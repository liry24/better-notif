/* oxlint-disable no-await-in-loop -- Field validators run in declaration order before any recipient writes. */
import type { BetterAuthPluginDBSchema, DBFieldAttribute, DBPrimitive, InferDBValueType } from '@better-auth/core/db'
import type { Where } from '@better-auth/core/db/adapter'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { APIError } from 'better-auth/api'

import { contentSchema, identifier, schema as baseSchema } from './schema'
import type { BaseContent, BaseInput } from './schema'
import type { Notification, StoredNotification } from './types'

export type NotificationField = DBFieldAttribute & { validate?: StandardSchemaV1 }
export type NotificationFields = Record<string, NotificationField>
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
export type NotificationTypes = Record<string, { fields?: NotificationFields }>
export interface NotificationSchema {
    modelName?: string
}

type TypeFields<K extends NotificationTypes, T extends keyof K> = K[T] extends {
    fields: infer F extends NotificationFields
}
    ? F
    : {}
type LocalFields<K extends NotificationTypes> = { [T in keyof K]: TypeFields<K, T> }[keyof K]
type Keys<U> = U extends unknown ? keyof U : never
type Value<U, N> = U extends unknown ? (N extends keyof U ? U[N] : never) : never
export type NotificationFieldsOf<F extends NotificationFields, K extends NotificationTypes> = {
    [N in (keyof F | Keys<LocalFields<K>>) & string]: Extract<
        N extends keyof F ? F[N] : Value<LocalFields<K>, N>,
        NotificationField
    >
}

type InputValue<A extends NotificationField> = A extends { validate: infer V extends StandardSchemaV1 }
    ? StandardSchemaV1.InferInput<V>
    : A extends { validator: { input: infer V extends StandardSchemaV1 } }
      ? StandardSchemaV1.InferInput<V>
      : InferDBValueType<A['type']> | (A['required'] extends false ? null : never)
type OutputValue<A extends NotificationField> = A extends { validator: { output: infer V extends StandardSchemaV1 } }
    ? StandardSchemaV1.InferOutput<V>
    : A extends { validate: infer V extends StandardSchemaV1 }
      ? A extends { transform: { input: unknown } } | { transform: { output: unknown } }
          ? InferDBValueType<A['type']>
          : StandardSchemaV1.InferOutput<V>
      : A extends { validator: { input: infer V extends StandardSchemaV1 } }
        ? A extends { transform: { input: unknown } } | { transform: { output: unknown } }
            ? InferDBValueType<A['type']>
            : StandardSchemaV1.InferOutput<V>
        : InferDBValueType<A['type']>
type HasDefault<A> = A extends { defaultValue: unknown } ? true : false
type RequiredInput<F extends NotificationFields> = {
    [N in keyof F]: F[N]['input'] extends false
        ? never
        : HasDefault<F[N]> extends true
          ? never
          : F[N]['required'] extends false
            ? never
            : N
}[keyof F]
type InputFields<F extends NotificationFields> = {
    [N in keyof F as N extends RequiredInput<F> ? N : never]: NonNullable<InputValue<F[N]>>
} & {
    [N in keyof F as F[N]['input'] extends false ? never : N extends RequiredInput<F> ? never : N]?: InputValue<F[N]>
}
type OutputFields<F extends NotificationFields> = {
    [N in keyof F as F[N]['returned'] extends false ? never : N]: F[N]['required'] extends false
        ? OutputValue<F[N]> | null
        : OutputValue<F[N]>
}
export type NotificationInput<
    F extends NotificationFields = {},
    K extends NotificationTypes = {},
> = keyof K extends never
    ? BaseInput & InputFields<F>
    : {
          [T in keyof K & string]: Omit<BaseInput, 'type'> & { type: T } & InputFields<F & TypeFields<K, T>>
      }[keyof K & string]
export type NotificationContent<
    F extends NotificationFields = {},
    K extends NotificationTypes = {},
> = keyof K extends never
    ? BaseContent & OutputFields<F>
    : {
          [T in keyof K & string]: Omit<BaseContent, 'type'> & { type: T } & OutputFields<F & TypeFields<K, T>>
      }[keyof K & string]
type PreparedValue<A extends NotificationField> = A extends { validate: infer V extends StandardSchemaV1 }
    ? StandardSchemaV1.InferOutput<V>
    : A extends { validator: { input: infer V extends StandardSchemaV1 } }
      ? StandardSchemaV1.InferOutput<V>
      : InferDBValueType<A['type']>
type PreparedFields<F extends NotificationFields> = {
    [N in keyof F as F[N]['returned'] extends false ? never : N]:
        | PreparedValue<F[N]>
        | (F[N]['required'] extends false ? null : never)
}
export type NotificationChanges<
    F extends NotificationFields = {},
    K extends NotificationTypes = {},
> = keyof K extends never
    ? BaseContent & PreparedFields<F>
    : {
          [T in keyof K & string]: Omit<BaseContent, 'type'> & { type: T } & PreparedFields<F & TypeFields<K, T>>
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

function isJSONContainer(value: unknown): value is Extract<DBPrimitive, Record<string, unknown> | unknown[]> {
    return value !== null && typeof value === 'object' && isJSON(value)
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
            return isJSONContainer(value)
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

const normalize = (attributes: NotificationFields): NotificationFields =>
    Object.fromEntries(
        Object.entries(attributes).map(([name, attribute]) => {
            if (attribute.validate && attribute.validator?.input)
                throw new Error(`Conflicting notification input validators: ${name}`)
            return [
                name,
                {
                    ...attribute,
                    required: attribute.required !== false,
                    ...(attribute.validate ? { validator: { ...attribute.validator, input: attribute.validate } } : {}),
                },
            ]
        }),
    )
const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    const left = Object.entries(a),
        right = Object.entries(b)
    return (
        left.length === right.length &&
        left.every(([key, value]) => Object.hasOwn(b, key) && equal(value, Reflect.get(b, key)))
    )
}
const storage = ({
    required: _required,
    defaultValue: _default,
    validator: _validator,
    validate: _validate,
    ...attribute
}: NotificationField) => attribute
const denyScope = (): never => {
    throw new APIError('FORBIDDEN', {
        code: 'NOTIFICATION_ACCESS_DENIED',
        message: 'Invalid notification list access scope',
    })
}

export function createNotificationModel<F extends NotificationFields, K extends NotificationTypes>(
    common: F | undefined,
    types: K | undefined,
    config?: NotificationSchema,
    filterableFields: readonly NotificationFilterField<NotificationFieldsOf<F, K>>[] = [],
) {
    const shared = normalize(common ?? {})
    const registry: NotificationTypes | undefined =
        types && Object.keys(types).length
            ? Object.fromEntries(
                  Object.entries(types).map(([type, definition]) => {
                      if (Object.keys(definition).some((key) => key !== 'fields'))
                          throw new Error(`Unknown notification type option: ${type}`)
                      return [type, { fields: normalize(definition.fields ?? {}) }]
                  }),
              )
            : undefined
    const fields: NotificationFields = { ...shared }
    for (const [type, definition] of Object.entries(registry ?? {})) {
        if (
            !identifier.safeParse(type).success ||
            type.length > 100 ||
            ['__proto__', 'prototype', 'constructor'].includes(type)
        )
            throw new Error(`Invalid notification type: ${type}`)
        for (const [name, attribute] of Object.entries(definition.fields ?? {})) {
            if (Object.hasOwn(shared, name)) throw new Error(`Notification type redeclares common field: ${name}`)
            if (fields[name] && !equal(storage(fields[name]), storage(attribute)))
                throw new Error(`Conflicting notification storage definitions: ${name}`)
            fields[name] ??= { ...storage(attribute), required: false }
        }
    }
    const logicalFields = (type: string) => ({ ...shared, ...registry?.[type]?.fields })
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
        const field: NotificationField = { ...attribute, required: attribute.required !== false }
        if (field.input === false && field.required && field.defaultValue === undefined)
            throw new Error(`Non-input required field needs a default: ${name}`)
        if (field.transform?.input) {
            const transform = field.transform.input
            field.transform = {
                ...field.transform,
                input: async (value) => {
                    if (value === null && !Object.hasOwn(shared, name)) return null
                    const transformed = await transform(value)
                    if (!matchesField(transformed, field)) invalid(`Invalid transformed notification field: ${name}`)
                    return transformed
                },
            }
        }
        if (field.transform?.output && !Object.hasOwn(shared, name)) {
            const output = field.transform.output
            field.transform = { ...field.transform, output: (value) => (value === null ? null : output(value)) }
        }
        fields[name] = field
    }
    for (const definition of [shared, ...Object.values(registry ?? {}).map((type) => type.fields ?? {})]) {
        for (const [name, field] of Object.entries(definition))
            if (field.input === false && field.required !== false && field.defaultValue === undefined)
                throw new Error(`Non-input required field needs a default: ${name}`)
    }
    const modelName = config?.modelName
    if (
        modelName !== undefined &&
        (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(modelName) ||
            ['user', 'session', 'account', 'verification'].includes(modelName.toLowerCase()))
    )
        throw new Error('Invalid or conflicting notification model name')
    const schema = {
        notification: {
            ...baseSchema.notification,
            ...(modelName ? { modelName } : {}),
            fields: Object.fromEntries(
                Object.entries({ ...baseSchema.notification.fields, ...fields }).map(
                    ([name, field]: [string, DBFieldAttribute]): [string, DBFieldAttribute] => {
                        if (!['json', 'string[]', 'number[]'].includes(String(field.type))) return [name, field]
                        const output = field.transform?.output
                        return [
                            name,
                            {
                                ...field,
                                transform: {
                                    ...field.transform,
                                    async output(value) {
                                        if (value === null && !Object.hasOwn(shared, name)) return null
                                        const transformed = output ? await output(value) : value
                                        if (typeof transformed !== 'string') return transformed
                                        // Core's fallback JSON decoder revives strings as Dates. Parse containers first.
                                        try {
                                            const parsed: unknown = JSON.parse(transformed)
                                            if (isJSONContainer(parsed)) return parsed
                                        } catch {
                                            // Let the native adapter retain its handling of malformed historical values.
                                        }
                                        return transformed
                                    },
                                },
                            } satisfies DBFieldAttribute,
                        ]
                    },
                ),
            ),
        },
    } satisfies BetterAuthPluginDBSchema

    async function prepare(input: NotificationInput<F, K>) {
        const content = contentSchema.parse(input)
        const raw: Record<string, unknown> = input
        if (registry && !Object.hasOwn(registry, content.type))
            throw new APIError('BAD_REQUEST', {
                code: 'NOTIFICATION_UNKNOWN_TYPE',
                message: 'Notification type is not registered',
            })
        const declared = logicalFields(content.type)
        for (const key of Object.keys(raw))
            if (!Object.hasOwn(contentSchema.shape, key) && !Object.hasOwn(declared, key))
                invalid(`Unknown notification field: ${key}`)
        const values: Record<string, unknown> = {
            ...Object.fromEntries(Object.keys(fields).map((name) => [name, null])),
            ...content,
        }
        const supplied: Record<string, unknown> = { ...content }
        for (const [name, field] of Object.entries(declared)) {
            const suppliedValue = Object.hasOwn(raw, name) && raw[name] !== undefined
            if (suppliedValue && field.input === false) invalid(`Notification field cannot be supplied: ${name}`)
            let value = suppliedValue
                ? raw[name]
                : typeof field.defaultValue === 'function'
                  ? field.defaultValue()
                  : field.defaultValue
            if (suppliedValue && field.validator?.input) value = await validate(field.validator.input, value)
            if (value === null || value === undefined) {
                if (field.required) invalid(`Required notification field: ${name}`)
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
        let current = !registry || Object.hasOwn(registry, row.type)
        const declared = current ? logicalFields(row.type) : fields
        const values: Record<string, unknown> = {}
        for (const [name, field] of Object.entries(declared)) {
            let value: unknown = row[name] ?? null
            if ((field.required && value === null) || (!field.validator?.output && !matchesField(value, field)))
                current = false
            if (field.returned === false) continue
            if (value !== null && field.validator?.output) {
                try {
                    value = (await validate(field.validator.output, value)) ?? null
                    if (
                        (value === null && field.required) ||
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
    function scopeWhere(scope: unknown): Where[] {
        if (
            !scope ||
            typeof scope !== 'object' ||
            Array.isArray(scope) ||
            Object.keys(scope).length !== 1 ||
            !Object.hasOwn(scope, 'where')
        )
            return denyScope()
        const terms: unknown = Reflect.get(scope, 'where')
        if (!Array.isArray(terms) || terms.length > 20) return denyScope()
        const scopeFields: Record<string, DBFieldAttribute> = {
            id: { type: 'string' },
            ...baseSchema.notification.fields,
            ...fields,
        }
        return terms.map((term: unknown) => {
            if (
                !term ||
                typeof term !== 'object' ||
                Array.isArray(term) ||
                Object.keys(term).some((key) => !['field', 'operator', 'value'].includes(key))
            )
                return denyScope()
            const name: unknown = Reflect.get(term, 'field'),
                operator: unknown = Reflect.get(term, 'operator') ?? 'eq',
                value: unknown = Reflect.get(term, 'value')
            if (
                typeof name !== 'string' ||
                !Object.hasOwn(scopeFields, name) ||
                typeof operator !== 'string' ||
                !['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in'].includes(operator)
            )
                return denyScope()
            const field = scopeFields[name]!
            if (
                field.transform ||
                (!['string', 'number', 'boolean', 'date'].includes(String(field.type)) && !Array.isArray(field.type))
            )
                return denyScope()
            if (operator === 'in') {
                if (field.type !== 'string' && field.type !== 'number' && !Array.isArray(field.type)) return denyScope()
                if (
                    !Array.isArray(value) ||
                    value.length < 1 ||
                    value.length > 100 ||
                    !value.every((item: unknown) => item !== null && matchesField(item, field))
                )
                    return denyScope()
            } else if (!matchesField(value, { ...field, required: false })) return denyScope()
            // Every policy term is ANDed with mandatory ownership and the requested filters.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every native operator and value is checked above.
            return { field: name, operator, value, connector: 'AND' } as Where
        })
    }
    function changes(content: Record<string, unknown>) {
        return Object.fromEntries(
            Object.entries(content).filter(
                ([name]) =>
                    !Object.hasOwn(fields, name) ||
                    (Object.hasOwn(logicalFields(String(content.type)), name) && fields[name]?.returned !== false),
            ),
        )
    }
    return { schema, prepare, present, filterWhere, scopeWhere, changes }
}

export type NotificationModel<F extends NotificationFields, K extends NotificationTypes> = ReturnType<
    typeof createNotificationModel<F, K>
>
