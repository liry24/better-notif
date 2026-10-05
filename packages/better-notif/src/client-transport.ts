import type { BetterFetchPlugin } from '@better-fetch/fetch'

import {
    decodeNotificationDates,
    isNotificationPath,
    notificationDateHeader,
    parseNotificationTransport,
} from './transport'

export const notificationFetchPlugin = {
    id: 'notification-transport',
    name: 'Notification transport',
    hooks: {
        onResponse({ request, response }) {
            if (!response.ok || !request.baseURL) return
            const url = new URL(request.url, 'http://notification.invalid')
            const base = new URL(request.baseURL, url)
            const prefix = base.pathname.replace(/\/$/u, '')
            if (
                url.origin !== base.origin ||
                !url.pathname.startsWith(prefix) ||
                !isNotificationPath(url.pathname.slice(prefix.length))
            )
                return
            const paths = decodeNotificationDates(response.headers.get(notificationDateHeader))
            // This public hook runs before validation, success callbacks, and atom updates in both supported peers.
            request.jsonParser = (text) => parseNotificationTransport(text, paths)
        },
    },
} satisfies BetterFetchPlugin
