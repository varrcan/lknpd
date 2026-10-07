import { LknpdError, isLknpdError } from './errors.js';

export interface Session {
    token: string;
    refreshToken: string;
    /** Момент истечения access-токена, как его отдал сервер (ISO-строка). */
    tokenExpireIn: string;
    inn: string;
}

/**
 * Хранилище сессии потребителя. Пакет сам состояние не держит: в k8s файл умирает с подом,
 * а сервисы одного ИНН должны видеть одну сессию.
 */
export interface TokenStore {
    load(): Promise<Session | null>;
    save(session: Session): Promise<void>;
    /**
     * Межпроцессная блокировка вокруг обновления и входа для процессов, делящих один стор:
     * без неё каждый обновляет токен сам, и обновлений больше, чем нужно.
     */
    withRefreshLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export class MemoryTokenStore implements TokenStore {
    #session: Session | null;

    constructor(session: Session | null = null) {
        this.#session = session;
    }

    load(): Promise<Session | null> {
        return Promise.resolve(this.#session && { ...this.#session });
    }

    save(session: Session): Promise<void> {
        this.#session = { ...session };
        return Promise.resolve();
    }
}

const REFRESH_AHEAD_MS = 60_000;

export interface SessionManagerDeps {
    store: TokenStore;
    refresh: (session: Session) => Promise<Session>;
    /** null — пароля в конфигурации нет. */
    passwordLogin: (() => Promise<Session>) | null;
}

export class SessionManager {
    readonly #deps: SessionManagerDeps;
    #inflight: Promise<Session> | null = null;

    constructor(deps: SessionManagerDeps) {
        this.#deps = deps;
    }

    /**
     * Вызов с токеном: упреждающее обновление перед ним, при 401 — одно обновление
     * (или подхват чужого) и один повтор.
     */
    async run<T>(call: (session: Session) => Promise<T>): Promise<T> {
        const session = await beforeCall(this.#acquire());
        try {
            return await call(session);
        } catch (error) {
            if (!isUnauthorized(error)) throw error;
        }
        const renewed = await beforeCall(this.#renew(session.token));
        try {
            return await call(renewed);
        } catch (error) {
            if (!isUnauthorized(error)) throw error;
            throw new LknpdError('Сервер отклонил токен и после обновления (401)', {
                kind: 'auth',
                outcome: 'rejected',
                status: 401,
            });
        }
    }

    /** Сохранить сессию, полученную явным входом, без гонки с идущим обновлением. */
    async establish(login: () => Promise<Session>): Promise<Session> {
        return this.#locked(async () => {
            const session = await login();
            await this.#deps.store.save(session);
            return session;
        });
    }

    async #acquire(): Promise<Session> {
        const session = await this.#deps.store.load();
        if (session && !expiresSoon(session)) return session;
        return this.#renew(session?.token ?? null);
    }

    /** Single-flight: одновременные вызовы процесса ждут одно обновление. */
    async #renew(staleToken: string | null): Promise<Session> {
        while (this.#inflight) {
            const session = await this.#inflight;
            if (session.token !== staleToken) return session;
        }
        const pending = this.#locked(() => this.#renewLocked(staleToken));
        this.#inflight = pending;
        try {
            return await pending;
        } finally {
            if (this.#inflight === pending) this.#inflight = null;
        }
    }

    async #renewLocked(staleToken: string | null): Promise<Session> {
        const { store, refresh, passwordLogin } = this.#deps;
        // Внутри блокировки стор перечитывается: пока ждали, сессию мог обновить другой
        // процесс или вызов, и второй refresh не нужен. Сейчас ФНС refresh-токен не ротирует
        // (спайк 2.4), но если начнёт — refresh на устаревшем токене упал бы 4xx и увёл бы
        // в лишний вход по паролю.
        const current = await store.load();
        if (current && current.token !== staleToken && !expiresSoon(current)) return current;

        let refreshRejection: LknpdError | undefined;
        if (current) {
            try {
                const renewed = await refresh(current);
                await store.save(renewed);
                return renewed;
            } catch (error) {
                // 429 — ограничение частоты, а не отказ refresh: вход по паролю ударил бы в тот же
                // лимит, а потребителю нужно подождать, а не чинить авторизацию.
                if (!isLknpdError(error) || error.outcome !== 'rejected' || error.status === 429) {
                    throw error;
                }
                refreshRejection = error;
            }
        }

        if (!passwordLogin) {
            if (!refreshRejection) {
                throw new LknpdError('Нет сессии в TokenStore и пароля для входа', {
                    kind: 'auth',
                    outcome: 'rejected',
                });
            }
            const { status, code, fnsMessage } = refreshRejection;
            throw new LknpdError(
                `Обновление токена отклонено, а пароля для повторного входа нет: ${refreshRejection.message}`,
                {
                    kind: 'auth',
                    outcome: 'rejected',
                    ...(status !== undefined && { status }),
                    ...(code !== undefined && { code }),
                    ...(fnsMessage !== undefined && { fnsMessage }),
                    cause: refreshRejection,
                }
            );
        }
        const session = await passwordLogin();
        await store.save(session);
        return session;
    }

    #locked<T>(fn: () => Promise<T>): Promise<T> {
        const { store } = this.#deps;
        return store.withRefreshLock ? store.withRefreshLock(fn) : fn();
    }
}

/**
 * Сбой получения токена — до отправки самого вызова. `maybe-sent` от refresh или входа
 * (таймаут, 5xx) относится к запросу токена, а не к `POST /income`: проброшенный как есть, он
 * отправил бы потребителя сверять чек, которого точно нет.
 */
async function beforeCall(pending: Promise<Session>): Promise<Session> {
    try {
        return await pending;
    } catch (error) {
        if (!isLknpdError(error) || error.outcome !== 'maybe-sent') throw error;
        throw new LknpdError(`Не удалось получить токен, вызов не отправлен: ${error.message}`, {
            kind: error.kind,
            outcome: 'not-sent',
            ...(error.status !== undefined && { status: error.status }),
            ...(error.code !== undefined && { code: error.code }),
            ...(error.fnsMessage !== undefined && { fnsMessage: error.fnsMessage }),
            cause: error,
        });
    }
}

function expiresSoon(session: Session): boolean {
    const expires = Date.parse(session.tokenExpireIn);
    // Неразборчивый срок не повод обновлять на каждом вызове: сработает реактивный путь по 401.
    if (Number.isNaN(expires)) return false;
    return expires - Date.now() < REFRESH_AHEAD_MS;
}

function isUnauthorized(error: unknown): boolean {
    return isLknpdError(error) && error.status === 401;
}
