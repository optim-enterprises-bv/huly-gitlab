import { GraphQLClient } from 'graphql-request'
import { validateGitLabBaseUrl } from '../util/url-validation'

/**
 * Phase 5 P5-T-21 — GraphQL adapter for GitLab.
 *
 * Thin wrapper over `graphql-request` that:
 *   - Validates the GitLab base URL via the shared SSRF allowlist.
 *   - Sends queries to `/api/graphql` with bearer auth.
 *   - Exposes a per-baseUrl 1-hour capability cache (`detectGraphQLCapability`)
 *     so callers can gate composite paths on GraphQL availability without
 *     re-probing on every call.
 *   - Supports manual bust (`invalidateGraphQLCapability(baseUrl?)`) per critic
 *     bug B5: stale capability data must not route operators to a dead endpoint
 *     after a bind-time config change.
 */

interface CapabilityCacheEntry {
  graphqlSupported: boolean
  schemaVersion: string | null
  detectedAt: number
}

export interface GraphQLCapabilities {
  graphqlAvailable: boolean
  schemaVersion: string | null
}

export interface GitLabGraphQLClientOptions {
  baseUrl: string
  token: string
}

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

// Per-baseUrl capability cache (1-hour TTL). The cache key is the normalized
// baseUrl; tokens are NOT part of the key because capability is an instance
// property (CE vs EE, GraphQL on/off), not a token property.
const capabilityCache = new Map<string, CapabilityCacheEntry>()
const CAPABILITY_TTL_MS = 60 * 60 * 1000

function normalizeBaseUrl (baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

/**
 * Probe the GitLab instance to determine if GraphQL is available.
 * Result is cached per-baseUrl for 1 hour. On any error (network, 4xx, 5xx)
 * returns `{ graphqlAvailable: false }` and caches the negative result so a
 * dead endpoint is not re-probed every call.
 */
export async function detectGraphQLCapability (
  baseUrl: string,
  token: string,
  nowFn: () => number = () => Date.now()
): Promise<GraphQLCapabilities> {
  const key = normalizeBaseUrl(baseUrl)
  const cached = capabilityCache.get(key)
  if (cached !== undefined && nowFn() - cached.detectedAt < CAPABILITY_TTL_MS) {
    return { graphqlAvailable: cached.graphqlSupported, schemaVersion: cached.schemaVersion }
  }
  try {
    const client = new GitLabGraphQLClient({ baseUrl, token })
    await client.query('{ currentUser { id } }')
    const entry: CapabilityCacheEntry = { graphqlSupported: true, schemaVersion: null, detectedAt: nowFn() }
    capabilityCache.set(key, entry)
    return { graphqlAvailable: true, schemaVersion: null }
  } catch {
    const entry: CapabilityCacheEntry = { graphqlSupported: false, schemaVersion: null, detectedAt: nowFn() }
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
