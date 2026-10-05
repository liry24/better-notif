import type { DBFieldAttribute } from '@better-auth/core/db'
import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { createAuthClient as reactClient } from 'better-auth/react'
import { createAuthClient as vueClient } from 'better-auth/vue'
import * as v from 'valibot'
import * as z from 'zod'

import { notificationClient } from '../packages/better-notif/src/client'
import { notification } from '../packages/better-notif/src/index'
import type { NotificationInput } from '../packages/better-notif/src/index'

const auth = betterAuth({ plugins: [notification({ loadContext: () => ({ organizationIds: ['org-1'] }) })] })
const client = createAuthClient({ plugins: [notificationClient()] })
const react = reactClient({ plugins: [notificationClient()] })
const vue = vueClient({ plugins: [notificationClient()] })
const fields = {
    amount: { type: 'number', required: false, validator: { input: z.string().transform(Number) } },
    slug: { type: 'string', required: false, validator: { input: v.string() } },
    hidden: { type: 'string', returned: false, input: false, defaultValue: 'internal' },
    priority: { type: 'number', defaultValue: 1 },
    source: { type: 'string' },
} as const satisfies Record<string, DBFieldAttribute>
const kinds = { invoice: { required: ['amount'] }, post: { required: ['slug'] } } as const
const typedAuth = betterAuth({
    plugins: [
        notification({
            schema: { notification: { additionalFields: fields } },
            kinds,
            filterableFields: ['amount', 'slug'],
            loadContext: () => ({ organizationId: 'org' }),
            onNotificationCreated({ notification: item, recipient }) {
                recipient.context?.organizationId.toUpperCase()
                if (item.schemaStatus === 'current' && item.type === 'invoice') {
                    item.amount.toFixed()
                    item.slug?.toUpperCase()
                    // @ts-expect-error Hooks receive transformed numbers.
                    item.amount.toUpperCase()
                }
                if (item.schemaStatus === 'current' && item.type === 'post') {
                    item.slug.toUpperCase()
                    // @ts-expect-error A field required only by another kind is nullable here.
                    item.amount.toFixed()
                }
                // @ts-expect-error Private fields are omitted from public results and callbacks.
                void item.hidden
            },
        }),
    ],
})
const typedClient = createAuthClient({ plugins: [notificationClient<typeof typedAuth>()] })
const typedReact = reactClient({ plugins: [notificationClient<typeof typedAuth>()] })
const typedVue = vueClient({ plugins: [notificationClient<typeof typedAuth>()] })
type Input = NotificationInput<typeof fields, typeof kinds>

export async function schemaTypeContracts() {
    const invoice: Input = { type: 'invoice', title: 'Invoice', amount: '12', source: 'app' }
    // @ts-expect-error Kind-specific required slug is missing.
    const missing: Input = { type: 'post', title: 'Post', source: 'app' }
    // @ts-expect-error Field validators determine input types.
    const wrongInput: Input = { type: 'invoice', title: 'Invoice', amount: 12, source: 'app' }
    // @ts-expect-error Configured kinds are closed on writes.
    const unknown: Input = { type: 'unknown', title: 'Unknown', source: 'app' }
    // @ts-expect-error Input false is respected.
    const hidden: Input = { ...invoice, hidden: 'injected' }
    // @ts-expect-error Globally required source is required on every kind.
    const commonMissing: Input = { type: 'invoice', title: 'Invoice', amount: '12' }
    void [missing, wrongInput, unknown, hidden, commonMissing]
    const sent = await typedAuth.api.sendNotification({
        body: {
            recipients: ['one'],
            idempotencyKey: 'key',
            notification: invoice,
            filter: ({ context }) => context?.organizationId === 'org',
        },
    })
    const item = sent.results[0]
    if (
        item?.status === 'created' &&
        item.notification.schemaStatus === 'current' &&
        item.notification.type === 'invoice'
    )
        item.notification.amount.toFixed()
    await typedAuth.api.sendNotification({
        body: {
            recipients: ['one'],
            idempotencyKey: 'key',
            // @ts-expect-error Factory endpoint inference preserves per-kind required fields.
            notification: { type: 'post', title: 'Invalid', source: 'app' },
        },
    })
    const list = await typedAuth.api.listUserNotifications({ query: { userIds: ['one'] } })
    const serverItem = list.notifications[0]
    if (serverItem?.schemaStatus === 'current' && serverItem.type === 'invoice') serverItem.amount.toFixed()
    if (serverItem?.schemaStatus === 'legacy') {
        // @ts-expect-error Historical fields cannot be assumed to match the current schema.
        serverItem.amount.toFixed()
    }
    const response = await typedClient.notification.list({ query: {} })
    await typedClient.notification.list({ query: { fields: { amount: 12 }, cursor: 'opaque-cursor' } })
    const view = typedClient.notification.createQuery({ fields: { slug: 'item' }, read: 'unread' })
    const viewed = view.notifications.get().data?.notifications[0]
    if (viewed?.schemaStatus === 'current' && viewed.type === 'invoice') viewed.amount.toFixed()
    // @ts-expect-error Private fields cannot be used in list filters.
    typedClient.notification.createQuery({ fields: { hidden: 'internal' } })
    // @ts-expect-error Filters consume native database types.
    typedClient.notification.createQuery({ fields: { amount: '12' } })
    // @ts-expect-error Cursor pagination replaces the former offset contract.
    typedClient.notification.createQuery({ offset: 20 })
    const clientItem = response.data?.notifications[0]
    if (clientItem?.schemaStatus === 'current' && clientItem.type === 'post') clientItem.slug.toUpperCase()
    const changed = await typedClient.notification.setRead({ id: 'one', read: false })
    if (changed.data?.notification.schemaStatus === 'current' && changed.data.notification.type === 'invoice')
        changed.data.notification.amount.toFixed()
    const batch = await typedClient.notification.setReadMany({ ids: ['one'], read: true })
    const mutation = batch.data?.results[0]
    if (
        mutation?.status === 'updated' &&
        mutation.notification.schemaStatus === 'current' &&
        mutation.notification.type === 'invoice'
    )
        mutation.notification.amount.toFixed()
    await typedClient.notification.deleteMany({ ids: ['one'] })
    // @ts-expect-error Recipient HTTP APIs cannot accept arbitrary users.
    await typedClient.notification.deleteMany({ ids: ['one'], userIds: 'all' })
    // @ts-expect-error Trusted server maintenance is absent from client inference.
    await typedClient.deleteUserNotifications({ userIds: 'all' })
    // @ts-expect-error Trusted server listing is absent from client inference.
    await typedClient.listUserNotifications({ query: { userIds: 'all' } })
    // @ts-expect-error Server maintenance requires an explicit target.
    await typedAuth.api.deleteUserNotifications({ body: {} })
    const reactItem = typedReact.useNotifications().data?.notifications[0]
    const vueItem = typedVue.useNotifications().value.data?.notifications[0]
    const atomItem = typedClient.useNotifications.get().data?.notifications[0]
    if (reactItem?.schemaStatus === 'current' && reactItem.type === 'invoice') reactItem.amount.toFixed()
    if (vueItem?.schemaStatus === 'current' && vueItem.type === 'invoice') vueItem.amount.toFixed()
    if (atomItem?.schemaStatus === 'current' && atomItem.type === 'invoice') {
        atomItem.amount.toFixed()
        // @ts-expect-error Atom data has the transformed number type.
        atomItem.amount.toUpperCase()
    }
}

export function typeContracts() {
    void auth.api.sendNotification({
        body: {
            recipients: ['one-user'],
            idempotencyKey: 'event',
            notification: { type: 'test', title: 'Test' },
            filter: ({ user, accounts, sessions, context }) =>
                user.emailVerified &&
                accounts.length >= 0 &&
                sessions.length >= 0 &&
                context?.organizationIds.includes('org-1') === true,
        },
    })
    // @ts-expect-error Missing required idempotency key.
    void auth.api.sendNotification({ body: { recipients: 'all', notification: { type: 'test', title: 'Test' } } })
    // @ts-expect-error Server-only delivery must not be inferred on the browser client.
    void client.sendNotification({ body: {} })
    void client.notification.list({ query: { read: 'unread', archived: 'unarchived', limit: 20 } })
    void client.notification.setRead({ id: 'notification', read: true })
    void client.notification.setArchived({ id: 'notification', archived: false })
    void client.notification.refetch({ read: 'all' })
    // @ts-expect-error State mutations require a boolean.
    void client.notification.setRead({ id: 'notification', read: 'yes' })
    // @ts-expect-error Only the supported filters are accepted.
    void client.notification.list({ query: { archived: 'deleted' } })
    const reactState = react.useNotifications()
    const vueState = vue.useNotifications()
    reactState.data?.notifications[0]?.actions[0]?.href?.toUpperCase()
    vueState.value.data?.notifications[0]?.title.toUpperCase()
    return { reactState, vueState }
}
