import { protocolError } from './errors.js';
import { formatKopecks, kopecksFromResponse } from './money.js';
import { parseResponseTime, tryParseResponseTime } from './time.js';

export interface IncomeService {
    name: string;
    /** Цена за единицу, `"N.NN"`. */
    amount: string;
    quantity: number;
}

export interface IncomeCancellation {
    comment: string | null;
    operationTime: Date | null;
    registerTime: Date | null;
}

export interface Income {
    receiptUuid: string;
    name: string | null;
    services: IncomeService[];
    /** `"N.NN"`. */
    totalAmount: string;
    operationTime: Date;
    requestTime: Date | null;
    registerTime: Date | null;
    cancelled: boolean;
    cancellation: IncomeCancellation | null;
    /** Ответ сервера целиком: поля, которые пакет не разбирает, не теряются. */
    raw: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * Гард проверяет только поля, на которые опирается пакет (номер, сумма, время, наименования
 * — отпечаток для сверки); остальное берётся мягко и всегда доступно в `raw` (design Р8).
 */
export function parseIncome(value: unknown, where: string): Income {
    if (!isRecord(value)) throw protocolError(`${where}: чек — не объект`);
    // Список отдаёт номер как approvedReceiptUuid, JSON чека — как receiptId (спайк 2.6).
    const receiptUuid = value.approvedReceiptUuid ?? value.receiptId;
    if (typeof receiptUuid !== 'string' || receiptUuid === '') {
        throw protocolError(`${where}: нет номера чека (approvedReceiptUuid / receiptId)`);
    }
    const at = `${where} ${receiptUuid}`;
    if (!Array.isArray(value.services)) throw protocolError(`${at}: нет services`);
    const services = value.services.map((item: unknown, i): IncomeService => {
        if (!isRecord(item) || typeof item.name !== 'string') {
            throw protocolError(`${at}: services[${i}] без наименования`);
        }
        return {
            name: item.name,
            amount: formatKopecks(kopecksFromResponse(item.amount, `${at}: services[${i}].amount`)),
            quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        };
    });
    const totalKopecks = kopecksFromResponse(value.totalAmount, `${at}: totalAmount`);
    const cancellation = parseCancellation(value.cancellationInfo);

    return {
        receiptUuid,
        name: stringOrNull(value.name),
        services,
        totalAmount: formatKopecks(totalKopecks),
        operationTime: parseResponseTime(value.operationTime, `${at}: operationTime`),
        requestTime: tryParseResponseTime(value.requestTime),
        registerTime: tryParseResponseTime(value.registerTime),
        cancelled: cancellation !== null,
        cancellation,
        raw: value,
    };
}

function parseCancellation(value: unknown): IncomeCancellation | null {
    if (!isRecord(value)) return null;
    return {
        comment: stringOrNull(value.comment),
        operationTime: tryParseResponseTime(value.operationTime),
        registerTime: tryParseResponseTime(value.registerTime),
    };
}
