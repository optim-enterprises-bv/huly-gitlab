import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Collection } from 'mongodb'
import { ObjectId } from 'mongodb'
import type { WorkspaceUuid, PersonUuid } from '@hcengineering/core'

export interface UserCredentialDoc {
  _id: ObjectId
  workspaceUuid: WorkspaceUuid
  hulyPersonUuid: PersonUuid
  gitlabBaseUrl: string
  username: string
  ciphertext: string
  iv: string
  tag: string
  expiresAt: Date | null
  refreshTokenCiphertext?: string
  refreshTokenIv?: string
  refreshTokenTag?: string
  createdAt: Date
  expired?: boolean
}

export interface PutUserCredentialInput {
  workspaceUuid: WorkspaceUuid
  hulyPersonUuid: PersonUuid
  gitlabBaseUrl: string
  username: string
  accessToken: string
  refreshToken?: string
  expiresAt?: Date | null
}

export interface RotateUserCredentialInput {
  accessToken: string
  refreshToken?: string
  expiresAt?: Date | null
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

export async function putUserCredential (
  collection: Collection<UserCredentialDoc>,
  encryptionKey: Buffer,
  input: PutUserCredentialInput
): Promise<{ credentialRef: string }> {
  const enc = encryptValue(input.accessToken, encryptionKey)
  const filter = {
    workspaceUuid: input.workspaceUuid,
    hulyPersonUuid: input.hulyPersonUuid,
    gitlabBaseUrl: input.gitlabBaseUrl
  }
  const update: Partial<UserCredentialDoc> & { createdAt?: Date } = {
    username: input.username,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    tag: enc.tag,
    expiresAt: input.expiresAt ?? null,
    createdAt: new Date()
  }
  if (input.refreshToken !== undefined) {
    const refreshEnc = encryptValue(input.refreshToken, encryptionKey)
    update.refreshTokenCiphertext = refreshEnc.ciphertext
    update.refreshTokenIv = refreshEnc.iv
    update.refreshTokenTag = refreshEnc.tag
  }
  const result = await collection.findOneAndUpdate(
    filter,
    { $set: update, $setOnInsert: { _id: new ObjectId() } },
    { upsert: true, returnDocument: 'after' }
  )
  const id = result?._id ?? new ObjectId()
  return { credentialRef: id.toHexString() }
}

export async function getUserCredential (
  collection: Collection<UserCredentialDoc>,
  encryptionKey: Buffer,
  workspaceUuid: WorkspaceUuid,
  hulyPersonUuid: PersonUuid,
  gitlabBaseUrl?: string
): Promise<{ token: string, expiresAt: Date | null, username: string, gitlabBaseUrl: string } | null> {
  const filter: Partial<UserCredentialDoc> = { workspaceUuid, hulyPersonUuid }
  if (gitlabBaseUrl !== undefined) {
    filter.gitlabBaseUrl = gitlabBaseUrl
  }
  const doc = await collection.findOne(filter)
  if (doc === null) {
    return null
  }
  const token = decryptValue({ ciphertext: doc.ciphertext, iv: doc.iv, tag: doc.tag }, encryptionKey)
  return { token, expiresAt: doc.expiresAt, username: doc.username, gitlabBaseUrl: doc.gitlabBaseUrl }
}

export async function deleteUserCredential (
  collection: Collection<UserCredentialDoc>,
  workspaceUuid: WorkspaceUuid,
  hulyPersonUuid: PersonUuid,
  gitlabBaseUrl: string
): Promise<boolean> {
  const result = await collection.deleteOne({ workspaceUuid, hulyPersonUuid, gitlabBaseUrl })
  return result.deletedCount === 1
}

export async function rotateUserCredential (
  collection: Collection<UserCredentialDoc>,
  encryptionKey: Buffer,
  workspaceUuid: WorkspaceUuid,
  hulyPersonUuid: PersonUuid,
  gitlabBaseUrl: string,
  input: RotateUserCredentialInput
): Promise<void> {
  const enc = encryptValue(input.accessToken, encryptionKey)
  const update: Partial<UserCredentialDoc> = {
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    tag: enc.tag
  }
  if (input.expiresAt !== undefined) {
    update.expiresAt = input.expiresAt
  }
  if (input.refreshToken !== undefined) {
    const refreshEnc = encryptValue(input.refreshToken, encryptionKey)
    update.refreshTokenCiphertext = refreshEnc.ciphertext
    update.refreshTokenIv = refreshEnc.iv
    update.refreshTokenTag = refreshEnc.tag
  }
  await collection.updateOne(
    { workspaceUuid, hulyPersonUuid, gitlabBaseUrl },
    { $set: update }
  )
}
