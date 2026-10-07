import {
    LknpdClient,
    MemoryTokenStore,
    type LknpdClientOptions,
    type Session,
} from '../src/index.js';

export interface RecordedCall {
    url: string;
    path: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

export function fakeFetch(handler: Handler) {
    const calls: RecordedCall[] = [];
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
        const url = new URL(input);
        const call: RecordedCall = {
            url: input,
            path: url.pathname.replace(/^\/api/, ''),
            method: init.method ?? 'GET',
            headers: { ...(init.headers as Record<string, string>) },
            body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        return handler(call);
    };
    return { fetch, calls };
}

export function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export const INN = '123456789012';

export function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        token: 'T1',
        refreshToken: 'R1',
        tokenExpireIn: new Date(Date.now() + 3600_000).toISOString(),
        inn: INN,
        ...overrides,
    };
}

export function expiresIn(ms: number): string {
    return new Date(Date.now() + ms).toISOString();
}

export function authBody(token: string, refreshToken?: string, inn = INN) {
    return {
        token,
        ...(refreshToken !== undefined && { refreshToken }),
        tokenExpireIn: expiresIn(3600_000),
        refreshTokenExpiresIn: null,
        profile: { inn, displayName: 'Иванов И. И.' },
    };
}

export function makeClient(
    handler: Handler,
    options: Partial<LknpdClientOptions> & { session?: Session | null } = {}
) {
    const { fetch, calls } = fakeFetch(handler);
    const { session = makeSession(), ...rest } = options;
    const store = new MemoryTokenStore(session);
    const client = new LknpdClient({
        deviceId: 'device-1',
        timezone: 'Europe/Moscow',
        fetch,
        tokenStore: store,
        ...rest,
    });
    return { client, calls, store };
}

export function incomeItem(overrides: Record<string, unknown> = {}) {
    return {
        approvedReceiptUuid: '20abcdef12',
        name: 'Подписка Pro, 1 месяц',
        services: [{ name: 'Подписка Pro, 1 месяц', amount: 149, quantity: 1, serviceNumber: 0 }],
        operationTime: '2026-11-01T01:30:00+03:00',
        requestTime: '2026-11-01T01:30:02+03:00',
        registerTime: '2026-11-01T01:30:03.123+03:00',
        taxPeriodId: '202611',
        paymentType: 'CASH',
        incomeType: 'FROM_INDIVIDUAL',
        totalAmount: 149,
        cancellationInfo: null,
        sourceDeviceId: 'device-1',
        ...overrides,
    };
}
