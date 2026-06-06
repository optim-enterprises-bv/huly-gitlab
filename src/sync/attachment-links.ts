/**
 * Parser and rewriter for attachment links in markdown bodies.
 *
 * Handles both GitLab upload links (`/uploads/<hash>/<filename>` or absolute
 * `https://gitlab.example/.../uploads/...`) and Huly attachment references
 * (`attachments://<ref>`).
 *
 * All functions are pure — no I/O.
 */

export interface AttachmentLink {
  /** Index within `extractedLinks` array — used to correlate with rewrites */
  markdownIndex: number
  /** Original URL as it appears in the source markdown */
  sourceUrl: string
  /** Alt text / link text */
  alt: string
  /** Filename extracted from the URL */
  filename: string
  /** 'image' for `![alt](url)` syntax, 'link' for `[text](url)` */
  kind: 'image' | 'link'
  /** Which system the link originates from */
  origin: 'gitlab' | 'huly'
}

export interface AttachmentMapping {
  sourceUrl: string
  targetUrl: string
}

/** Max attachment bytes we will mirror. Files beyond this are left as link-through. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MB

// Matches `![alt](url)` and `[text](url)` — captures alt/text and url.
// Non-greedy URL match stops at the first `)` not preceded by a backslash.
const MARKDOWN_LINK_RE = /(!?)\[([^\]]*)\]\(([^)]+)\)/g

// Detects a GitLab upload URL — either relative `/uploads/...` or absolute.
const GITLAB_UPLOAD_PATH_RE = /^\/uploads\//
const GITLAB_UPLOAD_ABSOLUTE_RE = /\/uploads\/[a-f0-9]+\//i
const HULY_ATTACHMENT_RE = /^attachments:\/\//

/**
 * Extract all attachment links from a markdown body string.
 *
 * Only links that point to GitLab uploads or Huly attachments are returned.
 * Plain web URLs, anchor links, and other references are skipped.
 *
 * @param body     - markdown source
 * @param baseUrl  - GitLab base URL used to determine whether an absolute URL
 *                   belongs to the connected GitLab instance (optional filter)
 */
export function extractAttachmentLinks (
  body: string,
  baseUrl?: string
): AttachmentLink[] {
  const results: AttachmentLink[] = []
  let markdownIndex = 0
  let match: RegExpExecArray | null

  const re = new RegExp(MARKDOWN_LINK_RE.source, 'g')

  while ((match = re.exec(body)) !== null) {
    const isImage = match[1] === '!'
    const alt = match[2]
    const url = match[3].trim()

    const isGitLabRelative = GITLAB_UPLOAD_PATH_RE.test(url)
    const isGitLabAbsolute =
      GITLAB_UPLOAD_ABSOLUTE_RE.test(url) &&
      (baseUrl === undefined || url.startsWith(baseUrl.replace(/\/$/, '')))
    const isHuly = HULY_ATTACHMENT_RE.test(url)

    if (!isGitLabRelative && !isGitLabAbsolute && !isHuly) {
      markdownIndex++
      continue
    }

    const filename = extractFilename(url)
    const origin: 'gitlab' | 'huly' = isHuly ? 'huly' : 'gitlab'

    results.push({
      markdownIndex,
      sourceUrl: url,
      alt,
      filename,
      kind: isImage ? 'image' : 'link',
      origin
    })

    markdownIndex++
  }

  return results
}

/**
 * Rewrite attachment links in a markdown body using the provided URL mapping.
 * Mappings that have no entry for a given sourceUrl are left unchanged (fallback).
 *
 * Idempotent: if the body already contains the target URL, the mapping is a
 * no-op (sourceUrl === targetUrl produces the same markdown).
 *
 * @param body     - original markdown source
 * @param mappings - list of {sourceUrl, targetUrl} replacements
 */
export function rewriteAttachmentLinks (
  body: string,
  mappings: AttachmentMapping[]
): string {
  if (mappings.length === 0) return body

  const urlMap = new Map<string, string>()
  for (const m of mappings) {
    if (m.sourceUrl !== m.targetUrl) {
      urlMap.set(m.sourceUrl, m.targetUrl)
    }
  }

  if (urlMap.size === 0) return body

  // Replace URLs inside markdown link/image syntax only.
  return body.replace(MARKDOWN_LINK_RE, (fullMatch, bang, alt, url) => {
    const trimmedUrl = url.trim()
    const replacement = urlMap.get(trimmedUrl)
    if (replacement === undefined) return fullMatch
    return `${bang as string}[${alt as string}](${replacement})`
  })
}

/**
 * Resolve a relative GitLab upload path to an absolute URL.
 * `/uploads/<hash>/file.png` → `https://gitlab.example/group/proj/uploads/<hash>/file.png`
 */
export function resolveGitLabUploadUrl (
  relativeOrAbsolute: string,
  gitlabBaseUrl: string,
  projectPath: string
): string {
  if (!relativeOrAbsolute.startsWith('/uploads/')) {
    return relativeOrAbsolute
  }
  const base = gitlabBaseUrl.replace(/\/$/, '')
  const project = projectPath.replace(/^\//, '').replace(/\/$/, '')
  const rest = relativeOrAbsolute.replace(/^\/uploads\//, '')
  return `${base}/${project}/uploads/${rest}`
}

function extractFilename (url: string): string {
  try {
    // Works for both absolute URLs and relative paths
    const decoded = decodeURIComponent(url)
    const parts = decoded.split('/')
    const last = parts[parts.length - 1]
    // Strip any query string
    return last.split('?')[0] ?? last
  } catch {
    const parts = url.split('/')
    return parts[parts.length - 1] ?? url
  }
}
