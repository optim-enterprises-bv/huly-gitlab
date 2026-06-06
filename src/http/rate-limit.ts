import type { Request, Response, NextFunction } from 'express'

interface Bucket {
  tokens: number
  lastRefill: number
}

export interface RateLimitOptions {
  capacity?: number
  refillPerSecond?: number
  windowMs?: number
  keyExtractor?: (req: Request) => string
}

export function rateLimit (opts: RateLimitOptions = {}) {
  const capacity = opts.capacity ?? 10
  const refillPerSecond = opts.refillPerSecond ?? capacity / 60
  const keyExtractor = opts.keyExtractor ?? ((req) => req.ip ?? 'unknown')
  const buckets = new Map<string, Bucket>()

  const pruneInterval = setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000
    for (const [k, b] of buckets) if (b.lastRefill < cutoff) buckets.delete(k)
  }, 60 * 1000)
  pruneInterval.unref?.()

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyExtractor(req)
    const now = Date.now()
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { tokens: capacity, lastRefill: now }
      buckets.set(key, bucket)
    } else {
      const elapsedSec = (now - bucket.lastRefill) / 1000
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSecond)
      bucket.lastRefill = now
    }
    if (bucket.tokens < 1) {
      res.status(429).json({ error: 'rate limit exceeded', retryAfter: Math.ceil((1 - bucket.tokens) / refillPerSecond) })
      return
    }
    bucket.tokens -= 1
    next()
  }
}
