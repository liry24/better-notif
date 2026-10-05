import * as v from 'valibot'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import * as z from 'zod'

import { notification } from '../../packages/better-notif/src/index'
import type { NotificationOptions } from '../../packages/better-notif/src/index'
import { setup } from '../utils'

const cleanups: (() => void)[] = []
afterEach(() => {
    for (const close of cleanups.splice(0)) close()
})

it('creates native nullable columns and validates Zod/Valibot once per send with kind requirements', async () => {
    const amount = z.string().transform(async (value) => Number(value))
    const validateAmount = vi.spyOn(amount['~standard'], 'validate')
    const created = vi.fn<NonNullable<NotificationOptions['onNotificationCreated']>>()
    const app = await setup({
        schema: {
            notification: {
                additionalFields: {
                    amount: { type: 'number', required: false, validator: { input: amount } },
                    slug: {
                        type: 'string',
                        required: false,
                        validator: { input: v.pipe(v.string(), v.trim(), v.toLowerCase()) },
                    },
                },
            },
        },
        kinds: { invoice: { required: ['amount'] }, post: { required: ['slug'] } },
        onNotificationCreated: created,
    })
    cleanups.push(app.close)
    const columns = app.database.prepare('PRAGMA table_info(notification)').all()
    expect(columns.find((row) => row.name === 'amount')).toMatchObject({ notnull: 0 })
    expect(columns.find((row) => row.name === 'slug')).toMatchObject({ notnull: 0 })
    expect(columns.some((row) => row.name === 'data')).toBe(false)
    const first = await app.user()
    const second = await app.user()
    const body = {
        recipients: [first.id, second.id],
        idempotencyKey: 'invoice',
        notification: { type: 'invoice' as const, title: 'Invoice', amount: '42' },
    }
    const sent = await app.auth.api.sendNotification({ body })
    expect(sent.results.map((r) => r.status)).toEqual(['created', 'created'])
    expect(validateAmount).toHaveBeenCalledTimes(1)
    expect(created).toHaveBeenCalledTimes(2)
    expect(created.mock.calls[0]![0].notification).toMatchObject({ amount: 42, slug: null, schemaStatus: 'current' })
    expect((await app.auth.api.sendNotification({ body })).results.map((r) => r.status)).toEqual([
        'duplicate',
        'duplicate',
    ])
    expect(validateAmount).toHaveBeenCalledTimes(2)
    const list = await app.auth.api.listNotifications({ headers: first.headers, query: {} })
    expect(list.notifications[0]).toMatchObject({ amount: 42, schemaStatus: 'current' })
    expect(validateAmount).toHaveBeenCalledTimes(2)
    expect(list.notifications[0]).not.toHaveProperty('contentHash')
    const updated = await app.auth.api.setNotificationRead({
        headers: first.headers,
        body: { id: list.notifications[0]!.id, read: true },
    })
    expect(updated.notification).toMatchObject({ amount: 42 })
    const conflict = await app.auth.api.sendNotification({
        body: { ...body, notification: { ...body.notification, amount: '43' } },
    })
    expect(conflict.results[0]).toMatchObject({
        status: 'failed',
        error: { code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT' },
    })
    const post = await app.auth.api.sendNotification({
        body: {
            recipients: [first.id],
            idempotencyKey: 'post',
            notification: { type: 'post', title: 'Post', slug: ' HELLO ' },
        },
    })
    expect(post.results[0]).toMatchObject({ status: 'created', notification: { slug: 'hello', amount: null } })
})

it('rejects missing conditional/global fields, unknown fields/kinds and invalid or thrown validators before recipient work', async () => {
    const load = vi.fn<() => undefined>()
    const hook = vi.fn<NonNullable<NotificationOptions['onNotificationCreated']>>()
    const app = await setup({
        schema: {
            notification: {
                additionalFields: {
                    source: { type: 'string' },
                    amount: { type: 'number', required: false, validator: { input: v.number() } },
                    hidden: { type: 'boolean', input: false, defaultValue: false },
                    failing: {
                        type: 'string',
                        required: false,
                        validator: {
                            input: {
                                '~standard': {
                                    version: 1,
                                    vendor: 'test',
                                    validate: async () => {
                                        throw new Error('private validator detail')
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        kinds: { invoice: { required: ['amount'] } },
        loadContext: load,
        onNotificationCreated: hook,
    })
    cleanups.push(app.close)
    const user = await app.user()
    const valid = { type: 'invoice', title: 'Invoice', source: 'app', amount: 1 }
    const send = (value: unknown) =>
        app.auth.api.sendNotification({
            body: { recipients: [user.id], idempotencyKey: 'bad', notification: value as any },
        })
    for (const value of [
        { ...valid, amount: undefined },
        { ...valid, amount: null },
        { ...valid, amount: 'wrong' },
        { ...valid, source: undefined },
        { ...valid, unexpected: 1 },
        { ...valid, hidden: false },
        { ...valid, contentHash: 'injected' },
        { ...valid, schemaStatus: 'current' },
    ])
        await expect(send(value)).rejects.toMatchObject({ body: { code: 'NOTIFICATION_INVALID_FIELDS' } })
    await expect(send({ ...valid, type: 'missing' })).rejects.toMatchObject({
        body: { code: 'NOTIFICATION_UNKNOWN_TYPE' },
    })
    await expect(send({ ...valid, failing: 'x' })).rejects.toMatchObject({
        body: { code: 'NOTIFICATION_SCHEMA_ERROR', message: 'Notification field validator failed' },
    })
    expect(load).not.toHaveBeenCalled()
    expect(hook).not.toHaveBeenCalled()
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(0)
})

it('honors native defaults, field mapping, visibility, dates and adapter transforms without double application', async () => {
    const input = vi.fn<(value: unknown) => string>((value) => `stored:${String(value)}`)
    const output = vi.fn<(value: unknown) => string>((value) => String(value).replace(/^stored:/u, ''))
    const generated = vi.fn<() => string>(() => crypto.randomUUID())
    const app = await setup({
        schema: {
            notification: {
                modelName: 'appNotification',
                additionalFields: {
                    code: { type: 'string', fieldName: 'appCode', transform: { input, output } },
                    token: { type: 'string', input: false, returned: false, defaultValue: generated },
                    enabled: { type: 'boolean', defaultValue: false },
                    count: { type: 'number', defaultValue: 5, validator: { input: z.string().transform(Number) } },
                    scheduledAt: { type: 'date', required: false },
                    tags: { type: 'string[]', required: false },
                },
            },
        },
        kinds: { event: { required: ['scheduledAt'] } },
    })
    cleanups.push(app.close)
    const user = await app.user()
    const scheduledAt = new Date('2026-10-05T00:00:00Z')
    const body = {
        recipients: [user.id],
        idempotencyKey: 'native',
        notification: { type: 'event' as const, title: 'Event', code: 'abc', scheduledAt, tags: ['one', 'two'] },
    }
    const result = (await app.auth.api.sendNotification({ body })).results[0]!
    expect(result).toMatchObject({
        status: 'created',
        notification: { code: 'abc', enabled: false, count: 5, scheduledAt, tags: ['one', 'two'] },
    })
    expect(result).not.toHaveProperty('notification.token')
    expect(input).toHaveBeenCalledTimes(1)
    expect(app.database.prepare('SELECT appCode, token FROM appNotification').get()).toMatchObject({
        appCode: 'stored:abc',
        token: expect.any(String),
    })
    expect((await app.auth.api.sendNotification({ body })).results[0]?.status).toBe('duplicate')
    expect(input).toHaveBeenCalledTimes(1)
    expect(generated).toHaveBeenCalledTimes(2)
    const list = await app.auth.api.listUserNotifications({ query: { userIds: [user.id] } })
    expect(list.notifications[0]).toMatchObject({ code: 'abc', schemaStatus: 'current' })
    expect(list.notifications[0]).not.toHaveProperty('token')
    expect(output).toHaveBeenCalled()
})

it('keeps removed kinds and incompatible historical rows readable as legacy, without replaying input validators', async () => {
    const input = vi.fn<(value: unknown) => { value: string }>((value) => ({ value: String(value) }))
    const output = z.string().min(2)
    const app = await setup({
        schema: {
            notification: {
                additionalFields: {
                    slug: {
                        type: 'string',
                        required: false,
                        validator: { input: { '~standard': { version: 1, vendor: 'test', validate: input } }, output },
                    },
                    secret: { type: 'string', required: false, returned: false },
                    unsafeOutput: {
                        type: 'string',
                        required: false,
                        validator: { output: z.string().transform(() => 1n) },
                    },
                },
            },
        },
        kinds: { post: { required: ['slug'] } },
    })
    cleanups.push(app.close)
    const user = await app.user()
    for (const [id, type, slug] of [
        ['removed', 'old.post', 'valid'],
        ['missing', 'post', null],
        ['invalid', 'post', 'x'],
    ] as const) {
        await app.ctx.adapter.create({
            model: 'notification',
            data: {
                id,
                userId: user.id,
                idempotencyKey: id,
                type,
                title: 'Historical',
                body: null,
                actions: [],
                slug,
                secret: 'private',
                unsafeOutput: 'unsafe',
                createdAt: new Date(),
                readAt: null,
                archivedAt: null,
            },
            forceAllowId: true,
        })
    }
    const list = await app.auth.api.listNotifications({ headers: user.headers, query: {} })
    expect(list.notifications).toHaveLength(3)
    expect(list.notifications.every((row) => row.schemaStatus === 'legacy')).toBe(true)
    expect(list.notifications.every((row) => !Object.hasOwn(row, 'secret'))).toBe(true)
    expect(list.notifications.every((row) => row.unsafeOutput === null)).toBe(true)
    expect(input).not.toHaveBeenCalled()
    await app.auth.api.setNotificationRead({ headers: user.headers, body: { id: 'removed', read: true } })
    const removed = await app.auth.api.deleteNotifications({
        headers: user.headers,
        body: { ids: list.notifications.map((row) => row.id) },
    })
    expect(removed.results.every((row) => row.status === 'deleted')).toBe(true)
})

it('supports explicitly selected JSON fields and rejects values that cannot survive their native storage', async () => {
    const app = await setup({
        schema: { notification: { additionalFields: { metadata: { type: 'json', required: false } } } },
    })
    cleanups.push(app.close)
    const user = await app.user()
    const send = (metadata: unknown) =>
        app.auth.api.sendNotification({
            body: {
                recipients: [user.id],
                idempotencyKey: 'json',
                notification: { type: 'event', title: 'Event', metadata } as any,
            },
        })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const sparse: unknown[] = []
    sparse.length = 2
    for (const metadata of [
        { x: undefined },
        { x: Number.NaN },
        { x: 1n },
        { x: new Date() },
        circular,
        sparse,
        { [Symbol('x')]: 1 },
    ]) {
        await expect(send(metadata)).rejects.toMatchObject({ body: { code: 'NOTIFICATION_INVALID_FIELDS' } })
    }
    expect((await send({ nested: { b: 2, a: 1 } })).results[0]?.status).toBe('created')
    expect((await send({ nested: { a: 1, b: 2 } })).results[0]?.status).toBe('duplicate')
})

it('rejects logical/physical namespace collisions and invalid kind requirements at configuration time', () => {
    for (const additionalFields of [
        { title: { type: 'string' } },
        { custom: { type: 'string', fieldName: 'USERID' } },
        { one: { type: 'string', fieldName: 'same' }, two: { type: 'string', fieldName: 'same' } },
        { hidden: { type: 'string', required: true, input: false } },
        JSON.parse('{"__proto__":{"type":"string"}}'),
    ])
        expect(() => notification({ schema: { notification: { additionalFields } } })).toThrow(
            /notification|Non-input/u,
        )
    expect(() => notification({ kinds: { event: { required: ['missing'] } } } as any)).toThrow(
        'Unknown required notification field',
    )
})
