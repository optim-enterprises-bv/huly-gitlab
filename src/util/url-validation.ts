import { isIP } from 'node:net'

/**
 * Validate a GitLab base URL against an allowlist (env GITLAB_ALLOWED_HOSTS, csv).
 * Default allowlist is `gitlab.com` if unset. NOT empty = allow-all.
 *
 * Rejects:
 *  - non-http(s) schemes
 *  - URLs containing user-info (credentials)
 *  - hostnames not in the allowlist
 *  - private/link-local IP literals (IPv4 / IPv6)
 *
 * DNS resolution + rebinding protection is out of scope for Phase 1.
 */
export function validateGitLabBaseUrl (raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid gitlabBaseUrl: ${raw}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`gitlabBaseUrl must use http or https: ${raw}`)
  }

  if (url.username !== '' || url.password !== '') {
    throw new Error('gitlabBaseUrl must not contain user-info credentials')
  }

  const host = url.hostname

  const ipVersion = isIP(host)
  if (ipVersion !== 0 && isPrivateIp(host, ipVersion)) {
    throw new Error(`gitlabBaseUrl resolves to a private/link-local IP: ${host}`)
  }

  const allowedRaw = process.env.GITLAB_ALLOWED_HOSTS
  const allowed = allowedRaw !== undefined && allowedRaw.length > 0
    ? allowedRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : ['gitlab.com']

  const hostLower = host.toLowerCase()
  const match = allowed.some((entry) => {
    const e = entry.toLowerCase()
    if (e === '*') return true
    if (e === hostLower) return true
    // Allow subdomain match when entry begins with '.'
    if (e.startsWith('.') && hostLower.endsWith(e)) return true
    return false
  })

  if (!match) {
    throw new Error(`gitlabBaseUrl host not in allowlist: ${host}`)
  }

  return url
}

function isPrivateIp (ip: string, version: number): boolean {
  if (version === 4) return isPrivateIpv4(ip)
  if (version === 6) return isPrivateIpv6(ip)
  return false
}

function isPrivateIpv4 (ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

function isPrivateIpv6 (ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  if (lower === '::') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
  if (lower.startsWith('fe80:')) return true // link-local
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length)
    if (isIP(v4) === 4) return isPrivateIpv4(v4)
  }
  return false
}
