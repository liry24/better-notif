import type { DBPrimitive } from '@better-auth/core/db'
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { createAuthClient, parseJSON } from 'better-auth/client'
import * as v from 'valibot'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import * as z from 'zod'

import { notificationClient } from '../../packages/better-notif/src/client'
import { encodeNotificationDates, notificationDateHeader } from '../../packages/better-notif/src/transport'
import { setup } from '../utils'

const close: (() => void)[] = []
afterEach(() => {
    for (const cleanup of close.splice(0)) cleanup()
})

it('scopes relative-base requests and rejects bad metadata before success callbacks', async () => {
    const iso = '2026-01-01T00:00:00.000Z'
    const data = {
        notifications: [{ id: 'one', title: iso, createdAt: new Date(iso) }],
        total: 1,
        hasMore: false,
        nextCursor: null,
    }
    let metadata: string | undefined = encodeNotificationDates(data)
    const onSuccess = vi.fn<(context: { data: unknown }) => void>()
    const client = createAuthClient({
        plugins: [notificationClient()],
        fetchOptions: {
            onSuccess,
            customFetchImpl: async (input) => {
                const url = new URL(input instanceof Request ? input.url : input, 'http://localhost:3000')
                if (url.pathname === '/api/auth/notification/list')
                    return Response.json(data, {
                        headers: metadata === undefined ? {} : { [notificationDateHeader]: metadata },
                    })
                return Response.json({ session: { createdAt: iso }, user: { id: 'one' } })
            },
        },
    })
    expect((await client.getSession()).data?.session.createdAt).toBeInstanceOf(Date)
    const result = await client.notification.list({ query: {} })
    expect(result.data?.notifications[0]?.title).toBe(iso)
    expect(result.data?.notifications[0]?.createdAt).toBeInstanceOf(Date)
    onSuccess.mockClear()
    metadata = undefined
    await expect(client.notification.list({ query: {} })).rejects.toThrow('notification date metadata')
    metadata = JSON.stringify({ v: 2, paths: [] })
    await expect(client.notification.list({ query: {} })).rejects.toThrow('notification date metadata')
    metadata = JSON.stringify({ v: 1, paths: [['__proto__']] })
    await expect(client.notification.list({ query: {} })).rejects.toThrow('notification date path')
    expect(onSuccess).not.toHaveBeenCalled()
})

it('preserves declared string/date contracts through native storage and ordinary clients without changing other auth routes', async () => {
    const iso = '2026-01-01T00:00:00.000Z'
    const precise = '2026-01-01T00:00:00.123456Z'
    const offset = '2026-01-01T09:00:00+09:00'
    const metadata = { when: precise, values: [iso, { at: offset }] }
    const metadataSchema = z.object({
        when: z.string(),
        values: z.array(z.union([z.string(), z.object({ at: z.string() })])),
    })
    const transformed = vi.fn<(value: DBPrimitive) => DBPrimitive>((value) => value)
    const app = await setup(
        {
            fields: {
                label: { type: 'string' },
                metadata: {
                    type: 'json',
                    validator: { input: metadataSchema, output: metadataSchema },
                    transform: { output: transformed },
                },
                timestamps: { type: 'string[]' },
                dueAt: { type: 'date' },
                displayDate: {
                    type: 'date',
                    validator: { output: z.date().transform((date) => date.toISOString()) },
                },
                computedDate: {
                    type: 'string',
                    validator: {
                        input: v.string(),
                        output: v.pipe(
                            v.string(),
                            v.transform((value) => new Date(value)),
                        ),
                    },
                },
                summary: {
                    type: 'json',
                    validator: {
                        input: z.object({ value: z.string() }),
                        output: z.object({ value: z.string() }).transform((value) => value.value),
                    },
                },
                optional: { type: 'date', required: false },
                freeform: { type: 'json', required: false },
            },
        },
        ':memory:',
        undefined,
        '/custom/auth',
    )
    close.push(app.close)
    const observed = vi.fn<() => void>()
    const options: BetterAuthOptions = app.ctx.options
    const observer: BetterAuthPlugin = {
        id: 'observe-notification-result',
        hooks: {
            after: [
                {
                    matcher: (ctx) => ctx.path === '/notification/list',
                    handler: createAuthMiddleware(async (ctx) => {
                        const result = ctx.context.returned as { notifications: { dueAt: Date; label: string }[] }
                        expect(result.notifications[0]?.dueAt).toBeInstanceOf(Date)
                        expect(result.notifications[0]?.label).toBe(precise)
                        observed()
                    }),
                },
            ],
        },
    }
    options.plugins = [...(options.plugins ?? []), observer]
    const user = await app.user()
    const notification = {
        type: 'example',
        title: iso,
        label: precise,
        metadata,
        timestamps: [iso, precise, offset],
        dueAt: new Date(iso),
        displayDate: new Date(iso),
        computedDate: iso,
        summary: { value: iso },
        actions: [{ id: iso, label: precise, href: '/example' }],
    }
    const sent = await app.auth.api.sendNotification({
        body: { recipients: [user.id], idempotencyKey: 'transport', notification },
    })
    expect(sent.results[0]).toMatchObject({
        status: 'created',
        notification: { schemaStatus: 'current', metadata, timestamps: [iso, precise, offset], summary: iso },
    })
    expect(transformed).toHaveBeenCalledTimes(1)
    const stored = app.database.prepare('SELECT metadata, actions FROM notification').get()
    expect(JSON.parse(String(stored?.metadata))).toEqual(metadata)
    expect(JSON.parse(String(stored?.actions))).toEqual(notification.actions)
    const direct = await app.auth.api.listNotifications({ headers: user.headers, query: {} })
    expect(direct.notifications[0]).toMatchObject({
        schemaStatus: 'current',
        label: precise,
        metadata,
        dueAt: new Date(iso),
        displayDate: iso,
        computedDate: new Date(iso),
        summary: iso,
        optional: null,
    })
    for (const freeform of [iso, 42, true])
        await expect(
            app.auth.api.sendNotification({
                body: {
                    recipients: [user.id],
                    idempotencyKey: 'scalar',
                    notification: { ...notification, freeform } as any,
                },
            }),
        ).rejects.toMatchObject({ body: { code: 'NOTIFICATION_INVALID_FIELDS' } })
    expect(await app.ctx.adapter.count({ model: 'notification' })).toBe(1)

    const parser = vi.fn<(text: string) => unknown>((text) => parseJSON(text))
    const globalSuccess = vi.fn<(context: { data: unknown }) => void>()
    const client = createAuthClient({
        baseURL: 'http://localhost:3000',
        basePath: '/custom/auth',
        plugins: [notificationClient<typeof app.auth>()],
        fetchOptions: {
            headers: { 'x-example': 'preserved' },
            jsonParser: parser,
            onSuccess: globalSuccess,
            customFetchImpl: (input, init) => {
                const request = new Request(input, init)
                expect(request.headers.get('x-example')).toBe('preserved')
                request.headers.set('cookie', user.headers.get('cookie')!)
                request.headers.set('origin', 'http://localhost:3000')
                return app.auth.handler(request)
            },
        },
    })
    const perCall = vi.fn<(context: { data: unknown }) => void>()
    const response = await client.notification.list(
        { query: {} },
        {
            onSuccess: perCall,
            output: z
                .object({ notifications: z.array(z.object({ label: z.string(), dueAt: z.date() }).passthrough()) })
                .passthrough(),
        },
    )
    expect(response.error).toBeNull()
    expect(response.data).toEqual(direct)
    expect(globalSuccess.mock.calls.at(-1)?.[0].data).toEqual(direct)
    expect(perCall.mock.calls[0]?.[0].data).toEqual(direct)
    expect(parser).not.toHaveBeenCalled()
    expect(observed).toHaveBeenCalled()
    const view = client.notification.createQuery({ archived: 'all' })
    close.push(view.dispose)
    await view.refetch()
    expect(view.notifications.get().data).toEqual(direct)
    const id = direct.notifications[0]!.id
    const changed = await client.notification.setRead({ id, read: true })
    expect(changed.data?.notification).toMatchObject({
        metadata,
        label: precise,
        dueAt: new Date(iso),
        displayDate: iso,
    })
    expect(changed.data?.notification.readAt).toBeInstanceOf(Date)
    const batch = await client.notification.setArchivedMany({ ids: [id], archived: true })
    expect(batch.data?.results[0]).toMatchObject({
        status: 'updated',
        notification: { metadata, computedDate: new Date(iso) },
    })
    expect((await client.notification.setRead({ id: 'missing', read: true })).error?.status).toBe(404)
    expect((await client.getSession()).data?.session.createdAt).toBeInstanceOf(Date)
    expect(parser).toHaveBeenCalled()
    const [concurrentList, concurrentSession] = await Promise.all([
        client.notification.list({ query: { archived: 'all' } }),
        client.getSession(),
    ])
    expect(concurrentList.data?.notifications[0]?.label).toBe(precise)
    expect(concurrentSession.data?.session.createdAt).toBeInstanceOf(Date)

    const plain = await app.request('/notification/list?archived=all', user.headers)
    expect(plain.headers.get('content-type')).toContain('application/json')
    expect(await plain.json()).toMatchObject({
        notifications: [{ label: precise, metadata, dueAt: iso, computedDate: iso }],
    })
    const native = await app.auth.api.listNotifications({
        query: { archived: 'all' },
        headers: user.headers,
        request: new Request('http://localhost:3000/custom/auth/notification/list', { headers: user.headers }),
        asResponse: false,
    })
    expect(native.notifications[0]?.dueAt).toBeInstanceOf(Date)
    const http = await app.request('/notification/list?archived=all', user.headers)
    expect(http.headers.get('content-type')).toContain('application/json')
    expect(http.headers.get(notificationDateHeader)).not.toBeNull()
    expect(http.headers.get('access-control-expose-headers')).toContain(notificationDateHeader)
    expect(await http.json()).toMatchObject({ notifications: [{ label: precise, metadata }] })
})

it('transports full 100-record lists and mutation results within the header bound', async () => {
    const app = await setup()
    close.push(app.close)
    const user = await app.user()
    const created = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
            app.auth.api.sendNotification({
                body: {
                    recipients: [user.id],
                    idempotencyKey: `page-${index}`,
                    notification: { type: 'page', title: 'Page' },
                },
            }),
        ),
    )
    const ids = created.map((result) => {
        const item = result.results[0]!
        if (item.status !== 'created') throw new Error('Fixture notification was not created')
        return item.notification.id
    })
    const client = createAuthClient({
        baseURL: 'http://localhost:3000',
        plugins: [notificationClient<typeof app.auth>()],
        fetchOptions: {
            customFetchImpl: (input, init) => {
                const request = new Request(input, init)
                for (const [key, value] of user.headers) request.headers.set(key, value)
                return app.auth.handler(request)
            },
        },
    })
    expect((await client.notification.setReadMany({ ids, read: true })).error).toBeNull()
    const batch = await client.notification.setArchivedMany({ ids, archived: true })
    expect(batch.error).toBeNull()
    expect(batch.data?.results).toHaveLength(100)
    for (const item of batch.data!.results) {
        expect(item.status).toBe('updated')
        if (item.status !== 'updated') throw new Error('Expected an updated notification')
        expect(item.notification.createdAt).toBeInstanceOf(Date)
        expect(item.notification.readAt).toBeInstanceOf(Date)
        expect(item.notification.archivedAt).toBeInstanceOf(Date)
    }
    const partial = await client.notification.setReadMany({ ids: [...ids.slice(0, 99), 'missing'], read: true })
    expect(partial.error).toBeNull()
    expect(partial.data?.results).toHaveLength(100)
    expect(partial.data?.results.filter((item) => item.status === 'unchanged')).toHaveLength(99)
    expect(partial.data?.results).toContainEqual({ id: 'missing', status: 'not_found' })
    const page = await client.notification.list({ query: { limit: 100, archived: 'all' } })
    expect(page.error).toBeNull()
    expect(page.data?.notifications).toHaveLength(100)
    expect(
        page.data?.notifications.every(
            (item) => item.createdAt instanceof Date && item.readAt instanceof Date && item.archivedAt instanceof Date,
        ),
    ).toBe(true)
})

it('keeps legacy invalid date fields readable with their ordinary JSON null value', async () => {
    const app = await setup({ fields: { dueAt: { type: 'date', transform: { output: () => new Date(Number.NaN) } } } })
    close.push(app.close)
    const user = await app.user()
    await app.auth.api.sendNotification({
        body: {
            recipients: [user.id],
            idempotencyKey: 'legacy-date',
            notification: { type: 'legacy', title: 'Legacy', dueAt: new Date() },
        },
    })
    const client = createAuthClient({
        baseURL: 'http://localhost:3000',
        plugins: [notificationClient<typeof app.auth>()],
        fetchOptions: {
            customFetchImpl: (input, init) => {
                const request = new Request(input, init)
                for (const [key, value] of user.headers) request.headers.set(key, value)
                return app.auth.handler(request)
            },
        },
    })
    const page = await client.notification.list({ query: {} })
    expect(page.error).toBeNull()
    expect(page.data?.notifications[0]).toMatchObject({
        schemaStatus: 'legacy',
        dueAt: null,
        createdAt: expect.any(Date),
    })
})

it('reports completed mutation identities when application date fields exceed the metadata bound', async () => {
    const field = 'date'.repeat(1600)
    const app = await setup({ fields: { [field]: { type: 'date' } } })
    close.push(app.close)
    const user = await app.user()
    const created = await app.auth.api.sendNotification({
        body: {
            recipients: [user.id],
            idempotencyKey: 'large-date-field',
            notification: { type: 'large', title: 'Large', [field]: new Date() } as any,
        },
    })
    const item = created.results[0]!
    if (item.status !== 'created') throw new Error('Fixture notification was not created')
    const read = await app.request('/notification/list', user.headers)
    expect(read.status).toBe(500)
    expect(await read.json()).toMatchObject({ code: 'NOTIFICATION_TRANSPORT_LIMIT' })
    const changed = await app.request('/notification/set-read', user.headers, { id: item.notification.id, read: true })
    expect(changed.status).toBe(500)
    expect(await changed.json()).toMatchObject({
        code: 'NOTIFICATION_TRANSPORT_LIMIT',
        mutationResults: [{ id: item.notification.id, status: 'updated', hook: 'skipped' }],
    })
    const batch = await app.request('/notification/set-archived-many', user.headers, {
        ids: [item.notification.id, 'missing'],
        archived: true,
    })
    expect(batch.status).toBe(500)
    expect(await batch.json()).toMatchObject({
        code: 'NOTIFICATION_TRANSPORT_LIMIT',
        mutationResults: expect.arrayContaining([
            { id: item.notification.id, status: 'updated', hook: 'skipped' },
            { id: 'missing', status: 'not_found' },
        ]),
        hasMore: false,
        nextCursor: null,
    })
    const saved = (await app.auth.api.listNotifications({ headers: user.headers, query: { archived: 'all' } }))
        .notifications[0]!
    expect(saved.readAt).toBeInstanceOf(Date)
    expect(saved.archivedAt).toBeInstanceOf(Date)
})
