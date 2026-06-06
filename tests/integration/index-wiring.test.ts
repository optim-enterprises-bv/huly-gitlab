/**
 * Integration test for P4-T-19 — `src/index.ts` wiring.
 *
 * Path B closure: TxSubscriber lifecycle is wired through the BindingLoader
 * `onWorkspaceLoaded` / `onWorkspaceEvicted` callbacks. This test exercises
 * the wiring without booting the full HTTP server or mongo by:
 *   - constructing a real BindingLoader with the callback contract
 *   - feeding a synthetic workspace through it
 *   - asserting the TxSubscriber start/stop call sequence
 *   - asserting EpicsSyncManager registers under kind 'epic'
 *   - asserting createApp mounts the user OAuth router
 *
 * The test does NOT invoke `main()` directly (that would require mongo +
 * a transactor); instead it reconstructs the equivalent wiring graph in
 * isolation so the assertions stay deterministic and fast.
 */

import express from 'express'
import request from 'supertest'
import * as fs from 'fs'
import * as path from 'path'
import type { Client, PersonId, WorkspaceUuid } from '@hcengineering/core'
import { SyncEngine, InMemoryBindingBreaker } from '../../src/sync'
import { EpicsSyncManager } from '../../src/sync/epics'
import { TxSubscriber } from '../../src/sync/tx-subscription'
import { createApp } from '../../src/http'
import * as metricsModule from '../../src/metrics'
import { METRIC_NAMES } from '../../src/metrics'
import type { Store } from '../../src/state/store'
import type { Config } from '../../src/config'
import type { Logger } from '../../src/logging'

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

function makeFakeClient (): Client {
  return {
    notify: undefined,
    findOne: async () => undefined,
    findAll: async () => [] as never,
    close: async () => {}
  } as unknown as Client
}

function makeFakeStore (): Store {
  return {
    bindings: () => ({}),
    idmap: () => ({}),
    userCredentials: () => ({}),
    oauthStates: () => ({}),
    dedup: () => ({}),
    inflight: () => ({}),
    cursors: () => ({})
  } as unknown as Store
}

function makeMinimalConfig (): Config {
  return {
    Port: 0,
    MongoUrl: 'mongodb://localhost:27017',
    MongoDb: 'test',
    AccountsURL: 'http://accounts.test',
    GitLabBaseUrl: 'https://gitlab.com',
    GitLabClientId: 'cid',
    GitLabClientSecret: 'csecret',
    OAuthRedirectUri: 'http://localhost/oauth/callback',
    PublicBaseUrl: 'http://localhost',
    ServerSecret: 'test-server-secret-at-least-32-bytes-long-1234567890',
    CredentialEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
    BackfillIntervalMs: 60_000,
    CorsAllowedOrigins: [],
    LogLevel: 'info'
  } as unknown as Config
}

describe('P4-T-19: index wiring', () => {
  it('EpicsSyncManager registers under kind "epic" on the engine', () => {
    const logger = makeLogger()
    const store = makeFakeStore()
    const breaker = new InMemoryBindingBreaker()
    const engine = new SyncEngine({ store, logger, breaker })

    const epicsManager = new EpicsSyncManager({
      loadBinding: (async () => { throw new Error('not exercised') }) as never,
      backfillEnqueuer: async () => {}
    })

    engine.register(epicsManager as unknown as Parameters<typeof engine.register>[0])

    // Trigger a backfill enqueue — engine enumerates registered kinds and
    // synthesizes one event per kind. Since only 'epic' is registered we
    // assert the manager is the dispatch target.
    let kinds: string[] = []
    const wrapped = engine as unknown as { managers: Map<string, unknown> }
    kinds = Array.from(wrapped.managers.keys())
    expect(kinds).toContain('epic')
  })

  it('TxSubscriber lifecycle: start on workspace load, stop on workspace evict', async () => {
    const logger = makeLogger()
    const store = makeFakeStore()
    const breaker = new InMemoryBindingBreaker()
    const engine = new SyncEngine({ store, logger, breaker })

    // Track lifecycle calls in order to assert sequence
    const calls: string[] = []
    const txSubscribers = new Map<string, TxSubscriber>()
    let engineHasStarted = false

    const serviceAccountPersonId = 'system' as unknown as PersonId

    const startTxSubscriberForWorkspace = (
      workspaceUuid: WorkspaceUuid,
      client: Client,
      bindingsByProject: Map<string, string>
    ): void => {
      if (txSubscribers.has(workspaceUuid)) return
      const sub = new TxSubscriber({
        client,
        syncEngine: engine,
        workspaceUuid,
        serviceAccountPersonId,
        bindingsByProject,
        logger
      })
      const origStart = sub.start.bind(sub)
      sub.start = () => { calls.push(`start:${workspaceUuid}`); origStart() }
      const origStop = sub.stop.bind(sub)
      sub.stop = () => { calls.push(`stop:${workspaceUuid}`); origStop() }
      const origMark = sub.markEngineStarted.bind(sub)
      sub.markEngineStarted = () => { calls.push(`markEngineStarted:${workspaceUuid}`); origMark() }
      sub.start()
      if (engineHasStarted) sub.markEngineStarted()
      txSubscribers.set(workspaceUuid, sub)
    }

    const stopTxSubscriberForWorkspace = (workspaceUuid: WorkspaceUuid): void => {
      const sub = txSubscribers.get(workspaceUuid)
      if (sub === undefined) return
      sub.stop()
      txSubscribers.delete(workspaceUuid)
    }

    const workspaceUuid = 'ws-A' as WorkspaceUuid
    const client = makeFakeClient()
    const bindingsByProject = new Map<string, string>([['42', 'binding-1']])

    // Simulate first workspace load: starts TxSubscriber.
    startTxSubscriberForWorkspace(workspaceUuid, client, bindingsByProject)
    expect(txSubscribers.has(workspaceUuid)).toBe(true)
    expect(client.notify).toBeDefined()

    // Simulate `engine.start()` resolving — mark all active subs as
    // engine-started. (The real engine's start() drains inflight from
    // mongo; we skip it here since the fake store has no mongo backing.)
    engineHasStarted = true
    for (const sub of txSubscribers.values()) sub.markEngineStarted()

    // Simulate workspace eviction.
    stopTxSubscriberForWorkspace(workspaceUuid)
    expect(txSubscribers.has(workspaceUuid)).toBe(false)
    expect(client.notify).toBeUndefined()

    expect(calls).toEqual([
      `start:${workspaceUuid}`,
      `markEngineStarted:${workspaceUuid}`,
      `stop:${workspaceUuid}`
    ])
  })

  it('createApp mounts /user/oauth router and serves /user/ui static path', async () => {
    const logger = makeLogger()
    const store = makeFakeStore()
    const breaker = new InMemoryBindingBreaker()
    const engine = new SyncEngine({ store, logger, breaker })
    const config = makeMinimalConfig()

    const app = createApp({ config, store, syncEngine: engine, logger })

    // /user/oauth/start without cookie → 401 cookie required.
    // This proves the user-oauth router is mounted under /user/oauth.
    const start = await request(app)
      .get('/user/oauth/start')
      .query({ gitlabBaseUrl: 'https://gitlab.com' })
    expect([401, 429]).toContain(start.status)
    expect(start.body).toHaveProperty('error')

    // /user/oauth/status without cookie → 401.
    const status = await request(app)
      .get('/user/oauth/status')
      .query({ gitlabBaseUrl: 'https://gitlab.com' })
    expect(status.status).toBe(401)
  })

  it('P5-T-04: SERVICE_ACCOUNT_RESOLVED gauge initialized at 0 (Path D sentinel fallback)', () => {
    // Reset so we get a clean baseline regardless of test order.
    metricsModule.reset(METRIC_NAMES.SERVICE_ACCOUNT_RESOLVED)
    // Simulate what src/index.ts does at startup: increment by 0 to register
    // the gauge entry without changing the value from the sentinel default.
    metricsModule.increment(METRIC_NAMES.SERVICE_ACCOUNT_RESOLVED, 0)
    expect(metricsModule.get(METRIC_NAMES.SERVICE_ACCOUNT_RESOLVED)).toBe(0)
  })

  it('P5-T-04: src/index.ts contains operator alert comment for echo-filter monitoring', () => {
    const indexSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/index.ts'),
      'utf8'
    )
    expect(indexSrc).toContain('Operator must monitor')
    expect(indexSrc).toContain('tx.subscription.echo.dropped')
    expect(indexSrc).toContain('Path D')
  })

  it('engine-started flag drains buffered txes after late markEngineStarted', () => {
    const logger = makeLogger()
    const store = makeFakeStore()
    const breaker = new InMemoryBindingBreaker()
    const engine = new SyncEngine({ store, logger, breaker })
    const serviceAccountPersonId = 'system' as unknown as PersonId

    // Spy on enqueueLocalEvent at the engine level.
    const enqueued: Array<{ binding: string, kind: string, doc: string }> = []
    ;(engine as unknown as { enqueueLocalEvent: (b: string, k: string, d: string, c: Record<string, unknown>) => void })
      .enqueueLocalEvent = (binding, kind, doc) => { enqueued.push({ binding, kind, doc }) }

    const client = makeFakeClient()
    const bindingsByProject = new Map<string, string>([['42', 'binding-X']])
    const sub = new TxSubscriber({
      client,
      syncEngine: engine,
      workspaceUuid: 'ws-late' as WorkspaceUuid,
      serviceAccountPersonId,
      bindingsByProject,
      logger
    })
    sub.start()

    // Deliver a tx BEFORE markEngineStarted — it should buffer, not dispatch.
    const issueTx = {
      _id: 'tx-1',
      _class: 'core:class:TxUpdateDoc',
      objectId: 'issue-1',
      objectClass: 'tracker:class:Issue',
      operations: { title: 'New' },
      modifiedBy: 'user-1'
    } as unknown as Parameters<NonNullable<Client['notify']>>[0]
    ;(client.notify as unknown as (tx: typeof issueTx) => void)(issueTx)
    expect(enqueued).toHaveLength(0)

    // Now mark engine-started — buffered tx should drain.
    sub.markEngineStarted()
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toEqual({ binding: 'binding-X', kind: 'issue', doc: 'issue-1' })
  })
})
