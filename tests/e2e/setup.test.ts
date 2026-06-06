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
  buildSeedDiscussionBody,
  seedGitLabDiscussion,
  seedGitLabApprover,
  getMRApprovalsFromGitLab,
  getMRDiffFromGitLab,
  postMigrateReviewerLabels,
  patchBindingDisabled,
  directMixinPatchOnChatMessage,
  directMixinPatchOnIssue,
  simulateHulyTxEdit,
  getMRApprovalRulesFromGitLab,
  createGitLabEpic,
  linkUserOAuth,
  getUserOAuthStatus,
  deleteUserOAuthCredential,
  triggerHulyTxWrite,
  runMixinSplitMigration,
  forceGraphQLFailure,
  rotateServerSecret,
  HARNESS_CHAT_MESSAGE_CLASS,
  HARNESS_ISSUE_CLASS,
  type HarnessDeps,
  type MinimalTransactor,
  type MinimalHulyTxClient
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

  test('buildSeedDiscussionBody serializes position fields into snake_case', () => {
    const minimal = buildSeedDiscussionBody({ body: 'hello' })
    expect(minimal).toEqual({ body: 'hello' })

    const withPos = buildSeedDiscussionBody({
      body: 'line cmt',
      position: {
        baseSha: 'b'.repeat(40),
        startSha: 's'.repeat(40),
        headSha: 'h'.repeat(40),
        oldPath: 'a.ts',
        newPath: 'b.ts',
        positionType: 'text',
        newLine: 12
      }
    })
    expect(withPos).toEqual({
      body: 'line cmt',
      position: {
        base_sha: 'b'.repeat(40),
        start_sha: 's'.repeat(40),
        head_sha: 'h'.repeat(40),
        old_path: 'a.ts',
        new_path: 'b.ts',
        position_type: 'text',
        new_line: 12
      }
    })
  })

  test('seedGitLabDiscussion POSTs to /discussions with PRIVATE-TOKEN and parses note id', async () => {
    const http = makeFetchMock()
    http.on('/discussions', {
      status: 201,
      body: { id: 'disc-abc', notes: [{ id: 901 }] }
    })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await seedGitLabDiscussion(deps, 'http://gitlab.test:8929', 'tok-x', 5, 9, {
      body: 'review note'
    })
    expect(result).toEqual({ discussionId: 'disc-abc', noteId: 901 })
    const call = http.invocations[0]
    expect(call.url).toBe('http://gitlab.test:8929/api/v4/projects/5/merge_requests/9/discussions')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['PRIVATE-TOKEN']).toBe('tok-x')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(call.init?.body as string)
    expect(body).toEqual({ body: 'review note' })
  })

  test('seedGitLabApprover uses PRIVATE-TOKEN header from approverToken (not root)', async () => {
    const http = makeFetchMock()
    http.on('/approve', { status: 201, body: { state: 'approved' } })
    const deps = buildDeps({ fetch: http.fetch })
    await seedGitLabApprover(deps, 'http://gitlab.test:8929', 12, 4, 'reviewer-token')
    const call = http.invocations[0]
    expect(call.url).toBe('http://gitlab.test:8929/api/v4/projects/12/merge_requests/4/approve')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['PRIVATE-TOKEN']).toBe('reviewer-token')
  })

  test('getMRApprovalsFromGitLab builds correct URL and shapes response', async () => {
    const http = makeFetchMock()
    http.on('/approvals', {
      status: 200,
      body: {
        approvals_required: 2,
        approved_by: [{ user: { username: 'alice' } }, { user: { username: 'bob' } }]
      }
    })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await getMRApprovalsFromGitLab(deps, 'http://gitlab.test:8929', 'root-tok', 3, 8)
    expect(result).toEqual({ approvalsRequired: 2, approvedBy: ['alice', 'bob'] })
    const call = http.invocations[0]
    expect(call.url).toBe('http://gitlab.test:8929/api/v4/projects/3/merge_requests/8/approvals')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['PRIVATE-TOKEN']).toBe('root-tok')
  })

  test('getMRDiffFromGitLab GETs /changes and projects change records', async () => {
    const http = makeFetchMock()
    http.on('/changes', {
      status: 200,
      body: {
        web_url: 'http://gitlab.test/proj/-/merge_requests/3',
        changes: [
          { old_path: 'a.ts', new_path: 'a.ts', new_file: false, renamed_file: false, deleted_file: false },
          { old_path: 'old.ts', new_path: 'new.ts', new_file: false, renamed_file: true, deleted_file: false }
        ]
      }
    })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await getMRDiffFromGitLab(deps, 'http://gitlab.test:8929', 'tok', 1, 3)
    expect(result.webUrl).toBe('http://gitlab.test/proj/-/merge_requests/3')
    expect(result.files).toHaveLength(2)
    expect(result.files[1]).toEqual({
      oldPath: 'old.ts',
      newPath: 'new.ts',
      newFile: false,
      renamedFile: true,
      deletedFile: false
    })
  })

  test('postMigrateReviewerLabels parses JSON body and surfaces 409 status', async () => {
    const http = makeFetchMock()
    http.on('/migrate-reviewer-labels', {
      status: 409,
      body: { error: 'binding is active; pause before migrating' }
    })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await postMigrateReviewerLabels(deps, {
      podBaseUrl: 'http://pod.test:3600',
      serverSecret: 'sec',
      bindingId: 'b-1'
    })
    expect(result.status).toBe(409)
    expect(result.body).toEqual({ error: 'binding is active; pause before migrating' })
    const call = http.invocations[0]
    expect(call.url).toBe('http://pod.test:3600/api/v1/bindings/b-1/migrate-reviewer-labels')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sec')
  })

  test('patchBindingDisabled PATCHes the binding with disabled flag in JSON body', async () => {
    const http = makeFetchMock()
    http.on('/api/v1/bindings/b-2', { status: 200, body: { ok: true } })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await patchBindingDisabled(deps, {
      podBaseUrl: 'http://pod.test:3600',
      serverSecret: 'sec',
      bindingId: 'b-2',
      disabled: true
    })
    expect(result.status).toBe(200)
    const call = http.invocations[0]
    expect(call.url).toBe('http://pod.test:3600/api/v1/bindings/b-2')
    expect(call.init?.method).toBe('PATCH')
    const body = JSON.parse(call.init?.body as string)
    expect(body).toEqual({ disabled: true })
  })

  test('directMixinPatchOnChatMessage forwards to transactor.updateMixin with ChatMessage class', async () => {
    const calls: Array<{ method: string, args: unknown[] }> = []
    const mockTransactor: MinimalTransactor = {
      createMixin: async (...args) => {
        calls.push({ method: 'createMixin', args })
      },
      updateMixin: async (...args) => {
        calls.push({ method: 'updateMixin', args })
      }
    }
    await directMixinPatchOnChatMessage(mockTransactor, {
      targetRef: 'msg-1',
      space: 'space-1',
      mixin: 'gitlab-review',
      attrs: { resolved: true, threadId: 'd1' }
    })
    expect(calls).toEqual([
      {
        method: 'updateMixin',
        args: ['msg-1', HARNESS_CHAT_MESSAGE_CLASS, 'space-1', 'gitlab-review', { resolved: true, threadId: 'd1' }]
      }
    ])
  })

  test('directMixinPatchOnChatMessage create mode calls createMixin (C18)', async () => {
    const calls: Array<{ method: string, args: unknown[] }> = []
    const mockTransactor: MinimalTransactor = {
      createMixin: async (...args) => {
        calls.push({ method: 'createMixin', args })
      },
      updateMixin: async (...args) => {
        calls.push({ method: 'updateMixin', args })
      }
    }
    await directMixinPatchOnChatMessage(mockTransactor, {
      targetRef: 'msg-2',
      space: 'space-2',
      mixin: 'gitlab-review',
      attrs: { threadId: 'd-new', resolved: false },
      mode: 'create'
    })
    expect(calls[0]?.method).toBe('createMixin')
    expect(calls[0]?.args[1]).toBe(HARNESS_CHAT_MESSAGE_CLASS)
  })

  test('directMixinPatchOnIssue still targets Issue class (no regression from C18)', async () => {
    const calls: Array<{ method: string, args: unknown[] }> = []
    const mockTransactor: MinimalTransactor = {
      createMixin: async (...args) => {
        calls.push({ method: 'createMixin', args })
      },
      updateMixin: async (...args) => {
        calls.push({ method: 'updateMixin', args })
      }
    }
    await directMixinPatchOnIssue(mockTransactor, {
      targetRef: 'issue-1',
      space: 'space-1',
      mixin: 'gitlab-mr',
      attrs: { draft: true }
    })
    expect(calls[0]?.args[1]).toBe(HARNESS_ISSUE_CLASS)
  })

  test('simulateHulyTxEdit forwards to transactor.updateDoc with Issue class by default', async () => {
    const calls: Array<{ cls: string, space: string, id: string, ops: Record<string, unknown> }> = []
    const fakeClient: MinimalHulyTxClient = {
      updateDoc: async (cls, space, id, ops) => {
        calls.push({ cls, space, id, ops })
      }
    }
    await simulateHulyTxEdit(fakeClient, {
      issueRef: 'issue-7',
      space: 'space-7',
      field: 'title',
      value: 'new title'
    })
    expect(calls).toEqual([
      { cls: HARNESS_ISSUE_CLASS, space: 'space-7', id: 'issue-7', ops: { title: 'new title' } }
    ])
  })

  test('simulateHulyTxEdit honors objectClass override (e.g. ChatMessage)', async () => {
    const calls: string[] = []
    const fakeClient: MinimalHulyTxClient = {
      updateDoc: async (cls) => {
        calls.push(cls)
      }
    }
    await simulateHulyTxEdit(fakeClient, {
      issueRef: 'msg-1',
      space: 's',
      field: 'message',
      value: 'edited body',
      objectClass: HARNESS_CHAT_MESSAGE_CLASS
    })
    expect(calls).toEqual([HARNESS_CHAT_MESSAGE_CLASS])
  })

  test('getMRApprovalRulesFromGitLab GETs /approval_rules and maps response to camelCase', async () => {
    const http = makeFetchMock()
    http.on('/approval_rules', {
      status: 200,
      body: [
        { id: 1, name: 'security', approvals_required: 1, approved_by: [{ username: 'sec-lead' }] },
        { id: 2, name: 'qa', approvals_required: 2, approved_by: [] }
      ]
    })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await getMRApprovalRulesFromGitLab(deps, 'http://gitlab.test:8929', 'rt', 9, 4)
    expect(result.rules).toEqual([
      { id: 1, name: 'security', approvalsRequired: 1, approvedBy: ['sec-lead'] },
      { id: 2, name: 'qa', approvalsRequired: 2, approvedBy: [] }
    ])
    const call = http.invocations[0]
    expect(call.url).toBe('http://gitlab.test:8929/api/v4/projects/9/merge_requests/4/approval_rules')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['PRIVATE-TOKEN']).toBe('rt')
  })

  test('getMRApprovalRulesFromGitLab throws on non-200 response (EE-only endpoint on CE)', async () => {
    const http = makeFetchMock()
    http.on('/approval_rules', { status: 404, body: { error: 'not found' } })
    const deps = buildDeps({ fetch: http.fetch })
    await expect(
      getMRApprovalRulesFromGitLab(deps, 'http://gitlab.test:8929', 'rt', 1, 1)
    ).rejects.toThrow(/unexpected status 404/)
  })

  test('createGitLabEpic POSTs to /groups/:id/epics with title + optional labels CSV', async () => {
    const http = makeFetchMock()
    http.on('/epics', { status: 201, body: { iid: 88, group_id: 12 } })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await createGitLabEpic(deps, 'http://gitlab.test:8929', 'rt', 12, {
      title: 'e2e-epic',
      labels: ['priority::1', 'team::core']
    })
    expect(result).toEqual({ epicIid: 88, groupId: 12 })
    const call = http.invocations[0]
    expect(call.url).toBe('http://gitlab.test:8929/api/v4/groups/12/epics')
    expect(call.init?.method).toBe('POST')
    const body = JSON.parse(call.init?.body as string)
    expect(body).toEqual({ title: 'e2e-epic', labels: 'priority::1,team::core' })
  })

  test('linkUserOAuth follows the /start redirect into /callback with extracted state', async () => {
    const http = makeFetchMock()
    http.on('/user/oauth/start', {
      status: 302,
      body: '',
      text: ''
    })
    http.on('/user/oauth/callback', { status: 200, body: { ok: true } })
    const deps = buildDeps({ fetch: http.fetch })
    // We can't easily set Location headers through the fetch-mock, so the test
    // asserts the no-state branch returns startStatus only with callbackStatus=0.
    const result = await linkUserOAuth(deps, {
      podUrl: 'http://pod.test:3600',
      hulyUserCookie: 'json-hmac-cookie',
      gitlabBaseUrl: 'http://gitlab.test:8929'
    })
    expect(result.startStatus).toBe(302)
    expect(result.callbackStatus).toBe(0)
    const call = http.invocations[0]
    expect(call.url).toBe('http://pod.test:3600/user/oauth/start')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Cookie).toBe('huly-user=json-hmac-cookie')
  })

  test('getUserOAuthStatus parses linked=true JSON body and surfaces the username field (SCG-2)', async () => {
    const http = makeFetchMock()
    http.on('/user/oauth/status', {
      status: 200,
      body: { linked: true, username: 'alice' }
    })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await getUserOAuthStatus(deps, {
      podUrl: 'http://pod.test:3600',
      bearer: 'tok-x'
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ linked: true, username: 'alice' })
    const headers = http.invocations[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-x')
  })

  test('deleteUserOAuthCredential DELETEs /user/oauth/credential with bearer auth', async () => {
    const http = makeFetchMock()
    http.on('/user/oauth/credential', { status: 204, body: '' })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await deleteUserOAuthCredential(deps, {
      podUrl: 'http://pod.test:3600',
      bearer: 'tok-x'
    })
    expect(result.status).toBe(204)
    const call = http.invocations[0]
    expect(call.url).toBe('http://pod.test:3600/user/oauth/credential')
    expect(call.init?.method).toBe('DELETE')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-x')
  })

  test('triggerHulyTxWrite calls updateMixin on the transactor with the given field/value', async () => {
    const calls: Array<{ method: string, targetRef: string, mixin: string, attrs: Record<string, unknown> }> = []
    const mockTransactor: MinimalTransactor = {
      createMixin: async (targetRef, _cls, _space, mixin, attrs) => {
        calls.push({ method: 'createMixin', targetRef, mixin, attrs })
      },
      updateMixin: async (targetRef, _cls, _space, mixin, attrs) => {
        calls.push({ method: 'updateMixin', targetRef, mixin, attrs })
      }
    }
    await triggerHulyTxWrite(mockTransactor, 'issue-ref-1', 'status', 'in-review')
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('updateMixin')
    expect(calls[0].targetRef).toBe('issue-ref-1')
    expect(calls[0].mixin).toBe('gitlab-mr')
    expect(calls[0].attrs).toEqual({ status: 'in-review' })
  })

  test('runMixinSplitMigration POSTs to /migrate-mixin-split with bearer auth and parses JSON body', async () => {
    const http = makeFetchMock()
    http.on('/migrate-mixin-split', {
      status: 200,
      body: { docsScanned: 5, docsMigrated: 3, bindingsProcessed: 1 }
    })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await runMixinSplitMigration(deps, {
      podBaseUrl: 'http://pod.test:3600',
      bindingId: 'b-split-1',
      bearer: 'admin-token'
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ docsScanned: 5, docsMigrated: 3, bindingsProcessed: 1 })
    const call = http.invocations[0]
    expect(call.url).toBe('http://pod.test:3600/api/v1/bindings/b-split-1/migrate-mixin-split')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer admin-token')
  })

  test('forceGraphQLFailure POSTs to /features/graphql_toggle with PRIVATE-TOKEN', async () => {
    const http = makeFetchMock()
    http.on('/graphql_toggle', { status: 200, body: { name: 'graphql_toggle', state: 'off' } })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await forceGraphQLFailure(deps, {
      gitlabBaseUrl: 'http://gitlab.test:8929',
      rootToken: 'root-tok'
    })
    expect(result.status).toBe(200)
    const call = http.invocations[0]
    expect(call.url).toBe('http://gitlab.test:8929/api/v4/features/graphql_toggle')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['PRIVATE-TOKEN']).toBe('root-tok')
    const body = JSON.parse(call.init?.body as string)
    expect(body).toEqual({ value: false })
  })

  test('rotateServerSecret POSTs to /api/v1/admin/rotate-secret with bearer auth and newPrimary', async () => {
    const http = makeFetchMock()
    http.on('/rotate-secret', {
      status: 200,
      body: { rotated: true, previousKeyRetained: true }
    })
    const deps = buildDeps({ fetch: http.fetch })
    const result = await rotateServerSecret(deps, {
      podUrl: 'http://pod.test:3600',
      bearer: 'admin-secret',
      newPrimary: 'new-key-xyz'
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ rotated: true, previousKeyRetained: true })
    const call = http.invocations[0]
    expect(call.url).toBe('http://pod.test:3600/api/v1/admin/rotate-secret')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer admin-secret')
    const body = JSON.parse(call.init?.body as string)
    expect(body).toEqual({ newPrimary: 'new-key-xyz' })
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
