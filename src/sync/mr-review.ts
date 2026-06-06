import type { PersonUuid, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import chunter, { type ChatMessage } from '@hcengineering/chunter'
import tracker, { type Issue } from '@hcengineering/tracker'
import type {
  SyncReviewThread,
  SyncUser as AdapterUser
} from '../adapter/types'
import { gfmMarkdownToMarkup } from '../markdown'
import { findByGitlab, findByHuly, upsertIdMap } from '../state/idmap'
import { setCursor } from '../state/cursors'
import { prefixGitlabIdForMultiInstance } from './multi-instance'
import type { SyncUser as IdentitySyncUser, UserIdentity } from '../huly/users'
import { MR_REVIEW_THREAD_MIXIN, type MRReviewThreadMixinDoc } from './mr-review-thread-mixin'
import type { BindingRef, SyncContext, SyncManager } from './types'
import * as metrics from '../metrics'
import { METRIC_NAMES } from '../metrics'
import type { MirrorDeps } from './attachments'
import { markAndRetry, REVIEW_RETRY_FLAG } from './deferred-parent'
import { withOriginatedMarker } from './originated-marker'

const HULY_CLASS_CHAT_MESSAGE = 'chunter.class.ChatMessage'

/**
 * Loaded binding context for ReviewThreadsSyncManager.
 *
 * Note: `credentials` is intentionally NOT on this context (B4) — only the MR
 * manager needs it. Resolution actions here use the binding's service-account
 * token via the gitlabClient.
 */
export interface MRReviewBindingContext {
  workspaceUuid: WorkspaceUuid
  gitlabProjectId: number
  gitlabProjectPath: string
  hulyProjectRef: Ref<Space>
  hulyClient: TxOperations
  gitlabClient: MRReviewGitLabClient
  userIdentity: UserIdentity
  gitlabBaseUrl: string
  /**
   * B1: true when ≥ 2 distinct GitLab base URLs are registered for this
   * workspace. When true, the `merge_request` idmap lookup for the parent
   * MR is prefixed via `prefixGitlabIdForMultiInstance` to avoid TG-4
   * cross-instance collisions. Review-thread idmap keys
   * (`${discussionId}:${noteId}`) are intrinsically discussion-scoped and
   * therefore not affected.
   */
  isMultiInstanceWorkspace?: boolean
  /**
   * Optional attachment mirror deps. When present (wired by BindingLoader when
   * mirrorCol is provided), attachment links in review thread bodies are
   * mirrored. When absent, link-through is used.
   */
  mirrorDeps?: MirrorDeps
}

/**
 * GitLab client surface used by ReviewThreadsSyncManager. The full GitLabClient
 * satisfies this structurally; tests pass a small fake.
 */
export interface MRReviewGitLabClient {
  listMergeRequests: (
    projectId: number | string,
    opts: { updatedAfter?: Date }
  ) => Promise<Array<{ iid: number }>>
  listDiscussions: (
    projectId: number | string,
    mrIid: number,
    opts: { updatedAfter?: Date }
  ) => Promise<SyncReviewThread[]>
  resolveDiscussion: (
    projectId: number | string,
    mrIid: number,
    discussionId: string,
    resolved: boolean,
    actorToken?: string
  ) => Promise<void>
}

export type MRReviewBindingLoader = (binding: BindingRef) => Promise<MRReviewBindingContext>

export type MRReviewBackfillEnqueuerFn = (
  binding: BindingRef,
  kind: string,
  record: Record<string, unknown>,
  eventId: string,
  version: string
) => Promise<void> | void

export interface MRReviewBackfillEnqueuer {
  enqueueBackfillRecord: MRReviewBackfillEnqueuerFn
}

export interface ReviewThreadsSyncManagerDeps {
  loadBinding: MRReviewBindingLoader
  /** Object form preserved for test ergonomics. */
  enqueuer?: MRReviewBackfillEnqueuer
  /** Function form preferred for new wiring. */
  backfillEnqueuer?: MRReviewBackfillEnqueuerFn
}

/**
 * ReviewThreadsSyncManager — sync for GitLab MR review threads (discussions).
 *
 * Per-note storage (Q1 v2 resolution): every ChatMessage in a thread carries
 * the `gitlab-review` mixin with its own `threadId`, `resolved`, `resolvedBy`,
 * and `resolvedAt` replicated. `position` is set ONLY on the root note;
 * replies have `position: undefined`. Distinct idmap rows per note:
 * key format `${discussionId}:${noteId}`.
 *
 * Field-ownership: this manager exclusively writes the `gitlab-review` mixin.
 * It does NOT touch any `gitlab-mr` field.
 *
 * applyLocal scope: ONLY resolution flips. Body edits are routed through
 * NotesSyncManager.applyLocal (existing Phase 2 path).
 */
export class ReviewThreadsSyncManager implements SyncManager<SyncReviewThread> {
  readonly kind = 'review'

  constructor (private readonly deps: ReviewThreadsSyncManagerDeps) {}

  resourceKey (record: Record<string, unknown>): string | undefined {
    const direct = record.discussionId ?? record.discussion_id
    if (typeof direct === 'string' && direct.length > 0) return `review:${direct}`
    const objAttrs = record.object_attributes
    if (objAttrs !== null && typeof objAttrs === 'object') {
      const d = (objAttrs as Record<string, unknown>).discussion_id
      if (typeof d === 'string' && d.length > 0) return `review:${d}`
    }
    return undefined
  }

  private async enqueueRecord (
    binding: BindingRef,
    kind: string,
    record: Record<string, unknown>,
    eventId: string,
    version: string
  ): Promise<void> {
    if (this.deps.backfillEnqueuer !== undefined) {
      await this.deps.backfillEnqueuer(binding, kind, record, eventId, version)
      return
    }
    if (this.deps.enqueuer !== undefined) {
      await this.deps.enqueuer.enqueueBackfillRecord(binding, kind, record, eventId, version)
    }
  }

  async applyRemote (
    ctx: SyncContext,
    binding: BindingRef,
    syncThread: SyncReviewThread
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)

    // Resolve parent MR — Huly Issue ref via 'merge_request' idmap.
    const parentGitlabId = prefixGitlabIdForMultiInstance(
      { isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true, gitlabBaseUrl: bctx.gitlabBaseUrl },
      `${bctx.gitlabProjectId}:${syncThread.mergeRequestIid}`
    )
    const parentMapping = await findByGitlab(
      ctx.store.idmap(),
      bctx.workspaceUuid,
      'merge_request',
      parentGitlabId
    )

    if (parentMapping === null) {
      const threadRecord = syncThread as unknown as Record<string, unknown>
      if (markAndRetry(threadRecord, REVIEW_RETRY_FLAG)) {
        ctx.logger.debug('ReviewThreadsSyncManager: parent MR not yet synced — deferring', {
          binding,
          projectId: bctx.gitlabProjectId,
          mrIid: syncThread.mergeRequestIid,
          discussionId: syncThread.discussionId
        })
        await this.enqueueRecord(
          binding,
          'review',
          { ...threadRecord },
          `deferred:review:${bctx.gitlabProjectId}:${syncThread.mergeRequestIid}:${syncThread.discussionId}`,
          syncThread.updatedAt.toISOString()
        )
      } else {
        metrics.increment(METRIC_NAMES.REVIEW_PARENT_MISSING)
        ctx.logger.warn('ReviewThreadsSyncManager: parent MR still missing after retry — dropping thread', {
          binding,
          metric: 'review.parent.missing',
          projectId: bctx.gitlabProjectId,
          mrIid: syncThread.mergeRequestIid,
          discussionId: syncThread.discussionId
        })
      }
      return
    }

    const issueRef = parentMapping.hulyRef as Ref<Issue>

    // Resolve thread-level resolver person (replicated across all notes).
    const resolvedByUuid = syncThread.resolvedBy !== null
      ? await this.resolvePerson(syncThread.resolvedBy, bctx.userIdentity)
      : undefined
    const resolvedAtMs = syncThread.resolvedAt !== null
      ? syncThread.resolvedAt.getTime()
      : undefined

    const refUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}/-/merge_requests`
    const imageUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}`

    // Root note is the first in the notes array — only it carries `position`.
    const rootNoteId = syncThread.notes.length > 0 ? syncThread.notes[0].id : undefined

    for (const note of syncThread.notes) {
      // Skip system notes (opened, closed, assigned, etc.) — never sync.
      if (note.system) continue

      const noteIdmapKey = `${syncThread.discussionId}:${note.id}`
      const existing = await findByGitlab(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        'review_thread',
        noteIdmapKey
      )

      const messageMarkup = gfmMarkdownToMarkup(note.body, refUrl, imageUrl)
      const authorRef = await this.resolveAuthor(note.author, bctx.userIdentity)
      const noteCreatedMs = note.createdAt.getTime()
      const noteUpdatedMs = note.updatedAt.getTime()

      let messageRef: Ref<ChatMessage>
      let firstApply = false

      if (existing === null) {
        messageRef = await bctx.hulyClient.createDoc<ChatMessage>(
          chunter.class.ChatMessage,
          bctx.hulyProjectRef,
          withOriginatedMarker({
            attachedTo: issueRef,
            attachedToClass: tracker.class.Issue,
            collection: 'comments',
            message: messageMarkup,
            modifiedBy: authorRef as ChatMessage['modifiedBy'],
            modifiedOn: noteUpdatedMs,
            createdBy: authorRef as ChatMessage['createdBy'],
            createdOn: noteCreatedMs
          })
        )
        await upsertIdMap(
          ctx.store.idmap(),
          bctx.workspaceUuid,
          'review_thread',
          noteIdmapKey,
          HULY_CLASS_CHAT_MESSAGE,
          messageRef
        )
        firstApply = true
      } else {
        messageRef = existing.hulyRef as Ref<ChatMessage>

        // LWW on body — only update when remote is newer than local modifiedOn.
        const hulyMessage = await bctx.hulyClient.findOne<ChatMessage>(
          chunter.class.ChatMessage,
          { _id: messageRef }
        )
        const localTs = hulyMessage?.modifiedOn ?? 0
        if (noteUpdatedMs > localTs && hulyMessage?.message !== messageMarkup) {
          await bctx.hulyClient.updateDoc<ChatMessage>(
            chunter.class.ChatMessage,
            bctx.hulyProjectRef,
            messageRef,
            withOriginatedMarker({
              message: messageMarkup,
              modifiedOn: noteUpdatedMs,
              modifiedBy: authorRef as ChatMessage['modifiedBy']
            })
          )
        }
      }

      // Apply mixin. First note (by id match) carries position; replies do not.
      const isRoot = rootNoteId !== undefined && note.id === rootNoteId
      const mixinAttrs: Record<string, unknown> = {
        threadId: syncThread.discussionId,
        resolved: syncThread.resolved
      }
      if (syncThread.resolved) {
        if (resolvedByUuid !== undefined) mixinAttrs.resolvedBy = resolvedByUuid
        if (resolvedAtMs !== undefined) mixinAttrs.resolvedAt = resolvedAtMs
      } else {
        // Stale-on-unresolve: explicitly clear resolver attribution when thread
        // transitions resolved → false so prior resolver doesn't linger.
        mixinAttrs.resolvedBy = undefined
        mixinAttrs.resolvedAt = undefined
      }
      if (isRoot && note.position !== undefined) mixinAttrs.position = note.position

      if (firstApply) {
        await bctx.hulyClient.createMixin<ChatMessage, MRReviewThreadMixinDoc>(
          messageRef,
          chunter.class.ChatMessage,
          bctx.hulyProjectRef,
          MR_REVIEW_THREAD_MIXIN,
          withOriginatedMarker(mixinAttrs) as unknown as Omit<MRReviewThreadMixinDoc, keyof ChatMessage>
        )
      } else {
        await bctx.hulyClient.updateMixin<ChatMessage, MRReviewThreadMixinDoc>(
          messageRef,
          chunter.class.ChatMessage,
          bctx.hulyProjectRef,
          MR_REVIEW_THREAD_MIXIN,
          withOriginatedMarker(mixinAttrs) as unknown as Partial<Omit<MRReviewThreadMixinDoc, keyof ChatMessage>>
        )
      }
    }

    await setCursor(ctx.store.cursors(), binding, 'reviews', syncThread.updatedAt)
  }

  /**
   * NOTE (Phase 3 Path B gap): This method is reachable in production ONLY if a
   * TxProcessor subscription is wired to call `engine.enqueueLocalEvent`.
   * Currently no such wiring exists in `src/index.ts`. Calls from tests work
   * fine; real Huly UI mutations do NOT trigger this path. Phase 4 work.
   */
  async applyLocal (
    ctx: SyncContext,
    binding: BindingRef,
    doc: string,
    change: Record<string, unknown>
  ): Promise<void> {
    // Review-only applyLocal handles ONLY resolution flips. Body edits route
    // through NotesSyncManager.applyLocal (the existing Phase 2 path).
    if (change.resolved === undefined) return

    const bctx = await this.deps.loadBinding(binding)

    const hulyRef = stripDocPrefix(doc)
    const mapping = await findByHuly(
      ctx.store.idmap(),
      bctx.workspaceUuid,
      HULY_CLASS_CHAT_MESSAGE,
      hulyRef
    )

    if (mapping === null || mapping.gitlabKind !== 'review_thread') {
      ctx.logger.warn('ReviewThreadsSyncManager: no review_thread mapping for Huly message — skip', {
        binding,
        hulyRef
      })
      return
    }

    const parsed = parseDiscussionNoteKey(mapping.gitlabId)
    if (parsed === null) {
      ctx.logger.warn('ReviewThreadsSyncManager: malformed idMap gitlabId', { gitlabId: mapping.gitlabId })
      return
    }

    // Locate the parent MR iid via the change payload or via the review_thread
    // → merge_request linkage. The MR iid hint must be supplied by the engine
    // (or test harness) on the change payload as `mergeRequestIid`.
    const mrIidHint = change.mergeRequestIid as number | undefined
    if (mrIidHint === undefined) {
      ctx.logger.warn('ReviewThreadsSyncManager: change missing mergeRequestIid — skip resolve', {
        binding,
        hulyRef,
        discussionId: parsed.discussionId
      })
      return
    }

    // SCG-1 provenance guard: the legacy Phase 3 path used to read an actor
    // token off the change envelope. That carry path is now FORBIDDEN —
    // synthetic envelope tokens MUST be ignored. Actor tokens come exclusively
    // from the workspace+person scoped resolver
    // (`bctx.credentials.resolveActorToken`), wired in P4-T-10. Until that
    // lands, the service-account path is used (resolveDiscussion receives
    // undefined). See plan §P4-T-08 SCG-1.
    const resolved = change.resolved === true
    const actorToken: string | undefined = undefined

    await bctx.gitlabClient.resolveDiscussion(
      bctx.gitlabProjectId,
      mrIidHint,
      parsed.discussionId,
      resolved,
      actorToken
    )
    await setCursor(ctx.store.cursors(), binding, 'reviews', new Date())
  }

  async backfill (
    ctx: SyncContext,
    binding: BindingRef,
    since: Date | undefined
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)
    const opts: { updatedAfter?: Date } = {}
    if (since !== undefined) opts.updatedAfter = since

    const mrs = await bctx.gitlabClient.listMergeRequests(bctx.gitlabProjectId, opts)
    for (const mr of mrs) {
      const threads = await bctx.gitlabClient.listDiscussions(bctx.gitlabProjectId, mr.iid, opts)
      for (const thread of threads) {
        const versionIso = thread.updatedAt.toISOString()
        const eventId = `backfill:review:${bctx.gitlabProjectId}:${mr.iid}:${thread.discussionId}:${versionIso}`
        await this.enqueueRecord(
          binding,
          'review',
          thread as unknown as Record<string, unknown>,
          eventId,
          versionIso
        )
      }
    }
  }

  // ---------------------------------------------------------------------------

  private async resolveAuthor (
    author: AdapterUser,
    userIdentity: UserIdentity
  ): Promise<string> {
    const identity: IdentitySyncUser = {
      gitlabId: String(author.id),
      ...(author.email !== null ? { email: author.email } : {}),
      ...(author.name !== '' ? { name: author.name } : {}),
      ...(author.username !== '' ? { username: author.username } : {})
    }
    const matched = await userIdentity.mapByGitlabUser(identity)
    if (matched !== undefined) return matched
    return await userIdentity.ensureStubGuest(identity)
  }

  private async resolvePerson (
    user: AdapterUser,
    userIdentity: UserIdentity
  ): Promise<PersonUuid | undefined> {
    const identity: IdentitySyncUser = {
      gitlabId: String(user.id),
      ...(user.email !== null ? { email: user.email } : {}),
      ...(user.name !== '' ? { name: user.name } : {}),
      ...(user.username !== '' ? { username: user.username } : {})
    }
    return await userIdentity.mapByGitlabUser(identity)
  }
}

function stripDocPrefix (doc: string): string {
  const colon = doc.indexOf(':')
  if (colon < 0) return doc
  return doc.slice(colon + 1)
}

function parseDiscussionNoteKey (gitlabId: string): { discussionId: string, noteId: number } | null {
  const colon = gitlabId.lastIndexOf(':')
  if (colon < 0) return null
  const discussionId = gitlabId.slice(0, colon)
  const noteId = Number.parseInt(gitlabId.slice(colon + 1), 10)
  if (discussionId.length === 0 || !Number.isFinite(noteId)) return null
  return { discussionId, noteId }
}
