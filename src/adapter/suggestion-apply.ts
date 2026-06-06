import { GitLabApiError } from './errors'
import { withRateLimitRetry, type RateLimitHeaders } from './rate-limit'

export interface ApplySuggestionResult {
  applied: boolean
  commitSha?: string
}

/**
 * Apply a GitLab suggestion via the dedicated suggestions API.
 *
 * PUT /api/v4/suggestions/:suggestionId/apply
 *
 * The oauthToken MUST be the Huly user's OAuth bearer token so the resulting
 * commit is attributed to that user, not the service account.
 */
export async function applySuggestion (
  baseUrl: string,
  suggestionId: number,
  oauthToken: string
): Promise<ApplySuggestionResult> {
  if (typeof oauthToken !== 'string' || oauthToken.length === 0 ||
      oauthToken.length > 4096 || /[\r\n\0]/.test(oauthToken)) {
    throw new GitLabApiError('invalid oauth token for suggestion apply', 0)
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/v4/suggestions/${suggestionId}/apply`
  const headers: Record<string, string> = {
    'PRIVATE-TOKEN': oauthToken,
    'Content-Type': 'application/json'
  }

  interface RawApplySuggestionResponse {
    id?: number
    commit_id?: string
  }

  return await withRateLimitRetry(async () => {
    const res = await fetch(url, { method: 'PUT', headers })
    const rlHeaders: RateLimitHeaders = {
      'retry-after': res.headers.get('retry-after') ?? undefined,
      'ratelimit-remaining': res.headers.get('ratelimit-remaining') ?? undefined,
      'ratelimit-reset': res.headers.get('ratelimit-reset') ?? undefined
    }
    return {
      status: res.status,
      headers: rlHeaders,
      body: async () => {
        if (res.status === 401 || res.status === 403) {
          const text = await res.text()
          throw new GitLabApiError(`suggestion apply auth error ${res.status}: ${text}`, res.status, text)
        }
        if (res.status === 409) {
          const text = await res.text()
          throw new GitLabApiError(`suggestion conflict ${res.status}: ${text}`, res.status, text)
        }
        if (res.status >= 400) {
          const text = await res.text()
          throw new GitLabApiError(`suggestion apply error ${res.status}: ${text}`, res.status, text)
        }
        const data = await res.json() as RawApplySuggestionResponse
        return {
          applied: true,
          commitSha: typeof data.commit_id === 'string' ? data.commit_id : undefined
        }
      }
    }
  })
}
