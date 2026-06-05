/**
 * Shared webhook payload builder.
 *
 * Defence-in-depth (B4): `confidential_issues_events` and
 * `confidential_note_events` are HARDCODED to `false` here — callers cannot
 * override. Every webhook payload (initial register, re-register) flows
 * through this helper so the confidential opt-out is uniform.
 */

export interface WebhookEventFlags {
  push_events?: boolean
  issues_events?: boolean
  note_events?: boolean
  merge_requests_events?: boolean
  tag_push_events?: boolean
  pipeline_events?: boolean
  wiki_page_events?: boolean
  deployment_events?: boolean
  releases_events?: boolean
  job_events?: boolean
  member_events?: boolean
  subgroup_events?: boolean
}

export interface BuildWebhookPayloadInput {
  url: string
  token: string
  eventFlags: WebhookEventFlags
}

export function buildWebhookPayload (opts: BuildWebhookPayloadInput): Record<string, unknown> {
  return {
    url: opts.url,
    token: opts.token,
    push_events: opts.eventFlags.push_events ?? false,
    issues_events: opts.eventFlags.issues_events ?? false,
    note_events: opts.eventFlags.note_events ?? false,
    merge_requests_events: opts.eventFlags.merge_requests_events ?? false,
    tag_push_events: opts.eventFlags.tag_push_events ?? false,
    pipeline_events: opts.eventFlags.pipeline_events ?? false,
    wiki_page_events: opts.eventFlags.wiki_page_events ?? false,
    deployment_events: opts.eventFlags.deployment_events ?? false,
    releases_events: opts.eventFlags.releases_events ?? false,
    job_events: opts.eventFlags.job_events ?? false,
    member_events: opts.eventFlags.member_events ?? false,
    subgroup_events: opts.eventFlags.subgroup_events ?? false,
    // Confidential flags HARDCODED FALSE — never let caller override.
    confidential_issues_events: false,
    confidential_note_events: false
  }
}
