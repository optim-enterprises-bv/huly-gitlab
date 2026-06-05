interface Config {
  Port: number
  PublicBaseUrl: string
  AccountsURL: string
  ServerSecret: string
  ServiceID: string
  MongoUrl: string
  MongoDb: string
  GitLabBaseUrl: string
  GitLabClientId: string
  GitLabClientSecret: string
  CredentialEncryptionKey: string
  WebhookSecretSeed: string
  AllowedWorkspaces: string[]
  BackfillIntervalMs: number
  RateLimit: number
  LogLevel: 'debug' | 'info' | 'warn' | 'error'
  BrandingPath: string
  OAuthRedirectUri: string
  CorsAllowedOrigins: string[]
}

const envMap: Record<keyof Omit<Config, 'OAuthRedirectUri'>, string> = {
  Port: 'PORT',
  PublicBaseUrl: 'PUBLIC_BASE_URL',
  AccountsURL: 'ACCOUNTS_URL',
  ServerSecret: 'SERVER_SECRET',
  ServiceID: 'SERVICE_ID',
  MongoUrl: 'MONGO_URL',
  MongoDb: 'MONGO_DB',
  GitLabBaseUrl: 'GITLAB_BASE_URL',
  GitLabClientId: 'GITLAB_CLIENT_ID',
  GitLabClientSecret: 'GITLAB_CLIENT_SECRET',
  CredentialEncryptionKey: 'CREDENTIAL_ENCRYPTION_KEY',
  WebhookSecretSeed: 'WEBHOOK_SECRET_SEED',
  AllowedWorkspaces: 'ALLOWED_WORKSPACES',
  BackfillIntervalMs: 'BACKFILL_INTERVAL_MS',
  RateLimit: 'RATE_LIMIT',
  LogLevel: 'LOG_LEVEL',
  BrandingPath: 'BRANDING_PATH',
  CorsAllowedOrigins: 'CORS_ALLOWED_ORIGINS'
}

function getEnvOrThrow (key: keyof typeof envMap): string {
  const value = process.env[envMap[key]]
  if (value === undefined) {
    throw new Error(`Missing env variable: ${envMap[key]}`)
  }
  return value
}

export function loadConfig (): Config {
  const portStr = process.env[envMap.Port] ?? '3600'
  const port = parseInt(portStr)

  const publicBaseUrl = getEnvOrThrow('PublicBaseUrl')
  const accountsUrl = getEnvOrThrow('AccountsURL')
  const serverSecret = getEnvOrThrow('ServerSecret')
  const mongoUrl = getEnvOrThrow('MongoUrl')
  const gitLabClientId = getEnvOrThrow('GitLabClientId')
  const gitLabClientSecret = getEnvOrThrow('GitLabClientSecret')
  const credentialEncryptionKey = getEnvOrThrow('CredentialEncryptionKey')
  const webhookSecretSeed = getEnvOrThrow('WebhookSecretSeed')

  const serviceId = process.env[envMap.ServiceID] ?? 'gitlab-service'
  const mongoDb = process.env[envMap.MongoDb] ?? 'huly-gitlab'
  const gitLabBaseUrl = process.env[envMap.GitLabBaseUrl] ?? 'https://gitlab.com'
  const allowedWorkspacesStr = process.env[envMap.AllowedWorkspaces] ?? ''
  const allowedWorkspaces =
    allowedWorkspacesStr.length > 0
      ? allowedWorkspacesStr.split(',').filter((x) => x !== '')
      : ['*']
  const backfillIntervalMs = parseInt(process.env[envMap.BackfillIntervalMs] ?? '300000')
  const rateLimit = parseInt(process.env[envMap.RateLimit] ?? '25')
  const logLevel = (process.env[envMap.LogLevel] ?? 'info') as 'debug' | 'info' | 'warn' | 'error'
  const brandingPath = process.env[envMap.BrandingPath] ?? ''
  const corsAllowedOriginsStr = process.env[envMap.CorsAllowedOrigins] ?? ''
  const corsAllowedOrigins = corsAllowedOriginsStr.length > 0
    ? corsAllowedOriginsStr.split(',').map((x) => x.trim()).filter((x) => x !== '')
    : []

  // Validate CredentialEncryptionKey is 32 bytes when base64-decoded
  let decoded: Buffer
  try {
    decoded = Buffer.from(credentialEncryptionKey, 'base64')
  } catch (error) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be valid base64')
  }

  if (decoded.length !== 32) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes, got ${decoded.length}`
    )
  }

  return {
    Port: port,
    PublicBaseUrl: publicBaseUrl,
    AccountsURL: accountsUrl,
    ServerSecret: serverSecret,
    ServiceID: serviceId,
    MongoUrl: mongoUrl,
    MongoDb: mongoDb,
    GitLabBaseUrl: gitLabBaseUrl,
    GitLabClientId: gitLabClientId,
    GitLabClientSecret: gitLabClientSecret,
    CredentialEncryptionKey: credentialEncryptionKey,
    WebhookSecretSeed: webhookSecretSeed,
    AllowedWorkspaces: allowedWorkspaces,
    BackfillIntervalMs: backfillIntervalMs,
    RateLimit: rateLimit,
    LogLevel: logLevel,
    BrandingPath: brandingPath,
    OAuthRedirectUri: `${publicBaseUrl}/oauth/callback`,
    CorsAllowedOrigins: corsAllowedOrigins
  }
}

export type { Config }
