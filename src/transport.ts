import { LknpdError, protocolError, type ErrorOutcome } from './errors.js';
import { classifyNetworkError, isAbortLike } from './network.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Данные хука наблюдения. Секретов (заголовков, тел, query) не содержит. */
export interface RequestEvent {
    method: string;
    path: string;
    status?: number;
    durationMs: number;
    outcome?: ErrorOutcome;
}

export interface TransportOptions {
    baseUrl: string;
    fetch: FetchLike;
    timeoutMs: number;
    userAgent: string;
    onRequest?: ((event: RequestEvent) => void) | undefined;
}

export interface TransportRequest {
    method: 'GET' | 'POST';
    path: string;
    version?: 'v1' | 'v2';
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    token?: string;
}

export interface TransportResponse {
    status: number;
    body: unknown;
}

// ФНС не требует Referer (спайк 2.1), но веб-кабинет его шлёт — меньше отличий от браузера.
const AUTH_REFERER = 'https://lknpd.nalog.ru/auth/login';

export class Transport {
    readonly #options: TransportOptions;

    constructor(options: TransportOptions) {
        this.#options = options;
    }

    async request(req: TransportRequest): Promise<TransportResponse> {
        const path = `/${req.version ?? 'v1'}${req.path}`;
        const started = Date.now();
        let status: number | undefined;
        try {
            const response = await this.#send(req, path);
            status = response.status;
            this.#emit({ method: req.method, path, status, durationMs: Date.now() - started });
            return response;
        } catch (error) {
            const outcome = error instanceof LknpdError ? error.outcome : 'maybe-sent';
            const event: RequestEvent = {
                method: req.method,
                path,
                durationMs: Date.now() - started,
                outcome,
            };
            if (error instanceof LknpdError && error.status !== undefined) {
                event.status = error.status;
            }
            this.#emit(event);
            throw error;
        }
    }

    async #send(req: TransportRequest, path: string): Promise<TransportResponse> {
        const { timeoutMs } = this.#options;
        const url = this.#url(path, req.query);
        const init: RequestInit = {
            method: req.method,
            headers: this.#headers(req),
            signal: AbortSignal.timeout(timeoutMs),
        };
        if (req.body !== undefined) init.body = JSON.stringify(req.body);

        const exchange = async (): Promise<TransportResponse> => {
            const response = await this.#options.fetch(url, init);
            const text = await response.text();
            return { status: response.status, body: parseBody(text) };
        };

        // Собственный таймер поверх сигнала: bun 1.2.2 игнорирует сигнал в фазе соединения
        // и висит ~135 с (design Р2). Проигравший fetch доживает в фоне, его итог не нужен.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(timeoutError(req.method, path, timeoutMs));
            }, timeoutMs);
        });

        let result: TransportResponse;
        try {
            result = await Promise.race([exchange(), deadline]);
        } catch (error) {
            if (error instanceof LknpdError) throw error;
            if (isAbortLike(error)) throw timeoutError(req.method, path, timeoutMs, error);
            const outcome = classifyNetworkError(error);
            throw new LknpdError(
                `${req.method} ${path}: сетевая ошибка (${outcome === 'not-sent' ? 'запрос не отправлен' : 'запрос мог дойти'})`,
                { kind: 'network', outcome, cause: error }
            );
        } finally {
            clearTimeout(timer);
        }

        return checkStatus(req.method, path, result);
    }

    #url(path: string, query: TransportRequest['query']): string {
        const url = `${this.#options.baseUrl}${path}`;
        if (!query) return url;
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) params.set(key, String(value));
        }
        const qs = params.toString();
        return qs ? `${url}?${qs}` : url;
    }

    #headers(req: TransportRequest): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
            'User-Agent': this.#options.userAgent,
        };
        if (req.body !== undefined) headers['Content-Type'] = 'application/json';
        if (req.path.startsWith('/auth/')) headers.Referer = AUTH_REFERER;
        if (req.token !== undefined) headers.Authorization = `Bearer ${req.token}`;
        return headers;
    }

    #emit(event: RequestEvent): void {
        try {
            this.#options.onRequest?.(event);
        } catch {
            // Сбой логгера потребителя не должен менять исход вызова к ФНС.
        }
    }
}

function parseBody(text: string): unknown {
    if (text === '') return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

function timeoutError(method: string, path: string, ms: number, cause?: unknown): LknpdError {
    return new LknpdError(`${method} ${path}: нет ответа за ${ms} мс (запрос мог дойти)`, {
        kind: 'timeout',
        outcome: 'maybe-sent',
        cause,
    });
}

function checkStatus(method: string, path: string, res: TransportResponse): TransportResponse {
    const { status, body } = res;
    if (status >= 200 && status < 300) return res;

    const { code, message } = fnsError(body);
    const details = [code, message].filter(Boolean).join(': ');
    const text = `${method} ${path}: HTTP ${status}${details ? ` — ${details}` : ''}`;
    const base = {
        status,
        ...(code !== undefined && { code }),
        ...(message !== undefined && { fnsMessage: message }),
    };

    if (status === 401) return throwError(text, { kind: 'auth', outcome: 'rejected', ...base });
    if (status >= 400 && status < 500) {
        return throwError(text, { kind: 'http', outcome: 'rejected', ...base });
    }
    // 5xx: сервер мог зарегистрировать доход до сбоя. Прочие коды (3xx без редиректа, 1xx)
    // ничего не говорят об обработке — тоже maybe-sent.
    return throwError(text, { kind: 'http', outcome: 'maybe-sent', ...base });
}

function throwError(message: string, options: ConstructorParameters<typeof LknpdError>[1]): never {
    throw new LknpdError(message, options);
}

function fnsError(body: unknown): { code?: string; message?: string } {
    if (typeof body !== 'object' || body === null) return {};
    const { code, message } = body as { code?: unknown; message?: unknown };
    const result: { code?: string; message?: string } = {};
    if (typeof code === 'string' && code !== '') result.code = code;
    if (typeof message === 'string' && message !== '') result.message = message;
    return result;
}

export function expectObject(body: unknown, what: string): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw protocolError(`${what}: ожидался JSON-объект в ответе`);
    }
    return body as Record<string, unknown>;
}
