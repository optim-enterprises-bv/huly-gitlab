import type { Client, MeasureContext, PersonUuid, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Collection } from 'mongodb'
import type { Status, TaskType } from '@hcengineering/tracker'
import type { AccountClient } from '@hcengineering/account-client'
import type { Logger } from '../logging'
import type { Store } from '../state/store'
import type { CredentialResolver } from '../auth'
import type { AttachmentMirrorDoc } from '../state/attachment-mirror'
import type { MirrorDeps, HulyAttachmentStore } from './attachments'
import { createHulyAttachmentStore } from './huly-attachment-store'
import { GitLabClient } from '../adapter/gitlab-client'
import { detectCapabilities } from '../adapter/capabilities'
import { createPlatformClient, closePlatformClient } from '../huly/client'
import { getTrackerProject } from '../huly/projects'
import { UserIdentity, type IdMapStore } from '../huly/users'
import { findByGitlab, upsertIdMap, type IdMapDoc } from '../state/idmap'
import { getBinding, type BindingDoc } from '../state/bindings'
import { getUserCredential } from '../state/user-credentials'
import { LabelCache } from './label-cache'
import { MilestoneCache } from './milestone-cache'
import { MRCache } from './mr-cache'
import type { BindingContext as IssuesBindingContext } from './issues'
import type { NotesBindingContext } from './notes'
import type { MRBindingContext } from './mr'
import type { MRReviewBindingContext } from './mr-review'
import type { PipelineBindingContext } from './pipeline'
import type { EpicsBindingContext } from './epics'
import type { BindingRef } from './types'
import { bindingsByProjectKey } from './multi-instance'

/**
 * Loaded binding context exposed by BindingLoader. Equivalent to the
 * IssuesBindingContext shape with an extra `mrCache` field so MR-related
 * code paths can resolve MR records without re-querying GitLab on every call.
 *
 * Multi-instance note: when two or more bindings under the same workspace
 * point to DIFFERENT GitLab instances, `isMultiInstanceWorkspace` is `true`
 * and callers MUST pass idmap gitlabId strings through
 * `prefixGitlabIdForMultiInstance` to prevent project-ID collisions across
 * instances (TG-4 defense-in-depth).
 */
export type BindingContext = IssuesBindingContext & {
  mrCache: MRCache
  /** True when ≥ 2 distinct gitlabBaseUrl values exist for this workspace. */
  isMultiInstanceWorkspace: boolean
}

// B4: previous narrow `EpicBindingContext` interface was DELETED because
// `loadForEpics` now returns the FULL `EpicsBindingContext` (imported above)
// so it carries `gitlabClient`, `statuses`, `defaultTaskType`, and
// `capabilities` — fields EpicsSyncManager.applyRemote actually consumes.

// prefixGitlabIdForMultiInstance moved to ./multi-instance.ts to break a
// circular import (sync managers now import the helper directly to thread
// it through their idmap call sites — B1 / TG-4). Re-exported here for
// backwards compatibility with existing call sites and tests.
export { prefixGitlabIdForMultiInstance, bindingsByProjectKey } from './multi-instance'

function createIdMapStoreAdapter (col: Collection<IdMapDoc>): IdMapStore {
  return {
    getIdMap: async (workspaceUuid, gitlabKind, gitlabId) => {
      const row = await findByGitlab(col, workspaceUuid, gitlabKind as IdMapDoc['gitlabKind'], gitlabId)
      return row?.hulyRef
    },
    putIdMap: async (workspaceUuid, gitlabKind, gitlabId, hulyRef) => {
      await upsertIdMap(col, workspaceUuid, gitlabKind as IdMapDoc['gitlabKind'], gitlabId, 'huly:class:Person', hulyRef)
    }
  }
}

const PLATFORM_CLIENT_TIMEOUT_MS = 30_000

interface WorkspaceCacheEntry {
  client: Client
  txOperations: TxOperations
  identity: UserIdentity
  expiresAt: number
  hulyStore?: HulyAttachmentStore
}

export interface BindingLoaderDeps {
  store: Store
  credentialResolver: CredentialResolver
  accountClient: AccountClient
  logger: Logger
  ctx: MeasureContext
  /** GitLab base URL fallback when the credential does not pin one */
  defaultGitlabBaseUrl: string
  /** AES-256-GCM key used to decrypt per-user OAuth tokens from userCredentials collection */
  encryptionKey: Buffer
  /** Cache TTL for per-workspace Huly platform clients */
  cacheTtlMs?: number
  /**
   * P4-T-19: invoked the first time a binding under a workspace is loaded.
   * Receives the platform Client and a live reference to the
   * bindingsByProject map (gitlabProjectId → bindingId). The callback
   * typically starts a TxSubscriber. Throwing inside the callback is logged
   * but does NOT block the load (the binding remains usable for outbound
   * GitLab sync; only Path B is degraded).
   */
  onWorkspaceLoaded?: (
    workspaceUuid: WorkspaceUuid,
    client: Client,
    bindingsByProject: Map<string, string>
  ) => Promise<void> | void
  /**
   * P4-T-19: invoked when a workspace cache entry is evicted (TTL expiry or
   * explicit close). Used to stop the TxSubscriber before the underlying
   * platform Client is closed. Throwing inside the callback is logged but
   * does NOT prevent eviction.
   */
  onWorkspaceEvicted?: (workspaceUuid: WorkspaceUuid) => Promise<void> | void
  /**
   * MongoDB collection for the attachment mirror mapping table.
   * When provided, a HulyAttachmentStore is constructed per workspace and
   * mirrorDeps is populated on each returned binding context (enabling
   * bi-directional attachment mirroring). When omitted, mirrorDeps is
   * undefined on all contexts and managers fall back to link-through.
   */
  mirrorCol?: Collection<AttachmentMirrorDoc>
}

/**
 * Loads everything a SyncManager needs to operate on a given binding:
 * resolves the binding doc, builds a GitLab client from its credential,
 * gets-or-creates a per-workspace Huly platform client, and primes the
 * label/milestone caches.
 *
 * Per-workspace platform clients are cached with a TTL so repeated lookups
 * within the same backfill/webhook burst don't pay the connection cost.
 *
 * Multi-instance support (TG-4): the workspace baseUrl registry tracks all
 * distinct gitlabBaseUrl values seen per workspace. When ≥ 2 distinct values
 * are present, `isMultiInstanceWorkspace` is set to `true` on every context
 * returned for that workspace. Callers use `prefixGitlabIdForMultiInstance`
 * when forming idmap gitlabId strings to prevent collision between GitLab
 * instances that share project IDs (e.g., two self-hosted instances each with
 * projectId = 1).
 */
export class BindingLoader {
  private readonly store: Store
  private readonly credentialResolver: CredentialResolver
  private readonly accountClient: AccountClient
  private readonly logger: Logger
  private readonly ctx: MeasureContext
  private readonly defaultGitlabBaseUrl: string
  private readonly encryptionKey: Buffer
  private readonly cacheTtlMs: number
  private readonly workspaceCache = new Map<WorkspaceUuid, WorkspaceCacheEntry>()
  /**
   * Registry of gitlabBaseUrl values seen per workspace.
   * Used to compute `isMultiInstanceWorkspace` at load time.
   */
  private readonly workspaceBaseUrls = new Map<WorkspaceUuid, Set<string>>()
  /**
   * P4-T-19: per-workspace map of GitLab project id → binding id. Populated
   * as bindings are loaded; consulted by TxSubscriber for resolving the
   * bindingId for a given tx. The map instance is stable across loads, so
   * callers (the TxSubscriber) hold a live reference.
   *
   * B6: keys are STRINGS via `bindingsByProjectKey()`:
   *   - single-instance: the raw numeric projectId stringified, e.g. `"42"`
   *   - multi-instance: `${hash8(gitlabBaseUrl)}:${projectId}`, e.g. `"a1b2c3d4:42"`
   * This prevents two bindings on different GitLab instances from clobbering
   * each other when they share a numeric projectId (TG-4 / Security L-3).
   */
  private readonly bindingsByWorkspace = new Map<WorkspaceUuid, Map<string, string>>()
  private readonly onWorkspaceLoaded?: BindingLoaderDeps['onWorkspaceLoaded']
  private readonly onWorkspaceEvicted?: BindingLoaderDeps['onWorkspaceEvicted']
  private readonly mirrorCol?: Collection<AttachmentMirrorDoc>

  constructor (deps: BindingLoaderDeps) {
    this.store = deps.store
    this.credentialResolver = deps.credentialResolver
    this.accountClient = deps.accountClient
    this.logger = deps.logger
    this.ctx = deps.ctx
    this.defaultGitlabBaseUrl = deps.defaultGitlabBaseUrl
    this.encryptionKey = deps.encryptionKey
    this.cacheTtlMs = deps.cacheTtlMs ?? 30 * 60 * 1000
    this.onWorkspaceLoaded = deps.onWorkspaceLoaded
    this.onWorkspaceEvicted = deps.onWorkspaceEvicted
    this.mirrorCol = deps.mirrorCol
  }

  /**
   * Live reference to the bindingsByProject map for a workspace. Returns
   * `undefined` if no binding has ever been loaded for the workspace.
   *
   * B6: keys are strings — see `bindingsByWorkspace` JSDoc.
   */
  getBindingsByProject (workspaceUuid: WorkspaceUuid): Map<string, string> | undefined {
    return this.bindingsByWorkspace.get(workspaceUuid)
  }

  /** IssuesSyncManager loader form. */
  loadForIssues = async (binding: BindingRef): Promise<IssuesBindingContext> => {
    return await this.loadInternal(binding)
  }

  /** NotesSyncManager loader form — same data, narrower shape. */
  loadForNotes = async (binding: BindingRef): Promise<NotesBindingContext> => {
    const ctx = await this.loadInternal(binding)
    // The same real GitLabClient instance satisfies both IssueGitLabClient and
    // NoteGitLabClient. The shapes are distinct interfaces so we cast at the
    // boundary rather than redundantly re-typing.
    return {
      workspaceUuid: ctx.workspaceUuid,
      gitlabProjectId: ctx.gitlabProjectId,
      gitlabProjectPath: ctx.gitlabProjectPath,
      hulyProjectRef: ctx.hulyProjectRef,
      hulyClient: ctx.hulyClient,
      gitlabClient: ctx.gitlabClient as unknown as NotesBindingContext['gitlabClient'],
      userIdentity: ctx.userIdentity,
      gitlabBaseUrl: ctx.gitlabBaseUrl,
      isMultiInstanceWorkspace: ctx.isMultiInstanceWorkspace,
      mirrorDeps: ctx.mirrorDeps
    }
  }

  /**
   * PipelineSyncManager loader form — pipelines only read the idmap and write
   * a mixin, so we skip credential resolution, GitLab client construction,
   * capability detection, statuses, TaskType and the caches.
   *
   * B1: still resolves the credential to get `gitlabBaseUrl` and register it
   * in the workspace multi-instance registry, so the parent-MR idmap key in
   * `applyRemote` is prefixed correctly in multi-instance workspaces.
   */
  loadForPipelines = async (binding: BindingRef): Promise<PipelineBindingContext> => {
    const bindingDoc = await this.resolveBinding(binding)
    const workspaceUuid = bindingDoc.workspaceUuid as unknown as WorkspaceUuid

    const credential = await this.credentialResolver.resolve(bindingDoc.credentialRef)
    const gitlabBaseUrl = credential?.gitlabBaseUrl ?? this.defaultGitlabBaseUrl
    this.registerBaseUrl(workspaceUuid, gitlabBaseUrl)
    this.registerBinding(workspaceUuid, bindingDoc.gitlabProjectId, binding, gitlabBaseUrl)
    const isMultiInstanceWorkspace = this.isMultiInstance(workspaceUuid)

    const workspace = await this.getOrCreateWorkspaceEntry(workspaceUuid)
    return {
      workspaceUuid,
      gitlabProjectId: bindingDoc.gitlabProjectId,
      hulyProjectRef: bindingDoc.hulyProjectRef as unknown as Ref<Space>,
      hulyClient: workspace.txOperations,
      gitlabBaseUrl,
      isMultiInstanceWorkspace
    }
  }

  /** MergeRequestsSyncManager loader form — IssuesBindingContext shape (MR ctx is a structural subset). */
  loadForMergeRequests = async (binding: BindingRef): Promise<MRBindingContext> => {
    const ctx = await this.loadInternal(binding)
    const store = this.store
    const encryptionKey = this.encryptionKey
    const gitlabBaseUrl = ctx.gitlabBaseUrl
    return {
      workspaceUuid: ctx.workspaceUuid,
      gitlabProjectId: ctx.gitlabProjectId,
      gitlabProjectPath: ctx.gitlabProjectPath,
      hulyProjectRef: ctx.hulyProjectRef,
      hulyClient: ctx.hulyClient,
      gitlabClient: ctx.gitlabClient as unknown as MRBindingContext['gitlabClient'],
      statuses: ctx.statuses,
      userIdentity: ctx.userIdentity,
      labelCache: ctx.labelCache,
      milestoneCache: ctx.milestoneCache,
      defaultTaskType: ctx.defaultTaskType,
      gitlabBaseUrl,
      isMultiInstanceWorkspace: ctx.isMultiInstanceWorkspace,
      mirrorDeps: ctx.mirrorDeps,
      credentials: {
        resolveActorToken: async (workspaceUuid: WorkspaceUuid, hulyPersonUuid: PersonUuid) => {
          if (workspaceUuid === undefined || hulyPersonUuid === undefined) return undefined
          const credential = await getUserCredential(
            store.userCredentials(),
            encryptionKey,
            workspaceUuid,
            hulyPersonUuid,
            gitlabBaseUrl
          )
          if (credential === null) return undefined
          if (credential.expiresAt !== null && credential.expiresAt.getTime() < Date.now()) {
            return undefined
          }
          return credential.token
        }
      }
    }
  }

  /**
   * ReviewThreadsSyncManager loader form — narrower than MR ctx; no caches,
   * statuses, defaultTaskType, or per-actor credentials (B4: review manager
   * uses service-account token only).
   */
  loadForReviews = async (binding: BindingRef): Promise<MRReviewBindingContext> => {
    const ctx = await this.loadInternal(binding)
    return {
      workspaceUuid: ctx.workspaceUuid,
      gitlabProjectId: ctx.gitlabProjectId,
      gitlabProjectPath: ctx.gitlabProjectPath,
      hulyProjectRef: ctx.hulyProjectRef,
      hulyClient: ctx.hulyClient,
      gitlabClient: ctx.gitlabClient as unknown as MRReviewBindingContext['gitlabClient'],
      userIdentity: ctx.userIdentity,
      gitlabBaseUrl: ctx.gitlabBaseUrl,
      isMultiInstanceWorkspace: ctx.isMultiInstanceWorkspace,
      mirrorDeps: ctx.mirrorDeps
    }
  }

  /**
   * EpicsSyncManager loader form — full EpicsBindingContext.
   *
   * B4 fix: prior implementation returned a narrow `EpicBindingContext` lacking
   * the fields EpicsSyncManager.applyRemote actually consumes (`gitlabClient`,
   * `capabilities`, `statuses`, `defaultTaskType`). That latent bug would crash
   * at the first epic webhook on a real workspace. We now reuse the same heavy
   * load path as `loadForMergeRequests` so all those fields are populated.
   */
  loadForEpics = async (binding: BindingRef): Promise<EpicsBindingContext> => {
    const ctx = await this.loadInternal(binding)
    return {
      workspaceUuid: ctx.workspaceUuid,
      gitlabProjectId: ctx.gitlabProjectId,
      hulyProjectRef: ctx.hulyProjectRef,
      hulyClient: ctx.hulyClient,
      gitlabClient: ctx.gitlabClient as unknown as EpicsBindingContext['gitlabClient'],
      gitlabBaseUrl: ctx.gitlabBaseUrl,
      isMultiInstanceWorkspace: ctx.isMultiInstanceWorkspace,
      statuses: ctx.statuses,
      defaultTaskType: ctx.defaultTaskType,
      capabilities: (ctx.gitlabClient as unknown as GitLabClient).capabilities ?? undefined
    }
  }

  async close (): Promise<void> {
    for (const [workspaceUuid, entry] of this.workspaceCache) {
      await this.invokeEvictionHook(workspaceUuid)
      try {
        await closePlatformClient(entry.client)
      } catch (err) {
        this.logger.warn('BindingLoader: failed to close cached platform client', {
          err: err instanceof Error ? err.message : String(err)
        })
      }
    }
    this.workspaceCache.clear()
    this.bindingsByWorkspace.clear()
  }

  // ---------------------------------------------------------------------------

  private async loadInternal (bindingId: BindingRef): Promise<BindingContext> {
    const binding = await this.resolveBinding(bindingId)

    const credential = await this.credentialResolver.resolve(binding.credentialRef)
    if (credential === null) {
      throw new Error(`BindingLoader: credential not found for binding ${bindingId}`)
    }

    const gitlabBaseUrl = credential.gitlabBaseUrl ?? this.defaultGitlabBaseUrl
    const gitlabClient = new GitLabClient({
      baseUrl: gitlabBaseUrl,
      token: credential.token,
      logger: this.logger
    })

    // Detect (and cache) capabilities for this client; result is stored on gitlabClient.capabilities
    // by detectCapabilities itself. The TTL cache in adapter/capabilities.ts deduplicates calls
    // per (baseUrl, token) for 1 hour.
    try {
      await detectCapabilities(gitlabClient)
    } catch (err) {
      this.logger.warn('BindingLoader: failed to detect capabilities, continuing without', {
        bindingId,
        err: err instanceof Error ? err.message : String(err)
      })
    }

    const workspaceUuid = binding.workspaceUuid as unknown as WorkspaceUuid

    this.registerBaseUrl(workspaceUuid, gitlabBaseUrl)
    this.registerBinding(workspaceUuid, binding.gitlabProjectId, bindingId, gitlabBaseUrl)
    const isMultiInstanceWorkspace = this.isMultiInstance(workspaceUuid)

    const workspace = await this.getOrCreateWorkspaceEntry(workspaceUuid)

    const hulyProjectRef = binding.hulyProjectRef as unknown as Ref<Space>

    // Resolve project + statuses + default TaskType
    const { statuses, type: projectType } = await getTrackerProject(
      workspace.client,
      hulyProjectRef as unknown as Parameters<typeof getTrackerProject>[1]
    )

    // Default TaskType: first entry in ProjectType.tasks. Fail fast if absent —
    // returning a sentinel Ref would only push the failure into createDoc with
    // an opaque platform-side error later.
    if (projectType.tasks.length === 0) {
      throw new Error(
        `BindingLoader: project ${String(hulyProjectRef)} has no TaskType; cannot mirror issues/MRs`
      )
    }
    const defaultTaskType: Ref<TaskType> = projectType.tasks[0]

    const labelCache = new LabelCache(binding.gitlabProjectId, hulyProjectRef)
    const milestoneCache = new MilestoneCache(binding.gitlabProjectId, hulyProjectRef)
    const mrCache = new MRCache(binding.gitlabProjectId)

    const mirrorDeps: MirrorDeps | undefined =
      workspace.hulyStore !== undefined && this.mirrorCol !== undefined
        ? {
            hulyStore: workspace.hulyStore,
            gitlabClient: gitlabClient as unknown as MirrorDeps['gitlabClient'],
            mirrorCol: this.mirrorCol,
            logger: this.logger
          }
        : undefined

    return {
      workspaceUuid,
      gitlabProjectId: binding.gitlabProjectId,
      gitlabProjectPath: binding.gitlabProjectPath,
      hulyProjectRef,
      hulyClient: workspace.txOperations,
      gitlabClient,
      statuses: statuses as readonly Status[],
      userIdentity: workspace.identity,
      labelCache,
      milestoneCache,
      mrCache,
      defaultTaskType,
      gitlabBaseUrl,
      isMultiInstanceWorkspace,
      mirrorDeps
    }
  }

  private async resolveBinding (bindingId: BindingRef): Promise<BindingDoc> {
    const binding = await getBinding(this.store.bindings(), bindingId)
    if (binding === null) {
      throw new Error(`BindingLoader: binding not found: ${bindingId}`)
    }
    return binding
  }

  private async getOrCreateWorkspaceEntry (workspaceUuid: WorkspaceUuid): Promise<WorkspaceCacheEntry> {
    const now = Date.now()
    const cached = this.workspaceCache.get(workspaceUuid)
    if (cached !== undefined && cached.expiresAt > now) {
      return cached
    }
    if (cached !== undefined) {
      // Expired — evict + close. Fire the eviction hook BEFORE close so the
      // TxSubscriber can detach its notify handler from a still-live client.
      await this.invokeEvictionHook(workspaceUuid)
      this.workspaceCache.delete(workspaceUuid)
      try {
        await closePlatformClient(cached.client)
      } catch (err) {
        this.logger.warn('BindingLoader: failed to close expired platform client', {
          workspaceUuid,
          err: err instanceof Error ? err.message : String(err)
        })
      }
    }

    const { client } = await createPlatformClient(this.ctx, workspaceUuid, PLATFORM_CLIENT_TIMEOUT_MS)
    // TODO: type properly — the platform `Client` is augmented to `TxOperations`
    // by the Huly platform at runtime; the vendor.d.ts declares them as separate
    // interfaces so we cast here at the boundary.
    const txOperations = client as unknown as TxOperations

    const identity = new UserIdentity(this.accountClient, createIdMapStoreAdapter(this.store.idmap()), workspaceUuid)

    let hulyStore: HulyAttachmentStore | undefined
    if (this.mirrorCol !== undefined) {
      try {
        hulyStore = createHulyAttachmentStore({ client: txOperations, logger: this.logger, workspaceUuid })
      } catch (err) {
        this.logger.warn('BindingLoader: failed to create HulyAttachmentStore — attachment mirroring disabled', {
          workspaceUuid,
          err: err instanceof Error ? err.message : String(err)
        })
      }
    }

    const entry: WorkspaceCacheEntry = {
      client,
      txOperations,
      identity,
      expiresAt: now + this.cacheTtlMs,
      hulyStore
    }
    this.workspaceCache.set(workspaceUuid, entry)

    // Fire the workspace-loaded hook on first ever load (no prior bindings
    // map). Subsequent TTL-refresh re-creates only fire the eviction hook +
    // a fresh load hook, allowing the TxSubscriber to re-attach.
    if (this.onWorkspaceLoaded !== undefined) {
      const bindingsByProject = this.getOrCreateBindingsByProject(workspaceUuid)
      try {
        await this.onWorkspaceLoaded(workspaceUuid, client, bindingsByProject)
      } catch (err) {
        this.logger.warn('BindingLoader: onWorkspaceLoaded hook threw', {
          workspaceUuid,
          err: err instanceof Error ? err.message : String(err)
        })
      }
    }

    return entry
  }

  private getOrCreateBindingsByProject (workspaceUuid: WorkspaceUuid): Map<string, string> {
    let existing = this.bindingsByWorkspace.get(workspaceUuid)
    if (existing === undefined) {
      existing = new Map<string, string>()
      this.bindingsByWorkspace.set(workspaceUuid, existing)
    }
    return existing
  }

  /**
   * Register a binding under its (workspace, projectId) key.
   *
   * B6: when the workspace is multi-instance, the key is
   * `${hash8(gitlabBaseUrl)}:${projectId}` instead of the raw numeric
   * projectId. This prevents collisions when two bindings on different GitLab
   * instances share the same numeric projectId.
   *
   * When a workspace transitions FROM single- TO multi-instance, the existing
   * single-instance entries are re-keyed eagerly so the registry stays
   * consistent. The remembered baseUrl per single-instance entry is recovered
   * from `workspaceFirstBaseUrl` (the SOLE baseUrl seen up to the transition).
   */
  /**
   * Tracks the (projectId, gitlabBaseUrl) tuple for every binding registered in
   * a workspace. Used to RE-KEY existing entries when the workspace transitions
   * from single- to multi-instance — without this we'd lose the original
   * baseUrl needed to compose the multi-instance composite key.
   */
  private readonly bindingMetaByWorkspace = new Map<WorkspaceUuid, Map<string, { projectId: number, gitlabBaseUrl: string }>>()

  private registerBinding (
    workspaceUuid: WorkspaceUuid,
    gitlabProjectId: number,
    bindingId: string,
    gitlabBaseUrl: string
  ): void {
    const map = this.getOrCreateBindingsByProject(workspaceUuid)
    const multi = this.isMultiInstance(workspaceUuid)

    let meta = this.bindingMetaByWorkspace.get(workspaceUuid)
    if (meta === undefined) {
      meta = new Map()
      this.bindingMetaByWorkspace.set(workspaceUuid, meta)
    }

    // If this is the very first registration that finds multi-instance true,
    // re-key any prior single-instance entries to composite keys using each
    // entry's remembered baseUrl.
    if (multi) {
      const rekeyed = new Map<string, string>()
      const rekeyedMeta = new Map<string, { projectId: number, gitlabBaseUrl: string }>()
      let needsRekey = false
      for (const [oldKey, val] of map) {
        const m = meta.get(oldKey)
        if (m === undefined) {
          // No meta — leave as-is (defensive).
          rekeyed.set(oldKey, val)
          continue
        }
        const newKey = bindingsByProjectKey(true, m.gitlabBaseUrl, m.projectId)
        if (newKey !== oldKey) needsRekey = true
        rekeyed.set(newKey, val)
        rekeyedMeta.set(newKey, m)
      }
      if (needsRekey) {
        map.clear()
        for (const [k, v] of rekeyed) map.set(k, v)
        meta.clear()
        for (const [k, v] of rekeyedMeta) meta.set(k, v)
      }
    }

    const key = bindingsByProjectKey(multi, gitlabBaseUrl, gitlabProjectId)
    map.set(key, bindingId)
    meta.set(key, { projectId: gitlabProjectId, gitlabBaseUrl })
  }

  private async invokeEvictionHook (workspaceUuid: WorkspaceUuid): Promise<void> {
    if (this.onWorkspaceEvicted === undefined) return
    try {
      await this.onWorkspaceEvicted(workspaceUuid)
    } catch (err) {
      this.logger.warn('BindingLoader: onWorkspaceEvicted hook threw', {
        workspaceUuid,
        err: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /** Register a baseUrl for a workspace. Called on every loadFor* that resolves a credential. */
  private registerBaseUrl (workspaceUuid: WorkspaceUuid, gitlabBaseUrl: string): void {
    const existing = this.workspaceBaseUrls.get(workspaceUuid)
    if (existing !== undefined) {
      existing.add(gitlabBaseUrl)
    } else {
      this.workspaceBaseUrls.set(workspaceUuid, new Set([gitlabBaseUrl]))
    }
  }

  /** True when ≥ 2 distinct gitlabBaseUrl values have been registered for the workspace. */
  private isMultiInstance (workspaceUuid: WorkspaceUuid): boolean {
    return (this.workspaceBaseUrls.get(workspaceUuid)?.size ?? 0) >= 2
  }
}
