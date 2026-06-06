import { buildWebhookPayload } from '../../src/adapter/webhook-payload'

describe('buildWebhookPayload', () => {
  test('1. issues_events:true → other flags default false, confidential_* false', () => {
    const body = buildWebhookPayload({
      url: 'https://huly.example.com/webhook/abc',
      token: 'tok',
      eventFlags: { issues_events: true }
    })

    expect(body.issues_events).toBe(true)
    expect(body.note_events).toBe(false)
    expect(body.merge_requests_events).toBe(false)
    expect(body.pipeline_events).toBe(false)
    expect(body.push_events).toBe(false)
    expect(body.tag_push_events).toBe(false)
    expect(body.confidential_issues_events).toBe(false)
    expect(body.confidential_note_events).toBe(false)
  })

  test('2. all event flags true → confidential_* still false (caller cannot override)', () => {
    // Cast through unknown so we can pass keys the type doesn't expose,
    // proving the helper hardcodes the confidential flags regardless of input.
    const malicious: Record<string, boolean> = {
      issues_events: true,
      note_events: true,
      merge_requests_events: true,
      pipeline_events: true,
      push_events: true,
      tag_push_events: true,
      wiki_page_events: true,
      deployment_events: true,
      releases_events: true,
      job_events: true,
      member_events: true,
      subgroup_events: true,
      confidential_issues_events: true,
      confidential_note_events: true
    }

    const body = buildWebhookPayload({
      url: 'https://h.example/webhook/x',
      token: 't',
      eventFlags: malicious as unknown as Parameters<typeof buildWebhookPayload>[0]['eventFlags']
    })

    expect(body.issues_events).toBe(true)
    expect(body.note_events).toBe(true)
    expect(body.merge_requests_events).toBe(true)
    expect(body.pipeline_events).toBe(true)
    // Critical: caller-provided confidential flags are ignored.
    expect(body.confidential_issues_events).toBe(false)
    expect(body.confidential_note_events).toBe(false)
  })

  test('3. empty eventFlags → all event flags default false, confidential_* explicitly false', () => {
    const body = buildWebhookPayload({
      url: 'https://h/x',
      token: 't',
      eventFlags: {}
    })

    expect(body.issues_events).toBe(false)
    expect(body.note_events).toBe(false)
    expect(body.merge_requests_events).toBe(false)
    expect(body.pipeline_events).toBe(false)
    expect(body.push_events).toBe(false)
    expect(body.tag_push_events).toBe(false)
    expect(body.wiki_page_events).toBe(false)
    expect(body.deployment_events).toBe(false)
    expect(body.releases_events).toBe(false)
    expect(body.job_events).toBe(false)
    expect(body.member_events).toBe(false)
    expect(body.subgroup_events).toBe(false)
    expect(body.confidential_issues_events).toBe(false)
    expect(body.confidential_note_events).toBe(false)
  })

  test('4. round-trip: payload includes url and token from input', () => {
    const url = 'https://huly.example.com/webhook/77'
    const token = 'super-secret-token'
    const body = buildWebhookPayload({
      url,
      token,
      eventFlags: { issues_events: true, note_events: true }
    })

    expect(body.url).toBe(url)
    expect(body.token).toBe(token)
  })

  test('5. epic_events honored when passed in eventFlags', () => {
    const body = buildWebhookPayload({
      url: 'https://h/x',
      token: 't',
      eventFlags: { epic_events: true }
    })

    expect(body.epic_events).toBe(true)
    expect(body.confidential_epic_events).toBe(false)
  })

  test('6. confidential_epic_events always false even if caller passes true', () => {
    const malicious: Record<string, boolean> = {
      epic_events: true,
      confidential_epic_events: true
    }

    const body = buildWebhookPayload({
      url: 'https://h/x',
      token: 't',
      eventFlags: malicious as unknown as Parameters<typeof buildWebhookPayload>[0]['eventFlags']
    })

    expect(body.epic_events).toBe(true)
    // Critical: confidential_epic_events is hardcoded false
    expect(body.confidential_epic_events).toBe(false)
  })
})
