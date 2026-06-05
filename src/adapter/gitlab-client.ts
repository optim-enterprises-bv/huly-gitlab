import { GraphQLClient } from 'graphql-request'
import type { Logger } from '../logging'
import { AuthError, ConfidentialIssueError, ConfidentialMergeRequestError, GitLabApiError, NotFoundError } from './errors'
import { withRateLimitRetry, type RateLimitHeaders } from './rate-limit'
import { validateGitLabBaseUrl } from '../util/url-validation'
import type {
  Capabilities,
  MergeStatus,
  SyncIssue,
  SyncLabel,
  SyncMergeRequest,
  SyncMilestone,
  SyncNote,
  SyncPipeline,
  SyncPipelineStatus,
  SyncProject,
  SyncUser,
  SyncWebhook
} from './types'

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
  milestone?: { iid: number, title: string } | null
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

function mapMergeRequest (raw: RawMergeRequest): SyncMergeRequest {
  return {
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
    reviewers: (raw.reviewers ?? []).map(mapUser),
    author: mapUser(raw.author),
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
    webUrl: raw.web_url,
    confidential: raw.confidential
  }
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

export class GitLabClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly logger: Logger
  private _capabilities: Capabilities | null = null

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

  get capabilities (): Capabilities | null {
    return this._capabilities
  }

  set capabilities (caps: Capabilities) {
    this._capabilities = caps
  }

  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    if (opts.query !== undefined) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) {
          url.searchParams.set(k, String(v))
        }
      }
    }

    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.token,
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
            pageItems = raw.map(mapMergeRequest)
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

  async getMergeRequest (projectId: number | string, mrIid: number): Promise<SyncMergeRequest> {
    const raw = await this.request<RawMergeRequest>('GET', `/api/v4/projects/${projectId}/merge_requests/${mrIid}`)
    if (raw.confidential) {
      throw new ConfidentialMergeRequestError(mrIid)
    }
    return mapMergeRequest(raw)
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
}
