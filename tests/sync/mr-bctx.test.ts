import type { Ref, Space, WorkspaceUuid } from '@hcengineering/core'
import type { TaskType } from '@hcengineering/tracker'
import { resolveProjectPath, type MRBindingContext, type MRGitLabClient } from '../../src/sync/mr'
import type { SyncProject } from '../../src/adapter/types'
import { LabelCache } from '../../src/sync/label-cache'
import { MilestoneCache } from '../../src/sync/milestone-cache'

function makeProject (pathWithNamespace: string): SyncProject {
  return {
    id: 42,
    name: 'proj',
    nameWithNamespace: pathWithNamespace,
    path: 'proj',
    pathWithNamespace,
    description: null,
    webUrl: `https://gitlab.example/${pathWithNamespace}`,
    visibility: 'private',
    defaultBranch: 'main',
    createdAt: '2024-01-01T00:00:00Z',
    lastActivityAt: '2024-01-01T00:00:00Z'
  }
}

function makeBctx (getProject: jest.Mock): MRBindingContext {
  const hulyProjectRef = 'huly-proj' as unknown as Ref<Space>
  return {
    workspaceUuid: 'ws-1' as unknown as WorkspaceUuid,
    gitlabProjectId: 42,
    gitlabProjectPath: 'group/proj',
    hulyProjectRef,
    hulyClient: {} as MRBindingContext['hulyClient'],
    gitlabClient: { getProject } as unknown as MRGitLabClient,
    statuses: [],
    userIdentity: {} as MRBindingContext['userIdentity'],
    labelCache: new LabelCache(42, hulyProjectRef),
    milestoneCache: new MilestoneCache(42, hulyProjectRef),
    defaultTaskType: 'task:taskType:default' as unknown as Ref<TaskType>,
    gitlabBaseUrl: 'https://gitlab.example',
    credentials: { resolveActorToken: async () => undefined }
  }
}

describe('resolveProjectPath', () => {
  it('calls getProject and returns pathWithNamespace on first call', async () => {
    const getProject = jest.fn().mockResolvedValue(makeProject('group/myrepo'))
    const bctx = makeBctx(getProject)

    const path = await resolveProjectPath(bctx)

    expect(path).toBe('group/myrepo')
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(getProject).toHaveBeenCalledWith(42)
  })

  it('caches result on bctx.resolvedProjectPath; second call does not call getProject again', async () => {
    const getProject = jest.fn().mockResolvedValue(makeProject('group/myrepo'))
    const bctx = makeBctx(getProject)

    await resolveProjectPath(bctx)
    const path2 = await resolveProjectPath(bctx)

    expect(path2).toBe('group/myrepo')
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(bctx.resolvedProjectPath).toBe('group/myrepo')
  })

  it('returns pre-cached value immediately when resolvedProjectPath already set', async () => {
    const getProject = jest.fn()
    const bctx = makeBctx(getProject)
    bctx.resolvedProjectPath = 'group/cached'

    const path = await resolveProjectPath(bctx)

    expect(path).toBe('group/cached')
    expect(getProject).not.toHaveBeenCalled()
  })

  it('falls back to String(gitlabProjectId) when getProject throws', async () => {
    const getProject = jest.fn().mockRejectedValue(new Error('network error'))
    const bctx = makeBctx(getProject)

    const path = await resolveProjectPath(bctx)

    expect(path).toBe('42')
    expect(getProject).toHaveBeenCalledTimes(1)
  })
})
