import { createDecipheriv } from 'node:crypto'
import { ObjectId } from 'mongodb'
import type { Store } from '../state/store'
import type { Logger } from '../logging'
import { rotateCredential } from '../state/credentials'
import { validateGitLabBaseUrl } from '../util/url-validation'

const FIVE_MINUTES_MS = 5 * 60 * 1000
const ALGORITHM = 'aes-256-gcm'

function isPermanentRefreshError (status: number | undefined, body: unknown): boolean {
  if (status === 401) return true
  if (status === 400) {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
    if (bodyStr.includes('"error":"invalid_grant"') || bodyStr.includes("'error':'invalid_grant'")) return true
  }
  return false
}

export interface OAuthRefresherDeps {
  store: Store
  logger: Logger
  encryptionKey: Buffer
  gitLabClientId: string
  gitLabClientSecret: string
  oauthRedirectUri: string
}

export class OAuthRefresher {
  private readonly store: Store
  private readonly logger: Logger
  private readonly encryptionKey: Buffer
  private readonly gitLabClientId: string
  private readonly gitLabClientSecret: string
  private readonly oauthRedirectUri: string
  private timer: ReturnType<typeof setInterval> | null = null

  constructor (deps: OAuthRefresherDeps) {
    this.store = deps.store
    this.logger = deps.logger
    this.encryptionKey = deps.encryptionKey
    this.gitLabClientId = deps.gitLabClientId
    this.gitLabClientSecret = deps.gitLabClientSecret
    this.oauthRedirectUri = deps.oauthRedirectUri
  }

  start (intervalMs: number = 30 * 60 * 1000): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.refresh()
    }, intervalMs)
  }

  stop (): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async refresh (): Promise<void> {
    const now = Date.now()
    const threshold = new Date(now + FIVE_MINUTES_MS)

    // Find all oauth credentials expiring within 5 minutes
    const docs = await this.store.credentials().find({
      kind: 'oauth',
      expiresAt: { $lt: threshold },
      expired: { $ne: true }
    }).toArray()

    for (const doc of docs) {
      const id = doc._id.toHexString()
      const gitlabBaseUrl = doc.gitlabBaseUrl

      if (gitlabBaseUrl === undefined || gitlabBaseUrl === '') {
        this.logger.warn('oauth-refresh: credential missing gitlabBaseUrl, skipping', { id })
        continue
      }

      try {
        validateGitLabBaseUrl(gitlabBaseUrl)
      } catch (err) {
        this.logger.warn('oauth-refresh: credential has invalid gitlabBaseUrl — marking expired', {
          id,
          reason: err instanceof Error ? err.message : String(err)
        })
        await this.markExpired(id)
        continue
      }

      if (
        doc.refreshTokenCiphertext === undefined ||
        doc.refreshTokenIv === undefined ||
        doc.refreshTokenTag === undefined
      ) {
        this.logger.warn('oauth-refresh: credential missing refresh token, skipping', { id })
        continue
      }

      let refreshToken: string
      try {
        const iv = Buffer.from(doc.refreshTokenIv, 'base64')
        const tag = Buffer.from(doc.refreshTokenTag, 'base64')
        const ciphertextBuf = Buffer.from(doc.refreshTokenCiphertext, 'base64')
        const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv)
        decipher.setAuthTag(tag)
        refreshToken = Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]).toString('utf8')
      } catch (err) {
        this.logger.warn('oauth-refresh: failed to decrypt refresh token', { id, err: err instanceof Error ? err.message : String(err) })
        await this.markExpired(id)
        continue
      }

      const tokenUrl = `${gitlabBaseUrl}/oauth/token`
      let tokenData: Record<string, unknown>
      let responseOk = false
      let responseStatus: number | undefined

      try {
        const response = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.gitLabClientId,
            client_secret: this.gitLabClientSecret,
            redirect_uri: this.oauthRedirectUri
          }).toString()
        })
        responseStatus = response.status
        tokenData = await response.json() as Record<string, unknown>
        responseOk = response.ok
      } catch (err) {
        this.logger.warn('oauth-refresh: network error — transient, will retry', { id, reason: 'transient', err: err instanceof Error ? err.message : String(err) })
        continue
      }

      if (!responseOk) {
        if (isPermanentRefreshError(responseStatus, tokenData)) {
          this.logger.warn('oauth-refresh: permanent refresh failure — marking expired', { id, status: responseStatus, reason: 'permanent', body: tokenData })
          await this.markExpired(id)
        } else {
          this.logger.warn('oauth-refresh: transient refresh failure — will retry', { id, status: responseStatus, reason: 'transient', body: tokenData })
        }
        continue
      }

      const newAccessToken = tokenData.access_token
      const newRefreshToken = tokenData.refresh_token
      const expiresIn = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : 7200

      if (typeof newAccessToken !== 'string') {
        this.logger.warn('oauth-refresh: no access_token in response', { id })
        await this.markExpired(id)
        continue
      }

      const newExpiresAt = new Date(Date.now() + expiresIn * 1000)

      await rotateCredential(this.store.credentials(), this.encryptionKey, id, {
        plaintext: newAccessToken,
        refreshTokenPlaintext: typeof newRefreshToken === 'string' ? newRefreshToken : undefined,
        expiresAt: newExpiresAt
      })

      this.logger.info('oauth-refresh: rotated credential', { id })
    }
  }

  private async markExpired (id: string): Promise<void> {
    await this.store.credentials().updateOne(
      { _id: new ObjectId(id) },
      { $set: { expired: true } }
    )
  }
}
