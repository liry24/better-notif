import { afterEach, expect, it, vi } from 'vite-plus/test'

import { content, setup } from '../utils'

const cleanups: (() => void)[] = []
afterEach(() => {
    for (const close of cleanups.splice(0)) close()
})

it('scopes every client operation to its session and permits explicit trusted server targets', async () => {
    const readHook = vi.fn<() => void>()
    const app = await setup({ hooks: { setRead: { after: readHook } } })
    cleanups.push(app.close)
    const a = await app.user()
    const b = await app.user()
    const sent = await app.auth.api.sendNotification({
        body: { recipients: [a.id, b.id], idempotencyKey: 'owned', notification: content },
    })
    const aRow = sent.results.find((r) => r.userId === a.id)!
    const bRow = sent.results.find((r) => r.userId === b.id)!
    if (aRow.status !== 'created' || bRow.status !== 'created') throw new Error('Expected created notifications')
    const ids = [aRow.notification.id, bRow.notification.id, 'missing']
    for (const [path, field] of [
        ['set-read-many', 'read'],
        ['set-archived-many', 'archived'],
    ] as const) {
        expect((await app.request(`/notification/${path}`, new Headers(), { ids, [field]: true })).status).toBe(401)
        const response = await app.request(`/notification/${path}`, a.headers, { ids, [field]: true })
        expect(response.status).toBe(200)
        const result = (await response.json()) as { results: { id: string; status: string }[] }
        expect(result.results.find((r) => r.id === bRow.notification.id)?.status).toBe('not_found')
        expect(result.results.find((r) => r.id === 'missing')?.status).toBe('not_found')
        expect(
            (await app.request(`/notification/${path}`, a.headers, { ids, userIds: 'all', [field]: true })).status,
        ).toBe(400)
    }
    expect(
        (await app.auth.api.listNotifications({ headers: a.headers, query: { archived: 'all' } })).notifications.map(
            (n) => n.userId,
        ),
    ).toEqual([a.id])
    let bList = await app.auth.api.listUserNotifications({ query: { userIds: [b.id] } })
    expect(bList.notifications[0]).toMatchObject({ readAt: null, archivedAt: null })
    const changed = await app.auth.api.setUserNotificationsRead({ body: { userIds: [b.id], read: true } })
    expect(changed.results[0]?.status).toBe('updated')
    expect(
        (await app.auth.api.setUserNotificationsRead({ body: { userIds: [b.id], read: true } })).results[0]?.status,
    ).toBe('unchanged')
    expect(readHook).toHaveBeenCalledTimes(2)
    await app.auth.api.setUserNotificationsRead({ body: { userIds: [b.id], read: false } })
    expect(await app.auth.api.getUserUnreadNotificationCount({ query: { userIds: [b.id] } })).toEqual({ count: 1 })
    expect((await app.request('/notification/delete', a.headers, { id: bRow.notification.id })).status).toBe(200)
    bList = await app.auth.api.listUserNotifications({ query: { userIds: [b.id] } })
    expect(bList.notifications).toHaveLength(1)
    const removed = await app.auth.api.deleteNotifications({ headers: a.headers, body: { ids } })
    expect(removed.results.find((r) => r.id === aRow.notification.id)?.status).toBe('deleted')
    expect(removed.results.find((r) => r.id === bRow.notification.id)?.status).toBe('not_found')
    expect((await app.auth.api.listUserNotifications({ query: { userIds: 'all' } })).notifications).toHaveLength(1)
    expect((await app.auth.api.deleteUserNotifications({ body: { userIds: [b.id] } })).results[0]?.status).toBe(
        'deleted',
    )
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(0)
})

it('keeps server maintenance off HTTP and requires explicit bounded targets', async () => {
    const app = await setup()
    cleanups.push(app.close)
    const user = await app.user()
    for (const name of [
        'listUserNotifications',
        'getUserUnreadNotificationCount',
        'setUserNotificationsRead',
        'setUserNotificationsArchived',
        'deleteUserNotifications',
    ] as const) {
        expect(app.auth.api[name].path).toBeFalsy()
        const path = name.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)
        for (const prefix of ['/', '/notification/']) {
            expect(
                (await app.request(prefix + path, user.headers, { userIds: 'all', read: true, archived: true })).status,
            ).toBe(404)
            expect((await app.request(prefix + path, user.headers)).status).toBe(404)
        }
    }
    for (const body of [
        {},
        { userIds: [] },
        { userIds: 'all', limit: 101 },
        { userIds: 'all', ids: [] },
        { userIds: 'all', filter: { arbitrary: true } },
    ]) {
        await expect(app.auth.api.deleteUserNotifications({ body: body as any })).rejects.toBeDefined()
    }
})

it('bounds bulk processing, preserves cursor progress through deletions, and retries partial failures', async () => {
    const app = await setup()
    cleanups.push(app.close)
    const user = await app.user()
    for (let n = 0; n < 105; n++) {
        await app.ctx.adapter.create({
            model: 'notification',
            data: {
                ...content,
                body: null,
                userId: user.id,
                idempotencyKey: `seed-${n}`,
                createdAt: new Date('2026-01-01'),
                readAt: null,
                archivedAt: new Date(),
            },
        })
    }
    const target = {
        userIds: [user.id],
        filter: { archived: 'archived' as const, createdBefore: new Date('2026-02-01') },
    }
    const spy = vi.spyOn(app.ctx.adapter, 'deleteMany').mockRejectedValueOnce(new Error('private database detail'))
    const first = await app.auth.api.deleteUserNotifications({ body: target })
    expect(first.results).toHaveLength(100)
    expect(first.hasMore).toBe(true)
    const failed = first.results.find((r) => r.status === 'failed')!
    expect(failed).toMatchObject({
        error: { code: 'NOTIFICATION_MUTATION_FAILED', message: 'Notification operation failed; retry this ID' },
    })
    spy.mockRestore()
    const second = await app.auth.api.deleteUserNotifications({ body: { ...target, cursor: first.nextCursor! } })
    expect(second.results).toHaveLength(5)
    expect(second.nextCursor).toBeNull()
    expect(
        (await app.auth.api.deleteUserNotifications({ body: { ...target, ids: [failed.id, failed.id] } })).results,
    ).toHaveLength(1)
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(0)
})

it('physically deletes records and allows the same idempotency key to create again', async () => {
    const hook = vi.fn<() => void>()
    const app = await setup({ hooks: { create: { after: hook } } })
    cleanups.push(app.close)
    const user = await app.user()
    const body = { recipients: [user.id], idempotencyKey: 'reuse', notification: content }
    const result = (await app.auth.api.sendNotification({ body })).results[0]!
    if (result.status !== 'created') throw new Error('Expected created notification')
    await app.auth.api.deleteNotification({ headers: user.headers, body: { id: result.notification.id } })
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(0)
    expect((await app.auth.api.sendNotification({ body })).results[0]?.status).toBe('created')
    expect(hook).toHaveBeenCalledTimes(2)
})
