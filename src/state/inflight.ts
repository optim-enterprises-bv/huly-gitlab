import type { Collection } from 'mongodb'
import { ObjectId } from 'mongodb'

export interface InflightDoc {
  _id: ObjectId
  bindingId: string
  op: string
  payload: Record<string, unknown>
  startedAt: Date
}

export async function createInflight (
  col: Collection<InflightDoc>,
  bindingId: string,
  op: string,
  payload: Record<string, unknown>
): Promise<string> {
  const doc: InflightDoc = {
    _id: new ObjectId(),
    bindingId,
    op,
    payload,
    startedAt: new Date()
  }
  await col.insertOne(doc)
  return doc._id.toHexString()
}

export async function deleteInflight (
  col: Collection<InflightDoc>,
  id: string
): Promise<void> {
  await col.deleteOne({ _id: new ObjectId(id) })
}

export async function listInflight (
  col: Collection<InflightDoc>,
  bindingId?: string
): Promise<InflightDoc[]> {
  const query = bindingId !== undefined ? { bindingId } : {}
  return await col.find(query).toArray()
}
