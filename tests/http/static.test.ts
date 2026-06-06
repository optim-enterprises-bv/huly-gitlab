import request from 'supertest'
import express from 'express'
import path from 'node:path'

describe('Static file serving (/user/ui)', () => {
  let app: express.Express

  beforeEach(() => {
    app = express()
    // Mount static middleware matching production setup
    app.use('/user/ui', express.static(path.join(__dirname, '../../public/user-ui'), {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'"
          )
        }
      }
    }))
  })

  test('1. GET /user/ui/ returns 200 with HTML content', async () => {
    const res = await request(app).get('/user/ui/')

    expect(res.status).toBe(200)
    expect(res.type).toMatch(/html/)
    expect(res.text).toContain('Huly GitLab')
    expect(res.text).toContain('Link your account')
  })

  test('2. GET /user/ui/ includes CSP header', async () => {
    const res = await request(app).get('/user/ui/')

    expect(res.status).toBe(200)
    const csp = res.get('Content-Security-Policy')
    expect(csp).toBeDefined()
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self'")
    expect(csp).toContain("connect-src 'self'")
  })

  test('3. GET /user/ui/app.js returns JavaScript file', async () => {
    const res = await request(app).get('/user/ui/app.js')

    expect(res.status).toBe(200)
    expect(res.type).toMatch(/javascript/)
    expect(res.text).toContain('huly-bearer')
    expect(res.text).toContain('postMessage')
    expect(res.text).toContain('sessionStorage')
  })

  test('4. GET /user/ui/style.css returns CSS file', async () => {
    const res = await request(app).get('/user/ui/style.css')

    expect(res.status).toBe(200)
    expect(res.type).toMatch(/css/)
    expect(res.text).toContain('body')
    expect(res.text).toContain('container')
  })

  test('5. HTML file does NOT contain bearer in query string patterns', async () => {
    const res = await request(app).get('/user/ui/')

    expect(res.status).toBe(200)
    // Verify no query-string bearer patterns in HTML
    expect(res.text).not.toMatch(/\?bearer=/i)
    expect(res.text).not.toMatch(/getQueryParam.*bearer/i)
  })

  test('6. JavaScript file does NOT contain query-string bearer code paths', async () => {
    const res = await request(app).get('/user/ui/app.js')

    expect(res.status).toBe(200)
    // Verify no query-string bearer patterns in JS
    expect(res.text).not.toMatch(/URLSearchParams.*bearer/i)
    expect(res.text).not.toMatch(/\['bearer'\]/i)
    expect(res.text).not.toMatch(/\.bearer\s*=/i)
  })

  test('7. JavaScript file contains postMessage handler', async () => {
    const res = await request(app).get('/user/ui/app.js')

    expect(res.status).toBe(200)
    expect(res.text).toContain('addEventListener(\'message\'')
    expect(res.text).toContain('huly-bearer')
    expect(res.text).toContain('window.parent.postMessage')
  })

  test('8. JavaScript file contains sessionStorage access', async () => {
    const res = await request(app).get('/user/ui/app.js')

    expect(res.status).toBe(200)
    expect(res.text).toContain('sessionStorage.getItem')
    expect(res.text).toContain('hulyBearer')
  })
})
