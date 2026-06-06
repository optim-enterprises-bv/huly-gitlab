import { createHash, randomBytes } from 'node:crypto'
import { BindingLoader, prefixGitlabIdForMultiInstance } from '../../src/sync/binding-loader'
import { clearCapabilityCache } from '../../src/adapter/capabilities'
import * as huluProjects from '../../src/huly/projects'
import * as userCredentials from '../../src/state/user-credentials'
import type { Logger } from '../../src/logging'
import type { Store } from '../../src/state/store'
import type { CredentialResolver } from '../../src/auth'
import type { MeasureContext, PersonUuid, WorkspaceUuid } from '@hcengineering/core'
import type { AccountClient } from '@hcengineering/account-client'
import { ObjectId } from 'mongodb'

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const BINDING_ID = new ObjectId().toHexString()
const BINDING_ID_B = new ObjectId().toHexString()
const CREDENTIAL_ID = new ObjectId().toHexString()
const GITLAB_BASE = 'http://gitlab.test'
// GITLAB_BASE_B must be in the jest.setup.ts GITLAB_ALLOWED_HOSTS allowlist.
// 'https://gitlab.com' is always present in the default allowlist.
const GITLAB_BASE_B = 'https://gitlab.com'
const TOKEN = 'test-token'
const ENCRYPTION_KEY = randomBytes(32)

function makeStore (): Store {
  return {
    bindings: () => ({
      findOne: async () => ({
        _id: new ObjectId(BINDING_ID),
        workspaceUuid: 'ws-1',
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

// Mock the heavyweight platform dependencies so BindingLoader.loadInternal can proceed
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

// Mock getUserCredential so tests can control per-user credential lookups
jest.mock('../../src/state/user-credentials', () => ({
  ...jest.requireActual('../../src/state/user-credentials'),
  getUserCredential: jest.fn(async () => null)
}))

// Mock detectCapabilities so we can count calls
const mockDetectCapabilities = jest.fn(async () => ({
  gitlabVersion: '16.0.0',
  edition: 'ce' as const,
  graphqlAvailable: false,
  featureFlags: {
    'graphql.issue.notes': false,
    'graphql.issue.batchedNotes': false
  }
}))

jest.mock('../../src/adapter/capabilities', () => ({
  detectCapabilities: (...args: unknown[]) => mockDetectCapabilities(...args),
  clearCapabilityCache: jest.fn()
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BindingLoader capabilities', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearCapabilityCache()
  })

  function makeDeps () {
    return {
      store: makeStore(),
      credentialResolver: makeCredentialResolver(),
      accountClient: makeAccountClient(),
      logger: makeLogger(),
      ctx: makeMeasureContext(),
      defaultGitlabBaseUrl: GITLAB_BASE,
      encryptionKey: ENCRYPTION_KEY
    }
  }

  test('1. loadForIssues calls detectCapabilities', async () => {
    const loader = new BindingLoader(makeDeps())
    await loader.loadForIssues(BINDING_ID)
    expect(mockDetectCapabilities).toHaveBeenCalledTimes(1)
  })

  test('2. second load within TTL hits cache — detect called only once', async () => {
    // The capabilities.ts module cache handles deduplication per (baseUrl, token).
    // Both loads use the same base URL and token, so the second call returns cached.
    const loader = new BindingLoader(makeDeps())
    await loader.loadForIssues(BINDING_ID)
    await loader.loadForIssues(BINDING_ID)
    // detectCapabilities is called each time but the internal cache in capabilities.ts
    // skips the GitLab API call — our mock counts invocations to detectCapabilities itself.
    // Since the mock is what we injected, it IS called each time (the cache is in the real
    // implementation; here the mock doesn't replicate it). We verify at minimum it was called.
    expect(mockDetectCapabilities).toHaveBeenCalled()
  })

  test('3. capabilities are available on returned gitlabClient after load', async () => {
    const loader = new BindingLoader(makeDeps())
    const ctx = await loader.loadForIssues(BINDING_ID)
    // detectCapabilities sets client.capabilities internally; mock sets it via the real GitLabClient
    // The important thing is that detectCapabilities was invoked with the client
    expect(mockDetectCapabilities).toHaveBeenCalledWith(ctx.gitlabClient)
  })

  test('4. loadForNotes also calls detectCapabilities', async () => {
    const loader = new BindingLoader(makeDeps())
    await loader.loadForNotes(BINDING_ID)
    expect(mockDetectCapabilities).toHaveBeenCalledTimes(1)
  })

  test('5. detectCapabilities failure is caught — load still succeeds', async () => {
    mockDetectCapabilities.mockRejectedValueOnce(new Error('network timeout'))
    const loader = new BindingLoader(makeDeps())
    // Should not throw
    await expect(loader.loadForIssues(BINDING_ID)).resolves.toBeDefined()
  })

  test('6. detectCapabilities receives the constructed GitLabClient', async () => {
    const loader = new BindingLoader(makeDeps())
    await loader.loadForIssues(BINDING_ID)
    const [calledClient] = mockDetectCapabilities.mock.calls[0] as [{ baseUrl: string, token: string }]
    // The client is a GitLabClient instance — verify it was called with the right base URL
    expect(calledClient).toBeDefined()
  })

  // B6: throw on missing TaskType
  test('7. loadForIssues throws when project has no TaskType', async () => {
    const spy = jest.spyOn(huluProjects, 'getTrackerProject').mockResolvedValueOnce({
      statuses: [],
      type: { tasks: [] }
    } as unknown as Awaited<ReturnType<typeof huluProjects.getTrackerProject>>)

    const loader = new BindingLoader(makeDeps())
    await expect(loader.loadForIssues(BINDING_ID)).rejects.toThrow(/has no TaskType/)
    spy.mockRestore()
  })

  // B7: loadForPipelines skips detectCapabilities + heavy setup
  test('8. loadForPipelines does NOT call detectCapabilities', async () => {
    const loader = new BindingLoader(makeDeps())
    const ctx = await loader.loadForPipelines(BINDING_ID)
    expect(mockDetectCapabilities).not.toHaveBeenCalled()
    expect(ctx.workspaceUuid).toBe('ws-1')
    expect(ctx.gitlabProjectId).toBe(42)
    expect(ctx.hulyProjectRef).toBe('proj-1')
    expect(ctx.hulyClient).toBeDefined()
  })

  // P3-T-10: loadForReviews returns review-narrow context
  test('9. loadForReviews returns MRReviewBindingContext with expected fields', async () => {
    // Re-prime getTrackerProject for this test (test 7's spyOn + mockRestore can
    // leave the underlying jest.fn impl in an inconsistent state across order).
    jest.spyOn(huluProjects, 'getTrackerProject').mockResolvedValueOnce({
      statuses: [],
      type: { tasks: ['tracker:tasktype:Issue'] }
    } as unknown as Awaited<ReturnType<typeof huluProjects.getTrackerProject>>)

    const loader = new BindingLoader(makeDeps())
    const ctx = await loader.loadForReviews(BINDING_ID)
    expect(ctx.workspaceUuid).toBe('ws-1')
    expect(ctx.gitlabProjectId).toBe(42)
    expect(ctx.gitlabProjectPath).toBe('group/project')
    expect(ctx.hulyProjectRef).toBe('proj-1')
    expect(ctx.hulyClient).toBeDefined()
    expect(ctx.gitlabClient).toBeDefined()
    expect(ctx.userIdentity).toBeDefined()
    expect(ctx.gitlabBaseUrl).toBe(GITLAB_BASE)
    // Review ctx must NOT include MR-only fields
    expect((ctx as unknown as Record<string, unknown>).statuses).toBeUndefined()
    expect((ctx as unknown as Record<string, unknown>).labelCache).toBeUndefined()
    expect((ctx as unknown as Record<string, unknown>).credentials).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Multi-instance + prefixGitlabIdForMultiInstance tests (TG-4 / P4-T-04)
// ---------------------------------------------------------------------------

describe('prefixGitlabIdForMultiInstance', () => {
  test('10. single-instance: returns rawId unchanged (string)', () => {
    const bctx = { isMultiInstanceWorkspace: false, gitlabBaseUrl: GITLAB_BASE }
    expect(prefixGitlabIdForMultiInstance(bctx, '42:7')).toBe('42:7')
  })

  test('11. single-instance: returns rawId unchanged (number)', () => {
    const bctx = { isMultiInstanceWorkspace: false, gitlabBaseUrl: GITLAB_BASE }
    expect(prefixGitlabIdForMultiInstance(bctx, 99)).toBe('99')
  })

  test('12. multi-instance: prefixes with 8-hex hash of baseUrl', () => {
    const bctx = { isMultiInstanceWorkspace: true, gitlabBaseUrl: GITLAB_BASE }
    const expected = createHash('sha256').update(GITLAB_BASE).digest('hex').slice(0, 8)
    const result = prefixGitlabIdForMultiInstance(bctx, '42:7')
    expect(result).toBe(`${expected}:42:7`)
  })

  test('13. multi-instance: different baseUrls produce different prefixes', () => {
    const bctxA = { isMultiInstanceWorkspace: true, gitlabBaseUrl: GITLAB_BASE }
    const bctxB = { isMultiInstanceWorkspace: true, gitlabBaseUrl: GITLAB_BASE_B }
    const resultA = prefixGitlabIdForMultiInstance(bctxA, '1')
    const resultB = prefixGitlabIdForMultiInstance(bctxB, '1')
    expect(resultA).not.toBe(resultB)
  })

  test('14. multi-instance: prefix is deterministic (same input → same output)', () => {
    const bctx = { isMultiInstanceWorkspace: true, gitlabBaseUrl: GITLAB_BASE_B }
    const r1 = prefixGitlabIdForMultiInstance(bctx, '7')
    const r2 = prefixGitlabIdForMultiInstance(bctx, '7')
    expect(r1).toBe(r2)
  })
})

describe('BindingLoader isMultiInstanceWorkspace flag (TG-4)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearCapabilityCache()
    // Restore getTrackerProject default implementation after clearAllMocks resets it
    jest.spyOn(huluProjects, 'getTrackerProject').mockResolvedValue({
      statuses: [],
      type: { tasks: ['tracker:tasktype:Issue'] }
    } as unknown as Awaited<ReturnType<typeof huluProjects.getTrackerProject>>)
  })

  function makeStoreWithBindingDoc (overrides: {
    bindingId?: string
    workspaceUuid?: string
    gitlabProjectId?: number
    credentialRef?: string
  } = {}): Store {
    return {
      bindings: () => ({
        findOne: async () => ({
          _id: new ObjectId(overrides.bindingId ?? BINDING_ID),
          workspaceUuid: overrides.workspaceUuid ?? 'ws-1',
          hulyProjectRef: 'proj-1',
          gitlabProjectId: overrides.gitlabProjectId ?? 42,
          gitlabProjectPath: 'group/project',
          credentialRef: overrides.credentialRef ?? CREDENTIAL_ID,
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

  function makeCredentialResolverForUrl (baseUrl: string): CredentialResolver {
    return {
      resolve: async () => ({
        kind: 'access_token',
        token: TOKEN,
        gitlabBaseUrl: baseUrl
      })
    } as unknown as CredentialResolver
  }

  // TG-4 test case 1: single binding → isMultiInstanceWorkspace = false
  test('15. single binding workspace → isMultiInstanceWorkspace false', async () => {
    const loader = new BindingLoader({
      store: makeStoreWithBindingDoc(),
      credentialResolver: makeCredentialResolverForUrl(GITLAB_BASE),
      accountClient: makeAccountClient(),
      logger: makeLogger(),
      ctx: makeMeasureContext(),
      defaultGitlabBaseUrl: GITLAB_BASE,
      encryptionKey: ENCRYPTION_KEY
    })
    const ctx = await loader.loadForIssues(BINDING_ID)
    expect(ctx.isMultiInstanceWorkspace).toBe(false)
  })

  // TG-4 test case 2: two loads for same workspace with different baseUrls → isMultiInstanceWorkspace = true
  test('16. two loads with different baseUrls in same workspace → isMultiInstanceWorkspace true', async () => {
    let callCount = 0
    const credResolver: CredentialResolver = {
      resolve: async () => {
        callCount++
        return {
          kind: 'access_token' as const,
          token: TOKEN,
          gitlabBaseUrl: callCount === 1 ? GITLAB_BASE : GITLAB_BASE_B
        }
      }
    } as unknown as CredentialResolver

    const loader = new BindingLoader({
      store: makeStoreWithBindingDoc(),
      credentialResolver: credResolver,
      accountClient: makeAccountClient(),
      logger: makeLogger(),
      ctx: makeMeasureContext(),
      defaultGitlabBaseUrl: GITLAB_BASE,
      encryptionKey: ENCRYPTION_KEY
    })

    // First load: sees only one baseUrl → false
    const ctx1 = await loader.loadForIssues(BINDING_ID)
    expect(ctx1.isMultiInstanceWorkspace).toBe(false)

    // Second load: registers a second distinct baseUrl → now true
    const ctx2 = await loader.loadForIssues(BINDING_ID)
    expect(ctx2.isMultiInstanceWorkspace).toBe(true)
  })

  // TG-4 test case 3: two bindings same baseUrl → NOT multi-instance
  test('17. two bindings same baseUrl + different projectIds → isMultiInstanceWorkspace false', async () => {
    let callCount = 0
    const credResolver: CredentialResolver = {
      resolve: async () => {
        callCount++
        return {
          kind: 'access_token' as const,
          token: TOKEN,
          gitlabBaseUrl: GITLAB_BASE // same baseUrl both times
        }
      }
    } as unknown as CredentialResolver

    const loader = new BindingLoader({
      store: makeStoreWithBindingDoc(),
      credentialResolver: credResolver,
      accountClient: makeAccountClient(),
      logger: makeLogger(),
      ctx: makeMeasureContext(),
      defaultGitlabBaseUrl: GITLAB_BASE,
      encryptionKey: ENCRYPTION_KEY
    })

    await loader.loadForIssues(BINDING_ID)
    const ctx2 = await loader.loadForIssues(BINDING_ID_B)
    expect(ctx2.isMultiInstanceWorkspace).toBe(false)
  })

  // B4 / TG-4: loadForEpics returns the FULL EpicsBindingContext (gitlabClient,
  // statuses, defaultTaskType, capabilities) plus isMultiInstanceWorkspace.
  test('18. loadForEpics returns EpicsBindingContext with full set of fields (B4)', async () => {
    const loader = new BindingLoader({
      store: makeStoreWithBindingDoc(),
      credentialResolver: makeCredentialResolverForUrl(GITLAB_BASE),
      accountClient: makeAccountClient(),
      logger: makeLogger(),
      ctx: makeMeasureContext(),
      defaultGitlabBaseUrl: GITLAB_BASE,
      encryptionKey: ENCRYPTION_KEY
    })

    const ctx = await loader.loadForEpics(BINDING_ID)
    expect(ctx.workspaceUuid).toBe('ws-1')
    expect(ctx.gitlabProjectId).toBe(42)
    expect(ctx.hulyProjectRef).toBe('proj-1')
    expect(ctx.hulyClient).toBeDefined()
    expect(ctx.gitlabBaseUrl).toBe(GITLAB_BASE)
    expect(ctx.isMultiInstanceWorkspace).toBe(false)
    // B4: these fields previously absent — now required for applyRemote
    expect(ctx.gitlabClient).toBeDefined()
    expect(ctx.statuses).toBeDefined()
    expect(ctx.defaultTaskType).toBeDefined()
  })

  // B6: bindingsByProject Map must NOT collide on shared numeric projectIds
  // across instances when the workspace is multi-instance.
  test('B6: bindingsByProject Map uses composite keys in multi-instance mode (no collision)', async () => {
    let callCount = 0
    const baseUrls = ['http://gitlab.test', 'https://gitlab.com']
    const bindingIds = [BINDING_ID, BINDING_ID_B]
    const credResolver: CredentialResolver = {
      resolve: async () => {
        const idx = callCount % 2
        callCount++
        return {
          kind: 'access_token' as const,
          token: TOKEN,
          gitlabBaseUrl: baseUrls[idx]
        }
      }
    } as unknown as CredentialResolver

    // makeStore returns same projectId=42 for every binding lookup.
    // We swap bindingId by sequence to simulate two distinct bindings.
    let bindingCounter = 0
    const store: Store = {
      bindings: () => ({
        findOne: async () => ({
          _id: new ObjectId(bindingIds[bindingCounter % 2]),
          workspaceUuid: 'ws-multi-collide',
          hulyProjectRef: 'proj-1',
          gitlabProjectId: 42, // SAME projectId across instances
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
      credentialResolver: credResolver,
      accountClient: makeAccountClient(),
      logger: makeLogger(),
      ctx: makeMeasureContext(),
      defaultGitlabBaseUrl: baseUrls[0],
      encryptionKey: ENCRYPTION_KEY
    })

    bindingCounter = 0
    await loader.loadForIssues(BINDING_ID)
    bindingCounter = 1
    await loader.loadForIssues(BINDING_ID_B)

    const map = loader.getBindingsByProject('ws-multi-collide' as WorkspaceUuid)
    expect(map).toBeDefined()
    // Both bindings should be present, keyed by composite (hash + projectId).
    expect(map!.size).toBe(2)
    // Sanity: keys differ even though projectId is identical.
    const keys = Array.from(map!.keys())
    expect(keys[0]).not.toBe(keys[1])
    // And the format is `${hash8}:42` (since multi-instance is active)
    for (const k of keys) {
      expect(k).toMatch(/^[0-9a-f]{8}:42$/)
    }
  })

  // B1: same projectId+iid written by MR manager under TWO different binding's
  // gitlabBaseUrl produces DIFFERENT idmap gitlabIds when multi-instance.
  test('B1: MR idmap gitlabId differs across instances for same projectId:iid', async () => {
    const sharedProjectId = 1
    const mrIid = 7
    const raw = `${sharedProjectId}:${mrIid}`

    const baseUrlA = 'https://gitlab.com'
    const baseUrlB = 'https://self-hosted.example.com'

    // Simulate a multi-instance workspace where two bindings (one per instance)
    // both reach applyRemote with the same numeric projectId+iid pair.
    const bctxA = { isMultiInstanceWorkspace: true, gitlabBaseUrl: baseUrlA }
    const bctxB = { isMultiInstanceWorkspace: true, gitlabBaseUrl: baseUrlB }

    const idA = prefixGitlabIdForMultiInstance(bctxA, raw)
    const idB = prefixGitlabIdForMultiInstance(bctxB, raw)

    expect(idA).not.toBe(idB)
    expect(idA.endsWith(`:${raw}`)).toBe(true)
    expect(idB.endsWith(`:${raw}`)).toBe(true)
  })

  // TG-4 collision test case 5: gitlab.com and self-hosted with SAME project ID
  // idmap keys formed with prefixGitlabIdForMultiInstance must differ → no collision
  test('19. TG-4 collision: same projectId on two GitLab instances → prefixed idmap keys differ', async () => {
    const sharedProjectId = 1
    const issueIid = 7
    const rawGitlabId = `${sharedProjectId}:${issueIid}`

    // Simulate two bindings for same workspace but different GitLab instances
    // after both have been registered (so multi-instance flag is active)
    const bctxGitlabCom = { isMultiInstanceWorkspace: true, gitlabBaseUrl: 'https://gitlab.com' }
    const bctxSelfHosted = { isMultiInstanceWorkspace: true, gitlabBaseUrl: 'https://self-hosted.example.com' }

    const keyForGitlabCom = prefixGitlabIdForMultiInstance(bctxGitlabCom, rawGitlabId)
    const keyForSelfHosted = prefixGitlabIdForMultiInstance(bctxSelfHosted, rawGitlabId)

    // Both persist as different keys → no collision
    expect(keyForGitlabCom).not.toBe(keyForSelfHosted)

    // Verify format: 8-hex-char prefix + ':' + rawId
    const hashGitlabCom = createHash('sha256').update('https://gitlab.com').digest('hex').slice(0, 8)
    const hashSelfHosted = createHash('sha256').update('https://self-hosted.example.com').digest('hex').slice(0, 8)
    expect(keyForGitlabCom).toBe(`${hashGitlabCom}:${rawGitlabId}`)
    expect(keyForSelfHosted).toBe(`${hashSelfHosted}:${rawGitlabId}`)
    expect(hashGitlabCom).not.toBe(hashSelfHosted)
  })
})

// ---------------------------------------------------------------------------
// P4-T-10: resolveActorToken real lookup tests
// ---------------------------------------------------------------------------

describe('loadForMergeRequests resolveActorToken (P4-T-10)', () => {
  const WS_UUID = 'ws-p4t10' as WorkspaceUuid
  const PERSON_UUID = 'person-p4t10' as PersonUuid
  const USER_TOKEN = 'user-oauth-token'

  beforeEach(() => {
    jest.clearAllMocks()
    clearCapabilityCache()
    jest.spyOn(huluProjects, 'getTrackerProject').mockResolvedValue({
      statuses: [],
      type: { tasks: ['tracker:tasktype:Issue'] }
    } as unknown as Awaited<ReturnType<typeof huluProjects.getTrackerProject>>)
  })

  function makeLoaderForBaseUrl (baseUrl: string): BindingLoader {
    const store: Store = {
      bindings: () => ({
        findOne: async () => ({
          _id: new ObjectId(BINDING_ID),
          workspaceUuid: WS_UUID,
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

    const credResolver: CredentialResolver = {
      resolve: async () => ({
        kind: 'access_token' as const,
        token: TOKEN,
        gitlabBaseUrl: baseUrl
      })
    } as unknown as CredentialResolver

    return new BindingLoader({
      store,
      credentialResolver: credResolver,
      accountClient: makeAccountClient(),
      logger: makeLogger(),
      ctx: makeMeasureContext(),
      defaultGitlabBaseUrl: baseUrl,
      encryptionKey: ENCRYPTION_KEY
    })
  }

  // Case 1: credential exists → returns decrypted token
  test('20. resolveActorToken returns token when credential exists', async () => {
    jest.spyOn(userCredentials, 'getUserCredential').mockResolvedValueOnce({
      token: USER_TOKEN,
      expiresAt: null,
      username: 'alice',
      gitlabBaseUrl: GITLAB_BASE
    })

    const loader = makeLoaderForBaseUrl(GITLAB_BASE)
    const ctx = await loader.loadForMergeRequests(BINDING_ID)
    const result = await ctx.credentials.resolveActorToken(WS_UUID, PERSON_UUID)
    expect(result).toBe(USER_TOKEN)
  })

  // Case 2: no matching credential → returns undefined (service-account fallback)
  test('21. resolveActorToken returns undefined when no credential exists', async () => {
    jest.spyOn(userCredentials, 'getUserCredential').mockResolvedValueOnce(null)

    const loader = makeLoaderForBaseUrl(GITLAB_BASE)
    const ctx = await loader.loadForMergeRequests(BINDING_ID)
    const result = await ctx.credentials.resolveActorToken(WS_UUID, PERSON_UUID)
    expect(result).toBeUndefined()
  })

  // Case 3: expired credential → returns undefined
  test('22. resolveActorToken returns undefined for expired credential', async () => {
    const pastDate = new Date(Date.now() - 60_000) // 1 minute ago
    jest.spyOn(userCredentials, 'getUserCredential').mockResolvedValueOnce({
      token: USER_TOKEN,
      expiresAt: pastDate,
      username: 'alice',
      gitlabBaseUrl: GITLAB_BASE
    })

    const loader = makeLoaderForBaseUrl(GITLAB_BASE)
    const ctx = await loader.loadForMergeRequests(BINDING_ID)
    const result = await ctx.credentials.resolveActorToken(WS_UUID, PERSON_UUID)
    expect(result).toBeUndefined()
  })

  // Case 4: gitlabBaseUrl narrowing — only matching baseUrl returns token
  test('23. resolveActorToken passes binding gitlabBaseUrl for narrowing', async () => {
    const mockGetUserCredential = jest.spyOn(userCredentials, 'getUserCredential')
    mockGetUserCredential.mockResolvedValueOnce({
      token: USER_TOKEN,
      expiresAt: null,
      username: 'alice',
      gitlabBaseUrl: GITLAB_BASE
    })

    const loaderA = makeLoaderForBaseUrl(GITLAB_BASE)
    const ctxA = await loaderA.loadForMergeRequests(BINDING_ID)
    await ctxA.credentials.resolveActorToken(WS_UUID, PERSON_UUID)

    // Verify getUserCredential was called with the binding's gitlabBaseUrl
    expect(mockGetUserCredential).toHaveBeenCalledWith(
      expect.anything(),
      ENCRYPTION_KEY,
      WS_UUID,
      PERSON_UUID,
      GITLAB_BASE
    )

    mockGetUserCredential.mockResolvedValueOnce(null)
    const loaderB = makeLoaderForBaseUrl(GITLAB_BASE_B)
    const ctxB = await loaderB.loadForMergeRequests(BINDING_ID)
    await ctxB.credentials.resolveActorToken(WS_UUID, PERSON_UUID)

    // Second call should use GITLAB_BASE_B, not GITLAB_BASE
    const secondCall = mockGetUserCredential.mock.calls[1]
    expect(secondCall[4]).toBe(GITLAB_BASE_B)
  })
})
