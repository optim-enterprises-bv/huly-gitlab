import { loadConfig } from './config'

describe('Config', () => {
  const originalEnv = process.env

  beforeEach(() => {
    // Clear all env vars we care about
    jest.resetModules()
    process.env = { ...originalEnv }
    delete process.env.PORT
    delete process.env.PUBLIC_BASE_URL
    delete process.env.ACCOUNTS_URL
    delete process.env.SERVER_SECRET
    delete process.env.SERVICE_ID
    delete process.env.MONGO_URL
    delete process.env.MONGO_DB
    delete process.env.GITLAB_BASE_URL
    delete process.env.GITLAB_CLIENT_ID
    delete process.env.GITLAB_CLIENT_SECRET
    delete process.env.CREDENTIAL_ENCRYPTION_KEY
    delete process.env.WEBHOOK_SECRET_SEED
    delete process.env.ALLOWED_WORKSPACES
    delete process.env.BACKFILL_INTERVAL_MS
    delete process.env.RATE_LIMIT
    delete process.env.LOG_LEVEL
    delete process.env.BRANDING_PATH
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('missing required env', () => {
    it('should throw when PUBLIC_BASE_URL is missing', () => {
      expect(() => loadConfig()).toThrow('Missing env variable: PUBLIC_BASE_URL')
    })

    it('should throw when ACCOUNTS_URL is missing', () => {
      process.env.PUBLIC_BASE_URL = 'http://localhost:3600'
      process.env.SERVER_SECRET = 'secret'
      process.env.MONGO_URL = 'mongodb://localhost'
      process.env.GITLAB_CLIENT_ID = 'id'
      process.env.GITLAB_CLIENT_SECRET = 'secret'
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')
      process.env.WEBHOOK_SECRET_SEED = 'seed'

      expect(() => loadConfig()).toThrow('Missing env variable: ACCOUNTS_URL')
    })

    it('should throw when CREDENTIAL_ENCRYPTION_KEY is missing', () => {
      process.env.PUBLIC_BASE_URL = 'http://localhost:3600'
      process.env.ACCOUNTS_URL = 'http://accounts'
      process.env.SERVER_SECRET = 'secret'
      process.env.MONGO_URL = 'mongodb://localhost'
      process.env.GITLAB_CLIENT_ID = 'id'
      process.env.GITLAB_CLIENT_SECRET = 'secret'
      process.env.WEBHOOK_SECRET_SEED = 'seed'

      expect(() => loadConfig()).toThrow('Missing env variable: CREDENTIAL_ENCRYPTION_KEY')
    })

    it('should throw when WEBHOOK_SECRET_SEED is missing', () => {
      process.env.PUBLIC_BASE_URL = 'http://localhost:3600'
      process.env.ACCOUNTS_URL = 'http://accounts'
      process.env.SERVER_SECRET = 'secret'
      process.env.MONGO_URL = 'mongodb://localhost'
      process.env.GITLAB_CLIENT_ID = 'id'
      process.env.GITLAB_CLIENT_SECRET = 'secret'
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')

      expect(() => loadConfig()).toThrow('Missing env variable: WEBHOOK_SECRET_SEED')
    })
  })

  describe('AllowedWorkspaces CSV parsing', () => {
    beforeEach(() => {
      // Set all required env
      process.env.PUBLIC_BASE_URL = 'http://localhost:3600'
      process.env.ACCOUNTS_URL = 'http://accounts'
      process.env.SERVER_SECRET = 'secret'
      process.env.MONGO_URL = 'mongodb://localhost'
      process.env.GITLAB_CLIENT_ID = 'id'
      process.env.GITLAB_CLIENT_SECRET = 'secret'
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')
      process.env.WEBHOOK_SECRET_SEED = 'seed'
    })

    it('should parse CSV into array', () => {
      process.env.ALLOWED_WORKSPACES = 'a,b,c'
      const config = loadConfig()
      expect(config.AllowedWorkspaces).toEqual(['a', 'b', 'c'])
    })

    it('should default to [*] when not set', () => {
      delete process.env.ALLOWED_WORKSPACES
      const config = loadConfig()
      expect(config.AllowedWorkspaces).toEqual(['*'])
    })

    it('should default to [*] when empty string', () => {
      process.env.ALLOWED_WORKSPACES = ''
      const config = loadConfig()
      expect(config.AllowedWorkspaces).toEqual(['*'])
    })

    it('should handle single value', () => {
      process.env.ALLOWED_WORKSPACES = 'single'
      const config = loadConfig()
      expect(config.AllowedWorkspaces).toEqual(['single'])
    })
  })

  describe('integer parsing', () => {
    beforeEach(() => {
      // Set all required env
      process.env.PUBLIC_BASE_URL = 'http://localhost:3600'
      process.env.ACCOUNTS_URL = 'http://accounts'
      process.env.SERVER_SECRET = 'secret'
      process.env.MONGO_URL = 'mongodb://localhost'
      process.env.GITLAB_CLIENT_ID = 'id'
      process.env.GITLAB_CLIENT_SECRET = 'secret'
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')
      process.env.WEBHOOK_SECRET_SEED = 'seed'
    })

    it('should parse Port from env', () => {
      process.env.PORT = '4000'
      const config = loadConfig()
      expect(config.Port).toBe(4000)
      expect(typeof config.Port).toBe('number')
    })

    it('should default Port to 3600', () => {
      delete process.env.PORT
      const config = loadConfig()
      expect(config.Port).toBe(3600)
    })

    it('should parse BackfillIntervalMs from env', () => {
      process.env.BACKFILL_INTERVAL_MS = '600000'
      const config = loadConfig()
      expect(config.BackfillIntervalMs).toBe(600000)
      expect(typeof config.BackfillIntervalMs).toBe('number')
    })

    it('should default BackfillIntervalMs to 300000', () => {
      delete process.env.BACKFILL_INTERVAL_MS
      const config = loadConfig()
      expect(config.BackfillIntervalMs).toBe(300000)
    })

    it('should parse RateLimit from env', () => {
      process.env.RATE_LIMIT = '50'
      const config = loadConfig()
      expect(config.RateLimit).toBe(50)
      expect(typeof config.RateLimit).toBe('number')
    })

    it('should default RateLimit to 25', () => {
      delete process.env.RATE_LIMIT
      const config = loadConfig()
      expect(config.RateLimit).toBe(25)
    })
  })

  describe('CredentialEncryptionKey validation', () => {
    beforeEach(() => {
      // Set all required env
      process.env.PUBLIC_BASE_URL = 'http://localhost:3600'
      process.env.ACCOUNTS_URL = 'http://accounts'
      process.env.SERVER_SECRET = 'secret'
      process.env.MONGO_URL = 'mongodb://localhost'
      process.env.GITLAB_CLIENT_ID = 'id'
      process.env.GITLAB_CLIENT_SECRET = 'secret'
      process.env.WEBHOOK_SECRET_SEED = 'seed'
    })

    it('should accept base64 key that decodes to 32 bytes', () => {
      const key = Buffer.alloc(32).toString('base64')
      process.env.CREDENTIAL_ENCRYPTION_KEY = key
      const config = loadConfig()
      expect(config.CredentialEncryptionKey).toBe(key)
    })

    it('should throw if decoded key is not 32 bytes', () => {
      const key = Buffer.alloc(31).toString('base64')
      process.env.CREDENTIAL_ENCRYPTION_KEY = key
      expect(() => loadConfig()).toThrow('must decode to 32 bytes')
    })

    it('should throw if key is not valid base64', () => {
      // Invalid base64 due to incorrect padding
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'A'.repeat(50)
      expect(() => loadConfig()).toThrow('must decode to 32 bytes')
    })

    it('should throw if key is too long when decoded', () => {
      const key = Buffer.alloc(33).toString('base64')
      process.env.CREDENTIAL_ENCRYPTION_KEY = key
      expect(() => loadConfig()).toThrow('must decode to 32 bytes')
    })
  })

  describe('OAuthRedirectUri derivation', () => {
    beforeEach(() => {
      // Set all required env
      process.env.ACCOUNTS_URL = 'http://accounts'
      process.env.SERVER_SECRET = 'secret'
      process.env.MONGO_URL = 'mongodb://localhost'
      process.env.GITLAB_CLIENT_ID = 'id'
      process.env.GITLAB_CLIENT_SECRET = 'secret'
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')
      process.env.WEBHOOK_SECRET_SEED = 'seed'
    })

    it('should derive OAuthRedirectUri from PublicBaseUrl', () => {
      process.env.PUBLIC_BASE_URL = 'http://localhost:3600'
      const config = loadConfig()
      expect(config.OAuthRedirectUri).toBe('http://localhost:3600/oauth/callback')
    })

    it('should handle trailing slashes', () => {
      process.env.PUBLIC_BASE_URL = 'http://localhost:3600/'
      const config = loadConfig()
      expect(config.OAuthRedirectUri).toBe('http://localhost:3600//oauth/callback')
    })

    it('should handle https URLs', () => {
      process.env.PUBLIC_BASE_URL = 'https://gitlab.example.com'
      const config = loadConfig()
      expect(config.OAuthRedirectUri).toBe('https://gitlab.example.com/oauth/callback')
    })
  })

  describe('default values', () => {
    beforeEach(() => {
      // Set all required env
      process.env.PUBLIC_BASE_URL = 'http://localhost:3600'
      process.env.ACCOUNTS_URL = 'http://accounts'
      process.env.SERVER_SECRET = 'secret'
      process.env.MONGO_URL = 'mongodb://localhost'
      process.env.GITLAB_CLIENT_ID = 'id'
      process.env.GITLAB_CLIENT_SECRET = 'secret'
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')
      process.env.WEBHOOK_SECRET_SEED = 'seed'
    })

    it('should default ServiceID to gitlab-service', () => {
      delete process.env.SERVICE_ID
      const config = loadConfig()
      expect(config.ServiceID).toBe('gitlab-service')
    })

    it('should use SERVICE_ID when provided', () => {
      process.env.SERVICE_ID = 'custom-service'
      const config = loadConfig()
      expect(config.ServiceID).toBe('custom-service')
    })

    it('should default MongoDb to huly-gitlab', () => {
      delete process.env.MONGO_DB
      const config = loadConfig()
      expect(config.MongoDb).toBe('huly-gitlab')
    })

    it('should use MONGO_DB when provided', () => {
      process.env.MONGO_DB = 'custom-db'
      const config = loadConfig()
      expect(config.MongoDb).toBe('custom-db')
    })

    it('should default GitLabBaseUrl to https://gitlab.com', () => {
      delete process.env.GITLAB_BASE_URL
      const config = loadConfig()
      expect(config.GitLabBaseUrl).toBe('https://gitlab.com')
    })

    it('should use GITLAB_BASE_URL when provided', () => {
      process.env.GITLAB_BASE_URL = 'https://gitlab.example.com'
      const config = loadConfig()
      expect(config.GitLabBaseUrl).toBe('https://gitlab.example.com')
    })

    it('should default LogLevel to info', () => {
      delete process.env.LOG_LEVEL
      const config = loadConfig()
      expect(config.LogLevel).toBe('info')
    })

    it('should use LOG_LEVEL when provided', () => {
      process.env.LOG_LEVEL = 'debug'
      const config = loadConfig()
      expect(config.LogLevel).toBe('debug')
    })

    it('should default BrandingPath to empty string', () => {
      delete process.env.BRANDING_PATH
      const config = loadConfig()
      expect(config.BrandingPath).toBe('')
    })

    it('should use BRANDING_PATH when provided', () => {
      process.env.BRANDING_PATH = '/path/to/branding'
      const config = loadConfig()
      expect(config.BrandingPath).toBe('/path/to/branding')
    })
  })

  describe('full config load', () => {
    it('should load a complete valid config', () => {
      process.env.PORT = '4000'
      process.env.PUBLIC_BASE_URL = 'http://localhost:4000'
      process.env.ACCOUNTS_URL = 'http://accounts'
      process.env.SERVER_SECRET = 'my-secret'
      process.env.SERVICE_ID = 'my-service'
      process.env.MONGO_URL = 'mongodb://localhost:27017'
      process.env.MONGO_DB = 'my-db'
      process.env.GITLAB_BASE_URL = 'https://gitlab.example.com'
      process.env.GITLAB_CLIENT_ID = 'client-id'
      process.env.GITLAB_CLIENT_SECRET = 'client-secret'
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')
      process.env.WEBHOOK_SECRET_SEED = 'seed'
      process.env.ALLOWED_WORKSPACES = 'ws1,ws2'
      process.env.BACKFILL_INTERVAL_MS = '600000'
      process.env.RATE_LIMIT = '50'
      process.env.LOG_LEVEL = 'debug'
      process.env.BRANDING_PATH = '/branding'

      const config = loadConfig()

      expect(config).toMatchObject({
        Port: 4000,
        PublicBaseUrl: 'http://localhost:4000',
        AccountsURL: 'http://accounts',
        ServerSecret: 'my-secret',
        ServiceID: 'my-service',
        MongoUrl: 'mongodb://localhost:27017',
        MongoDb: 'my-db',
        GitLabBaseUrl: 'https://gitlab.example.com',
        GitLabClientId: 'client-id',
        GitLabClientSecret: 'client-secret',
        WebhookSecretSeed: 'seed',
        AllowedWorkspaces: ['ws1', 'ws2'],
        BackfillIntervalMs: 600000,
        RateLimit: 50,
        LogLevel: 'debug',
        BrandingPath: '/branding',
        OAuthRedirectUri: 'http://localhost:4000/oauth/callback'
      })
    })
  })
})
