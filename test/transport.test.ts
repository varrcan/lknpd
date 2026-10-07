import { afterEach, describe, expect, it, vi } from 'vitest';
import { LknpdClient, LknpdError, isLknpdError, type RequestEvent } from '../src/index.js';
import { classifyNetworkError } from '../src/network.js';
import { authBody, fakeFetch, json, makeClient } from './helpers.js';

function caught(promise: Promise<unknown>): Promise<LknpdError> {
    return promise.then(
        () => {
            throw new Error('ожидалась ошибка');
        },
        (error: unknown) => {
            if (!isLknpdError(error)) throw error;
            return error;
        }
    );
}

function syncCaught(fn: () => unknown): LknpdError {
    try {
        fn();
    } catch (error) {
        if (isLknpdError(error)) return error;
        throw error;
    }
    throw new Error('ожидалась ошибка');
}

const listOk = () => json(200, { content: [], hasMore: false });

// Ручная подмена вместо vi.stubGlobal: тесты гоняются и раннером bun, где его нет.
const originalFetch = globalThis.fetch;

function stubGlobalFetch(impl: (...args: unknown[]) => Promise<Response>) {
    const mock = vi.fn(impl);
    globalThis.fetch = mock;
    return mock;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('Конфигурация клиента', () => {
    it('без deviceId — validation, сетевых вызовов нет', () => {
        const { fetch, calls } = fakeFetch(listOk);
        const error = syncCaught(
            () =>
                new LknpdClient({
                    deviceId: '',
                    timezone: 'Europe/Moscow',
                    fetch,
                })
        );
        expect(error.kind).toBe('validation');
        expect(error.outcome).toBe('not-sent');
        expect(calls).toHaveLength(0);
    });

    it('неизвестная зона — validation', () => {
        const error = syncCaught(
            () => new LknpdClient({ deviceId: 'd', timezone: 'Mars/Olympus' })
        );
        expect(error.kind).toBe('validation');
    });

    it('инжектированный fetch вместо globalThis.fetch', async () => {
        const globalFetch = stubGlobalFetch(() => Promise.resolve(listOk()));
        const { client, calls } = makeClient(listOk);
        await client.listIncomes();
        expect(calls).toHaveLength(1);
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('без fetch в опциях берётся globalThis.fetch на момент вызова', async () => {
        const client = new LknpdClient({ deviceId: 'd', timezone: 'Europe/Moscow' });
        const globalFetch = stubGlobalFetch(() => Promise.resolve(listOk()));
        await client.loginWithPassword({ inn: '123456789012', password: 'p' }).catch(() => {});
        expect(globalFetch).toHaveBeenCalledOnce();
    });

    it('базовый URL с версией, общие заголовки, Referer только на /auth/*', async () => {
        const { client, calls } = makeClient(call =>
            call.path === '/v1/auth/lkfl' ? json(200, authBody('T', 'R')) : listOk()
        );
        await client.loginWithPassword({ inn: '123456789012', password: 'p' });
        await client.listIncomes();
        const [login, list] = calls;
        expect(login?.url).toBe('https://lknpd.nalog.ru/api/v1/auth/lkfl');
        expect(login?.headers.Referer).toBe('https://lknpd.nalog.ru/auth/login');
        expect(login?.headers['Content-Type']).toBe('application/json');
        expect(list?.headers.Referer).toBeUndefined();
        expect(list?.headers.Authorization).toBe('Bearer T');
        expect(list?.headers['User-Agent']).toMatch(/Mozilla/);
    });
});

describe('Описание устройства', () => {
    it('два экземпляра с одним deviceId несут один sourceDeviceId', async () => {
        const handler = () => json(200, authBody('T', 'R'));
        const a = makeClient(handler, { deviceId: 'stable-id', userAgent: 'UA/1' });
        const b = makeClient(handler, { deviceId: 'stable-id', userAgent: 'UA/1' });
        await a.client.loginWithPassword({ inn: '123456789012', password: 'p' });
        await b.client.loginWithPassword({ inn: '123456789012', password: 'p' });
        const expected = {
            sourceType: 'WEB',
            sourceDeviceId: 'stable-id',
            appVersion: '1.0.0',
            metaDetails: { userAgent: 'UA/1' },
        };
        expect(a.calls[0]?.body).toMatchObject({ deviceInfo: expected });
        expect(b.calls[0]?.body).toMatchObject({ deviceInfo: expected });
    });
});

describe('Исход ошибок', () => {
    const rejectWith = (error: Error) => () => Promise.reject(error);

    it('ECONNREFUSED в cause — network / not-sent', async () => {
        const cause = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
        const { client } = makeClient(rejectWith(new TypeError('fetch failed', { cause })));
        const error = await caught(client.listIncomes());
        expect(error.kind).toBe('network');
        expect(error.outcome).toBe('not-sent');
    });

    it('код bun на самой ошибке — not-sent', () => {
        const error = Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' });
        expect(classifyNetworkError(error)).toBe('not-sent');
    });

    it('вложенные cause просматриваются', () => {
        const inner = Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
        const error = new TypeError('fetch failed', { cause: new Error('wrap', { cause: inner }) });
        expect(classifyNetworkError(error)).toBe('not-sent');
    });

    it('ECONNRESET — maybe-sent', async () => {
        const cause = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        const { client } = makeClient(rejectWith(new TypeError('fetch failed', { cause })));
        const error = await caught(client.listIncomes());
        expect(error.kind).toBe('network');
        expect(error.outcome).toBe('maybe-sent');
    });

    it('обрыв bun после соединения — maybe-sent', () => {
        const error = Object.assign(new Error('closed'), { code: 'ConnectionClosed' });
        expect(classifyNetworkError(error)).toBe('maybe-sent');
    });

    it('ошибка без кода — maybe-sent', async () => {
        const { client } = makeClient(rejectWith(new Error('???')));
        const error = await caught(client.listIncomes());
        expect(error.outcome).toBe('maybe-sent');
    });

    it('таймаут ответа — timeout / maybe-sent', async () => {
        const { client } = makeClient(
            () =>
                new Promise<Response>((_, reject) => {
                    // fetch, честно реагирующий на сигнал, отклоняется TimeoutError.
                    setTimeout(() => {
                        reject(new DOMException('timeout', 'TimeoutError'));
                    }, 20);
                }),
            { timeoutMs: 1000 }
        );
        const error = await caught(client.listIncomes());
        expect(error.kind).toBe('timeout');
        expect(error.outcome).toBe('maybe-sent');
    });

    it('fetch игнорирует сигнал — всё равно timeout за timeoutMs', async () => {
        const { client } = makeClient(() => new Promise<Response>(() => {}), { timeoutMs: 50 });
        const started = Date.now();
        const error = await caught(client.listIncomes());
        expect(error.kind).toBe('timeout');
        expect(error.outcome).toBe('maybe-sent');
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('зависшее тело ответа — тоже timeout', async () => {
        const stalled = new Response(new ReadableStream({ start() {} }), { status: 200 });
        const { client } = makeClient(() => stalled, { timeoutMs: 50 });
        const error = await caught(client.listIncomes());
        expect(error.kind).toBe('timeout');
    });

    it.each([500, 503])('HTTP %i — http / maybe-sent со статусом', async status => {
        const { client } = makeClient(() => new Response('Bad Gateway', { status }));
        const error = await caught(client.listIncomes());
        expect(error.kind).toBe('http');
        expect(error.outcome).toBe('maybe-sent');
        expect(error.status).toBe(status);
    });

    it.each([400, 422])('HTTP %i — http / rejected с кодом и текстом ФНС', async status => {
        const { client } = makeClient(() =>
            json(status, { code: 'validation.failed', message: 'Сумма слишком велика' })
        );
        const error = await caught(client.listIncomes());
        expect(error.kind).toBe('http');
        expect(error.outcome).toBe('rejected');
        expect(error.status).toBe(status);
        expect(error.code).toBe('validation.failed');
        expect(error.fnsMessage).toBe('Сумма слишком велика');
    });

    it('200 на создание чека без approvedReceiptUuid — protocol / maybe-sent', async () => {
        const { client } = makeClient(() => json(200, { something: 'else' }));
        const error = await caught(
            client.createIncome({ items: [{ name: 'Подписка', amount: '149.00' }] })
        );
        expect(error.kind).toBe('protocol');
        expect(error.outcome).toBe('maybe-sent');
    });

    it('isLknpdError распознаёт ошибку без instanceof и отвергает чужие', () => {
        const error = new LknpdError('x', { kind: 'http', outcome: 'rejected' });
        expect(isLknpdError(error)).toBe(true);
        expect(isLknpdError(Object.create(error) as unknown)).toBe(true);
        expect(isLknpdError(new Error('x'))).toBe(false);
        expect(isLknpdError({ kind: 'http', outcome: 'rejected' })).toBe(false);
        expect(isLknpdError(null)).toBe(false);
    });
});

describe('Секреты', () => {
    const PASSWORD = 's3cret-PASS';

    it('ошибка входа не содержит пароля ни в message, ни в JSON, ни в хуке', async () => {
        const events: RequestEvent[] = [];
        const { client } = makeClient(
            () => json(401, { code: 'authentication.failed', message: 'Неверный пароль' }),
            { onRequest: event => events.push(event) }
        );
        const error = await caught(
            client.loginWithPassword({ inn: '123456789012', password: PASSWORD })
        );
        expect(error.kind).toBe('auth');
        expect(error.message).not.toContain(PASSWORD);
        expect(JSON.stringify(error)).not.toContain(PASSWORD);
        expect(String(error.cause)).not.toContain(PASSWORD);
        expect(JSON.stringify(events)).not.toContain(PASSWORD);
    });

    it('хук наблюдения получает метод, путь, статус, длительность, но не Authorization', async () => {
        const events: RequestEvent[] = [];
        const { client } = makeClient(listOk, { onRequest: event => events.push(event) });
        await client.listIncomes({ limit: 5 });
        expect(events).toHaveLength(1);
        const [event] = events;
        expect(event).toMatchObject({ method: 'GET', path: '/v1/incomes', status: 200 });
        expect(typeof event?.durationMs).toBe('number');
        expect(JSON.stringify(events)).not.toContain('T1');
        expect(JSON.stringify(events)).not.toContain('Bearer');
    });

    it('хук получает outcome ошибки', async () => {
        const events: RequestEvent[] = [];
        const { client } = makeClient(() => new Response('', { status: 503 }), {
            onRequest: event => events.push(event),
        });
        await caught(client.listIncomes());
        expect(events[0]).toMatchObject({ status: 503, outcome: 'maybe-sent' });
    });

    it('сбой хука не меняет исход вызова', async () => {
        const { client } = makeClient(listOk, {
            onRequest: () => {
                throw new Error('logger down');
            },
        });
        await expect(client.listIncomes()).resolves.toMatchObject({ items: [] });
    });

    it('токены не попадают в ошибку 401 с повтором', async () => {
        const { client } = makeClient(call =>
            call.path === '/v1/auth/token'
                ? json(200, authBody('NEW-TOKEN', 'NEW-REFRESH'))
                : json(401, { code: 'auth', message: 'expired' })
        );
        const error = await caught(client.listIncomes());
        const dump = `${error.message} ${JSON.stringify(error)}`;
        for (const secret of ['T1', 'R1', 'NEW-TOKEN', 'NEW-REFRESH']) {
            expect(dump).not.toContain(secret);
        }
    });
});
