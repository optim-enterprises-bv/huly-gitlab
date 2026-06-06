export class GitLabApiError extends Error {
  constructor (
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: unknown
  ) {
    super(message)
    this.name = 'GitLabApiError'
  }
}

export class RateLimitError extends Error {
  constructor (message: string, public readonly retryAfterMs: number) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/**
 * Thrown by getIssue() when the remote issue has confidential:true.
 * Per Q5 resolution, confidential issues must never be returned to callers.
 */
export class ConfidentialIssueError extends Error {
  constructor (public readonly projectId: number | string, public readonly iid: number) {
    super(`Issue ${iid} in project ${projectId} is confidential and cannot be returned`)
    this.name = 'ConfidentialIssueError'
  }
}

export class AuthError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export class NotFoundError extends Error {
  constructor (resource: string) {
    super(`Not found: ${resource}`)
    this.name = 'NotFoundError'
  }
}

export class ConfidentialMergeRequestError extends Error {
  constructor (public iid: number) {
    super(`Confidential merge request !${iid} cannot be synced`)
    this.name = 'ConfidentialMergeRequestError'
  }
}

export class ConfidentialEpicError extends Error {
  readonly iid: number
  readonly groupId: number
  constructor (iid: number, groupId: number) {
    super(`Confidential epic !${iid} in group ${groupId} cannot be synced`)
    this.name = 'ConfidentialEpicError'
    this.iid = iid
    this.groupId = groupId
  }
}

export class ApprovalActionError extends Error {
  readonly kind: 'approve' | 'unapprove'
  /**
   * GitLab numeric project id (stringified) — the request target. Renamed from
   * the original `bindingId` (B5): the value passed at the throw site is
   * `String(projectId)` from gitlab-client.ts, NOT the binding Mongo
   * ObjectId. Keep the name consistent with the value for honest debugging.
   */
  readonly projectId: string
  readonly mrIid: number
  readonly actorUuid: string | undefined

  constructor (
    kind: 'approve' | 'unapprove',
    projectId: string,
    mrIid: number,
    message: string,
    actorUuid?: string
  ) {
    super(message)
    this.name = 'ApprovalActionError'
    this.kind = kind
    this.projectId = projectId
    this.mrIid = mrIid
    this.actorUuid = actorUuid
  }
}
