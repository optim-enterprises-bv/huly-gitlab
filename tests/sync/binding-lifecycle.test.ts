import { ObjectId } from 'mongodb'
import { BindingLifecycleService } from '../../src/sync/binding-lifecycle'
import type { GitLabClientFactory } from '../../src/sync/binding-lifecycle'
import type { BindingDoc } from '../../src/state/bindings'
import type { Logger } from '../../src/logging'
import { GitLabApiError } from '../../src/adapter/errors'
import type { SyncWebhook } from '../../src/adapter/types'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers / fakes
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

const PUBLIC_BASE_URL = 'https://huly.example.com'

function makeBinding (overrides: Partial<BindingDoc> = {}): BindingDoc {
  return {
    _id: new ObjectId(),
    workspaceUuid: 'ws-1',
    hulyProjectRef: 'proj-1',
    gitlabProjectId: 42,
    gitlabProjectPath: 'group/repo',
    credentialRef: 'cred-ref-123',
    webhookSecretRef: 'secret-ref-456',
    webhookRegistered: false,
    createdAt: new Date(),
    disabled: false,
    ...overrides
  }
}

function makeHook (id = 99): SyncWebhook {
  return {
    id,
    url: 'https://huly.example.com/webhook/abc',
    createdAt: new Date().toISOString(),
    issuesEvents: true,
    noteEvents: true,
    pushEvents: false,
    tagPushEvents: false,
    mergeRequestsEvents: false
  }
}

// ---------------------------------------------------------------------------
// Fake store
// ---------------------------------------------------------------------------

interface BindingUpdate {
  webhookId?: number
  webhookRegistered?: boolean
  disabled?: boolean
  webhookSecretRef?: string
}

function makeFakeStore (secretPlaintext: string) {
  const updates: Record<string, BindingUpdate> = {}
  const encryptionKey = randomBytes(32)

  // Minimal Collection<BindingDoc> shape
  const bindingsCol = {
    updateOne: jest.fn(async (_filter: unknown, patch: { $set: BindingUpdate }) => {
      const id = Object.values(_filter as Record<string, Record<string, string>>)[0]?.toHexString?.() ?? 'unknown'
      updates[id] = { ...updates[id], ...patch.$set }
    }),
    _updates: updates
  }

  // Minimal Collection<CredentialDoc> shape
  const credentialsCol = {
    findOne: jest.fn(async () => {
      // Return an encrypted-ish doc that decrypts to secretPlaintext
      // We bypass real encryption by returning the plaintext via a different approach:
      // We'll use a real putCredential-like structure but mock at a higher level.
      // Instead, we store plaintext directly in a fake doc structure and override decrypt.
      return null // overridden per test via mockResolvedValueOnce
    })
  }

  const store = {
    bindings: () => bindingsCol,
    credentials: () => credentialsCol,
    encryptionKey
  }

  return { store, updates, bindingsCol, credentialsCol, encryptionKey, secretPlaintext }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('BindingLifecycleService', () => {
  // 1. Success path
  test('onBindingCreate: success — registers webhook, sets webhookRegistered:true, webhookId populated', async () => {
    const binding = makeBinding()
    const hook = makeHook(77)
    const logger = makeLogger()

    const secretPlaintext = randomBytes(32).toString('base64')

    // Use real encryption so getCredential works
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { MongoClient } = await import('mongodb')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-1')
    await store.connect()

    const encryptionKey = randomBytes(32)

    // Store the secret under the binding's webhookSecretRef-equivalent id
    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: secretPlaintext
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef })
    const bindingId = testBinding._id.toHexString()

    // Also insert a binding doc so updateBinding works
    await store.bindings().insertOne(testBinding)

    const mockRegister = jest.fn(async () => hook)
    const factory: GitLabClientFactory = jest.fn(async () => ({
      createProjectWebhook: mockRegister
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger })
    const result = await svc.onBindingCreate(testBinding, PUBLIC_BASE_URL)

    expect(result.webhookRegistered).toBe(true)
    expect(result.webhookId).toBe(77)
    expect(result.reason).toBeUndefined()

    // Verify binding was updated in DB
    const { ObjectId } = await import('mongodb')
    const updated = await store.bindings().findOne({ _id: new ObjectId(bindingId) })
    expect(updated?.webhookRegistered).toBe(true)
    expect(updated?.webhookId).toBe(77)

    await store.disconnect()
    await mongod.stop()
  })

  // 2. Webhook secret is 32 bytes
  test('onBindingCreate: webhook secret passed to adapter decodes to 32 bytes', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const secretBytes = randomBytes(32)
    const secretPlaintext = secretBytes.toString('base64')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-2')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: secretPlaintext
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef })
    await store.bindings().insertOne(testBinding)

    let capturedToken: string | undefined
    const factory: GitLabClientFactory = jest.fn(async () => ({
      createProjectWebhook: jest.fn(async (_projectId: unknown, body: Record<string, unknown>) => {
        capturedToken = body.token as string
        return makeHook(1)
      })
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger: makeLogger() })
    await svc.onBindingCreate(testBinding, PUBLIC_BASE_URL)

    expect(capturedToken).toBeDefined()
    const decoded = Buffer.from(capturedToken ?? '', 'base64')
    expect(decoded.length).toBe(32)

    await store.disconnect()
    await mongod.stop()
  })

  // 3. Webhook URL is ${publicBaseUrl}/webhook/${binding._id}
  test('onBindingCreate: webhook URL is publicBaseUrl/webhook/<bindingId>', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-3')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: randomBytes(32).toString('base64')
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef })
    await store.bindings().insertOne(testBinding)
    const bindingId = testBinding._id.toHexString()

    let capturedUrl: string | undefined
    const factory: GitLabClientFactory = jest.fn(async () => ({
      createProjectWebhook: jest.fn(async (_projectId: unknown, body: Record<string, unknown>) => {
        capturedUrl = body.url as string
        return makeHook(2)
      })
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger: makeLogger() })
    await svc.onBindingCreate(testBinding, PUBLIC_BASE_URL)

    expect(capturedUrl).toBe(`${PUBLIC_BASE_URL}/webhook/${bindingId}`)

    await store.disconnect()
    await mongod.stop()
  })

  // 4. eventFlags exclude confidential_issues_events and confidential_note_events
  test('onBindingCreate: eventFlags exclude confidential_issues_events and confidential_note_events', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-4')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: randomBytes(32).toString('base64')
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef })
    await store.bindings().insertOne(testBinding)

    let capturedBody: Record<string, unknown> | undefined
    const factory: GitLabClientFactory = jest.fn(async () => ({
      createProjectWebhook: jest.fn(async (_projectId: unknown, body: Record<string, unknown>) => {
        capturedBody = body
        return makeHook(3)
      })
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger: makeLogger() })
    await svc.onBindingCreate(testBinding, PUBLIC_BASE_URL)

    expect(capturedBody).toBeDefined()
    expect(capturedBody?.confidential_issues_events).toBe(false)
    expect(capturedBody?.confidential_note_events).toBe(false)

    await store.disconnect()
    await mongod.stop()
  })

  // 5. Permission denied (4xx): logs warning, sets webhookRegistered:false, returns reason
  test('onBindingCreate: 4xx from adapter logs warning and returns webhookRegistered:false', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-5')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: randomBytes(32).toString('base64')
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef })
    await store.bindings().insertOne(testBinding)

    const logger = makeLogger()
    const factory: GitLabClientFactory = jest.fn(async () => ({
      createProjectWebhook: jest.fn(async () => {
        throw new GitLabApiError('Forbidden', 403)
      })
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger })
    const result = await svc.onBindingCreate(testBinding, PUBLIC_BASE_URL)

    expect(result.webhookRegistered).toBe(false)
    expect(result.reason).toContain('403')
    expect(logger.warn).toHaveBeenCalled()

    await store.disconnect()
    await mongod.stop()
  })

  // 6. 5xx from adapter: raises error
  test('onBindingCreate: 5xx from adapter raises error', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-6')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: randomBytes(32).toString('base64')
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef })
    await store.bindings().insertOne(testBinding)

    const factory: GitLabClientFactory = jest.fn(async () => ({
      createProjectWebhook: jest.fn(async () => {
        throw new GitLabApiError('Internal Server Error', 500)
      })
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger: makeLogger() })

    await expect(svc.onBindingCreate(testBinding, PUBLIC_BASE_URL)).rejects.toThrow(GitLabApiError)

    await store.disconnect()
    await mongod.stop()
  })

  // 7. onBindingDelete: best-effort dereg, succeeds even if dereg returns 404
  test('onBindingDelete: swallows 404 from deregister and returns normally', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-7')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const testBinding = makeBinding({ webhookId: 55 })
    const logger = makeLogger()

    const factory: GitLabClientFactory = jest.fn(async () => ({
      deleteProjectWebhook: jest.fn(async () => {
        throw new GitLabApiError('Not Found', 404)
      })
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger })

    // Should not throw
    await expect(svc.onBindingDelete(testBinding)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()

    await store.disconnect()
    await mongod.stop()
  })

  // 8. onBindingDelete: if webhookId not set, skips dereg call entirely
  test('onBindingDelete: skips dereg call if webhookId is not set', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-8')
    await store.connect()
    const encryptionKey = randomBytes(32)

    // No webhookId on binding
    const testBinding = makeBinding({ webhookId: undefined })

    const factory: GitLabClientFactory = jest.fn()

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger: makeLogger() })
    await svc.onBindingDelete(testBinding)

    // Factory never called since webhookId is not set
    expect(factory).not.toHaveBeenCalled()

    await store.disconnect()
    await mongod.stop()
  })

  // 9. rotateWebhookSecret: with webhookId set — dereg + reg called with new token
  test('rotateWebhookSecret: webhookId set — deregisters old and registers new with provided token', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-9')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: randomBytes(32).toString('base64')
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef, webhookId: 55, webhookRegistered: true })
    await store.bindings().insertOne(testBinding)
    const bindingId = testBinding._id.toHexString()

    const newSecret = randomBytes(32).toString('base64')
    const newHookId = 88

    const mockDereg = jest.fn(async () => undefined)
    const mockReg = jest.fn(async (_projectId: unknown, body: Record<string, unknown>) => ({
      ...makeHook(newHookId),
      token: body.token
    }))
    const factory: GitLabClientFactory = jest.fn(async () => ({
      deleteProjectWebhook: mockDereg,
      createProjectWebhook: mockReg
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger: makeLogger() })
    const result = await svc.rotateWebhookSecret(testBinding, newSecret, PUBLIC_BASE_URL)

    expect(result.webhookRegistered).toBe(true)
    expect(result.reason).toBeUndefined()

    // Dereg was called with old webhookId
    expect(mockDereg).toHaveBeenCalledWith(testBinding.gitlabProjectId, 55)

    // Reg was called with new token
    expect(mockReg).toHaveBeenCalled()
    const regArgs = mockReg.mock.calls[0][1] as Record<string, unknown>
    expect(regArgs.token).toBe(newSecret)

    // Binding updated with new webhookId
    const { ObjectId } = await import('mongodb')
    const updated = await store.bindings().findOne({ _id: new ObjectId(bindingId) })
    expect(updated?.webhookId).toBe(newHookId)
    expect(updated?.webhookRegistered).toBe(true)

    await store.disconnect()
    await mongod.stop()
  })

  // 11. onBindingCreate (Phase 2): event flags include merge_requests_events AND pipeline_events
  test('onBindingCreate (Phase 2): registers webhook with merge_requests_events:true AND pipeline_events:true', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-11')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: randomBytes(32).toString('base64')
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef })
    await store.bindings().insertOne(testBinding)

    let capturedBody: Record<string, unknown> | undefined
    const factory: GitLabClientFactory = jest.fn(async () => ({
      createProjectWebhook: jest.fn(async (_projectId: unknown, body: Record<string, unknown>) => {
        capturedBody = body
        return makeHook(11)
      })
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger: makeLogger() })
    await svc.onBindingCreate(testBinding, PUBLIC_BASE_URL)

    expect(capturedBody).toBeDefined()
    expect(capturedBody?.issues_events).toBe(true)
    expect(capturedBody?.note_events).toBe(true)
    expect(capturedBody?.merge_requests_events).toBe(true)
    expect(capturedBody?.pipeline_events).toBe(true)
    expect(capturedBody?.confidential_issues_events).toBe(false)
    expect(capturedBody?.confidential_note_events).toBe(false)

    await store.disconnect()
    await mongod.stop()
  })

  // 12. reRegisterWebhook: existing webhookId — PUTs the full Phase 2 event flag set + confidential_*=false
  test('reRegisterWebhook: existing webhookId — calls updateProjectWebhookEventFlags with all 4 flags and confidential_* false (B4)', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-12')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: randomBytes(32).toString('base64')
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef, webhookId: 200, webhookRegistered: true })
    await store.bindings().insertOne(testBinding)
    const bindingId = testBinding._id.toHexString()

    let capturedHookId: number | undefined
    let capturedBody: Record<string, unknown> | undefined
    const mockUpdate = jest.fn(async (_projectId: unknown, hookId: number, body: Record<string, unknown>) => {
      capturedHookId = hookId
      capturedBody = body
      return makeHook(200)
    })
    const factory: GitLabClientFactory = jest.fn(async () => ({
      updateProjectWebhook: mockUpdate
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger: makeLogger() })
    const result = await svc.reRegisterWebhook(testBinding, PUBLIC_BASE_URL)

    expect(result.webhookRegistered).toBe(true)
    expect(result.webhookId).toBe(200)
    expect(capturedHookId).toBe(200)
    expect(capturedBody).toBeDefined()
    expect(capturedBody?.issues_events).toBe(true)
    expect(capturedBody?.note_events).toBe(true)
    expect(capturedBody?.merge_requests_events).toBe(true)
    expect(capturedBody?.pipeline_events).toBe(true)
    // B4 — confidential flags forced false even on re-register.
    expect(capturedBody?.confidential_issues_events).toBe(false)
    expect(capturedBody?.confidential_note_events).toBe(false)

    // Sanity: binding still flagged registered in DB.
    const { ObjectId } = await import('mongodb')
    const updated = await store.bindings().findOne({ _id: new ObjectId(bindingId) })
    expect(updated?.webhookRegistered).toBe(true)
    expect(updated?.webhookId).toBe(200)

    await store.disconnect()
    await mongod.stop()
  })

  // 13. reRegisterWebhook: 4xx from GitLab — returns webhookRegistered:false, reason, no throw
  test('reRegisterWebhook: 4xx from GitLab → returns {webhookRegistered:false, reason}, does not throw', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-13')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: randomBytes(32).toString('base64')
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef, webhookId: 301, webhookRegistered: true })
    await store.bindings().insertOne(testBinding)
    const bindingId = testBinding._id.toHexString()

    const logger = makeLogger()
    const factory: GitLabClientFactory = jest.fn(async () => ({
      updateProjectWebhook: jest.fn(async () => {
        throw new GitLabApiError('Forbidden', 403)
      })
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger })

    const result = await svc.reRegisterWebhook(testBinding, PUBLIC_BASE_URL)

    expect(result.webhookRegistered).toBe(false)
    expect(result.reason).toContain('403')
    expect(logger.warn).toHaveBeenCalled()

    const { ObjectId } = await import('mongodb')
    const updated = await store.bindings().findOne({ _id: new ObjectId(bindingId) })
    expect(updated?.webhookRegistered).toBe(false)

    await store.disconnect()
    await mongod.stop()
  })

  // 10. rotateWebhookSecret: reg returns 4xx — webhookId cleared, registered:false, no throw
  test('rotateWebhookSecret: re-register returns 4xx — clears webhookId, sets webhookRegistered:false, does not throw', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const { Store } = await import('../../src/state/store')
    const { putCredential } = await import('../../src/state/credentials')

    const mongod = await MongoMemoryServer.create()
    const store = new Store(mongod.getUri(), 'test-lifecycle-10')
    await store.connect()
    const encryptionKey = randomBytes(32)

    const secretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: randomBytes(32).toString('base64')
    })

    const testBinding = makeBinding({ webhookSecretRef: secretRef, webhookId: 77, webhookRegistered: true })
    await store.bindings().insertOne(testBinding)
    const bindingId = testBinding._id.toHexString()

    const newSecret = randomBytes(32).toString('base64')
    const logger = makeLogger()

    const factory: GitLabClientFactory = jest.fn(async () => ({
      deleteProjectWebhook: jest.fn(async () => undefined),
      createProjectWebhook: jest.fn(async () => {
        throw new GitLabApiError('Forbidden', 403)
      })
    } as unknown as import('../../src/adapter/gitlab-client').GitLabClient))

    const svc = new BindingLifecycleService({ store, encryptionKey, gitlabClientFactory: factory, logger })
    const result = await svc.rotateWebhookSecret(testBinding, newSecret, PUBLIC_BASE_URL)

    expect(result.webhookRegistered).toBe(false)
    expect(result.reason).toContain('403')
    expect(logger.warn).toHaveBeenCalled()

    // webhookId cleared in DB
    const { ObjectId } = await import('mongodb')
    const updated = await store.bindings().findOne({ _id: new ObjectId(bindingId) })
    expect(updated?.webhookRegistered).toBe(false)
    expect(updated?.webhookId).toBeUndefined()

    await store.disconnect()
    await mongod.stop()
  })
})
