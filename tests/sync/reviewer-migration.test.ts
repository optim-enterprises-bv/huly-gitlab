import { ObjectId } from 'mongodb'
import type { PersonUuid, Ref, Space, TxOperations } from '@hcengineering/core'
import type { Issue } from '@hcengineering/tracker'
import type { TagElement } from '@hcengineering/tags'
import type { IdMapDoc } from '../../src/state/idmap'
import type { BindingDoc } from '../../src/state/bindings'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { UserIdentity } from '../../src/huly/users'
import { migrateReviewerLabels } from '../../src/sync/reviewer-migration'

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

/** In-memory IdMapDoc collection stub. Supports findOne + find cursor. */
function makeIdMapCol (initial: IdMapDoc[] = []) {
  const docs = [...initial]

  const toCursor = (results: IdMapDoc[]) => ({
    toArray: async () => results
  })

  return {
    docs,
    findOne: async (q: Record<string, unknown>): Promise<IdMapDoc | null> => {
      return docs.find((d) =>
        (q.workspaceUuid === undefined || d.workspaceUuid === q.workspaceUuid) &&
        (q.gitlabKind === undefined || d.gitlabKind === q.gitlabKind) &&
        (q.gitlabId === undefined || d.gitlabId === q.gitlabId)
      ) ?? null
    },
    find: (q: Record<string, unknown>) => {
      const ws = q.workspaceUuid as string | undefined
      const kind = q.gitlabKind as string | undefined
      const gitlabIdFilter = q.gitlabId as Record<string, string> | undefined
      const prefix: string | undefined = gitlabIdFilter?.$regex?.replace('^', '')

      const filtered = docs.filter((d) => {
        if (ws !== undefined && d.workspaceUuid !== ws) return false
        if (kind !== undefined && d.gitlabKind !== kind) return false
        if (prefix !== undefined && !d.gitlabId.startsWith(prefix)) return false
        return true
      })
      return toCursor(filtered)
    },
    updateOne: async () => ({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0, acknowledged: true })
  }
}

/** Tag elements store — findAll returns matching docs. */
function makeTagStore (tagDocs: Array<{ _id: string, title: string }>) {
  return tagDocs.map((t) => ({
    _id: t._id as unknown as Ref<TagElement>,
    title: t.title,
    _class: 'tags:class:TagElement' as unknown as TagElement['_class'],
    space: 'space-x' as unknown as TagElement['space'],
    modifiedOn: 0,
    modifiedBy: 'sys' as unknown as TagElement['modifiedBy'],
    targetClass: 'tracker:class:Issue' as unknown as TagElement['targetClass']
  }))
}

interface FakeIssue extends Issue {
  _id: Ref<Issue>
  labels: Array<Ref<TagElement>>
}

/** Minimal TxOperations stub. */
function makeHulyClient (
  issues: Map<Ref<Issue>, FakeIssue>,
  tagDocs: TagElement[],
  mixinDocs: Map<string, Record<string, unknown>> = new Map()
) {
  const updateDocCalls: Array<{ id: Ref<Issue>, update: Partial<Issue> }> = []
  const updateMixinCalls: Array<{ id: string, attrs: Record<string, unknown> }> = []

  const client = {
    updateDocCalls,
    updateMixinCalls,

    findOne: async (cls: unknown, q: Partial<Issue>): Promise<Issue | undefined> => {
      const clsStr = String(cls)
      if (q._id === undefined) return undefined
      // mixin lookup
      if (!clsStr.includes('tracker') && !clsStr.includes('Issue')) {
        const mixin = mixinDocs.get(String(q._id))
        if (mixin === undefined) return undefined
        return { ...mixin, _id: q._id } as unknown as Issue
      }
      return issues.get(q._id)
    },

    findAll: async (cls: unknown, q: Record<string, unknown>): Promise<TagElement[]> => {
      const clsStr = String(cls)
      if (!clsStr.includes('tag') && !clsStr.includes('Tag')) return []
      const inFilter = (q._id as Record<string, unknown> | undefined)?.$in as string[] | undefined
      if (inFilter === undefined) return tagDocs
      return tagDocs.filter((t) => inFilter.includes(String(t._id)))
    },

    updateDoc: async (
      _cls: unknown,
      _space: unknown,
      id: Ref<Issue>,
      update: Partial<Issue>
    ): Promise<void> => {
      updateDocCalls.push({ id, update })
      const existing = issues.get(id)
      if (existing !== undefined) {
        issues.set(id, { ...existing, ...update } as FakeIssue)
      }
    },

    updateMixin: async (
      objectId: string,
      _objectClass: unknown,
      _objectSpace: unknown,
      _mixin: unknown,
      attributes: Record<string, unknown>
    ): Promise<void> => {
      updateMixinCalls.push({ id: objectId, attrs: attributes })
      const cur = mixinDocs.get(objectId) ?? {}
      mixinDocs.set(objectId, { ...cur, ...attributes })
    },

    close: async () => undefined
  } as unknown as TxOperations & typeof client

  return client
}

function makeUserIdentity (
  mapping: Record<string, PersonUuid | undefined>
): UserIdentity {
  return {
    mapByGitlabUser: async (user: { username?: string }) => {
      const key = user.username ?? ''
      return mapping[key]
    }
  } as unknown as UserIdentity
}

function makeStore (idmapCol: ReturnType<typeof makeIdMapCol>): Store {
  return {
    idmap: () => idmapCol
  } as unknown as Store
}

function makeBinding (
  gitlabProjectId: number,
  workspaceUuid = 'ws-1',
  hulyProjectRef = 'project-ref-1'
): BindingDoc {
  return {
    _id: new ObjectId(),
    workspaceUuid,
    hulyProjectRef,
    gitlabProjectId,
    gitlabProjectPath: `group/project-${gitlabProjectId}`,
    credentialRef: 'cred-1',
    webhookSecretRef: 'secret-1',
    webhookRegistered: true,
    createdAt: new Date(),
    disabled: false
  }
}

function makeIdMapEntry (
  workspaceUuid: string,
  gitlabProjectId: number,
  mrIid: number,
  hulyRef: string
): IdMapDoc {
  return {
    _id: new ObjectId(),
    workspaceUuid,
    gitlabKind: 'merge_request',
    gitlabId: `${gitlabProjectId}:${mrIid}`,
    hulyClass: 'tracker:class:Issue',
    hulyRef
  }
}

function makeIssue (
  id: string,
  labels: string[] = []
): FakeIssue {
  return {
    _id: id as unknown as Ref<Issue>,
    _class: 'tracker:class:Issue' as unknown as Issue['_class'],
    space: 'project-ref-1' as unknown as Issue['space'],
    modifiedOn: Date.now(),
    modifiedBy: 'sys' as unknown as Issue['modifiedBy'],
    attachedTo: 'p' as unknown as Issue['attachedTo'],
    attachedToClass: 'tracker:class:Issue' as unknown as Issue['attachedToClass'],
    collection: 'issues',
    title: 'MR title',
    description: '',
    status: 'status-1' as unknown as Issue['status'],
    priority: 0,
    assignee: null,
    labels: labels as unknown as Array<Ref<TagElement>>,
    milestone: null,
    kind: 'task-type-1' as unknown as Issue['kind']
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateReviewerLabels', () => {
  // Case 1: Empty binding (no mirrored MRs) → all counters 0
  it('empty binding returns zero counters', async () => {
    const idmapCol = makeIdMapCol([])
    const hulyClient = makeHulyClient(new Map(), [])
    const result = await migrateReviewerLabels(
      { store: makeStore(idmapCol), hulyClient, userIdentity: makeUserIdentity({}), logger: makeLogger() },
      makeBinding(42)
    )
    expect(result.mrsScanned).toBe(0)
    expect(result.labelsStripped).toBe(0)
    expect(result.reviewersResolved).toBe(0)
    expect(result.unresolvedCount).toBe(0)
    expect(result.migratedAt).toBeTruthy()
  })

  // Case 2: Single MR with 2 reviewer labels → labels stripped, 2 PersonUuids resolved
  it('single MR with 2 reviewer labels resolves both and strips labels', async () => {
    const binding = makeBinding(42)
    const issueRef = 'huly-mr-1'
    const tagAliceRef = 'tag-alice'
    const tagBobRef = 'tag-bob'

    const idmapCol = makeIdMapCol([
      makeIdMapEntry('ws-1', 42, 1, issueRef)
    ])
    const issues = new Map<Ref<Issue>, FakeIssue>([[
      issueRef as unknown as Ref<Issue>,
      makeIssue(issueRef, [tagAliceRef, tagBobRef])
    ]])
    const tagDocs = makeTagStore([
      { _id: tagAliceRef, title: 'gitlab:reviewer:alice' },
      { _id: tagBobRef, title: 'gitlab:reviewer:bob' }
    ]) as unknown as TagElement[]

    const aliceUuid = 'uuid-alice' as PersonUuid
    const bobUuid = 'uuid-bob' as PersonUuid
    const hulyClient = makeHulyClient(issues, tagDocs)

    const result = await migrateReviewerLabels(
      {
        store: makeStore(idmapCol),
        hulyClient,
        userIdentity: makeUserIdentity({ alice: aliceUuid, bob: bobUuid }),
        logger: makeLogger()
      },
      binding
    )

    expect(result.mrsScanned).toBe(1)
    expect(result.labelsStripped).toBe(2)
    expect(result.reviewersResolved).toBe(2)
    expect(result.unresolvedCount).toBe(0)

    // Labels cleared on the issue
    const updatedIssue = issues.get(issueRef as unknown as Ref<Issue>)
    expect(updatedIssue?.labels).toEqual([])

    // Reviewers written to mixin
    const { updateMixinCalls } = hulyClient as ReturnType<typeof makeHulyClient>
    expect(updateMixinCalls).toHaveLength(1)
    const reviewers = updateMixinCalls[0].attrs.reviewers as PersonUuid[]
    expect(reviewers).toContain(aliceUuid)
    expect(reviewers).toContain(bobUuid)
  })

  // Case 3: Unresolvable reviewer → unresolvedCount incremented, label still stripped
  it('unresolvable reviewer increments unresolvedCount and strips label anyway', async () => {
    const binding = makeBinding(42)
    const issueRef = 'huly-mr-2'
    const tagRef = 'tag-ghost'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 2, issueRef)])
    const issues = new Map<Ref<Issue>, FakeIssue>([[
      issueRef as unknown as Ref<Issue>,
      makeIssue(issueRef, [tagRef])
    ]])
    const tagDocs = makeTagStore([
      { _id: tagRef, title: 'gitlab:reviewer:ghost' }
    ]) as unknown as TagElement[]

    const hulyClient = makeHulyClient(issues, tagDocs)

    const result = await migrateReviewerLabels(
      {
        store: makeStore(idmapCol),
        hulyClient,
        userIdentity: makeUserIdentity({}), // no mapping
        logger: makeLogger()
      },
      binding
    )

    expect(result.mrsScanned).toBe(1)
    expect(result.labelsStripped).toBe(1)
    expect(result.reviewersResolved).toBe(0)
    expect(result.unresolvedCount).toBe(1)

    const updatedIssue = issues.get(issueRef as unknown as Ref<Issue>)
    expect(updatedIssue?.labels).toEqual([])
  })

  // Case 4: Mixed labels — only reviewer labels matched and stripped; non-reviewer labels preserved
  it('only reviewer labels are stripped; non-reviewer labels preserved', async () => {
    const binding = makeBinding(42)
    const issueRef = 'huly-mr-3'
    const tagAliceRef = 'tag-alice'
    const tagPriorityRef = 'tag-priority'
    const tagBobRef = 'tag-bob'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 3, issueRef)])
    const issues = new Map<Ref<Issue>, FakeIssue>([[
      issueRef as unknown as Ref<Issue>,
      makeIssue(issueRef, [tagAliceRef, tagPriorityRef, tagBobRef])
    ]])
    const tagDocs = makeTagStore([
      { _id: tagAliceRef, title: 'gitlab:reviewer:alice' },
      { _id: tagPriorityRef, title: 'priority:high' },
      { _id: tagBobRef, title: 'gitlab:reviewer:bob' }
    ]) as unknown as TagElement[]

    const hulyClient = makeHulyClient(issues, tagDocs)

    const result = await migrateReviewerLabels(
      {
        store: makeStore(idmapCol),
        hulyClient,
        userIdentity: makeUserIdentity({
          alice: 'uuid-alice' as PersonUuid,
          bob: 'uuid-bob' as PersonUuid
        }),
        logger: makeLogger()
      },
      binding
    )

    expect(result.labelsStripped).toBe(2)
    expect(result.reviewersResolved).toBe(2)

    const updatedIssue = issues.get(issueRef as unknown as Ref<Issue>)
    expect(updatedIssue?.labels).toEqual([tagPriorityRef])
  })

  // Case 5: Multi-binding isolation (C12)
  it('only migrates MRs for the target binding; other binding issues untouched', async () => {
    const binding42 = makeBinding(42)
    const binding43 = makeBinding(43)

    const issueRef42 = 'huly-mr-42'
    const issueRef43 = 'huly-mr-43'
    const tagAliceRef = 'tag-alice'
    const tagCarolRef = 'tag-carol'

    const idmapCol = makeIdMapCol([
      makeIdMapEntry('ws-1', 42, 1, issueRef42),
      makeIdMapEntry('ws-1', 43, 1, issueRef43)
    ])

    const issue42 = makeIssue(issueRef42, [tagAliceRef])
    const issue43 = makeIssue(issueRef43, [tagCarolRef])

    const issues = new Map<Ref<Issue>, FakeIssue>([
      [issueRef42 as unknown as Ref<Issue>, issue42],
      [issueRef43 as unknown as Ref<Issue>, issue43]
    ])
    const tagDocs = makeTagStore([
      { _id: tagAliceRef, title: 'gitlab:reviewer:alice' },
      { _id: tagCarolRef, title: 'gitlab:reviewer:carol' }
    ]) as unknown as TagElement[]

    const hulyClient = makeHulyClient(issues, tagDocs)

    const result = await migrateReviewerLabels(
      {
        store: makeStore(idmapCol),
        hulyClient,
        userIdentity: makeUserIdentity({ alice: 'uuid-alice' as PersonUuid }),
        logger: makeLogger()
      },
      binding42
    )

    expect(result.mrsScanned).toBe(1)
    expect(result.labelsStripped).toBe(1)

    // issue43 labels untouched
    const issue43After = issues.get(issueRef43 as unknown as Ref<Issue>)
    expect(issue43After?.labels).toEqual([tagCarolRef])
  })

  // Case 6: Idempotent — second run is a no-op (labelsStripped=0)
  it('second run is a no-op when reviewer labels already stripped', async () => {
    const binding = makeBinding(42)
    const issueRef = 'huly-mr-idem'
    const tagAliceRef = 'tag-alice-idem'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 10, issueRef)])
    const issues = new Map<Ref<Issue>, FakeIssue>([[
      issueRef as unknown as Ref<Issue>,
      makeIssue(issueRef, [tagAliceRef])
    ]])
    const tagDocs = makeTagStore([
      { _id: tagAliceRef, title: 'gitlab:reviewer:alice' }
    ]) as unknown as TagElement[]

    const deps = {
      store: makeStore(idmapCol),
      hulyClient: makeHulyClient(issues, tagDocs),
      userIdentity: makeUserIdentity({ alice: 'uuid-alice' as PersonUuid }),
      logger: makeLogger()
    }

    const first = await migrateReviewerLabels(deps, binding)
    expect(first.labelsStripped).toBe(1)
    expect(first.mrsScanned).toBe(1)

    // After first run, issue has no reviewer labels. Second run should be a no-op.
    const second = await migrateReviewerLabels(deps, binding)
    expect(second.mrsScanned).toBe(1)
    expect(second.labelsStripped).toBe(0)
    expect(second.reviewersResolved).toBe(0)
  })

  // Case 7: Existing typed reviewers preserved
  it('existing typed reviewers are preserved when new reviewer is added', async () => {
    const binding = makeBinding(42)
    const issueRef = 'huly-mr-preserve'
    const tagBobRef = 'tag-bob-preserve'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 20, issueRef)])
    const issues = new Map<Ref<Issue>, FakeIssue>([[
      issueRef as unknown as Ref<Issue>,
      makeIssue(issueRef, [tagBobRef])
    ]])
    const tagDocs = makeTagStore([
      { _id: tagBobRef, title: 'gitlab:reviewer:bob' }
    ]) as unknown as TagElement[]

    const existingUuid = 'uuid-p1' as PersonUuid
    // Pre-populate mixin with existing reviewer P1
    const mixinDocs = new Map<string, Record<string, unknown>>([
      [issueRef, { reviewers: [existingUuid] }]
    ])

    const hulyClient = makeHulyClient(issues, tagDocs, mixinDocs)
    const bobUuid = 'uuid-bob' as PersonUuid

    const result = await migrateReviewerLabels(
      {
        store: makeStore(idmapCol),
        hulyClient,
        userIdentity: makeUserIdentity({ bob: bobUuid }),
        logger: makeLogger()
      },
      binding
    )

    expect(result.reviewersResolved).toBe(1)

    const { updateMixinCalls } = hulyClient as ReturnType<typeof makeHulyClient>
    expect(updateMixinCalls).toHaveLength(1)
    const reviewers = updateMixinCalls[0].attrs.reviewers as PersonUuid[]
    expect(reviewers).toContain(existingUuid)
    expect(reviewers).toContain(bobUuid)
    expect(reviewers).toHaveLength(2)
  })
})
