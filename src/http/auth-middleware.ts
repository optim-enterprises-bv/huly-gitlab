import { timingSafeEqual } from 'node:crypto'
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
    const a = Buffer.from(token)
    const b = Buffer.from(secret)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'Unauthorized' }); return
    }
    next()
  }
}
