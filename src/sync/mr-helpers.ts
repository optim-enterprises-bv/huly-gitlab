import type { PersonUuid, Ref, TxOperations } from '@hcengineering/core'
import type { TagElement } from '@hcengineering/tags'
import { deepEqual } from 'fast-equals'
import type { SyncMergeRequest } from '../adapter/types'
import type { SyncUser as IdentitySyncUser, UserIdentity } from '../huly/users'
import type { LabelCache } from './label-cache'
import type { MRGitLabClient } from './mr'

export function stripDocPrefix (doc: string): string {
  const colon = doc.indexOf(':')
  if (colon < 0) return doc
  return doc.slice(colon + 1)
}

export function parseIid (gitlabId: string): number | null {
  // B1: multi-instance keys are `${hash8}:${projectId}:${iid}`; single-instance
  // keys are `${projectId}:${iid}`. iid is always the LAST `:`-separated segment.
  const colon = gitlabId.lastIndexOf(':')
  if (colon < 0) return null
  const n = Number.parseInt(gitlabId.slice(colon + 1), 10)
  return Number.isFinite(n) ? n : null
}

export function areEqual (a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    const sa = new Set(a as unknown[])
    const sb = new Set(b as unknown[])
    if (sa.size !== sb.size) return false
    for (const x of sa) {
      if (!sb.has(x)) return false
    }
    return true
  }
  return deepEqual(a, b)
}

export async function resolveAssignee (
  assignees: SyncMergeRequest['assignees'],
  userIdentity: UserIdentity
): Promise<PersonUuid | string | null> {
  if (assignees.length === 0) return null
  const first = assignees[0]
  const identity: IdentitySyncUser = {
    gitlabId: String(first.id),
    ...(first.email !== null ? { email: first.email } : {}),
    ...(first.name !== '' ? { name: first.name } : {}),
    ...(first.username !== '' ? { username: first.username } : {})
  }
  const matched = await userIdentity.mapByGitlabUser(identity)
  if (matched !== undefined) return matched
  return await userIdentity.ensureStubGuest(identity)
}

export async function resolveReviewerUuids (
  users: SyncMergeRequest['reviewers'],
  userIdentity: UserIdentity
): Promise<PersonUuid[] | undefined> {
  if (users === undefined) return undefined
  const out: PersonUuid[] = []
  for (const u of users) {
    const identity: IdentitySyncUser = {
      gitlabId: String(u.id),
      ...(u.email !== null ? { email: u.email } : {}),
      ...(u.name !== '' ? { name: u.name } : {}),
      ...(u.username !== '' ? { username: u.username } : {})
    }
    const matched = await userIdentity.mapByGitlabUser(identity)
    if (matched !== undefined) {
      out.push(matched)
    } else {
      const stub = await userIdentity.ensureStubGuest(identity)
      out.push(stub as unknown as PersonUuid)
    }
  }
  return out
}

export async function resolveLocalLabels (
  names: readonly string[],
  labelCache: LabelCache,
  hulyClient: TxOperations
): Promise<Array<Ref<TagElement>>> {
  const out: Array<Ref<TagElement>> = []
  for (const name of names) {
    const ref = await labelCache.ensureLocalTag(hulyClient, name)
    out.push(ref)
  }
  return out
}

export async function ensureRemoteLabels (
  labels: Array<{ name: string, color?: string }>,
  labelCache: LabelCache,
  gitlabClient: MRGitLabClient
): Promise<string[]> {
  const names: string[] = []
  for (const l of labels) {
    const ensured = await labelCache.ensureRemoteLabel(gitlabClient, l.name, l.color)
    names.push(ensured.name)
  }
  return names
}
