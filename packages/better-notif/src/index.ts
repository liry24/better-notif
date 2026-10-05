import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api'
import * as z from 'zod'

import {
    deleteNotification,
    listUserNotifications,
    mutateNotifications,
    ownBatchSchema,
    notificationFilterSchema,
    unreadCount,
    userTargetSchema,
} from './management'
import { listNotifications, notificationWhere } from './query'
import { identifier, listQuerySchema } from './schema'
import { send, setState } from './server'
export type {
    NotificationFilter,
    UserNotificationQuery,
    NotificationPage,
    NotificationMutation,
    NotificationBatchResult,
} from './management'
import { createNotificationModel } from './fields'
import type { NotificationInput, NotificationFields, NotificationFieldFilters, NotificationKinds } from './fields'
export type {
    NotificationInput,
    NotificationContent,
    NotificationFields,
    NotificationKinds,
    NotificationSchema,
    NotificationFieldFilters,
    NotificationFilterField,
} from './fields'
import type { NotificationOptions, RecipientFilter } from './types'

export type { NotificationAction, NotificationListQuery } from './schema'
export type {
    ArchiveStateEvent,
    HookStatus,
    Notification,
    NotificationList,
    NotificationOptions,
    ReadStateEvent,
    RecipientAccount,
    RecipientContext,
    RecipientData,
    RecipientFilter,
    RecipientResult,
    RecipientSession,
    SendNotificationResult,
} from './types'

export function notification<
    TContext = undefined,
    const F extends NotificationFields = {},
    const K extends NotificationKinds<F> = {},
>(options: NotificationOptions<TContext, F, K> = {}) {
    const model = createNotificationModel(options.schema, options.kinds, options.filterableFields)
    const querySchema = listQuerySchema.extend({ fields: z.custom<NotificationFieldFilters<F>>().optional() })
    const countQuerySchema = querySchema.omit({ cursor: true, limit: true, read: true }).optional()
    const targetSchema = userTargetSchema.extend({
        filter: notificationFilterSchema
            .extend({ fields: z.custom<NotificationFieldFilters<F>>().optional() })
            .optional(),
    })
    return {
        id: 'notification',
        schema: model.schema,
        endpoints: {
            sendNotification: createAuthEndpoint.serverOnly(
                {
                    method: 'POST',
                    body: z.object({
                        recipients: z.union([z.array(identifier).max(10_000), z.literal('all')]),
                        notification: z.custom<NotificationInput<F, K>>(),
                        idempotencyKey: identifier,
                        cursor: identifier.optional(),
                        limit: z.number().int().min(1).max(100).default(100),
                        filter: z.custom<RecipientFilter<TContext>>((value) => typeof value === 'function').optional(),
                    }),
                },
                async (ctx) => {
                    const prepared = await model.prepare(ctx.body.notification)
                    return send(ctx.context, options, model, {
                        ...ctx.body,
                        notification: prepared.content,
                        contentHash: prepared.contentHash,
                    })
                },
            ),

            deleteNotification: createAuthEndpoint(
                '/notification/delete',
                {
                    method: 'POST',
                    body: z.strictObject({ id: identifier }),
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) => deleteNotification(ctx.context, ctx.context.session.user.id, ctx.body.id),
            ),
            deleteNotifications: createAuthEndpoint(
                '/notification/delete-many',
                {
                    method: 'POST',
                    body: ownBatchSchema,
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) =>
                    mutateNotifications(
                        ctx.context,
                        options,
                        model,
                        { ...ctx.body, userIds: [ctx.context.session.user.id] },
                        { field: 'delete' },
                    ),
            ),
            setNotificationsRead: createAuthEndpoint(
                '/notification/set-read-many',
                {
                    method: 'POST',
                    body: ownBatchSchema.extend({ read: z.boolean() }),
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) =>
                    mutateNotifications(
                        ctx.context,
                        options,
                        model,
                        { ...ctx.body, userIds: [ctx.context.session.user.id] },
                        { field: 'readAt', value: ctx.body.read },
                    ),
            ),
            setNotificationsArchived: createAuthEndpoint(
                '/notification/set-archived-many',
                {
                    method: 'POST',
                    body: ownBatchSchema.extend({ archived: z.boolean() }),
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) =>
                    mutateNotifications(
                        ctx.context,
                        options,
                        model,
                        { ...ctx.body, userIds: [ctx.context.session.user.id] },
                        { field: 'archivedAt', value: ctx.body.archived },
                    ),
            ),
            listUserNotifications: createAuthEndpoint.serverOnly({ method: 'GET', query: targetSchema }, async (ctx) =>
                listUserNotifications(ctx.context, model, ctx.query),
            ),
            getUserUnreadNotificationCount: createAuthEndpoint.serverOnly(
                { method: 'GET', query: targetSchema.pick({ userIds: true, filter: true }) },
                async (ctx) => unreadCount(ctx.context, model, ctx.query),
            ),
            setUserNotificationsRead: createAuthEndpoint.serverOnly(
                { method: 'POST', body: targetSchema.extend({ read: z.boolean() }) },
                async (ctx) =>
                    mutateNotifications(ctx.context, options, model, ctx.body, {
                        field: 'readAt',
                        value: ctx.body.read,
                    }),
            ),
            setUserNotificationsArchived: createAuthEndpoint.serverOnly(
                { method: 'POST', body: targetSchema.extend({ archived: z.boolean() }) },
                async (ctx) =>
                    mutateNotifications(ctx.context, options, model, ctx.body, {
                        field: 'archivedAt',
                        value: ctx.body.archived,
                    }),
            ),
            deleteUserNotifications: createAuthEndpoint.serverOnly(
                { method: 'POST', body: targetSchema },
                async (ctx) => mutateNotifications(ctx.context, options, model, ctx.body, { field: 'delete' }),
            ),
            listNotifications: createAuthEndpoint(
                '/notification/list',
                {
                    method: 'GET',
                    query: querySchema,
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) => listNotifications(ctx.context, model, ctx.context.session.user.id, ctx.query),
            ),
            getUnreadNotificationCount: createAuthEndpoint(
                '/notification/unread-count',
                {
                    method: 'GET',
                    query: countQuerySchema,
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) => ({
                    count: await ctx.context.adapter.count({
                        model: 'notification',
                        where: notificationWhere(
                            ctx.context.session.user.id,
                            { archived: 'unarchived', ...ctx.query, read: 'unread' },
                            model,
                        ),
                    }),
                }),
            ),
            setNotificationRead: createAuthEndpoint(
                '/notification/set-read',
                {
                    method: 'POST',
                    body: z.object({ id: identifier, read: z.boolean() }),
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) =>
                    setState(
                        ctx.context,
                        options,
                        model,
                        ctx.context.session.user.id,
                        ctx.body.id,
                        'readAt',
                        ctx.body.read,
                    ),
            ),
            setNotificationArchived: createAuthEndpoint(
                '/notification/set-archived',
                {
                    method: 'POST',
                    body: z.object({ id: identifier, archived: z.boolean() }),
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) =>
                    setState(
                        ctx.context,
                        options,
                        model,
                        ctx.context.session.user.id,
                        ctx.body.id,
                        'archivedAt',
                        ctx.body.archived,
                    ),
            ),
        },
        options,
    } satisfies BetterAuthPlugin
}

declare module '@better-auth/core' {
    interface BetterAuthPluginRegistry<AuthOptions, Options> {
        notification: { creator: typeof notification }
    }
}
