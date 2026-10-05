import { Buffer } from 'node:buffer'

import type { Where } from '@better-auth/core/db/adapter'
import { APIError } from 'better-auth/api'
import * as z from 'zod'

import type { NotificationFields, NotificationFieldsOf, NotificationTypes, NotificationModel } from './fields'
import { identifier } from './schema'
import type { NotificationListQuery } from './schema'
import type { NotificationContext, NotificationList, StoredNotification } from './types'

const cursorSchema = z.tuple([z.iso.datetime(), identifier])

function decodeCursor(cursor?: string) {
    if (!cursor) return undefined
    try {
        const [date, id] = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
        return { createdAt: new Date(date), id }
    } catch {
        throw new APIError('BAD_REQUEST', {
            code: 'NOTIFICATION_INVALID_CURSOR',
            message: 'Invalid notification cursor',
        })
    }
}

export function notificationWhere(
    userId: string,
    query: { type?: string | undefined; read?: string | undefined; archived?: string | undefined; fields?: unknown },
    model: { filterWhere: (input: unknown) => Where[] },
): Where[] {
    const where: Where[] = [{ field: 'userId', value: userId }, ...model.filterWhere(query.fields)]
    if (query.type !== undefined) where.push({ field: 'type', value: query.type })
    if (query.read && query.read !== 'all')
        where.push({ field: 'readAt', operator: query.read === 'unread' ? 'eq' : 'ne', value: null })
    if (query.archived && query.archived !== 'all')
        where.push({ field: 'archivedAt', operator: query.archived === 'unarchived' ? 'eq' : 'ne', value: null })
    return where
}

async function pageRows(ctx: NotificationContext, where: Where[], limit: number, cursor?: string) {
    const anchor = decodeCursor(cursor)
    const fetch = (conditions: Where[], field: 'createdAt' | 'id', size: number) =>
        ctx.adapter.findMany<StoredNotification>({
            model: 'notification',
            where: [...where, ...conditions],
            limit: size,
            sortBy: { field, direction: 'desc' },
        })
    const tied = anchor
        ? await fetch(
              [
                  { field: 'createdAt', value: anchor.createdAt },
                  { field: 'id', operator: 'lt', value: anchor.id },
              ],
              'id',
              limit + 1,
          )
        : []
    if (tied.length === limit + 1) return tied
    const older = await fetch(
        anchor ? [{ field: 'createdAt', operator: 'lt', value: anchor.createdAt }] : [],
        'createdAt',
        limit + 1 - tied.length,
    )
    if (!older.length) return tied
    // The adapter supports one sort field. Complete only the boundary timestamp's tie group,
    // then sort the already complete groups locally; each native query remains bounded.
    const boundary = older.at(-1)!.createdAt
    const complete = older
        .filter((row) => row.createdAt.getTime() > boundary.getTime())
        .toSorted(
            (a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
        )
    const boundaryRows = await fetch(
        [{ field: 'createdAt', value: boundary }],
        'id',
        limit + 1 - tied.length - complete.length,
    )
    return [...tied, ...complete, ...boundaryRows]
}

export async function listNotifications<F extends NotificationFields, K extends NotificationTypes>(
    ctx: NotificationContext,
    model: NotificationModel<F, K>,
    userId: string,
    query: NotificationListQuery<NotificationFieldsOf<F, K>>,
    accessWhere: Where[] = [],
): Promise<Omit<NotificationList<F, K>, 'hook'>> {
    const limit = query.limit ?? 20
    const where = [...notificationWhere(userId, query, model), ...accessWhere]
    const [rows, total] = await Promise.all([
        pageRows(ctx, where, limit, query.cursor),
        ctx.adapter.count({ model: 'notification', where }),
    ])
    const hasMore = rows.length > limit
    const last = rows[limit - 1]
    return {
        notifications: await Promise.all(rows.slice(0, limit).map((row) => model.present(row))),
        total,
        hasMore,
        nextCursor:
            hasMore && last
                ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id])).toString('base64url')
                : null,
    }
}
