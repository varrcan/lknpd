import { protocolError, validationError } from './errors.js';
import { formatKopecks, parseAmount, kopecksFromResponse, type Amount } from './money.js';
import { isRecord, parseIncome, type Income } from './models.js';
import { DEFAULT_BASE_URL, receiptPrintUrl, trimSlash } from './receipt-url.js';
import { MemoryTokenStore, SessionManager, type Session, type TokenStore } from './session.js';
import { assertTimeZone, formatInZone, parseResponseTime } from './time.js';
import { Transport, expectObject, type FetchLike, type RequestEvent } from './transport.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const APP_VERSION = '1.0.0';

export interface Credentials {
    inn: string;
    password: string;
}

export interface LknpdClientOptions {
    /** Стабильный идентификатор устройства: свой на каждого потребителя ИНН, один между рестартами. */
    deviceId: string;
    /** IANA-зона самозанятого: в ней формируется время чека. */
    timezone: string;
    /** По умолчанию — `MemoryTokenStore` (сессия живёт только в процессе). */
    tokenStore?: TokenStore;
    /** Для входа по паролю, в том числе автоматического при отозванном refresh-токене. */
    credentials?: Credentials;
    baseUrl?: string;
    /** База ссылок на печатную форму для покупателя; от `baseUrl` не зависит. */
    receiptBaseUrl?: string;
    fetch?: FetchLike;
    timeoutMs?: number;
    userAgent?: string;
    onRequest?: (event: RequestEvent) => void;
}

export type IncomeType = 'FROM_INDIVIDUAL' | 'FROM_LEGAL_ENTITY' | 'FROM_FOREIGN_AGENCY';
export type PaymentType = 'CASH' | 'ACCOUNT';

export interface IncomeItem {
    name: string;
    /** Цена за единицу. */
    amount: Amount;
    /** Целое ≥ 1, по умолчанию 1. */
    quantity?: number;
}

export interface IncomeClient {
    incomeType: IncomeType;
    /** Для `FROM_LEGAL_ENTITY` — обязателен, 10 или 12 цифр. */
    inn?: string;
    /** Для `FROM_LEGAL_ENTITY` — обязательно. */
    displayName?: string;
    contactPhone?: string;
}

export interface CreateIncomeParams {
    items: readonly IncomeItem[];
    /** Момент оплаты; по умолчанию — сейчас. */
    operationTime?: Date;
    /** По умолчанию — физлицо. */
    client?: IncomeClient;
    paymentType?: PaymentType;
}

export interface CreateIncomeResult {
    receiptUuid: string;
    printUrl: string;
    /** Отправленное время операции, `YYYY-MM-DDTHH:mm:ss±HH:MM` — часть отпечатка для сверки. */
    operationTime: string;
    /** Отправленная сумма, `"N.NN"`. */
    totalAmount: string;
    raw: Record<string, unknown>;
}

export type CancelReason = 'refund' | 'mistake';

export interface CancelIncomeParams {
    receiptUuid: string;
    reason: CancelReason;
    /** По умолчанию — сейчас. */
    operationTime?: Date;
}

export interface CancelIncomeResult {
    receiptUuid: string;
    raw: Record<string, unknown>;
}

export type IncomeSort =
    'operation_time:desc' | 'operation_time:asc' | 'total_amount:desc' | 'total_amount:asc';

export interface ListIncomesParams {
    from?: Date;
    to?: Date;
    offset?: number;
    /** Зажимается в 1–100, по умолчанию 100. */
    limit?: number;
    sortBy?: IncomeSort;
    buyerType?: 'PERSON' | 'COMPANY' | 'FOREIGN_AGENCY';
    receiptType?: 'REGISTERED' | 'CANCELLED';
}

export interface IncomeList {
    items: Income[];
    hasMore: boolean;
    offset: number;
    limit: number;
    raw: Record<string, unknown>;
}

export interface IncomeFingerprint {
    /** До секунды; строка — в формате с оффсетом, как `CreateIncomeResult.operationTime`. */
    operationTime: Date | string;
    totalAmount: Amount;
    /** Наименования позиций; порядок не важен. */
    names: readonly string[];
}

export interface SmsChallenge {
    challengeToken: string;
    expireDate: string;
    /** Секунды. */
    expireIn: number;
}

export interface SmsLoginParams {
    phone: string;
    challengeToken: string;
    code: string;
}

const CANCEL_COMMENTS: Record<CancelReason, string> = {
    refund: 'Возврат средств',
    mistake: 'Чек сформирован ошибочно',
};

const INCOME_TYPES: ReadonlySet<string> = new Set([
    'FROM_INDIVIDUAL',
    'FROM_LEGAL_ENTITY',
    'FROM_FOREIGN_AGENCY',
]);

const PAYMENT_TYPES: ReadonlySet<string> = new Set(['CASH', 'ACCOUNT']);

const MAX_LIST_LIMIT = 100;
const FINGERPRINT_WINDOW_MS = 60_000;

export class LknpdClient {
    readonly #transport: Transport;
    readonly #sessions: SessionManager;
    readonly #store: TokenStore;
    readonly #deviceId: string;
    readonly #timezone: string;
    readonly #userAgent: string;
    readonly #receiptBaseUrl: string;
    readonly #credentials: Credentials | undefined;

    constructor(options: LknpdClientOptions) {
        if (typeof options.deviceId !== 'string' || options.deviceId.trim() === '') {
            throw validationError('deviceId: обязательная непустая строка');
        }
        assertTimeZone(options.timezone);
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw validationError('timeoutMs: ожидается положительное число');
        }
        if (options.credentials) assertCredentials(options.credentials);

        this.#deviceId = options.deviceId;
        this.#timezone = options.timezone;
        this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
        this.#receiptBaseUrl = trimSlash(options.receiptBaseUrl ?? DEFAULT_BASE_URL);
        this.#credentials = options.credentials;
        this.#store = options.tokenStore ?? new MemoryTokenStore();
        this.#transport = new Transport({
            baseUrl: trimSlash(options.baseUrl ?? DEFAULT_BASE_URL),
            // Поздняя привязка: подмена globalThis.fetch после создания клиента тоже работает.
            fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
            timeoutMs,
            userAgent: this.#userAgent,
            onRequest: options.onRequest,
        });

        const credentials = this.#credentials;
        this.#sessions = new SessionManager({
            store: this.#store,
            refresh: session => this.#refresh(session),
            passwordLogin: credentials ? () => this.#passwordLogin(credentials) : null,
        });
    }

    /** Вход по ИНН и паролю; без аргумента — с `credentials` из конфигурации. */
    async loginWithPassword(credentials?: Credentials): Promise<Session> {
        const creds = credentials ?? this.#credentials;
        if (!creds) throw validationError('loginWithPassword: нет ИНН и пароля');
        assertCredentials(creds);
        return this.#sessions.establish(() => this.#passwordLogin(creds));
    }

    /** Шаг 1 входа по SMS. Новый код можно запросить только после истечения прежнего. */
    async requestSmsCode(phone: string): Promise<SmsChallenge> {
        const { body } = await this.#transport.request({
            method: 'POST',
            version: 'v2',
            path: '/auth/challenge/sms/start',
            body: { phone: normalizePhone(phone), requireTpToBeActive: true },
        });
        const data = expectObject(body, 'SMS-вход');
        const { challengeToken, expireDate, expireIn } = data;
        if (
            typeof challengeToken !== 'string' ||
            typeof expireDate !== 'string' ||
            typeof expireIn !== 'number'
        ) {
            throw protocolError('SMS-вход: в ответе нет challengeToken/expireDate/expireIn');
        }
        return { challengeToken, expireDate, expireIn };
    }

    /** Шаг 2 входа по SMS: обмен кода на сессию. */
    async loginWithSms(params: SmsLoginParams): Promise<Session> {
        const phone = normalizePhone(params.phone);
        if (!params.challengeToken || !params.code) {
            throw validationError('loginWithSms: нужны challengeToken и code');
        }
        return this.#sessions.establish(async () => {
            const { body } = await this.#transport.request({
                method: 'POST',
                path: '/auth/challenge/sms/verify',
                body: {
                    phone,
                    code: params.code,
                    challengeToken: params.challengeToken,
                    deviceInfo: this.#deviceInfo(),
                },
            });
            const auth = parseAuthResponse(body, 'SMS-вход');
            if (auth.refreshToken === undefined) {
                throw protocolError('SMS-вход: в ответе нет refreshToken');
            }
            const inn = auth.inn ?? (await this.#fetchInn(auth.token));
            return {
                token: auth.token,
                refreshToken: auth.refreshToken,
                tokenExpireIn: auth.tokenExpireIn,
                inn,
            };
        });
    }

    async createIncome(params: CreateIncomeParams): Promise<CreateIncomeResult> {
        // Входные гарды рассчитаны и на JS-потребителей без проверки типов.
        const rawItems: unknown = params.items;
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
            throw validationError('createIncome: нужна хотя бы одна позиция');
        }
        const items = rawItems as readonly IncomeItem[];
        let total = 0n;
        const services = items.map((item, i) => {
            const field = `items[${i}]`;
            if (typeof item.name !== 'string' || item.name.trim() === '') {
                throw validationError(`${field}.name: пустое наименование`);
            }
            const quantity = item.quantity ?? 1;
            if (!Number.isSafeInteger(quantity) || quantity < 1) {
                throw validationError(`${field}.quantity: ожидается целое ≥ 1`);
            }
            const kopecks = parseAmount(item.amount, `${field}.amount`);
            total += kopecks * BigInt(quantity);
            return { name: item.name, amount: formatKopecks(kopecks), quantity };
        });
        const client = buildIncomeClient(params.client);
        const paymentType = params.paymentType ?? 'CASH';
        if (!PAYMENT_TYPES.has(paymentType)) {
            throw validationError('paymentType: ожидается CASH или ACCOUNT');
        }
        const operationTime = this.#time(params.operationTime ?? new Date());
        const totalAmount = formatKopecks(total);

        return this.#sessions.run(async session => {
            const { body } = await this.#transport.request({
                method: 'POST',
                path: '/income',
                token: session.token,
                body: {
                    operationTime,
                    requestTime: this.#time(new Date()),
                    services,
                    totalAmount,
                    client,
                    paymentType,
                    ignoreMaxTotalIncomeRestriction: false,
                },
            });
            const data = expectObject(body, 'createIncome');
            const receiptUuid = data.approvedReceiptUuid;
            if (typeof receiptUuid !== 'string' || receiptUuid === '') {
                throw protocolError('createIncome: в ответе нет approvedReceiptUuid');
            }
            return {
                receiptUuid,
                printUrl: receiptPrintUrl(session.inn, receiptUuid, this.#receiptBaseUrl),
                operationTime,
                totalAmount,
                raw: data,
            };
        });
    }

    async cancelIncome(params: CancelIncomeParams): Promise<CancelIncomeResult> {
        if (typeof params.receiptUuid !== 'string' || params.receiptUuid.trim() === '') {
            throw validationError('cancelIncome: пустой receiptUuid');
        }
        if (!Object.hasOwn(CANCEL_COMMENTS, params.reason)) {
            throw validationError('cancelIncome: причина — refund или mistake');
        }
        const comment = CANCEL_COMMENTS[params.reason];
        const operationTime = this.#time(params.operationTime ?? new Date());

        return this.#sessions.run(async session => {
            const { body } = await this.#transport.request({
                method: 'POST',
                path: '/cancel',
                token: session.token,
                body: {
                    operationTime,
                    requestTime: this.#time(new Date()),
                    comment,
                    receiptUuid: params.receiptUuid,
                    partnerCode: null,
                },
            });
            const data = expectObject(body, 'cancelIncome');
            if (!isRecord(data.incomeInfo)) {
                throw protocolError('cancelIncome: в ответе нет incomeInfo');
            }
            return { receiptUuid: params.receiptUuid, raw: data };
        });
    }

    async listIncomes(params: ListIncomesParams = {}): Promise<IncomeList> {
        const offset = params.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw validationError('listIncomes: offset — целое ≥ 0');
        }
        const rawLimit = params.limit ?? MAX_LIST_LIMIT;
        if (!Number.isFinite(rawLimit)) throw validationError('listIncomes: limit — число');
        const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(rawLimit)));
        const query = {
            from: params.from && this.#time(params.from, true),
            to: params.to && this.#time(params.to, true),
            offset,
            limit,
            sortBy: params.sortBy ?? 'operation_time:desc',
            buyerType: params.buyerType,
            receiptType: params.receiptType,
        };

        return this.#sessions.run(async session => {
            const { body } = await this.#transport.request({
                method: 'GET',
                path: '/incomes',
                token: session.token,
                query,
            });
            const data = expectObject(body, 'listIncomes');
            if (!Array.isArray(data.content) || typeof data.hasMore !== 'boolean') {
                throw protocolError('listIncomes: в ответе нет content/hasMore');
            }
            return {
                items: data.content.map((item: unknown) => parseIncome(item, 'listIncomes')),
                hasMore: data.hasMore,
                offset,
                limit,
                raw: data,
            };
        });
    }

    /**
     * Все чеки с тем же отпечатком (секунда операции, сумма, наименования), включая
     * аннулированные. Решение «0 — пробить, 1 — принять, больше — к человеку» — за вызывающим.
     */
    async findIncomes(fingerprint: IncomeFingerprint): Promise<Income[]> {
        const at =
            typeof fingerprint.operationTime === 'string'
                ? parseFingerprintTime(fingerprint.operationTime)
                : fingerprint.operationTime;
        if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
            throw validationError('findIncomes: невалидное operationTime');
        }
        const kopecks = parseAmount(fingerprint.totalAmount, 'findIncomes: totalAmount');
        const second = Math.floor(at.getTime() / 1000);
        const names = normalizeNames(fingerprint.names);
        const from = new Date(at.getTime() - FINGERPRINT_WINDOW_MS);
        const to = new Date(at.getTime() + FINGERPRINT_WINDOW_MS);

        const matches: Income[] = [];
        for (let offset = 0; ;) {
            const page = await this.listIncomes({
                from,
                to,
                offset,
                limit: MAX_LIST_LIMIT,
                sortBy: 'operation_time:asc',
            });
            for (const income of page.items) {
                if (
                    Math.floor(income.operationTime.getTime() / 1000) === second &&
                    kopecksFromResponse(income.totalAmount, 'totalAmount') === kopecks &&
                    sameNames(normalizeNames(income.services.map(s => s.name)), names)
                ) {
                    matches.push(income);
                }
            }
            if (!page.hasMore) return matches;
            if (page.items.length === 0) {
                throw protocolError('findIncomes: hasMore при пустой странице');
            }
            offset += page.items.length;
        }
    }

    /** Данные чека (JSON) по ИНН текущей сессии. */
    async getReceipt(receiptUuid: string): Promise<Income> {
        if (typeof receiptUuid !== 'string' || receiptUuid.trim() === '') {
            throw validationError('getReceipt: пустой номер чека');
        }
        return this.#sessions.run(async session => {
            const { body } = await this.#transport.request({
                method: 'GET',
                path: `/receipt/${encodeURIComponent(session.inn)}/${encodeURIComponent(receiptUuid)}/json`,
                token: session.token,
            });
            return parseIncome(body, 'getReceipt');
        });
    }

    /** Ссылка на печатную форму на `receiptBaseUrl` конфигурации. */
    receiptPrintUrl(inn: string, receiptUuid: string): string {
        return receiptPrintUrl(inn, receiptUuid, this.#receiptBaseUrl);
    }

    #time(date: Date, withMillis = false): string {
        return formatInZone(date, this.#timezone, withMillis);
    }

    #deviceInfo() {
        return {
            sourceType: 'WEB',
            sourceDeviceId: this.#deviceId,
            appVersion: APP_VERSION,
            metaDetails: { userAgent: this.#userAgent },
        };
    }

    async #passwordLogin(credentials: Credentials): Promise<Session> {
        const { body } = await this.#transport.request({
            method: 'POST',
            path: '/auth/lkfl',
            // Поле логина — `username`: на `inn` ФНС отвечает 422 «Не передан ИНН ЛКФЛ» (спайк 2.1).
            body: {
                username: credentials.inn,
                password: credentials.password,
                deviceInfo: this.#deviceInfo(),
            },
        });
        const auth = parseAuthResponse(body, 'Вход по паролю');
        if (auth.refreshToken === undefined) {
            throw protocolError('Вход по паролю: в ответе нет refreshToken');
        }
        return {
            token: auth.token,
            refreshToken: auth.refreshToken,
            tokenExpireIn: auth.tokenExpireIn,
            inn: auth.inn ?? credentials.inn,
        };
    }

    async #refresh(session: Session): Promise<Session> {
        const { body } = await this.#transport.request({
            method: 'POST',
            path: '/auth/token',
            body: { deviceInfo: this.#deviceInfo(), refreshToken: session.refreshToken },
        });
        const auth = parseAuthResponse(body, 'Обновление токена');
        return {
            token: auth.token,
            refreshToken: auth.refreshToken ?? session.refreshToken,
            tokenExpireIn: auth.tokenExpireIn,
            inn: auth.inn ?? session.inn,
        };
    }

    async #fetchInn(token: string): Promise<string> {
        const { body } = await this.#transport.request({ method: 'GET', path: '/user', token });
        const { inn } = expectObject(body, 'Профиль');
        if (typeof inn !== 'string' || inn === '') throw protocolError('Профиль: нет ИНН');
        return inn;
    }
}

interface AuthResponse {
    token: string;
    refreshToken?: string;
    tokenExpireIn: string;
    inn?: string;
}

function parseAuthResponse(body: unknown, what: string): AuthResponse {
    const data = expectObject(body, what);
    const { token, refreshToken, tokenExpireIn, profile } = data;
    if (typeof token !== 'string' || token === '' || typeof tokenExpireIn !== 'string') {
        throw protocolError(`${what}: в ответе нет token/tokenExpireIn`);
    }
    const result: AuthResponse = { token, tokenExpireIn };
    if (typeof refreshToken === 'string' && refreshToken !== '') result.refreshToken = refreshToken;
    if (isRecord(profile) && typeof profile.inn === 'string' && profile.inn !== '') {
        result.inn = profile.inn;
    }
    return result;
}

function assertCredentials(credentials: Credentials): void {
    if (typeof credentials.inn !== 'string' || !/^\d{12}$/.test(credentials.inn)) {
        throw validationError('credentials.inn: ИНН физлица — 12 цифр');
    }
    if (typeof credentials.password !== 'string' || credentials.password === '') {
        throw validationError('credentials.password: пустой пароль');
    }
}

export function normalizePhone(phone: string): string {
    const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
    const normalized =
        digits.length === 10
            ? `7${digits}`
            : digits.length === 11 && digits.startsWith('8')
              ? `7${digits.slice(1)}`
              : digits;
    if (!/^7\d{10}$/.test(normalized)) {
        throw validationError('phone: ожидается российский номер, например +7 900 000-00-00');
    }
    return normalized;
}

function buildIncomeClient(client: IncomeClient | undefined) {
    const incomeType = client?.incomeType ?? 'FROM_INDIVIDUAL';
    if (!INCOME_TYPES.has(incomeType)) {
        throw validationError(`client.incomeType: неизвестный тип "${incomeType}"`);
    }
    if (incomeType === 'FROM_LEGAL_ENTITY') {
        if (typeof client?.inn !== 'string' || !/^(\d{10}|\d{12})$/.test(client.inn)) {
            throw validationError('client.inn: для юрлица ИНН из 10 или 12 цифр обязателен');
        }
        if (typeof client.displayName !== 'string' || client.displayName.trim() === '') {
            throw validationError('client.displayName: для юрлица наименование обязательно');
        }
    }
    return {
        contactPhone: client?.contactPhone ?? null,
        displayName: client?.displayName ?? null,
        incomeType,
        inn: client?.inn ?? null,
    };
}

function parseFingerprintTime(value: string): Date {
    try {
        return parseResponseTime(value, 'findIncomes: operationTime');
    } catch {
        throw validationError('findIncomes: operationTime — время с оффсетом');
    }
}

function normalizeNames(names: readonly string[]): string[] {
    return names.map(name => name.trim()).sort();
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((name, i) => name === b[i]);
}
