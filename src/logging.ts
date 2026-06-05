import type { Config } from './config'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface Logger {
  debug: (msg: string, ctx?: Record<string, unknown>) => void
  info: (msg: string, ctx?: Record<string, unknown>) => void
  warn: (msg: string, ctx?: Record<string, unknown>) => void
  error: (msg: string, ctx?: Record<string, unknown>) => void
}

const levelOrder: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

let currentLogLevel: LogLevel = 'info'

export function setLogLevel (level: LogLevel): void {
  currentLogLevel = level
}

export function createLogger (component: string, correlationId: string | null = null): Logger {
  const shouldLog = (level: LogLevel): boolean => {
    return levelOrder[level] >= levelOrder[currentLogLevel]
  }

  const log = (level: LogLevel, msg: string, ctx?: Record<string, unknown>): void => {
    if (!shouldLog(level)) {
      return
    }

    const output: Record<string, unknown> = {
      level,
      ts: new Date().toISOString(),
      component,
      correlationId,
      msg
    }

    if (ctx !== undefined && Object.keys(ctx).length > 0) {
      Object.assign(output, ctx)
    }

    console.log(JSON.stringify(output))
  }

  return {
    debug: (msg, ctx) => {
      log('debug', msg, ctx)
    },
    info: (msg, ctx) => {
      log('info', msg, ctx)
    },
    warn: (msg, ctx) => {
      log('warn', msg, ctx)
    },
    error: (msg, ctx) => {
      log('error', msg, ctx)
    }
  }
}

export function initializeLogging (config: Config): void {
  setLogLevel(config.LogLevel)
}

export type { Logger, LogLevel }
