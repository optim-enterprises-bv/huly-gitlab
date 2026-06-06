/**
 * E2E harness — boots the full huly-gitlab dev compose stack and exposes
 * helpers to seed GitLab, seed Huly, and bind projects through the pod.
 *
 * All side-effecting primitives (`exec`, `fetch`, `readFile`, `sleep`) are
 * dependency-injected so the harness is unit-testable without docker or the
 * network. The default factory `defaultHarness()` wires real implementations.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const execAsync = promisify(exec)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string
  stderr: string
}

export type ExecFn = (cmd: string) => Promise<ExecResult>
export type FetchFn = typeof fetch
export type ReadFileFn = (path: string) => Promise<string>
export type SleepFn = (ms: number) => Promise<void>

export interface HarnessDeps {
  exec: ExecFn
  fetch: FetchFn
  readFile: ReadFileFn
  sleep: SleepFn
  composeFile: string
  gitlabBaseUrl: string
  hulyAccountUrl: string
  podBaseUrl: string
  serverSecret: string
}

export interface StackContext {
  gitlabRootToken: string
  gitlabProjectId: number
  gitlabProjectPath: string
  hulyWorkspaceUuid: string
  hulyProjectRef: string
  bindingId: string
  webhookSecret?: string
}

export interface MRStackContext extends StackContext {
  mrIid: number
  sourceBranch: string
  targetBranch: string
}

export interface SeedMRResult {
  mrIid: number
  sourceBranch: string
  targetBranch: string
}

export interface SeedMRArgs {
  sourceBranch?: string
  targetBranch?: string
  title?: string
  description?: string
  draft?: boolean
}

export interface BootOptions {
  gitlabTimeoutMs?: number
  hulyTimeoutMs?: number
  podTimeoutMs?: number
  pollIntervalMs?: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function defaultHarness (): HarnessDeps {
  return {
    exec: async (cmd) => await execAsync(cmd, { maxBuffer: 32 * 1024 * 1024 }),
    fetch: globalThis.fetch.bind(globalThis),
    readFile: async (path) => await readFile(path, 'utf8'),
    sleep: async (ms) => await new Promise((r) => setTimeout(r, ms)),
    composeFile: resolve(__dirname, '../../docker/docker-compose.dev.yml'),
    gitlabBaseUrl: process.env.E2E_GITLAB_URL ?? 'http://localhost:8929',
    hulyAccountUrl: process.env.E2E_HULY_ACCOUNT_URL ?? 'http://localhost:8087/_accounts',
    podBaseUrl: process.env.E2E_POD_URL ?? 'http://localhost:3600',
    serverSecret: process.env.SECRET ?? 'change-me-shared-secret'
  }
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

interface PollOptions {
  url: string
  timeoutMs: number
  intervalMs: number
  label: string
  expectStatus?: number
}

export async function pollHttp (deps: Pick<HarnessDeps, 'fetch' | 'sleep'>, opts: PollOptions): Promise<void> {
  const expectStatus = opts.expectStatus ?? 200
  const deadline = Date.now() + opts.timeoutMs
  let lastError: string = 'never attempted'
  while (Date.now() < deadline) {
    try {
      const res = await deps.fetch(opts.url)
      if (res.status === expectStatus) {
        return
      }
      lastError = `status=${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await deps.sleep(opts.intervalMs)
  }
  throw new Error(`pollHttp(${opts.label}): timed out after ${opts.timeoutMs}ms (last=${lastError})`)
}

// ---------------------------------------------------------------------------
// Boot / shutdown
// ---------------------------------------------------------------------------

export async function bootStack (deps: HarnessDeps, opts: BootOptions = {}): Promise<void> {
  const gitlabTimeout = opts.gitlabTimeoutMs ?? 600000
  const hulyTimeout = opts.hulyTimeoutMs ?? 300000
  const podTimeout = opts.podTimeoutMs ?? 60000
  const intervalMs = opts.pollIntervalMs ?? 5000

  await deps.exec(`docker compose -f ${deps.composeFile} up -d`)

  await pollHttp(deps, {
    url: `${deps.gitlabBaseUrl}/api/v4/version`,
    timeoutMs: gitlabTimeout,
    intervalMs,
    label: 'gitlab'
  })

  await pollHttp(deps, {
    url: `${deps.hulyAccountUrl}/api/v1/accounts`,
    timeoutMs: hulyTimeout,
    intervalMs,
    label: 'huly-account'
  })

  await pollHttp(deps, {
    url: `${deps.podBaseUrl}/health`,
    timeoutMs: podTimeout,
    intervalMs: 1000,
    label: 'pod-gitlab'
  })
}

export async function shutdownStack (deps: HarnessDeps): Promise<void> {
  await deps.exec(`docker compose -f ${deps.composeFile} down`)
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface GitLabSeed {
  rootToken: string
  projectId: number
  projectPath: string
}

/** Parse the initial root password file content into a token string. */
export function parseInitialRootPassword (content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('Password:')) {
      return trimmed.slice('Password:'.length).trim()
    }
  }
  throw new Error('parseInitialRootPassword: no "Password:" line found')
}

export async function readGitLabInitialPassword (deps: Pick<HarnessDeps, 'exec'>): Promise<string> {
  const { stdout } = await deps.exec('docker compose exec -T gitlab cat /etc/gitlab/initial_root_password')
  return parseInitialRootPassword(stdout)
}

/**
 * Create a personal access token via the GitLab Rails runner. Requires the
 * `gitlab` service to be reachable via `docker compose exec`.
 */
export async function createRootToken (deps: Pick<HarnessDeps, 'exec'>): Promise<string> {
  const rubyScript = "u = User.find_by_username('root'); t = u.personal_access_tokens.create(scopes: ['api'], name: 'e2e-harness'); t.set_token('e2e-root-token-' + SecureRandom.hex(16)); t.save!; puts t.token"
  const { stdout } = await deps.exec(`docker compose exec -T gitlab gitlab-rails runner "${rubyScript}"`)
  const token = stdout.trim().split('\n').pop()
  if (token === undefined || token === '') {
    throw new Error('createRootToken: empty output from gitlab-rails')
  }
  return token
}

export async function createGitLabProject (
  deps: Pick<HarnessDeps, 'fetch'>,
  gitlabBaseUrl: string,
  token: string,
  name: string
): Promise<{ projectId: number, projectPath: string }> {
  const res = await deps.fetch(`${gitlabBaseUrl}/api/v4/projects`, {
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name, visibility: 'private', initialize_with_readme: true })
  })
  if (res.status !== 201) {
    throw new Error(`createGitLabProject: unexpected status ${res.status}`)
  }
  const body = await res.json() as { id: number, path_with_namespace: string }
  return { projectId: body.id, projectPath: body.path_with_namespace }
}

export async function seedGitLab (deps: HarnessDeps): Promise<GitLabSeed> {
  const rootToken = await createRootToken(deps)
  const projectName = `e2e-${Date.now()}`
  const { projectId, projectPath } = await createGitLabProject(deps, deps.gitlabBaseUrl, rootToken, projectName)
  return { rootToken, projectId, projectPath }
}

export interface HulySeed {
  workspaceUuid: string
  projectRef: string
}

/**
 * Minimal Huly seeding: create a workspace via the account REST API and
 * synthesize a tracker project ref. The transactor-side project document is
 * created on first sync (the engine's `ensureProject` path).
 */
export async function seedHuly (deps: HarnessDeps): Promise<HulySeed> {
  const workspaceName = `e2e-${Date.now()}`
  const res = await deps.fetch(`${deps.hulyAccountUrl}/api/v1/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: workspaceName })
  })
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`seedHuly: workspace create returned ${res.status}`)
  }
  const body = await res.json() as { uuid?: string, workspaceUuid?: string }
  const workspaceUuid = body.workspaceUuid ?? body.uuid
  if (workspaceUuid === undefined) {
    throw new Error('seedHuly: response missing workspace uuid')
  }
  return { workspaceUuid, projectRef: `tracker:project:${workspaceName}` }
}

// ---------------------------------------------------------------------------
// Bind through the pod admin API
// ---------------------------------------------------------------------------

export interface BindArgs {
  podBaseUrl: string
  serverSecret: string
  workspaceUuid: string
  hulyProjectRef: string
  gitlabProjectId: number
  gitlabProjectPath: string
  credentialRef: string
}

export async function bindProjects (
  deps: Pick<HarnessDeps, 'fetch'>,
  args: BindArgs
): Promise<{ bindingId: string }> {
  const res = await deps.fetch(`${args.podBaseUrl}/api/v1/bindings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.serverSecret}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      workspaceUuid: args.workspaceUuid,
      hulyProjectRef: args.hulyProjectRef,
      gitlabProjectId: args.gitlabProjectId,
      gitlabProjectPath: args.gitlabProjectPath,
      credentialRef: args.credentialRef
    })
  })
  if (res.status !== 201) {
    throw new Error(`bindProjects: unexpected status ${res.status}`)
  }
  const body = await res.json() as { bindingId: string }
  return { bindingId: body.bindingId }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * One-shot helper that boots the stack, seeds GitLab + Huly, registers a
 * placeholder credential, and binds the two projects. Returns the full
 * `StackContext` consumed by test cases.
 *
 * NOTE: the credential ref returned here is a placeholder; real OAuth /
 * access-token flow is exercised separately in `tests/auth/`.
 */
export async function setupFullStack (deps: HarnessDeps): Promise<StackContext> {
  await bootStack(deps)
  const gitlab = await seedGitLab(deps)
  const huly = await seedHuly(deps)
  const binding = await bindProjects(deps, {
    podBaseUrl: deps.podBaseUrl,
    serverSecret: deps.serverSecret,
    workspaceUuid: huly.workspaceUuid,
    hulyProjectRef: huly.projectRef,
    gitlabProjectId: gitlab.projectId,
    gitlabProjectPath: gitlab.projectPath,
    credentialRef: `e2e-cred-${gitlab.projectId}`
  })
  return {
    gitlabRootToken: gitlab.rootToken,
    gitlabProjectId: gitlab.projectId,
    gitlabProjectPath: gitlab.projectPath,
    hulyWorkspaceUuid: huly.workspaceUuid,
    hulyProjectRef: huly.projectRef,
    bindingId: binding.bindingId
  }
}

export function isRealStackEnabled (): boolean {
  return process.env.E2E_REAL_STACK === '1'
}

export function isSoakEnabled (): boolean {
  return process.env.E2E_REAL_STACK === '1' && process.env.E2E_SOAK === '1'
}

// ---------------------------------------------------------------------------
// Phase 2: MR seeding + synthetic webhook
// ---------------------------------------------------------------------------

export interface SeedMRBody {
  source_branch: string
  target_branch: string
  title: string
  description?: string
  draft?: boolean
}

/** Build the REST POST body for `POST /api/v4/projects/:id/merge_requests`. */
export function buildSeedMRBody (args: SeedMRArgs): SeedMRBody {
  const body: SeedMRBody = {
    source_branch: args.sourceBranch ?? 'feature/e2e',
    target_branch: args.targetBranch ?? 'main',
    title: args.title ?? 'e2e-mr'
  }
  if (args.description !== undefined) {
    body.description = args.description
  }
  if (args.draft === true) {
    body.draft = true
  }
  return body
}

/**
 * Create a source branch in the GitLab project then open a merge request via
 * REST. Returns the MR iid plus the branch pair used.
 */
export async function seedGitLabMR (
  deps: Pick<HarnessDeps, 'fetch'>,
  gitlabBaseUrl: string,
  rootToken: string,
  projectId: number,
  args: SeedMRArgs = {}
): Promise<SeedMRResult> {
  const sourceBranch = args.sourceBranch ?? `feature/e2e-${Date.now()}`
  const targetBranch = args.targetBranch ?? 'main'

  const branchRes = await deps.fetch(
    `${gitlabBaseUrl}/api/v4/projects/${projectId}/repository/branches?branch=${encodeURIComponent(sourceBranch)}&ref=${encodeURIComponent(targetBranch)}`,
    {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': rootToken }
    }
  )
  if (branchRes.status !== 201) {
    throw new Error(`seedGitLabMR: branch create returned ${branchRes.status}`)
  }

  const body = buildSeedMRBody({ ...args, sourceBranch, targetBranch })
  const mrRes = await deps.fetch(`${gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests`, {
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': rootToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (mrRes.status !== 201) {
    throw new Error(`seedGitLabMR: MR create returned ${mrRes.status}`)
  }
  const mrBody = await mrRes.json() as { iid: number }
  return { mrIid: mrBody.iid, sourceBranch, targetBranch }
}

export interface SyntheticWebhookArgs {
  podBaseUrl: string
  bindingId: string
  eventHeader: string
  payload: unknown
  secret: string
}

export interface SyntheticWebhookResponse {
  status: number
  body: string
}

/**
 * POST a synthetic GitLab webhook to the pod with the binding's shared secret.
 * Used by `pipeline.e2e.test.ts` to exercise the receiver → manager → mixin
 * path without a real GitLab runner.
 */
export async function postSyntheticWebhook (
  deps: Pick<HarnessDeps, 'fetch'>,
  args: SyntheticWebhookArgs
): Promise<SyntheticWebhookResponse> {
  const res = await deps.fetch(`${args.podBaseUrl}/webhook/${args.bindingId}`, {
    method: 'POST',
    headers: {
      'X-Gitlab-Token': args.secret,
      'X-Gitlab-Event': args.eventHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args.payload)
  })
  const text = await res.text()
  return { status: res.status, body: text }
}

/**
 * Setup variant for MR-focused suites: boots the stack, binds the project,
 * then seeds a single MR ready for downstream assertions.
 */
export async function setupStackForMR (deps: HarnessDeps, args: SeedMRArgs = {}): Promise<MRStackContext> {
  const base = await setupFullStack(deps)
  const mr = await seedGitLabMR(deps, deps.gitlabBaseUrl, base.gitlabRootToken, base.gitlabProjectId, args)
  return { ...base, ...mr }
}

// ---------------------------------------------------------------------------
// Phase 3: review threads, approvals, diff metadata, reviewer migration
// ---------------------------------------------------------------------------

export interface SeedDiscussionPosition {
  baseSha: string
  startSha: string
  headSha: string
  oldPath: string
  newPath: string
  positionType: 'text'
  oldLine?: number
  newLine?: number
}

export interface SeedDiscussionArgs {
  body: string
  position?: SeedDiscussionPosition
}

export interface SeedDiscussionResult {
  discussionId: string
  noteId: number
}

export interface SeedDiscussionBody {
  body: string
  position?: {
    base_sha: string
    start_sha: string
    head_sha: string
    old_path: string
    new_path: string
    position_type: 'text'
    old_line?: number
    new_line?: number
  }
}

/** Build the REST POST body for `POST /api/v4/projects/:id/merge_requests/:iid/discussions`. */
export function buildSeedDiscussionBody (args: SeedDiscussionArgs): SeedDiscussionBody {
  const body: SeedDiscussionBody = { body: args.body }
  if (args.position !== undefined) {
    body.position = {
      base_sha: args.position.baseSha,
      start_sha: args.position.startSha,
      head_sha: args.position.headSha,
      old_path: args.position.oldPath,
      new_path: args.position.newPath,
      position_type: args.position.positionType
    }
    if (args.position.oldLine !== undefined) {
      body.position.old_line = args.position.oldLine
    }
    if (args.position.newLine !== undefined) {
      body.position.new_line = args.position.newLine
    }
  }
  return body
}

/**
 * Seed a discussion (thread) on a GitLab merge request. When `position` is
 * provided the discussion is a line-anchored review comment; otherwise it is
 * a free-form thread.
 */
export async function seedGitLabDiscussion (
  deps: Pick<HarnessDeps, 'fetch'>,
  gitlabBaseUrl: string,
  rootToken: string,
  projectId: number,
  mrIid: number,
  args: SeedDiscussionArgs
): Promise<SeedDiscussionResult> {
  const body = buildSeedDiscussionBody(args)
  const res = await deps.fetch(
    `${gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/discussions`,
    {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': rootToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  )
  if (res.status !== 201) {
    throw new Error(`seedGitLabDiscussion: unexpected status ${res.status}`)
  }
  const json = await res.json() as { id: string, notes?: Array<{ id: number }> }
  const firstNote = json.notes?.[0]
  if (firstNote === undefined) {
    throw new Error('seedGitLabDiscussion: response missing first note')
  }
  return { discussionId: json.id, noteId: firstNote.id }
}

export interface SeedDiscussionReplyArgs {
  discussionId: string
  body: string
}

/**
 * Append a reply note to an existing discussion thread. The reply inherits
 * the parent discussion's position; `position` is not posted on reply notes
 * (per the GitLab API).
 */
export async function seedGitLabDiscussionReply (
  deps: Pick<HarnessDeps, 'fetch'>,
  gitlabBaseUrl: string,
  rootToken: string,
  projectId: number,
  mrIid: number,
  args: SeedDiscussionReplyArgs
): Promise<{ noteId: number }> {
  const res = await deps.fetch(
    `${gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/discussions/${encodeURIComponent(args.discussionId)}/notes`,
    {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': rootToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body: args.body })
    }
  )
  if (res.status !== 201) {
    throw new Error(`seedGitLabDiscussionReply: unexpected status ${res.status}`)
  }
  const json = await res.json() as { id: number }
  return { noteId: json.id }
}

/**
 * Resolve a discussion on a GitLab MR via REST. Used to assert the
 * `gitlab-review.resolved` mixin flips true on all notes in the thread.
 */
export async function resolveGitLabDiscussion (
  deps: Pick<HarnessDeps, 'fetch'>,
  gitlabBaseUrl: string,
  rootToken: string,
  projectId: number,
  mrIid: number,
  discussionId: string
): Promise<void> {
  const res = await deps.fetch(
    `${gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/discussions/${encodeURIComponent(discussionId)}?resolved=true`,
    {
      method: 'PUT',
      headers: { 'PRIVATE-TOKEN': rootToken }
    }
  )
  if (res.status !== 200) {
    throw new Error(`resolveGitLabDiscussion: unexpected status ${res.status}`)
  }
}

/**
 * Approve a merge request as a specific user (via that user's PRIVATE-TOKEN).
 * The token is the approver's personal access token, not the root token.
 */
export async function seedGitLabApprover (
  deps: Pick<HarnessDeps, 'fetch'>,
  gitlabBaseUrl: string,
  projectId: number,
  mrIid: number,
  approverToken: string
): Promise<void> {
  const res = await deps.fetch(
    `${gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/approve`,
    {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': approverToken }
    }
  )
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`seedGitLabApprover: unexpected status ${res.status}`)
  }
}

/**
 * Unapprove a merge request as a specific user. Used to assert the
 * `gitlab-mr.approvedBy` list shrinks.
 */
export async function unapproveGitLabMR (
  deps: Pick<HarnessDeps, 'fetch'>,
  gitlabBaseUrl: string,
  projectId: number,
  mrIid: number,
  approverToken: string
): Promise<void> {
  const res = await deps.fetch(
    `${gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/unapprove`,
    {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': approverToken }
    }
  )
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`unapproveGitLabMR: unexpected status ${res.status}`)
  }
}

export interface MRApprovalsResponse {
  approvalsRequired: number
  approvedBy: string[]
}

/**
 * GET the approvals snapshot for an MR. Used by the diff/approval assertion
 * helpers to cross-check the Huly mirror state against GitLab ground truth.
 */
export async function getMRApprovalsFromGitLab (
  deps: Pick<HarnessDeps, 'fetch'>,
  gitlabBaseUrl: string,
  rootToken: string,
  projectId: number,
  mrIid: number
): Promise<MRApprovalsResponse> {
  const res = await deps.fetch(
    `${gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/approvals`,
    { headers: { 'PRIVATE-TOKEN': rootToken } }
  )
  if (res.status !== 200) {
    throw new Error(`getMRApprovalsFromGitLab: unexpected status ${res.status}`)
  }
  const body = await res.json() as {
    approvals_required: number
    approved_by?: Array<{ user: { username: string } }>
  }
  return {
    approvalsRequired: body.approvals_required,
    approvedBy: (body.approved_by ?? []).map((a) => a.user.username)
  }
}

export interface MRDiffFile {
  oldPath: string
  newPath: string
  newFile: boolean
  renamedFile: boolean
  deletedFile: boolean
}

export interface MRDiffResponse {
  files: MRDiffFile[]
  webUrl: string
}

/**
 * GET the changes/diff snapshot for an MR. Used to cross-check the
 * `gitlab-mr.changedFiles` mirror.
 */
export async function getMRDiffFromGitLab (
  deps: Pick<HarnessDeps, 'fetch'>,
  gitlabBaseUrl: string,
  rootToken: string,
  projectId: number,
  mrIid: number
): Promise<MRDiffResponse> {
  const res = await deps.fetch(
    `${gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/changes`,
    { headers: { 'PRIVATE-TOKEN': rootToken } }
  )
  if (res.status !== 200) {
    throw new Error(`getMRDiffFromGitLab: unexpected status ${res.status}`)
  }
  const body = await res.json() as {
    web_url: string
    changes?: Array<{
      old_path: string
      new_path: string
      new_file: boolean
      renamed_file: boolean
      deleted_file: boolean
    }>
  }
  return {
    webUrl: body.web_url,
    files: (body.changes ?? []).map((c) => ({
      oldPath: c.old_path,
      newPath: c.new_path,
      newFile: c.new_file,
      renamedFile: c.renamed_file,
      deletedFile: c.deleted_file
    }))
  }
}

// ---------------------------------------------------------------------------
// directMixinPatch — harness-only writer for ChatMessage AND Issue mixins
// ---------------------------------------------------------------------------

/**
 * Minimal transactor interface required by `directMixinPatch*` helpers.
 *
 * The real harness binds this to a `@hcengineering/client` connection. Unit
 * tests inject a mock that records the call shape. This keeps the harness
 * decoupled from the heavy transactor client at type level.
 */
export interface MinimalTransactor {
  createMixin: (
    targetRef: string,
    targetClass: string,
    space: string,
    mixin: string,
    attrs: Record<string, unknown>
  ) => Promise<void>
  updateMixin: (
    targetRef: string,
    targetClass: string,
    space: string,
    mixin: string,
    attrs: Record<string, unknown>
  ) => Promise<void>
}

/** Class id for tracker.Issue — duplicated as a string constant to avoid pulling the heavy core import into the harness. */
export const HARNESS_ISSUE_CLASS = 'tracker:class:Issue'
/** Class id for chunter.ChatMessage. */
export const HARNESS_CHAT_MESSAGE_CLASS = 'chunter:class:ChatMessage'

export interface DirectMixinPatchArgs {
  targetRef: string
  space: string
  mixin: string
  attrs: Record<string, unknown>
  mode?: 'create' | 'update'
}

/**
 * Patch a runtime mixin onto a tracker.Issue via the transactor. Phase 2
 * shape; preserved here verbatim so existing call sites keep working.
 */
export async function directMixinPatchOnIssue (
  transactor: MinimalTransactor,
  args: DirectMixinPatchArgs
): Promise<void> {
  const mode = args.mode ?? 'update'
  if (mode === 'create') {
    await transactor.createMixin(args.targetRef, HARNESS_ISSUE_CLASS, args.space, args.mixin, args.attrs)
  } else {
    await transactor.updateMixin(args.targetRef, HARNESS_ISSUE_CLASS, args.space, args.mixin, args.attrs)
  }
}

/**
 * Patch a runtime mixin onto a chunter.ChatMessage via the transactor.
 * Phase 3 addition (C18) — Phase 2 harness only supported Issue mixins.
 */
export async function directMixinPatchOnChatMessage (
  transactor: MinimalTransactor,
  args: DirectMixinPatchArgs
): Promise<void> {
  const mode = args.mode ?? 'update'
  if (mode === 'create') {
    await transactor.createMixin(args.targetRef, HARNESS_CHAT_MESSAGE_CLASS, args.space, args.mixin, args.attrs)
  } else {
    await transactor.updateMixin(args.targetRef, HARNESS_CHAT_MESSAGE_CLASS, args.space, args.mixin, args.attrs)
  }
}

// ---------------------------------------------------------------------------
// Phase 3: migration endpoint client
// ---------------------------------------------------------------------------

export interface MigrationResponse {
  status: number
  body: unknown
}

/**
 * POST to the reviewer-label migration endpoint with bearer auth.
 * Returns the parsed JSON body alongside the status so 409 and 200 paths
 * can be asserted symmetrically.
 */
export async function postMigrateReviewerLabels (
  deps: Pick<HarnessDeps, 'fetch'>,
  args: { podBaseUrl: string, serverSecret: string, bindingId: string }
): Promise<MigrationResponse> {
  const res = await deps.fetch(
    `${args.podBaseUrl}/api/v1/bindings/${args.bindingId}/migrate-reviewer-labels`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.serverSecret}` }
    }
  )
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

/**
 * PATCH a binding's `disabled` flag. Used by the migration runbook to pause
 * delivery before invoking `migrate-reviewer-labels`.
 */
export async function patchBindingDisabled (
  deps: Pick<HarnessDeps, 'fetch'>,
  args: { podBaseUrl: string, serverSecret: string, bindingId: string, disabled: boolean }
): Promise<{ status: number }> {
  const res = await deps.fetch(
    `${args.podBaseUrl}/api/v1/bindings/${args.bindingId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${args.serverSecret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ disabled: args.disabled })
    }
  )
  return { status: res.status }
}
