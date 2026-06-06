import { GraphQLClient } from 'graphql-request'
import type { Logger } from '../logging'
import { ApprovalActionError, AuthError, ConfidentialEpicError, ConfidentialIssueError, ConfidentialMergeRequestError, GitLabApiError, NotFoundError } from './errors'
import { withRateLimitRetry, type RateLimitHeaders } from './rate-limit'
import { validateGitLabBaseUrl } from '../util/url-validation'
import * as metrics from '../metrics'
import { METRIC_NAMES } from '../metrics'
import { GitLabGraphQLClient, detectGraphQLCapability } from './gitlab-graphql-client'
import type {
  ApprovalStatus,
  Capabilities,
  MergeStatus,
  SyncChangedFile,
  SyncEpic,
  SyncIssue,
  SyncIteration,
  SyncLabel,
  SyncMergeRequest,
  SyncMilestone,
  SyncMRApprovals,
  SyncMRApprovalRule,
  SyncMRChanges,
  SyncNote,
  SyncPipeline,
  SyncPipelineStatus,
  SyncProject,
  SyncReviewNote,
  SyncReviewPosition,
  SyncReviewThread,
  SyncUser,
  SyncWebhook
} from './types'

export function getMrCompositePartialCount (): number {
  return metrics.get(METRIC_NAMES.MR_COMPOSITE_PARTIAL)
}
export function resetMrCompositePartialCount (): void {
  metrics.reset(METRIC_NAMES.MR_COMPOSITE_PARTIAL)
}

export class InvalidGitLabBaseUrlError extends Error {
  constructor (reason: string) {
    super(reason)
    this.name = 'InvalidGitLabBaseUrlError'
  }
}

export interface GitLabClientOptions {
  baseUrl: string
  token: string
  logger: Logger
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

// Raw GitLab API shapes (private — never leak outside this file)
interface RawUser {
  id: number
  username: string
  name: string
  email?: string
  avatar_url?: string
  web_url: string
}

interface RawLabel {
  id: number
  name: string
  color: string
  description?: string | null
}

interface RawMilestone {
  id: number
  iid: number
  title: string
  description?: string | null
  state: string
  due_date?: string | null
  start_date?: string | null
  created_at: string
  updated_at: string
}

interface RawNote {
  id: number
  body: string
  author: RawUser
  created_at: string
  updated_at: string
  system: boolean
  confidential?: boolean
}

interface RawIssue {
  id: number
  iid: number
  project_id: number
  title: string
  description?: string | null
  state: string
  labels: string[]
  milestone?: RawMilestone | null
  assignees?: RawUser[]
  author: RawUser
  confidential: boolean
  created_at: string
  updated_at: string
  closed_at?: string | null
  web_url: string
}

interface RawProject {
  id: number
  name: string
  name_with_namespace: string
  path: string
  path_with_namespace: string
  description?: string | null
  web_url: string
  visibility: string
  default_branch?: string | null
  created_at: string
  last_activity_at: string
}

interface RawWebhook {
  id: number
  url: string
  created_at: string
  issues_events: boolean
  note_events: boolean
  push_events: boolean
  tag_push_events: boolean
  merge_requests_events: boolean
}

interface RawMergeRequest {
  iid: number
  project_id: number
  title: string
  description?: string | null
  state: string
  draft: boolean
  source_branch: string
  target_branch: string
  merge_status: string
  merged_at?: string | null
  head_pipeline?: { status: string } | null
  labels: string[]
  milestone?: { iid: number, title: string, iteration_id?: number | null, group_id?: number | null } | null
  iteration?: { id: number, group_id?: number | null } | null
  assignees?: RawUser[]
  reviewers?: RawUser[]
  author: RawUser
  created_at: string
  updated_at: string
  web_url: string
  confidential: boolean
}

interface RawPipeline {
  id: number
  project_id: number
  status: string
  updated_at: string
  web_url: string
  merge_request?: { iid: number } | null
}

interface RawDiscussionPosition {
  base_sha: string
  start_sha: string
  head_sha: string
  position_type?: string
  new_path?: string | null
  old_path?: string | null
  new_line?: number | null
  old_line?: number | null
  x?: number | null
  y?: number | null
  width?: number | null
  height?: number | null
}

interface RawDiscussionNote {
  id: number
  body: string
  author: RawUser
  created_at: string
  updated_at: string
  system: boolean
  resolvable?: boolean
  resolved?: boolean
  resolved_by?: RawUser | null
  resolved_at?: string | null
  position?: RawDiscussionPosition | null
}

interface RawDiscussion {
  id: string
  individual_note?: boolean
  notes: RawDiscussionNote[]
}

interface RawApprovalResponse {
  approvals_required?: number
  approved_by?: Array<{ user: RawUser }>
}

interface RawChange {
  old_path?: string
  new_path?: string
  new_file?: boolean
  deleted_file?: boolean
  renamed_file?: boolean
}

interface RawChangesResponse {
  web_url?: string
  changes?: RawChange[]
}

interface RawApprovalRule {
  id: number
  name: string
  rule_type: string
  eligible_approvers?: RawUser[]
  approvals_required: number
  approved_by?: Array<{ user?: RawUser } | RawUser>
}

interface RawIteration {
  id: number
  iid?: number
  title: string
  description?: string | null
  state: number | string
  start_date?: string | null
  due_date?: string | null
  web_url: string
}

interface RawEpic {
  id: number
  iid: number
  group_id: number
  title: string
  description?: string | null
  state: string
  web_url: string
  author: RawUser
  created_at: string
  updated_at: string
  confidential?: boolean
}

interface RawEpicIssue {
  id: number
  iid: number
  project_id: number
}

interface RawNamespace {
  id: number
  full_path: string
  kind?: string
}

interface RawProjectWithNamespace extends RawProject {
  namespace?: RawNamespace
}

interface RawGroup {
  id: number
  parent_id?: number | null
  full_path?: string
}

function mapMergeStatus (raw: string): MergeStatus {
  if (raw === 'can_be_merged' || raw === 'cannot_be_merged' || raw === 'unchecked' || raw === 'locked') {
    return raw
  }
  return 'unchecked'
}

function mapPipelineStatus (raw: string): SyncPipelineStatus | null {
  if (raw === 'success' || raw === 'failed' || raw === 'canceled' || raw === 'pending' || raw === 'running') {
    return raw
  }
  return null
}

/**
 * Map a raw GitLab MR to SyncMergeRequest. The Phase 3 optional fields
 * (`reviewers`, `approvedBy`, `approvalsRequired`, `approvalStatus`,
 * `diffWebUrl`, `changedFiles`) are deliberately LEFT UNDEFINED here.
 * - `listMergeRequests` callers receive minimal MR rows.
 * - `getMergeRequest` (composite fetch) overlays the populated fields after
 *   calling `getMRApprovals` + `getMRChanges` in parallel.
 *
 * `applyRemote` consumers MUST treat `undefined` as "not yet fetched"
 * (NOT "clear field"); see B2 in the Phase 3 plan.
 */
function mapMergeRequest (raw: RawMergeRequest, includeReviewers: boolean = false): SyncMergeRequest {
  const mr: SyncMergeRequest = {
    iid: raw.iid,
    projectId: raw.project_id,
    title: raw.title,
    description: raw.description ?? '',
    state: (raw.state === 'closed' || raw.state === 'merged' || raw.state === 'locked') ? raw.state : 'opened',
    draft: raw.draft,
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    mergeStatus: mapMergeStatus(raw.merge_status),
    mergedAt: raw.merged_at != null ? new Date(raw.merged_at) : null,
    pipelineStatus: raw.head_pipeline != null ? mapPipelineStatus(raw.head_pipeline.status) : null,
    labels: raw.labels,
    milestone: raw.milestone ?? null,
    assignees: (raw.assignees ?? []).map(mapUser),
    author: mapUser(raw.author),
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
    webUrl: raw.web_url,
    confidential: raw.confidential
  }
  if (includeReviewers) {
    mr.reviewers = (raw.reviewers ?? []).map(mapUser)
  }
  return mr
}

function mapPipeline (raw: RawPipeline): SyncPipeline {
  return {
    id: raw.id,
    projectId: raw.project_id,
    mergeRequestIid: raw.merge_request?.iid ?? null,
    status: mapPipelineStatus(raw.status),
    rawStatus: raw.status,
    updatedAt: new Date(raw.updated_at),
    webUrl: raw.web_url
  }
}

function mapUser (raw: RawUser): SyncUser {
  return {
    id: raw.id,
    username: raw.username,
    name: raw.name,
    email: raw.email ?? null,
    avatarUrl: raw.avatar_url ?? null,
    webUrl: raw.web_url
  }
}

function mapLabel (raw: RawLabel): SyncLabel {
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color,
    description: raw.description ?? null
  }
}

function mapMilestone (raw: RawMilestone): SyncMilestone {
  return {
    id: raw.id,
    iid: raw.iid,
    title: raw.title,
    description: raw.description ?? null,
    state: raw.state === 'closed' ? 'closed' : 'active',
    dueDate: raw.due_date ?? null,
    startDate: raw.start_date ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  }
}

function mapNote (raw: RawNote): SyncNote {
  return {
    id: raw.id,
    body: raw.body,
    author: mapUser(raw.author),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    system: raw.system,
    confidential: raw.confidential === true
  }
}

function mapIssue (raw: RawIssue): SyncIssue {
  return {
    id: raw.id,
    iid: raw.iid,
    projectId: raw.project_id,
    title: raw.title,
    description: raw.description ?? null,
    state: raw.state === 'closed' ? 'closed' : 'opened',
    labels: raw.labels,
    milestone: raw.milestone != null ? mapMilestone(raw.milestone) : null,
    assignees: (raw.assignees ?? []).map(mapUser),
    author: mapUser(raw.author),
    confidential: raw.confidential,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
    webUrl: raw.web_url
  }
}

function mapProject (raw: RawProject): SyncProject {
  return {
    id: raw.id,
    name: raw.name,
    nameWithNamespace: raw.name_with_namespace,
    path: raw.path,
    pathWithNamespace: raw.path_with_namespace,
    description: raw.description ?? null,
    webUrl: raw.web_url,
    visibility: raw.visibility,
    defaultBranch: raw.default_branch ?? null,
    createdAt: raw.created_at,
    lastActivityAt: raw.last_activity_at
  }
}

function mapWebhook (raw: RawWebhook): SyncWebhook {
  return {
    id: raw.id,
    url: raw.url,
    createdAt: raw.created_at,
    issuesEvents: raw.issues_events,
    noteEvents: raw.note_events,
    pushEvents: raw.push_events,
    tagPushEvents: raw.tag_push_events,
    mergeRequestsEvents: raw.merge_requests_events
  }
}

function mapReviewPosition (raw: RawDiscussionPosition): SyncReviewPosition {
  const filePath = raw.new_path ?? raw.old_path ?? ''
  const pt = raw.position_type ?? 'text'
  if (pt === 'image') {
    return {
      positionType: 'image',
      filePath,
      x: raw.x ?? 0,
      y: raw.y ?? 0,
      width: raw.width ?? 0,
      height: raw.height ?? 0,
      baseSha: raw.base_sha,
      headSha: raw.head_sha
    }
  }
  if (pt === 'file') {
    return {
      positionType: 'file',
      filePath,
      baseSha: raw.base_sha,
      headSha: raw.head_sha
    }
  }
  return {
    positionType: 'text',
    filePath,
    oldLine: raw.old_line ?? null,
    newLine: raw.new_line ?? null,
    baseSha: raw.base_sha,
    headSha: raw.head_sha,
    startSha: raw.start_sha
  }
}

function mapReviewNote (raw: RawDiscussionNote): SyncReviewNote {
  const note: SyncReviewNote = {
    id: raw.id,
    body: raw.body,
    author: mapUser(raw.author),
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
    system: raw.system,
    resolvable: raw.resolvable === true,
    resolved: raw.resolved === true
  }
  if (raw.position != null) {
    note.position = mapReviewPosition(raw.position)
  }
  return note
}

/**
 * Map a GitLab discussion to SyncReviewThread. Returns null when the discussion's
 * notes carry an unknown position type — caller drops the row and increments the
 * discussion.position.unsupported metric.
 */
function mapDiscussion (raw: RawDiscussion, projectId: number, mergeRequestIid: number): SyncReviewThread | null {
  if (raw.notes.length === 0) return null
  for (const n of raw.notes) {
    const pt = n.position?.position_type
    if (pt !== undefined && pt !== 'text' && pt !== 'image' && pt !== 'file') {
      return null
    }
  }
  const rootNote = raw.notes[0]
  const resolvedBy = rootNote.resolved_by != null ? mapUser(rootNote.resolved_by) : null
  const resolvedAt = rootNote.resolved_at != null ? new Date(rootNote.resolved_at) : null
  const notes = raw.notes.map(mapReviewNote)
  const updatedAtMs = notes.reduce((acc, n) => Math.max(acc, n.updatedAt.getTime()), 0)

  return {
    discussionId: raw.id,
    mergeRequestIid,
    projectId,
    resolved: rootNote.resolved === true,
    resolvedBy,
    resolvedAt,
    notes,
    updatedAt: new Date(updatedAtMs)
  }
}

function mapApproval (raw: RawApprovalResponse): SyncMRApprovals {
  return {
    approvedBy: (raw.approved_by ?? []).map((entry) => mapUser(entry.user)),
    approvalsRequired: raw.approvals_required ?? 0
  }
}

function mapChangedFileStatus (raw: RawChange): SyncChangedFile['status'] {
  if (raw.new_file === true) return 'added'
  if (raw.deleted_file === true) return 'deleted'
  if (raw.renamed_file === true) return 'renamed'
  return 'modified'
}

function mapChangedFile (raw: RawChange): SyncChangedFile {
  const path = raw.new_path ?? raw.old_path ?? ''
  const file: SyncChangedFile = {
    path,
    additions: 0,
    deletions: 0,
    status: mapChangedFileStatus(raw)
  }
  if (raw.renamed_file === true && raw.old_path !== undefined) {
    file.oldPath = raw.old_path
  }
  return file
}

function mapChanges (raw: RawChangesResponse, fallbackWebUrl: string): SyncMRChanges {
  const webUrl = raw.web_url ?? fallbackWebUrl
  return {
    diffWebUrl: `${webUrl}/diffs`,
    changedFiles: (raw.changes ?? []).map(mapChangedFile)
  }
}

function deriveApprovalStatus (approvals: SyncMRApprovals): ApprovalStatus {
  if (approvals.approvalsRequired > 0 && approvals.approvedBy.length >= approvals.approvalsRequired) {
    return 'approved'
  }
  return 'pending'
}

function mapApprovalRuleType (raw: string): SyncMRApprovalRule['ruleType'] {
  if (raw === 'regular' || raw === 'code_owner' || raw === 'any_approver' || raw === 'report_approver') {
    return raw
  }
  return 'regular'
}

function mapApprovalRule (raw: RawApprovalRule): SyncMRApprovalRule {
  const approvedBy: SyncUser[] = []
  for (const entry of raw.approved_by ?? []) {
    const wrapped = (entry as { user?: RawUser }).user
    const userObj: RawUser | undefined = wrapped ?? (entry as RawUser)
    if (userObj?.id !== undefined) {
      approvedBy.push(mapUser(userObj))
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    ruleType: mapApprovalRuleType(raw.rule_type),
    eligibleApprovers: (raw.eligible_approvers ?? []).map(mapUser),
    approvalsRequired: raw.approvals_required,
    approvedBy
  }
}

function mapIterationState (raw: number | string): SyncIteration['state'] {
  // GitLab API returns numeric state: 1=upcoming, 2=started, 3=closed
  if (raw === 1 || raw === '1' || raw === 'upcoming') return 'upcoming'
  if (raw === 2 || raw === '2' || raw === 'started' || raw === 'current') return 'started'
  if (raw === 3 || raw === '3' || raw === 'closed') return 'closed'
  return 'upcoming'
}

function mapIteration (raw: RawIteration): SyncIteration {
  return {
    id: String(raw.id),
    title: raw.title,
    startDate: raw.start_date != null ? new Date(raw.start_date) : new Date(0),
    dueDate: raw.due_date != null ? new Date(raw.due_date) : new Date(0),
    state: mapIterationState(raw.state),
    webUrl: raw.web_url
  }
}

function mapEpicState (raw: string): SyncEpic['state'] {
  return raw === 'closed' ? 'closed' : 'opened'
}

function mapEpic (raw: RawEpic, childIssueIids: number[] = []): SyncEpic {
  return {
    iid: raw.iid,
    groupId: raw.group_id,
    title: raw.title,
    description: raw.description ?? '',
    state: mapEpicState(raw.state),
    webUrl: raw.web_url,
    childIssueIids,
    author: mapUser(raw.author),
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at)
  }
}

// ---------------------------------------------------------------------------
// P5-T-22: GraphQL composite getMergeRequest mapping.
//
// `mapGraphQLMRResponse` is exported (for testability) and converts a single
// GraphQL `project.mergeRequest` payload into the canonical SyncMergeRequest
// shape that REST composite produces. Confidential MRs raise the same
// ConfidentialMergeRequestError the REST path raises so callers cannot
// observe a behavioral difference between paths.
// ---------------------------------------------------------------------------

export const GRAPHQL_MR_COMPOSITE_QUERY = `
  query MRComposite($projectFullPath: ID!, $mrIid: String!) {
    project(fullPath: $projectFullPath) {
      mergeRequest(iid: $mrIid) {
        iid
        title
        description
        state
        draft
        sourceBranch
        targetBranch
        mergeStatus
        mergedAt
        createdAt
        updatedAt
        webUrl
        confidential
        labels { nodes { title } }
        milestone { iid title }
        author { id username name publicEmail avatarUrl webUrl }
        assignees { nodes { id username name publicEmail avatarUrl webUrl } }
        reviewers { nodes { id username name publicEmail avatarUrl webUrl } }
        headPipeline { status }
        approved
        approvalsRequired
        approvedBy { nodes { id username name publicEmail avatarUrl webUrl } }
        approvalState {
          rules {
            id
            name
            type
            approvalsRequired
            eligibleApprovers { id username name publicEmail avatarUrl webUrl }
            approvedBy { nodes { id username name publicEmail avatarUrl webUrl } }
          }
        }
        diffStats { path additions deletions }
      }
    }
  }
`

interface GraphQLUser {
  id: string | number
  username: string
  name: string
  publicEmail?: string | null
  avatarUrl?: string | null
  webUrl: string
}

interface GraphQLMRRule {
  id: string | number
  name: string
  type?: string | null
  approvalsRequired: number
  eligibleApprovers?: GraphQLUser[] | null
  approvedBy?: { nodes?: GraphQLUser[] | null } | null
}

interface GraphQLMRDiffStat {
  path: string
  additions: number
  deletions: number
}

interface GraphQLMRPayload {
  iid: number | string
  title: string
  description?: string | null
  state: string
  draft: boolean
  sourceBranch: string
  targetBranch: string
  mergeStatus: string
  mergedAt?: string | null
  createdAt: string
  updatedAt: string
  webUrl: string
  confidential: boolean
  labels?: { nodes?: Array<{ title: string }> | null } | null
  milestone?: { iid: number | string, title: string } | null
  author: GraphQLUser
  assignees?: { nodes?: GraphQLUser[] | null } | null
  reviewers?: { nodes?: GraphQLUser[] | null } | null
  headPipeline?: { status: string } | null
  approved?: boolean | null
  approvalsRequired?: number | null
  approvedBy?: { nodes?: GraphQLUser[] | null } | null
  approvalState?: { rules?: GraphQLMRRule[] | null } | null
  diffStats?: GraphQLMRDiffStat[] | null
}

export interface GraphQLMRResponse {
  project: {
    mergeRequest: GraphQLMRPayload | null
  } | null
}

function numericId (raw: string | number): number {
  if (typeof raw === 'number') return raw
  const m = /(\d+)$/.exec(raw)
  return m !== null ? parseInt(m[1], 10) : 0
}

function mapGraphQLUser (raw: GraphQLUser): SyncUser {
  return {
    id: numericId(raw.id),
    username: raw.username,
    name: raw.name,
    email: raw.publicEmail ?? null,
    avatarUrl: raw.avatarUrl ?? null,
    webUrl: raw.webUrl
  }
}

function mapGraphQLMRState (raw: string): SyncMergeRequest['state'] {
  const s = raw.toLowerCase()
  if (s === 'closed' || s === 'merged' || s === 'locked') return s
  return 'opened'
}

function mapGraphQLMergeStatus (raw: string): MergeStatus {
  const s = raw.toLowerCase()
  if (s === 'can_be_merged' || s === 'cannot_be_merged' || s === 'unchecked' || s === 'locked') {
    return s
  }
  return 'unchecked'
}

function mapGraphQLRule (raw: GraphQLMRRule): SyncMRApprovalRule {
  return {
    id: numericId(raw.id),
    name: raw.name,
    ruleType: mapApprovalRuleType(raw.type ?? 'regular'),
    eligibleApprovers: (raw.eligibleApprovers ?? []).map(mapGraphQLUser),
    approvalsRequired: raw.approvalsRequired,
    approvedBy: (raw.approvedBy?.nodes ?? []).map(mapGraphQLUser)
  }
}

/**
 * Map a GraphQL composite MR response to SyncMergeRequest.
 * Throws ConfidentialMergeRequestError when the MR is confidential.
 * Throws NotFoundError when `project` or `mergeRequest` is null.
 */
export function mapGraphQLMRResponse (data: GraphQLMRResponse): SyncMergeRequest {
  const mr = data.project?.mergeRequest
  if (mr == null) {
    throw new NotFoundError('graphql.merge_request.null')
  }
  if (mr.confidential) {
    throw new ConfidentialMergeRequestError(numericId(mr.iid))
  }
  const approvedBy = (mr.approvedBy?.nodes ?? []).map(mapGraphQLUser)
  const approvalsRequired = mr.approvalsRequired ?? 0
  const approvalStatus: ApprovalStatus =
    approvalsRequired > 0 && approvedBy.length >= approvalsRequired ? 'approved' : 'pending'
  const changedFiles: SyncChangedFile[] = (mr.diffStats ?? []).map((d) => ({
    path: d.path,
    additions: d.additions,
    deletions: d.deletions,
    status: 'modified'
  }))
  const out: SyncMergeRequest = {
    iid: numericId(mr.iid),
    projectId: 0,
    title: mr.title,
    description: mr.description ?? '',
    state: mapGraphQLMRState(mr.state),
    draft: mr.draft,
    sourceBranch: mr.sourceBranch,
    targetBranch: mr.targetBranch,
    mergeStatus: mapGraphQLMergeStatus(mr.mergeStatus),
    mergedAt: mr.mergedAt != null ? new Date(mr.mergedAt) : null,
    pipelineStatus: mr.headPipeline != null ? mapPipelineStatus(mr.headPipeline.status) : null,
    labels: (mr.labels?.nodes ?? []).map((l) => l.title),
    milestone: mr.milestone != null ? { iid: numericId(mr.milestone.iid), title: mr.milestone.title } : null,
    assignees: (mr.assignees?.nodes ?? []).map(mapGraphQLUser),
    author: mapGraphQLUser(mr.author),
    createdAt: new Date(mr.createdAt),
    updatedAt: new Date(mr.updatedAt),
    webUrl: mr.webUrl,
    confidential: mr.confidential,
    reviewers: (mr.reviewers?.nodes ?? []).map(mapGraphQLUser),
    approvedBy,
    approvalsRequired,
    approvalStatus,
    diffWebUrl: `${mr.webUrl}/diffs`,
    changedFiles,
    approvalRules: (mr.approvalState?.rules ?? []).map(mapGraphQLRule)
  }
  return out
}

// ---------------------------------------------------------------------------
// P5-T-23: GraphQL listEpicsWithChildren mapping.
//
// Single-roundtrip query for a group's epics plus their child issue iids. The
// REST path requires one call per epic to populate `childIssueIids`, so on a
// group with N epics this collapses N+1 round-trips into 1. `mapGraphQLEpicNode`
// is exported for testability.
// ---------------------------------------------------------------------------

export const GRAPHQL_EPICS_WITH_CHILDREN_QUERY = `
  query EpicsWithChildren($groupFullPath: ID!, $updatedAfter: Time) {
    group(fullPath: $groupFullPath) {
      epics(updatedAfter: $updatedAfter) {
        nodes {
          iid
          title
          description
          state
          webUrl
          confidential
          createdAt
          updatedAt
          group { id }
          author { id username name publicEmail avatarUrl webUrl }
          issues {
            nodes { iid }
          }
        }
      }
    }
  }
`

interface GraphQLEpicIssueNode {
  iid: number | string
}

interface GraphQLEpicNode {
  iid: number | string
  title: string
  description?: string | null
  state: string
  webUrl: string
  confidential?: boolean | null
  createdAt: string
  updatedAt: string
  group?: { id: string | number } | null
  author: GraphQLUser
  issues?: { nodes?: GraphQLEpicIssueNode[] | null } | null
}

export interface GraphQLEpicsResponse {
  group: {
    epics: { nodes?: GraphQLEpicNode[] | null } | null
  } | null
}

function mapGraphQLEpicState (raw: string): SyncEpic['state'] {
  return raw.toLowerCase() === 'closed' ? 'closed' : 'opened'
}

/**
 * Map a single GraphQL epic node to SyncEpic.
 * Confidential epics are skipped by the caller (see listEpicsWithChildren).
 */
export function mapGraphQLEpicNode (raw: GraphQLEpicNode): SyncEpic {
  const childIssueIids: number[] = []
  for (const node of raw.issues?.nodes ?? []) {
    const iidRaw = node.iid
    const n = typeof iidRaw === 'number' ? iidRaw : parseInt(String(iidRaw), 10)
    if (Number.isFinite(n) && n > 0) {
      childIssueIids.push(n)
    }
  }
  return {
    iid: numericId(raw.iid),
    groupId: raw.group != null ? numericId(raw.group.id) : 0,
    title: raw.title,
    description: raw.description ?? '',
    state: mapGraphQLEpicState(raw.state),
    webUrl: raw.webUrl,
    childIssueIids,
    author: mapGraphQLUser(raw.author),
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt)
  }
}

// ---------------------------------------------------------------------------
// P5-T-24: GraphQL listMergeRequestsWithApprovals mapping.
//
// Reuses the same per-MR fields as the P5-T-22 composite query but for a list
// of MRs in a project. REST path needs one composite fetch per MR (3-5 calls
// each) — GraphQL fetches the whole page in a single round-trip.
// `mapGraphQLMRListNode` is exported for testability.
// ---------------------------------------------------------------------------

export const GRAPHQL_MR_LIST_WITH_APPROVALS_QUERY = `
  query MRListWithApprovals($projectFullPath: ID!, $updatedAfter: Time) {
    project(fullPath: $projectFullPath) {
      mergeRequests(updatedAfter: $updatedAfter) {
        nodes {
          iid
          title
          description
          state
          draft
          sourceBranch
          targetBranch
          mergeStatus
          mergedAt
          createdAt
          updatedAt
          webUrl
          confidential
          labels { nodes { title } }
          milestone { iid title }
          author { id username name publicEmail avatarUrl webUrl }
          assignees { nodes { id username name publicEmail avatarUrl webUrl } }
          reviewers { nodes { id username name publicEmail avatarUrl webUrl } }
          headPipeline { status }
          approved
          approvalsRequired
          approvedBy { nodes { id username name publicEmail avatarUrl webUrl } }
          approvalState {
            rules {
              id
              name
              type
              approvalsRequired
              eligibleApprovers { id username name publicEmail avatarUrl webUrl }
              approvedBy { nodes { id username name publicEmail avatarUrl webUrl } }
            }
          }
          diffStats { path additions deletions }
        }
      }
    }
  }
`

export interface GraphQLMRListResponse {
  project: {
    mergeRequests: { nodes?: GraphQLMRPayload[] | null } | null
  } | null
}

/**
 * Map a single GraphQL MR list node to SyncMergeRequest. Confidential MRs are
 * skipped by the caller (see listMergeRequestsWithApprovals). Unlike the
 * composite mapper, this does NOT throw NotFoundError on a null payload —
 * the caller iterates the nodes array and the array is the source of truth.
 */
export function mapGraphQLMRListNode (raw: GraphQLMRPayload): SyncMergeRequest {
  return mapGraphQLMRResponse({ project: { mergeRequest: raw } })
}

interface ApprovalRuleCacheEntry {
  value: SyncMRApprovalRule[]
  expiresAt: number
}

interface TopLevelGroupCacheEntry {
  groupId: number
  expiresAt: number
}

const APPROVAL_RULES_CACHE_TTL_MS = 10 * 1000
const APPROVAL_RULES_CACHE_CAPACITY = 256
const TOP_LEVEL_GROUP_CACHE_TTL_MS = 60 * 60 * 1000

export class GitLabClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly logger: Logger
  private _capabilities: Capabilities | null = null
  // P4-R3: short-TTL LRU cache for getMRApprovalRules — bounded by capacity.
  // Map preserves insertion order; we evict the oldest entry when over capacity.
  private readonly approvalRulesCache = new Map<string, ApprovalRuleCacheEntry>()
  // Bug-1: cache of top-level group id per project for 1 hour.
  private readonly topLevelGroupCache = new Map<number, TopLevelGroupCacheEntry>()

  constructor (opts: GitLabClientOptions) {
    try {
      validateGitLabBaseUrl(opts.baseUrl)
    } catch (err) {
      throw new InvalidGitLabBaseUrlError(err instanceof Error ? err.message : String(err))
    }
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.logger = opts.logger
  }

  /**
   * Capability gate: returns true on EE, false on CE. When capabilities have not
   * yet been detected (null), this conservatively returns false so EE-only methods
   * return empty results until detectCapabilities() runs.
   */
  private ensureEE (): boolean {
    return this._capabilities?.edition === 'ee'
  }

  private now (): number {
    return Date.now()
  }

  private approvalRulesCacheKey (projectId: number | string, mrIid: number): string {
    return `${String(projectId)}:${mrIid}`
  }

  private approvalRulesCacheGet (key: string): SyncMRApprovalRule[] | null {
    const entry = this.approvalRulesCache.get(key)
    if (entry === undefined) return null
    if (this.now() >= entry.expiresAt) {
      this.approvalRulesCache.delete(key)
      return null
    }
    // refresh LRU position
    this.approvalRulesCache.delete(key)
    this.approvalRulesCache.set(key, entry)
    return entry.value
  }

  private approvalRulesCacheSet (key: string, value: SyncMRApprovalRule[]): void {
    if (this.approvalRulesCache.has(key)) {
      this.approvalRulesCache.delete(key)
    }
    this.approvalRulesCache.set(key, { value, expiresAt: this.now() + APPROVAL_RULES_CACHE_TTL_MS })
    while (this.approvalRulesCache.size > APPROVAL_RULES_CACHE_CAPACITY) {
      const oldestKey = this.approvalRulesCache.keys().next().value
      if (oldestKey === undefined) break
      this.approvalRulesCache.delete(oldestKey)
    }
  }

  private invalidateApprovalRulesCache (projectId: number | string, mrIid: number): void {
    this.approvalRulesCache.delete(this.approvalRulesCacheKey(projectId, mrIid))
  }

  get capabilities (): Capabilities | null {
    return this._capabilities
  }

  set capabilities (caps: Capabilities) {
    this._capabilities = caps
  }

  /**
   * Generic JSON request helper for GitLab REST API v4.
   *
   * Phase 3 (C6): accepts an optional `tokenOverride` that — when provided —
   * is used as the `PRIVATE-TOKEN` header instead of the instance token. This
   * supports per-call actor attribution for approve/unapprove operations where
   * the caller passes a user-specific OAuth token.
   *
   * When omitted, the helper falls back to the binding's stored service-account
   * token. All existing callers continue to work without changes.
   */
  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
    tokenOverride?: string
  ): Promise<T> {
    // B8 / Security M1: when a caller supplies tokenOverride, validate it
    // before placing it in the PRIVATE-TOKEN HTTP header. Reject empty,
    // oversized, or CRLF/NUL-bearing values so a bad actor token cannot inject
    // headers or be silently accepted.
    validateActorTokenHeader(tokenOverride)

    const url = new URL(`${this.baseUrl}${path}`)
    if (opts.query !== undefined) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) {
          url.searchParams.set(k, String(v))
        }
      }
    }

    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': tokenOverride ?? this.token,
      'Content-Type': 'application/json'
    }

    const fetchOpts: RequestInit = {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }

    const urlStr = url.toString()

    return await withRateLimitRetry(async () => {
      const res = await fetch(urlStr, fetchOpts)

      const rlHeaders: RateLimitHeaders = {
        'retry-after': res.headers.get('retry-after') ?? undefined,
        'ratelimit-remaining': res.headers.get('ratelimit-remaining') ?? undefined,
        'ratelimit-reset': res.headers.get('ratelimit-reset') ?? undefined,
        'x-ratelimit-remaining': res.headers.get('x-ratelimit-remaining') ?? undefined,
        'x-ratelimit-reset': res.headers.get('x-ratelimit-reset') ?? undefined
      }

      return {
        status: res.status,
        headers: rlHeaders,
        body: async () => {
          if (res.status === 401 || res.status === 403) {
            const text = await res.text()
            throw new AuthError(`GitLab auth error ${res.status}: ${text}`)
          }
          if (res.status === 404) {
            throw new NotFoundError(`${method} ${path}`)
          }
          if (res.status >= 400) {
            const text = await res.text()
            throw new GitLabApiError(`GitLab API error ${res.status}: ${text}`, res.status, text)
          }
          if (res.status === 204) {
            return undefined as unknown as T
          }
          return await res.json() as T
        }
      }
    })
  }

  /**
   * Execute a GraphQL query against GitLab's GraphQL API.
   * Only callable when capabilities.graphqlAvailable === true.
   */
  async graphql<T>(query: string, vars?: Record<string, unknown>): Promise<T> {
    if (this._capabilities !== null && !this._capabilities.graphqlAvailable) {
      throw new GitLabApiError('GraphQL is not available on this GitLab instance', 0)
    }
    const client = new GraphQLClient(`${this.baseUrl}/api/graphql`, {
      headers: { 'PRIVATE-TOKEN': this.token }
    })
    return await client.request<T>(query, vars)
  }

  async listProjects (opts: { page?: number, perPage?: number } = {}): Promise<{ items: SyncProject[], nextPage: number | null }> {
    const page = opts.page ?? 1
    const perPage = opts.perPage ?? 20

    const rawUrl = new URL(`${this.baseUrl}/api/v4/projects`)
    rawUrl.searchParams.set('page', String(page))
    rawUrl.searchParams.set('per_page', String(perPage))
    rawUrl.searchParams.set('membership', 'true')

    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.token
    }

    let nextPage: number | null = null
    let items: SyncProject[] = []

    await withRateLimitRetry(async () => {
      const res = await fetch(rawUrl.toString(), { headers })
      const rlHeaders: RateLimitHeaders = {
        'retry-after': res.headers.get('retry-after') ?? undefined,
        'ratelimit-remaining': res.headers.get('ratelimit-remaining') ?? undefined,
        'ratelimit-reset': res.headers.get('ratelimit-reset') ?? undefined
      }
      return {
        status: res.status,
        headers: rlHeaders,
        body: async () => {
          if (res.status >= 400) {
            const text = await res.text()
            throw new GitLabApiError(`GitLab API error ${res.status}: ${text}`, res.status, text)
          }
          const raw = await res.json() as RawProject[]
          items = raw.map(mapProject)
          const nextPageHeader = res.headers.get('x-next-page')
          nextPage = (nextPageHeader !== null && nextPageHeader !== '') ? parseInt(nextPageHeader, 10) : null
        }
      }
    })

    return { items, nextPage }
  }

  async getProject (id: number | string): Promise<SyncProject> {
    const raw = await this.request<RawProject>('GET', `/api/v4/projects/${id}`)
    return mapProject(raw)
  }

  /**
   * List issues for a project.
   * Per Q5 resolution: MUST set confidential=false query param to skip confidential issues.
   * Emits a gitlab.confidential.skipped log metric for any confidential issue encountered.
   */
  async listIssues (
    projectId: number | string,
    opts: { updatedAfter?: string, confidentialOnly?: false } = {}
  ): Promise<SyncIssue[]> {
    const query: Record<string, string | number | boolean | undefined> = {
      per_page: 100,
      // Q5: explicitly exclude confidential issues
      confidential: false
    }
    if (opts.updatedAfter !== undefined) {
      query.updated_after = opts.updatedAfter
    }

    const raw = await this.request<RawIssue[]>('GET', `/api/v4/projects/${projectId}/issues`, { query })

    // Defense-in-depth: filter any confidential issues that slipped through
    const filtered: SyncIssue[] = []
    for (const issue of raw) {
      if (issue.confidential) {
        this.logger.info('gitlab.confidential.skipped', { projectId, iid: issue.iid })
        continue
      }
      filtered.push(mapIssue(issue))
    }
    return filtered
  }

  /**
   * Get a single issue by iid.
   * Per Q5 resolution: MUST throw ConfidentialIssueError if the issue is confidential.
   * Never returns content of a confidential issue.
   */
  async getIssue (projectId: number | string, iid: number): Promise<SyncIssue> {
    const raw = await this.request<RawIssue>('GET', `/api/v4/projects/${projectId}/issues/${iid}`)
    if (raw.confidential) {
      throw new ConfidentialIssueError(projectId, iid)
    }
    return mapIssue(raw)
  }

  async createIssue (projectId: number | string, body: {
    title: string
    description?: string
    labels?: string
    milestone_id?: number
    assignee_ids?: number[]
    state_event?: 'close' | 'reopen'
  }): Promise<SyncIssue> {
    const raw = await this.request<RawIssue>('POST', `/api/v4/projects/${projectId}/issues`, { body })
    return mapIssue(raw)
  }

  async updateIssue (projectId: number | string, iid: number, body: {
    title?: string
    description?: string
    labels?: string
    milestone_id?: number
    assignee_ids?: number[]
    state_event?: 'close' | 'reopen'
  }): Promise<SyncIssue> {
    const raw = await this.request<RawIssue>('PUT', `/api/v4/projects/${projectId}/issues/${iid}`, { body })
    return mapIssue(raw)
  }

  async listNotes (
    projectId: number | string,
    issueIid: number,
    opts: { updatedAfter?: string } = {}
  ): Promise<SyncNote[]> {
    const query: Record<string, string | number | boolean | undefined> = {
      per_page: 100
    }
    if (opts.updatedAfter !== undefined) {
      query.updated_after = opts.updatedAfter
    }

    const raw = await this.request<RawNote[]>(
      'GET',
      `/api/v4/projects/${projectId}/issues/${issueIid}/notes`,
      { query }
    )

    // Filter confidential notes per Q5 resolution
    const filtered: SyncNote[] = []
    for (const note of raw) {
      if (note.confidential === true) {
        this.logger.info('gitlab.confidential.skipped', { projectId, issueIid, noteId: note.id })
        continue
      }
      filtered.push(mapNote(note))
    }
    return filtered
  }

  async createNote (
    projectId: number | string,
    issueIid: number,
    body: { body: string }
  ): Promise<SyncNote> {
    const raw = await this.request<RawNote>(
      'POST',
      `/api/v4/projects/${projectId}/issues/${issueIid}/notes`,
      { body }
    )
    return mapNote(raw)
  }

  async updateNote (
    projectId: number | string,
    issueIid: number,
    noteId: number,
    body: { body: string }
  ): Promise<SyncNote> {
    const raw = await this.request<RawNote>(
      'PUT',
      `/api/v4/projects/${projectId}/issues/${issueIid}/notes/${noteId}`,
      { body }
    )
    return mapNote(raw)
  }

  async deleteNote (
    projectId: number | string,
    issueIid: number,
    noteId: number
  ): Promise<void> {
    await this.request<undefined>(
      'DELETE',
      `/api/v4/projects/${projectId}/issues/${issueIid}/notes/${noteId}`
    )
  }

  async listLabels (projectId: number | string): Promise<SyncLabel[]> {
    const raw = await this.request<RawLabel[]>('GET', `/api/v4/projects/${projectId}/labels`, {
      query: { per_page: 100 }
    })
    return raw.map(mapLabel)
  }

  async createLabel (projectId: number | string, body: {
    name: string
    color: string
    description?: string
  }): Promise<SyncLabel> {
    const raw = await this.request<RawLabel>('POST', `/api/v4/projects/${projectId}/labels`, { body })
    return mapLabel(raw)
  }

  async listMilestones (projectId: number | string): Promise<SyncMilestone[]> {
    const raw = await this.request<RawMilestone[]>('GET', `/api/v4/projects/${projectId}/milestones`, {
      query: { per_page: 100 }
    })
    return raw.map(mapMilestone)
  }

  async createMilestone (projectId: number | string, body: {
    title: string
    description?: string
    due_date?: string
    start_date?: string
  }): Promise<SyncMilestone> {
    const raw = await this.request<RawMilestone>('POST', `/api/v4/projects/${projectId}/milestones`, { body })
    return mapMilestone(raw)
  }

  async getCurrentUser (): Promise<SyncUser> {
    const raw = await this.request<RawUser>('GET', '/api/v4/user')
    return mapUser(raw)
  }

  async lookupUserByEmail (email: string): Promise<SyncUser | null> {
    const raw = await this.request<RawUser[]>('GET', '/api/v4/users', {
      query: { search: email, per_page: 5 }
    })
    const match = raw.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    return match !== undefined ? mapUser(match) : null
  }

  async listProjectWebhooks (projectId: number | string): Promise<SyncWebhook[]> {
    const raw = await this.request<RawWebhook[]>('GET', `/api/v4/projects/${projectId}/hooks`)
    return raw.map(mapWebhook)
  }

  async createProjectWebhook (
    projectId: number | string,
    body: Record<string, unknown>
  ): Promise<SyncWebhook> {
    const raw = await this.request<RawWebhook>('POST', `/api/v4/projects/${projectId}/hooks`, { body })
    return mapWebhook(raw)
  }

  async deleteProjectWebhook (projectId: number | string, hookId: number): Promise<void> {
    await this.request<undefined>('DELETE', `/api/v4/projects/${projectId}/hooks/${hookId}`)
  }

  async updateProjectWebhook (
    projectId: number | string,
    hookId: number,
    body: Record<string, unknown>
  ): Promise<SyncWebhook> {
    const raw = await this.request<RawWebhook>(
      'PUT',
      `/api/v4/projects/${projectId}/hooks/${hookId}`,
      { body }
    )
    return mapWebhook(raw)
  }

  async listMergeRequests (
    projectId: number | string,
    opts: { updatedAfter?: Date } = {}
  ): Promise<SyncMergeRequest[]> {
    const results: SyncMergeRequest[] = []
    let nextPage: string | null = '1'

    while (nextPage !== null && nextPage !== '') {
      const rawUrl = new URL(`${this.baseUrl}/api/v4/projects/${projectId}/merge_requests`)
      rawUrl.searchParams.set('per_page', '100')
      rawUrl.searchParams.set('confidential', 'false')
      rawUrl.searchParams.set('page', nextPage)
      if (opts.updatedAfter !== undefined) {
        rawUrl.searchParams.set('updated_after', opts.updatedAfter.toISOString())
      }

      const urlStr = rawUrl.toString()
      const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token }

      let pageItems: SyncMergeRequest[] = []
      let pageNext: string | null = null

      await withRateLimitRetry(async () => {
        const res = await fetch(urlStr, { headers })
        const rlHeaders: RateLimitHeaders = {
          'retry-after': res.headers.get('retry-after') ?? undefined,
          'ratelimit-remaining': res.headers.get('ratelimit-remaining') ?? undefined,
          'ratelimit-reset': res.headers.get('ratelimit-reset') ?? undefined
        }
        return {
          status: res.status,
          headers: rlHeaders,
          body: async () => {
            if (res.status >= 400) {
              const text = await res.text()
              throw new GitLabApiError(`GitLab API error ${res.status}: ${text}`, res.status, text)
            }
            const raw = await res.json() as RawMergeRequest[]
            pageItems = raw.map((m) => mapMergeRequest(m))
            const nextHeader = res.headers.get('x-next-page')
            pageNext = (nextHeader !== null && nextHeader !== '') ? nextHeader : null
          }
        }
      })

      results.push(...pageItems)
      nextPage = pageNext
    }

    return results
  }

  /**
   * P5-T-24: list MRs with Phase 3/4 fields (approvals, reviewers, approval
   * rules, diff stats) populated in one round-trip when GitLab supports
   * GraphQL. The REST fallback issues `listMergeRequests` + one composite
   * `getMergeRequest` per row (N+1 over the 3-5 call composite).
   *
   * Requires a project full path (string) for the GraphQL path; numeric ids
   * skip straight to the REST fallback because `project(fullPath:)` does not
   * accept numeric ids.
   */
  async listMergeRequestsWithApprovals (
    projectPath: number | string,
    opts: { updatedAfter?: Date } = {}
  ): Promise<SyncMergeRequest[]> {
    if (typeof projectPath === 'string') {
      try {
        const cap = await detectGraphQLCapability(this.baseUrl, this.token)
        if (cap.graphqlAvailable) {
          const vars: Record<string, unknown> = { projectFullPath: projectPath }
          if (opts.updatedAfter !== undefined) {
            vars.updatedAfter = opts.updatedAfter.toISOString()
          }
          const data = await new GitLabGraphQLClient({ baseUrl: this.baseUrl, token: this.token })
            .query<GraphQLMRListResponse>(GRAPHQL_MR_LIST_WITH_APPROVALS_QUERY, vars)
          const nodes = data.project?.mergeRequests?.nodes ?? []
          const out: SyncMergeRequest[] = []
          for (const node of nodes) {
            if (node.confidential) continue
            out.push(mapGraphQLMRListNode(node))
          }
          metrics.increment(METRIC_NAMES.MR_LIST_GRAPHQL_HIT)
          return out
        }
      } catch (err) {
        this.logger.info('mr.list.graphql.fallback', { projectPath, error: String(err) })
      }
    }
    metrics.increment(METRIC_NAMES.MR_LIST_REST_FALLBACK)
    const base = await this.listMergeRequests(projectPath, opts)
    const enriched: SyncMergeRequest[] = []
    for (const mr of base) {
      try {
        enriched.push(await this.getMergeRequest(projectPath, mr.iid))
      } catch (err) {
        if (err instanceof ConfidentialMergeRequestError) continue
        throw err
      }
    }
    return enriched
  }

  /**
   * Fetch a single MR with Phase 3 + Phase 4 composite enrichment.
   *
   * On CE this issues THREE HTTP requests:
   *   1. GET /merge_requests/:iid       — base MR (mandatory; populates `reviewers`)
   *   2. GET /merge_requests/:iid/approvals — populates approvedBy/approvalsRequired/approvalStatus
   *   3. GET /merge_requests/:iid/changes    — populates diffWebUrl/changedFiles
   *
   * On EE this issues UP TO FIVE HTTP requests (Phase 4 P4-T-03):
   *   4. GET /merge_requests/:iid/approval_rules — populates approvalRules
   *   5. GET /groups/:groupId/iterations/:iterationId — populates iteration
   *      (only when the MR's iteration_id is set on either `iteration` or
   *      `milestone.iteration_id`)
   *
   * Calls 2-5 run in parallel via Promise.allSettled. If any auxiliary call
   * rejects (5xx or network error), the corresponding fields are LEFT UNDEFINED
   * (NOT defaulted to []) and the `mr.composite.partial` metric is incremented.
   * The base MR fetch is mandatory — a non-2xx there throws normally.
   *
   * 404 inside getMRApprovals / getMRChanges / getMRApprovalRules is treated as
   * "endpoint missing on legacy CE projects": those helpers return safe defaults
   * (empty arrays, 0 required, derived diffWebUrl) with the metric incremented.
   *
   * AC-1: the raw `epic_iid` field on the MR payload is IGNORED — parentEpicIid
   * is exclusively written by EpicsSyncManager via child-issue propagation.
   *
   * Cost: 3 HTTP requests per call on CE; up to 5 on EE. `listMergeRequests`
   * does NOT fan out — it returns minimal MRs with composite fields left
   * undefined to avoid an N+1 explosion.
   */
  async getMergeRequest (projectId: number | string, mrIid: number): Promise<SyncMergeRequest> {
    // P5-T-22: prefer the single-roundtrip GraphQL composite when GitLab supports
    // it. The path requires a project full path (string projectId) because the
    // GraphQL `project(fullPath:)` field does not accept numeric ids. If only a
    // numeric id is known, fall through to the REST composite which handles
    // both shapes natively.
    if (typeof projectId === 'string') {
      try {
        const cap = await detectGraphQLCapability(this.baseUrl, this.token)
        if (cap.graphqlAvailable) {
          const data = await new GitLabGraphQLClient({ baseUrl: this.baseUrl, token: this.token })
            .query<GraphQLMRResponse>(GRAPHQL_MR_COMPOSITE_QUERY, { projectFullPath: projectId, mrIid: String(mrIid) })
          const mr = mapGraphQLMRResponse(data)
          mr.projectId = typeof mr.projectId === 'number' && mr.projectId > 0 ? mr.projectId : 0
          metrics.increment(METRIC_NAMES.MR_COMPOSITE_GRAPHQL_HIT)
          return mr
        }
      } catch (err) {
        if (err instanceof ConfidentialMergeRequestError) {
          throw err
        }
        this.logger.info('mr.composite.graphql.fallback', { projectId, mrIid, error: String(err) })
      }
      metrics.increment(METRIC_NAMES.MR_COMPOSITE_REST_FALLBACK)
    }
    return await this.getMergeRequestREST(projectId, mrIid)
  }

  private async getMergeRequestREST (projectId: number | string, mrIid: number): Promise<SyncMergeRequest> {
    const raw = await this.request<RawMergeRequest>('GET', `/api/v4/projects/${projectId}/merge_requests/${mrIid}`)
    if (raw.confidential) {
      throw new ConfidentialMergeRequestError(mrIid)
    }
    const mr = mapMergeRequest(raw, true)

    const isEE = this.ensureEE()
    // Derive iteration coordinates from the MR payload. Two GitLab variants:
    //   - top-level `iteration: { id, group_id }`
    //   - milestone-embedded `milestone.iteration_id` + `milestone.group_id`
    let iterationId: number | null = null
    let iterationGroupId: number | null = null
    if (raw.iteration != null && typeof raw.iteration.id === 'number') {
      iterationId = raw.iteration.id
      iterationGroupId = raw.iteration.group_id ?? null
    } else if (raw.milestone != null && typeof raw.milestone.iteration_id === 'number') {
      iterationId = raw.milestone.iteration_id
      iterationGroupId = raw.milestone.group_id ?? null
    }

    const tasks: Array<Promise<unknown>> = [
      this.getMRApprovals(projectId, mrIid),
      this.getMRChanges(projectId, mrIid, mr.webUrl)
    ]
    let approvalRulesIdx = -1
    let iterationIdx = -1
    if (isEE) {
      approvalRulesIdx = tasks.length
      tasks.push(this.getMRApprovalRules(projectId, mrIid))
      if (iterationId !== null && iterationGroupId !== null) {
        iterationIdx = tasks.length
        tasks.push(this.getIteration(iterationGroupId, iterationId))
      }
    }

    const settled = await Promise.allSettled(tasks)
    const approvalsResult = settled[0] as PromiseSettledResult<SyncMRApprovals>
    const changesResult = settled[1] as PromiseSettledResult<SyncMRChanges>

    if (approvalsResult.status === 'fulfilled') {
      mr.approvedBy = approvalsResult.value.approvedBy
      mr.approvalsRequired = approvalsResult.value.approvalsRequired
      mr.approvalStatus = deriveApprovalStatus(approvalsResult.value)
    } else {
      metrics.increment(METRIC_NAMES.MR_COMPOSITE_PARTIAL)
      this.logger.warn('mr.composite.partial', { projectId, mrIid, source: 'approvals', error: String(approvalsResult.reason) })
    }

    if (changesResult.status === 'fulfilled') {
      mr.diffWebUrl = changesResult.value.diffWebUrl
      mr.changedFiles = changesResult.value.changedFiles
    } else {
      metrics.increment(METRIC_NAMES.MR_COMPOSITE_PARTIAL)
      this.logger.warn('mr.composite.partial', { projectId, mrIid, source: 'changes', error: String(changesResult.reason) })
    }

    if (approvalRulesIdx !== -1) {
      const rulesResult = settled[approvalRulesIdx] as PromiseSettledResult<SyncMRApprovalRule[]>
      if (rulesResult.status === 'fulfilled') {
        mr.approvalRules = rulesResult.value
      } else {
        metrics.increment(METRIC_NAMES.MR_COMPOSITE_PARTIAL)
        this.logger.warn('mr.composite.partial', { projectId, mrIid, source: 'approval_rules', error: String(rulesResult.reason) })
      }
    }

    if (iterationIdx !== -1) {
      const iterResult = settled[iterationIdx] as PromiseSettledResult<SyncIteration | null>
      if (iterResult.status === 'fulfilled') {
        mr.iteration = iterResult.value
      } else {
        metrics.increment(METRIC_NAMES.MR_COMPOSITE_PARTIAL)
        this.logger.warn('mr.composite.partial', { projectId, mrIid, source: 'iteration', error: String(iterResult.reason) })
      }
    }

    return mr
  }

  /**
   * GET /api/v4/projects/:id/merge_requests/:mrIid/approvals.
   *
   * Q4 + C11: returns `{ approvedBy: [], approvalsRequired: 0 }` and increments
   * `mr.composite.partial` on 404 (legacy CE projects without approval rules).
   * 5xx still propagates as GitLabApiError.
   */
  async getMRApprovals (projectId: number | string, mrIid: number): Promise<SyncMRApprovals> {
    try {
      const raw = await this.request<RawApprovalResponse>(
        'GET',
        `/api/v4/projects/${projectId}/merge_requests/${mrIid}/approvals`
      )
      return mapApproval(raw)
    } catch (err) {
      if (err instanceof NotFoundError) {
        metrics.increment(METRIC_NAMES.MR_COMPOSITE_PARTIAL)
        this.logger.info('mr.composite.partial', { projectId, mrIid, source: 'approvals', reason: '404' })
        return { approvedBy: [], approvalsRequired: 0 }
      }
      throw err
    }
  }

  /**
   * GET /api/v4/projects/:id/merge_requests/:mrIid/changes.
   *
   * Q4: on 404 returns `{ changedFiles: [], diffWebUrl: '${webUrl}/diffs' }`
   * (using `fallbackWebUrl` when provided, else empty base) and increments
   * `mr.composite.partial`. 5xx propagates.
   */
  async getMRChanges (
    projectId: number | string,
    mrIid: number,
    fallbackWebUrl: string = ''
  ): Promise<SyncMRChanges> {
    try {
      const raw = await this.request<RawChangesResponse>(
        'GET',
        `/api/v4/projects/${projectId}/merge_requests/${mrIid}/changes`
      )
      return mapChanges(raw, fallbackWebUrl)
    } catch (err) {
      if (err instanceof NotFoundError) {
        metrics.increment(METRIC_NAMES.MR_COMPOSITE_PARTIAL)
        this.logger.info('mr.composite.partial', { projectId, mrIid, source: 'changes', reason: '404' })
        return { changedFiles: [], diffWebUrl: `${fallbackWebUrl}/diffs` }
      }
      throw err
    }
  }

  /**
   * List MR review threads (discussions).
   *
   * Paginated via the X-Next-Page header (same shape as listMergeRequests).
   * Maps position_type 'text', 'image', and 'file' to their respective
   * SyncReviewPosition variants. Unknown position types are dropped and emit a
   * `discussion.position.unsupported` warn log per dropped row.
   *
   * Resolvable general-MR review threads (no position) are included.
   */
  async listDiscussions (
    projectId: number | string,
    mrIid: number,
    opts: { updatedAfter?: Date } = {}
  ): Promise<SyncReviewThread[]> {
    const projectIdNum = typeof projectId === 'number' ? projectId : parseInt(projectId, 10)
    const results: SyncReviewThread[] = []
    let nextPage: string | null = '1'

    while (nextPage !== null && nextPage !== '') {
      const rawUrl = new URL(`${this.baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/discussions`)
      rawUrl.searchParams.set('per_page', '100')
      rawUrl.searchParams.set('page', nextPage)
      if (opts.updatedAfter !== undefined) {
        rawUrl.searchParams.set('updated_after', opts.updatedAfter.toISOString())
      }

      const urlStr = rawUrl.toString()
      const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token }

      let pageItems: SyncReviewThread[] = []
      let pageNext: string | null = null

      await withRateLimitRetry(async () => {
        const res = await fetch(urlStr, { headers })
        const rlHeaders: RateLimitHeaders = {
          'retry-after': res.headers.get('retry-after') ?? undefined,
          'ratelimit-remaining': res.headers.get('ratelimit-remaining') ?? undefined,
          'ratelimit-reset': res.headers.get('ratelimit-reset') ?? undefined
        }
        return {
          status: res.status,
          headers: rlHeaders,
          body: async () => {
            if (res.status >= 400) {
              const text = await res.text()
              throw new GitLabApiError(`GitLab API error ${res.status}: ${text}`, res.status, text)
            }
            const raw = await res.json() as RawDiscussion[]
            const mapped: SyncReviewThread[] = []
            for (const d of raw) {
              const t = mapDiscussion(d, projectIdNum, mrIid)
              if (t === null) {
                this.logger.warn('discussion.position.unsupported', { projectId, mrIid, discussionId: d.id })
                metrics.increment(METRIC_NAMES.DISCUSSION_POSITION_UNSUPPORTED)
                continue
              }
              mapped.push(t)
            }
            pageItems = mapped
            const nextHeader = res.headers.get('x-next-page')
            pageNext = (nextHeader !== null && nextHeader !== '') ? nextHeader : null
          }
        }
      })

      results.push(...pageItems)
      nextPage = pageNext
    }

    return results
  }

  /**
   * POST a new discussion to an MR.
   *
   * Phase 3 callers do not yet POST line-anchored discussions from Huly;
   * the method lands and is exercised by tests. Body shape is `{ body: string }`
   * (NOT a bare string), mirroring `createMRNote`.
   */
  async createDiscussion (
    projectId: number | string,
    mrIid: number,
    body: { body: string, position?: SyncReviewPosition },
    actorToken?: string
  ): Promise<SyncReviewThread> {
    const projectIdNum = typeof projectId === 'number' ? projectId : parseInt(projectId, 10)
    const raw = await this.request<RawDiscussion>(
      'POST',
      `/api/v4/projects/${projectId}/merge_requests/${mrIid}/discussions`,
      { body },
      actorToken
    )
    const mapped = mapDiscussion(raw, projectIdNum, mrIid)
    if (mapped === null) {
      throw new GitLabApiError('createDiscussion returned a discussion with unsupported position', 0)
    }
    return mapped
  }

  /**
   * Resolve or unresolve a discussion.
   * PUT /api/v4/projects/:id/merge_requests/:mrIid/discussions/:discId?resolved=<bool>
   */
  async resolveDiscussion (
    projectId: number | string,
    mrIid: number,
    discussionId: string,
    resolved: boolean,
    actorToken?: string
  ): Promise<void> {
    await this.request<RawDiscussion>(
      'PUT',
      `/api/v4/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`,
      { query: { resolved } },
      actorToken
    )
  }

  /**
   * POST /api/v4/projects/:id/merge_requests/:mrIid/approve.
   *
   * Q2 attribution (C6): when `actorToken` is provided, the request uses that
   * token in the PRIVATE-TOKEN header (per-user OAuth attribution). When omitted,
   * the binding's service-account token is used and a warn log is emitted.
   *
   * Throws ApprovalActionError on any non-2xx response.
   */
  async approveMR (
    projectId: number | string,
    mrIid: number,
    actorToken?: string
  ): Promise<void> {
    // B8 / Security M1: validate the actor token BEFORE the wrapping try/catch
    // so a bad header value surfaces as GitLabApiError (no fetch attempted),
    // not as ApprovalActionError. Identical guard lives in `request()`.
    validateActorTokenHeader(actorToken)
    if (actorToken === undefined) {
      this.logger.warn('approval.action.fallback.service_account', { projectId, mrIid, kind: 'approve' })
    }
    try {
      await this.request<unknown>(
        'POST',
        `/api/v4/projects/${projectId}/merge_requests/${mrIid}/approve`,
        {},
        actorToken
      )
      this.invalidateApprovalRulesCache(projectId, mrIid)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ApprovalActionError('approve', String(projectId), mrIid, message)
    }
  }

  /**
   * POST /api/v4/projects/:id/merge_requests/:mrIid/unapprove. Same attribution
   * and error-wrapping contract as approveMR.
   */
  async unapproveMR (
    projectId: number | string,
    mrIid: number,
    actorToken?: string
  ): Promise<void> {
    validateActorTokenHeader(actorToken)
    if (actorToken === undefined) {
      this.logger.warn('approval.action.fallback.service_account', { projectId, mrIid, kind: 'unapprove' })
    }
    try {
      await this.request<unknown>(
        'POST',
        `/api/v4/projects/${projectId}/merge_requests/${mrIid}/unapprove`,
        {},
        actorToken
      )
      this.invalidateApprovalRulesCache(projectId, mrIid)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ApprovalActionError('unapprove', String(projectId), mrIid, message)
    }
  }

  async createMergeRequest (projectId: number | string, body: {
    title: string
    description?: string
    source_branch: string
    target_branch: string
    labels?: string
    milestone_id?: number
    assignee_ids?: number[]
    reviewer_ids?: number[]
    draft?: boolean
    remove_source_branch?: boolean
  }): Promise<SyncMergeRequest> {
    const raw = await this.request<RawMergeRequest>('POST', `/api/v4/projects/${projectId}/merge_requests`, { body })
    return mapMergeRequest(raw)
  }

  async updateMergeRequest (projectId: number | string, mrIid: number, body: {
    title?: string
    description?: string
    state_event?: 'close' | 'reopen'
    labels?: string
    milestone_id?: number
    assignee_ids?: number[]
    target_branch?: string
    remove_source_branch?: boolean
    draft?: boolean
  }): Promise<SyncMergeRequest> {
    const raw = await this.request<RawMergeRequest>('PUT', `/api/v4/projects/${projectId}/merge_requests/${mrIid}`, { body })
    return mapMergeRequest(raw)
  }

  async listMRNotes (
    projectId: number | string,
    mrIid: number,
    opts: { updatedAfter?: Date } = {}
  ): Promise<SyncNote[]> {
    const results: SyncNote[] = []
    let nextPage: string | null = '1'

    while (nextPage !== null && nextPage !== '') {
      const rawUrl = new URL(`${this.baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`)
      rawUrl.searchParams.set('per_page', '100')
      rawUrl.searchParams.set('page', nextPage)
      if (opts.updatedAfter !== undefined) {
        rawUrl.searchParams.set('updated_after', opts.updatedAfter.toISOString())
      }

      const urlStr = rawUrl.toString()
      const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token }

      let pageItems: SyncNote[] = []
      let pageNext: string | null = null

      await withRateLimitRetry(async () => {
        const res = await fetch(urlStr, { headers })
        const rlHeaders: RateLimitHeaders = {
          'retry-after': res.headers.get('retry-after') ?? undefined,
          'ratelimit-remaining': res.headers.get('ratelimit-remaining') ?? undefined,
          'ratelimit-reset': res.headers.get('ratelimit-reset') ?? undefined
        }
        return {
          status: res.status,
          headers: rlHeaders,
          body: async () => {
            if (res.status >= 400) {
              const text = await res.text()
              throw new GitLabApiError(`GitLab API error ${res.status}: ${text}`, res.status, text)
            }
            const raw = await res.json() as RawNote[]
            pageItems = raw.map((n) => ({ ...mapNote(n), noteableType: 'MergeRequest' as const }))
            const nextHeader = res.headers.get('x-next-page')
            pageNext = (nextHeader !== null && nextHeader !== '') ? nextHeader : null
          }
        }
      })

      results.push(...pageItems)
      nextPage = pageNext
    }

    return results
  }

  async createMRNote (
    projectId: number | string,
    mrIid: number,
    body: { body: string }
  ): Promise<SyncNote> {
    const raw = await this.request<RawNote>(
      'POST',
      `/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`,
      { body }
    )
    return { ...mapNote(raw), noteableType: 'MergeRequest' }
  }

  async updateMRNote (
    projectId: number | string,
    mrIid: number,
    noteId: number,
    body: { body: string }
  ): Promise<SyncNote> {
    const raw = await this.request<RawNote>(
      'PUT',
      `/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`,
      { body }
    )
    return { ...mapNote(raw), noteableType: 'MergeRequest' }
  }

  async deleteMRNote (
    projectId: number | string,
    mrIid: number,
    noteId: number
  ): Promise<void> {
    await this.request<undefined>(
      'DELETE',
      `/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`
    )
  }

  async getPipeline (projectId: number | string, pipelineId: number): Promise<SyncPipeline> {
    const raw = await this.request<RawPipeline>('GET', `/api/v4/projects/${projectId}/pipelines/${pipelineId}`)
    return mapPipeline(raw)
  }

  async getVersion (): Promise<{ version: string, revision: string }> {
    return await this.request<{ version: string, revision: string }>('GET', '/api/v4/version')
  }

  /**
   * EE-only: list approval rules for an MR.
   *
   * GET /api/v4/projects/:id/merge_requests/:mrIid/approval_rules
   *
   * - CE (capabilities.edition !== 'ee'): returns `[]` silently; no HTTP call.
   * - EE 404: returns `[]` + increments `mr.composite.partial` (legacy CE-style
   *   404 on EE instance, treated as "no rules configured").
   * - EE 5xx: propagates as GitLabApiError (caller handles via Promise.allSettled
   *   in composite path).
   *
   * P4-R3 mitigation: results are cached in a bounded in-memory LRU with a 10s
   * TTL keyed on `(projectId, mrIid)`. The cache is invalidated on any
   * approveMR/unapproveMR call so subsequent reads see fresh approver state.
   */
  async getMRApprovalRules (projectId: number | string, mrIid: number): Promise<SyncMRApprovalRule[]> {
    if (!this.ensureEE()) {
      return []
    }
    const cacheKey = this.approvalRulesCacheKey(projectId, mrIid)
    const cached = this.approvalRulesCacheGet(cacheKey)
    if (cached !== null) {
      return cached
    }
    try {
      const raw = await this.request<RawApprovalRule[]>(
        'GET',
        `/api/v4/projects/${projectId}/merge_requests/${mrIid}/approval_rules`
      )
      const rules = raw.map(mapApprovalRule)
      this.approvalRulesCacheSet(cacheKey, rules)
      return rules
    } catch (err) {
      if (err instanceof NotFoundError) {
        metrics.increment(METRIC_NAMES.MR_COMPOSITE_PARTIAL)
        this.logger.info('mr.composite.partial', { projectId, mrIid, source: 'approval_rules', reason: '404' })
        // Negative cache the empty result so repeated 404s do not refire the request.
        this.approvalRulesCacheSet(cacheKey, [])
        return []
      }
      throw err
    }
  }

  /**
   * EE-only: list iterations for a (top-level) group.
   *
   * GET /api/v4/groups/:groupId/iterations
   * Paginated via X-Next-Page. CE returns `[]` silently.
   */
  async listIterations (
    groupId: number | string,
    opts: { updatedAfter?: Date } = {}
  ): Promise<SyncIteration[]> {
    if (!this.ensureEE()) {
      return []
    }
    const results: SyncIteration[] = []
    let nextPage: string | null = '1'

    while (nextPage !== null && nextPage !== '') {
      const rawUrl = new URL(`${this.baseUrl}/api/v4/groups/${groupId}/iterations`)
      rawUrl.searchParams.set('per_page', '100')
      rawUrl.searchParams.set('page', nextPage)
      if (opts.updatedAfter !== undefined) {
        rawUrl.searchParams.set('updated_after', opts.updatedAfter.toISOString())
      }

      const urlStr = rawUrl.toString()
      const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token }

      let pageItems: SyncIteration[] = []
      let pageNext: string | null = null

      await withRateLimitRetry(async () => {
        const res = await fetch(urlStr, { headers })
        const rlHeaders: RateLimitHeaders = {
          'retry-after': res.headers.get('retry-after') ?? undefined,
          'ratelimit-remaining': res.headers.get('ratelimit-remaining') ?? undefined,
          'ratelimit-reset': res.headers.get('ratelimit-reset') ?? undefined
        }
        return {
          status: res.status,
          headers: rlHeaders,
          body: async () => {
            if (res.status >= 400) {
              const text = await res.text()
              throw new GitLabApiError(`GitLab API error ${res.status}: ${text}`, res.status, text)
            }
            const raw = await res.json() as RawIteration[]
            pageItems = raw.map(mapIteration)
            const nextHeader = res.headers.get('x-next-page')
            pageNext = (nextHeader !== null && nextHeader !== '') ? nextHeader : null
          }
        }
      })

      results.push(...pageItems)
      nextPage = pageNext
    }

    return results
  }

  /**
   * EE-only: fetch a single iteration. CE returns null; 404 returns null.
   */
  async getIteration (groupId: number | string, iterationId: number | string): Promise<SyncIteration | null> {
    if (!this.ensureEE()) {
      return null
    }
    try {
      const raw = await this.request<RawIteration>(
        'GET',
        `/api/v4/groups/${groupId}/iterations/${iterationId}`
      )
      return mapIteration(raw)
    } catch (err) {
      if (err instanceof NotFoundError) {
        return null
      }
      throw err
    }
  }

  /**
   * EE-only: list epics for a (top-level) group.
   *
   * GET /api/v4/groups/:groupId/epics
   * Paginated via X-Next-Page. CE returns `[]` silently.
   *
   * `childIssueIids` is NOT populated here — callers (EpicsSyncManager) compose
   * it via `listEpicIssues` per epic.
   */
  async listEpics (
    groupId: number | string,
    opts: { updatedAfter?: Date } = {}
  ): Promise<SyncEpic[]> {
    if (!this.ensureEE()) {
      return []
    }
    const results: SyncEpic[] = []
    let nextPage: string | null = '1'

    while (nextPage !== null && nextPage !== '') {
      const rawUrl = new URL(`${this.baseUrl}/api/v4/groups/${groupId}/epics`)
      rawUrl.searchParams.set('per_page', '100')
      rawUrl.searchParams.set('page', nextPage)
      if (opts.updatedAfter !== undefined) {
        rawUrl.searchParams.set('updated_after', opts.updatedAfter.toISOString())
      }

      const urlStr = rawUrl.toString()
      const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token }

      let pageItems: SyncEpic[] = []
      let pageNext: string | null = null

      await withRateLimitRetry(async () => {
        const res = await fetch(urlStr, { headers })
        const rlHeaders: RateLimitHeaders = {
          'retry-after': res.headers.get('retry-after') ?? undefined,
          'ratelimit-remaining': res.headers.get('ratelimit-remaining') ?? undefined,
          'ratelimit-reset': res.headers.get('ratelimit-reset') ?? undefined
        }
        return {
          status: res.status,
          headers: rlHeaders,
          body: async () => {
            if (res.status >= 400) {
              const text = await res.text()
              throw new GitLabApiError(`GitLab API error ${res.status}: ${text}`, res.status, text)
            }
            const raw = await res.json() as RawEpic[]
            pageItems = raw.map((e) => mapEpic(e))
            const nextHeader = res.headers.get('x-next-page')
            pageNext = (nextHeader !== null && nextHeader !== '') ? nextHeader : null
          }
        }
      })

      results.push(...pageItems)
      nextPage = pageNext
    }

    return results
  }

  /**
   * P5-T-23: list a group's epics with `childIssueIids` populated in a single
   * round-trip when GitLab supports GraphQL. The REST fallback issues
   * `listEpics` + one `listEpicIssues` call per epic (N+1).
   *
   * The GraphQL path requires the group's full path (string). Numeric ids
   * short-circuit to the REST fallback because `group(fullPath:)` does not
   * accept numeric ids. CE returns `[]` silently (same shape as `listEpics`).
   */
  async listEpicsWithChildren (
    groupPath: number | string,
    opts: { updatedAfter?: Date } = {}
  ): Promise<SyncEpic[]> {
    if (!this.ensureEE()) {
      return []
    }
    if (typeof groupPath === 'string') {
      try {
        const cap = await detectGraphQLCapability(this.baseUrl, this.token)
        if (cap.graphqlAvailable) {
          const vars: Record<string, unknown> = { groupFullPath: groupPath }
          if (opts.updatedAfter !== undefined) {
            vars.updatedAfter = opts.updatedAfter.toISOString()
          }
          const data = await new GitLabGraphQLClient({ baseUrl: this.baseUrl, token: this.token })
            .query<GraphQLEpicsResponse>(GRAPHQL_EPICS_WITH_CHILDREN_QUERY, vars)
          const nodes = data.group?.epics?.nodes ?? []
          const out: SyncEpic[] = []
          for (const node of nodes) {
            if (node.confidential === true) continue
            out.push(mapGraphQLEpicNode(node))
          }
          metrics.increment(METRIC_NAMES.EPICS_LIST_GRAPHQL_HIT)
          return out
        }
      } catch (err) {
        this.logger.info('epics.list.graphql.fallback', { groupPath, error: String(err) })
      }
    }
    metrics.increment(METRIC_NAMES.EPICS_LIST_REST_FALLBACK)
    const base = await this.listEpics(groupPath, opts)
    const enriched: SyncEpic[] = []
    for (const epic of base) {
      const children = await this.listEpicIssues(groupPath, epic.iid)
      enriched.push({ ...epic, childIssueIids: children.iids })
    }
    return enriched
  }

  /**
   * EE-only: fetch a single epic by iid within a (top-level) group.
   *
   * Throws ConfidentialEpicError when the epic has confidential:true.
   */
  async getEpic (groupId: number | string, epicIid: number): Promise<SyncEpic> {
    if (!this.ensureEE()) {
      // EE-only method invoked on CE — caller misuse; return a placeholder via
      // throw so the contract stays explicit. The composite/backfill paths must
      // capability-gate before calling.
      throw new GitLabApiError('getEpic invoked on a non-EE instance', 0)
    }
    const raw = await this.request<RawEpic>(
      'GET',
      `/api/v4/groups/${groupId}/epics/${epicIid}`
    )
    if (raw.confidential === true) {
      const groupIdNum = typeof groupId === 'number' ? groupId : parseInt(String(groupId), 10)
      throw new ConfidentialEpicError(epicIid, groupIdNum)
    }
    return mapEpic(raw)
  }

  /**
   * EE-only: list child issues of an epic.
   *
   * GET /api/v4/groups/:groupId/epics/:epicIid/issues
   * Returns child issue iids + their project ids so EpicsSyncManager can
   * filter cross-project issues (Phase 4 per-binding scope limitation).
   */
  async listEpicIssues (
    groupId: number | string,
    epicIid: number
  ): Promise<{ iids: number[], projectIds: number[] }> {
    if (!this.ensureEE()) {
      return { iids: [], projectIds: [] }
    }
    const iids: number[] = []
    const projectIds: number[] = []
    let nextPage: string | null = '1'

    while (nextPage !== null && nextPage !== '') {
      const rawUrl = new URL(`${this.baseUrl}/api/v4/groups/${groupId}/epics/${epicIid}/issues`)
      rawUrl.searchParams.set('per_page', '100')
      rawUrl.searchParams.set('page', nextPage)

      const urlStr = rawUrl.toString()
      const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token }

      let pageNext: string | null = null

      await withRateLimitRetry(async () => {
        const res = await fetch(urlStr, { headers })
        const rlHeaders: RateLimitHeaders = {
          'retry-after': res.headers.get('retry-after') ?? undefined,
          'ratelimit-remaining': res.headers.get('ratelimit-remaining') ?? undefined,
          'ratelimit-reset': res.headers.get('ratelimit-reset') ?? undefined
        }
        return {
          status: res.status,
          headers: rlHeaders,
          body: async () => {
            if (res.status >= 400) {
              const text = await res.text()
              throw new GitLabApiError(`GitLab API error ${res.status}: ${text}`, res.status, text)
            }
            const raw = await res.json() as RawEpicIssue[]
            for (const row of raw) {
              iids.push(row.iid)
              projectIds.push(row.project_id)
            }
            const nextHeader = res.headers.get('x-next-page')
            pageNext = (nextHeader !== null && nextHeader !== '') ? nextHeader : null
          }
        }
      })

      nextPage = pageNext
    }

    return { iids, projectIds }
  }

  /**
   * Bug-1 fix: epics live at the TOP-LEVEL group, not the immediate sub-group.
   * Walk the project's namespace chain upward via parent_id to find the root
   * group id. Cached per project for 1 hour.
   *
   * Throws GitLabApiError when the project's namespace is a user namespace
   * (epics require a group namespace).
   */
  async resolveTopLevelGroupForProject (projectId: number | string): Promise<number> {
    const numericId = typeof projectId === 'number' ? projectId : parseInt(String(projectId), 10)
    const cached = this.topLevelGroupCache.get(numericId)
    if (cached !== undefined && this.now() < cached.expiresAt) {
      return cached.groupId
    }

    const project = await this.request<RawProjectWithNamespace>('GET', `/api/v4/projects/${projectId}`)
    if (project.namespace === undefined) {
      throw new GitLabApiError(`project ${projectId} has no namespace`, 0)
    }
    if (project.namespace.kind === 'user') {
      throw new GitLabApiError(`project ${projectId} is in a user namespace; epics require a group`, 0)
    }

    let currentGroupId = project.namespace.id
    // Walk upward via parent_id; bound the loop to defend against cycles.
    for (let depth = 0; depth < 32; depth++) {
      const group = await this.request<RawGroup>('GET', `/api/v4/groups/${currentGroupId}`)
      if (group.parent_id === null || group.parent_id === undefined) {
        this.topLevelGroupCache.set(numericId, {
          groupId: currentGroupId,
          expiresAt: this.now() + TOP_LEVEL_GROUP_CACHE_TTL_MS
        })
        return currentGroupId
      }
      currentGroupId = group.parent_id
    }
    throw new GitLabApiError(`namespace walk exceeded depth for project ${projectId}`, 0)
  }
}

/**
 * B8 / Security M1 — guard PRIVATE-TOKEN header value before use.
 * Rejects undefined-vs-string mismatch, empty, oversize (>4096), or
 * values that contain CR/LF/NUL (header-injection).
 */
function validateActorTokenHeader (tokenOverride: string | undefined): void {
  if (tokenOverride === undefined) return
  if (typeof tokenOverride !== 'string' || tokenOverride.length === 0 ||
      tokenOverride.length > 4096 || /[\r\n\0]/.test(tokenOverride)) {
    throw new GitLabApiError('invalid actor token', 0)
  }
}
