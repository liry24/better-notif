import type { Where } from '@better-auth/core/db/adapter'
import { APIError } from 'better-auth/api'

import type { NotificationActor, NotificationContext, HookStatus, NotificationListContext } from './types'

export function serverActor(headers?: Headers): NotificationActor {
    return { session: null, headers: new Headers(headers) }
}
export function isolated<T extends { headers: Headers }>(event: T): T {
    const data = { ...event } as Record<string, unknown>
    delete data.headers
    let recipient: Record<string, unknown> | undefined
    let context: unknown
    if (data.recipient && typeof data.recipient === 'object') {
        recipient = { ...data.recipient }
        context = recipient.context
        delete recipient.context
        data.recipient = recipient
    }
    const copied = structuredClone(data)
    if (recipient && copied.recipient && typeof copied.recipient === 'object')
        Reflect.set(copied.recipient, 'context', context)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Copy the same callback fields while rebuilding Headers.
    return { ...copied, headers: new Headers(event.headers) } as T
}
export async function authorize<E extends { headers: Headers }>(
    policy: ((event: E) => boolean | Promise<boolean>) | undefined,
    event: E,
    managed = false,
) {
    if (managed || !policy) return
    let allowed: unknown
    try {
        allowed = await policy(isolated(event))
    } catch {
        allowed = false
    }
    if (allowed !== true)
        throw new APIError('FORBIDDEN', {
            code: 'NOTIFICATION_ACCESS_DENIED',
            message: 'Notification operation denied',
        })
}
export async function before<E extends { headers: Headers }>(
    hook: ((event: E) => void | Promise<void>) | undefined,
    event: E,
) {
    if (!hook) return
    try {
        const result: unknown = await hook(isolated(event))
        if (result !== undefined) throw new Error('Unexpected hook result')
    } catch {
        throw new APIError('INTERNAL_SERVER_ERROR', {
            code: 'NOTIFICATION_HOOK_FAILED',
            message: 'Notification before hook failed',
        })
    }
}
export async function after<E extends { headers: Headers }>(
    ctx: NotificationContext,
    hook: ((event: E) => void | Promise<void>) | undefined,
    event: E,
): Promise<HookStatus> {
    if (!hook) return 'skipped'
    try {
        const result: unknown = await hook(isolated(event))
        if (result !== undefined) throw new Error('Unexpected hook result')
        return 'completed'
    } catch {
        ctx.logger.error('Notification after hook failed; the completed operation is not retried')
        return 'failed'
    }
}
export async function listScope(
    policy: ((event: NotificationListContext) => unknown) | undefined,
    event: NotificationListContext,
    model: { scopeWhere: (scope: unknown) => Where[] },
): Promise<Where[]> {
    if (!policy) return []
    let allowed: unknown
    try {
        allowed = await policy(isolated(event))
    } catch {
        allowed = false
    }
    if (allowed === false)
        throw new APIError('FORBIDDEN', { code: 'NOTIFICATION_ACCESS_DENIED', message: 'Notification listing denied' })
    return model.scopeWhere(allowed)
}
