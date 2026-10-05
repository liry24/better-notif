import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { afterEach, expect, it, vi } from 'vite-plus/test'

import { notification } from '../../packages/better-notif/src/index'
import type { NotificationOptions } from '../../packages/better-notif/src/index'
import { content, setup } from '../utils'

const cleanups: (() => void)[] = []
afterEach(() => {
    for (const close of cleanups.splice(0).toReversed()) close()
})

it('filters before paging, counts the complete result, and traverses timestamp ties without duplicates', async () => {
    const app = await setup({
        schema: {
            notification: {
                modelName: 'message',
                additionalFields: {
                    topic: { type: 'string', required: false, fieldName: 'topic_code' },
                    privateNote: { type: 'string', returned: false, input: false, defaultValue: 'internal' },
                },
            },
        },
        filterableFields: ['topic'],
    })
    cleanups.push(app.close)
    const owner = await app.user()
    const foreign = await app.user()
    const matching: string[] = []
    for (let index = 0; index < 38; index++) {
        const sent = await app.auth.api.sendNotification({
            body: {
                recipients: [index === 37 ? foreign.id : owner.id],
                idempotencyKey: `entry-${index}`,
                notification: { ...content, topic: index < 30 ? 'beta' : 'alpha' },
            },
        })
        const row = sent.results[0]!
        if (row.status !== 'created') throw new Error('Expected created')
        await app.ctx.adapter.update({
            model: 'notification',
            where: [{ field: 'id', value: row.notification.id }],
            update: { createdAt: new Date(index < 30 ? '2026-02-01' : '2026-01-01') },
        })
        if (index >= 30 && index < 37) matching.push(row.notification.id)
    }
    expect(
        (await app.auth.api.listNotifications({ headers: owner.headers, query: {} })).notifications.every(
            (row) => row.topic === 'beta',
        ),
    ).toBe(true)
    const fields = { topic: 'alpha' }
    expect(await app.auth.api.getUnreadNotificationCount({ headers: owner.headers, query: { fields } })).toEqual({
        count: 7,
    })
    const url = '/notification/list?read=unread&limit=2&fields=' + encodeURIComponent(JSON.stringify(fields))
    const first = await (await app.request(url, owner.headers)).json()
    expect(first).toMatchObject({ total: 7, hasMore: true })
    expect(first.notifications[0]).not.toHaveProperty('privateNote')
    const seen: string[] = first.notifications.map((row: { id: string }) => row.id)
    // A cursor remains usable after its anchor record is deleted.
    await app.auth.api.deleteNotification({ headers: owner.headers, body: { id: seen.at(-1)! } })
    let cursor: string | null = first.nextCursor
    for (let page = 0; cursor && page < 4; page++) {
        const next = await app.auth.api.listNotifications({
            headers: owner.headers,
            query: { fields, read: 'unread', limit: 2, cursor },
        })
        expect(next.total).toBe(6)
        seen.push(...next.notifications.map((row) => row.id))
        cursor = next.nextCursor
    }
    expect(cursor).toBeNull()
    expect(seen).toEqual(matching.toSorted().toReversed())
    const changed = await app.auth.api.setUserNotificationsRead({
        body: { userIds: [owner.id], filter: { fields }, read: true },
    })
    expect(changed.results).toHaveLength(6)
    expect(await app.auth.api.getUnreadNotificationCount({ headers: owner.headers, query: { fields } })).toEqual({
        count: 0,
    })
    expect(
        await app.auth.api.getUserUnreadNotificationCount({
            query: { userIds: [owner.id], filter: { fields: { topic: 'beta' } } },
        }),
    ).toEqual({ count: 30 })
    expect(await app.auth.api.getUnreadNotificationCount({ headers: foreign.headers, query: { fields } })).toEqual({
        count: 1,
    })
})

it('rejects unknown, private, complex and transformed filter fields and malformed cursors', async () => {
    const app = await setup({
        schema: {
            notification: {
                additionalFields: {
                    topic: { type: 'string', required: false },
                    hidden: { type: 'string', returned: false, required: false },
                },
            },
        },
        filterableFields: ['topic'],
    })
    cleanups.push(app.close)
    const owner = await app.user()
    for (const fields of [{ hidden: 'value' }, { userId: owner.id }, { missing: 'value' }, { topic: 5 }, []]) {
        const encoded = encodeURIComponent(JSON.stringify(fields))
        expect((await app.request('/notification/list?fields=' + encoded, owner.headers)).status).toBe(400)
        expect((await app.request('/notification/unread-count?fields=' + encoded, owner.headers)).status).toBe(400)
    }
    expect((await app.request('/notification/list?cursor=invalid', owner.headers)).status).toBe(400)
    for (const field of [
        { type: 'string', returned: false },
        { type: 'json' },
        { type: 'string', transform: { input: (value: unknown) => value } },
    ]) {
        expect(() =>
            notification({
                schema: { notification: { additionalFields: { field } } },
                filterableFields: ['field'],
            } as any),
        ).toThrow('cannot be filtered')
    }
})

it('loads related recipient data only for callbacks, after a successful write for creation-only hooks', async () => {
    const plain = await setup()
    cleanups.push(plain.close)
    const owner = await plain.user()
    const related = vi.spyOn(plain.ctx.adapter, 'findMany')
    await plain.auth.api.sendNotification({
        body: { recipients: [owner.id], idempotencyKey: 'plain', notification: content },
    })
    expect(related.mock.calls.some(([query]) => query.model === 'account' || query.model === 'session')).toBe(false)
    const hook = vi.fn<NonNullable<NotificationOptions['onNotificationCreated']>>()
    const app = await setup({ onNotificationCreated: hook })
    cleanups.push(app.close)
    const user = await app.signUp()
    const findMany = app.ctx.adapter.findMany.bind(app.ctx.adapter)
    const countsAtLookup: number[] = []
    const relatedHook = vi.spyOn(app.ctx.adapter, 'findMany').mockImplementation(async (query) => {
        if (query.model === 'account' || query.model === 'session')
            countsAtLookup.push(await app.ctx.adapter.count({ model: 'notification' }))
        return findMany(query)
    })
    const body = { recipients: [user.id], idempotencyKey: 'hook', notification: content }
    expect((await app.auth.api.sendNotification({ body })).results[0]).toMatchObject({
        status: 'created',
        hook: 'completed',
    })
    expect(hook.mock.calls[0]![0].recipient.accounts).toHaveLength(1)
    expect(countsAtLookup).toEqual([1, 1])
    expect(hook.mock.calls[0]![0].recipient.accounts[0]).not.toHaveProperty('password')
    const calls = relatedHook.mock.calls.length
    expect((await app.auth.api.sendNotification({ body })).results[0]?.status).toBe('duplicate')
    expect(relatedHook).toHaveBeenCalledTimes(calls)
    relatedHook.mockImplementation(async () => {
        throw new Error('private lookup failure')
    })
    const failedHook = await app.auth.api.sendNotification({ body: { ...body, idempotencyKey: 'lookup-failure' } })
    expect(failedHook.results[0]).toMatchObject({ status: 'created', hook: 'failed' })
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(2)
    expect(JSON.stringify(failedHook)).not.toContain('private lookup failure')
})

it('honors native Better Auth authorization hooks for every recipient mutation without weakening Origin checks', async () => {
    const denied = new Set<string>()
    const mutations = ['set-read', 'set-archived', 'delete', 'set-read-many', 'set-archived-many', 'delete-many']
    const app = await setup({}, ':memory:', {
        before: createAuthMiddleware(async (ctx) => {
            if (!mutations.some((operation) => ctx.path === '/notification/' + operation)) return
            const session = await getSessionFromCtx(ctx)
            if (session && denied.has(session.user.id))
                throw new APIError('FORBIDDEN', { message: 'Operation is not allowed' })
        }),
    })
    cleanups.push(app.close)
    const user = await app.user()
    const sent = (
        await app.auth.api.sendNotification({
            body: { recipients: [user.id], idempotencyKey: 'authorization', notification: content },
        })
    ).results[0]!
    if (sent.status !== 'created') throw new Error('Expected created')
    const id = sent.notification.id
    denied.add(user.id)
    for (const operation of mutations) {
        const body = operation.endsWith('-many') ? { ids: [id] } : { id }
        expect(
            (
                await app.request('/notification/' + operation, user.headers, {
                    ...body,
                    ...(operation.startsWith('set-read') ? { read: true } : {}),
                    ...(operation.startsWith('set-archived') ? { archived: true } : {}),
                })
            ).status,
        ).toBe(403)
    }
    expect((await app.auth.api.listNotifications({ headers: user.headers, query: {} })).notifications[0]).toMatchObject(
        { readAt: null, archivedAt: null },
    )
    denied.clear()
    const foreignOrigin = new Headers(user.headers)
    foreignOrigin.set('origin', 'https://untrusted.example.com')
    expect((await app.request('/notification/set-read', foreignOrigin, { id, read: true })).status).toBe(403)
    expect((await app.request('/notification/set-read', user.headers, { id, read: true })).status).toBe(200)
})
