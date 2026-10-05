import type { Where } from '@better-auth/core/db/adapter'
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api'
import * as z from 'zod'

import {
    deleteNotification,
    listUserNotifications,
    mutateNotifications,
    ownBatchSchema,
    unreadCount,
    userTargetSchema,
} from './management'
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
import type { NotificationInput, NotificationFields, NotificationKinds } from './fields'
export type {
    NotificationInput,
    NotificationContent,
    NotificationFields,
    NotificationKinds,
    NotificationSchema,
} from './fields'
import type { NotificationList, NotificationOptions, RecipientFilter, StoredNotification } from './types'

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
    const model = createNotificationModel(options.schema, options.kinds)
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
            listUserNotifications: createAuthEndpoint.serverOnly(
                { method: 'GET', query: userTargetSchema },
                async (ctx) => listUserNotifications(ctx.context, model, ctx.query),
            ),
            getUserUnreadNotificationCount: createAuthEndpoint.serverOnly(
                { method: 'GET', query: userTargetSchema.pick({ userIds: true }) },
                async (ctx) => unreadCount(ctx.context, ctx.query.userIds),
            ),
            setUserNotificationsRead: createAuthEndpoint.serverOnly(
                { method: 'POST', body: userTargetSchema.extend({ read: z.boolean() }) },
                async (ctx) =>
                    mutateNotifications(ctx.context, options, model, ctx.body, {
                        field: 'readAt',
                        value: ctx.body.read,
                    }),
            ),
            setUserNotificationsArchived: createAuthEndpoint.serverOnly(
                { method: 'POST', body: userTargetSchema.extend({ archived: z.boolean() }) },
                async (ctx) =>
                    mutateNotifications(ctx.context, options, model, ctx.body, {
                        field: 'archivedAt',
                        value: ctx.body.archived,
                    }),
            ),
            deleteUserNotifications: createAuthEndpoint.serverOnly(
                { method: 'POST', body: userTargetSchema },
                async (ctx) => mutateNotifications(ctx.context, options, model, ctx.body, { field: 'delete' }),
            ),
            listNotifications: createAuthEndpoint(
                '/notification/list',
                {
                    method: 'GET',
                    query: listQuerySchema,
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx): Promise<NotificationList<F, K>> => {
                    const { read, archived, limit, offset } = ctx.query
                    const where: Where[] = [{ field: 'userId', value: ctx.context.session.user.id }]
                    if (read !== 'all')
                        where.push({ field: 'readAt', operator: read === 'unread' ? 'eq' : 'ne', value: null })
                    if (archived !== 'all')
                        where.push({
                            field: 'archivedAt',
                            operator: archived === 'unarchived' ? 'eq' : 'ne',
                            value: null,
                        })
                    const [rows, total] = await Promise.all([
                        ctx.context.adapter.findMany<StoredNotification>({
                            model: 'notification',
                            where,
                            limit,
                            offset,
                            sortBy: { field: 'createdAt', direction: 'desc' },
                        }),
                        ctx.context.adapter.count({ model: 'notification', where }),
                    ])
                    return {
                        notifications: await Promise.all(rows.map((row) => model.present(row))),
                        total,
                        nextOffset: rows.length > 0 && offset + rows.length < total ? offset + rows.length : null,
                    }
                },
            ),
            getUnreadNotificationCount: createAuthEndpoint(
                '/notification/unread-count',
                {
                    method: 'GET',
                    use: [sessionMiddleware],
                    metadata: { noStore: true },
                },
                async (ctx) => ({
                    count: await ctx.context.adapter.count({
                        model: 'notification',
                        where: [
                            { field: 'userId', value: ctx.context.session.user.id },
                            { field: 'readAt', value: null },
                            { field: 'archivedAt', value: null },
                        ],
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
