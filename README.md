# better-notif

Notifications for Better Auth: typed application fields, read/unread state, archiving, deletion, and application-owned delivery hooks.

The first npm release is pending. Install a local tarball or a CI package preview. Supported runtime and Better Auth ranges are declared in the [package manifest](packages/better-notif/package.json). SQLite is the tested database.

Node 22.0.0 or newer is supported with `better-sqlite3`. Using Better Auth with `node:sqlite` requires Node 22.16.0 or newer because that adapter uses `StatementSync.columns()`. Repository development uses Vite+, which requires Node 22.18.0 or a supported newer release.

## Register the plugin

```ts
import { betterAuth } from 'better-auth'
import { notification } from 'better-notif'
import * as z from 'zod'

export const auth = betterAuth({
  plugins: [
    notification({
      schema: {
        notification: {
          additionalFields: {
            postId: {
              type: 'string',
              required: false,
              validator: { input: z.string().min(1) },
            },
            amount: {
              type: 'number',
              required: false,
              validator: { input: z.string().transform(Number) },
            },
          },
        },
      },
      kinds: {
        'post.published': { required: ['postId'] },
        'invoice.ready': { required: ['amount'] },
      },
      filterableFields: ['postId', 'amount'],
    }),
  ],
})
```

`additionalFields` uses Better Auth's native `DBFieldAttribute` definitions. The example creates nullable `postId` and `amount` columns on one `notification` table. `kinds` lists fields required when sending each kind; it does not redefine their types. A field with `required: true` (the default) is required for every notification. Omit `kinds`, or pass `{}`, to accept arbitrary type strings.

Zod, Valibot, and other Standard Schema validators work through `validator.input`. Synchronous and asynchronous validators run before recipient processing. Their transformed values must fit the declared database field type. Native defaults, `input: false`, `returned: false`, `fieldName`, references, indexes, and adapter transforms retain their roles. Use `modelName` to rename the table. Built-in field names and duplicate column names are rejected.

There is no required `data` field or schema-conversion step. Add a native `json` field explicitly when your application needs one. JSON fields must contain JSON-safe values; native date fields accept `Date` objects.

Generate the database schema with the [official Better Auth CLI](https://better-auth.com/docs/concepts/cli):

```sh
bunx auth@1.7.7 generate
# Built-in SQLite adapter: apply the migration directly.
bunx auth@1.7.7 migrate
```

For Prisma or Drizzle, apply the generated schema through your ORM's migration tooling. The plugin requires its unique `(userId, idempotencyKey)` index for concurrent send safety. Registration, database migration, and the separate browser client plugin are the normal integration steps.

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

`sendNotification` is server-only: it has no HTTP route and is absent from the browser client. Input types, results, and hooks infer your additional fields. For `invoice.ready`, `amount` is required as a string on input and becomes a number after validation.

Results contain `created`, `duplicate`, `skipped`, or `failed` per recipient. A duplicate returns the saved notification without replaying the creation hook. Reusing a key with different validated, explicitly supplied content returns `NOTIFICATION_IDEMPOTENCY_CONFLICT`. Generated defaults and adapter transforms are excluded from the comparison; the first saved values are retained. JSON object key order does not matter.

Each call scans at most 100 recipients. `recipients` accepts up to 10,000 explicit IDs; IDs are deduplicated and sorted. Use `limit` and the returned `nextCursor` to continue, keeping the other inputs consistent. Retry failed recipient IDs separately without a cursor. Lists and cursors reflect live data, so save an explicit audience in your application when a fixed snapshot is needed.

`filter({ user, accounts, sessions, context })` can select recipients asynchronously. Add application data with `loadContext` on the plugin. Account/session queries run only when a filter, context loader, or creation hook needs them; creation-only hooks load them after persistence. Account credentials and session tokens are excluded; context is not persisted or sent to the browser. Existing duplicates skip context loading and filtering.

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

Every browser operation requires a session and scopes database queries to that user. Foreign IDs behave like missing IDs. Bulk operations accept up to 100 IDs and return an item result for each attempted ID; they can partially succeed.

Known client transport limitation: Better Auth's default decoder converts ISO-formatted strings into `Date` objects, including additional string fields and strings inside JSON fields. Exact string preservation needs to be resolved before the first release.

`list` returns `{ notifications, total, nextCursor, hasMore }`, ordered by creation time and ID descending. Pass `nextCursor` as `cursor` with the same filters to continue. Results reflect live data. Filters include `type`, `read: 'all' | 'read' | 'unread'`, `archived: 'all' | 'archived' | 'unarchived'`, and `fields: { postId: '123' }`. They apply before the page limit; `total` counts all matching records, including older unread entries. The default is 20 unarchived notifications.

`fields` permits equality checks only for explicitly configured `filterableFields`. Values use native database types; dates also accept ISO strings over HTTP. Private fields, JSON/array fields, and fields with adapter transforms cannot be enabled. `unreadCount({ query: { type, fields, archived } })` uses the same filters and always counts unread records; it excludes archived records by default.

React and Vue clients expose `useNotifications()` and `useUnreadNotificationCount()`. Vanilla clients expose subscribable atoms under the same names. These use the default shared view. For independent views, create one query instance per view:

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

Instances expose `notifications` and `unreadCount` as Nanostores atoms for direct subscriptions or framework bindings, plus a stable query `key`. Their filters, pages, and errors remain independent. Release subscriptions and call `dispose()` when a view is removed. Mutations refresh active views; session changes clear every view and discard previous-user responses. Refresh server-side arrivals explicitly with the instance's `refetch()` or `authClient.notification.refetch()` for the default view. No polling or push connection is installed, and SSR subscriptions do not fetch automatically.

Use Better Auth's `hooks.before` for application-specific permission checks on recipient mutation routes. Trusted server APIs require the caller's own authorization.

## Trusted server management

Use these server-only APIs for jobs operating on explicit users, without a session cookie:

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

`userIds` is required: up to 100 IDs or explicit `'all'`. Listing and mutations also accept `ids`, `filter`, `limit`, and `cursor`. Supported filters are `type`, `read`, `archived`, `fields`, and `createdBefore`. They process at most 100 records per call in ID order; continue with `nextCursor`. Mutation results are `updated`, `unchanged`, `deleted`, `not_found`, or `failed`. Failed IDs advance the cursor and need separate retries. These endpoints have no HTTP route; any application route wrapping them owns its authorization.

Deletion is physical. Deleting a notification also removes its idempotency record, so sending the same key again can create a notification and run the creation hook again. There is no deletion hook or tombstone.

## Hooks and retained data

| Option                  | Purpose                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `loadContext`           | Load application-owned recipient context for filtering and creation hooks.              |
| `onNotificationCreated` | Receive `{ notification, recipient, idempotencyKey }` after a successful insert.        |
| `onReadStateChanged`    | Receive `{ notificationId, userId, readAt }` after a read/unread transition.            |
| `onArchiveStateChanged` | Receive `{ notificationId, userId, archivedAt }` after an archive/unarchive transition. |

Hooks are awaited after successful writes. Duplicates and unchanged states skip them. A thrown hook leaves the write intact and reports `hook: 'failed'`; callback details are not exposed. Hooks have no automatic retry or guaranteed external delivery. Use your application's queue when durable email or other delivery is required.

Reads do not replay input validators or defaults. `schemaStatus: 'legacy'` identifies removed kinds, missing required values, incompatible native field values, or failed output validation. Legacy fields are typed as `unknown`; notifications remain readable and manageable, and private fields remain excluded. `schemaStatus: 'current'` permits narrowing by `type`. It is not a claim that old records were rechecked against today's input refinements. Use `validator.output` for explicit read validation and migrate retained records when refining their contract. Failed output validation returns `null` for that field with legacy status.

Adding, renaming, or removing columns requires an application migration and any necessary data backfill. Native `modelName` and `fieldName` map existing table/column names. Records without a content fingerprint cannot safely deduplicate a new send and report a conflict.

Actions contain `id`, `label`, and optional root-relative or HTTP(S) `href`. The app owns action execution and authorization. Limits and URL validation are defined in [schema.ts](packages/better-notif/src/schema.ts).

## License

[MIT](LICENSE), Copyright (c) 2026 Liry24.
