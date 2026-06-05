import { type Client, type Ref } from '@hcengineering/core'
import tracker, { type Project, type ProjectType, type Status, type TaskType } from '@hcengineering/tracker'
import task from '@hcengineering/task'
import { ProjectNotFoundError } from './errors'

export async function getTrackerProject (
  client: Client,
  hulyProjectRef: Ref<Project>
): Promise<{ project: Project, statuses: Status[], type: ProjectType }> {
  const projectQuery: Partial<Project> = { _id: hulyProjectRef }
  const project = await client.findOne(tracker.class.Project, projectQuery)
  if (project === undefined) {
    throw new ProjectNotFoundError(hulyProjectRef)
  }

  const typeQuery: Partial<ProjectType> = { _id: project.type }
  const projectType = await client.findOne(task.class.ProjectType, typeQuery)
  if (projectType === undefined) {
    // TODO: full status resolution exercised in T-10
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const stubType = { _id: project.type } as ProjectType
    return { project, statuses: [], type: stubType }
  }

  // Resolve statuses from task types
  const statuses: Status[] = []
  for (const taskTypeRef of projectType.tasks) {
    const ttQuery: Partial<TaskType> = { _id: taskTypeRef }
    const taskType = await client.findOne(task.class.TaskType, ttQuery)
    if (taskType !== undefined) {
      for (const statusRef of taskType.statuses) {
        const sQuery: Partial<Status> = { _id: statusRef }
        const status = await client.findOne(tracker.class.IssueStatus, sQuery)
        if (status !== undefined) {
          statuses.push(status)
        }
      }
    }
  }

  return { project, statuses, type: projectType }
}
