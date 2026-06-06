import express from 'express'
import request from 'supertest'
import { rateLimit } from '../../src/http/rate-limit'

function makeApp (opts: Parameters<typeof rateLimit>[0] = {}) {
  const app = express()
  app.use(rateLimit(opts))
  app.get('/api', (_req, res) => { res.json({ ok: true }) })
  return app
}

describe('rateLimit', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('1. First 10 requests within 1s all pass (200)', async () => {
    const app = makeApp({ capacity: 10, refillPerSecond: 10 / 60 })
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/api').set('x-forwarded-for', '1.2.3.4')
      expect(res.status).toBe(200)
    }
  })

  test('2. 11th request within 1s is rejected with 429', async () => {
    const app = makeApp({ capacity: 10, refillPerSecond: 10 / 60 })
    for (let i = 0; i < 10; i++) {
      await request(app).get('/api').set('x-forwarded-for', '1.2.3.5')
    }
    const res = await request(app).get('/api').set('x-forwarded-for', '1.2.3.5')
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('rate limit exceeded')
    expect(typeof res.body.retryAfter).toBe('number')
  })

  test('3. After waiting 60s bucket refills and new request passes', async () => {
    const app = makeApp({ capacity: 10, refillPerSecond: 10 / 60 })
    for (let i = 0; i < 10; i++) {
      await request(app).get('/api').set('x-forwarded-for', '1.2.3.6')
    }
    const blocked = await request(app).get('/api').set('x-forwarded-for', '1.2.3.6')
    expect(blocked.status).toBe(429)

    jest.advanceTimersByTime(60 * 1000)

    const res = await request(app).get('/api').set('x-forwarded-for', '1.2.3.6')
    expect(res.status).toBe(200)
  })

  test('4. Different IPs have independent buckets', async () => {
    const app = makeApp({
      capacity: 10,
      refillPerSecond: 10 / 60,
      keyExtractor: (req) => req.headers['x-real-ip'] as string ?? 'unknown'
    })
    for (let i = 0; i < 10; i++) {
      await request(app).get('/api').set('x-real-ip', '10.0.0.1')
    }
    const blockedA = await request(app).get('/api').set('x-real-ip', '10.0.0.1')
    expect(blockedA.status).toBe(429)

    const passB = await request(app).get('/api').set('x-real-ip', '10.0.0.2')
    expect(passB.status).toBe(200)
  })

  test('5. Custom keyExtractor isolates buckets by header value', async () => {
    const app = makeApp({
      capacity: 2,
      refillPerSecond: 2 / 60,
      keyExtractor: (req) => req.headers['x-tenant'] as string ?? 'default'
    })
    await request(app).get('/api').set('x-tenant', 'tenant-a')
    await request(app).get('/api').set('x-tenant', 'tenant-a')
    const blocked = await request(app).get('/api').set('x-tenant', 'tenant-a')
    expect(blocked.status).toBe(429)

    const passB = await request(app).get('/api').set('x-tenant', 'tenant-b')
    expect(passB.status).toBe(200)
  })
})
