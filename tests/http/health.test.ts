import request from 'supertest'
import express from 'express'
import { createHealthRouter, setMongoOk } from '../../src/http/health'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { Collection } from 'mongodb'
import type { BindingDoc } from '../../src/state/bindings'

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

function makeStore (connected: boolean): Store {
  return {
    bindings: () => ({
      findOne: async () => {
        if (!connected) throw new Error('not connected')
        return null
      }
    } as unknown as Collection<BindingDoc>)
  } as unknown as Store
}

describe('GET /health', () => {
  test('1. Returns 200 with status:ok when store connected', async () => {
    const store = makeStore(true)
    setMongoOk(true)

    const app = express()
    app.use(createHealthRouter(store, makeLogger()))

    const res = await request(app).get('/health')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.uptime).toBe('number')
    expect(typeof res.body.mongoOk).toBe('boolean')
  })

  test('2. mongoOk:false when store disconnected', async () => {
    const store = makeStore(false)
    setMongoOk(false)

    const app = express()
    app.use(createHealthRouter(store, makeLogger()))

    const res = await request(app).get('/health')

    expect(res.status).toBe(200)
    expect(res.body.mongoOk).toBe(false)
  })
})
