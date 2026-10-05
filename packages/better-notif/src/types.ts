import type { Account, AuthContext, Session, User } from 'better-auth'

import type {
    NotificationContent,
    NotificationFields,
    NotificationFilterField,
    NotificationKinds,
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
export type Notification<F extends NotificationFields = {}, K extends NotificationKinds<F> = {}> = NotificationRecord &
    (
        | (NotificationContent<F, K> & { schemaStatus: 'current' })
        | (BaseContent & { schemaStatus: 'legacy' } & {
              [N in keyof F as F[N]['returned'] extends false ? never : N]?: unknown
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

export interface ReadStateEvent {
    notificationId: string
    userId: string
    readAt: Date | null
}

export interface ArchiveStateEvent {
    notificationId: string
    userId: string
    archivedAt: Date | null
}

export interface NotificationOptions<
    TContext = undefined,
    F extends NotificationFields = {},
    K extends NotificationKinds<F> = {},
> {
    schema?: NotificationSchema<F>
    kinds?: K
    filterableFields?: readonly NotificationFilterField<F>[]
    loadContext?: (recipient: RecipientData) => TContext | Promise<TContext>
    onNotificationCreated?: (event: {
        notification: Notification<NoInfer<F>, NoInfer<K>>
        recipient: RecipientContext<TContext>
        idempotencyKey: string
    }) => void | Promise<void>
    onReadStateChanged?: (event: ReadStateEvent) => void | Promise<void>
    onArchiveStateChanged?: (event: ArchiveStateEvent) => void | Promise<void>
}

export type RecipientResult<F extends NotificationFields = {}, K extends NotificationKinds<F> = {}> =
    | { userId: string; status: 'created' | 'duplicate'; notification: Notification<F, K>; hook: HookStatus }
    | { userId: string; status: 'skipped' }
    | { userId: string; status: 'failed'; error: { code: string; message: string } }

export interface SendNotificationResult<F extends NotificationFields = {}, K extends NotificationKinds<F> = {}> {
    results: RecipientResult<F, K>[]
    nextCursor: string | null
    hasMore: boolean
}

export interface NotificationList<F extends NotificationFields = {}, K extends NotificationKinds<F> = {}> {
    notifications: Notification<F, K>[]
    total: number
    nextCursor: string | null
    hasMore: boolean
}

export type StoredNotification = BaseContent &
    NotificationRecord &
    Record<string, unknown> & { idempotencyKey: string; contentHash?: string | null }
