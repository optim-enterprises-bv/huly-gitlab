import { type Collection } from 'mongodb'

export type CursorKind = 'issues' | 'notes' | 'merge_requests' | 'pipelines' | 'reviews'

export interface CursorDoc {
  bindingId: string
  kind: CursorKind
  updatedAfter: Date
}

export async function getCursor (
  col: Collection<CursorDoc>,
  bindingId: string,
  kind: CursorKind
): Promise<Date | null> {
  const doc = await col.findOne({ bindingId, kind })
  return doc?.updatedAfter ?? null
}

export async function setCursor (
  col: Collection<CursorDoc>,
  bindingId: string,
  kind: CursorKind,
  updatedAfter: Date
): Promise<void> {
  await col.updateOne(
    { bindingId, kind },
    { $set: { bindingId, kind, updatedAfter } },
    { upsert: true }
  )
}

export async function deleteCursors (
  col: Collection<CursorDoc>,
  bindingId: string
): Promise<void> {
  await col.deleteMany({ bindingId })
}
