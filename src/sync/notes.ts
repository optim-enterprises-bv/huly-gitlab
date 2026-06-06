import type { Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import chunter, { type ChatMessage } from '@hcengineering/chunter'
import tracker, { type Issue } from '@hcengineering/tracker'
import type { SyncNote, SyncReviewPosition, SyncReviewThread, SyncUser as AdapterUser } from '../adapter/types'
import { gfmMarkdownToMarkup, markupToGfmMarkdown } from '../markdown'
import { findByGitlab, findByHuly, upsertIdMap } from '../state/idmap'
import { getCursor, setCursor } from '../state/cursors'
import { prefixGitlabIdForMultiInstance } from './multi-instance'
import * as metrics from '../metrics'
import { METRIC_NAMES } from '../metrics'
import type { SyncUser as IdentitySyncUser, UserIdentity } from '../huly/users'
import type { BindingRef, SyncContext, SyncManager } from './types'
import { resolveIssueRef, type BindingResolverInput } from './issues'
import type { MirrorDeps } from './attachments'
import { mirrorBodyGitlabToHuly, mirrorBodyHulyToGitlab } from './attachments'
import { markAndRetry, NOTE_RETRY_FLAG, REVIEW_RETRY_FLAG } from './deferred-parent'
import { withOriginatedMarker } from './originated-marker'

/**
 * Internal envelope carrying the note data plus its parent noteable iid.
 *
 * Used two ways:
 *  - Backfill path: NotesSyncManager.backfill constructs these directly.
 *  - Webhook path: parseWebhookPayload extracts them from the raw Note Hook payload.
 *
 * Webhook Note Hook payload shape (GitLab):
 *   { object_kind: 'note', object_attributes: { id, body, system, noteable_type, ... },
 *     issue: { iid: <parent iid>, ... } }
 *   or for MR notes:
 *   { object_kind: 'note', object_attributes: { id, body, system, noteable_type: 'MergeRequest', ... },
 *     merge_request: { iid: <parent iid>, ... } }
 *
 * Phase 3 — line-comment routing:
 *   When isReview === true, applyRemote re-enqueues with kind 'review' for
 *   ReviewThreadsSyncManager to handle. position and discussionId carry the
 *   line-anchor context. The notes path does NOT write a ChatMessage in this case.
 *
 * NOTE (C9): unit tests assert the enqueue CALL SHAPE only; live engine wiring
 * (kind 'review' registration) lands in P3-T-10.
 *
 * Suggestion blocks (C3): <<<<<<< SUGGEST content in note body passes through
 * verbatim as raw markdown. No interpretation is applied.
 */
export interface SyncNoteRecord {
  noteableIid: number
  note: SyncNote
  /** Phase 3: true when note has a text-position line anchor → re-route to review path */
  isReview?: boolean
  /** Phase 3: SyncReviewPosition extracted from the webhook position object */
  position?: SyncReviewPosition
  /** Phase 3: GitLab discussion_id for threading */
  discussionId?: string
}

/**
 * Parse a raw GitLab Note Hook webhook payload into SyncNoteRecord.
 * Returns undefined if the payload cannot be recognised as a note event.
 *
 * noteableType is set explicitly at all construction sites (critic C1):
 *  - 'Issue' (default) when object_attributes.noteable_type is 'Issue' or absent
 *  - 'MergeRequest' when object_attributes.noteable_type === 'MergeRequest'
 */
function parseWebhookPayload (record: Record<string, unknown>): SyncNoteRecord | undefined {
  const attrs = record.object_attributes
  if (attrs === null || typeof attrs !== 'object') return undefined

  const a = attrs as Record<string, unknown>
  const noteId = typeof a.id === 'number' ? a.id : undefined
  if (noteId === undefined) return undefined

  // Explicit allowlist: undefined or 'Issue' → Issue; 'MergeRequest' → MR.
  // Any other value (e.g. 'Snippet', 'Commit') is rejected so the note is
  // dropped by the caller rather than silently misrouted to the Issue path.
  let noteableType: 'Issue' | 'MergeRequest'
  if (a.noteable_type === undefined || a.noteable_type === 'Issue') {
    noteableType = 'Issue'
  } else if (a.noteable_type === 'MergeRequest') {
    noteableType = 'MergeRequest'
  } else {
    return undefined
  }

  // For MR notes, parent iid is in merge_request.iid; for Issue notes, in issue.iid
  let noteableIid: number | undefined
  if (noteableType === 'MergeRequest') {
    const mrObj = record.merge_request
    if (mrObj !== null && typeof mrObj === 'object') {
      const iid = (mrObj as Record<string, unknown>).iid
      if (typeof iid === 'number') noteableIid = iid
    }
  } else {
    const issueObj = record.issue
    if (issueObj !== null && typeof issueObj === 'object') {
      const iid = (issueObj as Record<string, unknown>).iid
      if (typeof iid === 'number') noteableIid = iid
    }
  }
  if (noteableIid === undefined) return undefined

  const authorObj = a.author
  const author: AdapterUser = (authorObj !== null && typeof authorObj === 'object')
    ? (() => {
        const au = authorObj as Record<string, unknown>
        return {
          id: typeof au.id === 'number' ? au.id : 0,
          username: typeof au.username === 'string' ? au.username : '',
          name: typeof au.name === 'string' ? au.name : '',
          email: typeof au.email === 'string' ? au.email : null,
          avatarUrl: typeof au.avatar_url === 'string' ? au.avatar_url : null,
          webUrl: typeof au.url === 'string' ? au.url : ''
        }
      })()
    : { id: 0, username: '', name: '', email: null, avatarUrl: null, webUrl: '' }

  const note: SyncNote = {
    id: noteId,
    body: typeof a.body === 'string' ? a.body : '',
    author,
    createdAt: typeof a.created_at === 'string' ? a.created_at : new Date().toISOString(),
    updatedAt: typeof a.updated_at === 'string' ? a.updated_at : new Date().toISOString(),
    system: a.system === true,
    confidential: a.confidential === true,
    noteableType
  }

  // Phase 3 — line-comment detection.
  // Only MR notes with position_type === 'text' are routed to the review path.
  // Notes without position, or non-MR noteables, continue through the existing path.
  if (
    noteableType === 'MergeRequest' &&
    a.position !== null &&
    typeof a.position === 'object'
  ) {
    const pos = a.position as Record<string, unknown>
    if (pos.position_type === 'text') {
      // Validate required SHA fields are present (spec §Error Handling):
      // "Line comment with malformed position: log warn, drop the note, do NOT create the thread"
      // Caller receives undefined and logs the warning.
      if (
        typeof pos.head_sha !== 'string' ||
        typeof pos.base_sha !== 'string' ||
        typeof pos.start_sha !== 'string'
      ) {
        const malformed: SyncNoteRecord & { _malformedPosition: boolean } = { noteableIid, note, isReview: false, _malformedPosition: true }
        return malformed
      }

      const position: SyncReviewPosition = {
        filePath: typeof pos.new_path === 'string' ? pos.new_path : (typeof pos.old_path === 'string' ? pos.old_path : ''),
        oldLine: typeof pos.old_line === 'number' ? pos.old_line : null,
        newLine: typeof pos.new_line === 'number' ? pos.new_line : null,
        baseSha: pos.base_sha,
        headSha: pos.head_sha,
        startSha: pos.start_sha,
        positionType: 'text'
      }

      const discussionId = typeof a.discussion_id === 'string' ? a.discussion_id : undefined

      // Attach position to the note for downstream consumers.
      note.position = position

      return { noteableIid, note, isReview: true, position, discussionId }
    }
    // position_type !== 'text' (e.g. 'image', 'file') — fall through to the notes path.
    // These are filtered at the adapter layer (P3-T-06) but we also handle them here as
    // defense-in-depth: they route via the existing non-review path.
  }

  return { noteableIid, note }
}

/**
 * Loaded binding context — everything NotesSyncManager needs.
 */
export interface NotesBindingContext {
  workspaceUuid: WorkspaceUuid
  gitlabProjectId: number
  gitlabProjectPath: string
  hulyProjectRef: Ref<Space>
  hulyClient: TxOperations
  gitlabClient: NoteGitLabClient
  userIdentity: UserIdentity
  gitlabBaseUrl: string
  /**
   * B1: true when ≥ 2 distinct GitLab base URLs are registered for this
   * workspace. When true, idmap gitlabId values are prefixed via
   * `prefixGitlabIdForMultiInstance` (TG-4 defense-in-depth).
   */
  isMultiInstanceWorkspace?: boolean
  /**
   * Optional attachment mirror deps. When present (wired by BindingLoader when
   * mirrorCol is provided), GitLab upload links in note bodies are mirrored
   * into Huly and vice versa. When absent, link-through is used.
   */
  mirrorDeps?: MirrorDeps
}

/**
 * GitLab client surface NotesSyncManager uses. The full GitLabClient satisfies this.
 *
 * createNote/updateNote take `{ body: string }` to match the real GitLabClient
 * signature exactly — drift here previously caused a 400 from GitLab.
 */
export interface NoteGitLabClient {
  listNotes: (
    projectId: number | string,
    issueIid: number,
    opts: { updatedAfter?: string }
  ) => Promise<SyncNote[]>
  createNote: (
    projectId: number | string,
    issueIid: number,
    body: { body: string }
  ) => Promise<SyncNote>
  updateNote: (
    projectId: number | string,
    issueIid: number,
    noteId: number,
    body: { body: string }
  ) => Promise<SyncNote>
  deleteNote: (
    projectId: number | string,
    issueIid: number,
    noteId: number
  ) => Promise<void>
  listIssues: (
    projectId: number | string,
    opts: { updatedAfter?: string }
  ) => Promise<Array<{ iid: number }>>
  /** Optional: used by backfill to enumerate MRs whose notes need fetching. */
  listMergeRequests?: (
    projectId: number | string,
    opts: { updatedAfter?: string }
  ) => Promise<Array<{ iid: number }>>
  listMRNotes: (
    projectId: number | string,
    mrIid: number,
    opts: { updatedAfter?: Date }
  ) => Promise<SyncNote[]>
  createMRNote: (
    projectId: number | string,
    mrIid: number,
    body: { body: string }
  ) => Promise<SyncNote>
  updateMRNote: (
    projectId: number | string,
    mrIid: number,
    noteId: number,
    body: { body: string }
  ) => Promise<SyncNote>
  deleteMRNote: (
    projectId: number | string,
    mrIid: number,
    noteId: number
  ) => Promise<void>
}

/**
 * Enqueue contract used by backfill and deferred retry.
 */
export type NotesBackfillEnqueuerFn = (
  binding: BindingRef,
  kind: string,
  record: Record<string, unknown>,
  eventId: string,
  version: string
) => Promise<void> | void

export interface NotesBackfillEnqueuer {
  enqueueBackfillRecord: NotesBackfillEnqueuerFn
}

export interface NotesSyncManagerDeps {
  loadBinding: (binding: BindingRef) => Promise<NotesBindingContext>
  /** Object form (legacy, used by tests) */
  enqueuer?: NotesBackfillEnqueuer
  /** Function form preferred for new wiring */
  backfillEnqueuer?: NotesBackfillEnqueuerFn
  /**
   * Optional attachment mirror deps. When present, GitLab upload links in note
   * bodies are mirrored into Huly (and vice versa). When absent or when mirror
   * fails, the original link is preserved (link-through fallback).
   */
  mirrorDeps?: MirrorDeps
}

const HULY_CLASS_CHAT_MESSAGE = 'chunter.class.ChatMessage'
const HULY_CLASS_ISSUE = 'tracker:class:Issue'

/**
 * NotesSyncManager — two-way sync for issue and MR comments (GitLab notes ↔ Huly ChatMessages).
 *
 * System note filter:
 *   GitLab emits 20+ system note kinds (opened, closed, assigned, etc.).
 *   We skip all of them using the `system: boolean` flag from the GitLab API —
 *   the single source of truth. Individual system note body strings are not enumerated.
 *
 * Deferred parent resolution:
 *   If the parent issue/MR has not yet been mirrored into Huly the note is re-enqueued
 *   once (flagged with `_noteRetried: true`). On a second miss it is dropped with a warning.
 *   This provides defense-in-depth for confidential MR notes where the webhook layer cannot
 *   filter (critic B3): notes for unmapped MR iids are deferred once then dropped.
 *
 * MR note routing (applyLocal):
 *   When pushing a note to GitLab, the parent Huly Issue ref is looked up in idmap.
 *   findByHuly returns the idmap entry which includes gitlabKind — if 'merge_request'
 *   then createMRNote/updateMRNote/deleteMRNote are used; otherwise the issue path.
 */
export class NotesSyncManager implements SyncManager<Record<string, unknown>> {
  readonly kind = 'note'

  constructor (private readonly deps: NotesSyncManagerDeps) {}

  resourceKey (record: Record<string, unknown>): string | undefined {
    // Backfill envelope: { noteableIid, note: { id } }
    const note = record.note
    if (note !== null && typeof note === 'object') {
      const id = (note as Record<string, unknown>).id
      if (typeof id === 'number') return `note:${id}`
    }
    // Webhook shape: { object_attributes: { id } }
    const objAttrs = record.object_attributes
    if (objAttrs !== null && typeof objAttrs === 'object') {
      const id = (objAttrs as Record<string, unknown>).id
      if (typeof id === 'number') return `note:${id}`
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
    rawRecord: Record<string, unknown>
  ): Promise<void> {
    // Unpack the record — either a SyncNoteRecord envelope (from backfill) or raw webhook payload.
    let noteableIid: number
    let note: SyncNote

    if (typeof rawRecord.noteableIid === 'number' && rawRecord.note !== undefined) {
      noteableIid = rawRecord.noteableIid
      note = rawRecord.note as SyncNote
    } else {
      const parsed = parseWebhookPayload(rawRecord)
      if (parsed === undefined) {
        ctx.logger.warn('NotesSyncManager: could not parse note record', { binding })
        return
      }

      // Phase 3 — drop malformed position notes before further processing.
      if ((parsed as SyncNoteRecord & { _malformedPosition?: boolean })._malformedPosition === true) {
        metrics.increment(METRIC_NAMES.REVIEW_POSITION_MALFORMED)
        ctx.logger.warn('NotesSyncManager: line comment with malformed position — dropping', {
          binding,
          metric: 'review.position.malformed',
          noteId: parsed.note.id
        })
        return
      }

      // Phase 3 — line-comment routing: re-enqueue with kind 'review' for ReviewThreadsSyncManager.
      // NOTE (C9): unit tests assert the enqueue CALL SHAPE only; live engine wiring
      // (kind 'review' registration) lands in P3-T-10.
      if (parsed.isReview === true) {
        const bctx = await this.deps.loadBinding(binding)

        // Resolve parent MR to check if it is mirrored yet.
        // Defense-in-depth for confidential MR notes (critic B3).
        const parentGitlabId = prefixGitlabIdForMultiInstance(
          { isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true, gitlabBaseUrl: bctx.gitlabBaseUrl },
          `${bctx.gitlabProjectId}:${parsed.noteableIid}`
        )
        const parentMapping = await findByGitlab(
          ctx.store.idmap(),
          bctx.workspaceUuid,
          'merge_request',
          parentGitlabId
        )

        if (parentMapping === null) {
          // C14 — _reviewRetried / _noteRetried flag: survive deferred re-enqueue cycle.
          // We normalise both legacy flags into REVIEW_RETRY_FLAG before calling markAndRetry.
          if (rawRecord[NOTE_RETRY_FLAG] === true) rawRecord[REVIEW_RETRY_FLAG] = true
          if (markAndRetry(rawRecord, REVIEW_RETRY_FLAG)) {
            ctx.logger.debug('NotesSyncManager: review note parent MR not yet synced — deferring', {
              binding,
              noteableIid: parsed.noteableIid,
              noteId: parsed.note.id
            })
            await this.enqueueRecord(
              binding,
              'note',
              { ...rawRecord },
              `deferred:review:${bctx.gitlabProjectId}:${parsed.noteableIid}:${parsed.note.id}`,
              parsed.note.updatedAt
            )
          } else {
            metrics.increment(METRIC_NAMES.REVIEW_PARENT_MISSING)
            ctx.logger.warn('NotesSyncManager: review note parent MR still missing after retry — dropping', {
              binding,
              metric: 'review.parent.missing',
              noteableIid: parsed.noteableIid,
              noteId: parsed.note.id
            })
          }
          return
        }

        // Build a SyncReviewThread-shaped envelope for the ReviewThreadsSyncManager.
        // Propagate _noteRetried as _reviewRetried so the review manager doesn't re-defer.
        const reviewEnvelope: SyncReviewThread & Record<string, unknown> = {
          discussionId: parsed.discussionId ?? `note:${parsed.note.id}`,
          mergeRequestIid: parsed.noteableIid,
          projectId: bctx.gitlabProjectId,
          resolved: false,
          resolvedBy: null,
          resolvedAt: null,
          updatedAt: new Date(parsed.note.updatedAt),
          notes: [{
            id: parsed.note.id,
            body: parsed.note.body,
            author: parsed.note.author,
            createdAt: new Date(parsed.note.createdAt),
            updatedAt: new Date(parsed.note.updatedAt),
            system: parsed.note.system,
            resolvable: true,
            resolved: false,
            position: parsed.position
          }]
        }

        // Propagate retry flags so review manager won't re-defer (C14).
        if (rawRecord._reviewRetried === true || rawRecord._noteRetried === true) {
          (reviewEnvelope as Record<string, unknown>)._reviewRetried = true
        }

        await this.enqueueRecord(
          binding,
          'review',
          reviewEnvelope as unknown as Record<string, unknown>,
          `review:${bctx.gitlabProjectId}:${parsed.noteableIid}:${parsed.note.id}`,
          parsed.note.updatedAt
        )
        return
      }

      noteableIid = parsed.noteableIid
      note = parsed.note
    }

    // Skip GitLab system notes (opened, closed, assigned, etc.)
    if (note.system) return

    const bctx = await this.deps.loadBinding(binding)
    const resolver: BindingResolverInput = {
      gitlabProjectId: bctx.gitlabProjectId,
      gitlabBaseUrl: bctx.gitlabBaseUrl,
      isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true
    }

    // Resolve parent ref — Issue or MR-mirror Issue.
    // noteableType defaults to 'Issue' (critic C1); MR notes use 'merge_request' idmap kind.
    const noteableType = note.noteableType ?? 'Issue'
    let issueRef: Ref<Issue> | undefined

    if (noteableType === 'MergeRequest') {
      // MR notes: look up parent via merge_request idmap entry.
      // Defense-in-depth for confidential MR notes (critic B3): if MR is not yet mapped,
      // the note is deferred once then dropped — same pattern as Issue notes.
      const gitlabId = prefixGitlabIdForMultiInstance(
        { isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true, gitlabBaseUrl: bctx.gitlabBaseUrl },
        `${bctx.gitlabProjectId}:${noteableIid}`
      )
      const mapping = await findByGitlab(ctx.store.idmap(), bctx.workspaceUuid, 'merge_request', gitlabId)
      issueRef = mapping !== null ? mapping.hulyRef as Ref<Issue> : undefined
    } else {
      issueRef = await resolveIssueRef(
        { ...ctx, workspaceUuid: bctx.workspaceUuid },
        resolver,
        noteableIid
      )
    }

    if (issueRef === undefined) {
      if (markAndRetry(rawRecord, NOTE_RETRY_FLAG)) {
        ctx.logger.debug('NotesSyncManager: parent not yet synced — deferring', {
          binding,
          noteableType,
          noteableIid,
          noteId: note.id
        })
        await this.enqueueRecord(
          binding,
          'note',
          { ...rawRecord },
          `deferred:${bctx.gitlabProjectId}:${noteableIid}:${note.id}`,
          note.updatedAt
        )
      } else {
        ctx.logger.warn('NotesSyncManager: parent still missing after retry — dropping note', {
          binding,
          noteableType,
          noteableIid,
          noteId: note.id
        })
      }
      return
    }

    const gitlabId = prefixGitlabIdForMultiInstance(
      { isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true, gitlabBaseUrl: bctx.gitlabBaseUrl },
      `${bctx.gitlabProjectId}:${note.id}`
    )
    const existing = await findByGitlab(ctx.store.idmap(), bctx.workspaceUuid, 'note', gitlabId)

    const refUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}/-/issues`
    const imageUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}`

    let noteBody = note.body
    if (this.deps.mirrorDeps !== undefined) {
      try {
        noteBody = await mirrorBodyGitlabToHuly(
          this.deps.mirrorDeps,
          note.body,
          bctx.gitlabBaseUrl,
          bctx.gitlabProjectPath
        )
      } catch (err) {
        ctx.logger.warn('NotesSyncManager: attachment mirror failed — using link-through', {
          binding,
          noteId: note.id,
          error: err instanceof Error ? err.message : String(err)
        })
        ctx.logger.info('ATTACHMENT_MIRROR_FAILED', { binding, noteId: note.id })
      }
    }

    const messageMarkup = gfmMarkdownToMarkup(noteBody, refUrl, imageUrl)

    const authorRef = await this.resolveAuthor(note.author, bctx.userIdentity)

    if (existing === null) {
      const msgRef = await bctx.hulyClient.createDoc<ChatMessage>(
        chunter.class.ChatMessage,
        bctx.hulyProjectRef,
        withOriginatedMarker({
          attachedTo: issueRef,
          attachedToClass: tracker.class.Issue,
          collection: 'comments',
          message: messageMarkup,
          modifiedBy: authorRef as ChatMessage['modifiedBy'],
          modifiedOn: new Date(note.updatedAt).getTime(),
          createdBy: authorRef as ChatMessage['createdBy'],
          createdOn: new Date(note.createdAt).getTime()
        })
      )
      await upsertIdMap(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        'note',
        gitlabId,
        HULY_CLASS_CHAT_MESSAGE,
        msgRef
      )
      await setCursor(ctx.store.cursors(), binding, 'notes', new Date(note.updatedAt))
      return
    }

    // UPDATE — LWW: apply remote update only when remote is newer than last note cursor.
    const cursor = await getCursor(ctx.store.cursors(), binding, 'notes')
    const localTs = cursor ?? new Date(0)
    const remoteTs = new Date(note.updatedAt)

    if (remoteTs > localTs) {
      await bctx.hulyClient.updateDoc<ChatMessage>(
        chunter.class.ChatMessage,
        bctx.hulyProjectRef,
        existing.hulyRef as Ref<ChatMessage>,
        withOriginatedMarker({
          message: messageMarkup,
          modifiedOn: remoteTs.getTime(),
          modifiedBy: authorRef as ChatMessage['modifiedBy']
        })
      )
      await setCursor(ctx.store.cursors(), binding, 'notes', remoteTs)
    }
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
    // Phase 3 — review route guard (C13).
    // When change.kind === 'review', this change belongs to ReviewThreadsSyncManager.
    // Return here so the review manager's applyLocal handles resolution flips.
    // Body edits (change.message) that arrive simultaneously with a resolved flip:
    //   - The notes path handles the body update (mapping.gitlabKind === 'note').
    //   - ReviewThreadsSyncManager handles the resolved flip independently.
    // Both paths execute correctly when both deltas arrive in the same change event.
    if (change.kind === 'review') return

    const bctx = await this.deps.loadBinding(binding)

    // doc format: note:<hulyRef>
    const hulyRef = stripDocPrefix(doc)

    const mapping = await findByHuly(
      ctx.store.idmap(),
      bctx.workspaceUuid,
      HULY_CLASS_CHAT_MESSAGE,
      hulyRef
    )

    // Additional route guard: if the idmap entry has gitlabKind === 'review_thread',
    // the body edit will be handled by ReviewThreadsSyncManager via its own applyLocal
    // invocation. Return here to avoid double-processing.
    if (mapping !== null && mapping.gitlabKind === 'review_thread') return

    const deleted = change.deleted === true
    const messageMarkup = change.message as string | undefined
    // Direct iid hint (used in tests and from local-change adapters that already know the iid)
    const hintIid = change.noteableIid as number | undefined
    const hulyAttachedTo = change.hulyMessage !== undefined && change.hulyMessage !== null && typeof change.hulyMessage === 'object'
      ? (change.hulyMessage as Record<string, unknown>).attachedTo as Ref<Issue> | undefined
      : undefined

    const refUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}/-/issues`
    const imageUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}`

    // Resolve noteableIid and parentIsMR. We look up via attachedTo whenever it
    // is provided so UPDATE/DELETE on MR-attached notes route to the MR endpoints
    // instead of returning a 404 from the Issue endpoint.
    let resolvedIid: number | undefined = hintIid
    let parentIsMR = false

    if (hulyAttachedTo !== undefined) {
      const parentMap = await findByHuly(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        HULY_CLASS_ISSUE,
        String(hulyAttachedTo)
      )
      if (parentMap !== null) {
        const parsed = parseProjectIid(parentMap.gitlabId)
        if (parsed !== null) {
          if (resolvedIid === undefined) resolvedIid = parsed.iid
          parentIsMR = parentMap.gitlabKind === 'merge_request'
        }
      } else if (resolvedIid === undefined) {
        ctx.logger.warn('NotesSyncManager: parent issue not yet synced to GitLab — dropping note', {
          binding,
          hulyRef,
          hulyAttachedTo
        })
        return
      }
    }

    if (mapping === null) {
      // CREATE on GitLab side
      if (messageMarkup === undefined || resolvedIid === undefined) {
        ctx.logger.warn('NotesSyncManager: cannot create remote note without body or noteableIid', {
          binding,
          hulyRef
        })
        return
      }
      let body = markupToGfmMarkdown(messageMarkup, refUrl, imageUrl)
      if (this.deps.mirrorDeps !== undefined) {
        try {
          body = await mirrorBodyHulyToGitlab(this.deps.mirrorDeps, body, bctx.gitlabProjectId)
        } catch (err) {
          ctx.logger.warn('NotesSyncManager: attachment mirror (Huly→GitLab) failed — using link-through', {
            binding,
            hulyRef,
            error: err instanceof Error ? err.message : String(err)
          })
          ctx.logger.info('ATTACHMENT_MIRROR_FAILED', { binding, hulyRef })
        }
      }
      let created: SyncNote
      if (parentIsMR) {
        created = await bctx.gitlabClient.createMRNote(bctx.gitlabProjectId, resolvedIid, { body })
      } else {
        created = await bctx.gitlabClient.createNote(bctx.gitlabProjectId, resolvedIid, { body })
      }
      const createdGitlabId = prefixGitlabIdForMultiInstance(
        { isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true, gitlabBaseUrl: bctx.gitlabBaseUrl },
        `${bctx.gitlabProjectId}:${created.id}`
      )
      await upsertIdMap(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        'note',
        createdGitlabId,
        HULY_CLASS_CHAT_MESSAGE,
        hulyRef
      )
      await setCursor(ctx.store.cursors(), binding, 'notes', new Date())
      return
    }

    // Extract noteId from gitlabId "projectId:noteId"
    const noteId = parseNoteId(mapping.gitlabId)
    if (noteId === null) {
      ctx.logger.warn('NotesSyncManager: malformed idMap gitlabId', { gitlabId: mapping.gitlabId })
      return
    }

    // Issue iid from change payload (UPDATE/DELETE path)
    const issueIid = (change.issueIid as number | undefined) ?? hintIid
    if (issueIid === undefined) {
      ctx.logger.warn('NotesSyncManager: cannot resolve issue iid for note operation', {
        binding,
        hulyRef,
        noteId
      })
      return
    }

    if (deleted) {
      if (parentIsMR) {
        await bctx.gitlabClient.deleteMRNote(bctx.gitlabProjectId, issueIid, noteId)
      } else {
        await bctx.gitlabClient.deleteNote(bctx.gitlabProjectId, issueIid, noteId)
      }
      await setCursor(ctx.store.cursors(), binding, 'notes', new Date())
      return
    }

    if (messageMarkup !== undefined) {
      let body = markupToGfmMarkdown(messageMarkup, refUrl, imageUrl)
      if (this.deps.mirrorDeps !== undefined) {
        try {
          body = await mirrorBodyHulyToGitlab(this.deps.mirrorDeps, body, bctx.gitlabProjectId)
        } catch (err) {
          ctx.logger.warn('NotesSyncManager: attachment mirror (Huly→GitLab) failed — using link-through', {
            binding,
            hulyRef,
            error: err instanceof Error ? err.message : String(err)
          })
          ctx.logger.info('ATTACHMENT_MIRROR_FAILED', { binding, hulyRef })
        }
      }
      if (parentIsMR) {
        await bctx.gitlabClient.updateMRNote(bctx.gitlabProjectId, issueIid, noteId, { body })
      } else {
        await bctx.gitlabClient.updateNote(bctx.gitlabProjectId, issueIid, noteId, { body })
      }
      await setCursor(ctx.store.cursors(), binding, 'notes', new Date())
    }
  }

  /**
   * Backfill: list all synced issues and fetch their notes since the given cursor.
   * Also backfills MR notes via listMergeRequests (when available on the client).
   * Each non-system note is enqueued as a remote event (same path as webhooks).
   */
  async backfill (
    ctx: SyncContext,
    binding: BindingRef,
    since: Date | undefined
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)

    const issues = await bctx.gitlabClient.listIssues(bctx.gitlabProjectId, {})
    const updatedAfter = since?.toISOString()

    for (const issue of issues) {
      const opts: { updatedAfter?: string } = {}
      if (updatedAfter !== undefined) opts.updatedAfter = updatedAfter

      const notes = await bctx.gitlabClient.listNotes(bctx.gitlabProjectId, issue.iid, opts)

      for (const note of notes) {
        if (note.system) continue

        // Explicit noteableType: 'Issue' at all backfill construction sites (critic C1)
        const envelope: SyncNoteRecord = {
          noteableIid: issue.iid,
          note: { ...note, noteableType: 'Issue' }
        }
        const eventId = `backfill:${bctx.gitlabProjectId}:${issue.iid}:${note.id}:${note.updatedAt}`
        await this.enqueueRecord(
          binding,
          'note',
          envelope as unknown as Record<string, unknown>,
          eventId,
          note.updatedAt
        )
      }
    }

    // Backfill MR notes when the client supports listing MRs
    if (bctx.gitlabClient.listMergeRequests !== undefined) {
      const mrs = await bctx.gitlabClient.listMergeRequests(bctx.gitlabProjectId, {})
      const mrOpts: { updatedAfter?: Date } = {}
      if (since !== undefined) mrOpts.updatedAfter = since

      for (const mr of mrs) {
        const mrNotes = await bctx.gitlabClient.listMRNotes(bctx.gitlabProjectId, mr.iid, mrOpts)

        for (const note of mrNotes) {
          if (note.system) continue

          // Explicit noteableType: 'MergeRequest' for MR backfill (critic C1)
          const envelope: SyncNoteRecord = {
            noteableIid: mr.iid,
            note: { ...note, noteableType: 'MergeRequest' }
          }
          const eventId = `backfill:mr:${bctx.gitlabProjectId}:${mr.iid}:${note.id}:${note.updatedAt}`
          await this.enqueueRecord(
            binding,
            'note',
            envelope as unknown as Record<string, unknown>,
            eventId,
            note.updatedAt
          )
        }
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
}

function stripDocPrefix (doc: string): string {
  const colon = doc.indexOf(':')
  if (colon < 0) return doc
  return doc.slice(colon + 1)
}

function parseNoteId (gitlabId: string): number | null {
  // B1: multi-instance keys are `${hash8}:${projectId}:${noteId}`; single-instance
  // keys are `${projectId}:${noteId}`. noteId is always the LAST `:`-separated segment.
  const colon = gitlabId.lastIndexOf(':')
  if (colon < 0) return null
  const n = Number.parseInt(gitlabId.slice(colon + 1), 10)
  return Number.isFinite(n) ? n : null
}

function parseProjectIid (gitlabId: string): { projectId: number, iid: number } | null {
  // B1: multi-instance keys are `${hash8}:${projectId}:${iid}`; single-instance
  // keys are `${projectId}:${iid}`. Strip any 8-hex-prefix before parsing.
  const parts = gitlabId.split(':')
  if (parts.length < 2) return null
  // Trailing two segments are always projectId, iid
  const iidStr = parts[parts.length - 1]
  const pidStr = parts[parts.length - 2]
  const pid = Number.parseInt(pidStr, 10)
  const iid = Number.parseInt(iidStr, 10)
  if (!Number.isFinite(pid) || !Number.isFinite(iid)) return null
  return { projectId: pid, iid }
}
