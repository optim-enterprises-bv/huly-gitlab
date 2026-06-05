export class ProjectNotFoundError extends Error {
  constructor (ref: string) {
    super(`Tracker project not found: ${ref}`)
    this.name = 'ProjectNotFoundError'
  }
}

export class IdentityError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'IdentityError'
  }
}
