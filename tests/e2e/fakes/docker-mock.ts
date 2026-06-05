/**
 * Mocks for child_process exec/spawn used by the harness during unit tests.
 *
 * The harness uses a small `execCommand(cmd: string)` indirection so tests can
 * inject a fake. This module does not patch global modules; it exports a
 * factory the tests pass into harness functions.
 */

export interface DockerInvocation {
  cmd: string
  at: number
}

export interface DockerMock {
  invocations: DockerInvocation[]
  exec: (cmd: string) => Promise<{ stdout: string, stderr: string }>
  enqueue: (response: { stdout?: string, stderr?: string, error?: Error }) => void
}

/**
 * Build a mock exec function. Responses are returned FIFO from the queue;
 * if the queue is empty, returns `{stdout: '', stderr: ''}`.
 */
export function makeDockerMock (): DockerMock {
  const queue: Array<{ stdout?: string, stderr?: string, error?: Error }> = []
  const invocations: DockerInvocation[] = []

  return {
    invocations,
    enqueue (response) {
      queue.push(response)
    },
    async exec (cmd: string) {
      invocations.push({ cmd, at: Date.now() })
      const next = queue.shift()
      if (next === undefined) {
        return { stdout: '', stderr: '' }
      }
      if (next.error !== undefined) {
        throw next.error
      }
      return { stdout: next.stdout ?? '', stderr: next.stderr ?? '' }
    }
  }
}
