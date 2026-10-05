/* oxlint-disable no-await-in-loop -- Pagination depends on the previous cursor; sequential recipient writes bound database and hook load. */
import type { Where } from '@better-auth/core/db/adapter'
import { APIError } from 'better-auth/api'

import type { NotificationFields, NotificationKinds, NotificationModel } from './fields'
import type {
    HookStatus,
    NotificationContext,
    NotificationOptions,
    RecipientAccount,
    RecipientContext,
    RecipientData,
    RecipientFilter,
    RecipientResult,
    RecipientSession,
    SendNotificationResult,
    StoredNotification,
} from './types'

export async function runHook<T>(
    ctx: NotificationContext,
    hook: ((event: T) => void | Promise<void>) | undefined,
    event: T,
): Promise<HookStatus> {
    if (!hook) return 'skipped'
    try {
        await hook(event)
        return 'completed'
    } catch {
        // App hook errors may contain provider credentials. Keep logs metadata-only.
        ctx.logger.error('Notification hook failed after the database write; no automatic retry is performed')
        return 'failed'
    }
}

async function related<T extends { id: string }>(
    adapter: NotificationContext['adapter'],
    model: string,
    where: Where[],
    select: string[],
): Promise<T[]> {
    const rows: T[] = []
    let cursor: string | undefined
    for (;;) {
        const page = await adapter.findMany<T>({
            model,
            select,
            limit: 100,
            sortBy: { field: 'id', direction: 'asc' },
            where: [
                ...where,
                ...(cursor === undefined ? [] : [{ field: 'id', operator: 'gt' as const, value: cursor }]),
            ],
        })
        rows.push(...page)
        if (page.length < 100) return rows
        cursor = page.at(-1)?.id
    }
}

async function recipientData(
    ctx: NotificationContext,
    recipientId: string,
    includeRelated: boolean,
    knownUser?: RecipientData['user'],
): Promise<RecipientData> {
    const user =
        knownUser ??
        (await ctx.adapter.findOne<RecipientData['user']>({
            model: 'user',
            where: [{ field: 'id', value: recipientId }],
        }))
    if (!user)
        throw new APIError('NOT_FOUND', { code: 'NOTIFICATION_USER_NOT_FOUND', message: 'Recipient does not exist' })
    if (!includeRelated) return { user, accounts: [], sessions: [] }
    const where: Where[] = [{ field: 'userId', value: recipientId }]
    const [accounts, sessions] = await Promise.all([
        related<RecipientAccount>(ctx.adapter, 'account', where, [
            'id',
            'userId',
            'accountId',
            'providerId',
            'scope',
            'createdAt',
            'updatedAt',
            'accessTokenExpiresAt',
            'refreshTokenExpiresAt',
        ]),
        ctx.options.secondaryStorage
            ? ctx.internalAdapter.listSessions(recipientId, { onlyActiveSessions: true })
            : related<RecipientSession>(
                  ctx.adapter,
                  'session',
                  [...where, { field: 'expiresAt', operator: 'gt', value: new Date() }],
                  ['id', 'userId', 'createdAt', 'updatedAt', 'expiresAt', 'ipAddress', 'userAgent'],
              ),
    ])
    // Adapter output transforms can reintroduce unselected fields; project before calling app code.
    return {
        user,
        accounts: accounts.map(
            ({
                id,
                userId,
                accountId,
                providerId,
                scope,
                createdAt,
                updatedAt,
                accessTokenExpiresAt,
                refreshTokenExpiresAt,
            }) => ({
                id,
                userId,
                accountId,
                providerId,
                scope,
                createdAt,
                updatedAt,
                accessTokenExpiresAt,
                refreshTokenExpiresAt,
            }),
        ),
        sessions: sessions.map(({ id, userId, createdAt, updatedAt, expiresAt, ipAddress, userAgent }) => ({
            id,
            userId,
            createdAt,
            updatedAt,
            expiresAt,
            ipAddress,
            userAgent,
        })),
    }
}

export interface SendInput<TContext> {
    recipients: string[] | 'all'
    notification: Record<string, unknown>
    contentHash: string
    idempotencyKey: string
    limit: number
    cursor?: string | undefined
    filter?: RecipientFilter<TContext> | undefined
}

export async function send<TContext, F extends NotificationFields, K extends NotificationKinds<F>>(
    ctx: NotificationContext,
    options: NotificationOptions<TContext, F, K>,
    model: NotificationModel<F, K>,
    input: SendInput<TContext>,
): Promise<SendNotificationResult<F, K>> {
    const ids =
        input.recipients === 'all'
            ? (
                  await ctx.adapter.findMany<{ id: string }>({
                      model: 'user',
                      select: ['id'],
                      limit: input.limit + 1,
                      sortBy: { field: 'id', direction: 'asc' },
                      where: input.cursor === undefined ? [] : [{ field: 'id', operator: 'gt', value: input.cursor }],
                  })
              ).map((user) => user.id)
            : [...new Set(input.recipients)]
                  .toSorted()
                  .filter((id) => input.cursor === undefined || id > input.cursor)
                  .slice(0, input.limit + 1)
    const results: RecipientResult<F, K>[] = []
    // Scan at most 100 candidates per call; use application jobs and ID batches for large audiences.
    for (const userId of ids.slice(0, input.limit)) {
        try {
            results.push(await sendOne(ctx, options, model, input, userId))
        } catch (error) {
            const known = error instanceof APIError && error.body?.code?.startsWith('NOTIFICATION_')
            if (!known) ctx.logger.error('Notification recipient processing failed', { userId })
            results.push({
                userId,
                status: 'failed',
                error: {
                    code: known ? error.body!.code! : 'NOTIFICATION_SEND_FAILED',
                    message: known ? error.body!.message! : 'Recipient processing failed; retry this user ID',
                },
            })
        }
    }
    const hasMore = ids.length > input.limit
    return { results, hasMore, nextCursor: hasMore ? ids[input.limit - 1]! : null }
}

async function sendOne<TContext, F extends NotificationFields, K extends NotificationKinds<F>>(
    ctx: NotificationContext,
    options: NotificationOptions<TContext, F, K>,
    model: NotificationModel<F, K>,
    input: SendInput<TContext>,
    userId: string,
): Promise<RecipientResult<F, K>> {
    const where: Where[] = [
        { field: 'userId', value: userId },
        { field: 'idempotencyKey', value: input.idempotencyKey },
    ]
    const existing = await ctx.adapter.findOne<StoredNotification>({ model: 'notification', where })
    if (existing) return duplicate(existing, input.contentHash, model)

    const base = await recipientData(ctx, userId, false)
    let pendingRecipient: Promise<RecipientContext<TContext>> | undefined
    const getRecipient = () =>
        (pendingRecipient ??= (async () => {
            const data = await recipientData(ctx, userId, true, base.user)
            return { ...data, context: await options.loadContext?.(data) }
        })())
    if (options.loadContext) await getRecipient()
    if (input.filter) {
        const matches = await input.filter(await getRecipient())
        if (typeof matches !== 'boolean')
            throw new APIError('BAD_REQUEST', {
                code: 'NOTIFICATION_INVALID_FILTER_RESULT',
                message: 'The filter must return a boolean',
            })
        if (!matches) return { userId, status: 'skipped' }
    }

    let created: StoredNotification
    try {
        created = await ctx.adapter.create<StoredNotification>({
            model: 'notification',
            data: {
                ...structuredClone(input.notification),
                contentHash: input.contentHash,
                userId,
                idempotencyKey: input.idempotencyKey,
                createdAt: new Date(),
                readAt: null,
                archivedAt: null,
            },
        })
    } catch (error) {
        // A concurrent insert may have won the database UNIQUE constraint.
        const winner = await ctx.adapter.findOne<StoredNotification>({ model: 'notification', where })
        if (winner) return duplicate(winner, input.contentHash, model)
        throw error
    }
    const notification = await model.present(created)
    const onCreated = options.onNotificationCreated
    const hook = await runHook(
        ctx,
        onCreated
            ? async () => {
                  await onCreated({
                      notification,
                      recipient: await getRecipient(),
                      idempotencyKey: input.idempotencyKey,
                  })
              }
            : undefined,
        undefined,
    )
    return { userId, status: 'created', notification, hook }
}

async function duplicate<F extends NotificationFields, K extends NotificationKinds<F>>(
    existing: StoredNotification,
    contentHash: string,
    model: NotificationModel<F, K>,
): Promise<RecipientResult<F, K>> {
    if (existing.contentHash !== contentHash) {
        throw new APIError('CONFLICT', {
            code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT',
            message:
                'This recipient and key identify different content or a legacy record without a content fingerprint',
        })
    }
    return {
        userId: existing.userId,
        status: 'duplicate',
        notification: await model.present(existing),
        hook: 'skipped',
    }
}

export async function setState<TContext, F extends NotificationFields, K extends NotificationKinds<F>>(
    ctx: NotificationContext,
    options: NotificationOptions<TContext, F, K>,
    model: NotificationModel<F, K>,
    userId: string,
    id: string,
    field: 'readAt' | 'archivedAt',
    value: boolean,
    conditions: Where[] = [],
) {
    const where: Where[] = [
        { field: 'id', value: id },
        { field: 'userId', value: userId },
    ]
    const timestamp = value ? new Date() : null
    const changed = await ctx.adapter.updateMany({
        model: 'notification',
        where: [...where, ...conditions, { field, operator: value ? 'eq' : 'ne', value: null }],
        update: { [field]: timestamp },
    })
    const row = await ctx.adapter.findOne<StoredNotification>({ model: 'notification', where })
    if (!row) throw new APIError('NOT_FOUND', { code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found' })
    let hook: HookStatus = 'skipped'
    if (changed) {
        hook =
            field === 'readAt'
                ? await runHook(ctx, options.onReadStateChanged, { notificationId: id, userId, readAt: timestamp })
                : await runHook(ctx, options.onArchiveStateChanged, {
                      notificationId: id,
                      userId,
                      archivedAt: timestamp,
                  })
    }
    return { notification: await model.present(row), changed: changed > 0, hook }
}
