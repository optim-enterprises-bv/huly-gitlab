import { type Collection, type Filter, ObjectId } from 'mongodb'

export interface BindingDoc {
  _id: ObjectId
  workspaceUuid: string
  hulyProjectRef: string
  gitlabProjectId: number
  gitlabProjectPath: string
  credentialRef: string
  webhookSecretRef: string
  webhookId?: number
  webhookRegistered: boolean
  createdAt: Date
  disabled: boolean
}

/** Public-safe projection — excludes webhookSecretRef */
export interface BindingView {
  id: string
  workspaceUuid: string
  hulyProjectRef: string
  gitlabProjectId: number
  gitlabProjectPath: string
  credentialRef: string
  webhookId?: number
  webhookRegistered: boolean
  createdAt: Date
  disabled: boolean
}

export interface CreateBindingInput {
  workspaceUuid: string
  hulyProjectRef: string
  gitlabProjectId: number
  gitlabProjectPath: string
  credentialRef: string
  webhookSecretRef: string
}

function toView (doc: BindingDoc): BindingView {
  const view: BindingView = {
    id: doc._id.toHexString(),
    workspaceUuid: doc.workspaceUuid,
    hulyProjectRef: doc.hulyProjectRef,
    gitlabProjectId: doc.gitlabProjectId,
    gitlabProjectPath: doc.gitlabProjectPath,
    credentialRef: doc.credentialRef,
    webhookRegistered: doc.webhookRegistered,
    createdAt: doc.createdAt,
    disabled: doc.disabled
  }
  if (doc.webhookId !== undefined) {
    view.webhookId = doc.webhookId
  }
  return view
}

export async function createBinding (
  col: Collection<BindingDoc>,
  input: CreateBindingInput
): Promise<BindingView> {
  const doc: BindingDoc = {
    _id: new ObjectId(),
    workspaceUuid: input.workspaceUuid,
    hulyProjectRef: input.hulyProjectRef,
    gitlabProjectId: input.gitlabProjectId,
    gitlabProjectPath: input.gitlabProjectPath,
    credentialRef: input.credentialRef,
    webhookSecretRef: input.webhookSecretRef,
    webhookRegistered: false,
    createdAt: new Date(),
    disabled: false
  }
  await col.insertOne(doc)
  return toView(doc)
}

export async function getBinding (
  col: Collection<BindingDoc>,
  id: string
): Promise<BindingDoc | null> {
  return await col.findOne({ _id: new ObjectId(id) })
}

export async function listBindings (
  col: Collection<BindingDoc>,
  filter: { workspaceUuid?: string } = {}
): Promise<BindingView[]> {
  const query: Filter<BindingDoc> = {}
  if (filter.workspaceUuid !== undefined) {
    query.workspaceUuid = filter.workspaceUuid
  }
  const docs = await col.find(query).toArray()
  return docs.map(toView)
}

export async function updateBinding (
  col: Collection<BindingDoc>,
  id: string,
  update: Partial<Pick<BindingDoc, 'webhookId' | 'webhookRegistered' | 'disabled' | 'webhookSecretRef'>>
): Promise<void> {
  await col.updateOne({ _id: new ObjectId(id) }, { $set: update })
}

export async function deleteBinding (
  col: Collection<BindingDoc>,
  id: string
): Promise<void> {
  await col.deleteOne({ _id: new ObjectId(id) })
}
