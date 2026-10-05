import { DatabaseSync } from 'node:sqlite'

import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { testUtils } from 'better-auth/plugins'

import { notification } from '../packages/better-notif/src/index'
import type { NotificationOptions, NotificationFields, NotificationKinds } from '../packages/better-notif/src/index'

function fixtureTestUtils() {
    const plugin = testUtils()
    return {
        ...plugin,
        init(ctx: Parameters<typeof plugin.init>[0]) {
            const { options, ...initialized } = plugin.init(ctx)
            // Older public helper types include options: undefined, incompatible with exact optional properties.
            return { ...initialized, ...(options === undefined ? {} : { options }) }
        },
    }
}

export async function setup<
    TContext = undefined,
    const F extends NotificationFields = {},
    const K extends NotificationKinds<F> = {},
>(options: NotificationOptions<TContext, F, K> = {}, filename = ':memory:', hooks?: BetterAuthOptions['hooks']) {
    const database = new DatabaseSync(filename)
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const auth = betterAuth({
        database,
        baseURL: 'http://localhost:3000',
        secret: 'notification-test-secret-at-least-thirty-two-characters',
        emailAndPassword: { enabled: true },
        advanced: { disableOriginCheck: false, disableCSRFCheck: false },
        user: { additionalFields: { plan: { type: 'string', defaultValue: 'free', input: false } } },
        plugins: [notification(options), fixtureTestUtils()] as const,
        logger: { disabled: true },
        ...(hooks ? { hooks } : {}),
    })
    const migrations = await getMigrations(auth.options)
    await migrations.runMigrations()
    const ctx = await auth.$context

    async function createUser(name: string = crypto.randomUUID()) {
        return ctx.test.saveUser(ctx.test.createUser({ name, email: `${name}@example.com` }))
    }

    async function user(name: string = crypto.randomUUID()) {
        const saved = await createUser(name)
        const { headers } = await ctx.test.login({ userId: saved.id })
        headers.set('origin', 'http://localhost:3000')
        return { id: saved.id, headers }
    }

    // Keep real signup for tests that need a credential account or exercise signup behavior.
    async function signUp(name: string = crypto.randomUUID()) {
        const response = await auth.api.signUpEmail({
            body: { email: `${name}@example.com`, password: 'a-long-test-password', name },
            asResponse: true,
        })
        if (!response.ok) throw new Error(await response.text())
        const data = (await response.json()) as { user: { id: string } }
        const headers = new Headers({ origin: 'http://localhost:3000' })
        headers.set(
            'cookie',
            response.headers
                .getSetCookie()
                .map((cookie) => cookie.split(';')[0])
                .join('; '),
        )
        return { id: data.user.id, headers }
    }

    function request(path: string, headers = new Headers(), body?: unknown) {
        const requestHeaders = new Headers(headers)
        if (body !== undefined) requestHeaders.set('content-type', 'application/json')
        return auth.handler(
            new Request(`http://localhost:3000/api/auth${path}`, {
                headers: requestHeaders,
                method: body === undefined ? 'GET' : 'POST',
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        )
    }

    return {
        auth,
        ctx,
        database,
        createUser,
        user,
        signUp,
        request,
        close: () => {
            if (database.isOpen) database.close()
        },
    }
}

export const content = {
    type: 'post.published',
    title: 'A post is ready',
    actions: [{ id: 'view', label: 'View post', href: '/posts/123' }],
}
