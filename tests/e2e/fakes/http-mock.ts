/**
 * Minimal fetch mock for harness unit tests.
 *
 * The harness uses an injectable `fetchFn` typed as the global `fetch`.
 * This factory returns a stub that maps URL substrings to ordered responses,
 * so a polling loop can be driven through several states (fail → 200).
 */

export interface FetchMockResponse {
  status: number
  body?: unknown
  text?: string
  throwError?: Error
}

export interface FetchMock {
  invocations: Array<{ url: string, init?: RequestInit }>
  fetch: typeof fetch
  /** When called for any URL containing `match`, return the next queued response. */
  on: (match: string, response: FetchMockResponse | FetchMockResponse[]) => void
}

export function makeFetchMock (): FetchMock {
  const queues = new Map<string, FetchMockResponse[]>()
  const invocations: Array<{ url: string, init?: RequestInit }> = []

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    invocations.push({ url, init })

    let chosen: FetchMockResponse | undefined
    for (const [match, queue] of queues.entries()) {
      if (url.includes(match) && queue.length > 0) {
        chosen = queue.shift()
        break
      }
    }
    if (chosen === undefined) {
      // Default: 599 so polling loops keep trying; throw if no match registered.
      throw new Error(`http-mock: no response registered for ${url}`)
    }
    if (chosen.throwError !== undefined) {
      throw chosen.throwError
    }
    const bodyText = chosen.text ?? (chosen.body !== undefined ? JSON.stringify(chosen.body) : '')
    const status = chosen.status
    const ok = status >= 200 && status < 300
    return {
      status,
      ok,
      async text () {
        return bodyText
      },
      async json () {
        return chosen?.body ?? JSON.parse(bodyText)
      }
    } as unknown as Response
  }) as unknown as typeof fetch

  return {
    invocations,
    fetch: fakeFetch,
    on (match, response) {
      const list = Array.isArray(response) ? response : [response]
      const existing = queues.get(match) ?? []
      queues.set(match, [...existing, ...list])
    }
  }
}
