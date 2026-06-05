/**
 * Ambient module declarations for @hcengineering/* packages that lack bundled .d.ts files.
 * Covers only the API surface used by src/huly/*.
 */

declare module '@hcengineering/core' {
  export type PersonUuid = string & { __personUuid: never }
  export type WorkspaceUuid = string & { __workspaceUuid: never }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export type Ref<_T> = string & { __ref: never }

  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface TxResult {}

  export interface ClassShape {
    __class: unknown
  }
  export type Class<T extends Doc> = ClassShape & { __classOf: T }

  /** A mixin is structurally identical to Class — it extends Class<T>. */
  export type Mixin<T extends Doc> = Class<T>

  /** Non-optional mixin fields only (used for createMixin). */
  export type MixinData<D extends Doc, M extends D> = Omit<M, keyof D>

  /** Partial mixin fields (used for updateMixin). */
  export type MixinUpdate<D extends Doc, M extends D> = Partial<Omit<M, keyof D>>

  export interface Doc {
    _id: Ref<Doc>
    _class: Ref<Class<Doc>>
    space: Ref<Doc>
    modifiedOn: number
    modifiedBy: Ref<Doc>
    createdOn?: number
    createdBy?: Ref<Doc>
  }

  export interface Space extends Doc {
    name: string
    description: string
    members: Array<Ref<Doc>>
    archived: boolean
    private: boolean
  }

  export interface AttachedDoc extends Doc {
    attachedTo: Ref<Doc>
    attachedToClass: Ref<Class<Doc>>
    collection: string
  }

  export interface MeasureContext {
    measure: (name: string, ops: number) => void
    info: (msg: string, extra?: Record<string, unknown>) => void
    error: (msg: string, extra?: Record<string, unknown>) => void
    warn: (msg: string, extra?: Record<string, unknown>) => void
  }

  /**
   * Default in-process MeasureContext implementation. The real platform class
   * accepts richer config (logger, parent, traces); we only use it as a plain
   * counter/log holder so the no-arg constructor surface is what we declare.
   */
  export class MeasureMetricsContext implements MeasureContext {
    constructor (name?: string, params?: Record<string, unknown>)
    measure (name: string, ops: number): void
    info (msg: string, extra?: Record<string, unknown>): void
    error (msg: string, extra?: Record<string, unknown>): void
    warn (msg: string, extra?: Record<string, unknown>): void
  }

  export interface Client {
    findOne: <T extends Doc>(
      _class: Ref<Class<T>>,
      query: Partial<T>
    ) => Promise<T | undefined>
    findAll: <T extends Doc>(
      _class: Ref<Class<T>>,
      query: Partial<T>
    ) => Promise<T[]>
    close: () => Promise<void>
  }

  /**
   * Subset of TxOperations used by IssuesSyncManager.
   * Real platform TxOperations exposes the full transaction surface; we only
   * need the doc CRUD helpers + findOne/findAll.
   */
  export interface TxOperations extends Client {
    createDoc: <T extends Doc>(
      _class: Ref<Class<T>>,
      space: Ref<Space>,
      attributes: Partial<T>,
      id?: Ref<T>
    ) => Promise<Ref<T>>
    updateDoc: <T extends Doc>(
      _class: Ref<Class<T>>,
      space: Ref<Space>,
      objectId: Ref<T>,
      operations: Partial<T>
    ) => Promise<void>
    createMixin: <D extends Doc, M extends D>(
      objectId: Ref<D>,
      objectClass: Ref<Class<D>>,
      objectSpace: Ref<Space>,
      mixin: Ref<Mixin<M>>,
      attributes: MixinData<D, M>
    ) => Promise<TxResult>
    updateMixin: <D extends Doc, M extends D>(
      objectId: Ref<D>,
      objectClass: Ref<Class<D>>,
      objectSpace: Ref<Space>,
      mixin: Ref<Mixin<M>>,
      attributes: MixinUpdate<D, M>
    ) => Promise<TxResult>
  }

  export const systemAccountUuid: PersonUuid
}

declare module '@hcengineering/platform' {
  export function setMetadata (key: unknown, value: unknown): void
  export function getMetadata (key: unknown): unknown
}

declare module '@hcengineering/client' {
  export interface ClientSocket {
    __clientSocket: true
  }

  export enum ClientConnectEvent {
    Connected = 'connected',
    Reconnected = 'reconnected',
    Upgraded = 'upgraded',
    Refresh = 'refresh'
  }

  const clientPlugin: {
    metadata: {
      UseBinaryProtocol: unknown
      UseProtocolCompression: unknown
      ConnectionTimeout: unknown
      FilterModel: unknown
      ClientSocketFactory: unknown
    }
  }

  export default clientPlugin
}

declare module '@hcengineering/client-resources' {
  import type { Client } from '@hcengineering/core'

  export interface GetClientOptions {
    ctx?: unknown
    onConnect?: unknown
    useGlobalRPCHandler?: boolean
  }

  export interface ClientFactory {
    function: {
      GetClient: (token: string, endpoint: string, opts?: GetClientOptions) => Promise<Client>
    }
  }

  function clientResources (): Promise<ClientFactory>
  export default clientResources
}

declare module '@hcengineering/server-client' {
  export function getTransactorEndpoint (
    token: string,
    kind?: 'external' | 'internal'
  ): Promise<string>
}

declare module '@hcengineering/server-token' {
  import type { PersonUuid, WorkspaceUuid } from '@hcengineering/core'
  export function generateToken (
    account: PersonUuid,
    workspace: WorkspaceUuid,
    extra?: Record<string, string>
  ): string
  export const systemAccountUuid: PersonUuid
}

declare module '@hcengineering/account-client' {
  import type { PersonUuid } from '@hcengineering/core'

  export class AccountClient {
    findPersonBySocialKey (key: string): Promise<PersonUuid | undefined>
  }

  /**
   * Factory used by the platform to obtain an AccountClient bound to a token.
   * Real signature: getClient(accountsUrl, token, retryTimeoutMs?) — we only
   * type the two parameters we pass.
   */
  export function getClient (accountsUrl: string, token?: string): AccountClient
}

declare module '@hcengineering/tracker' {
  import type { Doc, Ref, Space, Class, AttachedDoc } from '@hcengineering/core'

  export interface Project extends Space {
    identifier: string
    sequence: number
    type: Ref<ProjectType>
    defaultIssueStatus: Ref<IssueStatus>
  }

  export interface ProjectType extends Doc {
    name: string
    tasks: Array<Ref<TaskType>>
  }

  export interface TaskType extends Doc {
    name: string
    statuses: Array<Ref<IssueStatus>>
  }

  export interface IssueStatus extends Doc {
    name: string
    category: Ref<Doc>
  }

  export type Status = IssueStatus

  export enum IssuePriority {
    NoPriority = 0,
    Urgent = 1,
    High = 2,
    Medium = 3,
    Low = 4
  }

  export interface Issue extends AttachedDoc {
    title: string
    description: string
    status: Ref<IssueStatus>
    priority: IssuePriority
    assignee: Ref<Doc> | null
    labels?: Array<Ref<Doc>>
    milestone?: Ref<Milestone> | null
    kind: Ref<TaskType>
    component?: Ref<Doc> | null
    rank?: string
    dueDate?: number | null
  }

  export interface Milestone extends Doc {
    label: string
    description?: string
  }

  const tracker: {
    class: {
      Project: Ref<Class<Project>>
      ProjectType: Ref<Class<ProjectType>>
      TaskType: Ref<Class<TaskType>>
      IssueStatus: Ref<Class<IssueStatus>>
      Issue: Ref<Class<Issue>>
      Milestone: Ref<Class<Milestone>>
    }
  }

  export default tracker
}

declare module '@hcengineering/tags' {
  import type { Doc, Ref, Class } from '@hcengineering/core'

  export interface TagCategory extends Doc {
    label: string
    targetClass: Ref<Class<Doc>>
    tags: Array<Ref<TagElement>>
  }

  export interface TagElement extends Doc {
    title: string
    targetClass: Ref<Class<Doc>>
    color?: number
    description?: string
    category?: Ref<TagCategory>
  }

  const tags: {
    class: {
      TagElement: Ref<Class<TagElement>>
      TagCategory: Ref<Class<TagCategory>>
    }
  }

  export default tags
}

declare module '@hcengineering/task' {
  import type { Doc, Ref, Class } from '@hcengineering/core'

  export interface ProjectType extends Doc {
    name: string
    tasks: Array<Ref<TaskType>>
  }

  export interface TaskType extends Doc {
    name: string
    statuses: Array<Ref<IssueStatus>>
  }

  export interface IssueStatus extends Doc {
    name: string
    category: Ref<Doc>
  }

  const task: {
    class: {
      ProjectType: Ref<Class<ProjectType>>
      TaskType: Ref<Class<TaskType>>
    }
  }

  export default task
}

declare module '@hcengineering/chunter' {
  import type { AttachedDoc, Ref, Class } from '@hcengineering/core'

  export interface ChatMessage extends AttachedDoc {
    message: string
  }

  const chunter: {
    class: {
      ChatMessage: Ref<Class<ChatMessage>>
    }
  }

  export default chunter
}
