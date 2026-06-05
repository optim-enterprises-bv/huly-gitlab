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
