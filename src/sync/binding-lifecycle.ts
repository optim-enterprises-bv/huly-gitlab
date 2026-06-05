import type { Store } from '../state/store'
import type { Logger } from '../logging'
import type { GitLabClient } from '../adapter/gitlab-client'
import { updateBinding, type BindingDoc } from '../state/bindings'
import { ObjectId } from 'mongodb'
import { getCredential } from '../state/credentials'
import { registerProjectWebhook, deregisterProjectWebhook, updateProjectWebhookEventFlags } from '../adapter/webhooks'
import { GitLabApiError } from '../adapter/errors'

const PHASE2_EVENT_FLAGS = {
  issues_events: true,
  note_events: true,
  merge_requests_events: true,
  pipeline_events: true
} as const

export interface RotateWebhookSecretResult {
  webhookRegistered: boolean
  reason?: string
}

export type GitLabClientFactory = (credentialRef: string) => Promise<GitLabClient>

export interface BindingLifecycleServiceDeps {
  store: Store
  encryptionKey: Buffer
  gitlabClientFactory: GitLabClientFactory
  logger: Logger
}

export interface OnBindingCreateResult {
  webhookRegistered: boolean
  webhookId?: number
  reason?: string
}

export interface ReRegisterWebhookResult {
  webhookRegistered: boolean
  webhookId?: number
  reason?: string
}

export class BindingLifecycleService {
  private readonly store: Store
  private readonly encryptionKey: Buffer
  private readonly gitlabClientFactory: GitLabClientFactory
  private readonly logger: Logger

  constructor (deps: BindingLifecycleServiceDeps) {
    this.store = deps.store
    this.encryptionKey = deps.encryptionKey
    this.gitlabClientFactory = deps.gitlabClientFactory
    this.logger = deps.logger
  }

  async onBindingCreate (
    binding: BindingDoc,
    publicBaseUrl: string
  ): Promise<OnBindingCreateResult> {
    const bindingId = binding._id.toHexString()

    // Resolve the webhook secret stored by the HTTP layer
    const secretCred = await getCredential(
      this.store.credentials(),
      this.encryptionKey,
      binding.webhookSecretRef
    )
    if (secretCred === null) {
      const reason = 'webhook secret credential not found'
      this.logger.warn('binding-lifecycle: webhook secret missing', { bindingId, reason })
      return { webhookRegistered: false, reason }
    }

    const webhookUrl = `${publicBaseUrl}/webhook/${bindingId}`

    let client: GitLabClient
    try {
      client = await this.gitlabClientFactory(binding.credentialRef)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.warn('binding-lifecycle: failed to build GitLab client', { bindingId, reason })
      return { webhookRegistered: false, reason }
    }

    try {
      const hook = await registerProjectWebhook(client, binding.gitlabProjectId, {
        url: webhookUrl,
        token: secretCred.plaintext,
        eventFlags: { ...PHASE2_EVENT_FLAGS }
      })

      await updateBinding(this.store.bindings(), bindingId, {
        webhookId: hook.id,
        webhookRegistered: true
      })

      this.logger.info('binding-lifecycle: webhook registered', {
        bindingId,
        webhookId: hook.id,
        projectId: binding.gitlabProjectId
      })

      return { webhookRegistered: true, webhookId: hook.id }
    } catch (err) {
      if (err instanceof GitLabApiError) {
        if (err.statusCode >= 400 && err.statusCode < 500) {
          const reason = `GitLab ${err.statusCode}: ${err.message}`
          this.logger.warn('binding-lifecycle: insufficient permissions for webhook', {
            bindingId,
            statusCode: err.statusCode,
            reason
          })
          await updateBinding(this.store.bindings(), bindingId, {
            webhookRegistered: false
          })
          return { webhookRegistered: false, reason }
        }
        // 5xx — propagate
        this.logger.error('binding-lifecycle: GitLab server error registering webhook', {
          bindingId,
          statusCode: err.statusCode
        })
        throw err
      }
      throw err
    }
  }

  async rotateWebhookSecret (
    binding: BindingDoc,
    newSecret: string,
    publicBaseUrl: string
  ): Promise<RotateWebhookSecretResult> {
    const bindingId = binding._id.toHexString()

    if (binding.webhookId === undefined) {
      return { webhookRegistered: false }
    }

    let client: GitLabClient
    try {
      client = await this.gitlabClientFactory(binding.credentialRef)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.warn('binding-lifecycle: rotate-secret: could not build GitLab client', { bindingId, reason })
      return { webhookRegistered: false, reason }
    }

    // Deregister old webhook (best-effort)
    try {
      await deregisterProjectWebhook(client, binding.gitlabProjectId, binding.webhookId)
    } catch (err) {
      this.logger.warn('binding-lifecycle: rotate-secret: deregister failed (continuing)', {
        bindingId,
        webhookId: binding.webhookId,
        err: err instanceof Error ? err.message : String(err)
      })
    }

    const webhookUrl = `${publicBaseUrl}/webhook/${bindingId}`

    try {
      const hook = await registerProjectWebhook(client, binding.gitlabProjectId, {
        url: webhookUrl,
        token: newSecret,
        eventFlags: { ...PHASE2_EVENT_FLAGS }
      })

      await updateBinding(this.store.bindings(), bindingId, {
        webhookId: hook.id,
        webhookRegistered: true
      })

      this.logger.info('binding-lifecycle: rotate-secret: webhook re-registered', {
        bindingId,
        webhookId: hook.id
      })

      return { webhookRegistered: true }
    } catch (err) {
      if (err instanceof GitLabApiError && err.statusCode >= 400 && err.statusCode < 500) {
        const reason = `GitLab ${err.statusCode}: ${err.message}`
        this.logger.warn('binding-lifecycle: rotate-secret: re-register failed', { bindingId, reason })
        await this.store.bindings().updateOne(
          { _id: new ObjectId(bindingId) },
          { $set: { webhookRegistered: false }, $unset: { webhookId: '' } }
        )
        return { webhookRegistered: false, reason }
      }
      throw err
    }
  }

  /**
   * Re-register (or update) a webhook so the GitLab subscription matches the
   * current Phase 2 event flag set (issues, notes, merge requests, pipelines).
   *
   * - If `binding.webhookId` is set: PUT the new event flags onto the existing hook.
   * - If `binding.webhookId` is absent and `webhookRegistered` is false: re-run `onBindingCreate`.
   * - 4xx responses: log + return `{webhookRegistered: false, reason}` (no throw).
   * - 5xx responses: propagate as in `onBindingCreate`.
   */
  async reRegisterWebhook (
    binding: BindingDoc,
    publicBaseUrl: string
  ): Promise<ReRegisterWebhookResult> {
    const bindingId = binding._id.toHexString()

    if (binding.webhookId === undefined) {
      if (binding.webhookRegistered) {
        return { webhookRegistered: true }
      }
      // No existing webhook — try to register fresh.
      const created = await this.onBindingCreate(binding, publicBaseUrl)
      return {
        webhookRegistered: created.webhookRegistered,
        ...(created.webhookId !== undefined ? { webhookId: created.webhookId } : {}),
        ...(created.reason !== undefined ? { reason: created.reason } : {})
      }
    }

    const secretCred = await getCredential(
      this.store.credentials(),
      this.encryptionKey,
      binding.webhookSecretRef
    )
    if (secretCred === null) {
      const reason = 'webhook secret credential not found'
      this.logger.warn('binding-lifecycle: re-register: webhook secret missing', { bindingId, reason })
      return { webhookRegistered: false, reason }
    }

    let client: GitLabClient
    try {
      client = await this.gitlabClientFactory(binding.credentialRef)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.warn('binding-lifecycle: re-register: could not build GitLab client', { bindingId, reason })
      return { webhookRegistered: false, reason }
    }

    const webhookUrl = `${publicBaseUrl}/webhook/${bindingId}`

    try {
      const hook = await updateProjectWebhookEventFlags(
        client,
        binding.gitlabProjectId,
        binding.webhookId,
        {
          url: webhookUrl,
          token: secretCred.plaintext,
          eventFlags: { ...PHASE2_EVENT_FLAGS }
        }
      )

      await updateBinding(this.store.bindings(), bindingId, {
        webhookId: hook.id,
        webhookRegistered: true
      })

      this.logger.info('binding-lifecycle: re-register: webhook updated', {
        bindingId,
        webhookId: hook.id
      })

      return { webhookRegistered: true, webhookId: hook.id }
    } catch (err) {
      if (err instanceof GitLabApiError && err.statusCode >= 400 && err.statusCode < 500) {
        const reason = `GitLab ${err.statusCode}: ${err.message}`
        this.logger.warn('binding-lifecycle: re-register: failed (4xx)', { bindingId, reason })
        await updateBinding(this.store.bindings(), bindingId, {
          webhookRegistered: false
        })
        return { webhookRegistered: false, reason }
      }
      throw err
    }
  }

  async onBindingDelete (binding: BindingDoc): Promise<void> {
    if (binding.webhookId === undefined) {
      return
    }

    const bindingId = binding._id.toHexString()

    let client: GitLabClient
    try {
      client = await this.gitlabClientFactory(binding.credentialRef)
    } catch (err) {
      this.logger.warn('binding-lifecycle: could not build client for webhook deregistration', {
        bindingId,
        err: err instanceof Error ? err.message : String(err)
      })
      return
    }

    try {
      await deregisterProjectWebhook(client, binding.gitlabProjectId, binding.webhookId)
      this.logger.info('binding-lifecycle: webhook deregistered', {
        bindingId,
        webhookId: binding.webhookId
      })
    } catch (err) {
      // Best-effort: log and swallow
      this.logger.warn('binding-lifecycle: webhook deregistration failed (best-effort)', {
        bindingId,
        webhookId: binding.webhookId,
        err: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
