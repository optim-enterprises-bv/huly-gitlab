import { ObjectId } from 'mongodb'

const HEX24 = /^[0-9a-fA-F]{24}$/

/**
 * Parse a 24-hex string into a Mongo ObjectId.
 * Returns null on any invalid input — never throws.
 */
export function parseObjectId (raw: unknown): ObjectId | null {
  if (typeof raw !== 'string') return null
  if (!HEX24.test(raw)) return null
  try {
    return new ObjectId(raw)
  } catch {
    return null
  }
}
