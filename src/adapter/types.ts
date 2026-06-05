export interface SyncUser {
  id: number
  username: string
  name: string
  email: string | null
  avatarUrl: string | null
  webUrl: string
}

export interface SyncLabel {
  id: number
  name: string
  color: string
  description: string | null
}

export interface SyncMilestone {
  id: number
  iid: number
  title: string
  description: string | null
  state: 'active' | 'closed'
  dueDate: string | null
  startDate: string | null
  createdAt: string
  updatedAt: string
}

export interface SyncNote {
  id: number
  body: string
  author: SyncUser
  createdAt: string
  updatedAt: string
  system: boolean
  confidential: boolean
  noteableType?: 'Issue' | 'MergeRequest'
}

export type MergeStatus = 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'locked'

export type SyncPipelineStatus = 'pending' | 'running' | 'success' | 'failed' | 'canceled'

export interface SyncMergeRequest {
  iid: number
  projectId: number
  title: string
  description: string
  state: 'opened' | 'closed' | 'merged' | 'locked'
  draft: boolean
  sourceBranch: string
  targetBranch: string
  mergeStatus: MergeStatus
  mergedAt: Date | null
  pipelineStatus: SyncPipelineStatus | null
  labels: string[]
  milestone: { iid: number, title: string } | null
  assignees: SyncUser[]
  reviewers: SyncUser[]
  author: SyncUser
  createdAt: Date
  updatedAt: Date
  webUrl: string
  confidential: boolean
}

export interface SyncPipeline {
  id: number
  projectId: number
  mergeRequestIid: number | null
  status: SyncPipelineStatus | null
  rawStatus: string
  updatedAt: Date
  webUrl: string
}

export interface SyncIssue {
  id: number
  iid: number
  projectId: number
  title: string
  description: string | null
  state: 'opened' | 'closed'
  labels: string[]
  milestone: SyncMilestone | null
  assignees: SyncUser[]
  author: SyncUser
  confidential: boolean
  createdAt: string
  updatedAt: string
  closedAt: string | null
  webUrl: string
}

export interface SyncProject {
  id: number
  name: string
  nameWithNamespace: string
  path: string
  pathWithNamespace: string
  description: string | null
  webUrl: string
  visibility: string
  defaultBranch: string | null
  createdAt: string
  lastActivityAt: string
}

export interface SyncWebhook {
  id: number
  url: string
  createdAt: string
  issuesEvents: boolean
  noteEvents: boolean
  pushEvents: boolean
  tagPushEvents: boolean
  mergeRequestsEvents: boolean
}

export interface Cursor {
  bindingId: string
  kind: 'issues' | 'notes'
  updatedAfter: string
}

/**
 * Capabilities detected from the connected GitLab instance.
 *
 * featureFlags is a closed, explicit set:
 *   - 'graphql.issue.notes': consumed by T-11 (NotesSyncManager batched note fetch)
 *   - 'graphql.issue.batchedNotes': consumed by T-04 GitLabClient.graphql<T> fallback decisions
 */
export interface Capabilities {
  gitlabVersion: string
  edition: 'ce' | 'ee'
  graphqlAvailable: boolean
  featureFlags: {
    /** Consumed by T-11: NotesSyncManager uses GraphQL to batch-fetch notes per issue */
    'graphql.issue.notes': boolean
    /** Consumed by T-04: GitLabClient.graphql<T> decides whether batched note queries are safe */
    'graphql.issue.batchedNotes': boolean
  }
}
