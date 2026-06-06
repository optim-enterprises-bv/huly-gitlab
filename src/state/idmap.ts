import { type Collection, type ObjectId } from 'mongodb'

/**
 * Frozen kind contract — consumed by Wave C (T-07 SyncManager, T-10, T-11).
 * Do not add kinds without updating Wave C tasks.
 */
export type GitlabKind = 'issue' | 'note' | 'user' | 'label' | 'milestone' | 'project' | 'merge_request' | 'pipeline' | 'review_thread' | 'epic' | 'iteration' | 'approval_rule'

export interface IdMapDoc {
  _id: ObjectId
  workspaceUuid: string
  gitlabKind: GitlabKind
  gitlabId: string
  hulyClass: string
  hulyRef: string
}

export async function upsertIdMap (
  col: Collection<IdMapDoc>,
  workspaceUuid: string,
  gitlabKind: GitlabKind,
  gitlabId: string,
  hulyClass: string,
  hulyRef: string
): Promise<void> {
  await col.updateOne(
    { workspaceUuid, gitlabKind, gitlabId },
    { $set: { workspaceUuid, gitlabKind, gitlabId, hulyClass, hulyRef } },
    { upsert: true }
  )
}

export async function findByGitlab (
  col: Collection<IdMapDoc>,
  workspaceUuid: string,
  gitlabKind: GitlabKind,
  gitlabId: string
): Promise<IdMapDoc | null> {
  return await col.findOne({ workspaceUuid, gitlabKind, gitlabId })
}

export async function findByHuly (
  col: Collection<IdMapDoc>,
  workspaceUuid: string,
  hulyClass: string,
  hulyRef: string
): Promise<IdMapDoc | null> {
  return await col.findOne({ workspaceUuid, hulyClass, hulyRef })
}

export async function deleteIdMapByBinding (
  col: Collection<IdMapDoc>,
  workspaceUuid: string
): Promise<void> {
  await col.deleteMany({ workspaceUuid })
}
