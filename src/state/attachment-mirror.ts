import { type Collection, ObjectId } from 'mongodb'

/**
 * Persists the bi-directional attachment mirror mapping.
 *
 * Key: SHA-256 content hash of the original file (hex string).
 * Value: the mirrored URL on the target system.
 *
 * Two entries are written per mirrored file:
 *   origin='gitlab'  → records that a GitLab upload was copied to Huly
 *   origin='huly'    → records that a Huly attachment was copied to GitLab
 *
 * The unique index `attachment_mirror_hash_origin` enforces that each
 * (contentHash, origin) pair appears at most once.
 */
export interface AttachmentMirrorDoc {
  _id: ObjectId
  /**
   * Hex-encoded SHA-256 hash of the file bytes.
   * Used as the idempotency / dedupe key.
   */
  contentHash: string
  /** Which system originally hosted the file */
  origin: 'gitlab' | 'huly'
  /** URL on the target (mirror) system */
  targetUrl: string
  /** Original source URL — kept for debugging/auditability */
  sourceUrl: string
  createdAt: Date
}

export async function findMirroredAttachment (
  col: Collection<AttachmentMirrorDoc>,
  contentHash: string,
  origin: 'gitlab' | 'huly'
): Promise<AttachmentMirrorDoc | null> {
  return await col.findOne({ contentHash, origin })
}

export async function insertMirroredAttachment (
  col: Collection<AttachmentMirrorDoc>,
  contentHash: string,
  origin: 'gitlab' | 'huly',
  sourceUrl: string,
  targetUrl: string
): Promise<void> {
  try {
    await col.insertOne({
      _id: new ObjectId(),
      contentHash,
      origin,
      sourceUrl,
      targetUrl,
      createdAt: new Date()
    })
  } catch (err: unknown) {
    // Race: another process already inserted this hash+origin — ignore.
    if (isDuplicateKeyError(err)) return
    throw err
  }
}

function isDuplicateKeyError (err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code: unknown }).code === 11000
  }
  return false
}
