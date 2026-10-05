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
        expect(entries).toContain('package/LICENSE')
        expect(run('tar', ['-xOf', tarball, 'package/LICENSE'], directory)).toBe(
            await readFile(join(root, 'LICENSE'), 'utf8'),
        )
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
        const version = process.env.NOTIFICATION_BETTER_AUTH_VERSION ?? '1.7.7'
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
        for (const entry of entries.filter((name) => !name.endsWith('/') && name !== 'package/dist')) {
            const relativePath = entry.slice('package/'.length)
            const installedPath = resolve(installedDirectory, relativePath)
            assert(installedPath.startsWith(resolve(installedDirectory) + sep))
            const packedBytes = execFileSync('tar', ['-xOf', tarball, entry], { cwd: directory })
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
import { getMigrations } from 'better-auth/db/migration'
import { notification } from 'better-notif'
import * as z from 'zod'
import * as v from 'valibot'
const additionalFields = {
  amount: { type: 'number', required: false, validator: { input: z.string().transform(Number) } },
  slug: { type: 'string', required: false, validator: { input: v.pipe(v.string(), v.trim()) } },
} as const
const kinds = { invoice: { required: ['amount'] }, post: { required: ['slug'] } } as const
const database = new DatabaseSync(':memory:')
export const auth = betterAuth({ database, baseURL: 'http://localhost:3000', secret: 'packed-consumer-secret-more-than-thirty-two-characters', emailAndPassword: { enabled: true }, plugins: [notification({ schema: { notification: { additionalFields } }, kinds, onNotificationCreated: ({ notification: item }) => { if (item.schemaStatus === 'current' && item.type === 'invoice') { const amount: number = item.amount; assert.equal(amount, 42) } } })], logger: { disabled: true } })
await (await getMigrations(auth.options)).runMigrations()
const registered = await auth.api.signUpEmail({ body: { name: 'Consumer', email: 'consumer@example.com', password: 'a-long-consumer-password' }, asResponse: true })
assert.equal(registered.status, 200)
const signup = await registered.json() as { user: { id: string } }
const body = { recipients: [signup.user.id], notification: { type: 'invoice' as const, title: 'Packed', amount: '42' }, idempotencyKey: 'packed' }
assert.equal((await auth.api.sendNotification({ body })).results[0]?.status, 'created')
assert.equal((await auth.api.sendNotification({ body })).results[0]?.status, 'duplicate')
const cookie = registered.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
const response = await auth.handler(new Request('http://localhost:3000/api/auth/notification/list', { headers: { cookie } }))
assert.equal(response.status, 200)
assert.equal((await response.json()).notifications[0].amount, 42)
const page = await auth.api.listUserNotifications({ query: { userIds: [signup.user.id] } })
const item = page.notifications[0]!
if (item.schemaStatus === 'current' && item.type === 'invoice') { const amount: number = item.amount; assert.equal(amount, 42) }
await assert.rejects(auth.api.sendNotification({ body: { ...body, idempotencyKey: 'bad', notification: { type: 'post', title: 'Bad', slug: 123 } } } as any))
const post = await auth.api.sendNotification({ body: { ...body, idempotencyKey: 'post', notification: { type: 'post', title: 'Post', slug: ' hello ' } } })
assert.equal(post.results[0]?.status, 'created')
if (post.results[0]?.status === 'created' && post.results[0].notification.schemaStatus === 'current' && post.results[0].notification.type === 'post') assert.equal(post.results[0].notification.slug, 'hello')
const removed = await auth.api.deleteUserNotifications({ body: { userIds: [signup.user.id] } })
assert.equal(removed.results.length, 2)
assert(removed.results.every((result) => result.status === 'deleted'))
if (false) {
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
import type { auth } from './consumer.ts'
export const client = createAuthClient({ plugins: [notificationClient<typeof auth>()] })
void client.notification.list({ query: {} }).then(({ data }) => {
  const item = data?.notifications[0]
  if (item?.schemaStatus === 'current' && item.type === 'invoice') {
    const amount: number = item.amount
    // @ts-expect-error Reads expose the transformed schema output.
    const input: string = item.amount
    void amount; void input
  }
})
const state = client.useNotifications.get().data?.notifications[0]
if (state?.schemaStatus === 'current' && state.type === 'post') { const slug: string = state.slug; void slug }
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
        const runtimeVersion = process.env.NOTIFICATION_NODE_VERSION
        if (runtimeVersion) {
            assert(/^\d+\.\d+\.\d+$/u.test(runtimeVersion), 'Consumer Node version must be exact')
            run('npm', ['exec', '--yes', '--package=node@' + runtimeVersion, '--', 'node', 'consumer.ts'], directory)
        } else {
            run(process.execPath, ['consumer.ts'], directory)
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
        expect(bundle).not.toMatch(/createAuthEndpoint|Notification hook failed|node:sqlite/u)
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
