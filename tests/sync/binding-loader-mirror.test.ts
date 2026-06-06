import { randomBytes } from 'node:crypto'
import { BindingLoader } from '../../src/sync/binding-loader'
import { clearCapabilityCache } from '../../src/adapter/capabilities'
import * as hulyProjects from '../../src/huly/projects'
import * as hulyAttachmentStore from '../../src/sync/huly-attachment-store'
import type { Logger } from '../../src/logging'
import type { Store } from '../../src/state/store'
import type { CredentialResolver } from '../../src/auth'
import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { AccountClient } from '@hcengineering/account-client'
import { ObjectId } from 'mongodb'

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const BINDING_ID = new ObjectId().toHexString()
const CREDENTIAL_ID = new ObjectId().toHexString()
const GITLAB_BASE = 'http://gitlab.test'
const TOKEN = 'test-token'
const ENCRYPTION_KEY = randomBytes(32)

function makeStore (): Store {
  return {
    bindings: () => ({
      findOne: async () => ({
        _id: new ObjectId(BINDING_ID),
        workspaceUuid: 'ws-mirror-1',
        hulyProjectRef: 'proj-1',
        gitlabProjectId: 42,
        gitlabProjectPath: 'group/project',
        credentialRef: CREDENTIAL_ID,
        webhookSecretRef: new ObjectId().toHexString(),
        webhookRegistered: false,
        createdAt: new Date(),
        disabled: false
      })
    }),
    idmap: () => ({}),
    userCredentials: () => ({})
  } as unknown as Store
}

function makeCredentialResolver (): CredentialResolver {
  return {
    resolve: async () => ({
      kind: 'access_token',
      token: TOKEN,
      gitlabBaseUrl: GITLAB_BASE
    })
  } as unknown as CredentialResolver
}

function makeAccountClient (): AccountClient {
  return {} as unknown as AccountClient
}

function makeMeasureContext (): MeasureContext {
  return {} as unknown as MeasureContext
}

function makeMirrorCol () {
  return {} as ReturnType<Store['attachmentMirror']>
}

// Mock heavy platform deps
jest.mock('../../src/huly/client', () => ({
  createPlatformClient: jest.fn(async () => ({
    client: { findAll: jest.fn(async () => []) }
  })),
  closePlatformClient: jest.fn(async () => {})
}))

jest.mock('../../src/huly/projects', () => ({
  getTrackerProject: jest.fn(async () => ({
    statuses: [],
    type: { tasks: ['tracker:tasktype:Issue'] }
  }))
}))

jest.mock('../../src/huly/users', () => ({
  UserIdentity: jest.fn(() => ({}))
}))

jest.mock('../../src/state/user-credentials', () => ({
  ...jest.requireActual('../../src/state/user-credentials'),
  getUserCredential: jest.fn(async () => null)
}))

jest.mock('../../src/adapter/capabilities', () => ({
  detectCapabilities: jest.fn(async () => ({})),
  clearCapabilityCache: jest.fn()
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BindingLoader mirrorDeps wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearCapabilityCache()
    jest.spyOn(hulyProjects, 'getTrackerProject').mockResolvedValue({
      statuses: [],
      type: { tasks: ['tracker:tasktype:Issue'] }
    } as unknown as Awaited<ReturnType<typeof hulyProjects.getTrackerProject>>)
  })

  function makeDeps (mirrorCol?: ReturnType<Store['attachmentMirror']>) {
    return {
      store: makeStore(),
      credentialResolver: makeCredentialResolver(),
      accountClient: makeAccountClient(),
      logger: makeLogger(),
      ctx: makeMeasureContext(),
      defaultGitlabBaseUrl: GITLAB_BASE,
      encryptionKey: ENCRYPTION_KEY,
      mirrorCol
    }
  }

  // Case 1: mirrorCol provided → workspace entry has hulyStore, mirrorDeps non-undefined
  test('1. mirrorCol provided → loadForIssues returns context with mirrorDeps defined', async () => {
    const loader = new BindingLoader(makeDeps(makeMirrorCol()))
    const ctx = await loader.loadForIssues(BINDING_ID)
    expect(ctx.mirrorDeps).toBeDefined()
    expect(ctx.mirrorDeps?.hulyStore).toBeDefined()
    expect(ctx.mirrorDeps?.gitlabClient).toBeDefined()
    expect(ctx.mirrorDeps?.mirrorCol).toBeDefined()
    expect(ctx.mirrorDeps?.logger).toBeDefined()
  })

  // Case 2: mirrorCol omitted → mirrorDeps undefined (link-through fallback)
  test('2. mirrorCol omitted → loadForIssues returns context with mirrorDeps undefined', async () => {
    const loader = new BindingLoader(makeDeps(undefined))
    const ctx = await loader.loadForIssues(BINDING_ID)
    expect(ctx.mirrorDeps).toBeUndefined()
  })

  // Case 3: mirrorCol provided → loadForNotes propagates mirrorDeps
  test('3. mirrorCol provided → loadForNotes returns context with mirrorDeps defined', async () => {
    const loader = new BindingLoader(makeDeps(makeMirrorCol()))
    const ctx = await loader.loadForNotes(BINDING_ID)
    expect(ctx.mirrorDeps).toBeDefined()
  })

  // Case 4: mirrorCol omitted → loadForNotes returns mirrorDeps undefined
  test('4. mirrorCol omitted → loadForNotes returns context with mirrorDeps undefined', async () => {
    const loader = new BindingLoader(makeDeps(undefined))
    const ctx = await loader.loadForNotes(BINDING_ID)
    expect(ctx.mirrorDeps).toBeUndefined()
  })

  // Case 5: mirrorCol provided → loadForMergeRequests propagates mirrorDeps
  test('5. mirrorCol provided → loadForMergeRequests returns context with mirrorDeps defined', async () => {
    const loader = new BindingLoader(makeDeps(makeMirrorCol()))
    const ctx = await loader.loadForMergeRequests(BINDING_ID)
    expect(ctx.mirrorDeps).toBeDefined()
  })

  // Case 6: mirrorCol omitted → loadForMergeRequests returns mirrorDeps undefined
  test('6. mirrorCol omitted → loadForMergeRequests returns context with mirrorDeps undefined', async () => {
    const loader = new BindingLoader(makeDeps(undefined))
    const ctx = await loader.loadForMergeRequests(BINDING_ID)
    expect(ctx.mirrorDeps).toBeUndefined()
  })

  // Case 7: mirrorCol provided → loadForReviews propagates mirrorDeps
  test('7. mirrorCol provided → loadForReviews returns context with mirrorDeps defined', async () => {
    const loader = new BindingLoader(makeDeps(makeMirrorCol()))
    const ctx = await loader.loadForReviews(BINDING_ID)
    expect(ctx.mirrorDeps).toBeDefined()
  })

  // Case 8: mirrorCol omitted → loadForReviews returns mirrorDeps undefined
  test('8. mirrorCol omitted → loadForReviews returns context with mirrorDeps undefined', async () => {
    const loader = new BindingLoader(makeDeps(undefined))
    const ctx = await loader.loadForReviews(BINDING_ID)
    expect(ctx.mirrorDeps).toBeUndefined()
  })

  // Case 9: createHulyAttachmentStore throws → hulyStore undefined, no crash, mirrorDeps undefined
  test('9. createHulyAttachmentStore throws → mirrorDeps undefined, no crash', async () => {
    jest.spyOn(hulyAttachmentStore, 'createHulyAttachmentStore').mockImplementationOnce(() => {
      throw new Error('store init failed')
    })

    const loader = new BindingLoader(makeDeps(makeMirrorCol()))
    const ctx = await loader.loadForIssues(BINDING_ID)
    expect(ctx.mirrorDeps).toBeUndefined()
  })

  // Case 10: mirrorDeps.mirrorCol is the same collection reference passed in
  test('10. mirrorDeps.mirrorCol is the collection passed to BindingLoader', async () => {
    const col = makeMirrorCol()
    const loader = new BindingLoader(makeDeps(col))
    const ctx = await loader.loadForIssues(BINDING_ID)
    expect(ctx.mirrorDeps?.mirrorCol).toBe(col)
  })

  // Case 11: workspace cache hit — same hulyStore returned on second load
  test('11. cached workspace entry reuses same hulyStore across loads', async () => {
    const col = makeMirrorCol()
    const loader = new BindingLoader(makeDeps(col))
    const ctx1 = await loader.loadForIssues(BINDING_ID)
    const ctx2 = await loader.loadForIssues(BINDING_ID)
    expect(ctx1.mirrorDeps?.hulyStore).toBe(ctx2.mirrorDeps?.hulyStore)
  })
})

// mirrorCol omitted: existing BindingLoader.loadForPipelines still works (backward compat)
describe('BindingLoader backward compatibility without mirrorCol', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearCapabilityCache()
    jest.spyOn(hulyProjects, 'getTrackerProject').mockResolvedValue({
      statuses: [],
      type: { tasks: ['tracker:tasktype:Issue'] }
    } as unknown as Awaited<ReturnType<typeof hulyProjects.getTrackerProject>>)
  })

  test('12. no mirrorCol → loadForPipelines still resolves successfully', async () => {
    const store: Store = {
      bindings: () => ({
        findOne: async () => ({
          _id: new ObjectId(BINDING_ID),
          workspaceUuid: 'ws-compat',
          hulyProjectRef: 'proj-1',
          gitlabProjectId: 42,
          gitlabProjectPath: 'group/project',
          credentialRef: CREDENTIAL_ID,
          webhookSecretRef: new ObjectId().toHexString(),
          webhookRegistered: false,
          createdAt: new Date(),
          disabled: false
        })
      }),
      idmap: () => ({}),
      userCredentials: () => ({})
    } as unknown as Store

    const loader = new BindingLoader({
      store,
      credentialResolver: makeCredentialResolver(),
      accountClient: makeAccountClient(),
      logger: makeLogger(),
      ctx: makeMeasureContext(),
      defaultGitlabBaseUrl: GITLAB_BASE,
      encryptionKey: ENCRYPTION_KEY
    })

    const ctx = await loader.loadForPipelines(BINDING_ID)
    expect(ctx.workspaceUuid).toBe('ws-compat' as WorkspaceUuid)
    expect(ctx.gitlabProjectId).toBe(42)
  })
})
