import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Wraps an async Express handler so unhandled promise rejections forward to
 * the global error middleware via next(err) instead of crashing the process.
 */
export function asyncHandler (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}
