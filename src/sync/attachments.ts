/**
 * Bi-directional attachment mirror for issue/MR/note body content.
 *
 * GitLab → Huly:
 *   Download from GitLab upload URL, upload to Huly attachment store,
 *   persist mapping in `attachment_mirror` collection.
 *
 * Huly → GitLab:
 *   Download from Huly attachment store, POST to GitLab project uploads,
 *   persist mapping in `attachment_mirror` collection.
 *
 * Idempotency: content hash (SHA-256) is the dedupe key. If a mapping
 * already exists for a given hash + origin, the existing targetUrl is
 * returned without re-uploading.
 *
 * Failure mode: any error in mirror functions is caught by the caller in
 * notes.ts / issues.ts. On failure the caller falls back to link-through
 * and increments the `ATTACHMENT_MIRROR_FAILED` metric.
 *
 * Huly attachment store:
 *   No upload API was found in the existing codebase. The `HulyAttachmentStore`
 *   interface below defines the required contract. The `stubHulyAttachmentStore`
 *   export satisfies the interface but throws at runtime — wire it to the real
 *   platform attachment service when the API is available.
 *   TODO: wire to platform attachment service
 */

import { createHash } from 'node:crypto'
import type { Collection } from 'mongodb'
import type { Logger } from '../logging'
import type { AttachmentMirrorDoc } from '../state/attachment-mirror'
import { findMirroredAttachment, insertMirroredAttachment } from '../state/attachment-mirror'
import { MAX_ATTACHMENT_BYTES } from './attachment-links'

export { MAX_ATTACHMENT_BYTES } from './attachment-links'

// ---------------------------------------------------------------------------
// Huly attachment store interface (integration point)
// ---------------------------------------------------------------------------

/**
 * Contract for reading/writing files to the Huly platform attachment store.
 *
 * TODO: wire to platform attachment service — no upload API was found in the
 * existing codebase. Replace `stubHulyAttachmentStore` with a real implementation
 * once the platform API is available.
 */
export interface HulyAttachmentStore {
  /** Upload bytes to the Huly attachment store; returns a stable {ref, url}. */
  upload: (filename: string, bytes: Buffer) => Promise<{ ref: string, url: string }>
  /** Download bytes for a Huly attachment ref/url. */
  download: (refOrUrl: string) => Promise<Buffer>
}

/**
 * Stub implementation — throws at runtime with a clear TODO message.
 * Replace this with the real Huly attachment service client.
 */
export const stubHulyAttachmentStore: HulyAttachmentStore = {
  upload: async (_filename: string, _bytes: Buffer) => {
    throw new Error('TODO: wire to platform attachment service')
  },
  download: async (_refOrUrl: string) => {
    throw new Error('TODO: wire to platform attachment service')
  }
}

// ---------------------------------------------------------------------------
// GitLab upload client surface used by mirror functions
// ---------------------------------------------------------------------------

export interface AttachmentGitLabClient {
  downloadUpload: (url: string) => Promise<Buffer | null>
  uploadFile: (
    projectId: number | string,
    filename: string,
    bytes: Buffer
  ) => Promise<{ url: string, alt: string, markdown: string }>
}

// ---------------------------------------------------------------------------
// Mirror deps
// ---------------------------------------------------------------------------

export interface MirrorDeps {
  gitlabClient: AttachmentGitLabClient
  hulyStore: HulyAttachmentStore
  mirrorCol: Collection<AttachmentMirrorDoc>
  logger: Logger
}

// ---------------------------------------------------------------------------
// GitLab → Huly
// ---------------------------------------------------------------------------

/**
 * Mirror a single GitLab upload link into the Huly attachment store.
 *
 * Returns the Huly URL to substitute in place of the original GitLab URL,
 * or null on any error (caller should fall back to link-through).
 *
 * @param deps        - injected clients and collection
 * @param sourceUrl   - absolute GitLab upload URL
 * @param filename    - filename hint used when uploading to Huly
 * @param projectId   - GitLab project ID (unused here; kept for symmetry)
 */
export async function mirrorGitlabUploadToHuly (
  deps: MirrorDeps,
  sourceUrl: string,
  filename: string,
  _projectId?: number | string
): Promise<string | null> {
  try {
    const bytes = await deps.gitlabClient.downloadUpload(sourceUrl)
    if (bytes === null) {
      deps.logger.warn('attachment.mirror: GitLab upload not found', { sourceUrl })
      return null
    }

    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      deps.logger.warn('attachment.mirror: file exceeds size limit — using link-through', {
        sourceUrl,
        bytes: bytes.byteLength,
        limit: MAX_ATTACHMENT_BYTES
      })
      return null
    }

    const contentHash = sha256(bytes)

    const existing = await findMirroredAttachment(deps.mirrorCol, contentHash, 'gitlab')
    if (existing !== null) {
      return existing.targetUrl
    }

    const { url: targetUrl } = await deps.hulyStore.upload(filename, bytes)

    await insertMirroredAttachment(deps.mirrorCol, contentHash, 'gitlab', sourceUrl, targetUrl)

    return targetUrl
  } catch (err) {
    deps.logger.warn('attachment.mirror: GitLab→Huly mirror failed', {
      sourceUrl,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Huly → GitLab
// ---------------------------------------------------------------------------

/**
 * Mirror a single Huly attachment link into GitLab project uploads.
 *
 * Returns the GitLab upload URL to substitute, or null on error
 * (caller falls back to link-through).
 *
 * @param deps      - injected clients and collection
 * @param sourceUrl - Huly attachment URL / ref
 * @param filename  - filename to use when posting to GitLab
 * @param projectId - GitLab project ID for POST /api/v4/projects/:id/uploads
 */
export async function mirrorHulyAttachmentToGitlab (
  deps: MirrorDeps,
  sourceUrl: string,
  filename: string,
  projectId: number | string
): Promise<string | null> {
  try {
    const bytes = await deps.hulyStore.download(sourceUrl)

    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      deps.logger.warn('attachment.mirror: file exceeds size limit — using link-through', {
        sourceUrl,
        bytes: bytes.byteLength,
        limit: MAX_ATTACHMENT_BYTES
      })
      return null
    }

    const contentHash = sha256(bytes)

    const existing = await findMirroredAttachment(deps.mirrorCol, contentHash, 'huly')
    if (existing !== null) {
      return existing.targetUrl
    }

    const { url: targetUrl } = await deps.gitlabClient.uploadFile(projectId, filename, bytes)

    await insertMirroredAttachment(deps.mirrorCol, contentHash, 'huly', sourceUrl, targetUrl)

    return targetUrl
  } catch (err) {
    deps.logger.warn('attachment.mirror: Huly→GitLab mirror failed', {
      sourceUrl,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Body-level mirror: process an entire markdown body
// ---------------------------------------------------------------------------

/**
 * Process a markdown body arriving from GitLab: mirror each GitLab upload link
 * into Huly and rewrite the body.
 *
 * Falls back to link-through for any individual link that fails to mirror.
 * Increments `ATTACHMENT_MIRROR_FAILED` metric (via logger warn) per failure.
 *
 * @returns rewritten body (may be identical to input if no GitLab links found
 *          or all mirrors failed)
 */
export async function mirrorBodyGitlabToHuly (
  deps: MirrorDeps,
  body: string,
  gitlabBaseUrl: string,
  projectPath: string
): Promise<string> {
  const { extractAttachmentLinks, rewriteAttachmentLinks, resolveGitLabUploadUrl } = await import('./attachment-links')

  const links = extractAttachmentLinks(body, gitlabBaseUrl).filter((l) => l.origin === 'gitlab')
  if (links.length === 0) return body

  const mappings: Array<{ sourceUrl: string, targetUrl: string }> = []

  for (const link of links) {
    const absoluteUrl = resolveGitLabUploadUrl(link.sourceUrl, gitlabBaseUrl, projectPath)
    const targetUrl = await mirrorGitlabUploadToHuly(deps, absoluteUrl, link.filename)
    if (targetUrl !== null) {
      mappings.push({ sourceUrl: link.sourceUrl, targetUrl })
    }
  }

  return rewriteAttachmentLinks(body, mappings)
}

/**
 * Process a markdown body going to GitLab: mirror each Huly attachment link
 * into GitLab uploads and rewrite the body.
 *
 * Falls back to link-through for any individual link that fails to mirror.
 *
 * @returns rewritten body
 */
export async function mirrorBodyHulyToGitlab (
  deps: MirrorDeps,
  body: string,
  projectId: number | string
): Promise<string> {
  const { extractAttachmentLinks, rewriteAttachmentLinks } = await import('./attachment-links')

  const links = extractAttachmentLinks(body).filter((l) => l.origin === 'huly')
  if (links.length === 0) return body

  const mappings: Array<{ sourceUrl: string, targetUrl: string }> = []

  for (const link of links) {
    const targetUrl = await mirrorHulyAttachmentToGitlab(deps, link.sourceUrl, link.filename, projectId)
    if (targetUrl !== null) {
      mappings.push({ sourceUrl: link.sourceUrl, targetUrl })
    }
  }

  return rewriteAttachmentLinks(body, mappings)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256 (buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
