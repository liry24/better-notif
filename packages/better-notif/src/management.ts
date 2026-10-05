/* oxlint-disable no-await-in-loop -- Bounded sequential writes keep hook and adapter load predictable. */
import type { AuthContext } from '@better-auth/core'
import type { Where } from '@better-auth/core/db/adapter'
import * as z from 'zod'

import type { NotificationFields, NotificationKinds, NotificationModel } from './fields'
import { identifier } from './schema'
import { setState } from './server'
import type { HookStatus, Notification, NotificationOptions, StoredNotification } from './types'

const ids = z.array(identifier).min(1).max(100)
const page = { limit: z.number().int().min(1).max(100).default(100), cursor: identifier.optional() }
export const notificationFilterSchema = z.strictObject({
    type: z.string().min(1).max(100).optional(),
    read: z.enum(['all', 'read', 'unread']).optional(),
    archived: z.enum(['all', 'archived', 'unarchived']).optional(),
    createdBefore: z.coerce.date<Date | string>().optional(),
})
export const userTargetSchema = z.strictObject({
    userIds: z.union([ids, z.literal('all')]),
    ids: ids.optional(),
    filter: notificationFilterSchema.optional(),
    ...page,
})
export const ownBatchSchema = z.strictObject({ ids, ...page })
export type NotificationFilter = z.input<typeof notificationFilterSchema>
export type UserNotificationQuery = z.input<typeof userTargetSchema>
type Target = z.output<typeof userTargetSchema>

export interface NotificationPage<F extends NotificationFields = {}, K extends NotificationKinds<F> = {}> {
    notifications: Notification<F, K>[]
    nextCursor: string | null
    hasMore: boolean
}
export type NotificationMutation<F extends NotificationFields = {}, K extends NotificationKinds<F> = {}> =
    | { id: string; status: 'updated' | 'unchanged'; notification: Notification<F, K>; hook: HookStatus }
    | { id: string; status: 'deleted' | 'not_found' }
    | { id: string; status: 'failed'; error: { code: string; message: string } }
export interface NotificationBatchResult<F extends NotificationFields = {}, K extends NotificationKinds<F> = {}> {
    results: NotificationMutation<F, K>[]
    nextCursor: string | null
    hasMore: boolean
}

function scope(target: Target): Where[] {
    const where: Where[] =
        target.userIds === 'all' ? [] : [{ field: 'userId', operator: 'in', value: [...new Set(target.userIds)] }]
    const filter = target.filter
    if (filter?.type !== undefined) where.push({ field: 'type', value: filter.type })
    if (filter?.createdBefore) where.push({ field: 'createdAt', operator: 'lt', value: filter.createdBefore })
    if (filter?.read && filter.read !== 'all')
        where.push({ field: 'readAt', operator: filter.read === 'read' ? 'ne' : 'eq', value: null })
    if (filter?.archived && filter.archived !== 'all')
        where.push({ field: 'archivedAt', operator: filter.archived === 'archived' ? 'ne' : 'eq', value: null })
    return where
}

export async function listUserNotifications<F extends NotificationFields, K extends NotificationKinds<F>>(
    ctx: AuthContext,
    model: NotificationModel<F, K>,
    target: Target,
): Promise<NotificationPage<F, K>> {
    const rows = await ctx.adapter.findMany<StoredNotification>({
        model: 'notification',
        where: [
            ...scope(target),
            ...(target.ids ? [{ field: 'id', operator: 'in' as const, value: target.ids }] : []),
            ...(target.cursor ? [{ field: 'id', operator: 'gt' as const, value: target.cursor }] : []),
        ],
        sortBy: { field: 'id', direction: 'asc' },
        limit: target.limit + 1,
    })
    const hasMore = rows.length > target.limit
    return {
        notifications: await Promise.all(rows.slice(0, target.limit).map((row) => model.present(row))),
        hasMore,
        nextCursor: hasMore ? rows[target.limit - 1]!.id : null,
    }
}

export async function unreadCount(ctx: AuthContext, userIds: Target['userIds']) {
    return {
        count: await ctx.adapter.count({
            model: 'notification',
            where: scope({ userIds, limit: 100, filter: { read: 'unread', archived: 'unarchived' } }),
        }),
    }
}

export async function deleteNotification(ctx: AuthContext, userId: string, id: string) {
    return {
        deleted:
            (await ctx.adapter.deleteMany({
                model: 'notification',
                where: [
                    { field: 'id', value: id },
                    { field: 'userId', value: userId },
                ],
            })) > 0,
    }
}

export async function mutateNotifications<TContext, F extends NotificationFields, K extends NotificationKinds<F>>(
    ctx: AuthContext,
    options: NotificationOptions<TContext, F, K>,
    model: NotificationModel<F, K>,
    target: Target,
    operation: { field: 'readAt' | 'archivedAt'; value: boolean } | { field: 'delete' },
): Promise<NotificationBatchResult<F, K>> {
    const where = scope(target)
    // Explicit IDs also produce results for missing/foreign records without distinguishing them.
    const candidates = target.ids
        ? [...new Set(target.ids)]
              .toSorted()
              .filter((id) => !target.cursor || id > target.cursor)
              .slice(0, target.limit + 1)
        : (
              await ctx.adapter.findMany<{ id: string }>({
                  model: 'notification',
                  select: ['id'],
                  where: [
                      ...where,
                      ...(target.cursor ? [{ field: 'id', operator: 'gt' as const, value: target.cursor }] : []),
                  ],
                  sortBy: { field: 'id', direction: 'asc' },
                  limit: target.limit + 1,
              })
          ).map((row) => row.id)
    const results: NotificationMutation<F, K>[] = []
    for (const id of candidates.slice(0, target.limit)) {
        try {
            const ownedWhere: Where[] = [...where, { field: 'id', value: id }]
            if (operation.field === 'delete') {
                const deleted = await ctx.adapter.deleteMany({ model: 'notification', where: ownedWhere })
                results.push({ id, status: deleted ? 'deleted' : 'not_found' })
                continue
            }
            const row = await ctx.adapter.findOne<StoredNotification>({ model: 'notification', where: ownedWhere })
            if (!row) {
                results.push({ id, status: 'not_found' })
                continue
            }
            const result = await setState(ctx, options, model, row.userId, id, operation.field, operation.value, where)
            results.push({
                id,
                status: result.changed ? 'updated' : 'unchanged',
                notification: result.notification,
                hook: result.hook,
            })
        } catch {
            ctx.logger.error('Notification batch item failed', { id })
            results.push({
                id,
                status: 'failed',
                error: {
                    code: 'NOTIFICATION_MUTATION_FAILED',
                    message: 'Notification operation failed; retry this ID',
                },
            })
        }
    }
    const hasMore = candidates.length > target.limit
    return { results, hasMore, nextCursor: hasMore ? candidates[target.limit - 1]! : null }
}
