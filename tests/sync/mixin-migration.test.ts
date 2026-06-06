import { ObjectId } from 'mongodb'
import type { Ref, Space, TxOperations } from '@hcengineering/core'
import type { Issue } from '@hcengineering/tracker'
import type { IdMapDoc } from '../../src/state/idmap'
import type { BindingDoc } from '../../src/state/bindings'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import { migrateMixinSplit } from '../../src/sync/mixin-migration'
import { MR_MIXIN } from '../../src/sync/mr-mixin'
import { MR_CORE_MIXIN } from '../../src/sync/mr-core-mixin'
import { MR_REVIEW_MIXIN_DOC } from '../../src/sync/mr-review-mixin-doc'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

function makeIdMapCol (initial: IdMapDoc[] = []) {
  const docs = [...initial]
  const toCursor = (results: IdMapDoc[]) => ({
    toArray: async () => results
  })
  return {
    docs,
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
    }
  }
}

function makeBindingsCol (bindings: BindingDoc[]) {
  return {
    findOne: async (q: Record<string, unknown>): Promise<BindingDoc | null> => {
      const idFilter = q._id
      if (idFilter !== undefined) {
        const idStr = String(idFilter)
        return bindings.find((b) => b._id.toHexString() === idStr) ?? null
      }
      return null
    }
  }
}

function makeStore (
  idmapCol: ReturnType<typeof makeIdMapCol>,
  bindingsCol: ReturnType<typeof makeBindingsCol>
): Store {
  return {
    idmap: () => idmapCol,
    bindings: () => bindingsCol
  } as unknown as Store
}

/** TxOperations stub that stores mixin attrs keyed under their mixin id on the doc. */
function makeHulyClient (
  issueDocs: Map<string, Record<string, unknown>>
): TxOperations & {
  createMixinCalls: Array<{ id: string, mixin: string, attrs: Record<string, unknown> }>
  updateMixinCalls: Array<{ id: string, mixin: string, attrs: Record<string, unknown> }>
} {
  const createMixinCalls: Array<{ id: string, mixin: string, attrs: Record<string, unknown> }> = []
  const updateMixinCalls: Array<{ id: string, mixin: string, attrs: Record<string, unknown> }> = []

  const client = {
    createMixinCalls,
    updateMixinCalls,

    findOne: async (_cls: unknown, q: Partial<Issue>): Promise<Issue | undefined> => {
      const id = String(q._id)
      const doc = issueDocs.get(id)
      if (doc === undefined) return undefined
      return doc as unknown as Issue
    },

    createMixin: async (
      objectId: string,
      _objectClass: unknown,
      _objectSpace: unknown,
      mixin: unknown,
      attributes: Record<string, unknown>
    ): Promise<void> => {
      const mixinStr = String(mixin)
      createMixinCalls.push({ id: objectId, mixin: mixinStr, attrs: attributes })
      const doc = issueDocs.get(objectId) ?? {}
      doc[mixinStr] = { ...((doc[mixinStr] as Record<string, unknown> | undefined) ?? {}), ...attributes }
      issueDocs.set(objectId, doc)
    },

    updateMixin: async (
      objectId: string,
      _objectClass: unknown,
      _objectSpace: unknown,
      mixin: unknown,
      attributes: Record<string, unknown>
    ): Promise<void> => {
      const mixinStr = String(mixin)
      updateMixinCalls.push({ id: objectId, mixin: mixinStr, attrs: attributes })
      const doc = issueDocs.get(objectId) ?? {}
      const existing = (doc[mixinStr] as Record<string, unknown> | undefined) ?? {}
      const merged: Record<string, unknown> = { ...existing }
      for (const [k, v] of Object.entries(attributes)) {
        if (v === undefined) {
          delete merged[k]
        } else {
          merged[k] = v
        }
      }
      doc[mixinStr] = merged
      issueDocs.set(objectId, doc)
    }
  } as unknown as TxOperations & {
    createMixinCalls: typeof createMixinCalls
    updateMixinCalls: typeof updateMixinCalls
  }

  return client
}

function makeBinding (
  gitlabProjectId: number,
  workspaceUuid = 'ws-1',
  hulyProjectRef = 'project-ref-1',
  extras: Partial<BindingDoc> = {}
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
    disabled: true,
    ...extras
  } as BindingDoc
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

function makeIssueDoc (
  id: string,
  mixins: Record<string, Record<string, unknown>> = {}
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    _id: id,
    _class: 'tracker:class:Issue',
    space: 'project-ref-1',
    modifiedOn: 0,
    modifiedBy: 'sys',
    attachedTo: 'p',
    attachedToClass: 'tracker:class:Issue',
    collection: 'issues',
    title: 'MR title',
    description: '',
    status: 'status-1',
    priority: 0,
    assignee: null,
    labels: [],
    milestone: null,
    kind: 'task-type-1'
  }
  for (const [mixinId, attrs] of Object.entries(mixins)) {
    base[mixinId] = attrs
  }
  return base
}

/** Full 8-field legacy core payload + optional review fields. */
function fullLegacyMixinAttrs (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    draft: false,
    mergedAt: null,
    mergeStatus: 'can_be_merged',
    webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/1',
    gitlabIid: 1,
    gitlabProjectId: 42,
    reviewers: ['uuid-r1'],
    approvalsRequired: 2,
    diffWebUrl: 'https://gitlab.example.com/group/project/-/merge_requests/1/diffs',
    ...overrides
  }
}

const NO_DRAIN_DEPS = { drainTimeoutMs: 0, drainPollIntervalMs: 1 }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateMixinSplit', () => {
  // Case 1: empty binding → migrate runs cleanly, counters 0
  it('empty binding returns zero counters', async () => {
    const binding = makeBinding(42)
    const idmapCol = makeIdMapCol([])
    const bindingsCol = makeBindingsCol([binding])
    const issueDocs = new Map<string, Record<string, unknown>>()
    const hulyClient = makeHulyClient(issueDocs)

    const result = await migrateMixinSplit(
      { store: makeStore(idmapCol, bindingsCol), hulyClient, logger: makeLogger(), ...NO_DRAIN_DEPS },
      binding
    )

    expect(result.mrsScanned).toBe(0)
    expect(result.legacyStripped).toBe(0)
    expect(result.coreWritten).toBe(0)
    expect(result.reviewWritten).toBe(0)
    expect(result.unresolvedCount).toBe(0)
    expect(result.drainTimedOut).toBeUndefined()
  })

  // Case 2: single MR with legacy mixin → new core + review mixins written; legacy stripped
  it('single MR with legacy mixin splits into core+review and strips legacy', async () => {
    const binding = makeBinding(42)
    const issueRef = 'huly-mr-1'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 1, issueRef)])
    const bindingsCol = makeBindingsCol([binding])

    const legacyAttrs = fullLegacyMixinAttrs()
    const issueDocs = new Map<string, Record<string, unknown>>([[
      issueRef,
      makeIssueDoc(issueRef, { [MR_MIXIN as unknown as string]: legacyAttrs })
    ]])
    const hulyClient = makeHulyClient(issueDocs)

    const result = await migrateMixinSplit(
      { store: makeStore(idmapCol, bindingsCol), hulyClient, logger: makeLogger(), ...NO_DRAIN_DEPS },
      binding
    )

    expect(result.mrsScanned).toBe(1)
    expect(result.legacyStripped).toBe(1)
    expect(result.coreWritten).toBe(1)
    expect(result.reviewWritten).toBe(1)
    expect(result.unresolvedCount).toBe(0)

    const coreCall = hulyClient.createMixinCalls.find((c) => c.mixin === String(MR_CORE_MIXIN))
    expect(coreCall).toBeDefined()
    expect(coreCall?.attrs.sourceBranch).toBe('feature/x')
    expect(coreCall?.attrs.gitlabIid).toBe(1)
    expect(coreCall?.attrs.gitlabProjectId).toBe(42)

    const reviewCall = hulyClient.createMixinCalls.find((c) => c.mixin === String(MR_REVIEW_MIXIN_DOC))
    expect(reviewCall).toBeDefined()
    expect(reviewCall?.attrs.reviewers).toEqual(['uuid-r1'])
    expect(reviewCall?.attrs.approvalsRequired).toBe(2)

    // Legacy stripped: updateMixin called with MR_MIXIN; every key set to undefined
    const stripCall = hulyClient.updateMixinCalls.find((c) => c.mixin === String(MR_MIXIN))
    expect(stripCall).toBeDefined()
    for (const v of Object.values(stripCall?.attrs ?? {})) {
      expect(v).toBeUndefined()
    }
  })

  // Case 3: multi-binding isolated — only migrate binding-A's MRs
  it('multi-binding isolation: only migrates target binding MRs', async () => {
    const bindingA = makeBinding(42)
    const bindingB = makeBinding(43)
    const issueA = 'huly-mr-a'
    const issueB = 'huly-mr-b'

    const idmapCol = makeIdMapCol([
      makeIdMapEntry('ws-1', 42, 1, issueA),
      makeIdMapEntry('ws-1', 43, 1, issueB)
    ])
    const bindingsCol = makeBindingsCol([bindingA, bindingB])

    const issueDocs = new Map<string, Record<string, unknown>>([
      [issueA, makeIssueDoc(issueA, { [MR_MIXIN as unknown as string]: fullLegacyMixinAttrs({ gitlabProjectId: 42 }) })],
      [issueB, makeIssueDoc(issueB, { [MR_MIXIN as unknown as string]: fullLegacyMixinAttrs({ gitlabProjectId: 43 }) })]
    ])
    const hulyClient = makeHulyClient(issueDocs)

    const result = await migrateMixinSplit(
      { store: makeStore(idmapCol, bindingsCol), hulyClient, logger: makeLogger(), ...NO_DRAIN_DEPS },
      bindingA
    )

    expect(result.mrsScanned).toBe(1)
    expect(result.legacyStripped).toBe(1)
    expect(result.coreWritten).toBe(1)

    // Binding-B's issue untouched
    const issueBDoc = issueDocs.get(issueB)
    const issueBLegacy = issueBDoc?.[MR_MIXIN as unknown as string] as Record<string, unknown> | undefined
    expect(issueBLegacy?.sourceBranch).toBe('feature/x')

    // No createMixin call ever ran for issueB
    expect(hulyClient.createMixinCalls.every((c) => c.id !== issueB)).toBe(true)
  })

  // Case 4: idempotent — re-run on already-migrated MR is no-op
  it('idempotent: re-run on already-migrated MR makes no writes', async () => {
    const binding = makeBinding(42)
    const issueRef = 'huly-mr-1'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 1, issueRef)])
    const bindingsCol = makeBindingsCol([binding])
    const issueDocs = new Map<string, Record<string, unknown>>([[
      issueRef,
      makeIssueDoc(issueRef, { [MR_MIXIN as unknown as string]: fullLegacyMixinAttrs() })
    ]])
    const hulyClient = makeHulyClient(issueDocs)

    const deps = { store: makeStore(idmapCol, bindingsCol), hulyClient, logger: makeLogger(), ...NO_DRAIN_DEPS }

    const first = await migrateMixinSplit(deps, binding)
    expect(first.legacyStripped).toBe(1)
    expect(first.coreWritten).toBe(1)

    const createsBefore = hulyClient.createMixinCalls.length
    const updatesBefore = hulyClient.updateMixinCalls.length

    const second = await migrateMixinSplit(deps, binding)
    expect(second.mrsScanned).toBe(1)
    expect(second.legacyStripped).toBe(0)
    expect(second.coreWritten).toBe(0)
    expect(second.reviewWritten).toBe(0)

    // No new writes on the second run
    expect(hulyClient.createMixinCalls.length).toBe(createsBefore)
    expect(hulyClient.updateMixinCalls.length).toBe(updatesBefore)
  })

  // Case 5: MR with BOTH legacy AND new mixins → strip legacy only, don't duplicate writes
  it('mid-migration state with both legacy and new mixins: only strips legacy', async () => {
    const binding = makeBinding(42)
    const issueRef = 'huly-mr-mid'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 1, issueRef)])
    const bindingsCol = makeBindingsCol([binding])

    const existingCore = {
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      draft: false,
      mergedAt: null,
      mergeStatus: 'can_be_merged',
      webUrl: 'https://gitlab.example.com/p/-/merge_requests/1',
      gitlabIid: 1,
      gitlabProjectId: 42
    }
    const existingReview = { reviewers: ['uuid-x'] }

    const issueDocs = new Map<string, Record<string, unknown>>([[
      issueRef,
      makeIssueDoc(issueRef, {
        [MR_MIXIN as unknown as string]: fullLegacyMixinAttrs(),
        [MR_CORE_MIXIN as unknown as string]: existingCore,
        [MR_REVIEW_MIXIN_DOC as unknown as string]: existingReview
      })
    ]])
    const hulyClient = makeHulyClient(issueDocs)

    const result = await migrateMixinSplit(
      { store: makeStore(idmapCol, bindingsCol), hulyClient, logger: makeLogger(), ...NO_DRAIN_DEPS },
      binding
    )

    expect(result.mrsScanned).toBe(1)
    expect(result.legacyStripped).toBe(1)
    expect(result.coreWritten).toBe(0)
    expect(result.reviewWritten).toBe(0)

    // No createMixin for core or review
    expect(hulyClient.createMixinCalls.length).toBe(0)
    // Only the legacy strip ran
    expect(hulyClient.updateMixinCalls.length).toBe(1)
    expect(hulyClient.updateMixinCalls[0].mixin).toBe(String(MR_MIXIN))
  })

  // Case 6: MR with NO legacy mixin → no-op
  it('MR with no legacy mixin (fresh Phase 5 write) is a no-op', async () => {
    const binding = makeBinding(42)
    const issueRef = 'huly-mr-fresh'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 1, issueRef)])
    const bindingsCol = makeBindingsCol([binding])

    const issueDocs = new Map<string, Record<string, unknown>>([[
      issueRef,
      makeIssueDoc(issueRef, {
        [MR_CORE_MIXIN as unknown as string]: {
          sourceBranch: 'a', targetBranch: 'b', draft: false, mergedAt: null,
          mergeStatus: 'can_be_merged', webUrl: 'x', gitlabIid: 1, gitlabProjectId: 42
        }
      })
    ]])
    const hulyClient = makeHulyClient(issueDocs)

    const result = await migrateMixinSplit(
      { store: makeStore(idmapCol, bindingsCol), hulyClient, logger: makeLogger(), ...NO_DRAIN_DEPS },
      binding
    )

    expect(result.mrsScanned).toBe(1)
    expect(result.legacyStripped).toBe(0)
    expect(result.coreWritten).toBe(0)
    expect(result.reviewWritten).toBe(0)
    expect(hulyClient.createMixinCalls.length).toBe(0)
    expect(hulyClient.updateMixinCalls.length).toBe(0)
  })

  // Case 7b (M-5): binding un-paused during drain → abort with reason
  it('M-5 — binding un-paused during drain: returns success=false and skips strip', async () => {
    // Binding starts disabled=true (route checked), but in the store it's now disabled=false
    // (operator re-enabled mid-drain). After drain the function re-reads and aborts.
    const binding = makeBinding(42, 'ws-1', 'project-ref-1', { disabled: true })
    const bindingInStore = makeBinding(42, 'ws-1', 'project-ref-1', { disabled: false })
    // Override _id so re-read by id finds the un-paused version
    bindingInStore._id = binding._id
    const issueRef = 'huly-mr-unpaused'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 1, issueRef)])
    const bindingsCol = makeBindingsCol([bindingInStore])
    const issueDocs = new Map<string, Record<string, unknown>>([[
      issueRef,
      makeIssueDoc(issueRef, { [MR_MIXIN as unknown as string]: fullLegacyMixinAttrs() })
    ]])
    const hulyClient = makeHulyClient(issueDocs)

    const result = await migrateMixinSplit(
      { store: makeStore(idmapCol, bindingsCol), hulyClient, logger: makeLogger(), ...NO_DRAIN_DEPS },
      binding
    )

    expect(result.success).toBe(false)
    expect(result.reason).toBe('binding_unpaused_during_drain')
    expect(result.legacyStripped).toBe(0)
    expect(hulyClient.createMixinCalls.length).toBe(0)
    expect(hulyClient.updateMixinCalls.length).toBe(0)
  })

  // Case 7 (B4): backfill drain timeout returns partial result without stripping
  it('B4 — backfill drain timeout: returns drainTimedOut=true and skips strip', async () => {
    const binding = makeBinding(42, 'ws-1', 'project-ref-1', { backfillInFlight: true } as Partial<BindingDoc>)
    const issueRef = 'huly-mr-drain'

    const idmapCol = makeIdMapCol([makeIdMapEntry('ws-1', 42, 1, issueRef)])
    const bindingsCol = makeBindingsCol([binding])
    const issueDocs = new Map<string, Record<string, unknown>>([[
      issueRef,
      makeIssueDoc(issueRef, { [MR_MIXIN as unknown as string]: fullLegacyMixinAttrs() })
    ]])
    const hulyClient = makeHulyClient(issueDocs)

    const result = await migrateMixinSplit(
      {
        store: makeStore(idmapCol, bindingsCol),
        hulyClient,
        logger: makeLogger(),
        drainTimeoutMs: 50,
        drainPollIntervalMs: 10
      },
      binding
    )

    expect(result.drainTimedOut).toBe(true)
    expect(result.mrsScanned).toBe(0)
    expect(result.legacyStripped).toBe(0)
    // No writes when drain didn't complete
    expect(hulyClient.createMixinCalls.length).toBe(0)
    expect(hulyClient.updateMixinCalls.length).toBe(0)
  })
})

// Suppress unused-import warning for Ref/Space helpers in fakes.
void ({} as Ref<Space>)
