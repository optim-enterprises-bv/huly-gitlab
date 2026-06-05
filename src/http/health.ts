import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import type { Store } from '../state/store'
import type { Logger } from '../logging'

interface HealthState {
  mongoOk: boolean
  gitlabReachable: boolean | null
}

const state: HealthState = {
  mongoOk: false,
  gitlabReachable: null
}

export function setMongoOk (ok: boolean): void {
  state.mongoOk = ok
}

export function setGitlabReachable (reachable: boolean): void {
  state.gitlabReachable = reachable
}

export function createHealthRouter (store: Store, logger: Logger): Router {
  const router = createRouter()

  // Periodically probe mongo by pinging. Update state.mongoOk.
  const probeInterval = setInterval(() => {
    void (async () => {
      try {
        // If store's client is accessible we ping via a lightweight command
        const col = store.bindings()
        await col.findOne({}, { projection: { _id: 1 } })
        state.mongoOk = true
      } catch (err) {
        logger.warn('health: mongo probe failed', { err: err instanceof Error ? err.message : String(err) })
        state.mongoOk = false
      }
    })()
  }, 10000)

  // Allow GC in tests — unref so the interval doesn't prevent process exit
  probeInterval.unref()

  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      mongoOk: state.mongoOk,
      gitlabReachable: state.gitlabReachable
    })
  })

  return router
}
