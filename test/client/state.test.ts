import { createAuthClient } from 'better-auth/client'
import type { AuthQueryAtom } from 'better-auth/client'
import { createAuthClient as createReactClient } from 'better-auth/react'
import { createAuthClient as createVueClient } from 'better-auth/vue'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { effectScope } from 'vue'

import { notificationClient } from '../../packages/better-notif/src/client'
import type { NotificationList } from '../../packages/better-notif/src/client'
import { content, setup } from '../utils'

const cleanups: (() => void)[] = []
beforeEach(() => {
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
})
afterEach(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
    vi.unstubAllGlobals()
})

async function clientFixture() {
    const app = await setup()
    cleanups.push(app.close)
    const user = await app.user()
    let cookie = user.headers.get('cookie')!
    let holdNextList = false
    let failNextList = false
    const requests: { path: string; type: string | null }[] = []
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const fetchImpl: typeof fetch = async (input, init) => {
        const request = new Request(input, init)
        request.headers.set('origin', 'http://localhost:3000')
        request.headers.set('cookie', cookie)
        const path = new URL(request.url).pathname
        if (path.startsWith('/api/auth/notification/'))
            requests.push({ path, type: new URL(request.url).searchParams.get('type') })
        if (failNextList && path.endsWith('/notification/list')) {
            failNextList = false
            return new Response(JSON.stringify({ message: 'Temporarily unavailable' }), {
                status: 503,
                headers: { 'content-type': 'application/json' },
            })
        }
        const shouldHold = holdNextList && path.endsWith('/notification/list')
        if (shouldHold) holdNextList = false
        const response = await app.auth.handler(request)
        if (path.endsWith('/sign-out') && response.ok) cookie = ''
        if (shouldHold) {
            started.resolve()
            await release.promise
        }
        return response
    }
    const clientOptions = {
        baseURL: 'http://localhost:3000',
        fetchOptions: { customFetchImpl: fetchImpl, retry: 0 },
        sessionOptions: { refetchOnWindowFocus: false, refetchInterval: 0 },
    }
    const client = createAuthClient({ ...clientOptions, plugins: [notificationClient()] })
    const list = client.$store.atoms.notifications as AuthQueryAtom<NotificationList>
    const count = client.$store.atoms.unreadNotificationCount as AuthQueryAtom<{ count: number }>
    return {
        app,
        user,
        client,
        clientOptions,
        list,
        count,
        requests,
        hold: () => {
            holdNextList = true
            return { started: started.promise, release: () => release.resolve() }
        },
        fail: () => {
            failNextList = true
        },
        switchTo: (headers: Headers) => {
            cookie = headers.get('cookie') ?? ''
            client.$store.notify('$sessionSignal')
        },
    }
}

it('shares list/count state, refreshes after mutations, exposes errors, and clears on sign-out', async () => {
    const { app, user, client, list, count, fail } = await clientFixture()
    await app.auth.api.sendNotification({
        body: { recipients: [user.id], idempotencyKey: 'client', notification: content },
    })
    cleanups.push(
        list.subscribe(() => {}),
        count.subscribe(() => {}),
    )
    await vi.waitFor(() => expect(list.get().data?.notifications).toHaveLength(1))
    await vi.waitFor(() => expect(count.get().data?.count).toBe(1))
    const id = list.get().data!.notifications[0]!.id
    expect(list.get().data!.notifications[0]!.createdAt).toBeInstanceOf(Date)
    expect((await client.notification.setRead({ id, read: true })).error).toBeNull()
    await vi.waitFor(() => expect(count.get().data?.count).toBe(0))
    expect((await client.notification.setArchived({ id, archived: true })).error).toBeNull()
    await vi.waitFor(() => expect(list.get().data?.notifications).toHaveLength(0))
    await client.notification.refetch({ archived: 'archived' })
    expect(list.get().data?.notifications).toHaveLength(1)
    fail()
    await client.notification.refetch()
    expect(list.get().error?.status).toBe(503)
    expect(list.get().data?.notifications).toHaveLength(1)
    await client.notification.refetch()
    expect(list.get().error).toBeNull()
    await client.signOut()
    // Better Auth dispatches session signals on a short deferred timer.
    await vi.waitFor(() => expect(list.get().data).toBeNull())
    await vi.waitFor(() => expect(count.get().data).toBeNull())
    await vi.waitFor(() => expect(list.get().error?.status).toBe(401))
})

it('refreshes shared state after batch updates and deletion', async () => {
    const { app, user, client, list, count } = await clientFixture()
    for (const key of ['one', 'two'])
        await app.auth.api.sendNotification({
            body: { recipients: [user.id], idempotencyKey: key, notification: content },
        })
    cleanups.push(
        list.subscribe(() => {}),
        count.subscribe(() => {}),
    )
    await vi.waitFor(() => expect(list.get().data?.notifications).toHaveLength(2))
    await vi.waitFor(() => expect(count.get().data?.count).toBe(2))
    const ids = list.get().data!.notifications.map((row) => row.id)
    expect((await client.notification.setReadMany({ ids, read: true })).error).toBeNull()
    await vi.waitFor(() => expect(count.get().data?.count).toBe(0))
    expect((await client.notification.setReadMany({ ids, read: false })).error).toBeNull()
    await vi.waitFor(() => expect(count.get().data?.count).toBe(2))
    expect((await client.notification.setArchivedMany({ ids, archived: true })).error).toBeNull()
    await vi.waitFor(() => expect(list.get().data?.notifications).toHaveLength(0))
    await vi.waitFor(() => expect(count.get().data?.count).toBe(0))
    await client.notification.refetch({ archived: 'all' })
    expect(list.get().data?.notifications).toHaveLength(2)
    expect((await client.notification.delete({ id: ids[0]! })).data).toEqual({ deleted: true, hook: 'skipped' })
    await vi.waitFor(() => expect(list.get().data?.notifications).toHaveLength(1))
    expect((await client.notification.deleteMany({ ids })).error).toBeNull()
    await vi.waitFor(() => expect(list.get().data?.notifications).toHaveLength(0))
})

it('does not let a response from the previous user repopulate shared state', async () => {
    const { app, user, client, list, hold, switchTo } = await clientFixture()
    const second = await app.user()
    const firstSent = await app.auth.api.sendNotification({
        body: {
            recipients: [user.id],
            idempotencyKey: 'first',
            notification: { ...content, title: 'First user' },
        },
    })
    expect(firstSent.results[0]?.status).toBe('created')
    const secondSent = await app.auth.api.sendNotification({
        body: {
            recipients: [second.id],
            idempotencyKey: 'second',
            notification: { ...content, title: 'Second user' },
        },
    })
    expect(secondSent.results[0]?.status).toBe('created')
    cleanups.push(list.subscribe(() => {}))
    // Server-side arrivals need an explicit refresh if the client already fetched its first page.
    await client.notification.refetch()
    await vi.waitFor(() => expect(list.get()).toMatchObject({ data: { notifications: [{ title: 'First user' }] } }))
    const pending = hold()
    const oldRequest = client.notification.refetch()
    await pending.started
    switchTo(second.headers)
    expect(list.get().data).toBeNull()
    await vi.waitFor(() => expect(list.get().data?.notifications[0]?.title).toBe('Second user'))
    pending.release()
    await oldRequest
    expect(list.get().data?.notifications[0]?.title).toBe('Second user')
    await client.updateUser({ name: 'Second user updated' })
    await vi.waitFor(() => expect(list.get().data?.notifications[0]?.title).toBe('Second user'))
})

it('integrates with Vue reactive scopes and React SSR without fetching during SSR', async () => {
    const { app, user, clientOptions } = await clientFixture()
    await app.auth.api.sendNotification({
        body: { recipients: [user.id], idempotencyKey: 'framework', notification: content },
    })
    const vue = createVueClient({ ...clientOptions, plugins: [notificationClient()] })
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const state = scope.run(() => vue.useNotifications())!
    await vi.waitFor(() => expect(state.value.data?.notifications).toHaveLength(1))
    vi.unstubAllGlobals()
    const fetchSpy = vi.fn<typeof fetch>()
    const react = createReactClient({
        baseURL: 'http://localhost:3000',
        plugins: [notificationClient()],
        fetchOptions: { customFetchImpl: fetchSpy },
    })
    const markup = renderToString(
        createElement(() => {
            const notifications = react.useNotifications()
            return createElement('span', null, notifications.isPending ? 'Loading' : 'Ready')
        }),
    )
    expect(markup).toBe('<span>Loading</span>')
    expect(fetchSpy).not.toHaveBeenCalled()
})

it('keeps query-keyed views independent across pages, mutations, session changes and disposal', async () => {
    const { app, user, client, requests, hold, switchTo } = await clientFixture()
    const replacement = await app.user()
    for (const [owner, type, title, key] of [
        [user.id, 'alpha', 'Alpha one', 'a1'],
        [user.id, 'alpha', 'Alpha two', 'a2'],
        [user.id, 'alpha', 'Alpha three', 'a3'],
        [user.id, 'beta', 'Beta', 'b'],
        [replacement.id, 'alpha', 'Next alpha', 'next-a'],
        [replacement.id, 'beta', 'Next beta', 'next-b'],
    ] as const)
        await app.auth.api.sendNotification({
            body: { recipients: [owner], idempotencyKey: key, notification: { type, title } },
        })
    const alpha = client.notification.createQuery({ type: 'alpha', limit: 1 })
    const beta = client.notification.createQuery({ type: 'beta', read: 'unread' })
    const equivalent = client.notification.createQuery({ read: 'unread', type: 'beta' })
    expect(equivalent.key).toBe(beta.key)
    expect(equivalent.notifications).not.toBe(beta.notifications)
    equivalent.dispose()
    cleanups.push(
        () => alpha.dispose(),
        () => beta.dispose(),
        alpha.notifications.subscribe(() => {}),
        beta.notifications.subscribe(() => {}),
    )
    await Promise.all([alpha.refetch(), beta.refetch()])
    await vi.waitFor(() => expect(alpha.notifications.get().data?.total).toBe(3))
    expect(beta.notifications.get().data?.notifications[0]?.title).toBe('Beta')
    expect(alpha.unreadCount.get().data?.count).toBe(3)
    const firstId = alpha.notifications.get().data!.notifications[0]!.id
    await alpha.nextPage()
    const secondId = alpha.notifications.get().data!.notifications[0]!.id
    expect(secondId).not.toBe(firstId)
    expect(beta.notifications.get().data?.notifications[0]?.title).toBe('Beta')
    const betaId = beta.notifications.get().data!.notifications[0]!.id
    await client.notification.setRead({ id: betaId, read: true })
    await vi.waitFor(() => expect(beta.notifications.get().data?.notifications).toEqual([]))
    await vi.waitFor(() => expect(beta.unreadCount.get().data?.count).toBe(0))
    expect(alpha.notifications.get().data?.notifications[0]?.id).toBe(secondId)
    expect(
        requests
            .filter((request) => /\/(list|unread-count)$/u.test(request.path))
            .every((request) => request.type === 'alpha' || request.type === 'beta'),
    ).toBe(true)
    const pending = hold()
    const oldResponse = alpha.refetch()
    await pending.started
    switchTo(replacement.headers)
    expect(alpha.notifications.get().data).toBeNull()
    expect(beta.notifications.get().data).toBeNull()
    await vi.waitFor(() => expect(alpha.notifications.get().data?.notifications[0]?.title).toBe('Next alpha'))
    await vi.waitFor(() => expect(beta.notifications.get().data?.notifications[0]?.title).toBe('Next beta'))
    pending.release()
    await oldResponse
    expect(alpha.notifications.get().data?.notifications[0]?.title).toBe('Next alpha')
    alpha.dispose()
    const requestsBefore = requests.filter((request) => request.type === 'alpha').length
    await client.notification.setRead({ id: beta.notifications.get().data!.notifications[0]!.id, read: true })
    await vi.waitFor(() => expect(beta.notifications.get().data?.notifications).toEqual([]))
    expect(requests.filter((request) => request.type === 'alpha')).toHaveLength(requestsBefore)
    expect(alpha.notifications.get().data).toBeNull()
})

it('does not fetch query instances during SSR subscriptions', () => {
    vi.unstubAllGlobals()
    const fetchSpy = vi.fn<typeof fetch>()
    const client = createAuthClient({
        baseURL: 'http://localhost:3000',
        plugins: [notificationClient()],
        fetchOptions: { customFetchImpl: fetchSpy },
    })
    const view = client.notification.createQuery({ read: 'unread' })
    const stop = view.notifications.subscribe(() => {})
    expect(view.notifications.get().data).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    stop()
    view.dispose()
})
