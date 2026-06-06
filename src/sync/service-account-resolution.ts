/**
 * Service-account PersonId resolution — Path F and Path G.
 *
 * Resolution chain (first success wins):
 *   Path F: operator-provided via SERVICE_ACCOUNT_PERSON_ID env var (config.ServiceAccountPersonId).
 *   Path G: boot-time probe — write a sentinel doc, read back modifiedBy, delete the sentinel.
 *   Path D: fallback sentinel cast of systemAccountUuid (existing behavior, callers supply it).
 *
 * Returns `{ personId, resolved }`:
 *   - `personId`  — the resolved PersonId string (cast to PersonId brand by caller)
 *   - `resolved`  — true if Path F or G succeeded; false if Path D fallback is in use.
 *
 * Path G probe details:
 *   - Writes a sentinel doc using TxOperations.createDoc on a system space (SYSTEM_SPACE).
 *   - Reads it back via client.findOne to capture createdBy / modifiedBy.
 *   - Deletes via removeDoc (passed as a callback to avoid hard import of platform ops).
 *   - Bounded by PROBE_TIMEOUT_MS (10 s). On timeout or any error, falls through to Path D.
 */

import type { PersonId } from '@hcengineering/core'
import type { Logger } from '../logging'

export const PROBE_TIMEOUT_MS = 10_000

/**
 * Minimal interface for the boot-time probe.
 * Callers provide a real TxOperations-shaped client; tests inject fakes.
 */
export interface ProbeClient {
  /** Create a doc and return its new ref string. */
  createDoc: (space: string, attributes: Record<string, unknown>) => Promise<string>
  /** Read back a doc by ref; returns the raw doc object or undefined. */
  findByRef: (ref: string) => Promise<Record<string, unknown> | undefined>
  /** Delete the doc by ref. */
  removeDoc: (ref: string) => Promise<void>
}

export interface ResolutionResult {
  personId: string
  resolved: boolean
  path: 'F' | 'G' | 'D'
}

/**
 * Attempt Path F: use the operator-supplied PersonId from config.
 * Returns the value if present and non-empty, otherwise undefined.
 */
export function tryPathF (serviceAccountPersonIdFromConfig: string | undefined): string | undefined {
  if (serviceAccountPersonIdFromConfig !== undefined && serviceAccountPersonIdFromConfig !== '') {
    return serviceAccountPersonIdFromConfig
  }
  return undefined
}

/**
 * Attempt Path G: boot-time probe to discover the service-account PersonId.
 *
 * Creates a sentinel doc using the provided ProbeClient (which operates as the
 * service account), reads back the `modifiedBy` field, and deletes the sentinel.
 * Returns the discovered PersonId string on success, or undefined on failure/timeout.
 */
export async function tryPathG (
  probeClient: ProbeClient,
  logger: Logger
): Promise<string | undefined> {
  const raceResult = await Promise.race([
    runProbe(probeClient, logger),
    new Promise<undefined>((resolve) => {
      setTimeout(() => { resolve(undefined) }, PROBE_TIMEOUT_MS)
    })
  ])
  return raceResult
}

async function runProbe (probeClient: ProbeClient, logger: Logger): Promise<string | undefined> {
  let sentinelRef: string | undefined
  try {
    sentinelRef = await probeClient.createDoc(
      'core:space:Model' as string,
      { _probe: 'service-account-resolution', _probeTs: Date.now() }
    )

    const doc = await probeClient.findByRef(sentinelRef)
    if (doc === undefined) {
      logger.warn('service-account-resolution: Path G probe doc not found after create')
      return undefined
    }

    const modifiedBy = doc.modifiedBy as string | undefined
    if (modifiedBy === undefined || modifiedBy === '') {
      logger.warn('service-account-resolution: Path G probe returned empty modifiedBy')
      return undefined
    }

    logger.info('service-account-resolution: Path G probe succeeded', { personId: modifiedBy })
    return modifiedBy
  } catch (err) {
    logger.warn('service-account-resolution: Path G probe error', {
      err: err instanceof Error ? err.message : String(err)
    })
    return undefined
  } finally {
    if (sentinelRef !== undefined) {
      try {
        await probeClient.removeDoc(sentinelRef)
      } catch (cleanupErr) {
        logger.warn('service-account-resolution: Path G probe cleanup error', {
          err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        })
      }
    }
  }
}

/**
 * Full resolution chain: Path F → Path G → Path D.
 *
 * @param configPersonId   Value of config.ServiceAccountPersonId (Path F source).
 * @param probeClient      Optional probe client for Path G. If undefined, Path G is skipped.
 * @param pathDFallback    PersonId string to use when both F and G fail (Path D sentinel).
 * @param logger           Logger instance.
 */
export async function resolveServiceAccountPersonId (
  configPersonId: string | undefined,
  probeClient: ProbeClient | undefined,
  pathDFallback: string,
  logger: Logger
): Promise<ResolutionResult> {
  // Path F
  const pathF = tryPathF(configPersonId)
  if (pathF !== undefined) {
    logger.info('service-account-resolution: Path F engaged (operator-provided)', { personId: pathF })
    return { personId: pathF, resolved: true, path: 'F' }
  }

  // Path G
  if (probeClient !== undefined) {
    const pathG = await tryPathG(probeClient, logger)
    if (pathG !== undefined) {
      logger.info('service-account-resolution: Path G engaged (boot-time probe)', { personId: pathG })
      return { personId: pathG, resolved: true, path: 'G' }
    }
  }

  // Path D fallback
  logger.info('service-account-resolution: Path D fallback (systemAccountUuid sentinel)', {
    personId: pathDFallback
  })
  return { personId: pathDFallback, resolved: false, path: 'D' }
}

// Re-export PersonId type for test/caller convenience
export type { PersonId }
