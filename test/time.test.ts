import { describe, expect, it } from 'vitest';
import {
    assertTimeZone,
    formatInZone,
    offsetFromLongName,
    parseResponseTime,
} from '../src/time.js';

describe('formatInZone', () => {
    it.each([
        ['граница месяца', 'Europe/Moscow', '2026-10-31T22:30:00Z', '2026-11-01T01:30:00+03:00'],
        ['Новосибирск', 'Asia/Novosibirsk', '2026-10-07T10:00:00Z', '2026-10-07T17:00:00+07:00'],
        ['полчаса оффсета', 'Asia/Kolkata', '2026-10-07T10:00:00Z', '2026-10-07T15:30:00+05:30'],
        ['UTC', 'UTC', '2026-01-15T00:00:00Z', '2026-01-15T00:00:00+00:00'],
        ['Лондон зимой', 'Europe/London', '2026-01-15T12:00:00Z', '2026-01-15T12:00:00+00:00'],
        ['Лондон летом', 'Europe/London', '2026-07-15T12:00:00Z', '2026-07-15T13:00:00+01:00'],
        ['отрицательный', 'America/New_York', '2026-01-15T12:00:00Z', '2026-01-15T07:00:00-05:00'],
        ['полночь', 'Europe/Moscow', '2026-03-09T21:00:00Z', '2026-03-10T00:00:00+03:00'],
        [
            'миллисекунды отбрасываются',
            'Europe/Moscow',
            '2026-10-07T10:00:00.999Z',
            '2026-10-07T13:00:00+03:00',
        ],
    ])('%s', (_, zone, instant, expected) => {
        expect(formatInZone(new Date(instant), zone)).toBe(expected);
    });

    it('переход на летнее время в Берлине: оффсет на момент, а не на дату', () => {
        // 29.03.2026 01:00Z часы в Берлине переводятся с 02:00 +01:00 на 03:00 +02:00.
        expect(formatInZone(new Date('2026-03-29T00:59:59Z'), 'Europe/Berlin')).toBe(
            '2026-03-29T01:59:59+01:00'
        );
        expect(formatInZone(new Date('2026-03-29T01:00:00Z'), 'Europe/Berlin')).toBe(
            '2026-03-29T03:00:00+02:00'
        );
    });

    it('с миллисекундами — формат фильтров списка', () => {
        expect(formatInZone(new Date('2026-10-07T10:00:00.042Z'), 'Europe/Moscow', true)).toBe(
            '2026-10-07T13:00:00.042+03:00'
        );
        expect(formatInZone(new Date('2026-01-15T00:00:00Z'), 'UTC', true)).toBe(
            '2026-01-15T00:00:00.000+00:00'
        );
    });

    it('строка обратно разбирается в тот же момент', () => {
        const instant = new Date('2026-10-31T22:30:00Z');
        for (const zone of ['Europe/Moscow', 'Asia/Kolkata', 'UTC', 'America/New_York']) {
            expect(Date.parse(formatInZone(instant, zone))).toBe(instant.getTime());
        }
    });

    it('невалидная дата — validation', () => {
        expect(() => formatInZone(new Date(NaN), 'UTC')).toThrow(
            expect.objectContaining({ kind: 'validation' })
        );
    });
});

describe('assertTimeZone', () => {
    it.each(['Mars/Olympus', '', 'GMT+25'])('отказ: "%s"', zone => {
        expect(() => {
            assertTimeZone(zone);
        }).toThrow(expect.objectContaining({ kind: 'validation' }));
    });

    it('валидная зона', () => {
        expect(() => {
            assertTimeZone('Europe/Moscow');
        }).not.toThrow();
    });
});

describe('parseResponseTime', () => {
    it.each(['2026-11-01T01:30:00+03:00', '2026-11-01T01:30:00.123+03:00', '2026-10-31T22:30:00Z'])(
        '%s',
        value => {
            expect(parseResponseTime(value, 'x').getTime()).toBe(Date.parse(value));
        }
    );

    it.each(['2026-11-01T01:30:00', '2026-11-01', 'вчера', 42])('без оффсета — protocol: %s', v => {
        expect(() => parseResponseTime(v, 'x')).toThrow(
            expect.objectContaining({ kind: 'protocol' })
        );
    });
});

describe('offsetFromLongName', () => {
    it.each([
        ['GMT+07:00', '+07:00'],
        ['GMT-05:00', '-05:00'],
        ['GMT+05:30', '+05:30'],
        ['GMT+00:00', '+00:00'],
        // bun и ECMA-402 отдают нулевой оффсет без знака.
        ['GMT', '+00:00'],
    ])('%s → %s', (name, expected) => {
        expect(offsetFromLongName(name, 'Z')).toBe(expected);
    });

    it.each(['GMT+5', 'UTC', 'GMT+05:53:28', ''])('отказ: "%s"', name => {
        expect(() => offsetFromLongName(name, 'Z')).toThrow(
            expect.objectContaining({ kind: 'validation' })
        );
    });
});
