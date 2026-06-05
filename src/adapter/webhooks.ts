import type { GitLabClient } from './gitlab-client'
import type { SyncWebhook } from './types'
import { buildWebhookPayload, type WebhookEventFlags } from './webhook-payload'

export type { WebhookEventFlags }

export interface RegisterWebhookOptions {
  url: string
  token: string
  eventFlags: WebhookEventFlags
}

/**
 * Register a project webhook.
 * Per Q5 resolution: confidential_issues_events and confidential_note_events
 * are explicitly excluded and never set to true regardless of what eventFlags contains.
 */
export async function registerProjectWebhook (
  client: GitLabClient,
  projectId: number | string,
  opts: RegisterWebhookOptions
): Promise<SyncWebhook> {
  const body = buildWebhookPayload({
    url: opts.url,
    token: opts.token,
    eventFlags: opts.eventFlags
  })

  return await client.createProjectWebhook(projectId, body)
}

/**
 * Deregister (delete) a project webhook by its hook ID.
 */
export async function deregisterProjectWebhook (
  client: GitLabClient,
  projectId: number | string,
  webhookId: number
): Promise<void> {
  await client.deleteProjectWebhook(projectId, webhookId)
}

/**
 * Update the event flags on an existing project webhook (re-register flow).
 * Uses the shared helper so confidential flags are always false (B4).
 */
export async function updateProjectWebhookEventFlags (
  client: GitLabClient,
  projectId: number | string,
  webhookId: number,
  opts: RegisterWebhookOptions
): Promise<SyncWebhook> {
  const body = buildWebhookPayload({
    url: opts.url,
    token: opts.token,
    eventFlags: opts.eventFlags
  })

  return await client.updateProjectWebhook(projectId, webhookId, body)
}
