import type { PersonUuid, Ref, Space, TxOperations } from '@hcengineering/core'
import tracker, { type Issue } from '@hcengineering/tracker'
import tags, { type TagElement } from '@hcengineering/tags'
import type { Collection } from 'mongodb'
import type { IdMapDoc } from '../state/idmap'
import type { BindingDoc } from '../state/bindings'
import type { UserIdentity } from '../huly/users'
import type { Logger } from '../logging'
import type { Store } from '../state/store'
import { MR_MIXIN, readMRMixinAttributes, type MRMixinDoc } from './mr-mixin'
import { withOriginatedMarker } from './originated-marker'
import { increment, METRIC_NAMES } from '../metrics'

const HULY_CLASS_ISSUE = 'tracker:class:Issue'

const REVIEWER_LABEL_PREFIX = 'gitlab:reviewer:'

export interface ReviewerMigrationResult {
  migratedAt: string
  mrsScanned: number
  labelsStripped: number
  reviewersResolved: number
  unresolvedCount: number
}

export interface MigrateReviewerLabelsDeps {
  store: Store
  hulyClient: TxOperations
  userIdentity: UserIdentity
  logger: Logger
}

/**
 * Migrate reviewer data from Phase 2 `gitlab:reviewer:<username>` labels into
 * the typed `MRMixinDoc.reviewers` field introduced in Phase 3.
 *
 * Idempotent on re-run: when no `gitlab:reviewer:*` labels exist on an issue
 * the function is a no-op for that issue (labelsStripped=0 on second run).
 *
 * Multi-binding-safe (C12): only MR idmap entries whose gitlabId starts with
 * `${binding.gitlabProjectId}:` are touched. Other bindings' issues are never
 * read or modified.
 *
 * Bearer token is admin-global (matches Phase 2 pattern) — the caller must
 * supply an appropriately-authenticated `hulyClient`.
 *
 * Caller (HTTP route in P3-T-10) is responsible for the 409 check when the
 * binding is currently active/locked before invoking this function.
 */
export async function migrateReviewerLabels (
  deps: MigrateReviewerLabelsDeps,
  binding: BindingDoc
): Promise<ReviewerMigrationResult> {
  const { store, hulyClient, userIdentity, logger } = deps
  const hulyProjectRef = binding.hulyProjectRef as Ref<Space>

  const idmapCol: Collection<IdMapDoc> = store.idmap()

  // 1. Find all MR idmap entries for THIS binding.
  const prefix = `${binding.gitlabProjectId}:`
  // Cast through unknown to supply the $regex operator which the IdMapDoc type doesn't model.
  const cursor = idmapCol.find({
    workspaceUuid: binding.workspaceUuid,
    gitlabKind: 'merge_request',
    gitlabId: { $regex: `^${prefix}` }
  } as unknown as Parameters<typeof idmapCol.find>[0])
  const mrEntries = await cursor.toArray()

  let mrsScanned = 0
  let labelsStripped = 0
  let reviewersResolved = 0
  let unresolvedCount = 0

  for (const entry of mrEntries) {
    mrsScanned++

    if (entry.hulyClass !== HULY_CLASS_ISSUE) {
      logger.warn('reviewer-migration: idmap entry has unexpected hulyClass', {
        gitlabId: entry.gitlabId,
        hulyClass: entry.hulyClass
      })
      continue
    }

    const issueRef = entry.hulyRef as Ref<Issue>

    // 2. Load the Huly Issue.
    const hulyIssue = await hulyClient.findOne<Issue>(tracker.class.Issue, { _id: issueRef })
    if (hulyIssue === undefined) {
      logger.warn('reviewer-migration: idmap points to missing issue', {
        gitlabId: entry.gitlabId,
        hulyRef: entry.hulyRef
      })
      continue
    }

    const currentLabels: Array<Ref<TagElement>> = hulyIssue.labels ?? []
    if (currentLabels.length === 0) continue

    // 3. Resolve label docs — findAll by _id $in current labels.
    const tagDocs = await hulyClient.findAll<TagElement>(
      tags.class.TagElement,
      { _id: { $in: currentLabels } } as unknown as Partial<TagElement>
    )

    // 4. Partition: reviewer labels vs everything else.
    const reviewerTagDocs = tagDocs.filter((t) => t.title.startsWith(REVIEWER_LABEL_PREFIX))
    if (reviewerTagDocs.length === 0) continue

    const reviewerTagRefs = new Set(reviewerTagDocs.map((t) => t._id as unknown as Ref<TagElement>))
    const remainingLabels = currentLabels.filter((ref) => !reviewerTagRefs.has(ref))

    // 5. Resolve each reviewer username → PersonUuid.
    const resolvedPersonUuids: PersonUuid[] = []
    for (const tagDoc of reviewerTagDocs) {
      const username = tagDoc.title.slice(REVIEWER_LABEL_PREFIX.length)
      const personUuid = await userIdentity.mapByGitlabUser({ gitlabId: username, username })
      if (personUuid !== undefined) {
        resolvedPersonUuids.push(personUuid)
        reviewersResolved++
      } else {
        unresolvedCount++
        increment(METRIC_NAMES.MIGRATION_REVIEWER_UNRESOLVED)
        logger.warn('reviewer-migration: cannot resolve reviewer to PersonUuid', { username })
      }
    }

    // 6. Read existing typed reviewers from mixin to preserve them.
    const existingMixinReviewers: PersonUuid[] = await readExistingReviewers(
      hulyClient,
      issueRef,
      hulyProjectRef
    )

    // Merge and dedup.
    const mergedReviewers = dedup([...existingMixinReviewers, ...resolvedPersonUuids])

    // 7. Strip reviewer labels from Issue.
    labelsStripped += reviewerTagDocs.length
    await hulyClient.updateDoc<Issue>(
      tracker.class.Issue,
      hulyProjectRef,
      issueRef,
      withOriginatedMarker({ labels: remainingLabels }) as unknown as Partial<Issue>
    )

    // 8. Write merged reviewers to mixin.
    await hulyClient.updateMixin<Issue, MRMixinDoc>(
      issueRef,
      tracker.class.Issue,
      hulyProjectRef,
      MR_MIXIN,
      withOriginatedMarker({ reviewers: mergedReviewers }) as unknown as Partial<MRMixinDoc>
    )
  }

  return {
    migratedAt: new Date().toISOString(),
    mrsScanned,
    labelsStripped,
    reviewersResolved,
    unresolvedCount
  }
}

// ---------------------------------------------------------------------------

/**
 * Attempt to read existing typed reviewers from the mixin. If the mixin doc
 * does not exist yet (pre-Phase-3 issue) returns an empty array.
 */
async function readExistingReviewers (
  client: TxOperations,
  issueRef: Ref<Issue>,
  _space: Ref<Space>
): Promise<PersonUuid[]> {
  const issue = await client.findOne<Issue>(tracker.class.Issue, { _id: issueRef })
  return readMRMixinAttributes(issue).reviewers ?? []
}

function dedup<T> (arr: T[]): T[] {
  return [...new Set(arr)]
}
