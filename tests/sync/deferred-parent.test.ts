import { markAndRetry, NOTE_RETRY_FLAG, REVIEW_RETRY_FLAG } from '../../src/sync/deferred-parent'

describe('markAndRetry', () => {
  it('returns true on first call and sets the flag', () => {
    const record: Record<string, unknown> = {}
    const result = markAndRetry(record, NOTE_RETRY_FLAG)
    expect(result).toBe(true)
    expect(record[NOTE_RETRY_FLAG]).toBe(true)
  })

  it('returns false on second call with same flag', () => {
    const record: Record<string, unknown> = {}
    markAndRetry(record, NOTE_RETRY_FLAG)
    const result = markAndRetry(record, NOTE_RETRY_FLAG)
    expect(result).toBe(false)
  })

  it('different flag on same record is independent', () => {
    const record: Record<string, unknown> = {}
    markAndRetry(record, NOTE_RETRY_FLAG)
    const result = markAndRetry(record, REVIEW_RETRY_FLAG)
    expect(result).toBe(true)
    expect(record[REVIEW_RETRY_FLAG]).toBe(true)
  })
})
