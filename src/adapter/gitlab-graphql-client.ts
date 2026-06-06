import { GraphQLClient } from 'graphql-request'
import { validateGitLabBaseUrl } from '../util/url-validation'
import { increment, METRIC_NAMES } from '../metrics'

/**
 * Phase 5 P5-T-21 — GraphQL adapter for GitLab.
 *
 * Thin wrapper over `graphql-request` that:
 *   - Validates the GitLab base URL via the shared SSRF allowlist.
 *   - Sends queries to `/api/graphql` with bearer auth.
 *   - Exposes a per-baseUrl capability cache (`detectGraphQLCapability`)
 *     so callers can gate composite paths on GraphQL availability without
 *     re-probing on every call.
 *   - Differentiates transient (5xx/network) vs permanent (4xx) errors with
 *     different TTLs: positive=1h, permanent-negative=1h, transient-negative=5min.
 *   - Supports manual bust (`invalidateGraphQLCapability(baseUrl?)`) per critic
 *     bug B5: stale capability data must not route operators to a dead endpoint
 *     after a bind-time config change.
 */

interface CapabilityCacheEntry {
  available: boolean
  schemaVersion: string | null
  cachedAt: number
  ttlMs: number
}

export interface GraphQLCapabilities {
  graphqlAvailable: boolean
  schemaVersion: string | null
}

export interface GitLabGraphQLClientOptions {
  baseUrl: string
  token: string
}

export const CAPABILITY_POSITIVE_TTL_MS = 60 * 60 * 1000
export const CAPABILITY_NEGATIVE_TTL_MS = 5 * 60 * 1000

export class GitLabGraphQLClient {
  private readonly client: GraphQLClient
  readonly baseUrl: string

  constructor (opts: GitLabGraphQLClientOptions) {
    validateGitLabBaseUrl(opts.baseUrl)
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.client = new GraphQLClient(`${this.baseUrl}/api/graphql`, {
      headers: { Authorization: `Bearer ${opts.token}` }
    })
  }

  async query<T> (query: string, variables?: Record<string, unknown>): Promise<T> {
    return await this.client.request<T>(query, variables)
  }
}

// Per-baseUrl capability cache. The cache key is the normalized baseUrl;
// tokens are NOT part of the key because capability is an instance property
// (CE vs EE, GraphQL on/off), not a token property.
const capabilityCache = new Map<string, CapabilityCacheEntry>()

function normalizeBaseUrl (baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

function extractStatusCode (err: unknown): number | null {
  if (err != null && typeof err === 'object') {
    const e = err as Record<string, unknown>
    if (typeof e.status === 'number') return e.status
    if (typeof e.response === 'object' && e.response != null) {
      const r = e.response as Record<string, unknown>
      if (typeof r.status === 'number') return r.status
    }
  }
  return null
}

function isTransientError (err: unknown): boolean {
  const status = extractStatusCode(err)
  if (status !== null) {
    return status >= 500
  }
  // Network-level errors (ECONNREFUSED, ETIMEDOUT, etc.)
  if (err != null && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const code = typeof e.code === 'string' ? e.code : ''
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true
    const msg = typeof e.message === 'string' ? e.message : ''
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) return true
  }
  return false
}

function isAuthError (err: unknown): boolean {
  const status = extractStatusCode(err)
  return status === 401 || status === 403
}

/**
 * Probe the GitLab instance to determine if GraphQL is available.
 *
 * Error classification:
 *   - 401/403: auth/token issue — do NOT cache (operator will see auth metric).
 *   - 4xx (other): permanent negative — 1h TTL.
 *   - 5xx / network errors: transient — 5min TTL.
 *   - Parse failure on 200: permanent negative — 1h TTL.
 *   - Success: positive — 1h TTL.
 */
export async function detectGraphQLCapability (
  baseUrl: string,
  token: string,
  nowFn: () => number = () => Date.now()
): Promise<GraphQLCapabilities> {
  const key = normalizeBaseUrl(baseUrl)
  const cached = capabilityCache.get(key)
  if (cached !== undefined && nowFn() - cached.cachedAt < cached.ttlMs) {
    if (!cached.available) {
      increment(METRIC_NAMES.GRAPHQL_CAPABILITY_NEGATIVE_CACHE_HIT)
    }
    return { graphqlAvailable: cached.available, schemaVersion: cached.schemaVersion }
  }
  try {
    const client = new GitLabGraphQLClient({ baseUrl, token })
    await client.query('{ currentUser { id } }')
    const entry: CapabilityCacheEntry = {
      available: true,
      schemaVersion: null,
      cachedAt: nowFn(),
      ttlMs: CAPABILITY_POSITIVE_TTL_MS
    }
    capabilityCache.set(key, entry)
    return { graphqlAvailable: true, schemaVersion: null }
  } catch (err) {
    if (isAuthError(err)) {
      // Do not cache — auth issues should be retried immediately after token fix.
      return { graphqlAvailable: false, schemaVersion: null }
    }
    const ttlMs = isTransientError(err) ? CAPABILITY_NEGATIVE_TTL_MS : CAPABILITY_POSITIVE_TTL_MS
    const entry: CapabilityCacheEntry = {
      available: false,
      schemaVersion: null,
      cachedAt: nowFn(),
      ttlMs
    }
    capabilityCache.set(key, entry)
    return { graphqlAvailable: false, schemaVersion: null }
  }
}

/**
 * Invalidate the GraphQL capability cache.
 *   - `baseUrl` provided: invalidate that entry only (used by binding lifecycle
 *     on config change).
 *   - `baseUrl` undefined: invalidate ALL entries (used by the admin endpoint
 *     `POST /api/v1/admin/invalidate-graphql-cache`).
 */
export function invalidateGraphQLCapability (baseUrl?: string): void {
  if (baseUrl === undefined) {
    capabilityCache.clear()
  } else {
    capabilityCache.delete(normalizeBaseUrl(baseUrl))
  }
}

/** Exposed for tests + admin endpoint response payload. */
export function getGraphQLCapabilityCacheSize (): number {
  return capabilityCache.size
}
