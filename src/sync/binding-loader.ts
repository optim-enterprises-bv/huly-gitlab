import type { Client, MeasureContext, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Collection } from 'mongodb'
import type { Status, TaskType } from '@hcengineering/tracker'
import type { AccountClient } from '@hcengineering/account-client'
import type { Logger } from '../logging'
import type { Store } from '../state/store'
import type { CredentialResolver } from '../auth'
import { GitLabClient } from '../adapter/gitlab-client'
import { detectCapabilities } from '../adapter/capabilities'
import { createPlatformClient, closePlatformClient } from '../huly/client'
import { getTrackerProject } from '../huly/projects'
import { UserIdentity, type IdMapStore } from '../huly/users'
import { findByGitlab, upsertIdMap, type IdMapDoc } from '../state/idmap'
import { getBinding, type BindingDoc } from '../state/bindings'
import { LabelCache } from './label-cache'
import { MilestoneCache } from './milestone-cache'
import { MRCache } from './mr-cache'
import type { BindingContext as IssuesBindingContext } from './issues'
import type { NotesBindingContext } from './notes'
import type { MRBindingContext } from './mr'
import type { MRReviewBindingContext } from './mr-review'
import type { PipelineBindingContext } from './pipeline'
import type { BindingRef } from './types'

/**
 * Loaded binding context exposed by BindingLoader. Equivalent to the
 * IssuesBindingContext shape with an extra `mrCache` field so MR-related
 * code paths can resolve MR records without re-querying GitLab on every call.
 */
export type BindingContext = IssuesBindingContext & {
  mrCache: MRCache
}

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
}

export interface BindingLoaderDeps {
  store: Store
  credentialResolver: CredentialResolver
  accountClient: AccountClient
  logger: Logger
  ctx: MeasureContext
  /** GitLab base URL fallback when the credential does not pin one */
  defaultGitlabBaseUrl: string
  /** Cache TTL for per-workspace Huly platform clients */
  cacheTtlMs?: number
}

/**
 * Loads everything a SyncManager needs to operate on a given binding:
 * resolves the binding doc, builds a GitLab client from its credential,
 * gets-or-creates a per-workspace Huly platform client, and primes the
 * label/milestone caches.
 *
 * Per-workspace platform clients are cached with a TTL so repeated lookups
 * within the same backfill/webhook burst don't pay the connection cost.
 */
export class BindingLoader {
  private readonly store: Store
  private readonly credentialResolver: CredentialResolver
  private readonly accountClient: AccountClient
  private readonly logger: Logger
  private readonly ctx: MeasureContext
  private readonly defaultGitlabBaseUrl: string
  private readonly cacheTtlMs: number
  private readonly workspaceCache = new Map<WorkspaceUuid, WorkspaceCacheEntry>()

  constructor (deps: BindingLoaderDeps) {
    this.store = deps.store
    this.credentialResolver = deps.credentialResolver
    this.accountClient = deps.accountClient
    this.logger = deps.logger
    this.ctx = deps.ctx
    this.defaultGitlabBaseUrl = deps.defaultGitlabBaseUrl
    this.cacheTtlMs = deps.cacheTtlMs ?? 30 * 60 * 1000
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
      gitlabBaseUrl: ctx.gitlabBaseUrl
    }
  }

  /**
   * PipelineSyncManager loader form — pipelines only read the idmap and write
   * a mixin, so we skip credential resolution, GitLab client construction,
   * capability detection, statuses, TaskType and the caches.
   */
  loadForPipelines = async (binding: BindingRef): Promise<PipelineBindingContext> => {
    const bindingDoc = await this.resolveBinding(binding)
    const workspaceUuid = bindingDoc.workspaceUuid as unknown as WorkspaceUuid
    const workspace = await this.getOrCreateWorkspaceEntry(workspaceUuid)
    return {
      workspaceUuid,
      gitlabProjectId: bindingDoc.gitlabProjectId,
      hulyProjectRef: bindingDoc.hulyProjectRef as unknown as Ref<Space>,
      hulyClient: workspace.txOperations
    }
  }

  /** MergeRequestsSyncManager loader form — IssuesBindingContext shape (MR ctx is a structural subset). */
  loadForMergeRequests = async (binding: BindingRef): Promise<MRBindingContext> => {
    const ctx = await this.loadInternal(binding)
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
      gitlabBaseUrl: ctx.gitlabBaseUrl,
      // Phase 3 (P3-T-07): per-actor token resolver. Stub in Phase 3 —
      // always returns undefined, triggering the service-account path with
      // warn log + visibility comment. P3-T-10 wires the real lookup.
      credentials: {
        resolveActorToken: async () => undefined
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
      gitlabBaseUrl: ctx.gitlabBaseUrl
    }
  }

  async close (): Promise<void> {
    for (const [, entry] of this.workspaceCache) {
      try {
        await closePlatformClient(entry.client)
      } catch (err) {
        this.logger.warn('BindingLoader: failed to close cached platform client', {
          err: err instanceof Error ? err.message : String(err)
        })
      }
    }
    this.workspaceCache.clear()
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
      gitlabBaseUrl
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
      // Expired — evict + close
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

    const entry: WorkspaceCacheEntry = {
      client,
      txOperations,
      identity,
      expiresAt: now + this.cacheTtlMs
    }
    this.workspaceCache.set(workspaceUuid, entry)
    return entry
  }
}
