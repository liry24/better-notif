import { expect, it } from 'vite-plus/test'
import * as z from 'zod'

import { createNotificationModel } from '../../packages/better-notif/src/fields'
import { contentSchema, listQuerySchema } from '../../packages/better-notif/src/schema'
import type { StoredNotification } from '../../packages/better-notif/src/types'

it('marks absent and null globally required output fields as legacy in retained records', async () => {
    const model = createNotificationModel(
        {
            name: { type: 'string', validator: { output: z.string() } },
            optional: { type: 'string', required: false, validator: { output: z.string() } },
        },
        undefined,
    )
    const retained: StoredNotification = {
        id: 'retained',
        userId: 'user',
        idempotencyKey: 'retained',
        type: 'event',
        title: 'Retained',
        body: null,
        actions: [],
        createdAt: new Date(),
        readAt: null,
        archivedAt: null,
    }
    expect(await model.present(retained)).toMatchObject({ name: null, schemaStatus: 'legacy' })
    expect(await model.present({ ...retained, name: null })).toMatchObject({ name: null, schemaStatus: 'legacy' })
    expect(await model.present({ ...retained, name: 'Saved' })).toMatchObject({
        name: 'Saved',
        optional: null,
        schemaStatus: 'current',
    })
})

it('accepts navigable actions and rejects dangerous or ambiguous links', () => {
    for (const href of [
        '/billing',
        '/posts/1?tab=comments#last',
        'https://example.com/posts/1',
        'http://localhost:3000',
    ]) {
        expect(
            contentSchema.safeParse({
                type: 'test',
                title: 'Test',
                actions: [{ id: 'open', label: 'Open', href }],
            }).success,
        ).toBe(true)
    }
    for (const href of [
        'javascript:alert(1)',
        'data:text/html,x',
        '//evil.test',
        '/\\evil.test',
        ' https://example.com',
        'https://a\nb.test',
        'https://user:password@example.com',
        'https:example.com',
    ]) {
        expect(
            contentSchema.safeParse({
                type: 'test',
                title: 'Test',
                actions: [{ id: 'open', label: 'Open', href }],
            }).success,
        ).toBe(false)
    }
    expect(
        contentSchema.parse({
            type: 'test',
            title: 'Test',
            actions: [{ id: 'modal', label: 'Change payment method' }],
        }).actions,
    ).toHaveLength(1)
})

it('validates content and query bounds without silently accepting duplicate actions', () => {
    expect(contentSchema.safeParse({ type: 'test', title: '' }).success).toBe(false)
    expect(
        contentSchema.safeParse({
            type: 'test',
            title: 'Test',
            actions: [
                { id: 'same', label: 'A' },
                { id: 'same', label: 'B' },
            ],
        }).success,
    ).toBe(false)
    expect(listQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(listQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
    expect(listQuerySchema.parse({})).toEqual({
        limit: 20,
        read: 'all',
        archived: 'unarchived',
    })
})
