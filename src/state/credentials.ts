import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Collection } from 'mongodb'
import { ObjectId } from 'mongodb'

export type CredentialKind = 'oauth' | 'access_token' | 'webhook_secret'

export interface CredentialDoc {
  _id: ObjectId
  kind: CredentialKind
  ciphertext: string
  iv: string
  tag: string
  createdAt: Date
  expiresAt?: Date
  refreshTokenCiphertext?: string
  refreshTokenIv?: string
  refreshTokenTag?: string
  /** Base URL of the GitLab instance that issued this credential (oauth/access_token only) */
  gitlabBaseUrl?: string
  /** UUID of the Huly workspace this credential belongs to */
  workspaceUuid?: string
  /** Set to true when a refresh attempt fails permanently */
  expired?: boolean
}

export interface CredentialResult {
  plaintext: string
  kind: CredentialKind
  expiresAt?: Date
  refreshTokenPlaintext?: string
}

const ALGORITHM = 'aes-256-gcm'

interface Encrypted {
  ciphertext: string
  iv: string
  tag: string
}

function encryptValue (plaintext: string, key: Buffer): Encrypted {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertextBuf = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: ciphertextBuf.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  }
}

function decryptValue (enc: Encrypted, key: Buffer): string {
  const iv = Buffer.from(enc.iv, 'base64')
  const tag = Buffer.from(enc.tag, 'base64')
  const ciphertextBuf = Buffer.from(enc.ciphertext, 'base64')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const plaintextBuf = Buffer.concat([decipher.update(ciphertextBuf), decipher.final()])
  return plaintextBuf.toString('utf8')
}

export interface PutCredentialInput {
  kind: CredentialKind
  plaintext: string
  expiresAt?: Date
  refreshTokenPlaintext?: string
  gitlabBaseUrl?: string
  workspaceUuid?: string
}

export async function putCredential (
  col: Collection<CredentialDoc>,
  key: Buffer,
  input: PutCredentialInput
): Promise<string> {
  const enc = encryptValue(input.plaintext, key)
  const doc: CredentialDoc = {
    _id: new ObjectId(),
    kind: input.kind,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    tag: enc.tag,
    createdAt: new Date()
  }
  if (input.expiresAt !== undefined) {
    doc.expiresAt = input.expiresAt
  }
  if (input.gitlabBaseUrl !== undefined) {
    doc.gitlabBaseUrl = input.gitlabBaseUrl
  }
  if (input.workspaceUuid !== undefined) {
    doc.workspaceUuid = input.workspaceUuid
  }
  if (input.refreshTokenPlaintext !== undefined) {
    const refreshEnc = encryptValue(input.refreshTokenPlaintext, key)
    doc.refreshTokenCiphertext = refreshEnc.ciphertext
    doc.refreshTokenIv = refreshEnc.iv
    doc.refreshTokenTag = refreshEnc.tag
  }
  await col.insertOne(doc)
  return doc._id.toHexString()
}

export async function getCredential (
  col: Collection<CredentialDoc>,
  key: Buffer,
  id: string
): Promise<CredentialResult | null> {
  const doc = await col.findOne({ _id: new ObjectId(id) })
  if (doc === null) {
    return null
  }
  const plaintext = decryptValue({ ciphertext: doc.ciphertext, iv: doc.iv, tag: doc.tag }, key)
  const result: CredentialResult = {
    plaintext,
    kind: doc.kind
  }
  if (doc.expiresAt !== undefined) {
    result.expiresAt = doc.expiresAt
  }
  if (
    doc.refreshTokenCiphertext !== undefined &&
    doc.refreshTokenIv !== undefined &&
    doc.refreshTokenTag !== undefined
  ) {
    result.refreshTokenPlaintext = decryptValue(
      { ciphertext: doc.refreshTokenCiphertext, iv: doc.refreshTokenIv, tag: doc.refreshTokenTag },
      key
    )
  }
  return result
}

export async function deleteCredential (
  col: Collection<CredentialDoc>,
  id: string
): Promise<void> {
  await col.deleteOne({ _id: new ObjectId(id) })
}

export interface RotateCredentialInput {
  plaintext: string
  refreshTokenPlaintext?: string
  expiresAt?: Date
}

export async function rotateCredential (
  col: Collection<CredentialDoc>,
  key: Buffer,
  id: string,
  input: RotateCredentialInput | string
): Promise<void> {
  const newPlaintext = typeof input === 'string' ? input : input.plaintext
  const enc = encryptValue(newPlaintext, key)
  const update: Partial<CredentialDoc> = { ciphertext: enc.ciphertext, iv: enc.iv, tag: enc.tag }
  if (typeof input !== 'string') {
    if (input.expiresAt !== undefined) {
      update.expiresAt = input.expiresAt
    }
    if (input.refreshTokenPlaintext !== undefined) {
      const refreshEnc = encryptValue(input.refreshTokenPlaintext, key)
      update.refreshTokenCiphertext = refreshEnc.ciphertext
      update.refreshTokenIv = refreshEnc.iv
      update.refreshTokenTag = refreshEnc.tag
    }
  }
  await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: update }
  )
}
