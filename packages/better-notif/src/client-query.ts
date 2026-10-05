/* oxlint-disable typescript/no-unsafe-type-assertion -- Preserve Better Fetch's overloaded call signature around guarded callbacks. */
import type { BetterFetchOption } from '@better-fetch/fetch'
import type { BetterAuthClientPlugin } from 'better-auth'
import { useAuthQuery } from 'better-auth/client'
import type { AuthQueryAtom } from 'better-auth/client'
import type { WritableAtom } from 'nanostores'

import type { NotificationFields, NotificationTypes, NotificationFieldsOf } from './fields'
import type { NotificationListQuery } from './schema'
import type { NotificationList, NotificationCount } from './types'

type ClientFetch = Parameters<NonNullable<BetterAuthClientPlugin['getAtoms']>>[0]
export interface NotificationQuery<F extends NotificationFields = {}, K extends NotificationTypes = {}> {
    readonly key: string
    readonly notifications: AuthQueryAtom<NotificationList<F, K>>
    readonly unreadCount: AuthQueryAtom<NotificationCount>
    refetch: () => Promise<void>
    nextPage: () => Promise<void>
    resetPage: () => Promise<void>
    dispose: () => void
}

export function createNotificationQuery<F extends NotificationFields, K extends NotificationTypes>(
    $fetch: ClientFetch,
    signal: WritableAtom<boolean>,
    epoch: WritableAtom<number>,
    initial: NotificationListQuery<NotificationFieldsOf<F, K>>,
    onDispose: () => void = () => {},
) {
    let query = structuredClone(initial)
    let cursor = query.cursor
    let revision = 0
    let disposed = false
    const requests = new Map<string, number>()
    const scopedFetch = ((url: string, options?: BetterFetchOption) => {
        if (disposed) return Promise.resolve({ data: null, error: null })
        const started = epoch.get()
        const generation = revision
        const request = (requests.get(url) ?? 0) + 1
        requests.set(url, request)
        const current = () =>
            !disposed && started === epoch.get() && generation === revision && requests.get(url) === request
        return $fetch(url, {
            ...options,
            onSuccess: (event) => (current() ? options?.onSuccess?.(event) : undefined),
            onError: (event) => (current() ? options?.onError?.(event) : undefined),
            onRequest: (event) => (current() ? options?.onRequest?.(event) : undefined),
        }).catch((error: unknown) => {
            if (!current()) return { data: null, error: null }
            throw error
        })
    }) as ClientFetch
    const encodeFields = () => (query.fields === undefined ? {} : { fields: JSON.stringify(query.fields) })
    const notifications = useAuthQuery<NotificationList<F, K>>(signal, '/notification/list', scopedFetch, () => ({
        method: 'GET',
        query: { ...query, ...encodeFields(), cursor },
    }))
    const unreadCount = useAuthQuery<NotificationCount>(signal, '/notification/unread-count', scopedFetch, () => ({
        method: 'GET',
        query: { type: query.type, archived: query.archived, ...encodeFields() },
    }))
    const reset = () => {
        revision++
        // Reading .value avoids mounting inactive query atoms and starting unwanted requests.
        notifications.set({ ...notifications.value, data: null, error: null, isPending: true, isRefetching: false })
        unreadCount.set({ ...unreadCount.value, data: null, error: null, isPending: true, isRefetching: false })
    }
    const refetch = async () => {
        if (disposed) return
        await Promise.all([notifications.value.refetch(), unreadCount.value.refetch()])
    }
    const api: NotificationQuery<F, K> = {
        get key() {
            return JSON.stringify({
                type: query.type,
                read: query.read ?? 'all',
                archived: query.archived ?? 'unarchived',
                limit: query.limit ?? 20,
                cursor: query.cursor,
                fields:
                    query.fields === undefined
                        ? undefined
                        : Object.fromEntries(
                              Object.entries(query.fields).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
                          ),
            })
        },
        notifications,
        unreadCount,
        refetch,
        async nextPage() {
            const next = notifications.value.data?.nextCursor
            if (disposed || !next) return
            cursor = next
            reset()
            await refetch()
        },
        async resetPage() {
            cursor = undefined
            reset()
            await refetch()
        },
        dispose() {
            if (disposed) return
            disposed = true
            reset()
            onDispose()
        },
    }
    return {
        api,
        reset() {
            cursor = undefined
            reset()
        },
        replace(next: NotificationListQuery<NotificationFieldsOf<F, K>>) {
            query = structuredClone(next)
            cursor = query.cursor
            reset()
        },
    }
}
