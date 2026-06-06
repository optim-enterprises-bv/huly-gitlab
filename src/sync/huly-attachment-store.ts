/**
 * Real HulyAttachmentStore implementation backed by the Huly platform TxOperations client.
 *
 * API used: TxOperations.createDoc / findOne — the only doc-level write+read API
 * available in the installed @hcengineering packages (0.7.423).
 * No `@hcengineering/attachment`, `@hcengineering/storage`, or blob-upload API
 * was found in the installed package set. File bytes are stored base64-encoded
 * inside a synthetic `gitlab:class:AttachmentBlob` doc (a lightweight `AttachedDoc`
 * carrier). The ref is the Huly doc `_id`; the url is the `attachments://<_id>` scheme.
 *
 * Fallback: if `client.createDoc` throws (e.g. not connected, schema mismatch),
 * the error propagates to `mirrorGitlabUploadToHuly` which catches it, logs a warn,
 * and falls back to link-through. Startup is NOT blocked.
 *
 * Idempotency is handled one level up in `mirrorGitlabUploadToHuly` / `mirrorHulyAttachmentToGitlab`
 * via the `attachment_mirror` collection SHA-256 dedupe — this store does not
 * need to dedupe itself.
 */

import type { Doc, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Logger } from '../logging'
import type { HulyAttachmentStore } from './attachments'
import { MAX_ATTACHMENT_BYTES } from './attachment-links'

// The class identifier used for synthetic attachment blob docs.
// This string is intentionally NOT pulled from a typed constant because the
// @hcengineering/attachment package is not in the dependency set (0.7.423).
const ATTACHMENT_BLOB_CLASS = 'gitlab:class:AttachmentBlob' as Ref<never>

// Sentinel space: attachment blobs are not workspace-project scoped;
// we park them under a well-known space ref. If the Huly platform enforces
// space ACL, operators can configure the space ref via deps.
const ATTACHMENT_SPACE_DEFAULT = 'gitlab:space:Attachments' as Ref<Space>

export interface HulyAttachmentStoreDeps {
  client: TxOperations
  logger: Logger
  workspaceUuid: WorkspaceUuid
  /** Override the space ref used when creating blob docs (optional). */
  spaceRef?: Ref<Space>
}

/**
 * Shape of the synthetic attachment blob document stored in Huly.
 * Extends Doc so it can be used with TxOperations.createDoc / findOne.
 */
interface AttachmentBlobDoc extends Doc {
  filename: string
  /** MIME / content-type hint (unused for now, present for future consumers). */
  mimeType: string
  /** Base64-encoded file bytes. */
  data: string
  /** Byte length before encoding. */
  size: number
  createdAt: number
}

/**
 * Validate a filename: reject path traversal, null bytes, or empty strings.
 * Throws with a descriptive message if invalid.
 */
export function validateFilename (filename: string): void {
  if (filename.length === 0) {
    throw new Error('attachment: filename must not be empty')
  }
  if (filename.includes('/') || filename.includes('\\')) {
    throw new Error(`attachment: filename must not contain path separators: ${filename}`)
  }
  if (filename.includes('\0')) {
    throw new Error(`attachment: filename must not contain null bytes: ${filename}`)
  }
}

/**
 * Create a real HulyAttachmentStore backed by TxOperations.
 *
 * upload: validates filename and size, base64-encodes bytes, calls
 *         client.createDoc to persist, returns {ref, url}.
 *
 * download: looks up the doc by ref (_id), decodes base64, returns Buffer.
 *
 * Graceful degradation: if either call throws, mirrorGitlabUploadToHuly /
 * mirrorHulyAttachmentToGitlab catch the error, log a warning, and fall back
 * to link-through. Startup is never blocked.
 */
export function createHulyAttachmentStore (deps: HulyAttachmentStoreDeps): HulyAttachmentStore {
  const { client, logger, workspaceUuid } = deps
  const spaceRef = deps.spaceRef ?? ATTACHMENT_SPACE_DEFAULT

  return {
    async upload (filename: string, bytes: Buffer): Promise<{ ref: string, url: string }> {
      validateFilename(filename)

      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `attachment: file exceeds ${MAX_ATTACHMENT_BYTES} byte limit (${bytes.byteLength} bytes): ${filename}`
        )
      }

      const data = bytes.toString('base64')
      const now = Date.now()

      logger.debug('huly-attachment-store: uploading', {
        filename,
        size: bytes.byteLength,
        workspaceUuid
      })

      const docRef = await client.createDoc<AttachmentBlobDoc>(
        ATTACHMENT_BLOB_CLASS as Ref<never>,
        spaceRef,
        {
          filename,
          mimeType: guessMimeType(filename),
          data,
          size: bytes.byteLength,
          createdAt: now
        }
      )

      const ref = String(docRef)
      const url = `attachments://${ref}`

      logger.debug('huly-attachment-store: uploaded', { ref, filename, size: bytes.byteLength })

      return { ref, url }
    },

    async download (refOrUrl: string): Promise<Buffer> {
      const ref = refOrUrl.startsWith('attachments://')
        ? refOrUrl.slice('attachments://'.length)
        : refOrUrl

      logger.debug('huly-attachment-store: downloading', { ref, workspaceUuid })

      const doc = await client.findOne<AttachmentBlobDoc>(
        ATTACHMENT_BLOB_CLASS as Ref<never>,
        { _id: ref as Ref<AttachmentBlobDoc> }
      )

      if (doc === undefined) {
        throw new Error(`attachment: doc not found for ref: ${ref}`)
      }

      const bytes = Buffer.from(doc.data, 'base64')
      logger.debug('huly-attachment-store: downloaded', { ref, size: bytes.byteLength })
      return bytes
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guessMimeType (filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar'
  }
  return map[ext] ?? 'application/octet-stream'
}
