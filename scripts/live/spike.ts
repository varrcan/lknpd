/**
 * Живой спайк к API ФНС (tasks.md, раздел 2). Запускать вручную, по шагам. Фиктивных чеков
 * не создаёт: чек — это заявленный доход (422-ФЗ), поэтому создание и аннулирование
 * проверяются только на настоящей оплате и настоящем возврате.
 *
 *   bun scripts/live/spike.ts login          # 2.1
 *   bun scripts/live/spike.ts devices        # 2.2
 *   bun scripts/live/spike.ts save-session   # 2.3, на первой машине/IP
 *   bun scripts/live/spike.ts use-session    # 2.3, на машине с другим egress-IP
 *   bun scripts/live/spike.ts rotation       # 2.4
 *   bun scripts/live/spike.ts observe        # 2.5–2.8 только чтение, по существующим чекам
 *   bun scripts/live/spike.ts real-income …  # 2.5 на настоящей оплате, вместо ручного пробития
 *   bun scripts/live/spike.ts real-cancel …  # 2.7 на настоящем возврате
 *
 * bun сам читает .env: LKNPD_INN, LKNPD_PASSWORD, LKNPD_TZ (по умолчанию Europe/Moscow).
 * Токены в вывод не попадают.
 */
/// <reference types="node" />
import { readFileSync, writeFileSync } from 'node:fs';
import { LknpdClient, MemoryTokenStore, isLknpdError, type Session } from '../../src';
import { formatInZone } from '../../src/time.js';

const BASE = 'https://lknpd.nalog.ru/api';
const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SESSION_FILE = '.live-session.json';

const INN = env('LKNPD_INN');
const PASSWORD = env('LKNPD_PASSWORD');
const TZ = process.env.LKNPD_TZ ?? 'Europe/Moscow';

function env(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Нет ${name} в окружении (.env)`);
    return value;
}

const SECRET_KEYS = new Set(['token', 'refreshToken', 'challengeToken', 'password']);

function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
            k,
            SECRET_KEYS.has(k) && typeof v === 'string' ? `<${k}: ${v.length} симв.>` : redact(v),
        ])
    );
}

function show(label: string, value: unknown): void {
    console.log(`\n== ${label}\n${JSON.stringify(redact(value), null, 2)}`);
}

function deviceInfo(deviceId: string) {
    return {
        sourceType: 'WEB',
        sourceDeviceId: deviceId,
        appVersion: '1.0.0',
        metaDetails: { userAgent: UA },
    };
}

async function raw(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string; referer?: boolean } = {}
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    const headers: Record<string, string> = {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'User-Agent': UA,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.referer) headers.Referer = 'https://lknpd.nalog.ru/auth/login';
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetch(`${BASE}${path}`, init);
    const text = await res.text();
    let body: unknown = text;
    try {
        body = JSON.parse(text);
    } catch {
        // не JSON — оставляем текст
    }
    return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}

async function passwordLogin(deviceId: string, field: 'username' | 'inn', referer = true) {
    return raw('POST', '/v1/auth/lkfl', {
        body: { [field]: INN, password: PASSWORD, deviceInfo: deviceInfo(deviceId) },
        referer,
    });
}

function tokens(body: unknown): { token: string; refreshToken: string } {
    const b = body as { token?: string; refreshToken?: string };
    if (!b.token || !b.refreshToken) throw new Error('В ответе нет токенов');
    return { token: b.token, refreshToken: b.refreshToken };
}

const steps: Record<string, () => Promise<void>> = {
    // 2.1 Поле логина, форма ответа, нужен ли Referer.
    async login() {
        const device = `spike-login-${Date.now()}`;
        const byUsername = await passwordLogin(device, 'username');
        show(`username + Referer → ${byUsername.status}`, byUsername.body);
        const byInn = await passwordLogin(device, 'inn');
        show(`inn + Referer → ${byInn.status}`, byInn.body);
        const noReferer = await passwordLogin(device, 'username', false);
        show(`username без Referer → ${noReferer.status}`, noReferer.body);
        const ok = [byUsername, byInn, noReferer].find(r => r.status === 200);
        if (ok) {
            show('ключи ответа входа', Object.keys(ok.body as object));
            show('profile', (ok.body as { profile?: unknown }).profile ?? null);
        }
    },

    // 2.2 Инвалидация при входе с другого deviceId.
    async devices() {
        const a = tokens((await passwordLogin('spike-device-A', 'username')).body);
        const userA1 = await raw('GET', '/v1/user', { token: a.token });
        console.log(`токен A сразу после входа A: ${userA1.status}`);
        const b = tokens((await passwordLogin('spike-device-B', 'username')).body);
        const userA2 = await raw('GET', '/v1/user', { token: a.token });
        console.log(`токен A после входа B: ${userA2.status}`);
        const userB = await raw('GET', '/v1/user', { token: b.token });
        console.log(`токен B: ${userB.status}`);
        const refreshA = await raw('POST', '/v1/auth/token', {
            body: { deviceInfo: deviceInfo('spike-device-A'), refreshToken: a.refreshToken },
            referer: true,
        });
        show(`refresh A после входа B → ${refreshA.status}`, refreshA.body);
        await passwordLogin('spike-device-A', 'username');
        const userA3 = await raw('GET', '/v1/user', { token: a.token });
        console.log(`старый токен A после повторного входа A: ${userA3.status}`);
    },

    // 2.3 Привязка к IP, шаг 1: сохранить сессию.
    async 'save-session'() {
        const t = tokens((await passwordLogin('spike-ip', 'username')).body);
        writeFileSync(SESSION_FILE, JSON.stringify(t), { mode: 0o600 });
        const ip = await fetch('https://api.ipify.org').then(r => r.text());
        console.log(`Сессия сохранена в ${SESSION_FILE} (НЕ коммитить), egress-IP: ${ip}`);
    },

    // 2.3 Привязка к IP, шаг 2: использовать с другого IP.
    async 'use-session'() {
        const t = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as {
            token: string;
            refreshToken: string;
        };
        const ip = await fetch('https://api.ipify.org').then(r => r.text());
        console.log(`egress-IP: ${ip}`);
        const user = await raw('GET', '/v1/user', { token: t.token });
        console.log(`/v1/user с чужого IP: ${user.status}`);
        const refresh = await raw('POST', '/v1/auth/token', {
            body: { deviceInfo: deviceInfo('spike-ip'), refreshToken: t.refreshToken },
            referer: true,
        });
        show(`refresh с чужого IP → ${refresh.status}`, refresh.body);
    },

    // 2.4 Ротация refresh-токена.
    async rotation() {
        const device = 'spike-rotation';
        const t = tokens((await passwordLogin(device, 'username')).body);
        const first = await raw('POST', '/v1/auth/token', {
            body: { deviceInfo: deviceInfo(device), refreshToken: t.refreshToken },
            referer: true,
        });
        show(`refresh #1 → ${first.status}`, first.body);
        const b = first.body as { refreshToken?: string };
        console.log(
            `refreshToken в ответе: ${b.refreshToken ? 'есть' : 'нет'}; ` +
                `совпадает с прежним: ${String(b.refreshToken === t.refreshToken)}`
        );
        const again = await raw('POST', '/v1/auth/token', {
            body: { deviceInfo: deviceInfo(device), refreshToken: t.refreshToken },
            referer: true,
        });
        show(`refresh прежним refreshToken → ${again.status}`, again.body);
        const oldAccess = await raw('GET', '/v1/user', { token: t.token });
        console.log(`прежний access-токен после refresh: ${oldAccess.status}`);
    },

    // 2.5–2.8 только чтение, на уже существующих настоящих чеках: формат времени и сумм,
    // фильтр окна, поиск по отпечатку, печатная форма, JSON, cancellationInfo, форма 4xx.
    // LKNPD_RECEIPT_UUID — какой чек разбирать; по умолчанию самый свежий.
    async observe() {
        const { client, store } = makeClient('spike-observe');
        const page = await client.listIncomes({ limit: 20 });
        const session = (await store.load()) as Session;
        if (page.items.length === 0) throw new Error('В кабинете нет чеков — разбирать нечего');
        show('2.5 сырой элемент списка', page.items[0]?.raw);

        const wanted = process.env.LKNPD_RECEIPT_UUID;
        const income = wanted ? await client.getReceipt(wanted) : page.items[0];
        if (!income) throw new Error('Чек не найден');
        const at = income.operationTime;
        console.log(
            `\nЧек ${income.receiptUuid}: operationTime ${String(income.raw.operationTime)}`
        );

        const window = await raw(
            'GET',
            `/v1/incomes?from=${encodeURIComponent(fmt(at, -60_000))}&to=${encodeURIComponent(fmt(at, 60_000))}&offset=0&limit=100&sortBy=operation_time:asc`,
            { token: session.token }
        );
        const content = (window.body as { content?: { approvedReceiptUuid?: string }[] }).content;
        console.log(
            `2.5 окно ±1 мин по operationTime → ${window.status}, чеков: ${content?.length ?? '?'}, ` +
                `наш внутри: ${String(content?.some(c => c.approvedReceiptUuid === income.receiptUuid))}`
        );
        const found = await client.findIncomes({
            operationTime: at,
            totalAmount: income.totalAmount,
            names: income.services.map(service => service.name),
        });
        console.log(`2.5 findIncomes по отпечатку: ${found.length} совпадений (ожидается ≥ 1)`);

        const print = await fetch(client.receiptPrintUrl(session.inn, income.receiptUuid));
        console.log(
            `2.6 печатная форма без авторизации: ${print.status} ${print.headers.get('content-type') ?? ''}`
        );
        const json = await raw('GET', `/v1/receipt/${session.inn}/${income.receiptUuid}/json`, {
            token: session.token,
        });
        show(`2.6 JSON чека → ${json.status}`, json.body);

        const cancelled = await client.listIncomes({ receiptType: 'CANCELLED', limit: 1 });
        show(
            '2.7 аннулированный чек из истории (если есть)',
            cancelled.items[0]?.raw.cancellationInfo ?? 'аннулированных чеков нет'
        );

        const missing = await raw('GET', `/v1/receipt/${session.inn}/0000000000/json`, {
            token: session.token,
        });
        show(`2.8 несуществующий чек → ${missing.status}`, {
            body: missing.body,
            headers: missing.headers,
        });
    },

    // Только для НАСТОЯЩЕЙ оплаты — вместо ручного пробития, не в дополнение к нему.
    //   bun scripts/live/spike.ts real-income 'Наименование' 149.00 2026-10-08T12:34:56+03:00
    async 'real-income'() {
        const [name, amount, paidAt] = process.argv.slice(3);
        if (!name || !amount || !paidAt) {
            throw new Error('Аргументы: наименование, сумма, момент оплаты с оффсетом');
        }
        const operationTime = new Date(paidAt);
        if (Number.isNaN(operationTime.getTime())) throw new Error('Неверный момент оплаты');
        const { client, store } = makeClient('spike-real-income');
        const created = await client.createIncome({ items: [{ name, amount }], operationTime });
        show('2.5 создан', created);
        const session = (await store.load()) as Session;
        const window = await raw(
            'GET',
            `/v1/incomes?from=${encodeURIComponent(fmt(operationTime, -60_000))}&to=${encodeURIComponent(fmt(operationTime, 60_000))}&offset=0&limit=100&sortBy=operation_time:asc`,
            { token: session.token }
        );
        show(`2.5 сырой список сразу после создания → ${window.status}`, window.body);
        const found = await client.findIncomes({
            operationTime: created.operationTime,
            totalAmount: created.totalAmount,
            names: [name],
        });
        console.log(`2.5 findIncomes: ${found.length} совпадений`);
        const print = await fetch(created.printUrl);
        console.log(`2.6 печатная форма без авторизации: ${print.status}`);
    },

    // Только для НАСТОЯЩЕГО возврата или реально ошибочного чека.
    //   bun scripts/live/spike.ts real-cancel 20abcdef12 refund
    async 'real-cancel'() {
        const [receiptUuid, reason] = process.argv.slice(3);
        if (!receiptUuid || (reason !== 'refund' && reason !== 'mistake')) {
            throw new Error('Аргументы: номер чека, refund | mistake');
        }
        const { client } = makeClient('spike-real-cancel');
        const result = await client.cancelIncome({ receiptUuid, reason });
        show('2.7 ответ аннулирования', result.raw);
        const after = await client.getReceipt(receiptUuid);
        show('2.7 чек после аннулирования', { cancelled: after.cancelled, c: after.cancellation });
    },
};

function makeClient(deviceId: string) {
    const store = new MemoryTokenStore();
    const client = new LknpdClient({
        deviceId,
        timezone: TZ,
        tokenStore: store,
        credentials: { inn: INN, password: PASSWORD },
        onRequest: e => {
            console.log(`  ${e.method} ${e.path} → ${e.status ?? '-'} ${e.durationMs} мс`);
        },
    });
    return { client, store };
}

function fmt(at: Date, shiftMs: number): string {
    return formatInZone(new Date(at.getTime() + shiftMs), TZ, true);
}

const step = process.argv[2] ?? '';
const run = steps[step];
if (!run) {
    console.error(`Шаги: ${Object.keys(steps).join(', ')}`);
    process.exit(1);
}
run().catch((error: unknown) => {
    if (isLknpdError(error)) console.error(JSON.stringify(error, null, 2));
    else console.error(error);
    process.exit(1);
});
