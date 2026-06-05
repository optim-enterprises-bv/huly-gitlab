import type { Ref } from '@hcengineering/core'
import { IssuePriority } from '@hcengineering/tracker'
import type { Status } from '@hcengineering/tracker'
import type { SyncMergeRequest } from '../adapter/types'
import type { Logger } from '../logging'

/**
 * Status category matching keywords (case-insensitive substring on the category Ref string).
 * Mirrors the idiom from status-map.ts.
 */
const ACTIVE_KEYWORDS = ['active', 'todo', 'inprogress', 'unstarted', 'backlog']
const DONE_KEYWORDS = ['done', 'won']
const CANCELLED_KEYWORDS = ['cancelled', 'canceled', 'lost']

export interface MRStateMapping {
  status: Ref<Status>
  priority?: number
  draft?: boolean
}

function categoryString (s: Status): string {
  const cat = s.category
  return typeof cat === 'string' ? cat.toLowerCase() : ''
}

function categoryMatches (s: Status, keywords: readonly string[]): boolean {
  const cat = categoryString(s)
  return keywords.some((k) => cat.includes(k))
}

function findFirst (statuses: Status[], keywords: readonly string[]): Ref<Status> | undefined {
  return statuses.find((s) => categoryMatches(s, keywords))?._id
}

/**
 * Map a GitLab MR state to a Huly MRStateMapping.
 *
 * - 'opened' + draft: false → first Active status
 * - 'opened' + draft: true  → first Active status + priority Low + draft:true
 * - 'closed'                → first Cancelled status (fallback: first Active if none found)
 * - 'merged'                → first Done status
 * - 'locked'                → status unchanged (caller passes current ref)
 */
export function mapRemoteMRState (
  remote: SyncMergeRequest['state'],
  draft: boolean,
  currentStatusRef: Ref<Status>,
  projectStatuses: Status[],
  logger?: Logger
): MRStateMapping {
  if (remote === 'locked') {
    return { status: currentStatusRef }
  }

  if (remote === 'merged') {
    const status = findFirst(projectStatuses, DONE_KEYWORDS)
    if (status !== undefined) return { status }
    const fallback = findFirst(projectStatuses, ACTIVE_KEYWORDS) ?? currentStatusRef
    return { status: fallback }
  }

  if (remote === 'closed') {
    const status = findFirst(projectStatuses, CANCELLED_KEYWORDS)
    if (status !== undefined) return { status }
    // Graceful degradation: no Cancelled category in project
    logger?.warn('mr-status-map: no Cancelled category found; falling back to first Active for closed MR')
    const fallback = findFirst(projectStatuses, ACTIVE_KEYWORDS) ?? currentStatusRef
    return { status: fallback }
  }

  // 'opened'
  const status = findFirst(projectStatuses, ACTIVE_KEYWORDS) ?? currentStatusRef
  if (draft) {
    return { status, priority: IssuePriority.Low, draft: true }
  }
  return { status }
}

/**
 * Inverse: given a Huly status Ref, return the GitLab state event to send.
 *
 * - Done/Cancelled → 'close'
 * - Active/ToDo/InProgress → 'reopen'
 * - Returns undefined when status does not map to a clear event
 */
export function mapHulyStatusToMRStateEvent (
  hulyStatusRef: Ref<Status>,
  projectStatuses: Status[]
): 'close' | 'reopen' | undefined {
  const status = projectStatuses.find((s) => s._id === hulyStatusRef)
  if (status === undefined) return undefined

  if (categoryMatches(status, DONE_KEYWORDS) || categoryMatches(status, CANCELLED_KEYWORDS)) {
    return 'close'
  }
  if (categoryMatches(status, ACTIVE_KEYWORDS)) {
    return 'reopen'
  }
  return undefined
}
