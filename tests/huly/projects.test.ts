import { getTrackerProject } from '../../src/huly/projects'
import { ProjectNotFoundError } from '../../src/huly/errors'
import type { Client, Ref, Doc, Class } from '@hcengineering/core'
import type { Project, ProjectType, TaskType, Status } from '@hcengineering/tracker'

function makeClient (findOneImpl: (cls: unknown, query: unknown) => Promise<unknown>): Client {
  return {
    findOne: jest.fn().mockImplementation(findOneImpl),
    findAll: jest.fn(),
    close: jest.fn()
  } as unknown as Client
}

const PROJECT_REF = 'project-ref-123' as Ref<Project>

const TASK_TYPE_REF = 'task-type-ref-1' as Ref<TaskType>
const STATUS_REF = 'status-ref-1' as Ref<Status>

const MOCK_STATUS: Status = {
  _id: STATUS_REF as unknown as Ref<Doc>,
  _class: 'tracker:class:IssueStatus' as unknown as Ref<Class<Doc>>,
  space: 'space-ref' as unknown as Ref<Doc>,
  modifiedOn: 0,
  modifiedBy: 'sys' as unknown as Ref<Doc>,
  name: 'In Progress',
  category: 'cat' as unknown as Ref<Doc>
}

const MOCK_TASK_TYPE: TaskType = {
  _id: TASK_TYPE_REF as unknown as Ref<Doc>,
  _class: 'task:class:TaskType' as unknown as Ref<Class<Doc>>,
  space: 'space-ref' as unknown as Ref<Doc>,
  modifiedOn: 0,
  modifiedBy: 'sys' as unknown as Ref<Doc>,
  name: 'Default Task Type',
  statuses: [STATUS_REF]
}

const MOCK_PROJECT_TYPE: ProjectType = {
  _id: 'project-type-ref-1' as unknown as Ref<Doc>,
  _class: 'task:class:ProjectType' as unknown as Ref<Class<Doc>>,
  space: 'space-ref' as unknown as Ref<Doc>,
  modifiedOn: 0,
  modifiedBy: 'sys' as unknown as Ref<Doc>,
  name: 'Software Dev',
  tasks: [TASK_TYPE_REF]
}

const MOCK_PROJECT: Project = {
  _id: PROJECT_REF as unknown as Ref<Doc>,
  _class: 'tracker:class:Project' as unknown as Ref<Class<Doc>>,
  space: 'space-ref' as unknown as Ref<Doc>,
  modifiedOn: 0,
  modifiedBy: 'sys' as unknown as Ref<Doc>,
  name: 'My Project',
  description: '',
  members: [],
  archived: false,
  private: false,
  identifier: 'MP',
  sequence: 0,
  type: MOCK_PROJECT_TYPE._id as unknown as Ref<ProjectType>,
  defaultIssueStatus: STATUS_REF as unknown as Ref<Status>
}

describe('getTrackerProject', () => {
  // 1. Returns project + statuses + type when found
  it('returns project, statuses, and type when project exists', async () => {
    const client = makeClient(async (_cls, query) => {
      const q = query as Record<string, unknown>
      if (q._id === PROJECT_REF) return MOCK_PROJECT
      if (q._id === MOCK_PROJECT_TYPE._id) return MOCK_PROJECT_TYPE
      if (q._id === TASK_TYPE_REF) return MOCK_TASK_TYPE
      if (q._id === STATUS_REF) return MOCK_STATUS
      return undefined
    })

    const result = await getTrackerProject(client, PROJECT_REF)

    expect(result.project).toEqual(MOCK_PROJECT)
    expect(result.type).toEqual(MOCK_PROJECT_TYPE)
    expect(result.statuses).toHaveLength(1)
    expect(result.statuses[0]).toEqual(MOCK_STATUS)
  })

  // 2. Throws ProjectNotFoundError when ref missing
  it('throws ProjectNotFoundError when project ref does not exist', async () => {
    const client = makeClient(async () => undefined)

    await expect(getTrackerProject(client, PROJECT_REF)).rejects.toThrow(ProjectNotFoundError)
    await expect(getTrackerProject(client, PROJECT_REF)).rejects.toThrow('project-ref-123')
  })
})
