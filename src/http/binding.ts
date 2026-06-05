import { randomBytes } from 'node:crypto'
import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import type { Store } from '../state/store'
import type { Logger } from '../logging'
import type { BindingLifecycleService } from '../sync/binding-lifecycle'
import { createBinding, getBinding, listBindings, deleteBinding } from '../state/bindings'
import { putCredential, deleteCredential, rotateCredential } from '../state/credentials'
import { requireBearer } from './auth-middleware'
import { parseObjectId } from '../util/object-id'
import { asyncHandler } from './async-handler'

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
  publicBaseUrl?: string
): Router {
  const router = createRouter()
  const auth = requireBearer(serverSecret)

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

  return router
}
