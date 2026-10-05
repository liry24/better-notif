import { afterEach, expect, it, vi } from 'vite-plus/test'

import { setup } from '../utils'
const cleanups: (() => void)[] = []
afterEach(() => {
    for (const close of cleanups.splice(0)) close()
})

it('separates Boolean create access from lifecycle hooks and rechecks duplicates', async () => {
    let allowed = true
    const access = vi.fn<() => boolean>(() => allowed)
    const before = vi.fn<(event: { changes: { title: string } }) => void>(
        ({ changes }: { changes: { title: string } }) => {
            changes.title = 'callback mutation'
        },
    )
    const after = vi.fn<(event: unknown) => void>()
    const app = await setup({ access: { create: access }, hooks: { create: { before, after } } })
    cleanups.push(app.close)
    const user = await app.user()
    const body = {
        recipients: [user.id],
        idempotencyKey: 'creation',
        notification: { type: 'event', title: 'Original' },
    }
    expect((await app.auth.api.sendNotification({ body })).results[0]).toMatchObject({
        status: 'created',
        notification: { title: 'Original' },
        hook: 'completed',
    })
    expect((await app.auth.api.sendNotification({ body })).results[0]?.status).toBe('duplicate')
    allowed = false
    expect((await app.auth.api.sendNotification({ body })).results[0]).toMatchObject({
        status: 'failed',
        error: { code: 'NOTIFICATION_ACCESS_DENIED' },
    })
    expect(access).toHaveBeenCalledTimes(3)
    expect(before).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(1)
})

it('fails closed for missing/invalid policy results and does not interpret lifecycle false as access', async () => {
    const app = await setup({ access: { create: (() => undefined) as any } })
    cleanups.push(app.close)
    const user = await app.user()
    const body = {
        recipients: [user.id],
        idempotencyKey: 'invalid-policy',
        notification: { type: 'event', title: 'Event' },
    }
    expect((await app.auth.api.sendNotification({ body })).results[0]).toMatchObject({
        status: 'failed',
        error: { code: 'NOTIFICATION_ACCESS_DENIED' },
    })
    const invalid = await setup({ hooks: { create: { before: (() => false) as any } } })
    cleanups.push(invalid.close)
    const other = await invalid.user()
    expect(
        (await invalid.auth.api.sendNotification({ body: { ...body, recipients: [other.id] } })).results[0],
    ).toMatchObject({ status: 'failed', error: { code: 'NOTIFICATION_HOOK_FAILED' } })
    expect(await invalid.ctx.adapter.count({ model: 'notification' })).toBe(0)
})

it('uses owner-scoped Boolean access for direct/bulk writes, no-ops, and trusted maintenance', async () => {
    let allowed = true
    const access = vi.fn<(event: { record: { userId: string }; session: { user: { id: string } } | null }) => boolean>(
        ({ record, session }: { record: { userId: string }; session: { user: { id: string } } | null }) =>
            allowed && record.userId === session?.user.id,
    )
    const before = vi.fn<(event: unknown) => void>(),
        after = vi.fn<(event: unknown) => void>()
    const app = await setup({
        access: { setRead: access, setArchived: access, delete: access },
        hooks: { setRead: { before, after }, setArchived: { before, after }, delete: { before, after } },
    })
    cleanups.push(app.close)
    const owner = await app.user(),
        foreign = await app.user()
    const sent = await app.auth.api.sendNotification({
        body: {
            recipients: [owner.id, foreign.id],
            idempotencyKey: 'state',
            notification: { type: 'event', title: 'Event' },
        },
    })
    const own = sent.results.find((row) => row.userId === owner.id)!,
        other = sent.results.find((row) => row.userId === foreign.id)!
    if (own.status !== 'created' || other.status !== 'created') throw new Error('Fixture send failed')
    const id = own.notification.id
    await app.auth.api.setNotificationRead({ headers: owner.headers, body: { id, read: true } })
    await app.auth.api.setNotificationRead({ headers: owner.headers, body: { id, read: true } })
    expect(before).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    expect(access).toHaveBeenCalledTimes(2)
    allowed = false
    await expect(
        app.auth.api.setNotificationRead({ headers: owner.headers, body: { id, read: true } }),
    ).rejects.toMatchObject({ body: { code: 'NOTIFICATION_ACCESS_DENIED' } })
    await expect(
        app.auth.api.setNotificationArchived({ headers: owner.headers, body: { id, archived: true } }),
    ).rejects.toMatchObject({ body: { code: 'NOTIFICATION_ACCESS_DENIED' } })
    await expect(app.auth.api.deleteNotification({ headers: owner.headers, body: { id } })).rejects.toMatchObject({
        body: { code: 'NOTIFICATION_ACCESS_DENIED' },
    })
    const calls = access.mock.calls.length
    const batch = await app.auth.api.setNotificationsArchived({
        headers: owner.headers,
        body: { ids: [id, other.notification.id], archived: true },
    })
    expect(batch.results.find((row) => row.id === id)).toMatchObject({
        status: 'failed',
        error: { code: 'NOTIFICATION_ACCESS_DENIED' },
    })
    expect(batch.results.find((row) => row.id === other.notification.id)).toMatchObject({ status: 'not_found' })
    expect(access).toHaveBeenCalledTimes(calls + 1)
    const response = await app.request('/notification/set-read-many', owner.headers, { ids: [id], read: false })
    expect(response.status).toBe(200)
    expect((await response.json()).results[0]).toMatchObject({
        status: 'failed',
        error: { code: 'NOTIFICATION_ACCESS_DENIED' },
    })
    const maintained = await app.auth.api.setUserNotificationsArchived({
        body: { userIds: [owner.id], ids: [id], archived: true },
    })
    expect(maintained.results[0]).toMatchObject({ status: 'updated', hook: 'completed' })
    expect(before).toHaveBeenCalledTimes(2)
    expect(after.mock.calls.at(-1)?.[0]).toMatchObject({
        session: null,
        operation: 'setArchived',
        record: { archivedAt: expect.any(Date) },
        previous: { archivedAt: null },
    })
    expect(
        (await app.auth.api.deleteUserNotifications({ body: { userIds: [owner.id], ids: [id] } })).results[0],
    ).toMatchObject({ status: 'deleted', hook: 'completed' })
})

it('applies declarative list access before pagination and counting without escaping ownership', async () => {
    const app = await setup({
        fields: { category: { type: 'string' } },
        list: { filters: ['category'] },
        access: {
            list: ({ session }) => ({
                where: [
                    { field: 'category', value: 'visible' },
                    { field: 'userId', value: session!.user.id },
                ],
            }),
        },
    })
    cleanups.push(app.close)
    const owner = await app.user(),
        foreign = await app.user()
    for (let index = 0; index < 105; index++)
        await app.auth.api.sendNotification({
            body: {
                recipients: [owner.id, foreign.id],
                idempotencyKey: `list-${index}`,
                notification: { type: 'event', title: 'Event', category: index < 3 ? 'visible' : 'hidden' },
            },
        })
    const first = await app.auth.api.listNotifications({ headers: owner.headers, query: { limit: 2 } })
    expect(first.total).toBe(3)
    expect(first.notifications).toHaveLength(2)
    expect(first.notifications.every((row) => row.userId === owner.id && row.category === 'visible')).toBe(true)
    const next = await app.auth.api.listNotifications({
        headers: owner.headers,
        query: { limit: 2, cursor: first.nextCursor! },
    })
    expect(next.notifications).toHaveLength(1)
    expect(next.total).toBe(3)
    expect((await app.auth.api.getUnreadNotificationCount({ headers: owner.headers, query: {} })).count).toBe(3)
    expect(
        (await app.auth.api.listNotifications({ headers: owner.headers, query: { fields: { category: 'hidden' } } }))
            .total,
    ).toBe(0)
})

it('rejects false, undefined, invalid, and OR list scopes for both HTTP list and count', async () => {
    let scope: unknown = false
    const app = await setup({ access: { list: (() => scope) as any } })
    cleanups.push(app.close)
    const user = await app.user()
    for (scope of [
        false,
        undefined,
        true,
        { where: [{ field: 'userId', value: user.id, connector: 'OR' }] },
        { where: [{ field: 'unknown', value: 'x' }] },
        { where: [{ field: 'createdAt', operator: 'in', value: [new Date()] }] },
    ]) {
        expect((await app.request('/notification/list', user.headers)).status).toBe(403)
        expect((await app.request('/notification/unread-count', user.headers)).status).toBe(403)
    }
})

it('blocks failed before hooks and keeps successful writes when after hooks fail', async () => {
    let failBefore = false
    const before = vi.fn<() => void>(() => {
        if (failBefore) throw new Error('private before error')
    })
    const after = vi.fn<() => void>(() => {
        throw new Error('private after error')
    })
    const app = await setup({
        hooks: { create: { before, after }, setRead: { before, after }, delete: { before, after } },
    })
    cleanups.push(app.close)
    const user = await app.user()
    const body = { recipients: [user.id], idempotencyKey: 'hooks', notification: { type: 'event', title: 'Event' } }
    const sent = (await app.auth.api.sendNotification({ body })).results[0]!
    expect(sent).toMatchObject({ status: 'created', hook: 'failed' })
    if (sent.status !== 'created') throw new Error('Fixture send failed')
    const id = sent.notification.id
    failBefore = true
    await expect(
        app.auth.api.setNotificationRead({ headers: user.headers, body: { id, read: true } }),
    ).rejects.toMatchObject({ body: { code: 'NOTIFICATION_HOOK_FAILED' } })
    await expect(app.auth.api.deleteNotification({ headers: user.headers, body: { id } })).rejects.toMatchObject({
        body: { code: 'NOTIFICATION_HOOK_FAILED' },
    })
    expect(
        (await app.auth.api.listNotifications({ headers: user.headers, query: {} })).notifications[0]?.readAt,
    ).toBeNull()
    expect((await app.auth.api.sendNotification({ body })).results[0]?.status).toBe('duplicate')
    failBefore = false
    expect(await app.auth.api.setNotificationRead({ headers: user.headers, body: { id, read: true } })).toMatchObject({
        changed: true,
        hook: 'failed',
    })
    expect(await app.auth.api.setNotificationRead({ headers: user.headers, body: { id, read: true } })).toMatchObject({
        changed: false,
        hook: 'skipped',
    })
    expect(await app.auth.api.deleteNotification({ headers: user.headers, body: { id } })).toMatchObject({
        deleted: true,
        hook: 'failed',
    })
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(0)
    expect(after).toHaveBeenCalledTimes(3)
})

it('rechecks create access when a concurrent insert wins the idempotency constraint', async () => {
    let allowed = true
    const access = vi.fn<() => boolean>(() => allowed),
        after = vi.fn<(event: unknown) => void>()
    const app = await setup({ access: { create: access }, hooks: { create: { after } } })
    cleanups.push(app.close)
    const user = await app.user()
    const create = app.ctx.adapter.create.bind(app.ctx.adapter)
    vi.spyOn(app.ctx.adapter, 'create').mockImplementationOnce(async (input) => {
        await create(input)
        allowed = false
        throw new Error('Simulated unique winner')
    })
    const sent = await app.auth.api.sendNotification({
        body: { recipients: [user.id], idempotencyKey: 'race', notification: { type: 'event', title: 'Event' } },
    })
    expect(sent.results[0]).toMatchObject({ status: 'failed', error: { code: 'NOTIFICATION_ACCESS_DENIED' } })
    expect(access).toHaveBeenCalledTimes(2)
    expect(after).not.toHaveBeenCalled()
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(1)
})

it('reports list/count after failures separately from successful reads and blocks before failures', async () => {
    let block = false
    const before = vi.fn<() => void>(() => {
        if (block) throw new Error('private before detail')
    })
    const after = vi.fn<() => void>(() => {
        throw new Error('private after detail')
    })
    const app = await setup({ hooks: { list: { before, after } } })
    cleanups.push(app.close)
    const user = await app.user()
    await app.auth.api.sendNotification({
        body: { recipients: [user.id], idempotencyKey: 'read-hooks', notification: { type: 'event', title: 'Saved' } },
    })
    const list = await app.request('/notification/list', user.headers)
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({ total: 1, hook: 'failed', notifications: [{ title: 'Saved' }] })
    const count = await app.request('/notification/unread-count', user.headers)
    expect(count.status).toBe(200)
    expect(await count.json()).toEqual({ count: 1, hook: 'failed' })
    block = true
    expect((await app.request('/notification/list', user.headers)).status).toBe(500)
    expect((await app.request('/notification/unread-count', user.headers)).status).toBe(500)
    expect(after).toHaveBeenCalledTimes(2)
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(1)
})
