import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'

import { encodeNotificationDates, isNotificationPath, notificationDateHeader } from './transport'

function mutationOutcome(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object') return {}
    if ('results' in value && Array.isArray(value.results)) {
        const mutationResults = value.results.map((result: Record<string, unknown>) => {
            const { notification: _, ...outcome } = result
            return outcome
        })
        return {
            mutationResults,
            ...('nextCursor' in value ? { nextCursor: value.nextCursor } : {}),
            ...('hasMore' in value ? { hasMore: value.hasMore } : {}),
        }
    }
    if ('notification' in value && value.notification !== null && typeof value.notification === 'object') {
        return {
            mutationResults: [
                {
                    ...('id' in value.notification ? { id: value.notification.id } : {}),
                    status: 'changed' in value && value.changed ? 'updated' : 'unchanged',
                    ...('hook' in value ? { hook: value.hook } : {}),
                },
            ],
        }
    }
    return {}
}

export const notificationTransport = {
    hooks: {
        after: [
            {
                matcher: (ctx) => !!ctx.request && isNotificationPath(ctx.path),
                handler: createAuthMiddleware(async (ctx) => {
                    const value: unknown = ctx.context.returned
                    if (value instanceof APIError || value instanceof Response || value === undefined) return
                    let metadata: string
                    try {
                        metadata = encodeNotificationDates(value)
                    } catch (error) {
                        if (!(error instanceof RangeError)) throw error
                        throw new APIError('INTERNAL_SERVER_ERROR', {
                            code: 'NOTIFICATION_TRANSPORT_LIMIT',
                            message:
                                'Notification date metadata exceeds 6 KiB. Mutations are not rolled back; inspect mutationResults. Use a smaller page or batch, or reduce date fields.',
                            ...mutationOutcome(value),
                        })
                    }
                    ctx.setHeader(notificationDateHeader, metadata)
                    const exposed = ctx.context.responseHeaders?.get('access-control-expose-headers')
                    ctx.setHeader(
                        'access-control-expose-headers',
                        exposed ? `${exposed}, ${notificationDateHeader}` : notificationDateHeader,
                    )
                }),
            },
        ],
    },
} satisfies Pick<BetterAuthPlugin, 'hooks'>
