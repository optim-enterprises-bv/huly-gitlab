import { MongoClient, type Db, type Collection } from 'mongodb'
import type { BindingDoc } from './bindings'
import type { CursorDoc } from './cursors'
import type { IdMapDoc } from './idmap'
import type { DedupDoc } from './dedup'
import type { InflightDoc } from './inflight'
import type { CredentialDoc } from './credentials'
import type { OAuthStateDoc } from './oauth-state'
import type { UserCredentialDoc } from './user-credentials'
import type { AttachmentMirrorDoc } from './attachment-mirror'

export interface DismissedSuggestionDoc {
  workspaceUuid: string
  hulyPersonUuid: string
  bindingId: string
  mrIid: string
  noteId: string
  dismissedAt: Date
}

export class Store {
  private readonly client: MongoClient
  private db: Db | null = null

  constructor (mongoUrl: string, private readonly dbName: string) {
    this.client = new MongoClient(mongoUrl)
  }

  async connect (): Promise<void> {
    await this.client.connect()
    this.db = this.client.db(this.dbName)
    await this.createIndexes()
  }

  async disconnect (): Promise<void> {
    await this.client.close()
  }

  private getDb (): Db {
    if (this.db === null) {
      throw new Error('Store not connected — call connect() first')
    }
    return this.db
  }

  bindings (): Collection<BindingDoc> {
    return this.getDb().collection<BindingDoc>('bindings')
  }

  cursors (): Collection<CursorDoc> {
    return this.getDb().collection<CursorDoc>('cursors')
  }

  idmap (): Collection<IdMapDoc> {
    return this.getDb().collection<IdMapDoc>('idmap')
  }

  dedup (): Collection<DedupDoc> {
    return this.getDb().collection<DedupDoc>('dedup')
  }

  inflight (): Collection<InflightDoc> {
    return this.getDb().collection<InflightDoc>('inflight')
  }

  credentials (): Collection<CredentialDoc> {
    return this.getDb().collection<CredentialDoc>('credentials')
  }

  oauthStates (): Collection<OAuthStateDoc> {
    return this.getDb().collection<OAuthStateDoc>('oauth_state')
  }

  userCredentials (): Collection<UserCredentialDoc> {
    return this.getDb().collection<UserCredentialDoc>('user_credentials')
  }

  dismissedSuggestions (): Collection<DismissedSuggestionDoc> {
    return this.getDb().collection<DismissedSuggestionDoc>('dismissed_suggestions')
  }

  attachmentMirror (): Collection<AttachmentMirrorDoc> {
    return this.getDb().collection<AttachmentMirrorDoc>('attachment_mirror')
  }

  private async createIndexes (): Promise<void> {
    const db = this.getDb()

    // bindings: unique per (workspaceUuid, gitlabProjectId)
    await db.collection('bindings').createIndex(
      { workspaceUuid: 1, gitlabProjectId: 1 },
      { unique: true, name: 'bindings_workspace_project' }
    )

    // cursors: unique per (bindingId, kind)
    await db.collection('cursors').createIndex(
      { bindingId: 1, kind: 1 },
      { unique: true, name: 'cursors_binding_kind' }
    )

    // idmap: gitlab direction
    await db.collection('idmap').createIndex(
      { workspaceUuid: 1, gitlabKind: 1, gitlabId: 1 },
      { unique: true, name: 'idmap_gitlab_direction' }
    )
    // idmap: huly direction
    await db.collection('idmap').createIndex(
      { workspaceUuid: 1, hulyClass: 1, hulyRef: 1 },
      { unique: true, name: 'idmap_huly_direction' }
    )

    // dedup: unique per (bindingId, eventId, version) + TTL 7 days
    await db.collection('dedup').createIndex(
      { bindingId: 1, eventId: 1, version: 1 },
      { unique: true, name: 'dedup_binding_event_version' }
    )
    await db.collection('dedup').createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 7 * 24 * 60 * 60, name: 'dedup_ttl' }
    )

    // inflight: TTL 1 hour
    await db.collection('inflight').createIndex(
      { startedAt: 1 },
      { expireAfterSeconds: 60 * 60, name: 'inflight_ttl' }
    )

    // oauth_state: TTL 10 minutes (expiresAt field drives expiry)
    await db.collection('oauth_state').createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'oauth_state_ttl' }
    )
    // oauth_state: unique state token
    await db.collection('oauth_state').createIndex(
      { state: 1 },
      { unique: true, name: 'oauth_state_unique' }
    )

    // user_credentials: unique per (workspaceUuid, hulyPersonUuid, gitlabBaseUrl)
    await db.collection('user_credentials').createIndex(
      { workspaceUuid: 1, hulyPersonUuid: 1, gitlabBaseUrl: 1 },
      { unique: true, name: 'user_credentials_workspace_person_baseurl' }
    )

    // dismissed_suggestions: unique per (workspaceUuid, hulyPersonUuid, bindingId, mrIid, noteId)
    await db.collection('dismissed_suggestions').createIndex(
      { workspaceUuid: 1, hulyPersonUuid: 1, bindingId: 1, mrIid: 1, noteId: 1 },
      { unique: true, name: 'dismissed_suggestions_unique' }
    )

    // attachment_mirror: unique per (contentHash, origin) — dedupe key
    await db.collection('attachment_mirror').createIndex(
      { contentHash: 1, origin: 1 },
      { unique: true, name: 'attachment_mirror_hash_origin' }
    )
  }
}
