import { randomBytes } from 'node:crypto'
import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import type { Store } from '../state/store'
import type { Logger } from '../logging'
import type { BindingLifecycleService } from '../sync/binding-lifecycle'
import { createBinding, getBinding, listBindings, deleteBinding, updateBinding } from '../state/bindings'
import { putCredential, deleteCredential, rotateCredential } from '../state/credentials'
import { requireBearer } from './auth-middleware'
import { parseObjectId } from '../util/object-id'
import { asyncHandler } from './async-handler'
import { rateLimit } from './rate-limit'
import { migrateReviewerLabels, type ReviewerMigrationResult } from '../sync/reviewer-migration'
import { migrateMixinSplit, type MixinSplitMigrationResult } from '../sync/mixin-migration'
import type { BindingLoader } from '../sync/binding-loader'
import { invalidateGraphQLCapability, getGraphQLCapabilityCacheSize } from '../adapter/gitlab-graphql-client'

interface CreateBindingBody {
  workspaceUuid: string
  hulyProjectRef: string
  gitlabProjectId: number
  gitlabProjectPath: string
  credentialRef: string
}

export interface BindingRouterDeps {
  store: Store
  encryptionKey: Buffer
  serverSecret: string
  logger: Logger
  bindingLifecycle?: BindingLifecycleService
  publicBaseUrl?: string
}

export function createBindingRouter (
  store: Store,
  encryptionKey: Buffer,
  serverSecret: string,
  logger: Logger,
  bindingLifecycle?: BindingLifecycleService,
  publicBaseUrl?: string,
  bindingLoader?: BindingLoader
): Router {
  const router = createRouter()
  const auth = requireBearer(serverSecret)
  const adminRateLimit = rateLimit({ capacity: 10, refillPerSecond: 10 / 60 })

  // POST /api/v1/bindings
  router.post('/api/v1/bindings', auth, asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Partial<CreateBindingBody>

    if (
      typeof body.workspaceUuid !== 'string' ||
      typeof body.hulyProjectRef !== 'string' ||
      typeof body.gitlabProjectId !== 'number' ||
      typeof body.gitlabProjectPath !== 'string' ||
      typeof body.credentialRef !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid request body' })
      return
    }

    if (parseObjectId(body.credentialRef) === null) {
      res.status(400).json({ error: 'invalid id format' })
      return
    }

    // Generate random 32-byte webhook secret
    const secretBytes = randomBytes(32)
    const secretPlaintext = secretBytes.toString('base64')

    // Store secret encrypted in credentials collection
    const webhookSecretRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'webhook_secret',
      plaintext: secretPlaintext
    })

    logger.info('binding: creating binding', {
      workspaceUuid: body.workspaceUuid,
      gitlabProjectId: body.gitlabProjectId
    })

    const view = await createBinding(store.bindings(), {
      workspaceUuid: body.workspaceUuid,
      hulyProjectRef: body.hulyProjectRef,
      gitlabProjectId: body.gitlabProjectId,
      gitlabProjectPath: body.gitlabProjectPath,
      credentialRef: body.credentialRef,
      webhookSecretRef
    })

    let webhookRegistered = false
    let webhookId: number | undefined

    if (bindingLifecycle !== undefined && publicBaseUrl !== undefined) {
      // Fetch the raw BindingDoc so lifecycle has full access (including webhookSecretRef)
      const bindingDoc = await getBinding(store.bindings(), view.id)
      if (bindingDoc !== null) {
        const result = await bindingLifecycle.onBindingCreate(bindingDoc, publicBaseUrl)
        webhookRegistered = result.webhookRegistered
        webhookId = result.webhookId
      }
    }

    const responseBody: Record<string, unknown> = { bindingId: view.id, webhookRegistered }
    if (webhookId !== undefined) {
      responseBody.webhookId = webhookId
    }

    res.status(201).json(responseBody)
  }))

  // GET /api/v1/bindings?workspaceUuid=...
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.get('/api/v1/bindings', auth, async (req: Request, res: Response) => {
    const workspaceUuid = typeof req.query.workspaceUuid === 'string' ? req.query.workspaceUuid : undefined
    const views = await listBindings(store.bindings(), { workspaceUuid })
    // BindingView already excludes webhookSecretRef and webhookSecret (see state/bindings.ts toView())
    res.status(200).json(views)
  })

  // DELETE /api/v1/bindings/:id
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.delete('/api/v1/bindings/:id', auth, async (req: Request, res: Response) => {
    const { id } = req.params

    if (parseObjectId(id) === null) {
      res.status(400).json({ error: 'invalid id format' })
      return
    }

    // Look up binding to get webhookSecretRef before deleting
    let binding
    try {
      binding = await getBinding(store.bindings(), id)
    } catch (_err) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    if (binding === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    // Best-effort webhook deregistration before deleting state
    if (bindingLifecycle !== undefined) {
      await bindingLifecycle.onBindingDelete(binding)
    }

    // Delete credential record for webhookSecret
    await deleteCredential(store.credentials(), binding.webhookSecretRef)

    // Delete the binding
    await deleteBinding(store.bindings(), id)

    logger.info('binding: deleted binding', { id, webhookSecretRef: binding.webhookSecretRef })
    res.status(200).json({ deleted: true })
  })

  // POST /api/v1/bindings/:id/rotate-secret
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/api/v1/bindings/:id/rotate-secret', auth, async (req: Request, res: Response) => {
    const { id } = req.params

    if (parseObjectId(id) === null) {
      res.status(400).json({ error: 'invalid id format' })
      return
    }

    const binding = await getBinding(store.bindings(), id)
    if (binding === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const newSecret = randomBytes(32).toString('base64')

    await rotateCredential(store.credentials(), encryptionKey, binding.webhookSecretRef, { plaintext: newSecret })

    const rotatedAt = new Date().toISOString()
    let webhookRegistered = binding.webhookRegistered ?? false
    let reason: string | undefined

    if (webhookRegistered && binding.webhookId !== undefined && bindingLifecycle !== undefined && publicBaseUrl !== undefined) {
      const result = await bindingLifecycle.rotateWebhookSecret(binding, newSecret, publicBaseUrl)
      webhookRegistered = result.webhookRegistered
      reason = result.reason
    } else if (bindingLifecycle !== undefined && (binding.webhookId !== undefined) && publicBaseUrl === undefined) {
      // No publicBaseUrl — can't re-register; mark as unregistered
      webhookRegistered = false
    }

    const responseBody: Record<string, unknown> = { rotatedAt, webhookRegistered }
    if (reason !== undefined) {
      responseBody.reason = reason
    }

    logger.info('binding: rotated webhook secret', { id, webhookRegistered })
    res.status(200).json(responseBody)
  })

  // POST /api/v1/bindings/:id/re-register-webhook
  router.post('/api/v1/bindings/:id/re-register-webhook', auth, asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params

    if (parseObjectId(id) === null) {
      res.status(400).json({ error: 'invalid id format' })
      return
    }

    const binding = await getBinding(store.bindings(), id)
    if (binding === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const rotatedAt = new Date().toISOString()

    let webhookRegistered = binding.webhookRegistered ?? false
    let webhookId: number | undefined = binding.webhookId
    let reason: string | undefined

    if (bindingLifecycle !== undefined && publicBaseUrl !== undefined) {
      const result = await bindingLifecycle.reRegisterWebhook(binding, publicBaseUrl)
      webhookRegistered = result.webhookRegistered
      webhookId = result.webhookId
      reason = result.reason
    }

    const responseBody: Record<string, unknown> = { rotatedAt, webhookRegistered }
    if (webhookId !== undefined) {
      responseBody.webhookId = webhookId
    }
    if (reason !== undefined) {
      responseBody.reason = reason
    }

    logger.info('binding: re-registered webhook', { id, webhookRegistered })
    res.status(200).json(responseBody)
  }))

  // PATCH /api/v1/bindings/:id — operator pause/resume toggle (Q3 convention)
  router.patch('/api/v1/bindings/:id', auth, asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params

    if (parseObjectId(id) === null) {
      res.status(400).json({ error: 'invalid id format' })
      return
    }

    const binding = await getBinding(store.bindings(), id)
    if (binding === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const body = req.body as { disabled?: unknown }
    const update: { disabled?: boolean } = {}
    if (typeof body.disabled === 'boolean') {
      update.disabled = body.disabled
    }

    if (update.disabled !== undefined) {
      await updateBinding(store.bindings(), id, update)
    }

    const refreshed = await getBinding(store.bindings(), id)
    if (refreshed === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const view: Record<string, unknown> = {
      id: refreshed._id.toHexString(),
      workspaceUuid: refreshed.workspaceUuid,
      hulyProjectRef: refreshed.hulyProjectRef,
      gitlabProjectId: refreshed.gitlabProjectId,
      gitlabProjectPath: refreshed.gitlabProjectPath,
      credentialRef: refreshed.credentialRef,
      webhookRegistered: refreshed.webhookRegistered,
      createdAt: refreshed.createdAt,
      disabled: refreshed.disabled
    }
    if (refreshed.webhookId !== undefined) view.webhookId = refreshed.webhookId

    logger.info('binding: patched binding', { id, disabled: refreshed.disabled })
    res.status(200).json(view)
  }))

  // POST /api/v1/bindings/:id/migrate-reviewer-labels — Phase 3 reviewer migration (Q3)
  router.post('/api/v1/bindings/:id/migrate-reviewer-labels', auth, asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params

    if (parseObjectId(id) === null) {
      res.status(400).json({ error: 'invalid id format' })
      return
    }

    const binding = await getBinding(store.bindings(), id)
    if (binding === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    if (!binding.disabled) {
      res.status(409).json({
        error: 'binding active',
        message: 'Pause binding (PATCH /api/v1/bindings/:id with {disabled: true}) before running migration; re-enable after.'
      })
      return
    }

    if (bindingLoader === undefined) {
      logger.error('binding: migrate-reviewer-labels called without bindingLoader wired', { id })
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    const bctx = await bindingLoader.loadForMergeRequests(id)
    const result: ReviewerMigrationResult = await migrateReviewerLabels(
      {
        store,
        hulyClient: bctx.hulyClient,
        userIdentity: bctx.userIdentity,
        logger
      },
      binding
    )

    logger.info('binding: reviewer label migration complete', { id, ...result })
    res.status(200).json(result)
  }))

  // POST /api/v1/bindings/:id/migrate-mixin-split — Phase 5 P5-T-19 mixin-split migration (Q3)
  router.post('/api/v1/bindings/:id/migrate-mixin-split', auth, adminRateLimit, asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params

    if (parseObjectId(id) === null) {
      res.status(400).json({ error: 'invalid id format' })
      return
    }

    const binding = await getBinding(store.bindings(), id)
    if (binding === null) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    if (!binding.disabled) {
      res.status(409).json({
        error: 'binding active',
        message: 'Pause binding (PATCH /api/v1/bindings/:id with {disabled: true}) before running mixin-split migration; re-enable after.'
      })
      return
    }

    if (bindingLoader === undefined) {
      logger.error('binding: migrate-mixin-split called without bindingLoader wired', { id })
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    const bctx = await bindingLoader.loadForMergeRequests(id)
    const result: MixinSplitMigrationResult = await migrateMixinSplit(
      {
        store,
        hulyClient: bctx.hulyClient,
        logger
      },
      binding
    )

    logger.info('binding: mixin-split migration complete', { id, ...result })
    res.status(200).json(result)
  }))

  // POST /api/v1/admin/invalidate-graphql-cache — Phase 5 P5-T-21 critic B5
  // Manual operator hook to bust the per-baseUrl GraphQL capability cache.
  // Optional body `{baseUrl}` invalidates one entry; omitted body invalidates all.
  router.post('/api/v1/admin/invalidate-graphql-cache', auth, adminRateLimit, asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { baseUrl?: unknown }
    let invalidated: string
    if (typeof body.baseUrl === 'string' && body.baseUrl.length > 0) {
      invalidateGraphQLCapability(body.baseUrl)
      invalidated = body.baseUrl
    } else {
      invalidateGraphQLCapability()
      invalidated = 'all'
    }
    const cacheSize = getGraphQLCapabilityCacheSize()
    logger.info('binding: invalidated graphql capability cache', { invalidated, cacheSize })
    res.status(200).json({ invalidated, cacheSize })
  }))

  return router
}
