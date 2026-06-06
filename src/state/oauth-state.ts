import type { ObjectId } from 'mongodb'

export interface OAuthStateDoc {
  _id: ObjectId
  state: string
  statePayload: string
  nonce: string
  codeVerifier: string
  workspaceUuid: string
  hulyProjectRef: string
  gitlabBaseUrl: string
  expiresAt: Date
}
