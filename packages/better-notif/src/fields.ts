/* oxlint-disable no-await-in-loop -- Field validators run in declaration order before any recipient writes. */
import type { BetterAuthPluginDBSchema, DBFieldAttribute, InferDBValueType } from '@better-auth/core/db'
import type { Where } from '@better-auth/core/db/adapter'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { APIError } from 'better-auth/api'

import { contentSchema, identifier, schema as baseSchema } from './schema'
import type { BaseContent, BaseInput } from './schema'
import type { Notification, StoredNotification } from './types'

export type NotificationFields = Record<string, DBFieldAttribute>
export type NotificationFilterField<F extends NotificationFields> = {
    [N in keyof F & string]: F[N]['returned'] extends false
        ? never
        : F[N] extends { transform: unknown }
          ? never
          : F[N]['type'] extends 'string' | 'number' | 'boolean' | 'date' | readonly string[]
            ? N
            : never
}[keyof F & string]
export type NotificationFieldFilters<F extends NotificationFields = {}> = keyof F extends never
    ? Record<string, never>
    : { [N in NotificationFilterField<F>]?: InferDBValueType<F[N]['type']> | null }
export type NotificationKinds<F extends NotificationFields = NotificationFields> = Record<
    string,
    { required?: readonly (keyof F & string)[] }
>
export interface NotificationSchema<F extends NotificationFields = {}> {
    notification?: { additionalFields?: F; modelName?: string }
}

type InputValue<A extends DBFieldAttribute> = A extends { validator: { input: infer V extends StandardSchemaV1 } }
    ? StandardSchemaV1.InferInput<V>
    : InferDBValueType<A['type']> | (A['required'] extends false ? null : never)
type OutputValue<A extends DBFieldAttribute> = A extends { validator: { output: infer V extends StandardSchemaV1 } }
    ? StandardSchemaV1.InferOutput<V>
    : A extends { validator: { input: infer V extends StandardSchemaV1 } }
      ? A extends { transform: { output: unknown } }
          ? InferDBValueType<A['type']>
          : StandardSchemaV1.InferOutput<V>
      : InferDBValueType<A['type']>
type HasDefault<A> = A extends { defaultValue: unknown } ? true : false
type RequiredFor<K, T extends keyof K> = K[T] extends { required: readonly (infer N)[] } ? N : never
type RequiredInput<F extends NotificationFields, R> = {
    [N in keyof F]: F[N]['input'] extends false
        ? never
        : HasDefault<F[N]> extends true
          ? never
          : F[N]['required'] extends false
            ? N extends R
                ? N
                : never
            : N
}[keyof F]
type InputFields<F extends NotificationFields, R> = {
    [N in keyof F as N extends RequiredInput<F, R> ? N : never]: NonNullable<InputValue<F[N]>>
} & {
    [N in keyof F as F[N]['input'] extends false ? never : N extends RequiredInput<F, R> ? never : N]?: InputValue<F[N]>
}
type OutputFields<F extends NotificationFields, R> = {
    [N in keyof F as F[N]['returned'] extends false ? never : N]: F[N]['required'] extends false
        ? N extends R
            ? NonNullable<OutputValue<F[N]>>
            : OutputValue<F[N]> | null
        : OutputValue<F[N]>
}
export type NotificationInput<
    F extends NotificationFields = {},
    K extends NotificationKinds<F> = {},
> = keyof K extends never
    ? BaseInput & InputFields<F, never>
    : {
          [T in keyof K & string]: Omit<BaseInput, 'type'> & { type: T } & InputFields<F, RequiredFor<K, T>>
      }[keyof K & string]
export type NotificationContent<
    F extends NotificationFields = {},
    K extends NotificationKinds<F> = {},
> = keyof K extends never
    ? BaseContent & OutputFields<F, never>
    : {
          [T in keyof K & string]: Omit<BaseContent, 'type'> & { type: T } & OutputFields<F, RequiredFor<K, T>>
      }[keyof K & string]

function invalid(message: string): never {
    throw new APIError('BAD_REQUEST', { code: 'NOTIFICATION_INVALID_FIELDS', message })
}

// Used only for explicitly declared JSON fields. Other native fields retain their own types, including Date.
function isJSON(value: unknown, ancestors = new Set<object>()): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object' || ancestors.has(value)) return false
    if (
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
    )
        return false
    ancestors.add(value)
    const keys = Reflect.ownKeys(value)
    const valid =
        keys.every((key) => {
            if (Array.isArray(value) && key === 'length') return true
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!
            return (
                typeof key === 'string' &&
                descriptor.enumerable === true &&
                'value' in descriptor &&
                (!Array.isArray(value) || /^(0|[1-9]\d*)$/u.test(key)) &&
                isJSON(descriptor.value, ancestors)
            )
        }) &&
        (!Array.isArray(value) || keys.length === value.length + 1)
    ancestors.delete(value)
    return valid
}

function matchesField(value: unknown, field: DBFieldAttribute): boolean {
    if (value === null || value === undefined) return field.required === false
    if (Array.isArray(field.type)) return typeof value === 'string' && field.type.includes(value)
    switch (field.type) {
        case 'string':
            return typeof value === 'string'
        case 'number':
            return typeof value === 'number' && Number.isFinite(value)
        case 'boolean':
            return typeof value === 'boolean'
        case 'date':
            return value instanceof Date && Number.isFinite(value.getTime())
        case 'json':
            return isJSON(value)
        case 'string[]':
            return Array.isArray(value) && isJSON(value) && value.every((v) => typeof v === 'string')
        case 'number[]':
            return Array.isArray(value) && isJSON(value) && value.every((v) => typeof v === 'number')
        default:
            return false
    }
}

async function validate(validator: StandardSchemaV1, value: unknown) {
    let result: StandardSchemaV1.Result<unknown>
    try {
        result = await validator['~standard'].validate(value)
    } catch {
        throw new APIError('INTERNAL_SERVER_ERROR', {
            code: 'NOTIFICATION_SCHEMA_ERROR',
            message: 'Notification field validator failed',
        })
    }
    if (result.issues) invalid('Notification field does not match its validator')
    return result.value
}

async function fingerprint(value: unknown) {
    const canonical = JSON.stringify(value, (_key, item: unknown) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            return Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        }
        return item
    })
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createNotificationModel<F extends NotificationFields, K extends NotificationKinds<F>>(
    config: NotificationSchema<F> | undefined,
    kinds: K | undefined,
    filterableFields: readonly NotificationFilterField<F>[] = [],
) {
    const fields: NotificationFields = { ...config?.notification?.additionalFields }
    const registry: NotificationKinds | undefined = kinds && Object.keys(kinds).length ? { ...kinds } : undefined
    const reserved = new Set([
        'id',
        'schemaStatus',
        '__proto__',
        'prototype',
        'constructor',
        ...Object.keys(baseSchema.notification.fields),
    ])
    const columns = new Set([...reserved].map((key) => key.toLowerCase()))
    for (const [name, attribute] of Object.entries(fields)) {
        if (reserved.has(name) || !/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(name))
            throw new Error(`Invalid notification field name: ${name}`)
        const column = attribute.fieldName ?? name
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(column) || columns.has(column.toLowerCase()))
            throw new Error(`Conflicting notification column: ${column}`)
        columns.add(column.toLowerCase())
        const field: DBFieldAttribute = { ...attribute, required: attribute.required !== false }
        if (field.input === false && field.required && field.defaultValue === undefined)
            throw new Error(`Non-input required field needs a default: ${name}`)
        if (field.transform?.input) {
            const transform = field.transform.input
            field.transform = {
                ...field.transform,
                input: async (value) => {
                    const transformed = await transform(value)
                    if (!matchesField(transformed, field)) invalid(`Invalid transformed notification field: ${name}`)
                    return transformed
                },
            }
        }
        fields[name] = field
    }
    for (const [kind, rule] of Object.entries(registry ?? {})) {
        if (!identifier.safeParse(kind).success || kind.length > 100 || reserved.has(kind))
            throw new Error(`Invalid notification kind: ${kind}`)
        for (const name of rule.required ?? [])
            if (!Object.hasOwn(fields, name)) throw new Error(`Unknown required notification field: ${name}`)
    }
    const modelName = config?.notification?.modelName
    if (
        modelName !== undefined &&
        (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(modelName) ||
            ['user', 'session', 'account', 'verification'].includes(modelName.toLowerCase()))
    )
        throw new Error('Invalid or conflicting notification model name')
    const schema = {
        notification: {
            ...baseSchema.notification,
            ...(config?.notification?.modelName ? { modelName: config.notification.modelName } : {}),
            fields: { ...baseSchema.notification.fields, ...fields },
        },
    } satisfies BetterAuthPluginDBSchema

    async function prepare(input: NotificationInput<F, K>) {
        const content = contentSchema.parse(input)
        const raw: Record<string, unknown> = input
        for (const key of Object.keys(raw))
            if (!Object.hasOwn(contentSchema.shape, key) && !Object.hasOwn(fields, key))
                invalid(`Unknown notification field: ${key}`)
        if (registry && !Object.hasOwn(registry, content.type))
            throw new APIError('BAD_REQUEST', {
                code: 'NOTIFICATION_UNKNOWN_TYPE',
                message: 'Notification type is not registered',
            })
        const values: Record<string, unknown> = { ...content }
        const supplied: Record<string, unknown> = { ...content }
        const required = new Set(registry?.[content.type]?.required ?? [])
        for (const [name, field] of Object.entries(fields)) {
            const suppliedValue = Object.hasOwn(raw, name) && raw[name] !== undefined
            if (suppliedValue && field.input === false) invalid(`Notification field cannot be supplied: ${name}`)
            let value = suppliedValue
                ? raw[name]
                : typeof field.defaultValue === 'function'
                  ? field.defaultValue()
                  : field.defaultValue
            if (suppliedValue && field.validator?.input) value = await validate(field.validator.input, value)
            if (value === null || value === undefined) {
                if (field.required || required.has(name)) invalid(`Required notification field: ${name}`)
                value = null
            }
            if (!field.transform?.input && !matchesField(value, field))
                invalid(`Invalid notification field type: ${name}`)
            // Hash only supplied, validated values: generated defaults and adapter transforms need not be repeatable.
            if (suppliedValue) supplied[name] = value
            values[name] = value
        }
        return { content: structuredClone(values), contentHash: await fingerprint(supplied) }
    }

    async function present(row: StoredNotification): Promise<Notification<F, K>> {
        const content = contentSchema.parse(row)
        const required = new Set(registry?.[row.type]?.required ?? [])
        let current = !registry || Object.hasOwn(registry, row.type)
        const values: Record<string, unknown> = {}
        for (const [name, field] of Object.entries(fields)) {
            let value: unknown = row[name] ?? null
            if (
                ((field.required || required.has(name)) && value === null) ||
                (!field.validator?.output && !matchesField(value, field))
            )
                current = false
            if (field.returned === false) continue
            if (value !== null && field.validator?.output) {
                try {
                    value = (await validate(field.validator.output, value)) ?? null
                    if (
                        (value === null && (field.required || required.has(name))) ||
                        (value !== null && !(value instanceof Date ? Number.isFinite(value.getTime()) : isJSON(value)))
                    ) {
                        current = false
                        value = null
                    }
                } catch {
                    current = false
                    value = null
                }
            }
            values[name] = value
        }
        // Explicit legacy branch prevents removed kinds or missing required fields from masquerading as current types.
        return {
            ...content,
            ...values,
            id: row.id,
            userId: row.userId,
            createdAt: row.createdAt,
            readAt: row.readAt ?? null,
            archivedAt: row.archivedAt ?? null,
            schemaStatus: current ? 'current' : 'legacy',
        }
    }
    const allowedFilters = new Set<string>(filterableFields)
    for (const name of allowedFilters) {
        const field = fields[name]
        if (
            !Object.hasOwn(fields, name) ||
            !field ||
            field.returned === false ||
            field.transform ||
            (!['string', 'number', 'boolean', 'date'].includes(String(field.type)) && !Array.isArray(field.type))
        )
            throw new Error(`Notification field cannot be filtered: ${name}`)
    }
    function filterWhere(input: unknown): Where[] {
        if (input === undefined) return []
        let values: unknown = input
        if (typeof values === 'string') {
            if (values.length > 16_384) invalid('Notification field filters are too large')
            try {
                values = JSON.parse(values)
            } catch {
                invalid('Invalid notification field filters')
            }
        }
        if (!values || typeof values !== 'object' || Array.isArray(values))
            invalid('Expected notification field filters')
        const entries = Object.entries(values)
        if (entries.length > 16) invalid('Too many notification field filters')
        return entries.map(([name, raw]) => {
            if (!allowedFilters.has(name)) invalid(`Notification field is not filterable: ${name}`)
            const field = fields[name]!
            const value: unknown = field.type === 'date' && typeof raw === 'string' ? new Date(raw) : raw
            if (
                value !== null &&
                typeof value !== 'string' &&
                typeof value !== 'number' &&
                typeof value !== 'boolean' &&
                !(value instanceof Date)
            )
                invalid(`Invalid notification filter value: ${name}`)
            if (value !== null && (!matchesField(value, field) || (typeof value === 'string' && value.length > 2048)))
                invalid(`Invalid notification filter value: ${name}`)
            // Filter values use the native database type; write validators and transforms are never replayed.
            return { field: name, value }
        })
    }
    return { schema, prepare, present, filterWhere }
}

export type NotificationModel<F extends NotificationFields, K extends NotificationKinds<F>> = ReturnType<
    typeof createNotificationModel<F, K>
>
