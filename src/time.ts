import { protocolError, validationError } from './errors.js';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
    let fmt = formatters.get(timeZone);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            // Без h23 часть локалей и рантаймов отдаёт полночь как 24:00.
            hourCycle: 'h23',
            timeZoneName: 'longOffset',
        });
        formatters.set(timeZone, fmt);
    }
    return fmt;
}

export function assertTimeZone(timeZone: unknown): asserts timeZone is string {
    if (typeof timeZone !== 'string' || timeZone === '') {
        throw validationError('timezone: обязательна IANA-зона, например "Europe/Moscow"');
    }
    try {
        formatter(timeZone);
    } catch {
        throw validationError(`timezone: неизвестная зона "${timeZone}"`);
    }
}

// Node 24 отдаёт нулевой оффсет как "GMT+00:00", bun — как "GMT" без знака (ECMA-402).
const LONG_OFFSET = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/;

/** `GMT+07:00` → `+07:00`, голый `GMT` → `+00:00`. */
export function offsetFromLongName(name: string, timeZone: string): string {
    const match = LONG_OFFSET.exec(name);
    if (!match) {
        throw validationError(`время: оффсет "${name}" зоны ${timeZone} не выражается как ±HH:MM`);
    }
    return `${match[1] ?? '+'}${match[2] ?? '00'}:${match[3] ?? '00'}`;
}

/**
 * Локальное время зоны и её оффсет на этот момент: `YYYY-MM-DDTHH:mm:ss±HH:MM`.
 * С `withMillis` — `YYYY-MM-DDTHH:mm:ss.SSS±HH:MM` (формат фильтров списка).
 */
export function formatInZone(date: Date, timeZone: string, withMillis = false): string {
    if (Number.isNaN(date.getTime())) throw validationError('время: невалидная дата');
    const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of formatter(timeZone).formatToParts(date)) parts[part.type] = part.value;

    const offsetText = offsetFromLongName(parts.timeZoneName ?? '', timeZone);
    const year = (parts.year ?? '').padStart(4, '0');
    const millis = withMillis ? `.${String(date.getUTCMilliseconds()).padStart(3, '0')}` : '';
    return (
        `${year}-${parts.month ?? ''}-${parts.day ?? ''}` +
        `T${parts.hour ?? ''}:${parts.minute ?? ''}:${parts.second ?? ''}${millis}${offsetText}`
    );
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Время из ответа API. Без оффсета строка неоднозначна — такой ответ не принимается. */
export function parseResponseTime(value: unknown, field: string): Date {
    const date = tryParseResponseTime(value);
    if (!date) throw protocolError(`${field}: ожидалось время с оффсетом в ответе`);
    return date;
}

export function tryParseResponseTime(value: unknown): Date | null {
    if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
}
