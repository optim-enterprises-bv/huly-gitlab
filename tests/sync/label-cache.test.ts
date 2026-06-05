import type { Ref, Space, TxOperations } from '@hcengineering/core'
import type { TagElement } from '@hcengineering/tags'
import { LabelCache, type LabelGitLabClient } from '../../src/sync/label-cache'
import type { SyncLabel } from '../../src/adapter/types'

function makeFakeGitlab (initial: SyncLabel[] = []): LabelGitLabClient & {
  created: SyncLabel[]
  listCalls: number
} {
  const created: SyncLabel[] = []
  let listCalls = 0
  return {
    created,
    listCalls,
    get listCallsCount (): number { return listCalls },
    listLabels: async (): Promise<SyncLabel[]> => {
      listCalls++
      return [...initial]
    },
    createLabel: async (_pid, body) => {
      const label: SyncLabel = {
        id: 100 + created.length,
        name: body.name,
        color: body.color,
        description: body.description ?? null
      }
      created.push(label)
      return label
    }
  } as unknown as LabelGitLabClient & { created: SyncLabel[], listCalls: number }
}

function makeFakeOps (): TxOperations & {
  created: Array<{ class: string, attrs: Record<string, unknown>, ref: string }>
} {
  const created: Array<{ class: string, attrs: Record<string, unknown>, ref: string }> = []
  let counter = 0
  const ops = {
    created,
    findAll: async () => [],
    findOne: async () => undefined,
    createDoc: async (cls: string, _space: unknown, attrs: Record<string, unknown>) => {
      const ref = `tag-ref-${++counter}`
      created.push({ class: String(cls), attrs, ref })
      return ref
    },
    updateDoc: async () => undefined,
    close: async () => undefined
  } as unknown as TxOperations & { created: typeof created }
  return ops
}

const PID = 42
const HULY_PROJECT = 'proj-x' as unknown as Ref<Space>

test('ensureRemoteLabel: existing label returned, no create call', async () => {
  const cache = new LabelCache(PID, HULY_PROJECT)
  const gitlab = makeFakeGitlab([
    { id: 1, name: 'bug', color: '#FF0000', description: null }
  ])
  const result = await cache.ensureRemoteLabel(gitlab, 'bug')
  expect(result.id).toBe(1)
  expect(gitlab.created).toHaveLength(0)
})

test('ensureRemoteLabel: missing label is created on GitLab', async () => {
  const cache = new LabelCache(PID, HULY_PROJECT)
  const gitlab = makeFakeGitlab([])
  const result = await cache.ensureRemoteLabel(gitlab, 'new-label', '#00FF00')
  expect(result.name).toBe('new-label')
  expect(result.color).toBe('#00FF00')
  expect(gitlab.created).toHaveLength(1)

  // Second call returns cached (no second create)
  await cache.ensureRemoteLabel(gitlab, 'new-label')
  expect(gitlab.created).toHaveLength(1)
})

test('ensureLocalTag: missing tag is created on Huly', async () => {
  const cache = new LabelCache(PID, HULY_PROJECT)
  const ops = makeFakeOps()
  const ref = await cache.ensureLocalTag(ops, 'feature')
  expect(ref).toMatch(/tag-ref-\d+/)
  expect(ops.created).toHaveLength(1)
  expect(ops.created[0].attrs.title).toBe('feature')

  // Second call returns cached value (no extra createDoc call)
  await cache.ensureLocalTag(ops, 'feature')
  expect(ops.created).toHaveLength(1)
})

test('ensureRemoteLabel: case-insensitive lookup', async () => {
  const cache = new LabelCache(PID, HULY_PROJECT)
  const gitlab = makeFakeGitlab([
    { id: 1, name: 'Bug', color: '#FF0000', description: null }
  ])
  const result = await cache.ensureRemoteLabel(gitlab, 'BUG')
  expect(result.id).toBe(1)
  expect(gitlab.created).toHaveLength(0)
})
