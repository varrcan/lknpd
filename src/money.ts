import { protocolError, validationError } from './errors.js';

/** Сумма: строка рублей (`"149"`, `"149.9"`, `"149.90"`) или целые копейки. */
export type Amount = string | { kopecks: number };

const RUBLES = /^(\d+)(?:\.(\d{1,2}))?$/;

/** Положительная сумма из входных данных потребителя → копейки. */
export function parseAmount(amount: Amount, field: string): bigint {
    const value: unknown = amount;
    let kopecks: bigint;
    if (typeof value === 'string') {
        const match = RUBLES.exec(value);
        if (!match) {
            throw validationError(
                `${field}: ожидается строка рублей вида "149.90", получено "${value}"`
            );
        }
        kopecks = BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
    } else if (
        typeof value === 'object' &&
        value !== null &&
        Number.isSafeInteger((value as { kopecks?: unknown }).kopecks)
    ) {
        kopecks = BigInt((value as { kopecks: number }).kopecks);
    } else {
        throw validationError(`${field}: ожидается строка рублей или { kopecks: целое }`);
    }
    if (kopecks <= 0n) throw validationError(`${field}: сумма должна быть больше нуля`);
    return kopecks;
}

export function formatKopecks(kopecks: bigint): string {
    const sign = kopecks < 0n ? '-' : '';
    const abs = kopecks < 0n ? -kopecks : kopecks;
    return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

const KOPECK_TOLERANCE = 1e-6;
const RESPONSE_DECIMAL = /^\d+(?:\.\d{1,2})?$/;

/**
 * Сумма из ответа API → копейки. ФНС отдаёт деньги JSON-числом; рубли с двумя знаками
 * до 2^53/100 представимы double без потери копеек, а ошибка умножения на 100 на порядки
 * меньше половины копейки, поэтому округление безопасно (design Р5). Дробь мельче копейки —
 * признак, что ответ понят неверно.
 */
export function kopecksFromResponse(value: unknown, field: string): bigint {
    if (typeof value === 'string' && RESPONSE_DECIMAL.test(value)) {
        return parseAmountUnchecked(value);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw protocolError(`${field}: ожидалась неотрицательная сумма в ответе`);
    }
    const scaled = value * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > KOPECK_TOLERANCE || !Number.isSafeInteger(rounded)) {
        throw protocolError(`${field}: сумма ${value} в ответе не выражается целыми копейками`);
    }
    return BigInt(rounded);
}

function parseAmountUnchecked(value: string): bigint {
    const [rubles = '0', fraction = ''] = value.split('.');
    return BigInt(rubles) * 100n + BigInt(fraction.padEnd(2, '0'));
}
