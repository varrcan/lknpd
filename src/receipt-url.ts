import { validationError } from './errors.js';

export const DEFAULT_BASE_URL = 'https://lknpd.nalog.ru/api';

/**
 * Ссылка на печатную форму чека для покупателя. Сессия не нужна. База — `receiptBaseUrl`,
 * а не транспортный `baseUrl`: прокси, через который сервис ходит в API, покупателю недоступен.
 */
export function receiptPrintUrl(inn: string, receiptUuid: string, base = DEFAULT_BASE_URL): string {
    if (typeof inn !== 'string' || inn.trim() === '') {
        throw validationError('receiptPrintUrl: пустой ИНН');
    }
    if (typeof receiptUuid !== 'string' || receiptUuid.trim() === '') {
        throw validationError('receiptPrintUrl: пустой номер чека');
    }
    return `${trimSlash(base)}/v1/receipt/${encodeURIComponent(inn)}/${encodeURIComponent(receiptUuid)}/print`;
}

export function trimSlash(url: string): string {
    return url.replace(/\/+$/, '');
}
