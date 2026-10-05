export const notificationDateHeader = 'x-better-notif-date-paths'
export const notificationDateLimit = 6144

const routes = new Set([
    '/notification/list',
    '/notification/unread-count',
    '/notification/set-read',
    '/notification/set-archived',
    '/notification/set-read-many',
    '/notification/set-archived-many',
    '/notification/delete',
    '/notification/delete-many',
])

export function isNotificationPath(path: string | undefined): boolean {
    return path !== undefined && routes.has(path)
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object'
}

function safeKey(key: unknown): key is string {
    return typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key)
}

export function notificationDatePaths(value: unknown): string[][] {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? [[]] : []
    if (!record(value)) return []
    const children = Object.entries(value).map(([key, child]) => ({ key, paths: notificationDatePaths(child) }))
    if (!Array.isArray(value)) return children.flatMap(({ key, paths }) => paths.map((path) => [key, ...path]))
    // A full 100-item page exceeds the header budget without coalescing repeated array paths.
    // Only merge existing Date/null suffixes; missing batch-result branches are skipped, ISO strings never qualify.
    const merged = new Map<string, string[]>()
    for (const { paths } of children) {
        for (const path of paths) {
            if (path.includes('*')) continue
            const identity = JSON.stringify(path)
            if (merged.has(identity)) continue
            const compatible = value.every((child: unknown) => {
                let target = child
                for (const key of path) {
                    if (!record(target)) return false
                    if (!Object.hasOwn(target, key)) return true
                    target = target[key]
                }
                return target === null || target instanceof Date
            })
            if (compatible) merged.set(identity, path)
        }
    }
    return [
        ...[...merged.values()].map((path) => ['*', ...path]),
        ...children.flatMap(({ key, paths }) =>
            paths.filter((path) => !merged.has(JSON.stringify(path))).map((path) => [key, ...path]),
        ),
    ]
}

export function encodeNotificationDates(value: unknown): string {
    const metadata = JSON.stringify({ v: 1, paths: notificationDatePaths(value) }).replace(
        /[^\x20-\x7e]/gu,
        (characters) =>
            characters
                .split('')
                .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
                .join(''),
    )
    if (metadata.length > notificationDateLimit) throw new RangeError('Notification date metadata exceeds 6 KiB')
    return metadata
}

export function decodeNotificationDates(header: string | null): string[][] {
    if (header === null || header.length > notificationDateLimit || /[^\x20-\x7e]/u.test(header))
        throw new TypeError('Missing or oversized notification date metadata')
    const metadata: unknown = JSON.parse(header)
    if (!record(metadata) || metadata.v !== 1 || !Array.isArray(metadata.paths))
        throw new TypeError('Invalid notification date metadata')
    const paths: unknown[] = metadata.paths
    if (!paths.every((path): path is string[] => Array.isArray(path) && path.every(safeKey)))
        throw new TypeError('Invalid notification date path')
    return paths
}

export function parseNotificationTransport(text: string, paths: readonly (readonly string[])[]): unknown {
    let data: unknown = JSON.parse(text)
    const targets: { parent: Record<string, unknown> | undefined; key: string | undefined; date: Date }[] = []
    const seen = new Set<string>()
    function visit(
        value: unknown,
        path: readonly string[],
        resolved: string[],
        parent?: Record<string, unknown>,
        nullable = false,
    ) {
        const key = path[0]
        if (key !== undefined) {
            if (key === '*' && record(value) && Array.isArray(value)) {
                for (const [index, child] of value.entries())
                    visit(child, path.slice(1), [...resolved, String(index)], value, true)
                return
            }
            if (nullable && record(value) && !Object.hasOwn(value, key)) return
            if (!record(value) || !Object.hasOwn(value, key) || (Array.isArray(value) && !/^(0|[1-9]\d*)$/u.test(key)))
                throw new TypeError('Invalid notification date path')
            visit(value[key], path.slice(1), [...resolved, key], value, nullable)
            return
        }
        const identity = JSON.stringify(resolved)
        if (seen.has(identity)) throw new TypeError('Invalid notification date path')
        seen.add(identity)
        if (nullable && value === null) return
        if (typeof value !== 'string') throw new TypeError('Invalid notification date value')
        const date = new Date(value)
        if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
            throw new TypeError('Invalid notification date value')
        targets.push({ parent, key: resolved.at(-1), date })
    }
    for (const path of paths) {
        if (!path.every(safeKey)) throw new TypeError('Invalid notification date path')
        const count = targets.length
        visit(data, path, [])
        if (targets.length === count) throw new TypeError('Notification date path has no dates')
    }
    // Validate every path before applying any conversion.
    for (const { parent, key, date } of targets) {
        if (parent && key !== undefined)
            Object.defineProperty(parent, key, { value: date, enumerable: true, configurable: true, writable: true })
        else data = date
    }
    return data
}
