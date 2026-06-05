import crypto from 'crypto'
import type { GitLabClient } from './gitlab-client'
import type { Capabilities } from './types'

const TTL_MS = 60 * 60 * 1000 // 1 hour

interface CacheEntry {
  capabilities: Capabilities
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function cacheKey (baseUrl: string, token: string): string {
  return crypto
    .createHash('sha256')
    .update(`${baseUrl}:${token}`)
    .digest('hex')
}

function parseEdition (revision: string): 'ce' | 'ee' {
  // EE instances return revision strings containing 'ee' (case-insensitive)
  if (/ee/i.test(revision)) {
    return 'ee'
  }
  return 'ce'
}

const GRAPHQL_INTROSPECTION_PING = '{ __schema { queryType { name } } }'

/**
 * Detect capabilities of the connected GitLab instance.
 * Calls GET /api/v4/version to determine version and edition.
 * Runs a minimal GraphQL introspection ping to test graphqlAvailable.
 * Result is cached for 1 hour keyed by baseUrl+token hash.
 */
export async function detectCapabilities (
  client: GitLabClient,
  nowFn: () => number = () => Date.now()
): Promise<Capabilities> {
  const opts = (client as unknown as { baseUrl: string, token: string })
  const key = cacheKey(opts.baseUrl, opts.token)

  const cached = cache.get(key)
  if (cached !== undefined && nowFn() < cached.expiresAt) {
    return cached.capabilities
  }

  const versionData = await client.getVersion()
  const edition = parseEdition(versionData.revision)

  let graphqlAvailable = false
  try {
    await client.graphql<unknown>(GRAPHQL_INTROSPECTION_PING)
    graphqlAvailable = true
  } catch {
    graphqlAvailable = false
  }

  const capabilities: Capabilities = {
    gitlabVersion: versionData.version,
    edition,
    graphqlAvailable,
    featureFlags: {
      'graphql.issue.notes': graphqlAvailable,
      'graphql.issue.batchedNotes': graphqlAvailable
    }
  }

  client.capabilities = capabilities

  cache.set(key, {
    capabilities,
    expiresAt: nowFn() + TTL_MS
  })

  return capabilities
}

/** Exposed for testing: clear the capability cache */
export function clearCapabilityCache (): void {
  cache.clear()
}
