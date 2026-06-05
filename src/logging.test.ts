import { createLogger, setLogLevel } from './logging'

describe('Logging', () => {
  let consoleLogSpy: jest.SpyInstance<void, unknown[]>
  let capturedLogs: Array<Record<string, unknown>>

  beforeEach(() => {
    capturedLogs = []
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      try {
        const parsed = JSON.parse(String(msg))
        if (typeof parsed === 'object' && parsed !== null) {
          capturedLogs.push(parsed as Record<string, unknown>)
        }
      } catch {
        // Fallback if not JSON
        capturedLogs.push({ raw: msg })
      }
    })
    setLogLevel('debug')
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
  })

  describe('createLogger', () => {
    it('should emit debug level logs', () => {
      const logger = createLogger('test-component')
      logger.debug('test message')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]).toMatchObject({
        level: 'debug',
        component: 'test-component',
        msg: 'test message',
        correlationId: null
      })
    })

    it('should emit info level logs', () => {
      const logger = createLogger('test-component')
      logger.info('info message')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]).toMatchObject({
        level: 'info',
        component: 'test-component',
        msg: 'info message'
      })
    })

    it('should emit warn level logs', () => {
      const logger = createLogger('test-component')
      logger.warn('warning message')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]).toMatchObject({
        level: 'warn',
        component: 'test-component',
        msg: 'warning message'
      })
    })

    it('should emit error level logs', () => {
      const logger = createLogger('test-component')
      logger.error('error message')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]).toMatchObject({
        level: 'error',
        component: 'test-component',
        msg: 'error message'
      })
    })

    it('should include timestamp in ISO format', () => {
      const logger = createLogger('test-component')
      const before = new Date().toISOString()
      logger.info('test')
      const after = new Date().toISOString()

      expect(capturedLogs).toHaveLength(1)
      const ts = capturedLogs[0].ts as string
      expect(ts).toBeDefined()
      expect(new Date(ts).toISOString()).toBeTruthy()
      expect(ts >= before).toBeTruthy()
      expect(ts <= after).toBeTruthy()
    })

    it('should include context when provided', () => {
      const logger = createLogger('test-component')
      logger.info('test message', { userId: '123', action: 'create' })

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]).toMatchObject({
        level: 'info',
        component: 'test-component',
        msg: 'test message',
        userId: '123',
        action: 'create'
      })
    })

    it('should not include context when not provided', () => {
      const logger = createLogger('test-component')
      logger.info('test message')

      expect(capturedLogs).toHaveLength(1)
      const log = capturedLogs[0]
      expect(log).not.toHaveProperty('userId')
      expect(log).not.toHaveProperty('action')
    })

    it('should handle empty context object', () => {
      const logger = createLogger('test-component')
      logger.info('test message', {})

      expect(capturedLogs).toHaveLength(1)
      const log = capturedLogs[0]
      expect(log).toMatchObject({
        level: 'info',
        msg: 'test message'
      })
    })

    it('should include correlationId when provided', () => {
      const logger = createLogger('test-component', 'corr-123')
      logger.info('test message')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]).toMatchObject({
        correlationId: 'corr-123'
      })
    })

    it('should be null when correlationId not provided', () => {
      const logger = createLogger('test-component')
      logger.info('test message')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0].correlationId).toBeNull()
    })

    it('should merge context properties at top level', () => {
      const logger = createLogger('test-component', 'corr-123')
      logger.info('test message', { nested: { a: 1 }, b: 2 })

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]).toMatchObject({
        level: 'info',
        component: 'test-component',
        correlationId: 'corr-123',
        msg: 'test message',
        nested: { a: 1 },
        b: 2
      })
    })
  })

  describe('level filtering', () => {
    it('should suppress debug logs when level is info', () => {
      setLogLevel('info')
      const logger = createLogger('test-component')

      logger.debug('debug message')
      logger.info('info message')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]).toMatchObject({
        level: 'info'
      })
    })

    it('should emit info, warn, error when level is info', () => {
      setLogLevel('info')
      const logger = createLogger('test-component')

      logger.info('info message')
      logger.warn('warn message')
      logger.error('error message')

      expect(capturedLogs).toHaveLength(3)
      expect(capturedLogs[0].level).toBe('info')
      expect(capturedLogs[1].level).toBe('warn')
      expect(capturedLogs[2].level).toBe('error')
    })

    it('should suppress debug and info logs when level is warn', () => {
      setLogLevel('warn')
      const logger = createLogger('test-component')

      logger.debug('debug message')
      logger.info('info message')
      logger.warn('warn message')
      logger.error('error message')

      expect(capturedLogs).toHaveLength(2)
      expect(capturedLogs[0].level).toBe('warn')
      expect(capturedLogs[1].level).toBe('error')
    })

    it('should only emit error logs when level is error', () => {
      setLogLevel('error')
      const logger = createLogger('test-component')

      logger.debug('debug message')
      logger.info('info message')
      logger.warn('warn message')
      logger.error('error message')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0].level).toBe('error')
    })

    it('should emit all logs when level is debug', () => {
      setLogLevel('debug')
      const logger = createLogger('test-component')

      logger.debug('debug message')
      logger.info('info message')
      logger.warn('warn message')
      logger.error('error message')

      expect(capturedLogs).toHaveLength(4)
    })
  })

  describe('multiple loggers', () => {
    it('should track different component names', () => {
      const logger1 = createLogger('component-a')
      const logger2 = createLogger('component-b')

      logger1.info('message from a')
      logger2.info('message from b')

      expect(capturedLogs).toHaveLength(2)
      expect(capturedLogs[0].component).toBe('component-a')
      expect(capturedLogs[1].component).toBe('component-b')
    })

    it('should respect global log level across all loggers', () => {
      setLogLevel('warn')
      const logger1 = createLogger('component-a')
      const logger2 = createLogger('component-b')

      logger1.debug('debug from a')
      logger1.info('info from a')
      logger2.debug('debug from b')
      logger2.warn('warn from b')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]).toMatchObject({
        component: 'component-b',
        level: 'warn'
      })
    })
  })

  describe('JSON output', () => {
    it('should always output valid JSON', () => {
      const logger = createLogger('test-component', 'corr-123')
      logger.info('test', { key: 'value', number: 42, bool: true })

      expect(capturedLogs).toHaveLength(1)
      const log = capturedLogs[0]
      expect(typeof log.level).toBe('string')
      expect(typeof log.ts).toBe('string')
      expect(typeof log.component).toBe('string')
      expect(typeof log.msg).toBe('string')
    })

    it('should handle special characters in message', () => {
      const logger = createLogger('test-component')
      logger.info('test "quoted" and \\escaped\\ and\nnewline')

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0].msg).toBe('test "quoted" and \\escaped\\ and\nnewline')
    })

    it('should handle special characters in context', () => {
      const logger = createLogger('test-component')
      logger.info('test', { msg: 'quotes "here" and\\backslash' })

      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0].msg).toBe('quotes "here" and\\backslash')
    })
  })
})
