import type { ErrorOutcome } from './errors.js';

/**
 * Коды ошибок фазы соединения: байты запроса до сервера не дошли.
 *
 * Только белый список — ошибка в сторону `maybe-sent` стоит потребителю одной сверки,
 * в сторону `not-sent` — двойного чека.
 *
 * undici (Node) кладёт код в `cause.code`. bun 1.2.2 кладёт код на саму ошибку и отдаёт
 * `ConnectionRefused` и на отказ в соединении, и на ошибку DNS (проверено, в т.ч. вне
 * песочницы); обе ситуации — до отправки. Обрыв после отправки bun отдаёт как
 * `ConnectionClosed` — он в список не входит.
 */
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'ConnectionRefused',
]);

const MAX_CAUSE_DEPTH = 5;

export function classifyNetworkError(error: unknown): ErrorOutcome {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
        if (typeof current !== 'object' || current === null) break;
        const { code, cause } = current as { code?: unknown; cause?: unknown };
        if (typeof code === 'string' && CONNECT_PHASE_CODES.has(code)) return 'not-sent';
        current = cause;
    }
    return 'maybe-sent';
}

export function isAbortLike(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const { name } = error as { name?: unknown };
    return name === 'TimeoutError' || name === 'AbortError';
}
