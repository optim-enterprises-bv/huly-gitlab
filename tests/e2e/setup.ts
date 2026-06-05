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
