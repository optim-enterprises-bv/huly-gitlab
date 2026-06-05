import { MeasureMetricsContext, type WorkspaceUuid } from '@hcengineering/core'
import { generateToken, systemAccountUuid } from '@hcengineering/server-token'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { loadConfig } from './config'
import { initializeLogging, createLogger } from './logging'
import { Store } from './state/store'
import {
  SyncEngine,
  InMemoryBindingBreaker,
  BindingLoader,
  IssuesSyncManager,
  NotesSyncManager,
  BackfillScheduler
} from './sync'
import { MergeRequestsSyncManager } from './sync/mr'
import { PipelineSyncManager } from './sync/pipeline'
import { createApp } from './http'
import { CredentialResolver, OAuthRefresher } from './auth'
import { BindingLifecycleService } from './sync/binding-lifecycle'
import { GitLabClient } from './adapter/gitlab-client'

async function main (): Promise<void> {
  const config = loadConfig()
  initializeLogging(config)

  const logger = createLogger('main')

  // Connect store
  const store = new Store(config.MongoUrl, config.MongoDb)
  await store.connect()
  logger.info('main: store connected', { db: config.MongoDb })

  const encryptionKey = Buffer.from(config.CredentialEncryptionKey, 'base64')
  const credentialResolver = new CredentialResolver({ store, encryptionKey })

  // Platform-side measurement context, account client + binding loader
  const ctx = new MeasureMetricsContext('huly-gitlab', {})
  // System-level token: no real workspace, use sentinel so the cast is explicit and documented.
  const serverToken = generateToken(systemAccountUuid, 'system' as WorkspaceUuid, { service: 'gitlab' })
  const accountClient = getAccountClient(config.AccountsURL, serverToken)
  const bindingLoader = new BindingLoader({
    store,
    credentialResolver,
    accountClient,
    logger,
    ctx,
    defaultGitlabBaseUrl: config.GitLabBaseUrl
  })

  // Construct sync engine + register managers
  const breaker = new InMemoryBindingBreaker()
  const syncEngine = new SyncEngine({ store, logger, breaker })

  const backfillEnqueuer = async (
    binding: string,
    kind: string,
    record: Record<string, unknown>,
    eventId: string,
    version: string
  ): Promise<void> => {
    await syncEngine.enqueueWebhookEvent(binding, kind, record, eventId, version)
  }

  const issuesManager = new IssuesSyncManager({
    loadBinding: bindingLoader.loadForIssues,
    backfillEnqueuer
  })
  const notesManager = new NotesSyncManager({
    loadBinding: bindingLoader.loadForNotes,
    backfillEnqueuer
  })
  const mrManager = new MergeRequestsSyncManager({
    loadBinding: bindingLoader.loadForMergeRequests,
    backfillEnqueuer
  })
  const pipelineManager = new PipelineSyncManager({
    loadBinding: bindingLoader.loadForPipelines
  })

  // Cast to engine's generic SyncManager — managers are parameterised on their
  // own record types (SyncIssue / note envelope) while the engine treats records
  // opaquely as Record<string, unknown>.
  syncEngine.register(issuesManager as unknown as Parameters<typeof syncEngine.register>[0])
  syncEngine.register(notesManager as unknown as Parameters<typeof syncEngine.register>[0])
  syncEngine.register(mrManager as unknown as Parameters<typeof syncEngine.register>[0])
  syncEngine.register(pipelineManager as unknown as Parameters<typeof syncEngine.register>[0])

  await syncEngine.start()
  logger.info('main: sync engine started')

  // Periodic backfill sweep — same breaker as engine so failures cross paths
  const backfillScheduler = new BackfillScheduler({
    store,
    syncEngine,
    breaker,
    intervalMs: config.BackfillIntervalMs,
    logger
  })
  backfillScheduler.start()

  // Start OAuth token refresher
  const oauthRefresher = new OAuthRefresher({
    store,
    logger,
    encryptionKey,
    gitLabClientId: config.GitLabClientId,
    gitLabClientSecret: config.GitLabClientSecret,
    oauthRedirectUri: config.OAuthRedirectUri
  })
  oauthRefresher.start()
  logger.info('main: OAuth refresher started')

  // Construct binding lifecycle service (webhook auto-registration)
  const bindingLifecycle = new BindingLifecycleService({
    store,
    encryptionKey,
    gitlabClientFactory: async (credentialRef: string) => {
      const cred = await credentialResolver.resolve(credentialRef)
      if (cred === null) {
        throw new Error(`Credential not found: ${credentialRef}`)
      }
      const baseUrl = cred.gitlabBaseUrl ?? config.GitLabBaseUrl
      return new GitLabClient({ baseUrl, token: cred.token, logger })
    },
    logger
  })

  // Build and start HTTP server
  const app = createApp({ config, store, syncEngine, logger, credentialResolver, bindingLifecycle })
  const server = app.listen(config.Port, () => {
    logger.info('main: HTTP server listening', { port: config.Port })
  })

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info('main: shutting down')
    backfillScheduler.stop()
    oauthRefresher.stop()
    await syncEngine.stop()
    await bindingLoader.close()
    await store.disconnect()
    server.close(() => {
      logger.info('main: server closed')
    })
  }

  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error('main: fatal error', msg)
  process.exit(1)
})
