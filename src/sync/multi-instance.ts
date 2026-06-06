import { createHash } from 'node:crypto'

/**
 * Prefix a raw GitLab id for idmap storage.
 *
 * When `bctx.isMultiInstanceWorkspace === false` (the dominant single-instance
 * deployment) this is a no-op: the raw id is returned unchanged so no existing
 * idmap rows are affected.
 *
 * When `true`, the id is prefixed with the first 8 hex characters of the
 * SHA-256 of `bctx.gitlabBaseUrl` followed by `':'`. This provides
 * defense-in-depth against duplicate GitLab project IDs across instances
 * within the same Huly workspace (TG-4).
 *
 * Migration note: existing single-instance workspaces never transition to
 * multi-instance retroactively — legacy idmap rows stay unprefixed. Operators
 * who genuinely add a second GitLab instance to an existing workspace MUST run
 * the one-time idmap migration script documented in
 * `docs/runbooks/phase4-deployment.md`.
 *
 * Implementation note: lives in its own module so sync managers (issues, mr,
 * notes, mr-review, pipeline) can import it without creating a circular
 * import with `binding-loader.ts` (which depends on the binding-context types
 * declared in those managers).
 */
export function prefixGitlabIdForMultiInstance (
  bctx: { isMultiInstanceWorkspace: boolean, gitlabBaseUrl: string },
  rawId: string | number
): string {
  const raw = String(rawId)
  if (!bctx.isMultiInstanceWorkspace) return raw
  const hash = createHash('sha256').update(bctx.gitlabBaseUrl).digest('hex').slice(0, 8)
  return `${hash}:${raw}`
}

/**
 * B6: compute a composite key for the `bindingsByProject` map when in
 * multi-instance mode. Single-instance mode uses the raw numeric projectId
 * (same as before — no behavior change). Multi-instance mode keys by
 * `${hash8(baseUrl)}:${projectId}` so two bindings with the same numeric
 * projectId on different GitLab instances don't collide in the Map.
 */
export function bindingsByProjectKey (
  isMultiInstance: boolean,
  gitlabBaseUrl: string,
  gitlabProjectId: number
): string {
  if (!isMultiInstance) return String(gitlabProjectId)
  const hash = createHash('sha256').update(gitlabBaseUrl).digest('hex').slice(0, 8)
  return `${hash}:${gitlabProjectId}`
}
