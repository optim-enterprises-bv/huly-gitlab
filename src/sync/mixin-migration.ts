import type { Ref, Space, TxOperations } from '@hcengineering/core'
import tracker, { type Issue } from '@hcengineering/tracker'
import type { Collection } from 'mongodb'
import type { IdMapDoc } from '../state/idmap'
import type { BindingDoc } from '../state/bindings'
import type { Logger } from '../logging'
import type { Store } from '../state/store'
import { getBinding } from '../state/bindings'
import { MR_MIXIN, type MRMixinDoc } from './mr-mixin'
import { MR_CORE_MIXIN, type MRCoreMixinDoc } from './mr-core-mixin'
import { MR_REVIEW_MIXIN_DOC, type MRReviewMixinDoc } from './mr-review-mixin-doc'
import { withOriginatedMarker } from './originated-marker'

const HULY_CLASS_ISSUE = 'tracker:class:Issue'

const CORE_FIELD_KEYS: Array<keyof MRCoreMixinDoc> = [
  'sourceBranch',
  'targetBranch',
  'draft',
  'mergedAt',
  'mergeStatus',
  'webUrl',
  'gitlabIid',
  'gitlabProjectId'
]

const REVIEW_FIELD_KEYS: Array<keyof MRReviewMixinDoc> = [
  'reviewers',
  'approvedBy',
  'approvalsRequired',
  'approvalStatus',
  'diffWebUrl',
  'changedFiles',
  'approvalRules',
  'iteration',
  'parentEpicIid'
]

const DEFAULT_DRAIN_TIMEOUT_MS = 5 * 60 * 1000
const DRAIN_POLL_INTERVAL_MS = 1000

export interface MixinSplitMigrationResult {
  migratedAt: string
  mrsScanned: number
  legacyStripped: number
  coreWritten: number
  reviewWritten: number
  /** MRs where legacy attrs couldn't be split (missing required core fields). Rare. */
  unresolvedCount: number
  /** Set when the backfill drain wait timed out before the strip step ran. */
  drainTimedOut?: boolean
  /** Set to false when the migration was aborted due to a precondition failure. */
  success?: boolean
  /** Human-readable reason for abort (only set when success === false). */
  reason?: string
}

export interface MigrateMixinSplitDeps {
  store: Store
  hulyClient: TxOperations
  logger: Logger
  /** Override the 5-minute backfill drain timeout. Tests may set this to 0 to skip the wait. */
  drainTimeoutMs?: number
  /** Override the poll interval for the backfill drain wait. */
  drainPollIntervalMs?: number
}

/**
 * One-shot, operator-paused migration that moves data from the legacy
 * `gitlab-mr` mixin into the Phase 5 split (`gitlab-mr-core` +
 * `gitlab-mr-review`).
 *
 * Caller (HTTP route) MUST verify `binding.disabled === true` BEFORE invoking
 * this function — the route enforces the operator-paused contract from Phase 3
 * (`migrate-reviewer-labels`). Running on an active binding risks racing with
 * applyRemote writes.
 *
 * **Critic B4 — backfill drain coordination:** before stripping the legacy
 * mixin, this helper polls `binding.backfillInFlight` (re-reading the binding
 * doc via the store on each tick) until the flag clears OR `drainTimeoutMs`
 * elapses (default 5 minutes). On timeout the function returns a partial
 * result with `drainTimedOut: true` and does NOT strip any legacy mixins —
 * the operator must retry. If the binding never had backfill running, the
 * wait returns immediately.
 *
 * Idempotent: re-running on an Issue that already has the new core+review
 * mixins is a no-op for that Issue (no duplicate writes; legacy strip still
 * runs if a leftover legacy mixin is present so partial-progress states from
 * a prior interrupted run converge).
 *
 * Multi-binding isolated: only idmap entries whose `gitlabId` starts with
 * `${binding.gitlabProjectId}:` AND whose `workspaceUuid` matches are
 * touched. Other bindings' MRs are never read or modified.
 */
export async function migrateMixinSplit (
  deps: MigrateMixinSplitDeps,
  binding: BindingDoc
): Promise<MixinSplitMigrationResult> {
  const { store, hulyClient, logger } = deps
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  const drainPollIntervalMs = deps.drainPollIntervalMs ?? DRAIN_POLL_INTERVAL_MS

  const hulyProjectRef = binding.hulyProjectRef as Ref<Space>
  const idmapCol: Collection<IdMapDoc> = store.idmap()

  const result: MixinSplitMigrationResult = {
    migratedAt: new Date().toISOString(),
    mrsScanned: 0,
    legacyStripped: 0,
    coreWritten: 0,
    reviewWritten: 0,
    unresolvedCount: 0
  }

  // B4: wait for in-flight backfill to drain before stripping legacy mixins.
  const drained = await waitForBackfillDrain(
    store,
    binding._id.toHexString(),
    drainTimeoutMs,
    drainPollIntervalMs
  )
  if (!drained) {
    logger.warn('mixin-migration: backfill drain timed out; aborting before strip', {
      bindingId: binding._id.toHexString(),
      drainTimeoutMs
    })
    result.drainTimedOut = true
    return result
  }

  // M-5: re-read binding after drain to ensure it is still paused. If the operator
  // un-paused the binding mid-drain, abort to avoid racing with applyRemote writes.
  const bindingAfterDrain = await getBinding(store.bindings(), binding._id.toHexString())
  if (bindingAfterDrain?.disabled !== true) {
    logger.warn('mixin-migration: binding un-paused during drain; aborting', {
      bindingId: binding._id.toHexString()
    })
    return { ...result, success: false, reason: 'binding_unpaused_during_drain' }
  }

  // 1. Find all MR idmap entries for THIS binding.
  const prefix = `${binding.gitlabProjectId}:`
  const cursor = idmapCol.find({
    workspaceUuid: binding.workspaceUuid,
    gitlabKind: 'merge_request',
    gitlabId: { $regex: `^${prefix}` }
  } as unknown as Parameters<typeof idmapCol.find>[0])
  const mrEntries = await cursor.toArray()

  for (const entry of mrEntries) {
    result.mrsScanned++

    if (entry.hulyClass !== HULY_CLASS_ISSUE) {
      logger.warn('mixin-migration: idmap entry has unexpected hulyClass', {
        gitlabId: entry.gitlabId,
        hulyClass: entry.hulyClass
      })
      continue
    }

    const issueRef = entry.hulyRef as Ref<Issue>

    // 2. Read the Issue carrying the mixins. We fetch the base Issue first; mixin
    //    attrs live under the mixin id keys on the same doc shape returned by the
    //    Huly platform.
    const issueDoc = await hulyClient.findOne<Issue>(tracker.class.Issue, { _id: issueRef })
    if (issueDoc === undefined) {
      logger.warn('mixin-migration: idmap points to missing issue', {
        gitlabId: entry.gitlabId,
        hulyRef: entry.hulyRef
      })
      continue
    }

    const docObj = issueDoc as unknown as Record<string, unknown>
    const legacyAttrs = docObj[MR_MIXIN as unknown as string] as Partial<MRMixinDoc> | undefined
    const coreAttrs = docObj[MR_CORE_MIXIN as unknown as string] as Partial<MRCoreMixinDoc> | undefined
    const reviewAttrs = docObj[MR_REVIEW_MIXIN_DOC as unknown as string] as Partial<MRReviewMixinDoc> | undefined

    const hasLegacy = legacyAttrs !== undefined && Object.keys(legacyAttrs).length > 0
    const hasNewCore = coreAttrs !== undefined && Object.keys(coreAttrs).length > 0
    const hasNewReview = reviewAttrs !== undefined && Object.keys(reviewAttrs).length > 0

    // Case: no legacy mixin → nothing to do (idempotent re-run OR fresh Phase 5 write).
    if (!hasLegacy) continue

    // 3. Build new mixin payloads from legacy when new ones are missing.
    let wroteCore = false
    let wroteReview = false

    if (!hasNewCore) {
      const corePayload = pickFields(legacyAttrs, CORE_FIELD_KEYS) as Partial<MRCoreMixinDoc>
      // Require all 8 core fields to be present; if any are missing the legacy doc
      // is malformed (rare) — count as unresolved and skip the write.
      const missingCore = CORE_FIELD_KEYS.filter((k) => corePayload[k] === undefined)
      if (missingCore.length > 0) {
        logger.warn('mixin-migration: legacy mixin missing required core fields', {
          gitlabId: entry.gitlabId,
          missing: missingCore
        })
        result.unresolvedCount++
        continue
      }
      await hulyClient.createMixin<Issue, MRCoreMixinDoc>(
        issueRef,
        tracker.class.Issue,
        hulyProjectRef,
        MR_CORE_MIXIN,
        withOriginatedMarker(corePayload as unknown as Record<string, unknown>) as unknown as MRCoreMixinDoc
      )
      result.coreWritten++
      wroteCore = true
    }

    if (!hasNewReview) {
      const reviewPayload = pickDefinedFields(legacyAttrs, REVIEW_FIELD_KEYS) as Partial<MRReviewMixinDoc>
      if (Object.keys(reviewPayload).length > 0) {
        await hulyClient.createMixin<Issue, MRReviewMixinDoc>(
          issueRef,
          tracker.class.Issue,
          hulyProjectRef,
          MR_REVIEW_MIXIN_DOC,
          withOriginatedMarker(reviewPayload as unknown as Record<string, unknown>) as unknown as MRReviewMixinDoc
        )
        result.reviewWritten++
        wroteReview = true
      }
    }

    // 4. Strip the legacy mixin. We clear every key via updateMixin attrs={...all keys → undefined}.
    //    The Huly platform's `updateMixin` writes the supplied attribute map; setting each field to
    //    `undefined` removes it from the persisted mixin shape. This is the closest portable analogue
    //    to a true remove-mixin op which the platform vendor.d.ts does not yet expose.
    const stripAttrs: Record<string, unknown> = {}
    for (const k of Object.keys(legacyAttrs)) {
      stripAttrs[k] = undefined
    }
    await hulyClient.updateMixin<Issue, MRMixinDoc>(
      issueRef,
      tracker.class.Issue,
      hulyProjectRef,
      MR_MIXIN,
      stripAttrs as unknown as Partial<MRMixinDoc>
    )
    result.legacyStripped++

    if (wroteCore || wroteReview) {
      logger.debug('mixin-migration: migrated MR', {
        gitlabId: entry.gitlabId,
        wroteCore,
        wroteReview
      })
    }
  }

  return result
}

// ---------------------------------------------------------------------------

function pickFields<T extends Record<string, unknown>, K extends keyof T> (
  src: T | undefined,
  keys: K[]
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {}
  if (src === undefined) return out
  for (const k of keys) {
    if (src[k] !== undefined) {
      out[k] = src[k]
    }
  }
  return out
}

function pickDefinedFields<T extends Record<string, unknown>, K extends keyof T> (
  src: T | undefined,
  keys: K[]
): Partial<Pick<T, K>> {
  return pickFields(src, keys)
}

/**
 * Poll the binding doc until `backfillInFlight !== true` OR the timeout elapses.
 * Returns `true` if the wait completed (drained or never set), `false` if it
 * timed out and the caller should abort before stripping.
 *
 * The poll re-fetches the binding from the store so flag changes made by the
 * lifecycle service while the migration is running are observed.
 */
async function waitForBackfillDrain (
  store: Store,
  bindingId: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<boolean> {
  if (timeoutMs <= 0) return true
  const deadline = Date.now() + timeoutMs
  // First read: the live doc may already be drained.
  // We tolerate the flag being entirely absent — it is OPTIONAL on BindingDoc
  // and treated as "not in flight" by default.
  while (Date.now() < deadline) {
    const cur = await getBinding(store.bindings(), bindingId)
    const inFlight = (cur as unknown as { backfillInFlight?: boolean } | null)?.backfillInFlight === true
    if (!inFlight) return true
    await sleep(pollIntervalMs)
  }
  // Final check after timeout to avoid a race where the flag cleared right at the deadline.
  const final = await getBinding(store.bindings(), bindingId)
  return (final as unknown as { backfillInFlight?: boolean } | null)?.backfillInFlight !== true
}

async function sleep (ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}
