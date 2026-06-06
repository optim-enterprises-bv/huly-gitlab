import { MeasureMetricsContext, type Client, type PersonId, type WorkspaceUuid } from '@hcengineering/core'
import { generateToken, systemAccountUuid } from '@hcengineering/server-token'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { loadConfig } from './config'
import { initializeLogging, createLogger } from './logging'
import * as metrics from './metrics'
import { METRIC_NAMES } from './metrics'
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
import { ReviewThreadsSyncManager } from './sync/mr-review'
import { EpicsSyncManager } from './sync/epics'
import { TxSubscriber } from './sync/tx-subscription'
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

  // Construct sync engine + register managers
  const breaker = new InMemoryBindingBreaker()
  const syncEngine = new SyncEngine({ store, logger, breaker })

  /**
   * P4-T-19 / P5-T-04: TxSubscriber lifecycle wiring (Path B closure).
   *
   * Path D finding: no Huly platform API exists to resolve the pod's
   * service-account PersonId at runtime. `systemAccountUuid` is a PersonUuid;
   * we cast it to PersonId for the on-wire equality check (TxSubscriber
   * compares as strings). This sentinel is semantically correct because
   * `generateToken(systemAccountUuid, ...)` above stamps that exact identity,
   * and applyRemote writes are authored by the same identity — making the
   * echo-filter effective.
   *
   * SERVICE_ACCOUNT_RESOLVED gauge is set to 0 (sentinel/Path D fallback).
   * If a future platform API becomes available, resolve the real PersonId and
   * set the gauge to 1 so operators can distinguish the two modes.
   *
   * Operator must monitor `tx.subscription.echo.dropped`; sustained zero
   * values indicate echo filter is non-functional and a tx storm may be
   * silently occurring.
   */
  // Operator must monitor `tx.subscription.echo.dropped`; sustained zero values indicate echo filter is non-functional and a tx storm may be silently occurring.
  metrics.increment(METRIC_NAMES.SERVICE_ACCOUNT_RESOLVED, 0)
  const serviceAccountPersonId = systemAccountUuid as unknown as PersonId
  const txSubscribers = new Map<string, TxSubscriber>()
  let engineHasStarted = false

  const startTxSubscriberForWorkspace = (
    workspaceUuid: WorkspaceUuid,
    client: Client,
    bindingsByProject: Map<string, string>
  ): void => {
    if (txSubscribers.has(workspaceUuid)) return
    const sub = new TxSubscriber({
      client,
      syncEngine,
      workspaceUuid,
      serviceAccountPersonId,
      bindingsByProject,
      logger
    })
    sub.start()
    if (engineHasStarted) sub.markEngineStarted()
    txSubscribers.set(workspaceUuid, sub)
    logger.info('main: TxSubscriber started', { workspaceUuid })
  }

  const stopTxSubscriberForWorkspace = (workspaceUuid: WorkspaceUuid): void => {
    const sub = txSubscribers.get(workspaceUuid)
    if (sub === undefined) return
    sub.stop()
    txSubscribers.delete(workspaceUuid)
    logger.info('main: TxSubscriber stopped', { workspaceUuid })
  }

  const bindingLoader = new BindingLoader({
    store,
    credentialResolver,
    accountClient,
    logger,
    ctx,
    defaultGitlabBaseUrl: config.GitLabBaseUrl,
    encryptionKey,
    onWorkspaceLoaded: (workspaceUuid, client, bindingsByProject) => {
      startTxSubscriberForWorkspace(workspaceUuid, client, bindingsByProject)
    },
    onWorkspaceEvicted: (workspaceUuid) => {
      stopTxSubscriberForWorkspace(workspaceUuid)
    }
  })

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
  const reviewManager = new ReviewThreadsSyncManager({
    loadBinding: bindingLoader.loadForReviews,
    backfillEnqueuer
  })
  // EpicsSyncManager (Phase 4). loadForEpics now returns the FULL
  // EpicsBindingContext (B4 fix); no boundary cast needed.
  const epicsManager = new EpicsSyncManager({
    loadBinding: bindingLoader.loadForEpics,
    backfillEnqueuer: async (binding, kind, record, eventId, version) => {
      await syncEngine.enqueueWebhookEvent(binding, kind, record, eventId, version)
    }
  })

  // Cast to engine's generic SyncManager — managers are parameterised on their
  // own record types (SyncIssue / note envelope) while the engine treats records
  // opaquely as Record<string, unknown>.
  syncEngine.register(issuesManager as unknown as Parameters<typeof syncEngine.register>[0])
  syncEngine.register(notesManager as unknown as Parameters<typeof syncEngine.register>[0])
  syncEngine.register(mrManager as unknown as Parameters<typeof syncEngine.register>[0])
  syncEngine.register(pipelineManager as unknown as Parameters<typeof syncEngine.register>[0])
  syncEngine.register(reviewManager as unknown as Parameters<typeof syncEngine.register>[0])
  syncEngine.register(epicsManager as unknown as Parameters<typeof syncEngine.register>[0])

  await syncEngine.start()
  engineHasStarted = true
  for (const sub of txSubscribers.values()) sub.markEngineStarted()
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
  const app = createApp({ config, store, syncEngine, logger, credentialResolver, bindingLifecycle, bindingLoader })
  const server = app.listen(config.Port, () => {
    logger.info('main: HTTP server listening', { port: config.Port })
  })

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info('main: shutting down')
    backfillScheduler.stop()
    oauthRefresher.stop()
    // Stop TxSubscribers first so no further enqueueLocalEvent calls land
    // in the engine after we ask it to drain.
    for (const sub of txSubscribers.values()) sub.stop()
    txSubscribers.clear()
    await syncEngine.stop()
    await bindingLoader.close()
    // B11: await server.close BEFORE store.disconnect so in-flight requests
    // can complete and any DB calls land before we tear down the pool.
    await new Promise<void>((resolve) => {
      server.close(() => {
        logger.info('main: server closed')
        resolve()
      })
    })
    await store.disconnect()
  }

  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error('main: fatal error', msg)
  process.exit(1)
})
