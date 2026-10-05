# better-notif

Notifications for Better Auth with typed application fields, read/unread state, archiving, deletion, and application-owned delivery hooks.

```sh
npm install better-notif
```

The first npm publication is pending. For current builds, install a CI package preview or a local tarball. Supported runtime and Better Auth ranges are declared in the [package manifest](packages/better-notif/package.json). SQLite is the tested database.

## Register the plugin

```ts
import { betterAuth } from 'better-auth'
import { notification } from 'better-notif'
import * as z from 'zod'

export const auth = betterAuth({
  plugins: [
    notification({
      types: {
        'post.published': {
          fields: {
            postId: { type: 'string', validate: z.string().min(1) },
          },
        },
        'invoice.ready': {
          fields: {
            amount: { type: 'number', validate: z.string().transform(Number) },
          },
        },
      },
      list: { filters: ['postId', 'amount'] },
    }),
  ],
})
```

Declare fields alongside their notification type. `type` selects native database storage; `validate` accepts Zod, Valibot, or another Standard Schema validator. No schema introspection, converter, helper import, or extra ORM is required. Synchronous and asynchronous validators run once per send before recipient processing. Their transformed values must fit the declared storage type.

Fields are required within their type unless `required: false` or `defaultValue` allows omission. Different types share one notification table; type-local columns are physically nullable so unrelated notifications can omit them. A notification cannot supply another type's fields. Optional values return `null`; unrelated fields are absent from current results. Put fields used by every type in the root `fields` option. Omit `types`, or use `{}`, to accept arbitrary type strings.

Generate and apply the database schema using the [Better Auth CLI](https://better-auth.com/docs/concepts/cli):

```sh
npx auth@latest generate
# Built-in SQLite adapter:
npx auth@latest migrate
```

For an ORM adapter, apply the generated schema through its migration tooling. Registration, migration, and the separate browser client plugin are the normal integration steps. The unique `(userId, idempotencyKey)` index is required for concurrent send safety.

## Send from your server

```ts
const result = await auth.api.sendNotification({
  body: {
    recipients: ['user-1'], // One or more IDs, or 'all'.
    idempotencyKey: 'post:123:published',
    notification: {
      type: 'post.published',
      title: 'Your post is ready',
      postId: '123',
      actions: [{ id: 'view', label: 'View post', href: '/posts/123' }],
    },
  },
})
```

`sendNotification` is server-only, with no HTTP route or browser client method. Inputs, results, callbacks, and client views infer your fields. For `invoice.ready`, `amount` is a string on input and a number after validation.

Results contain `created`, `duplicate`, `skipped`, or `failed` per recipient. A duplicate returns the saved notification without replaying lifecycle hooks. Reusing a key with different validated, explicitly supplied content returns `NOTIFICATION_IDEMPOTENCY_CONFLICT`. Generated defaults and adapter transforms are excluded from comparison; the first saved values are retained. JSON object key order does not matter.

Each call scans at most 100 recipients. Explicit audiences accept up to 10,000 IDs, deduplicated and sorted. Continue with `limit` and `nextCursor`, keeping other inputs consistent. Retry failed IDs separately without a cursor. Cursors reflect live data; save an audience in your application when you need a fixed snapshot.

`filter({ user, accounts, sessions, context })` selects recipients asynchronously. `loadContext` adds application-owned context. Related data loads only when a filter, context loader, creation policy, or creation hook needs it. An after-only creation hook loads it after persistence. Duplicates skip filtering and lifecycle hooks; a configured creation policy still loads context and rechecks access. Account credentials and recipient session tokens are excluded. Context is not persisted or sent to the browser.

## Browser integration

```ts
import { createAuthClient } from 'better-auth/react' // Also /vue or /client.
import { notificationClient } from 'better-notif/client'
import type { auth } from './auth'

export const authClient = createAuthClient({
  plugins: [notificationClient<typeof auth>()],
})

const response = await authClient.notification.list({ query: { limit: 20 } })
const item = response.data?.notifications[0]
if (item?.schemaStatus === 'current' && item.type === 'post.published') {
  item.postId.toUpperCase()
}

await authClient.notification.setRead({ id: 'notification-id', read: true })
await authClient.notification.setRead({ id: 'notification-id', read: false })
await authClient.notification.setArchived({ id: 'notification-id', archived: true })
await authClient.notification.delete({ id: 'notification-id' })
await authClient.notification.setReadMany({ ids: ['one', 'two'], read: true })
await authClient.notification.setArchivedMany({ ids: ['one', 'two'], archived: false })
await authClient.notification.deleteMany({ ids: ['one', 'two'] })
```

Every browser operation requires a session and scopes database queries to its user. Foreign IDs behave like missing IDs. Bulk operations accept up to 100 IDs and can partially succeed.

`list` returns `{ notifications, total, nextCursor, hasMore, hook }`, ordered by creation time and ID descending. Pass `nextCursor` as `cursor` with the same filters to continue. Filters include `type`, `read: 'all' | 'read' | 'unread'`, `archived: 'all' | 'archived' | 'unarchived'`, and `fields: { postId: '123' }`. They apply before the page limit; `total` counts all matching records. The default is 20 unarchived notifications.

Field equality filters must be enabled in `list.filters` and use native storage types. Dates also accept ISO strings over HTTP. Private fields, JSON/array fields, and fields with adapter transforms cannot be enabled. `unreadCount({ query: { type, fields, archived } })` returns `{ count, hook }`, shares list access and filters, and always counts unread records. It excludes archived records by default.

React and Vue expose `useNotifications()` and `useUnreadNotificationCount()`. Vanilla clients expose subscribable atoms with those names. For independent views, create one query instance per view:

```ts
const inbox = authClient.notification.createQuery({ read: 'unread' })
const post = authClient.notification.createQuery({ fields: { postId: '123' }, limit: 10 })
await post.refetch()
const page = post.notifications.get().data
await post.nextPage()
await post.resetPage()
post.dispose()
inbox.dispose()
```

Instances expose `notifications` and `unreadCount` Nanostores atoms, a stable query `key`, and independent filters, pages, and errors. Release subscriptions and call `dispose()` when a view is removed. Mutations refresh active views; session changes clear views and discard previous-user responses. Refresh server arrivals with the instance's `refetch()` or `authClient.notification.refetch()` for the default view. No polling or push connection is installed; SSR subscriptions do not fetch automatically.

The client preserves strings exactly, including ISO-formatted strings inside JSON/arrays, and restores actual server `Date` values. Notification responses carry `x-better-notif-date-paths` while retaining their ordinary JSON body. Metadata is applied before output validation, callbacks, and query updates. Other auth routes and errors retain the caller's parser. Proxies must preserve the header; it is exposed for browser CORS access. Custom hooks changing response values must run before this plugin's after hook.

The ASCII metadata `{ v: 1, paths: string[][] }` is limited to 6 KiB. `*` selects array elements with dates or `null` at that path, skipping absent branches, so ordinary 100-record responses fit. Missing/invalid metadata fails explicitly. Excessive date fields return `NOTIFICATION_TRANSPORT_LIMIT`; reduce the page/batch size or returned fields. Completed writes remain saved: error bodies include `mutationResults` with IDs, statuses, hook outcomes, and continuation metadata for reconciliation.

## Access

Application authorization belongs in `access`; lifecycle work belongs in `hooks`.

```ts
notification({
  access: {
    create: ({ recipient }) => recipient.user.emailVerified,
    list: () => ({ where: [{ field: 'type', value: 'post.published' }] }),
    setRead: ({ session, record }) => record.userId === session?.user.id,
    setArchived: () => true,
    delete: () => false,
  },
})
```

Creation and mutation policies must return an explicit Boolean. `false`, invalid/missing returns, and thrown policies deny access. List access returns `false` or `{ where: [...] }`: at most 20 native scalar conditions using `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, or `in`. `in` accepts 1–100 strings/numbers. Every condition is ANDed with mandatory ownership and requested filters before pagination and counting. OR connectors, transformed columns, and unsupported values are rejected.

Omitted policies retain the plugin's intrinsic permissions: server-only creation and a recipient's own records. Application policies can further restrict these boundaries. Policies are rechecked on duplicate sends and unchanged state operations, including an insert race's winning record. Session enforcement and ownership cannot be overridden by a policy returning `true`.

Callback `session` comes from the recipient endpoint's session middleware. Creation and trusted maintenance use `session: null`; supplying headers does not authenticate a server-only send. Authorize your application caller before invoking those server APIs.

## Operations and hooks

`hooks.create`, `hooks.list`, `hooks.setRead`, `hooks.setArchived`, and `hooks.delete` each accept `before` and `after` callbacks. Normal completion continues the operation; hooks return no value. They do not return Boolean permission decisions.

```ts
notification({
  hooks: {
    create: {
      before: ({ changes }) => {
        // Validated values, before adapter transforms.
      },
      after: async ({ record, recipient, idempotencyKey }) => {
        await enqueueApplicationDelivery(record, recipient.context, idempotencyKey)
      },
    },
    setRead: {
      after: ({ record, previous, changes }) => {
        // record is the saved view; previous is the view before the change.
      },
    },
  },
})
```

Contexts include `operation`, `userId`, `headers`, and `session`. Creation also includes `recipient`, `idempotencyKey`, and validated `changes`; `record` is null before a new insert and present afterward. State callbacks receive `changes.readAt` or `changes.archivedAt`. Delete callbacks receive the deleted record's view. Mutation lifecycle callbacks include `previous`; creation uses `previous: null`.

`record` and `previous` retain the public notification view: output validators apply and `returned: false` fields are excluded. Creation `changes` contains public Standard Schema output before native adapter transforms and output validators. Callback copies isolate records, changes, session data, and headers from library operations. Opaque application `recipient.context` remains application-owned. Use field validators/transforms to change stored values.

Before hooks are awaited after access and may throw to prevent a write. After hooks are awaited after successful work; failure does not undo it. Results report `hook: 'completed' | 'failed' | 'skipped'`. A write with `hook: 'failed'` is saved; do not retry the write as if it failed. Lists/counts retain their successfully read data with `hook: 'failed'` when their after callback fails. Callback error details are not exposed or logged.

Normal duplicates and no-op state changes skip before/after callbacks. Before callbacks may run for a write attempt that loses a concurrent race; after callbacks run only for actual writes. The list callbacks also run for unread counts. Hooks have no automatic retry or guaranteed external delivery. Use your application's queue for durable delivery.

## Trusted server management

Server-only APIs support jobs targeting explicit users without a session cookie:

```ts
const page = await auth.api.listUserNotifications({
  query: { userIds: ['user-1'], filter: { type: 'post.published', read: 'unread' } },
})
await auth.api.setUserNotificationsRead({ body: { userIds: ['user-1'], read: true } })
await auth.api.setUserNotificationsArchived({ body: { userIds: ['user-1'], archived: false } })
await auth.api.deleteUserNotifications({
  body: { userIds: 'all', filter: { archived: 'archived', createdBefore: '2026-01-01' } },
})
const count = await auth.api.getUserUnreadNotificationCount({ query: { userIds: ['user-1'] } })
```

`userIds` is required: up to 100 IDs or explicit `'all'`. Listing/mutations also accept `ids`, `filter`, `limit`, and `cursor`. Filters are `type`, `read`, `archived`, `fields`, and `createdBefore`. Each call processes at most 100 records in ID order; continue with `nextCursor`. Mutation results are `updated`, `unchanged`, `deleted`, `not_found`, or `failed`. Failed IDs advance the cursor and need separate retries.

Maintenance bypasses application `access` policies; mutation lifecycle hooks still run. Trusted listing/counting bypass list hooks too. These APIs have no HTTP route; any wrapping application route owns its authorization. Deletion is physical and removes idempotency history. Sending the same key after deletion can create a new notification and run creation hooks again; there is no tombstone.

## Native storage and retained data

Field declarations retain Better Auth's `DBFieldAttribute` settings: `input`, `returned`, `defaultValue`, `fieldName`, references, indexes, uniqueness, `transform`, and advanced `validator.input`/`validator.output`. `validate` is the compact input-validator spelling; do not combine it with `validator.input`. For fields with native adapter transforms, public inference uses the storage type unless `validator.output` declares the public result. Use `schema.modelName` to map the notification table. Reserved field names and conflicting physical columns are rejected at configuration time.

The same logical field may appear in several types if native storage metadata agrees. Its requiredness, defaults, and Standard Schema validators may differ by type. Common fields cannot be redeclared locally. Type-local defaults run only for that type; unrelated columns stay `null`. An omitted input uses native `defaultValue`, rather than executing a schema validator on `undefined`. Native uniqueness and references apply to the whole physical table.

There is no required JSON payload. Declare a native `json` field when needed. Its stored root must be a JSON-safe object/array, or `null` for an optional field; nested scalars are supported. Native scalar fields handle scalar roots and date fields accept `Date`. Output validators may return JSON-safe values or a valid `Date`.

Reads never replay input validators or defaults. `schemaStatus: 'legacy'` covers removed types, missing required values, incompatible native values, or failed output validation. Legacy fields are typed `unknown`; records remain manageable and private fields remain excluded. `schemaStatus: 'current'` enables narrowing by `type`, without claiming historical data passed today's input refinements. Use `validator.output` for explicit read validation; failures return `null` for that field with legacy status.

Column changes require application migrations/backfills. Native `modelName`/`fieldName` can map existing names. Records without a content fingerprint conflict when deduplicating a new send. Actions contain `id`, `label`, and optional root-relative or HTTP(S) `href`; execution and authorization belong to the app. Limits and URL rules are in [schema.ts](packages/better-notif/src/schema.ts).

## Development

Use the repository's pinned package manager and local Vite+ tooling:

```sh
vp install --frozen-lockfile
vp run check
```

The minimum package runtime is exercised with `better-sqlite3`; `node:sqlite` requires a newer Node release for `StatementSync.columns()`. Development tooling has its own engine requirement. See the manifests and CI for the exact tested versions and matrices. Consumer tests install a fresh tarball and verify the exact archive.

## License

[MIT](LICENSE), Copyright (c) 2026 Liry24.
