import type { Request, Response, NextFunction, RequestHandler } from 'express'

/**
 * Factory that returns a middleware which rejects requests lacking a valid
 * `Authorization: Bearer <secret>` header with 401.
 */
export function requireBearer (secret: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization
    if (authHeader === undefined || authHeader === null || authHeader === '') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const token = authHeader.slice('Bearer '.length)
    if (token !== secret) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }
}
