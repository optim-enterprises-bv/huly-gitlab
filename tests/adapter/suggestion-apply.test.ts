import nock from 'nock'
import { applySuggestion } from '../../src/adapter/suggestion-apply'
import { GitLabApiError } from '../../src/adapter/errors'

const BASE_URL = 'http://gitlab.suggestion-apply.test'
const USER_TOKEN = 'gl-user-oauth-token'

afterEach(() => {
  nock.cleanAll()
})

describe('applySuggestion', () => {
  test('1. success → returns {applied: true, commitSha}', async () => {
    nock(BASE_URL)
      .put('/api/v4/suggestions/123/apply')
      .reply(200, { id: 123, commit_id: 'deadbeefcafe1234' })

    const result = await applySuggestion(BASE_URL, 123, USER_TOKEN)
    expect(result.applied).toBe(true)
    expect(result.commitSha).toBe('deadbeefcafe1234')
  })

  test('2. success with no commit_id in response → commitSha is undefined', async () => {
    nock(BASE_URL)
      .put('/api/v4/suggestions/123/apply')
      .reply(200, { id: 123 })

    const result = await applySuggestion(BASE_URL, 123, USER_TOKEN)
    expect(result.applied).toBe(true)
    expect(result.commitSha).toBeUndefined()
  })

  test('3. GitLab returns 409 → throws GitLabApiError with statusCode 409', async () => {
    nock(BASE_URL)
      .put('/api/v4/suggestions/456/apply')
      .reply(409, 'Suggestion is outdated and cannot be applied')

    const err = await applySuggestion(BASE_URL, 456, USER_TOKEN).catch(e => e)
    expect(err).toBeInstanceOf(GitLabApiError)
    expect((err as GitLabApiError).statusCode).toBe(409)
  })

  test('4. uses user OAuth token in PRIVATE-TOKEN header (not service account)', async () => {
    const capturedHeaders: Record<string, string> = {}
    nock(BASE_URL)
      .put('/api/v4/suggestions/789/apply')
      .reply(function () {
        Object.assign(capturedHeaders, this.req.headers)
        return [200, { id: 789, commit_id: 'token-header-check' }]
      })

    await applySuggestion(BASE_URL, 789, USER_TOKEN)
    expect(capturedHeaders['private-token']).toBe(USER_TOKEN)
    // Must NOT use Authorization: Bearer (that would be service-account style)
    expect(capturedHeaders['authorization']).toBeUndefined()
  })

  test('5. GitLab returns 401 → throws GitLabApiError with statusCode 401', async () => {
    nock(BASE_URL)
      .put('/api/v4/suggestions/999/apply')
      .reply(401, 'Unauthorized')

    const err = await applySuggestion(BASE_URL, 999, USER_TOKEN).catch(e => e)
    expect(err).toBeInstanceOf(GitLabApiError)
    expect((err as GitLabApiError).statusCode).toBe(401)
  })

  test('6. invalid token (empty string) → throws GitLabApiError before any network call', async () => {
    await expect(applySuggestion(BASE_URL, 1, '')).rejects.toThrow(GitLabApiError)
  })

  test('7. invalid token (contains newline) → throws GitLabApiError before any network call', async () => {
    await expect(applySuggestion(BASE_URL, 1, 'token\ninjection')).rejects.toThrow(GitLabApiError)
  })
})
