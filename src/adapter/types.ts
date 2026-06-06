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
  /** Phase 3 — present only for line comments (position_type === 'text'). */
  position?: SyncReviewPosition
}

export type MergeStatus = 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'locked'

export type ApprovalStatus = 'pending' | 'approved' | 'changes_requested'

export interface SyncChangedFile {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  status: 'added' | 'modified' | 'deleted' | 'renamed'
}

export type SyncReviewPosition =
  | { positionType: 'text', filePath: string, oldLine: number | null, newLine: number | null, baseSha: string, headSha: string, startSha: string }
  | { positionType: 'image', filePath: string, x: number, y: number, width: number, height: number, baseSha: string, headSha: string }
  | { positionType: 'file', filePath: string, baseSha: string, headSha: string }

export interface SyncReviewNote {
  id: number
  body: string
  author: SyncUser
  createdAt: Date
  updatedAt: Date
  system: boolean
  resolvable: boolean
  resolved: boolean
  position?: SyncReviewPosition
}

export interface SyncReviewThread {
  discussionId: string
  mergeRequestIid: number
  projectId: number
  resolved: boolean
  resolvedBy: SyncUser | null
  resolvedAt: Date | null
  notes: SyncReviewNote[]
  updatedAt: Date
}

export interface SyncMRChanges {
  diffWebUrl: string
  changedFiles: SyncChangedFile[]
}

export interface SyncMRApprovals {
  approvedBy: SyncUser[]
  approvalsRequired: number
}

export type SyncPipelineStatus = 'pending' | 'running' | 'success' | 'failed' | 'canceled'

export interface SyncMRApprovalRule {
  id: number
  name: string
  ruleType: 'regular' | 'any_approver' | 'code_owner' | 'report_approver'
  eligibleApprovers: SyncUser[]
  approvalsRequired: number
  approvedBy: SyncUser[]
}

export interface SyncIteration {
  id: string
  title: string
  startDate: Date
  dueDate: Date
  state: 'upcoming' | 'started' | 'closed'
  webUrl: string
}

export interface SyncEpic {
  iid: number
  groupId: number
  title: string
  description: string
  state: 'opened' | 'closed'
  webUrl: string
  childIssueIids: number[]
  author: SyncUser
  createdAt: Date
  updatedAt: Date
}

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
  author: SyncUser
  createdAt: Date
  updatedAt: Date
  webUrl: string
  confidential: boolean
  /**
   * OPTIONAL: only populated by getMergeRequest (composite fetch).
   * listMergeRequests returns these as undefined.
   * applyRemote MUST treat undefined as 'not yet fetched', NOT 'clear field'.
   */
  reviewers?: SyncUser[]
  approvedBy?: SyncUser[]
  approvalsRequired?: number
  approvalStatus?: ApprovalStatus
  diffWebUrl?: string
  changedFiles?: SyncChangedFile[]
  approvalRules?: SyncMRApprovalRule[]
  iteration?: SyncIteration | null
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
