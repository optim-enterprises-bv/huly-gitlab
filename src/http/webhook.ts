import { timingSafeEqual } from 'node:crypto'
import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import type { Store } from '../state/store'
import type { SyncEngine } from '../sync/engine'
import type { Logger } from '../logging'
import { getBinding } from '../state/bindings'
import { getCredential } from '../state/credentials'
import { parseObjectId } from '../util/object-id'
import { asyncHandler } from './async-handler'
import * as metrics from '../metrics'
import { METRIC_NAMES } from '../metrics'

export function getConfidentialSkippedCount (): number {
  return metrics.get(METRIC_NAMES.WEBHOOK_CONFIDENTIAL_SKIPPED)
}

export function getMrSkippedCount (): number {
  return metrics.get(METRIC_NAMES.WEBHOOK_MR_SKIPPED)
}

export function getUnboundPipelineCount (): number {
  return metrics.get(METRIC_NAMES.WEBHOOK_UNBOUND_PIPELINE)
}

export function getEpicCeSkippedCount (): number {
  return metrics.get(METRIC_NAMES.WEBHOOK_EPIC_CE_SKIPPED)
}

export function getPayloadInvalidCount (): number {
  return metrics.get(METRIC_NAMES.WEBHOOK_PAYLOAD_INVALID)
}

const CONFIDENTIAL_HOOKS = new Set([
  'Confidential Issue Hook',
  'Confidential Note Hook',
  'Confidential Epic Hook'
])

const MR_EVENT_HEADER = 'Merge Request Hook'
const PIPELINE_EVENT_HEADER = 'Pipeline Hook'
const NOTE_NOTEABLE_TYPES = { issue: 'Issue', mergeRequest: 'MergeRequest' } as const

interface GitLabWebhookPayload {
  object_attributes?: {
    confidential?: boolean
    updated_at?: string
    /** For Note Hook: type of the entity the note is attached to */
    noteable_type?: string
    [key: string]: unknown
  }
  issue?: {
    confidential?: boolean
    iid?: number
    [key: string]: unknown
  }
  /**
   * Present on Note Hook payloads when noteable_type === 'MergeRequest'.
   * NOTE: GitLab does NOT include a `confidential` field on this embedded
   * merge_request object for Note Hook events — confidential MR note defense
   * is handled downstream by NotesSyncManager (P2-T-09) via parent-ref lookup.
   */
  merge_request?: {
    iid?: number
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

export function createWebhookRouter (
  store: Store,
  syncEngine: SyncEngine,
  encryptionKey: Buffer,
  logger: Logger
): Router {
  const router = createRouter()

  router.post('/webhook/:bindingId', asyncHandler(async (req: Request, res: Response) => {
    const { bindingId } = req.params

    if (parseObjectId(bindingId) === null) {
      res.status(400).json({ error: 'invalid id format' })
      return
    }

    const eventHeader = req.headers['x-gitlab-event'] as string | undefined
    const tokenHeader = req.headers['x-gitlab-token'] as string | undefined
    const eventUuid = (req.headers['x-gitlab-event-uuid'] as string | undefined) ?? `${bindingId}-${Date.now()}`

    // Reject rogue confidential hook variants without ever touching secrets
    if (eventHeader !== undefined && CONFIDENTIAL_HOOKS.has(eventHeader)) {
      logger.info('webhook: confidential hook received — dropping', { bindingId, event: eventHeader })
      metrics.increment(METRIC_NAMES.WEBHOOK_CONFIDENTIAL_SKIPPED)
      res.status(204).end()
      return
    }

    // Resolve binding
    let binding
    try {
      binding = await getBinding(store.bindings(), bindingId)
    } catch (_err) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    if (binding === null) {
      res.status(404).json({ error: 'Binding not found' })
      return
    }

    // B7: honour operator-pause contract (Q3). A disabled binding must not
    // dispatch events to the engine. Return 200 so GitLab does not retry,
    // explicitly signaling acceptance=false with the reason.
    if (binding.disabled) {
      logger.info('webhook: binding disabled — not enqueueing', { bindingId, event: eventHeader })
      res.status(200).json({ accepted: false, reason: 'binding disabled' })
      return
    }

    // Resolve webhook secret from credentials
    const credential = await getCredential(store.credentials(), encryptionKey, binding.webhookSecretRef)
    if (credential === null) {
      logger.error('webhook: missing webhook secret credential', { bindingId, webhookSecretRef: binding.webhookSecretRef })
      res.status(500).json({ error: 'Internal error' })
      return
    }

    // Timing-safe token comparison
    if (tokenHeader === undefined || tokenHeader === null || tokenHeader === '') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    let authorized: boolean
    try {
      const receivedBuf = Buffer.from(tokenHeader)
      const storedBuf = Buffer.from(credential.plaintext)
      if (receivedBuf.length !== storedBuf.length) {
        authorized = false
      } else {
        authorized = timingSafeEqual(receivedBuf, storedBuf)
      }
    } catch (_err) {
      authorized = false
    }

    if (!authorized) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const payload = req.body as GitLabWebhookPayload

    // Dispatch based on X-Gitlab-Event header
    if (eventHeader === 'Issue Hook') {
      // Skip confidential issues (Q5 defense-in-depth)
      if (payload.object_attributes?.confidential === true) {
        logger.info('webhook: confidential issue — dropping', { bindingId, eventUuid })
        metrics.increment(METRIC_NAMES.WEBHOOK_CONFIDENTIAL_SKIPPED)
        res.status(204).end()
        return
      }

      const version = payload.object_attributes?.updated_at ?? String(Date.now())
      await syncEngine.enqueueWebhookEvent(bindingId, 'issue', payload as Record<string, unknown>, eventUuid, version)
      res.status(200).json({ accepted: true })
      return
    }

    if (eventHeader === MR_EVENT_HEADER) {
      // Drop confidential MRs — GitLab MR Hook DOES carry object_attributes.confidential
      if (payload.object_attributes?.confidential === true) {
        logger.info('webhook: confidential MR — dropping', { bindingId, eventUuid })
        metrics.increment(METRIC_NAMES.WEBHOOK_CONFIDENTIAL_SKIPPED)
        metrics.increment(METRIC_NAMES.WEBHOOK_MR_SKIPPED)
        res.status(204).end()
        return
      }

      const version = payload.object_attributes?.updated_at ?? String(Date.now())
      await syncEngine.enqueueWebhookEvent(bindingId, 'merge_request', payload as Record<string, unknown>, eventUuid, version)
      res.status(200).json({ accepted: true })
      return
    }

    if (eventHeader === PIPELINE_EVENT_HEADER) {
      const mergeRequestIid = payload.merge_request?.iid

      // Drop pipelines not tied to an MR (standalone branch/tag pipelines)
      if (mergeRequestIid === undefined || mergeRequestIid === null) {
        logger.info('webhook: pipeline without MR — dropping', { bindingId, eventUuid })
        metrics.increment(METRIC_NAMES.WEBHOOK_UNBOUND_PIPELINE)
        res.status(204).end()
        return
      }

      const version = payload.object_attributes?.updated_at ?? String(Date.now())
      await syncEngine.enqueueWebhookEvent(bindingId, 'pipeline', payload as Record<string, unknown>, eventUuid, version)
      res.status(200).json({ accepted: true })
      return
    }

    if (eventHeader === 'Note Hook') {
      const noteableType = payload.object_attributes?.noteable_type

      if (noteableType === NOTE_NOTEABLE_TYPES.issue || noteableType === undefined) {
        // Existing Issue-note path: skip notes on confidential issues
        if (payload.issue?.confidential === true) {
          logger.info('webhook: note on confidential issue — dropping', { bindingId, eventUuid })
          metrics.increment(METRIC_NAMES.WEBHOOK_CONFIDENTIAL_SKIPPED)
          res.status(204).end()
          return
        }

        const version = payload.object_attributes?.updated_at ?? String(Date.now())
        await syncEngine.enqueueWebhookEvent(bindingId, 'note', payload as Record<string, unknown>, eventUuid, version)
        res.status(200).json({ accepted: true })
        return
      }

      if (noteableType === NOTE_NOTEABLE_TYPES.mergeRequest) {
        // MR-note path: no confidential check here — GitLab Note Hook does NOT carry
        // a `confidential` field on the embedded merge_request object. Defense-in-depth
        // is via NotesSyncManager (P2-T-09): notes for unmapped MR parents are dropped
        // after deferred-retry exhaustion (confidential MRs are never in idmap).
        const version = payload.object_attributes?.updated_at ?? String(Date.now())
        await syncEngine.enqueueWebhookEvent(bindingId, 'note', payload as Record<string, unknown>, eventUuid, version)
        res.status(200).json({ accepted: true })
        return
      }

      // Other noteable_type values (Snippet, Commit, etc.) — accept silently
      logger.debug('webhook: note with unhandled noteable_type', { bindingId, eventUuid, noteableType })
      res.status(200).json({ accepted: true })
      return
    }

    if (eventHeader === 'Epic Hook') {
      const oa = payload.object_attributes as Record<string, unknown> | undefined

      // Validate required fields
      if (oa?.iid == null || oa?.group_id == null) {
        logger.debug('webhook: Epic Hook with missing object_attributes.iid or group_id — dropping', { bindingId, eventUuid })
        metrics.increment(METRIC_NAMES.WEBHOOK_PAYLOAD_INVALID)
        res.status(400).json({ error: 'invalid payload: missing object_attributes.iid or group_id' })
        return
      }

      // Defense-in-depth: skip confidential epics
      if (oa?.confidential === true) {
        logger.info('webhook: confidential epic — dropping', { bindingId, eventUuid })
        metrics.increment(METRIC_NAMES.WEBHOOK_CONFIDENTIAL_SKIPPED)
        res.status(204).end()
        return
      }

      const version = (oa?.updated_at as string | undefined) ?? String(Date.now())
      await syncEngine.enqueueWebhookEvent(bindingId, 'epic', payload as Record<string, unknown>, eventUuid, version)
      res.status(200).json({ accepted: true })
      return
    }

    // Unknown event type — accept silently to avoid GitLab retries
    logger.debug('webhook: unhandled event type', { bindingId, event: eventHeader })
    res.status(200).json({ accepted: true })
  }))

  return router
}
