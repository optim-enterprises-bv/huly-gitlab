import type { Ref } from '@hcengineering/core'
import type { Status } from '@hcengineering/tracker'

/**
 * Status category matching keywords (case-insensitive substring on the category Ref string).
 *
 * Tracker stores category refs like `task:statusCategory:Active`, `task:statusCategory:ToDo`,
 * `task:statusCategory:InProgress`, `task:statusCategory:Won` (Done) and
 * `task:statusCategory:Lost` (Cancelled). The plan specifies plain category labels —
 * we keep both spellings to be robust to upstream rename without churn.
 */
const OPEN_CATEGORY_KEYWORDS = ['active', 'todo', 'inprogress', 'unstarted', 'backlog']
const CLOSED_CATEGORY_KEYWORDS = ['done', 'cancelled', 'canceled', 'won', 'lost']

interface ProjectCacheEntry {
  open: Ref<Status> | undefined
  closed: Ref<Status> | undefined
  /** Map of statusRef → 'opened' | 'closed' for inverse resolution. */
  inverse: Map<Ref<Status>, 'opened' | 'closed'>
}

const cache = new Map<string, ProjectCacheEntry>()

/**
 * Reset the status cache. Test-only.
 */
export function _clearStatusCache (): void {
  cache.clear()
}

function categoryString (s: Status): string {
  const cat = s.category
  return typeof cat === 'string' ? cat.toLowerCase() : ''
}

function categoryMatches (s: Status, keywords: readonly string[]): boolean {
  const cat = categoryString(s)
  return keywords.some((k) => cat.includes(k))
}

function buildEntry (statuses: readonly Status[]): ProjectCacheEntry {
  const open = statuses.find((s) => categoryMatches(s, OPEN_CATEGORY_KEYWORDS))
  const closed = statuses.find((s) => categoryMatches(s, CLOSED_CATEGORY_KEYWORDS))

  const inverse = new Map<Ref<Status>, 'opened' | 'closed'>()
  for (const s of statuses) {
    if (categoryMatches(s, CLOSED_CATEGORY_KEYWORDS)) {
      inverse.set(s._id, 'closed')
    } else if (categoryMatches(s, OPEN_CATEGORY_KEYWORDS)) {
      inverse.set(s._id, 'opened')
    }
  }

  return {
    open: open?._id,
    closed: closed?._id,
    inverse
  }
}

function getEntry (projectKey: string, statuses: readonly Status[]): ProjectCacheEntry {
  const cached = cache.get(projectKey)
  if (cached !== undefined) return cached
  const entry = buildEntry(statuses)
  cache.set(projectKey, entry)
  return entry
}

/**
 * Map a GitLab `state` ('opened' | 'closed') to a Huly status Ref using the project's
 * available statuses. Deterministic: first matching status by category keyword wins.
 *
 * Caches the resolved (open, closed) tuple per project on first call.
 */
export function mapRemoteState (
  projectKey: string,
  remoteState: 'opened' | 'closed',
  projectStatuses: readonly Status[]
): Ref<Status> | undefined {
  const entry = getEntry(projectKey, projectStatuses)
  return remoteState === 'closed' ? entry.closed : entry.open
}

/**
 * Inverse: given a Huly status Ref, return the GitLab state.
 * Unknown / not-in-cache statuses fall back to 'opened' (safest default for sync push).
 */
export function mapHulyStatus (
  projectKey: string,
  statusRef: Ref<Status>,
  projectStatuses: readonly Status[]
): 'opened' | 'closed' {
  const entry = getEntry(projectKey, projectStatuses)
  return entry.inverse.get(statusRef) ?? 'opened'
}
