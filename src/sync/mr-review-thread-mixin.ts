import type { Mixin, PersonUuid, Ref } from '@hcengineering/core'
import type { ChatMessage } from '@hcengineering/chunter'
import type { SyncReviewPosition } from '../adapter/types'

/**
 * Runtime mixin id for the `gitlab-review` mixin applied to ChatMessage.
 *
 * Applied to EVERY ChatMessage in a thread (per-note storage per Q1 v2 resolution).
 * `position` is set only on the thread's first note; replies inherit position by
 * joining via `threadId`.
 */
export const MR_REVIEW_THREAD_MIXIN = 'gitlab-review' as unknown as Ref<Mixin<MRReviewThreadMixinDoc>>

/**
 * Shape of the runtime `gitlab-review` mixin written onto a chunter.ChatMessage
 * that mirrors a GitLab review thread note.
 *
 * Field-ownership: ReviewThreadsSyncManager exclusively owns all fields here.
 * No other manager writes these fields.
 *
 * Per-note storage: every ChatMessage in a GitLab discussion thread carries this
 * mixin with its own `threadId`, `resolved`, `resolvedBy`, and `resolvedAt`.
 * Thread-level resolved state is derived via LWW using max(resolvedAt) across notes.
 * `position` is set ONLY on the first note (discussion root); reply notes have
 * `position: undefined`.
 */
export interface MRReviewThreadMixinDoc extends ChatMessage {
  /** GitLab discussion_id for the thread this note belongs to. */
  threadId: string
  /** Whether this thread is resolved. Replicated on every note in the thread. */
  resolved: boolean
  /** Who resolved the thread (undefined when never resolved). */
  resolvedBy?: PersonUuid
  /** When the thread was resolved, ms since epoch (per Huly convention). Undefined when never resolved. */
  resolvedAt?: number
  /**
   * Diff position for inline review comments. Set ONLY on the thread root (first note).
   * Reply notes have `position: undefined` and inherit position by joining via `threadId`.
   */
  position?: SyncReviewPosition
}
