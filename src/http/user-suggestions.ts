/**
 * User-facing suggestion apply/dismiss endpoints.
 *
 * Routes (mounted under `/user/api/v1/suggestions`):
 *   POST /:bindingId/:mrIid/:suggestionId/apply   — apply via user OAuth token
 *   POST /:bindingId/:mrIid/:noteId/dismiss        — local dismiss (no GitLab call)
 *
 * All routes require a valid huly-user cookie (same as user-oauth).
 * Apply uses the authenticated user's OAuth bearer so the resulting commit is
 * attributed to that user, not the service account.
 */

import { Router as createRouter } from 'express'
import type { Response, Router } from 'express'
import type { Config } from '../config'
import type { Store } from '../state/store'
import type { Logger } from '../logging'
import { requireHulyCookie } from './cookie-auth'
import type { HulyUserAuthRequest } from './cookie-auth'
import { rateLimit } from './rate-limit'
import { applySuggestion } from '../adapter/suggestion-apply'
import { getUserCredential } from '../state/user-credentials'
import { getBinding } from '../state/bindings'
import { GitLabApiError } from '../adapter/errors'
import type { WorkspaceUuid, PersonUuid } from '@hcengineering/core'
import type { SecretConfig } from '../util/secret-rotation'

export interface UserSuggestionsRouterDeps {
  config: Config
  store: Store
  logger: Logger
  secrets?: SecretConfig
}

export function createUserSuggestionsRouter (deps: UserSuggestionsRouterDeps): Router {
  const { config, store, logger } = deps
  const secrets: SecretConfig = deps.secrets ?? { primary: config.ServerSecret, previous: config.ServerSecretPrevious }
  const router = createRouter()

  const cookieAuth = requireHulyCookie(secrets)
  const applyRateLimit = rateLimit({ capacity: 10, refillPerSecond: 10 / 60 })

  /**
   * POST /:bindingId/:mrIid/:suggestionId/apply
   *
   * Applies a GitLab suggestion as the authenticated Huly user. Requires that
   * the user has a stored OAuth credential for the GitLab instance backing the
   * binding. Returns { applied: true, commitSha? } on success, or 400/401/409
   * on various failure modes.
   */
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/:bindingId/:mrIid/:suggestionId/apply', applyRateLimit, cookieAuth, async (req: HulyUserAuthRequest, res: Response) => {
    const identity = req.hulyUser
    if (identity === undefined) {
      res.status(401).json({ error: 'huly-user cookie required' })
      return
    }

    const { bindingId, suggestionId } = req.params
    const suggestionIdNum = parseInt(suggestionId, 10)
    if (!Number.isFinite(suggestionIdNum) || suggestionIdNum <= 0) {
      res.status(400).json({ error: 'invalid_request', message: 'Invalid suggestionId' })
      return
    }

    const encryptionKey = Buffer.from(config.CredentialEncryptionKey, 'base64')

    // Resolve binding to find the GitLab base URL for the credential lookup.
    let gitlabBaseUrl: string
    try {
      const binding = await getBinding(store.bindings(), bindingId)
      if (binding === null) {
        res.status(404).json({ error: 'not_found', message: 'Binding not found' })
        return
      }
      // Resolve gitlabBaseUrl from the credential attached to this binding.
      const credDoc = await store.credentials().findOne({ _id: { $exists: true } })
      void credDoc // only used to determine collection exists
      // Look up gitlabBaseUrl from credential doc directly
      const { ObjectId } = await import('mongodb')
      const rawCred = await store.credentials().findOne({ _id: new ObjectId(binding.credentialRef) })
      if (rawCred?.gitlabBaseUrl === undefined) {
        logger.error('user-suggestions: binding credential missing gitlabBaseUrl', { bindingId })
        res.status(500).json({ error: 'server_error', message: 'Cannot determine GitLab instance for binding' })
        return
      }
      gitlabBaseUrl = rawCred.gitlabBaseUrl
    } catch (err) {
      logger.error('user-suggestions: binding lookup failed', { bindingId, err: err instanceof Error ? err.message : String(err) })
      res.status(400).json({ error: 'invalid_request', message: 'Invalid bindingId' })
      return
    }

    // Retrieve the user's OAuth token for the resolved GitLab instance.
    const credential = await getUserCredential(
      store.userCredentials(),
      encryptionKey,
      identity.workspaceUuid as WorkspaceUuid,
      identity.hulyPersonUuid as PersonUuid,
      gitlabBaseUrl
    )

    if (credential === null) {
      res.status(401).json({ error: 'not_linked', message: 'No GitLab credential found. Link your account first.' })
      return
    }

    try {
      const result = await applySuggestion(gitlabBaseUrl, suggestionIdNum, credential.token)
      logger.info('user-suggestions: applied', {
        bindingId,
        suggestionId: suggestionIdNum,
        workspaceUuid: identity.workspaceUuid
      })
      res.status(200).json(result)
    } catch (err) {
      if (err instanceof GitLabApiError) {
        if (err.statusCode === 409) {
          res.status(400).json({ error: 'conflict', message: 'Suggestion could not be applied (outdated or already applied)' })
          return
        }
        if (err.statusCode === 401 || err.statusCode === 403) {
          res.status(401).json({ error: 'gitlab_auth_failed', message: 'GitLab rejected the user token' })
          return
        }
      }
      logger.error('user-suggestions: apply failed', {
        bindingId,
        suggestionId: suggestionIdNum,
        err: err instanceof Error ? err.message : String(err)
      })
      res.status(500).json({ error: 'server_error', message: 'Failed to apply suggestion' })
    }
  })

  /**
   * POST /:bindingId/:mrIid/:noteId/dismiss
   *
   * Locally marks a suggestion as dismissed. No GitLab API call is made.
   * The dismissed state is stored in the `dismissed_suggestions` MongoDB
   * collection keyed on (workspaceUuid, hulyPersonUuid, bindingId, noteId).
   */
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/:bindingId/:mrIid/:noteId/dismiss', applyRateLimit, cookieAuth, async (req: HulyUserAuthRequest, res: Response) => {
    const identity = req.hulyUser
    if (identity === undefined) {
      res.status(401).json({ error: 'huly-user cookie required' })
      return
    }

    const { bindingId, mrIid, noteId } = req.params

    try {
      await store.dismissedSuggestions().updateOne(
        {
          workspaceUuid: identity.workspaceUuid,
          hulyPersonUuid: identity.hulyPersonUuid,
          bindingId,
          mrIid,
          noteId
        },
        {
          $set: {
            workspaceUuid: identity.workspaceUuid,
            hulyPersonUuid: identity.hulyPersonUuid,
            bindingId,
            mrIid,
            noteId,
            dismissedAt: new Date()
          }
        },
        { upsert: true }
      )
      logger.info('user-suggestions: dismissed', {
        bindingId,
        mrIid,
        noteId,
        workspaceUuid: identity.workspaceUuid
      })
      res.status(200).json({ dismissed: true })
    } catch (err) {
      logger.error('user-suggestions: dismiss failed', {
        bindingId,
        mrIid,
        noteId,
        err: err instanceof Error ? err.message : String(err)
      })
      res.status(500).json({ error: 'server_error', message: 'Failed to dismiss suggestion' })
    }
  })

  return router
}
