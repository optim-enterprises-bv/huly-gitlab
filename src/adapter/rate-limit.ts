import { RateLimitError } from './errors'

const MAX_RETRIES = 5
const BASE_DELAY_MS = 500
const BACKOFF_FACTOR = 2
const MAX_DELAY_MS = 30_000

/**
 * Parse the Retry-After header value per RFC 7231.
 * Accepts both integer seconds ("2") and HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
 * Returns milliseconds to wait.
 */
export function parseRetryAfter (value: string): number {
  const asSeconds = parseInt(value, 10)
  if (!isNaN(asSeconds) && asSeconds.toString() === value.trim()) {
    return asSeconds * 1000
  }
  const date = new Date(value)
  if (!isNaN(date.getTime())) {
    const diff = date.getTime() - Date.now()
    return diff > 0 ? diff : 0
  }
  return BASE_DELAY_MS
}

function exponentialDelay (attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt)
  return Math.min(delay, MAX_DELAY_MS)
}

export interface RateLimitHeaders {
  'retry-after'?: string
  'ratelimit-remaining'?: string
  'ratelimit-reset'?: string
  'x-ratelimit-remaining'?: string
  'x-ratelimit-reset'?: string
}

/**
 * Extract wait duration from 429 response headers.
 * Prefers Retry-After; falls back to RateLimit-Reset (unix epoch seconds).
 */
export function extractWaitMs (headers: RateLimitHeaders): number {
  const retryAfter = headers['retry-after']
  if (retryAfter !== undefined && retryAfter !== '') {
    return parseRetryAfter(retryAfter)
  }

  const reset = headers['ratelimit-reset'] ?? headers['x-ratelimit-reset']
  if (reset !== undefined) {
    const resetEpoch = parseInt(reset, 10)
    if (!isNaN(resetEpoch)) {
      const diff = resetEpoch * 1000 - Date.now()
      return diff > 0 ? diff : 0
    }
  }

  return BASE_DELAY_MS
}

/**
 * Retry wrapper that honours rate-limit headers and applies exponential backoff.
 * Throws RateLimitError after MAX_RETRIES exhausted.
 */
export async function withRateLimitRetry<T> (
  fn: () => Promise<{ status: number, headers: RateLimitHeaders, body: () => Promise<T> }>,
  delayFn: (ms: number) => Promise<void> = async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)) }
): Promise<T> {
  let lastWaitMs = 0

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await fn()

    if (result.status !== 429) {
      return await result.body()
    }

    if (attempt === MAX_RETRIES) {
      throw new RateLimitError(
        `Rate limit exceeded after ${MAX_RETRIES} retries`,
        lastWaitMs
      )
    }

    const headerWait = extractWaitMs(result.headers)
    const backoffWait = exponentialDelay(attempt)
    lastWaitMs = Math.max(headerWait, backoffWait)

    await delayFn(lastWaitMs)
  }

  throw new RateLimitError('Rate limit exceeded', lastWaitMs)
}
