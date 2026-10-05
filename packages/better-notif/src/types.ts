import type { Account, AuthContext, Session, User } from 'better-auth'

import type {
    NotificationContent,
    NotificationChanges,
    NotificationFields,
    NotificationFieldsOf,
    NotificationFilterField,
    NotificationTypes,
    NotificationSchema,
} from './fields'
import type { BaseContent } from './schema'

// Depend on the capabilities used here, not unrelated plugin-registry inference.
export type NotificationContext = Pick<AuthContext, 'adapter' | 'logger'> & {
    options: Pick<AuthContext['options'], 'secondaryStorage'>
    internalAdapter: Pick<AuthContext['internalAdapter'], 'listSessions'>
}
interface NotificationRecord {
    id: string
    userId: string
    createdAt: Date
    readAt: Date | null
    archivedAt: Date | null
}
export type Notification<F extends NotificationFields = {}, K extends NotificationTypes = {}> = NotificationRecord &
    (
        | (NotificationContent<F, K> & { schemaStatus: 'current' })
        | (BaseContent & { schemaStatus: 'legacy' } & {
              [
                  N in keyof NotificationFieldsOf<F, K> as NotificationFieldsOf<F, K>[N]['returned'] extends false
                      ? never
                      : N
              ]?: unknown
          })
    )
export type RecipientAccount = Pick<
    Account,
    | 'id'
    | 'userId'
    | 'accountId'
    | 'providerId'
    | 'scope'
    | 'createdAt'
    | 'updatedAt'
    | 'accessTokenExpiresAt'
    | 'refreshTokenExpiresAt'
>
export type RecipientSession = Omit<Session, 'token'>
export interface RecipientData {
    user: User & Record<string, unknown>
    accounts: RecipientAccount[]
    sessions: RecipientSession[]
}
export type RecipientContext<TContext = undefined> = RecipientData & { context: TContext | undefined }
export type RecipientFilter<TContext = undefined> = (
    recipient: RecipientContext<TContext>,
) => boolean | Promise<boolean>
export type HookStatus = 'completed' | 'failed' | 'skipped'

export type NotificationOperation = 'create' | 'list' | 'setRead' | 'setArchived' | 'delete'
export interface NotificationSession {
    user: User & Record<string, unknown>
    session: Session
}
export interface NotificationActor {
    session: NotificationSession | null
    headers: Headers
    managed?: boolean
}
interface OperationContext<O extends NotificationOperation> {
    operation: O
    session: NotificationSession | null
    headers: Headers
    userId: string
}
export type NotificationCreateContext<
    TContext = undefined,
    F extends NotificationFields = {},
    K extends NotificationTypes = {},
> = OperationContext<'create'> & {
    record: Notification<F, K> | null
    changes: NotificationChanges<F, K>
    recipient: RecipientContext<TContext>
    idempotencyKey: string
}
export type NotificationMutationContext<
    F extends NotificationFields = {},
    K extends NotificationTypes = {},
    O extends 'setRead' | 'setArchived' | 'delete' = 'setRead' | 'setArchived' | 'delete',
> = OperationContext<O> & {
    record: Notification<F, K>
    changes: O extends 'setRead'
        ? { readAt: Date | null }
        : O extends 'setArchived'
          ? { archivedAt: Date | null }
          : Record<string, never>
}
export type NotificationListContext = OperationContext<'list'>
type Awaitable<T> = T | Promise<T>
type Policy<E> = (event: E) => Awaitable<boolean>
export interface NotificationScope<F extends NotificationFields = {}> {
    where: readonly {
        field: (keyof F & string) | 'id' | 'userId' | 'type' | 'title' | 'createdAt' | 'readAt' | 'archivedAt'
        operator?: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in'
        value: string | number | boolean | Date | null | string[] | number[]
    }[]
}
export interface NotificationAccess<
    TContext = undefined,
    F extends NotificationFields = {},
    K extends NotificationTypes = {},
> {
    create?: Policy<NotificationCreateContext<TContext, F, K>>
    list?: (event: NotificationListContext) => Awaitable<false | NotificationScope<NotificationFieldsOf<F, K>>>
    setRead?: Policy<NotificationMutationContext<F, K, 'setRead'>>
    setArchived?: Policy<NotificationMutationContext<F, K, 'setArchived'>>
    delete?: Policy<NotificationMutationContext<F, K, 'delete'>>
}
export interface NotificationLifecycle<Before, After = Before> {
    before?: (event: Before) => void | Promise<void>
    after?: (event: After) => void | Promise<void>
}
export interface NotificationHooks<
    TContext = undefined,
    F extends NotificationFields = {},
    K extends NotificationTypes = {},
> {
    create?: NotificationLifecycle<
        NotificationCreateContext<TContext, F, K> & { previous: null },
        NotificationCreateContext<TContext, F, K> & { record: Notification<F, K>; previous: null }
    >
    list?: NotificationLifecycle<NotificationListContext>
    setRead?: NotificationLifecycle<NotificationMutationContext<F, K, 'setRead'> & { previous: Notification<F, K> }>
    setArchived?: NotificationLifecycle<
        NotificationMutationContext<F, K, 'setArchived'> & { previous: Notification<F, K> }
    >
    delete?: NotificationLifecycle<NotificationMutationContext<F, K, 'delete'> & { previous: Notification<F, K> }>
}
export interface NotificationOptions<
    TContext = undefined,
    F extends NotificationFields = {},
    K extends NotificationTypes = {},
> {
    fields?: F
    types?: K
    schema?: NotificationSchema
    list?: { filters?: readonly NotificationFilterField<NotificationFieldsOf<F, K>>[] }
    loadContext?: (recipient: RecipientData) => TContext | Promise<TContext>
    access?: NotificationAccess<TContext, NoInfer<F>, NoInfer<K>>
    hooks?: NotificationHooks<TContext, NoInfer<F>, NoInfer<K>>
}
export type RecipientResult<F extends NotificationFields = {}, K extends NotificationTypes = {}> =
    | { userId: string; status: 'created' | 'duplicate'; notification: Notification<F, K>; hook: HookStatus }
    | { userId: string; status: 'skipped' }
    | { userId: string; status: 'failed'; error: { code: string; message: string } }
export interface SendNotificationResult<F extends NotificationFields = {}, K extends NotificationTypes = {}> {
    results: RecipientResult<F, K>[]
    nextCursor: string | null
    hasMore: boolean
}
export interface NotificationCount {
    count: number
    hook: HookStatus
}
export interface NotificationList<F extends NotificationFields = {}, K extends NotificationTypes = {}> {
    hook: HookStatus
    notifications: Notification<F, K>[]
    total: number
    nextCursor: string | null
    hasMore: boolean
}
export type StoredNotification = BaseContent &
    NotificationRecord &
    Record<string, unknown> & { idempotencyKey: string; contentHash?: string | null }
