/**
 * Unit tests for the e2e harness. No docker, no network — all primitives are
 * dependency-injected via fakes.
 */

import {
  bootStack,
  pollHttp,
  parseInitialRootPassword,
  readGitLabInitialPassword,
  createRootToken,
  createGitLabProject,
  bindProjects,
  shutdownStack,
  isRealStackEnabled,
  isSoakEnabled,
  buildSeedMRBody,
  seedGitLabMR,
  postSyntheticWebhook,
  setupStackForMR,
  type HarnessDeps
} from './setup'
import { makeDockerMock } from './fakes/docker-mock'
import { makeFetchMock } from './fakes/http-mock'

function buildDeps (overrides: Partial<HarnessDeps> = {}): HarnessDeps {
  const docker = makeDockerMock()
  const http = makeFetchMock()
  return {
    exec: docker.exec,
    fetch: http.fetch,
    readFile: async () => '',
    sleep: async () => {},
    composeFile: '/tmp/docker-compose.dev.yml',
    gitlabBaseUrl: 'http://gitlab.test:8929',
    hulyAccountUrl: 'http://huly.test:8087/_accounts',
    podBaseUrl: 'http://pod.test:3600',
    serverSecret: 'unit-secret',
    ...overrides
  }
}

describe('harness primitives', () => {
  test('parseInitialRootPassword extracts the password line', () => {
    const content = '# WARNING\nPassword: hunter2-secret\n# expires in 24h\n'
    expect(parseInitialRootPassword(content)).toBe('hunter2-secret')
  })

  test('parseInitialRootPassword throws when no Password line present', () => {
    expect(() => parseInitialRootPassword('# WARNING\n# nothing here\n')).toThrow(/no "Password:" line/)
  })

  test('readGitLabInitialPassword shells out and parses stdout', async () => {
    const docker = makeDockerMock()
    docker.enqueue({ stdout: '# Note\nPassword: from-docker-9000\n' })
    const deps = buildDeps({ exec: docker.exec })
    const pwd = await readGitLabInitialPassword(deps)
    expect(pwd).toBe('from-docker-9000')
    expect(docker.invocations).toHaveLength(1)
    expect(docker.invocations[0].cmd).toContain('cat /etc/gitlab/initial_root_password')
  })

  test('pollHttp returns when endpoint reaches expected status', async () => {
    const http = makeFetchMock()
    http.on('/ready', [{ status: 503 }, { status: 503 }, { status: 200 }])
    const deps = buildDeps({ fetch: http.fetch })
    await pollHttp(deps, {
      url: 'http://x/ready',
      timeoutMs: 5000,
      intervalMs: 1,
      label: 'unit'
    })
    expect(http.invocations).toHaveLength(3)
  })

  test('pollHttp throws on timeout when endpoint never returns 200', async () => {
    const http = makeFetchMock()
    for (let i = 0; i < 50; i++) http.on('/never', { status: 503 })
    const deps = buildDeps({ fetch: http.fetch })
    await expect(
      pollHttp(deps, { url: 'http://x/never', timeoutMs: 30, intervalMs: 5, label: 'never' })
    ).rejects.toThrow(/timed out/)
  })

  test('bootStack calls docker compose up and then polls all three services', async () => {
    const docker = makeDockerMock()
    docker.enqueue({ stdout: '' })
    const http = makeFetchMock()
    http.on('/api/v4/version', { status: 200, body: { version: '16.11.10' } })
    http.on('/api/v1/accounts', { status: 200, body: [] })
    http.on('/health', { status: 200, body: { status: 'ok' } })
    const deps = buildDeps({ exec: docker.exec, fetch: http.fetch })

    await bootStack(deps, { gitlabTimeoutMs: 1000, hulyTimeoutMs: 1000, podTimeoutMs: 1000, pollIntervalMs: 1 })

    expect(docker.invocations).toHaveLength(1)
    expect(docker.invocations[0].cmd).toContain('docker compose')
    expect(docker.invocations[0].cmd).toContain('up -d')
    expect(http.invocations.map((i) => i.url)).toEqual(
      expect.arrayContaining([
        'http://gitlab.test:8929/api/v4/version',
        'http://huly.test:8087/_accounts/api/v1/accounts',
        'http://pod.test:3600/health'
      ])
    )
  })

  test('bootStack rejects when GitLab never becomes healthy', async () => {
    const docker = makeDockerMock()
    docker.enqueue({ stdout: '' })
    const http = makeFetchMock()
    for (let i = 0; i < 20; i++) http.on('/api/v4/version', { status: 502 })
    const deps = buildDeps({ exec: docker.exec, fetch: http.fetch })

    await expect(
      bootStack(deps, { gitlabTimeoutMs: 30, hulyTimeoutMs: 1000, podTimeoutMs: 1000, pollIntervalMs: 5 })
    ).rejects.toThrow(/gitlab/)
  })

  test('createRootToken parses last non-empty line of rails runner output', async () => {
    const docker = makeDockerMock()
    docker.enqueue({ stdout: 'Loading Rails...\nglpat-xyz-9876\n' })
    const deps = buildDeps({ exec: docker.exec })
    const tok = await createRootToken(deps)
    expect(tok).toBe('glpat-xyz-9876')
    expect(docker.invocations[0].cmd).toContain('gitlab-rails runner')
  })

  test('createGitLabProject posts to /api/v4/projects with PRIVATE-TOKEN header', async () => {
    const http = makeFetchMock()
    http.on('/api/v4/projects', {
      status: 201,
      body: { id: 42, path_with_namespace: 'root/e2e-proj' }
    })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await createGitLabProject(deps, 'http://gitlab.test:8929', 'tok-x', 'e2e-proj')
    expect(result).toEqual({ projectId: 42, projectPath: 'root/e2e-proj' })
    const call = http.invocations[0]
    expect(call.url).toBe('http://gitlab.test:8929/api/v4/projects')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['PRIVATE-TOKEN']).toBe('tok-x')
  })

  test('bindProjects calls pod admin endpoint with bearer auth and full payload', async () => {
    const http = makeFetchMock()
    http.on('/api/v1/bindings', { status: 201, body: { bindingId: 'b-1' } })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await bindProjects(deps, {
      podBaseUrl: 'http://pod.test:3600',
      serverSecret: 'sec',
      workspaceUuid: 'ws-1',
      hulyProjectRef: 'proj-1',
      gitlabProjectId: 99,
      gitlabProjectPath: 'g/p',
      credentialRef: 'cred-1'
    })
    expect(result).toEqual({ bindingId: 'b-1' })
    const call = http.invocations[0]
    expect(call.url).toBe('http://pod.test:3600/api/v1/bindings')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sec')
    const body = JSON.parse(call.init?.body as string)
    expect(body).toEqual({
      workspaceUuid: 'ws-1',
      hulyProjectRef: 'proj-1',
      gitlabProjectId: 99,
      gitlabProjectPath: 'g/p',
      credentialRef: 'cred-1'
    })
  })

  test('bindProjects throws on non-201 response', async () => {
    const http = makeFetchMock()
    http.on('/api/v1/bindings', { status: 500, body: { error: 'boom' } })
    const deps = buildDeps({ fetch: http.fetch })
    await expect(
      bindProjects(deps, {
        podBaseUrl: 'http://pod.test:3600',
        serverSecret: 'sec',
        workspaceUuid: 'ws',
        hulyProjectRef: 'p',
        gitlabProjectId: 1,
        gitlabProjectPath: 'g/p',
        credentialRef: 'c'
      })
    ).rejects.toThrow(/unexpected status 500/)
  })

  test('shutdownStack issues docker compose down', async () => {
    const docker = makeDockerMock()
    docker.enqueue({ stdout: '' })
    const deps = buildDeps({ exec: docker.exec })
    await shutdownStack(deps)
    expect(docker.invocations).toHaveLength(1)
    expect(docker.invocations[0].cmd).toContain('docker compose')
    expect(docker.invocations[0].cmd).toContain('down')
  })

  test('buildSeedMRBody constructs the correct REST POST body for /merge_requests', () => {
    const body = buildSeedMRBody({
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      title: 'mr-title',
      description: 'mr-desc',
      draft: true
    })
    expect(body).toEqual({
      source_branch: 'feature/x',
      target_branch: 'main',
      title: 'mr-title',
      description: 'mr-desc',
      draft: true
    })
    const minimal = buildSeedMRBody({})
    expect(minimal.source_branch).toBe('feature/e2e')
    expect(minimal.target_branch).toBe('main')
    expect(minimal.title).toBe('e2e-mr')
    expect(minimal).not.toHaveProperty('draft')
    expect(minimal).not.toHaveProperty('description')
  })

  test('seedGitLabMR creates branch then posts to /merge_requests with PRIVATE-TOKEN', async () => {
    const http = makeFetchMock()
    http.on('/repository/branches', { status: 201, body: { name: 'feature/seeded' } })
    http.on('/merge_requests', { status: 201, body: { iid: 7 } })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await seedGitLabMR(deps, 'http://gitlab.test:8929', 'tok-x', 12, {
      sourceBranch: 'feature/seeded',
      targetBranch: 'main',
      title: 'mr-seed'
    })
    expect(result).toEqual({ mrIid: 7, sourceBranch: 'feature/seeded', targetBranch: 'main' })
    expect(http.invocations).toHaveLength(2)
    const branchCall = http.invocations[0]
    expect(branchCall.url).toContain('/api/v4/projects/12/repository/branches')
    expect(branchCall.url).toContain('branch=feature%2Fseeded')
    expect(branchCall.url).toContain('ref=main')
    const mrCall = http.invocations[1]
    expect(mrCall.url).toBe('http://gitlab.test:8929/api/v4/projects/12/merge_requests')
    const mrHeaders = mrCall.init?.headers as Record<string, string>
    expect(mrHeaders['PRIVATE-TOKEN']).toBe('tok-x')
    const mrBody = JSON.parse(mrCall.init?.body as string)
    expect(mrBody).toEqual({
      source_branch: 'feature/seeded',
      target_branch: 'main',
      title: 'mr-seed'
    })
  })

  test('postSyntheticWebhook POSTs to /webhook/:bindingId with X-Gitlab-Token + X-Gitlab-Event', async () => {
    const http = makeFetchMock()
    http.on('/webhook/binding-42', { status: 200, text: 'ok' })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await postSyntheticWebhook(deps, {
      podBaseUrl: 'http://pod.test:3600',
      bindingId: 'binding-42',
      eventHeader: 'Pipeline Hook',
      payload: { object_kind: 'pipeline', object_attributes: { status: 'success' } },
      secret: 'wh-secret'
    })
    expect(result).toEqual({ status: 200, body: 'ok' })
    const call = http.invocations[0]
    expect(call.url).toBe('http://pod.test:3600/webhook/binding-42')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['X-Gitlab-Token']).toBe('wh-secret')
    expect(headers['X-Gitlab-Event']).toBe('Pipeline Hook')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(call.init?.body as string)
    expect(body.object_kind).toBe('pipeline')
  })

  test('setupStackForMR boots stack + seeds project + binds + seeds MR (mocked)', async () => {
    const docker = makeDockerMock()
    docker.enqueue({ stdout: '' }) // docker compose up -d
    docker.enqueue({ stdout: '# warn\nPassword: dont-care\n' }) // unused but harmless
    docker.enqueue({ stdout: 'Loading Rails...\nglpat-seeded-token\n' }) // createRootToken
    const http = makeFetchMock()
    // bootStack health probes
    http.on('/api/v4/version', { status: 200, body: { version: '16.11.10' } })
    http.on('/api/v1/accounts', { status: 200, body: [] })
    http.on('/health', { status: 200, body: { status: 'ok' } })
    // seedGitLab → createGitLabProject
    http.on('/api/v4/projects', { status: 201, body: { id: 77, path_with_namespace: 'root/mr-proj' } })
    // seedHuly → workspace create
    http.on('/api/v1/workspaces', { status: 201, body: { workspaceUuid: 'ws-mr-1' } })
    // bindProjects
    http.on('/api/v1/bindings', { status: 201, body: { bindingId: 'b-mr-1' } })
    // seedGitLabMR
    http.on('/repository/branches', { status: 201, body: { name: 'feature/m' } })
    http.on('/merge_requests', { status: 201, body: { iid: 3 } })
    const deps = buildDeps({ exec: docker.exec, fetch: http.fetch })

    const result = await setupStackForMR(deps, { sourceBranch: 'feature/m', title: 't' })

    expect(result.gitlabProjectId).toBe(77)
    expect(result.hulyWorkspaceUuid).toBe('ws-mr-1')
    expect(result.bindingId).toBe('b-mr-1')
    expect(result.mrIid).toBe(3)
    expect(result.sourceBranch).toBe('feature/m')
    expect(result.targetBranch).toBe('main')
  })

  test('isRealStackEnabled and isSoakEnabled honor env vars', () => {
    const prevReal = process.env.E2E_REAL_STACK
    const prevSoak = process.env.E2E_SOAK
    try {
      delete process.env.E2E_REAL_STACK
      delete process.env.E2E_SOAK
      expect(isRealStackEnabled()).toBe(false)
      expect(isSoakEnabled()).toBe(false)

      process.env.E2E_REAL_STACK = '1'
      expect(isRealStackEnabled()).toBe(true)
      expect(isSoakEnabled()).toBe(false)

      process.env.E2E_SOAK = '1'
      expect(isSoakEnabled()).toBe(true)
    } finally {
      if (prevReal === undefined) {
        delete process.env.E2E_REAL_STACK
      } else {
        process.env.E2E_REAL_STACK = prevReal
      }
      if (prevSoak === undefined) {
        delete process.env.E2E_SOAK
      } else {
        process.env.E2E_SOAK = prevSoak
      }
    }
  })
})
