import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vite-plus/test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const packageDirectory = join(root, 'packages/better-notif')

function run(program: string, args: string[], cwd: string, env = process.env) {
    try {
        if (process.platform === 'win32' && program === 'npm') {
            return execFileSync(
                process.execPath,
                [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args],
                { cwd, env, encoding: 'utf8', stdio: 'pipe' },
            )
        }
        if (process.platform === 'win32' && program === 'pnpm') {
            return run('npm', ['exec', '--yes', '--package=pnpm@10.25.0', '--', 'pnpm', ...args], cwd, env)
        }
        return execFileSync(program, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
        if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
            throw new Error(`${error.message}\n${error.stdout}`, { cause: error })
        }
        throw error
    }
}

it('installs and exercises the actual tarball in an isolated consumer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notification-consumer-'))
    try {
        let tarball = process.env.NOTIFICATION_TARBALL
        if (!tarball) {
            run(process.execPath, [join(root, 'node_modules/vite-plus/dist/bin.js'), 'run', 'build'], root)
            const packDirectory = join(directory, 'pack')
            await mkdir(packDirectory)
            run('bun', ['pm', 'pack', '--destination', packDirectory, '--ignore-scripts'], packageDirectory)
            const archives = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'))
            assert.equal(archives.length, 1, 'Expected exactly one packed archive')
            tarball = join(packDirectory, archives[0]!)
        }
        const before = createHash('sha256')
            .update(await readFile(tarball))
            .digest('hex')
        const entries = run('tar', ['-tzf', tarball], directory).trim().split(/\r?\n/u)
        expect(
            entries.every((entry) => /^package\/(?:dist(?:\/.*)?|package.json|README.md|LICENSE)$/u.test(entry)),
        ).toBe(true)
        expect(entries.some((entry) => entry.endsWith('.map'))).toBe(false)
        expect(entries).toContain('package/LICENSE')
        const license = run('tar', ['-xOf', tarball, 'package/LICENSE'], directory)
        expect(license).toBe(await readFile(join(root, 'LICENSE'), 'utf8'))
        expect(license.split(/\r?\n/u)[2]).toBe('Copyright (c) 2026 Liry24')
        const packedManifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json'], directory)) as {
            name: string
            version: string
            license?: string
        }
        expect(packedManifest.name).toBe('better-notif')
        expect(packedManifest.version).toEqual(expect.any(String))
        expect(packedManifest.license).toBe('MIT')
        const archiveName = `better-notif-${before}.tgz`
        await copyFile(tarball, join(directory, archiveName))
        const version = process.env.NOTIFICATION_BETTER_AUTH_VERSION ?? '1.7.0'
        const manager = process.env.NOTIFICATION_PACKAGE_MANAGER ?? 'bun'
        assert(['bun', 'npm', 'pnpm'].includes(manager), 'Unsupported consumer package manager')
        await writeFile(
            join(directory, 'package.json'),
            JSON.stringify({
                name: 'notification-consumer',
                private: true,
                type: 'module',
                dependencies: {
                    'better-notif': `file:./${archiveName}`,
                    'better-auth': version,
                    '@better-auth/core': version,
                    zod: '^4.5.4',
                    valibot: '^1.5.0',
                },
                devDependencies: { typescript: '^7.0.2', '@types/node': '^26.6.3', auth: '1.7.7' },
            }),
        )
        // Bun can share file-tarball cache entries across independent consumers.
        run(manager, ['install', '--ignore-scripts'], directory, {
            ...process.env,
            BUN_INSTALL_CACHE_DIR: join(directory, 'bun-cache'),
        })
        const installedDirectory = join(directory, 'node_modules/better-notif')
        const installedManifest: unknown = JSON.parse(await readFile(join(installedDirectory, 'package.json'), 'utf8'))
        expect(installedManifest).toEqual(packedManifest)
        const installedAuth = JSON.parse(
            await readFile(join(directory, 'node_modules/better-auth/package.json'), 'utf8'),
        ) as { version: string }
        const installedCore = JSON.parse(
            await readFile(join(directory, 'node_modules/@better-auth/core/package.json'), 'utf8'),
        ) as { version: string }
        expect(installedAuth.version).toBe(installedCore.version)
        if (/^\d+\.\d+\.\d+$/u.test(version)) assert.equal(installedAuth.version, version)
        for (const entry of entries.filter((name) => !name.endsWith('/') && name !== 'package/dist')) {
            const relativePath = entry.slice('package/'.length)
            const installedPath = resolve(installedDirectory, relativePath)
            assert(installedPath.startsWith(resolve(installedDirectory) + sep))
            const packedBytes = execFileSync('tar', ['-xOf', tarball, entry], { cwd: directory })
            if (relativePath.startsWith('dist/'))
                assert.doesNotMatch(packedBytes.toString('utf8'), /(?:sourceMappingURL|declarationMap)\s*[:=]/u)
            expect(await readFile(installedPath), `Installed ${relativePath} must match the archive`).toEqual(
                packedBytes,
            )
        }
        await writeFile(
            join(directory, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    target: 'ES2022',
                    types: ['node'],
                    strict: true,
                    skipLibCheck: true,
                    noEmit: true,
                    allowImportingTsExtensions: true,
                },
                include: ['consumer.ts', 'client.ts'],
            }),
        )
        await writeFile(
            join(directory, 'consumer.ts'),
            `import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { getMigrations } from 'better-auth/db/migration'
import { notification, type NotificationFields, type NotificationKinds } from 'better-notif'
import { notificationClient } from 'better-notif/client'
import * as z from 'zod'
import * as v from 'valibot'
export type IsAny<T> = 0 extends 1 & T ? true : false
export type Concrete<T> = IsAny<T> extends true ? false : unknown extends T ? false : true
export type Equal<T, U> = (<V>() => V extends T ? 1 : 2) extends <V>() => V extends U ? 1 : 2 ? true : false
function assertType<T extends true>(proof: T) { return proof }
function configure<const F extends NotificationFields, const K extends NotificationKinds<F>>(fields: F, kinds: K) {
  return notification({ schema: { notification: { additionalFields: fields } }, kinds })
}
assertType<Concrete<typeof notification>>(true)
assertType<Concrete<ReturnType<typeof notification>>>(true)
assertType<Concrete<typeof notificationClient>>(true)
assertType<Concrete<ReturnType<typeof notificationClient>>>(true)
type GenericClientPlugin = ReturnType<typeof notificationClient>
assertType<Equal<GenericClientPlugin['id'], 'notification'>>(true)
assertType<Concrete<ReturnType<GenericClientPlugin['getAtoms']>>>(true)
assertType<Concrete<ReturnType<GenericClientPlugin['getActions']>>>(true)
assertType<Concrete<ReturnType<ReturnType<GenericClientPlugin['getActions']>['notification']['createQuery']>>>(true)
const requestedNode = process.env.NOTIFICATION_NODE_VERSION
if (requestedNode) assert(requestedNode.includes('.') ? process.versions.node === requestedNode : process.versions.node.startsWith(requestedNode + '.'))
const additionalFields = {
  amount: { type: 'number', required: false, validator: { input: z.string().transform(Number) } },
  slug: { type: 'string', required: false, validator: { input: v.pipe(v.string(), v.trim()) } },
  summary: { type: 'string', required: false, validator: { output: z.string().transform((value) => value.length) } },
  label: { type: 'string', required: false },
  metadata: { type: 'json', required: false, validator: { input: z.object({ values: z.array(z.string()) }) } },
  timestamps: { type: 'string[]', required: false },
  dueAt: { type: 'date', required: false },
  displayDate: { type: 'date', required: false, validator: { output: z.date().transform((date) => date.toISOString()) } },
  computedDate: { type: 'string', required: false, validator: { output: v.pipe(v.string(), v.transform((value) => new Date(value))) } },
} as const
const kinds = { invoice: { required: ['amount'] }, post: { required: ['slug'] } } as const
const database = new DatabaseSync(':memory:')
export const auth = betterAuth({ database, baseURL: 'http://localhost:3000', secret: 'packed-consumer-secret-more-than-thirty-two-characters', emailAndPassword: { enabled: true }, advanced: { disableOriginCheck: false, disableCSRFCheck: false }, plugins: [notification({ schema: { notification: { additionalFields } }, kinds, filterableFields: ['amount', 'slug'], loadContext: () => ({ scope: 'example' }), onNotificationCreated: ({ notification: item, recipient }) => { assertType<Concrete<typeof item>>(true); assertType<Concrete<typeof recipient>>(true); assertType<Equal<typeof recipient.context, { scope: string } | undefined>>(true); if (item.schemaStatus === 'current' && item.type === 'invoice') { assertType<Equal<typeof item.amount, number>>(true); assertType<Equal<typeof item.summary, number | null>>(true); const amount: number = item.amount; assert.equal(amount, 42) } } })], logger: { disabled: true } })
assertType<Concrete<typeof auth.api.sendNotification>>(true)
assertType<Concrete<Parameters<typeof auth.api.sendNotification>[0]>>(true)
assertType<Concrete<Awaited<ReturnType<typeof auth.api.sendNotification>>>>(true)
assertType<Concrete<typeof auth.api.listUserNotifications>>(true)
await (await getMigrations(auth.options)).runMigrations()
const registered = await auth.api.signUpEmail({ body: { name: 'Consumer', email: 'consumer@example.com', password: 'a-long-consumer-password' }, asResponse: true })
assert.equal(registered.status, 200)
const signup = await registered.json() as { user: { id: string } }
const iso = '2026-01-01T00:00:00.000Z'
const precise = '2026-01-01T00:00:00.123456Z'
const strings = [iso, precise, '2026-01-01T09:00:00+09:00']
const body = { recipients: [signup.user.id], notification: { type: 'invoice' as const, title: iso, amount: '42', label: precise, metadata: { values: strings }, timestamps: strings, dueAt: new Date(iso), displayDate: new Date(iso), computedDate: iso, actions: [{ id: iso, label: precise, href: '/example' }] }, idempotencyKey: 'packed' }
assert.equal((await auth.api.sendNotification({ body })).results[0]?.status, 'created')
assert.equal((await auth.api.sendNotification({ body })).results[0]?.status, 'duplicate')
const cookie = registered.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
const response = await auth.handler(new Request('http://localhost:3000/api/auth/notification/list', { headers: { cookie } }))
assert.equal(response.status, 200)
assert.equal((await response.json()).notifications[0].amount, 42)
const packedClient = createAuthClient({ baseURL: 'http://localhost:3000', plugins: [notificationClient<typeof auth>()], fetchOptions: { customFetchImpl: (input, init) => {
  const request = new Request(input, init)
  request.headers.set('cookie', cookie)
  request.headers.set('origin', 'http://localhost:3000')
  return auth.handler(request)
} } })
let transportCallbacks = 0
const responseSchema = z.object({ notifications: z.array(z.object({ label: z.string(), dueAt: z.date(), displayDate: z.string(), computedDate: z.date(), metadata: z.object({ values: z.array(z.string()) }) }).passthrough()) }).passthrough()
await packedClient.notification.list({ query: {} }, { output: responseSchema, onSuccess: ({ data }) => { responseSchema.parse(data); transportCallbacks++ } })
assert.equal(transportCallbacks, 1)
const invoiceView = packedClient.notification.createQuery({ fields: { amount: 42 }, type: 'invoice' })
assertType<Concrete<typeof invoiceView>>(true)
assertType<Concrete<typeof packedClient.notification.createQuery>>(true)
await invoiceView.refetch()
assert.equal(invoiceView.notifications.get().data?.total, 1)
const transported = invoiceView.notifications.get().data!.notifications[0]!
if (transported.schemaStatus === 'current') {
  assertType<Equal<typeof transported.label, string | null>>(true)
  assertType<Equal<typeof transported.metadata, { values: string[] } | null>>(true)
  assertType<Equal<typeof transported.timestamps, string[] | null>>(true)
  assertType<Equal<typeof transported.dueAt, Date | null>>(true)
  assertType<Equal<typeof transported.displayDate, string | null>>(true)
  assertType<Equal<typeof transported.computedDate, Date | null>>(true)
}
assert.equal(transported.schemaStatus, 'current')
assert.equal(transported.label, precise)
assert.deepEqual(transported.metadata, { values: strings })
assert.deepEqual(transported.timestamps, strings)
assert.deepEqual(transported.actions, body.notification.actions)
assert.deepEqual(transported.dueAt, new Date(iso))
assert.deepEqual(transported.computedDate, new Date(iso))
assert.equal(transported.displayDate, iso)
assert(transported.createdAt instanceof Date)
assert.equal(invoiceView.unreadCount.get().data?.count, 1)
invoiceView.dispose()
const page = await auth.api.listUserNotifications({ query: { userIds: [signup.user.id] } })
const item = page.notifications[0]!
assertType<Concrete<typeof page>>(true)
assertType<Concrete<typeof item>>(true)
if (item.schemaStatus === 'current' && item.type === 'invoice') { assertType<Equal<typeof item.amount, number>>(true); assertType<Equal<typeof item.summary, number | null>>(true); const amount: number = item.amount; assert.equal(amount, 42) }
if (item.schemaStatus === 'legacy') { assertType<Equal<typeof item.amount, unknown>>(true) }
await assert.rejects(auth.api.sendNotification({ body: { ...body, idempotencyKey: 'bad', notification: { type: 'post', title: 'Bad', slug: 123 } } } as any))
const post = await auth.api.sendNotification({ body: { ...body, idempotencyKey: 'post', notification: { type: 'post', title: 'Post', slug: ' hello ' } } })
assert.equal(post.results[0]?.status, 'created')
if (post.results[0]?.status === 'created' && post.results[0].notification.schemaStatus === 'current' && post.results[0].notification.type === 'post') assert.equal(post.results[0].notification.slug, 'hello')
const removed = await auth.api.deleteUserNotifications({ body: { userIds: [signup.user.id] } })
assert.equal(removed.results.length, 2)
assert(removed.results.every((result) => result.status === 'deleted'))
if (false) {
  const configuredAuth = betterAuth({ plugins: [configure(additionalFields, kinds)] })
  assertType<Concrete<typeof configuredAuth.api.sendNotification>>(true)
  assertType<Concrete<Parameters<typeof configuredAuth.api.sendNotification>[0]>>(true)
  // @ts-expect-error Generic configuration factories preserve closed kinds.
  await configuredAuth.api.sendNotification({ body: { ...body, notification: { type: 'unknown', title: 'Invalid' } } })
  // @ts-expect-error Writes consume schema input, not transformed output.
  await auth.api.sendNotification({ body: { ...body, notification: { type: 'invoice', title: 'Bad', amount: 42 } } })
  // @ts-expect-error Notification kinds are closed when schemas are configured.
  await auth.api.sendNotification({ body: { ...body, notification: { type: 'unknown', title: 'Bad' } } })
}
database.close()
`,
        )
        await writeFile(
            join(directory, 'client.ts'),
            `import { createAuthClient } from 'better-auth/client'
import { notificationClient } from 'better-notif/client'
import type { auth, Concrete, Equal } from './consumer.ts'
function assertType<T extends true>(proof: T) { return proof }
export const client = createAuthClient({ plugins: [notificationClient<typeof auth>()] })
assertType<Concrete<typeof client.notification.list>>(true)
assertType<Concrete<Parameters<typeof client.notification.list>[0]>>(true)
assertType<Concrete<typeof client.notification.setRead>>(true)
assertType<Concrete<ReturnType<typeof client.notification.createQuery>>>(true)
const view = client.notification.createQuery({ fields: { amount: 42 }, read: 'unread' })
const queryItem = view.notifications.get().data?.notifications[0]
assertType<Concrete<typeof queryItem>>(true)
if (queryItem?.schemaStatus === 'current' && queryItem.type === 'invoice') { assertType<Equal<typeof queryItem.amount, number>>(true); const amount: number = queryItem.amount; void amount }
// @ts-expect-error Filters use native number values rather than validator input strings.
client.notification.createQuery({ fields: { amount: '42' } })
// @ts-expect-error Unknown additional fields cannot be queried.
client.notification.createQuery({ fields: { missing: 'value' } })
void client.notification.list({ query: {} }).then(({ data }) => {
  assertType<Concrete<typeof data>>(true)
  const item = data?.notifications[0]
  assertType<Concrete<typeof item>>(true)
  if (item?.schemaStatus === 'current' && item.type === 'invoice') {
    assertType<Equal<typeof item.amount, number>>(true)
    assertType<Equal<typeof item.summary, number | null>>(true)
    const amount: number = item.amount
    // @ts-expect-error Reads expose the transformed schema output.
    const input: string = item.amount
    void amount; void input
  }
})
const state = client.useNotifications.get().data?.notifications[0]
assertType<Concrete<typeof state>>(true)
if (state?.schemaStatus === 'current' && state.type === 'post') { assertType<Equal<typeof state.slug, string>>(true); assertType<Equal<typeof state.amount, number | null>>(true); const slug: string = state.slug; void slug }
void client.notification.setRead({ id: 'one', read: true }).then((response) => { assertType<Concrete<typeof response>>(true) })
void client.notification.deleteMany({ ids: ['one'] })
// @ts-expect-error Trusted target APIs are not client endpoints.
void client.listUserNotifications({ query: { userIds: 'all' } })
void client.notification.list({ query: { limit: 20 } })
void client.notification.setRead({ id: 'one', read: true })
void client.notification.refetch()
// @ts-expect-error The send API is server-only.
void client.sendNotification({})
`,
        )
        run(process.execPath, [join(directory, 'node_modules/typescript/bin/tsc'), '--noEmit'], directory)
        // Test the published JavaScript runtime without requiring Node's newer TypeScript loader.
        run(
            'bun',
            ['build', 'consumer.ts', '--target', 'node', '--packages', 'external', '--outfile', 'consumer.mjs'],
            directory,
        )
        const runtimeVersion = process.env.NOTIFICATION_NODE_VERSION
        if (runtimeVersion) {
            assert(/^(?:22|\d+\.\d+\.\d+)$/u.test(runtimeVersion), 'Expected an exact Node version or latest Node 22')
            run('npm', ['exec', '--yes', '--package=node@' + runtimeVersion, '--', 'node', 'consumer.mjs'], directory)
        } else {
            run(process.execPath, ['consumer.mjs'], directory)
        }
        await writeFile(
            join(directory, 'auth.ts'),
            `import { betterAuth } from 'better-auth'
import { notification } from 'better-notif'
export const auth = betterAuth({ plugins: [notification({ schema: { notification: { additionalFields: {
    postId: { type: 'string', required: false }, score: { type: 'number', required: true },
} } }, kinds: { post: { required: ['postId'] } } })] })
`,
        )
        run(
            process.execPath,
            [
                join(directory, 'node_modules/auth/dist/index.mjs'),
                'generate',
                '--config',
                './auth.ts',
                '--adapter',
                'drizzle',
                '--dialect',
                'sqlite',
                '--output',
                './generated-schema.ts',
                '--yes',
            ],
            directory,
        )
        const generated = await readFile(join(directory, 'generated-schema.ts'), 'utf8')
        expect(generated).toMatch(/postId:\s*text\(["']post_id["']\)/u)
        expect(generated).toMatch(/score:\s*(?:integer|real|numeric)\(["']score["']\)\.notNull\(\)/u)
        expect(generated).not.toMatch(/postId:[^\n]*notNull/u)
        run('bun', ['build', 'client.ts', '--target', 'browser', '--outdir', 'bundle'], directory)
        const bundle = await readFile(join(directory, 'bundle/client.js'), 'utf8')
        expect(bundle).not.toMatch(
            /createAuthEndpoint|createNotificationModel|Notification hook failed|node:sqlite|node:buffer/u,
        )
        const after = createHash('sha256')
            .update(await readFile(tarball))
            .digest('hex')
        expect(after).toBe(before)
    } finally {
        // Only remove the exact temporary directory created by this test.
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
        assert(directory.startsWith(join(tmpdir(), 'notification-consumer-')))
        await rm(directory, { recursive: true, force: true })
    }
})
