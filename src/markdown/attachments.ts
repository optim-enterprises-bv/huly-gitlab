/**
 * Attachment URL rewriting for GFM ↔ Huly markdown conversion.
 *
 * Phase 1 limitation: only link-through is implemented. GitLab `/uploads/<hash>/file`
 * paths are absolutized to `${gitlabBaseUrl}/${projectPath}/uploads/<hash>/file`.
 * Huly `attachments://` references pass through unchanged.
 * No proxy, no upload sync — those are deferred to a later phase.
 */

export interface AttachmentBinding {
  gitlabBaseUrl: string
  projectPath: string
}

// Matches /uploads/... only when NOT preceded by a protocol-like pattern (i.e. relative paths only)
const UPLOADS_RELATIVE = /(?<![:/\w])\/uploads\/([^)\s"']+)/g
const UPLOADS_ABSOLUTE_RE = /https?:\/\/[^/]+\/[^/]+(?:\/[^/]+)*\/uploads\/([^)\s"']+)/

/**
 * Rewrite attachment URLs in a markdown string.
 *
 * In 'gfm-to-huly' mode:
 *   - Relative GitLab upload paths `/uploads/<hash>/file` are absolutized to
 *     `${gitlabBaseUrl}/${projectPath}/uploads/<hash>/file`.
 *   - Absolute GitLab upload URLs that already contain the full project path
 *     are left unchanged (they are already navigable).
 *   - `attachments://` Huly references pass through unchanged.
 *
 * In 'huly-to-gfm' mode:
 *   - `attachments://` references pass through unchanged (Phase 1; no upload sync).
 *   - Absolute GitLab upload URLs pass through unchanged.
 *
 * @param markdown - source markdown string
 * @param mode     - conversion direction
 * @param binding  - GitLab base URL and project path used for absolutization
 */
export function rewriteAttachmentUrls (
  markdown: string,
  mode: 'gfm-to-huly' | 'huly-to-gfm',
  binding: AttachmentBinding
): string {
  if (mode === 'gfm-to-huly') {
    // Absolutize relative /uploads/... paths
    return markdown.replace(UPLOADS_RELATIVE, (_match, rest: string) => {
      const base = binding.gitlabBaseUrl.replace(/\/$/, '')
      const project = binding.projectPath.replace(/^\//, '').replace(/\/$/, '')
      return `${base}/${project}/uploads/${rest}`
    })
  }

  // huly-to-gfm: pass through — no upload sync in Phase 1
  // attachments:// refs are not GitLab URLs and cannot be resolved here
  return markdown
}

/**
 * Returns true if the URL is a GitLab upload URL for the given project.
 */
export function isGitLabUploadUrl (url: string, binding: AttachmentBinding): boolean {
  return UPLOADS_ABSOLUTE_RE.test(url) && url.includes(binding.projectPath)
}
