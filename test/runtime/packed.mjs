import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise the published runtime independently of Vite+, TypeScript loading, and node:sqlite.
const root = fileURLToPath(new URL('../../', import.meta.url))
assert(process.env.NOTIFICATION_TARBALL, 'NOTIFICATION_TARBALL must identify the already-built artifact')
const tarball = resolve(process.env.NOTIFICATION_TARBALL)
const directory = await mkdtemp(join(tmpdir(), 'notification-runtime-'))
const version = process.env.NOTIFICATION_BETTER_AUTH_VERSION ?? '^1.7.0'
const env = { ...process.env, npm_config_cache: join(directory, '.npm-cache'), npm_config_engine_strict: 'true' }
function run(program, args) {
    return execFileSync(program, args, { cwd: directory, env, encoding: 'utf8', timeout: 240_000 })
}
function npm(args) {
    return process.platform === 'win32'
        ? run(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args])
        : run('npm', args)
}
const hash = async () =>
    createHash('sha256')
        .update(await readFile(tarball))
        .digest('hex')
try {
    const before = await hash()
    const archiveName = `better-notif-${before}.tgz`
    const entries = run('tar', ['-tzf', tarball]).trim().split(/\r?\n/u)
    assert(entries.every((entry) => /^package\/(?:dist(?:\/.*)?|package.json|README.md|LICENSE)$/u.test(entry)))
    assert(!entries.some((entry) => entry.endsWith('.map')), 'Packed files must not contain source maps')
    const license = run('tar', ['-xOf', tarball, 'package/LICENSE'])
    assert.equal(license, await readFile(join(root, 'LICENSE'), 'utf8'))
    assert.equal(license.split(/\r?\n/u)[2], 'Copyright (c) 2026 Liry24')
    const manifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']))
    assert.equal(manifest.engines.node, '>=22.0.0')
    await copyFile(tarball, join(directory, archiveName))
    await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
            name: 'notification-runtime-consumer',
            private: true,
            type: 'module',
            dependencies: {
                'better-notif': `file:./${archiveName}`,
                'better-auth': version,
                '@better-auth/core': version,
                'better-sqlite3': '12.11.1',
                zod: '^4.5.4',
                valibot: '^1.5.0',
            },
        }),
    )
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'])
    // Run only the explicitly selected SQLite driver's native installation script.
    npm(['rebuild', 'better-sqlite3'])
    const installed = join(directory, 'node_modules/better-notif')
    assert.deepEqual(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')), manifest)
    await Promise.all(
        entries
            .filter((name) => !name.endsWith('/') && name !== 'package/dist')
            .map(async (entry) => {
                const installedPath = resolve(installed, entry.slice('package/'.length))
                assert(installedPath.startsWith(resolve(installed) + sep))
                const packedBytes = execFileSync('tar', ['-xOf', tarball, entry], { cwd: directory })
                if (entry.startsWith('package/dist/'))
                    assert.doesNotMatch(packedBytes.toString('utf8'), /(?:sourceMappingURL|declarationMap)\s*[:=]/u)
                assert.deepEqual(await readFile(installedPath), packedBytes)
            }),
    )
    const authVersion = JSON.parse(
        await readFile(join(directory, 'node_modules/better-auth/package.json'), 'utf8'),
    ).version
    assert.equal(
        authVersion,
        JSON.parse(await readFile(join(directory, 'node_modules/@better-auth/core/package.json'), 'utf8')).version,
    )
    if (/^\d+\.\d+\.\d+$/u.test(version)) assert.equal(authVersion, version)
    await writeFile(
        join(directory, 'consumer.mjs'),
        `import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { getMigrations } from 'better-auth/db/migration'
import { notification } from 'better-notif'
import { notificationClient } from 'better-notif/client'
import * as z from 'zod'
import * as v from 'valibot'
const database = new Database(':memory:')
let createdHooks = 0
const auth = betterAuth({ database, baseURL: 'http://localhost:3000', secret: 'runtime-notification-secret-more-than-thirty-two-characters', emailAndPassword: { enabled: true }, advanced: { disableOriginCheck: false, disableCSRFCheck: false }, logger: { disabled: true }, plugins: [notification({ schema: { notification: { additionalFields: {
  amount: { type: 'number', required: false, validator: { input: z.string().transform(Number) } },
  slug: { type: 'string', required: false, validator: { input: v.pipe(v.string(), v.trim()) } },
  label: { type: 'string', required: false },
  metadata: { type: 'json', required: false, validator: { input: z.object({ values: z.array(z.string()) }) } },
  timestamps: { type: 'string[]', required: false },
  dueAt: { type: 'date', required: false },
  displayDate: { type: 'date', required: false, validator: { output: z.date().transform((date) => date.toISOString()) } },
  computedDate: { type: 'string', required: false, validator: { output: v.pipe(v.string(), v.transform((value) => new Date(value))) } },
} } }, kinds: { invoice: { required: ['amount'] }, post: { required: ['slug'] } }, filterableFields: ['amount', 'slug'], onNotificationCreated: ({ notification: item }) => { createdHooks++; if (item.type === 'invoice') assert.equal(item.amount, 42) } })] })
await (await getMigrations(auth.options)).runMigrations()
const registered = await auth.api.signUpEmail({ body: { name: 'Consumer', email: 'consumer@example.com', password: 'a-long-consumer-password' }, asResponse: true })
assert.equal(registered.status, 200)
const signup = await registered.json()
const cookie = registered.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
const headers = { cookie, origin: 'http://localhost:3000' }
const iso = '2026-01-01T00:00:00.000Z'
const precise = '2026-01-01T00:00:00.123456Z'
const strings = [iso, precise, '2026-01-01T09:00:00+09:00']
const body = { recipients: [signup.user.id], idempotencyKey: 'invoice', notification: { type: 'invoice', title: iso, amount: '42', label: precise, metadata: { values: strings }, timestamps: strings, dueAt: new Date(iso), displayDate: new Date(iso), computedDate: iso, actions: [{ id: iso, label: precise, href: '/example' }] } }
const first = (await auth.api.sendNotification({ body })).results[0]
assert.equal(first.status, 'created')
assert.equal(first.notification.amount, 42)
assert.equal((await auth.api.sendNotification({ body })).results[0].status, 'duplicate')
assert.equal(createdHooks, 1)
assert.equal(database.prepare('SELECT amount FROM notification').get().amount, 42)
await assert.rejects(auth.api.sendNotification({ body: { ...body, notification: { type: 'invoice', title: 'Invalid', amount: 'not-a-number' } } }))
await assert.rejects(auth.api.sendNotification({ body: { ...body, notification: { type: 'post', title: 'Invalid', slug: 123 } } }))
const post = (await auth.api.sendNotification({ body: { ...body, idempotencyKey: 'post', notification: { type: 'post', title: 'Post', slug: ' hello ' } } })).results[0]
assert.equal(post.status, 'created')
assert.equal(post.notification.slug, 'hello')
assert.equal(createdHooks, 2)
const firstPage = await auth.api.listNotifications({ headers, query: { limit: 1 } })
assert.equal(firstPage.total, 2)
assert.equal(firstPage.hasMore, true)
const secondPage = await auth.api.listNotifications({ headers, query: { limit: 1, cursor: firstPage.nextCursor } })
assert.equal(secondPage.notifications.length, 1)
assert.notEqual(firstPage.notifications[0].id, secondPage.notifications[0].id)
assert.equal(secondPage.hasMore, false)
const client = createAuthClient({ baseURL: 'http://localhost:3000', plugins: [notificationClient()], fetchOptions: { customFetchImpl: (input, init) => {
  const request = new Request(input, init)
  request.headers.set('cookie', cookie)
  request.headers.set('origin', 'http://localhost:3000')
  return auth.handler(request)
} } })
const invoiceView = client.notification.createQuery({ fields: { amount: 42 } })
const postView = client.notification.createQuery({ fields: { slug: 'hello' } })
await Promise.all([invoiceView.refetch(), postView.refetch()])
assert.equal(invoiceView.notifications.get().data.total, 1)
const transported = invoiceView.notifications.get().data.notifications[0]
assert.equal(transported.schemaStatus, 'current')
assert.equal(transported.label, precise)
assert.deepEqual(transported.metadata, { values: strings })
assert.deepEqual(transported.timestamps, strings)
assert.deepEqual(transported.actions, body.notification.actions)
assert.deepEqual(transported.dueAt, new Date(iso))
assert.deepEqual(transported.computedDate, new Date(iso))
assert.equal(transported.displayDate, iso)
assert(transported.createdAt instanceof Date)
assert.deepEqual(JSON.parse(database.prepare('SELECT metadata FROM notification WHERE id = ?').get(first.notification.id).metadata), { values: strings })
assert.equal(postView.notifications.get().data.total, 1)
assert.equal(invoiceView.unreadCount.get().data.count, 1)
await client.notification.setRead({ id: first.notification.id, read: true })
await invoiceView.refetch()
assert.equal(invoiceView.unreadCount.get().data.count, 0)
assert.equal((await auth.api.getUnreadNotificationCount({ headers, query: {} })).count, 1)
invoiceView.dispose()
postView.dispose()
assert.equal((await auth.handler(new Request('http://localhost:3000/api/auth/notification/list'))).status, 401)
assert.equal((await auth.handler(new Request('http://localhost:3000/api/auth/notification/send', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' }))).status, 404)
const removed = await auth.api.deleteUserNotifications({ body: { userIds: [signup.user.id] } })
assert.equal(removed.results.length, 2)
assert(removed.results.every((result) => result.status === 'deleted'))
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM notification').get().count, 0)
database.close()
`,
    )
    run(process.execPath, ['consumer.mjs'])
    assert.equal(await hash(), before)
    process.stdout.write(
        `PASS Node ${process.version}, Better Auth ${authVersion}, better-sqlite3, artifact ${before}\n`,
    )
} finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert(directory.startsWith(join(tmpdir(), 'notification-runtime-')))
    await rm(directory, { recursive: true, force: true })
}
