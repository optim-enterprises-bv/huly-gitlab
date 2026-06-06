import type { Collection } from 'mongodb'
import { ObjectId } from 'mongodb'
import type { Ref, Space, TxOperations } from '@hcengineering/core'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { IdMapDoc } from '../../src/state/idmap'
import type { SyncPipeline } from '../../src/adapter/types'
import {
  PipelineSyncManager,
  type PipelineBindingContext,
  incrementPipelineLruDrop,
  getUnboundPipelineCount,
  getPipelineLruDropCount
} from '../../src/sync/pipeline'
import { reset as resetMetrics } from '../../src/metrics'
import type { SyncContext } from '../../src/sync/types'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

interface FakeIdMap extends Collection<IdMapDoc> {
  docs: IdMapDoc[]
}

function makeIdMap (): FakeIdMap {
  const docs: IdMapDoc[] = []
  return {
    docs,
    findOne: async (q: Record<string, unknown>) => {
      return docs.find((d) =>
        d.workspaceUuid === q.workspaceUuid &&
        (q.gitlabKind === undefined || d.gitlabKind === q.gitlabKind) &&
        (q.gitlabId === undefined || d.gitlabId === q.gitlabId)
      ) ?? null
    },
    updateOne: async (q: Record<string, unknown>, update: Record<string, unknown>) => {
      const set = (update.$set as Record<string, unknown>) ?? {}
      const existingIdx = docs.findIndex((d) =>
        d.workspaceUuid === q.workspaceUuid &&
        d.gitlabKind === q.gitlabKind &&
        d.gitlabId === q.gitlabId
      )
      if (existingIdx >= 0) {
        docs[existingIdx] = { ...docs[existingIdx], ...set } as IdMapDoc
      } else {
        docs.push({ _id: new ObjectId(), ...(set as object) } as IdMapDoc)
      }
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, acknowledged: true }
    }
  } as unknown as FakeIdMap
}

function makeStore (idmap: FakeIdMap): Store {
  return {
    idmap: () => idmap,
    cursors: () => ({})
  } as unknown as Store
}

interface FakeHulyClient extends TxOperations {
  mixinUpdates: Array<{ objectId: string, mixin: string, attributes: Record<string, unknown> }>
}

function makeHulyClient (): FakeHulyClient {
  const mixinUpdates: Array<{ objectId: string, mixin: string, attributes: Record<string, unknown> }> = []
  return {
    mixinUpdates,
    findOne: async () => undefined,
    findAll: async () => [],
    createDoc: async () => 'ref' as Ref<never>,
    updateDoc: async () => {},
    createMixin: async () => ({}),
    updateMixin: async (
      objectId: string,
      _objectClass: unknown,
      _objectSpace: unknown,
      mixin: string,
      attributes: Record<string, unknown>
    ) => {
      mixinUpdates.push({ objectId, mixin, attributes })
      return {}
    },
    close: async () => {}
  } as unknown as FakeHulyClient
}

const PROJECT_ID = 1

function makeBindingContext (hulyClient: FakeHulyClient): PipelineBindingContext {
  return {
    workspaceUuid: 'ws-1',
    gitlabProjectId: PROJECT_ID,
    hulyProjectRef: 'project-ref-1' as Ref<Space>,
    hulyClient
  }
}

function makeCtx (idmap: FakeIdMap): SyncContext {
  return {
    workspaceUuid: 'ws-1',
    logger: makeLogger(),
    store: makeStore(idmap)
  }
}

function makePipeline (overrides: Partial<SyncPipeline> = {}): SyncPipeline {
  return {
    id: 999,
    projectId: 1,
    mergeRequestIid: 42,
    status: 'success',
    rawStatus: 'success',
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    webUrl: 'https://gitlab.example.com/project/-/pipelines/999',
    ...overrides
  }
}

// Seed idmap with an MR entry so applyRemote can resolve it.
// IMPORTANT: idmap gitlabId for merge_request MUST be `${projectId}:${iid}` —
// the same format that MergeRequestsSyncManager writes. Seeding with just the
// iid masks the historical bug where PipelineSyncManager looked up by bare iid.
function seedMrInIdmap (
  idmap: FakeIdMap,
  workspaceUuid: string,
  mrIid: number,
  hulyRef: string,
  projectId: number = PROJECT_ID
): void {
  idmap.docs.push({
    _id: new ObjectId(),
    workspaceUuid,
    gitlabKind: 'merge_request',
    gitlabId: `${projectId}:${mrIid}`,
    hulyClass: 'tracker:class:Issue',
    hulyRef
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineSyncManager', () => {
  // Case 6: resourceKey
  describe('resourceKey', () => {
    const manager = new PipelineSyncManager({ loadBinding: async () => { throw new Error('not called') } })

    it('returns pipeline:<id> from object_attributes.id (webhook shape)', () => {
      const result = manager.resourceKey({ object_attributes: { id: 123 } })
      expect(result).toBe('pipeline:123')
    })

    it('returns pipeline:<id> from top-level id', () => {
      const result = manager.resourceKey({ id: 456 })
      expect(result).toBe('pipeline:456')
    })

    it('prefers object_attributes.id over top-level id', () => {
      const result = manager.resourceKey({ id: 1, object_attributes: { id: 2 } })
      expect(result).toBe('pipeline:2')
    })

    it('returns undefined when no id is present', () => {
      const result = manager.resourceKey({})
      expect(result).toBeUndefined()
    })
  })

  // Case 5: backfill no-op
  describe('backfill', () => {
    it('resolves to undefined and makes no adapter calls', async () => {
      const hulyClient = makeHulyClient()
      const idmap = makeIdMap()
      const ctx = makeCtx(idmap)
      const manager = new PipelineSyncManager({
        loadBinding: async () => makeBindingContext(hulyClient)
      })

      await expect(manager.backfill(ctx, 'binding-1', undefined)).resolves.toBeUndefined()
      expect(hulyClient.mixinUpdates).toHaveLength(0)
    })
  })

  // Case 4: applyLocal no-op
  describe('applyLocal', () => {
    it('makes no adapter calls', async () => {
      const hulyClient = makeHulyClient()
      const idmap = makeIdMap()
      const ctx = makeCtx(idmap)
      const manager = new PipelineSyncManager({
        loadBinding: async () => makeBindingContext(hulyClient)
      })

      await manager.applyLocal(ctx, 'binding-1', 'issue:some-ref', {})
      expect(hulyClient.mixinUpdates).toHaveLength(0)
    })
  })

  // Case 2: applyRemote with mergeRequestIid null → no-op, counter incremented
  describe('applyRemote — null mergeRequestIid', () => {
    it('does not call updateMixin and increments unboundPipelineCount', async () => {
      const hulyClient = makeHulyClient()
      const idmap = makeIdMap()
      const ctx = makeCtx(idmap)
      const manager = new PipelineSyncManager({
        loadBinding: async () => makeBindingContext(hulyClient)
      })

      resetMetrics()
      const pipeline = makePipeline({ mergeRequestIid: null })
      await manager.applyRemote(ctx, 'binding-1', pipeline)

      expect(hulyClient.mixinUpdates).toHaveLength(0)
      expect(getUnboundPipelineCount()).toBe(1)
    })
  })

  // Case 3: applyRemote with mergeRequestIid not in idmap → no-op
  describe('applyRemote — MR not in idmap', () => {
    it('does not call updateMixin when MR is not yet mirrored', async () => {
      const hulyClient = makeHulyClient()
      const idmap = makeIdMap()
      const ctx = makeCtx(idmap)
      const manager = new PipelineSyncManager({
        loadBinding: async () => makeBindingContext(hulyClient)
      })

      const pipeline = makePipeline({ mergeRequestIid: 999 })
      await manager.applyRemote(ctx, 'binding-1', pipeline)

      expect(hulyClient.mixinUpdates).toHaveLength(0)
    })
  })

  // Case 1: applyRemote writes ONLY pipelineStatus (critic C2 + C8)
  describe('applyRemote — writes only pipelineStatus', () => {
    it('calls updateMixin with ONLY pipelineStatus field', async () => {
      const hulyClient = makeHulyClient()
      const idmap = makeIdMap()
      const ctx = makeCtx(idmap)

      seedMrInIdmap(idmap, 'ws-1', 42, 'huly-issue-ref-42')

      const manager = new PipelineSyncManager({
        loadBinding: async () => makeBindingContext(hulyClient)
      })

      const pipeline = makePipeline({ mergeRequestIid: 42, status: 'success' })
      await manager.applyRemote(ctx, 'binding-1', pipeline)

      expect(hulyClient.mixinUpdates).toHaveLength(1)
      const call = hulyClient.mixinUpdates[0]
      expect(call.objectId).toBe('huly-issue-ref-42')
      expect(call.mixin).toBe('gitlab-mr')

      // Critic C2: ONLY pipelineStatus — no title, description, status, or other fields
      expect(call.attributes).toEqual({ pipelineStatus: 'success' })
      expect(Object.keys(call.attributes)).toHaveLength(1)
    })

    it('writes pipelineStatus: null when pipeline status is null', async () => {
      const hulyClient = makeHulyClient()
      const idmap = makeIdMap()
      const ctx = makeCtx(idmap)

      seedMrInIdmap(idmap, 'ws-1', 7, 'huly-issue-ref-7')

      const manager = new PipelineSyncManager({
        loadBinding: async () => makeBindingContext(hulyClient)
      })

      const pipeline = makePipeline({ mergeRequestIid: 7, status: null })
      await manager.applyRemote(ctx, 'binding-1', pipeline)

      expect(hulyClient.mixinUpdates).toHaveLength(1)
      expect(hulyClient.mixinUpdates[0].attributes).toEqual({ pipelineStatus: null })
    })
  })

  // Regression test for B1: idmap key format mismatch.
  // Before the fix, MergeRequestsSyncManager wrote idmap with `${projectId}:${iid}`
  // while PipelineSyncManager looked up by bare iid → ALWAYS missed.
  // Here we seed with the WRONG (bare-iid) format and assert lookup fails.
  describe('applyRemote — bare-iid idmap entry (B1 regression)', () => {
    it('does not match an idmap entry seeded with bare iid (no project prefix)', async () => {
      const hulyClient = makeHulyClient()
      const idmap = makeIdMap()
      const ctx = makeCtx(idmap)

      // Deliberately wrong format (the historical bug) — bare iid.
      idmap.docs.push({
        _id: new ObjectId(),
        workspaceUuid: 'ws-1',
        gitlabKind: 'merge_request',
        gitlabId: String(42),
        hulyClass: 'tracker:class:Issue',
        hulyRef: 'huly-issue-ref-42'
      })

      const manager = new PipelineSyncManager({
        loadBinding: async () => makeBindingContext(hulyClient)
      })

      const pipeline = makePipeline({ mergeRequestIid: 42, status: 'success' })
      await manager.applyRemote(ctx, 'binding-1', pipeline)

      // No mixin write — lookup correctly missed because the manager uses
      // `${projectId}:${iid}` which does not match the bare iid we seeded.
      expect(hulyClient.mixinUpdates).toHaveLength(0)
    })
  })

  // LRU eviction counter (Phase 2 limitation documented in pipeline.ts)
  describe('incrementPipelineLruDrop', () => {
    it('increments pipelineLruDropCount', () => {
      resetMetrics()
      incrementPipelineLruDrop()
      expect(getPipelineLruDropCount()).toBe(1)
    })
  })
})
