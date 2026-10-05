/* oxlint-disable typescript/no-unsafe-type-assertion -- Better Auth inference markers and its untyped client store require narrowing. */
import type { BetterAuthClientPlugin, BetterAuthOptions, ClientStore } from 'better-auth'
import type { AuthQueryState } from 'better-auth/client'
import { atom, onMount } from 'nanostores'
import type { WritableAtom } from 'nanostores'

import { createNotificationQuery } from './client-query'
import type { NotificationQuery } from './client-query'
import { notificationFetchPlugin } from './client-transport'
import type { NotificationFields, NotificationKinds } from './fields'
import type { notification } from './index'
import type { NotificationListQuery } from './schema'

export type { NotificationAction, NotificationListQuery } from './schema'
export type { NotificationInput, NotificationFields, NotificationFieldFilters, NotificationKinds } from './fields'
export type { HookStatus, Notification, NotificationList } from './types'
export type { NotificationQuery } from './client-query'

type DefaultAuth = { options: { plugins: [ReturnType<typeof notification<undefined, {}, {}>>] } }
type ServerPlugin<A extends { options: BetterAuthOptions }> = Extract<
    NonNullable<A['options']['plugins']>[number],
    { id: 'notification' }
>
type FieldsOf<A extends { options: BetterAuthOptions }> =
    ServerPlugin<A> extends {
        options: { schema?: { notification?: { additionalFields?: infer F extends NotificationFields } } }
    }
        ? F
        : {}
type KindsOf<A extends { options: BetterAuthOptions }> =
    ServerPlugin<A> extends {
        options: { kinds?: infer K extends NotificationKinds<FieldsOf<A>> }
    }
        ? K
        : {}

type ClientFetch = Parameters<NonNullable<BetterAuthClientPlugin['getAtoms']>>[0]
type NotificationView<A extends { options: BetterAuthOptions }> = ReturnType<
    typeof createNotificationQuery<FieldsOf<A>, KindsOf<A>>
>

// A named return type keeps generic factory extraction concrete in emitted declarations.
interface NotificationClientPlugin<A extends { options: BetterAuthOptions }> {
    id: 'notification'
    $InferServerPlugin: ServerPlugin<A>
    getAtoms: ($fetch: ClientFetch) => {
        $notificationSignal: WritableAtom<boolean>
        $notificationEpoch: WritableAtom<number>
        $notificationDefault: WritableAtom<NotificationView<A>>
        $notificationViews: WritableAtom<Set<NotificationView<A>>>
        notifications: NotificationQuery<FieldsOf<A>, KindsOf<A>>['notifications']
        unreadNotificationCount: NotificationQuery<FieldsOf<A>, KindsOf<A>>['unreadCount']
    }
    getActions: (
        $fetch: ClientFetch,
        store: ClientStore,
    ) => {
        notification: {
            refetch: (nextQuery?: NotificationListQuery<FieldsOf<A>>) => Promise<void>
            createQuery: (query?: NotificationListQuery<FieldsOf<A>>) => NotificationQuery<FieldsOf<A>, KindsOf<A>>
        }
    }
    atomListeners: { matcher: (path: string) => boolean; signal: '$notificationSignal' }[]
    fetchPlugins: (typeof notificationFetchPlugin)[]
}

export function notificationClient<
    A extends { options: BetterAuthOptions } = DefaultAuth,
>(): NotificationClientPlugin<A> {
    type F = FieldsOf<A>
    type K = KindsOf<A>
    type View = ReturnType<typeof createNotificationQuery<F, K>>
    return {
        id: 'notification',
        $InferServerPlugin: {} as ServerPlugin<A>,
        fetchPlugins: [notificationFetchPlugin],
        getAtoms($fetch) {
            const signal = atom(false)
            const epoch = atom(0)
            const view = createNotificationQuery<F, K>($fetch, signal, epoch, {})
            return {
                $notificationSignal: signal,
                $notificationEpoch: epoch,
                $notificationDefault: atom(view),
                $notificationViews: atom(new Set([view])),
                notifications: view.api.notifications,
                unreadNotificationCount: view.api.unreadCount,
            }
        },
        getActions($fetch, store) {
            const epoch = store.atoms.$notificationEpoch as WritableAtom<number>
            const signal = store.atoms.$notificationSignal as WritableAtom<boolean>
            const defaults = (store.atoms.$notificationDefault as WritableAtom<View>).get()
            const views = (store.atoms.$notificationViews as WritableAtom<Set<View>>).get()
            const session = store.atoms.session as WritableAtom<AuthQueryState<{ user: { id: string } }>>
            const reset = () => {
                epoch.set(epoch.get() + 1)
                for (const view of views) view.reset()
            }
            onMount(signal, () => {
                let userId: string | null | undefined
                return session.subscribe((state) => {
                    if (state.isPending) return
                    const next = state.data?.user.id ?? null
                    if (next !== userId) {
                        userId = next
                        reset()
                        store.notify('$notificationSignal')
                    }
                })
            })
            store.listen('$sessionSignal', () => {
                reset()
                store.notify('$notificationSignal')
            })
            return {
                notification: {
                    async refetch(nextQuery?: NotificationListQuery<F>) {
                        if (nextQuery) defaults.replace(nextQuery)
                        await defaults.api.refetch()
                    },
                    createQuery(query: NotificationListQuery<F> = {}): NotificationQuery<F, K> {
                        const view = createNotificationQuery<F, K>($fetch, signal, epoch, query, () => {
                            views.delete(view)
                        })
                        views.add(view)
                        return view.api
                    },
                },
            }
        },
        atomListeners: [
            {
                matcher: (path) =>
                    [
                        '/notification/set-read',
                        '/notification/set-archived',
                        '/notification/set-read-many',
                        '/notification/set-archived-many',
                        '/notification/delete',
                        '/notification/delete-many',
                    ].includes(path),
                signal: '$notificationSignal',
            },
        ],
    } satisfies BetterAuthClientPlugin
}
