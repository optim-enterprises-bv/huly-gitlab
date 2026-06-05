import request from 'supertest'
import express from 'express'
import bodyParser from 'body-parser'
import { createWebhookRouter, getConfidentialSkippedCount, getMrSkippedCount, getUnboundPipelineCount } from '../../src/http/webhook'
import type { Store } from '../../src/state/store'
import type { SyncEngine } from '../../src/sync/engine'
import type { Logger } from '../../src/logging'
import type { Collection } from 'mongodb'
import type { BindingDoc } from '../../src/state/bindings'
import type { CredentialDoc } from '../../src/state/credentials'
import { ObjectId } from 'mongodb'
import { randomBytes, createCipheriv } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const ENCRYPTION_KEY = randomBytes(32)

function encryptSecret (plaintext: string): { ciphertext: string, iv: string, tag: string } {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv)
  const ctBuf = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: ctBuf.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  }
}

const WEBHOOK_SECRET = 'test-webhook-secret-value'
const CREDENTIAL_ID = new ObjectId()
const BINDING_ID = new ObjectId()

function makeCredentialDoc (): CredentialDoc {
  const enc = encryptSecret(WEBHOOK_SECRET)
  return {
    _id: CREDENTIAL_ID,
    kind: 'webhook_secret',
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    tag: enc.tag,
    createdAt: new Date()
  }
}

function makeBindingDoc (): BindingDoc {
  return {
    _id: BINDING_ID,
    workspaceUuid: 'ws-1',
    hulyProjectRef: 'proj-1',
    gitlabProjectId: 42,
    gitlabProjectPath: 'group/project',
    credentialRef: 'cred-oauth-1',
    webhookSecretRef: CREDENTIAL_ID.toHexString(),
    webhookRegistered: true,
    createdAt: new Date(),
    disabled: false
  }
}

function makeBindingsCol (binding: BindingDoc | null): Collection<BindingDoc> {
  return {
    findOne: async (q: Record<string, unknown>) => {
      if (binding === null) return null
      const queryId = q._id as ObjectId
      return queryId.toHexString() === binding._id.toHexString() ? binding : null
    }
  } as unknown as Collection<BindingDoc>
}

function makeCredentialsCol (cred: CredentialDoc | null): Collection<CredentialDoc> {
  return {
    findOne: async (q: Record<string, unknown>) => {
      if (cred === null) return null
      const queryId = q._id as ObjectId
      return queryId.toHexString() === cred._id.toHexString() ? cred : null
    }
  } as unknown as Collection<CredentialDoc>
}

function makeStore (binding: BindingDoc | null = makeBindingDoc(), cred: CredentialDoc | null = makeCredentialDoc()): Store {
  return {
    bindings: () => makeBindingsCol(binding),
    credentials: () => makeCredentialsCol(cred)
  } as unknown as Store
}

function makeSyncEngine (): SyncEngine & { calls: Array<{ binding: string, kind: string }> } {
  const calls: Array<{ binding: string, kind: string }> = []
  return {
    calls,
    enqueueWebhookEvent: jest.fn(async (binding: string, kind: string) => {
      calls.push({ binding, kind })
    })
  } as unknown as SyncEngine & { calls: Array<{ binding: string, kind: string }> }
}

function buildApp (store: Store, engine: SyncEngine): express.Express {
  const app = express()
  app.use(bodyParser.json({ limit: '5mb' }))
  app.use(createWebhookRouter(store, engine, ENCRYPTION_KEY, makeLogger()))
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /webhook/:bindingId', () => {
  const validBindingId = BINDING_ID.toHexString()

  test('1. Unknown binding → 404', async () => {
    const store = makeStore(null)
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${new ObjectId().toHexString()}`)
      .set('X-Gitlab-Event', 'Issue Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .send({ object_attributes: { id: 1 } })

    expect(res.status).toBe(404)
  })

  test('2. Missing/mismatched X-Gitlab-Token → 401', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Issue Hook')
      .set('X-Gitlab-Token', 'wrong-secret')
      .send({ object_attributes: { id: 1 } })

    expect(res.status).toBe(401)
  })

  test('3. Valid Issue Hook → 200, enqueued with kind=issue', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Issue Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .set('X-Gitlab-Event-Uuid', 'uuid-1')
      .send({ object_attributes: { id: 10, updated_at: '2024-01-01T00:00:00Z' } })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accepted: true })
    expect(engine.enqueueWebhookEvent).toHaveBeenCalledWith(
      validBindingId,
      'issue',
      expect.any(Object),
      'uuid-1',
      '2024-01-01T00:00:00Z'
    )
  })

  test('4. Valid Note Hook → 200, kind=note', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Note Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .set('X-Gitlab-Event-Uuid', 'uuid-2')
      .send({ object_attributes: { id: 20, updated_at: '2024-01-02T00:00:00Z' }, issue: { confidential: false } })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accepted: true })
    expect(engine.enqueueWebhookEvent).toHaveBeenCalledWith(
      validBindingId,
      'note',
      expect.any(Object),
      'uuid-2',
      '2024-01-02T00:00:00Z'
    )
  })

  test('5. Issue Hook with confidential=true → 204, NOT enqueued', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Issue Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .send({ object_attributes: { id: 30, confidential: true } })

    expect(res.status).toBe(204)
    expect(engine.enqueueWebhookEvent).not.toHaveBeenCalled()
  })

  test('6. Confidential Issue Hook header → 204, NOT enqueued', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Confidential Issue Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .send({ object_attributes: { id: 40 } })

    expect(res.status).toBe(204)
    expect(engine.enqueueWebhookEvent).not.toHaveBeenCalled()
  })

  test('7. Body > 5mb → 413', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    // 6MB payload — exceeds 5mb limit
    const bigBody = JSON.stringify({ data: 'x'.repeat(6 * 1024 * 1024) })

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Issue Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .set('Content-Type', 'application/json')
      .send(bigBody)

    expect(res.status).toBe(413)
  })

  test('9. Malformed bindingId (not 24-hex) → 400, not 404 or 500', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post('/webhook/not-a-valid-object-id')
      .set('X-Gitlab-Event', 'Issue Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .send({ object_attributes: { id: 1 } })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid id format')
    expect(engine.enqueueWebhookEvent).not.toHaveBeenCalled()
  })

  test('8. Bad secret of correct length → 401, not 500', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    // Same length as WEBHOOK_SECRET but different content
    const wrongSecret = 'x'.repeat(WEBHOOK_SECRET.length)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Issue Hook')
      .set('X-Gitlab-Token', wrongSecret)
      .send({ object_attributes: { id: 50 } })

    expect(res.status).toBe(401)
  })

  // ---------------------------------------------------------------------------
  // P2-T-06: Merge Request Hook
  // ---------------------------------------------------------------------------

  test('P2-1. Valid Merge Request Hook → 200, enqueued with kind=merge_request', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Merge Request Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .set('X-Gitlab-Event-Uuid', 'uuid-mr-1')
      .send({ object_attributes: { iid: 7, updated_at: '2024-03-01T00:00:00Z', confidential: false } })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accepted: true })
    expect(engine.enqueueWebhookEvent).toHaveBeenCalledWith(
      validBindingId,
      'merge_request',
      expect.any(Object),
      'uuid-mr-1',
      '2024-03-01T00:00:00Z'
    )
  })

  test('P2-2. Merge Request Hook confidential=true → 204, NOT enqueued, mrSkippedCount incremented', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const beforeMr = getMrSkippedCount()
    const beforeConf = getConfidentialSkippedCount()

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Merge Request Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .send({ object_attributes: { iid: 8, confidential: true } })

    expect(res.status).toBe(204)
    expect(engine.enqueueWebhookEvent).not.toHaveBeenCalled()
    expect(getMrSkippedCount()).toBe(beforeMr + 1)
    expect(getConfidentialSkippedCount()).toBe(beforeConf + 1)
  })

  // ---------------------------------------------------------------------------
  // P2-T-06: Pipeline Hook
  // ---------------------------------------------------------------------------

  test('P2-3. Pipeline Hook with merge_request.iid → 200, enqueued with kind=pipeline', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Pipeline Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .set('X-Gitlab-Event-Uuid', 'uuid-pipe-1')
      .send({
        object_attributes: { id: 100, status: 'success', updated_at: '2024-03-02T00:00:00Z' },
        merge_request: { iid: 42 }
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accepted: true })
    expect(engine.enqueueWebhookEvent).toHaveBeenCalledWith(
      validBindingId,
      'pipeline',
      expect.any(Object),
      'uuid-pipe-1',
      '2024-03-02T00:00:00Z'
    )
  })

  test('P2-4. Pipeline Hook with merge_request: null → 204, NOT enqueued, unboundPipelineCount incremented', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const before = getUnboundPipelineCount()

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Pipeline Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .send({
        object_attributes: { id: 101, status: 'running' },
        merge_request: null
      })

    expect(res.status).toBe(204)
    expect(engine.enqueueWebhookEvent).not.toHaveBeenCalled()
    expect(getUnboundPipelineCount()).toBe(before + 1)
  })

  // ---------------------------------------------------------------------------
  // P2-T-06: Note Hook — noteable_type differentiation
  // ---------------------------------------------------------------------------

  test('P2-5. Note Hook noteable_type=MergeRequest → 200, enqueued kind=note', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Note Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .set('X-Gitlab-Event-Uuid', 'uuid-note-mr-1')
      .send({
        object_attributes: {
          id: 200,
          noteable_type: 'MergeRequest',
          updated_at: '2024-03-03T00:00:00Z'
        },
        merge_request: { iid: 55 }
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accepted: true })
    expect(engine.enqueueWebhookEvent).toHaveBeenCalledWith(
      validBindingId,
      'note',
      expect.any(Object),
      'uuid-note-mr-1',
      '2024-03-03T00:00:00Z'
    )
  })

  test('P2-6. Note Hook noteable_type=Issue + confidential=true → 204, NOT enqueued (Phase 1 regression)', async () => {
    const store = makeStore()
    const engine = makeSyncEngine()
    const app = buildApp(store, engine)

    const res = await request(app)
      .post(`/webhook/${validBindingId}`)
      .set('X-Gitlab-Event', 'Note Hook')
      .set('X-Gitlab-Token', WEBHOOK_SECRET)
      .send({
        object_attributes: {
          id: 201,
          noteable_type: 'Issue',
          updated_at: '2024-03-04T00:00:00Z'
        },
        issue: { confidential: true, iid: 99 }
      })

    expect(res.status).toBe(204)
    expect(engine.enqueueWebhookEvent).not.toHaveBeenCalled()
  })
})
