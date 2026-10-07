import { describe, expect, it, vi } from 'vitest';
import {
    LknpdClient,
    MemoryTokenStore,
    isLknpdError,
    type Session,
    type TokenStore,
} from '../src/index.js';
import {
    INN,
    authBody,
    expiresIn,
    fakeFetch,
    json,
    makeClient,
    makeSession,
    type RecordedCall,
} from './helpers.js';

const CREDENTIALS = { inn: INN, password: 'pw' };
const listOk = () => json(200, { content: [], hasMore: false });

function paths(calls: RecordedCall[]) {
    return calls.map(call => call.path);
}

function tokensOfListCalls(calls: RecordedCall[]) {
    return calls.filter(c => c.path === '/v1/incomes').map(c => c.headers.Authorization);
}

describe('Вход по паролю', () => {
    it('сохраняет сессию с ИНН из профиля', async () => {
        const { client, store, calls } = makeClient(
            () => json(200, authBody('T', 'R', '999999999999')),
            { session: null }
        );
        const save = vi.spyOn(store, 'save');
        const session = await client.loginWithPassword(CREDENTIALS);
        expect(save).toHaveBeenCalledWith(session);
        expect(session).toMatchObject({ token: 'T', refreshToken: 'R', inn: '999999999999' });
        expect(calls[0]?.body).toMatchObject({ username: INN, password: 'pw' });
    });

    it('401 — auth / rejected, сессия не сохраняется', async () => {
        const { client, store } = makeClient(
            () => json(401, { code: 'authentication.failed', message: 'Неверный пароль' }),
            { session: null }
        );
        const save = vi.spyOn(store, 'save');
        const error: unknown = await client.loginWithPassword(CREDENTIALS).catch((e: unknown) => e);
        expect(isLknpdError(error) && error.kind).toBe('auth');
        expect(isLknpdError(error) && error.outcome).toBe('rejected');
        expect(save).not.toHaveBeenCalled();
    });

    it('без профиля в ответе берёт ИНН из учётных данных', async () => {
        const { client } = makeClient(
            () => json(200, { token: 'T', refreshToken: 'R', tokenExpireIn: expiresIn(3600_000) }),
            { session: null }
        );
        await expect(client.loginWithPassword(CREDENTIALS)).resolves.toMatchObject({ inn: INN });
    });
});

describe('Вход по SMS', () => {
    it('нормализует телефон и возвращает challengeToken и срок', async () => {
        const { client, calls } = makeClient(() =>
            json(200, { challengeToken: 'CH', expireDate: '2026-10-07T12:02:00Z', expireIn: 120 })
        );
        const challenge = await client.requestSmsCode('+7 (900) 000-00-00');
        expect(calls[0]?.url).toBe('https://lknpd.nalog.ru/api/v2/auth/challenge/sms/start');
        expect(calls[0]?.body).toEqual({ phone: '79000000000', requireTpToBeActive: true });
        expect(challenge).toEqual({
            challengeToken: 'CH',
            expireDate: '2026-10-07T12:02:00Z',
            expireIn: 120,
        });
    });

    it('обмен кода сохраняет сессию', async () => {
        const { client, store, calls } = makeClient(() => json(200, authBody('T', 'R')), {
            session: null,
        });
        const session = await client.loginWithSms({
            phone: '89000000000',
            challengeToken: 'CH',
            code: '1234',
        });
        expect(calls[0]?.url).toBe('https://lknpd.nalog.ru/api/v1/auth/challenge/sms/verify');
        expect(calls[0]?.body).toMatchObject({
            phone: '79000000000',
            code: '1234',
            challengeToken: 'CH',
            deviceInfo: { sourceDeviceId: 'device-1' },
        });
        await expect(store.load()).resolves.toEqual(session);
    });

    it('без профиля ИНН берётся из /v1/user', async () => {
        const { client } = makeClient(
            call =>
                call.path === '/v1/user'
                    ? json(200, { inn: '777777777777' })
                    : json(200, { token: 'T', refreshToken: 'R', tokenExpireIn: expiresIn(1e6) }),
            { session: null }
        );
        const session = await client.loginWithSms({
            phone: '9000000000',
            challengeToken: 'CH',
            code: '1',
        });
        expect(session.inn).toBe('777777777777');
    });

    it('невалидный телефон — validation без запроса', async () => {
        const { client, calls } = makeClient(listOk);
        await expect(client.requestSmsCode('12345')).rejects.toMatchObject({
            kind: 'validation',
        });
        expect(calls).toHaveLength(0);
    });
});

describe('Упреждающее обновление', () => {
    it('токен истекает через 30 с — refresh и save до вызова', async () => {
        const { client, store, calls } = makeClient(
            call => (call.path === '/v1/auth/token' ? json(200, authBody('T2', 'R2')) : listOk()),
            { session: makeSession({ tokenExpireIn: expiresIn(30_000) }) }
        );
        const save = vi.spyOn(store, 'save');
        await client.listIncomes();
        expect(paths(calls)).toEqual(['/v1/auth/token', '/v1/incomes']);
        expect(calls[0]?.body).toMatchObject({ refreshToken: 'R1' });
        expect(save).toHaveBeenCalledOnce();
        expect(tokensOfListCalls(calls)).toEqual(['Bearer T2']);
    });

    it('токен свежий — без обновления', async () => {
        const { client, calls } = makeClient(listOk);
        await client.listIncomes();
        expect(paths(calls)).toEqual(['/v1/incomes']);
    });
});

describe('Повтор после 401', () => {
    it('401 → refresh → повтор 200, новая сессия сохранена', async () => {
        let listCalls = 0;
        const { client, store, calls } = makeClient(call => {
            if (call.path === '/v1/auth/token') return json(200, authBody('T2', 'R2'));
            return ++listCalls === 1 ? json(401, {}) : listOk();
        });
        await expect(client.listIncomes()).resolves.toMatchObject({ items: [] });
        expect(paths(calls)).toEqual(['/v1/incomes', '/v1/auth/token', '/v1/incomes']);
        expect(tokensOfListCalls(calls)).toEqual(['Bearer T1', 'Bearer T2']);
        await expect(store.load()).resolves.toMatchObject({ token: 'T2', refreshToken: 'R2' });
    });

    it('повторный 401 — auth, третьей попытки нет', async () => {
        const { client, calls } = makeClient(call =>
            call.path === '/v1/auth/token' ? json(200, authBody('T2', 'R2')) : json(401, {})
        );
        await expect(client.listIncomes()).rejects.toMatchObject({
            kind: 'auth',
            outcome: 'rejected',
        });
        expect(paths(calls).filter(p => p === '/v1/incomes')).toHaveLength(2);
    });

    it('поздний 401 на устаревшем токене — повтор с новым без refresh', async () => {
        let releaseSlow!: () => void;
        const slowGate = new Promise<void>(resolve => {
            releaseSlow = resolve;
        });
        const { client, store, calls } = makeClient(async call => {
            const token = call.headers.Authorization;
            if (call.path === '/v1/auth/token') return json(200, authBody('T2', 'R2'));
            if (token === 'Bearer T1' && call.url.includes('limit=1&')) {
                await slowGate;
                return json(401, {});
            }
            return token === 'Bearer T2' ? listOk() : json(401, {});
        });
        // Первый вызов уходит с T1 и висит; второй получает 401, обновляет до T2.
        const slow = client.listIncomes({ limit: 1, sortBy: 'operation_time:asc' });
        await client.listIncomes({ limit: 2 });
        await expect(store.load()).resolves.toMatchObject({ token: 'T2' });
        releaseSlow();
        await expect(slow).resolves.toMatchObject({ items: [] });
        expect(paths(calls).filter(p => p === '/v1/auth/token')).toHaveLength(1);
    });
});

describe('Ответ обновления без refresh-токена', () => {
    it('сохраняется прежний refreshToken', async () => {
        const { client, store } = makeClient(
            call => (call.path === '/v1/auth/token' ? json(200, authBody('T2')) : listOk()),
            { session: makeSession({ tokenExpireIn: expiresIn(0) }) }
        );
        const save = vi.spyOn(store, 'save');
        await client.listIncomes();
        expect(save).toHaveBeenCalledWith(
            expect.objectContaining({ token: 'T2', refreshToken: 'R1' })
        );
    });
});

describe('Вход по паролю при отозванном refresh', () => {
    it('refresh 401, пароль есть — вход, save, исходный вызов', async () => {
        const { client, store, calls } = makeClient(
            call => {
                if (call.path === '/v1/auth/token') return json(401, {});
                if (call.path === '/v1/auth/lkfl') return json(200, authBody('T3', 'R3'));
                return listOk();
            },
            { session: makeSession({ tokenExpireIn: expiresIn(0) }), credentials: CREDENTIALS }
        );
        await client.listIncomes();
        expect(paths(calls)).toEqual(['/v1/auth/token', '/v1/auth/lkfl', '/v1/incomes']);
        expect(tokensOfListCalls(calls)).toEqual(['Bearer T3']);
        await expect(store.load()).resolves.toMatchObject({ token: 'T3' });
    });

    it('refresh 401, пароля нет — auth / rejected', async () => {
        const { client } = makeClient(
            call => (call.path === '/v1/auth/token' ? json(401, {}) : listOk()),
            { session: makeSession({ tokenExpireIn: expiresIn(0) }) }
        );
        await expect(client.listIncomes()).rejects.toMatchObject({
            kind: 'auth',
            outcome: 'rejected',
        });
    });

    it('refresh 503 — ошибка как есть, входа по паролю нет', async () => {
        const { client, calls } = makeClient(
            call => (call.path === '/v1/auth/token' ? json(503, {}) : listOk()),
            { session: makeSession({ tokenExpireIn: expiresIn(0) }), credentials: CREDENTIALS }
        );
        await expect(client.listIncomes()).rejects.toMatchObject({ kind: 'http', status: 503 });
        expect(paths(calls)).toEqual(['/v1/auth/token']);
    });

    it('сбой refresh перед createIncome — not-sent: сам чек не отправлялся', async () => {
        const { client, calls } = makeClient(
            call =>
                call.path === '/v1/auth/token'
                    ? json(503, {})
                    : json(200, { approvedReceiptUuid: 'x' }),
            { session: makeSession({ tokenExpireIn: expiresIn(0) }) }
        );
        await expect(
            client.createIncome({ items: [{ name: 'x', amount: '1' }] })
        ).rejects.toMatchObject({ kind: 'http', status: 503, outcome: 'not-sent' });
        expect(paths(calls)).toEqual(['/v1/auth/token']);
    });

    it('таймаут refresh после 401 на createIncome — not-sent: первый вызов отклонён', async () => {
        const { client, calls } = makeClient(
            call =>
                call.path === '/v1/auth/token' ? new Promise<Response>(() => {}) : json(401, {}),
            { timeoutMs: 50 }
        );
        await expect(
            client.createIncome({ items: [{ name: 'x', amount: '1' }] })
        ).rejects.toMatchObject({ kind: 'timeout', outcome: 'not-sent' });
        expect(paths(calls)).toEqual(['/v1/income', '/v1/auth/token']);
    });

    it('protocol-ошибка в ответе входа перед вызовом — not-sent', async () => {
        const { client } = makeClient(
            call => (call.path === '/v1/auth/lkfl' ? json(200, { nope: true }) : listOk()),
            { session: null, credentials: CREDENTIALS }
        );
        await expect(client.listIncomes()).rejects.toMatchObject({
            kind: 'protocol',
            outcome: 'not-sent',
        });
    });

    it('нет сессии, есть пароль — вход перед вызовом', async () => {
        const { client, calls } = makeClient(
            call => (call.path === '/v1/auth/lkfl' ? json(200, authBody('T', 'R')) : listOk()),
            { session: null, credentials: CREDENTIALS }
        );
        await client.listIncomes();
        expect(paths(calls)).toEqual(['/v1/auth/lkfl', '/v1/incomes']);
    });
});

describe('Одно обновление за раз', () => {
    it('пять параллельных вызовов при истекающем токене — один refresh', async () => {
        const { client, calls } = makeClient(
            async call => {
                if (call.path === '/v1/auth/token') {
                    await new Promise(resolve => setTimeout(resolve, 10));
                    return json(200, authBody('T2', 'R2'));
                }
                return listOk();
            },
            { session: makeSession({ tokenExpireIn: expiresIn(30_000) }) }
        );
        await Promise.all(Array.from({ length: 5 }, () => client.listIncomes()));
        expect(paths(calls).filter(p => p === '/v1/auth/token')).toHaveLength(1);
        expect(tokensOfListCalls(calls)).toEqual(Array(5).fill('Bearer T2'));
    });

    it('обновление внутри withRefreshLock, стор перечитывается в блокировке', async () => {
        const events: string[] = [];
        let stored: Session | null = makeSession({ tokenExpireIn: expiresIn(0) });
        const store: TokenStore = {
            load: () => {
                events.push('load');
                return Promise.resolve(stored);
            },
            save: session => {
                events.push('save');
                stored = session;
                return Promise.resolve();
            },
            withRefreshLock: async fn => {
                events.push('lock');
                // Пока ждали блокировку, другой процесс уже обновил токен.
                stored = makeSession({ token: 'FROM-OTHER', refreshToken: 'R9' });
                try {
                    return await fn();
                } finally {
                    events.push('unlock');
                }
            },
        };
        const { fetch, calls } = fakeFetch(listOk);
        const client = new LknpdClient({
            deviceId: 'd',
            timezone: 'Europe/Moscow',
            fetch,
            tokenStore: store,
        });
        await client.listIncomes();
        expect(events).toEqual(['load', 'lock', 'load', 'unlock']);
        expect(paths(calls)).toEqual(['/v1/incomes']);
        expect(tokensOfListCalls(calls)).toEqual(['Bearer FROM-OTHER']);
    });
});

describe('MemoryTokenStore', () => {
    it('load возвращает сохранённое', async () => {
        const store = new MemoryTokenStore();
        await expect(store.load()).resolves.toBeNull();
        const session = makeSession();
        await store.save(session);
        await expect(store.load()).resolves.toEqual(session);
    });
});
