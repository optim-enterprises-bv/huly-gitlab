import { type Collection, ObjectId } from 'mongodb'

export interface DedupDoc {
  _id: ObjectId
  bindingId: string
  eventId: string
  version: string
  createdAt: Date
}

/**
 * Returns true if the event was already seen (duplicate).
 * Returns false and inserts the record if it is new.
 */
export async function checkAndMarkSeen (
  col: Collection<DedupDoc>,
  bindingId: string,
  eventId: string,
  version: string
): Promise<boolean> {
  const existing = await col.findOne({ bindingId, eventId, version })
  if (existing !== null) {
    return true
  }
  try {
    await col.insertOne({
      _id: new ObjectId(),
      bindingId,
      eventId,
      version,
      createdAt: new Date()
    })
    return false
  } catch (err: unknown) {
    // Duplicate key — another process raced and inserted first
    if (isDuplicateKeyError(err)) {
      return true
    }
    throw err
  }
}

function isDuplicateKeyError (err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code: unknown }).code === 11000
  }
  return false
}
