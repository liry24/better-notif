import { expect, it } from 'vite-plus/test'

import {
    decodeNotificationDates,
    encodeNotificationDates,
    notificationDateLimit,
    parseNotificationTransport,
} from '../../packages/better-notif/src/transport'

it('restores only actual dates and rejects malformed metadata or prototype-traversing paths', () => {
    const iso = '2026-01-01T00:00:00.000Z'
    const data = { nested: [{ date: new Date(iso), text: iso }], nullable: null }
    const paths = decodeNotificationDates(encodeNotificationDates(data))
    expect(parseNotificationTransport(JSON.stringify(data), paths)).toEqual(data)
    for (const invalid of [
        [['missing']],
        [['nested', '01', 'date']],
        [['__proto__', 'polluted']],
        [['nested', '0', 'constructor']],
        [['nullable']],
        [
            ['nested', '0', 'date'],
            ['nested', '0', 'date'],
        ],
    ])
        expect(() => parseNotificationTransport(JSON.stringify(data), invalid)).toThrow(TypeError)
    for (const metadata of [
        { v: 2, paths: [] },
        { v: 1, paths: [123] },
        { v: 1, paths: [['__proto__']] },
    ])
        expect(() => decodeNotificationDates(JSON.stringify(metadata))).toThrow(TypeError)
    expect(() => decodeNotificationDates(null)).toThrow(TypeError)
    expect(() => decodeNotificationDates(' '.repeat(notificationDateLimit + 1))).toThrow(TypeError)
    expect(() => parseNotificationTransport(JSON.stringify({ date: 'invalid' }), [['date']])).toThrow(TypeError)
    expect(() => parseNotificationTransport(JSON.stringify({ date: '2026-01-01T00:00:00Z' }), [['date']])).toThrow(
        TypeError,
    )
    expect(Object.prototype).not.toHaveProperty('polluted')
    const unicode = { '\u65e5\ud83d\udcc5': new Date(iso) }
    const header = encodeNotificationDates(unicode)
    expect(header).not.toMatch(/[^\x20-\x7e]/u)
    expect(parseNotificationTransport(JSON.stringify(unicode), decodeNotificationDates(header))).toEqual(unicode)
    expect(() => encodeNotificationDates({ ['x'.repeat(notificationDateLimit)]: new Date(iso) })).toThrow(RangeError)
})

it('bounds full pages with array paths without converting mixed strings or nulls', () => {
    const date = new Date('2026-01-01T00:00:00.000Z')
    const data = {
        notifications: Array.from({ length: 100 }, (_, index) => ({
            createdAt: date,
            readAt: index % 2 ? date : null,
            archivedAt: date,
        })),
    }
    const header = encodeNotificationDates(data)
    expect(header.length).toBeLessThan(200)
    expect(parseNotificationTransport(JSON.stringify(data), decodeNotificationDates(header))).toEqual(data)
    const mixed = { values: [{ date }, { date: date.toISOString() }, { date: null }] }
    const paths = decodeNotificationDates(encodeNotificationDates(mixed))
    expect(paths).toEqual([['values', '0', 'date']])
    expect(parseNotificationTransport(JSON.stringify(mixed), paths)).toEqual(mixed)
    expect(() =>
        parseNotificationTransport(JSON.stringify(data), [
            ['notifications', '*', 'createdAt'],
            ['notifications', '0', 'createdAt'],
        ]),
    ).toThrow(TypeError)
    expect(() => parseNotificationTransport(JSON.stringify({ values: [date, 'invalid'] }), [['values', '*']])).toThrow(
        TypeError,
    )
    expect(() => parseNotificationTransport(JSON.stringify({ values: [{}, {}] }), [['values', '*', 'date']])).toThrow(
        TypeError,
    )
    const partial = { values: [{ date }, {}, { date: null }] }
    expect(
        parseNotificationTransport(JSON.stringify(partial), decodeNotificationDates(encodeNotificationDates(partial))),
    ).toEqual(partial)
    const legacy = { values: [{ date }, { date: new Date(Number.NaN) }] }
    expect(
        parseNotificationTransport(JSON.stringify(legacy), decodeNotificationDates(encodeNotificationDates(legacy))),
    ).toEqual({ values: [{ date }, { date: null }] })
})
