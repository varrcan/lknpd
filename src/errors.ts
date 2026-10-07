export type ErrorKind = 'network' | 'timeout' | 'http' | 'auth' | 'validation' | 'protocol';

/**
 * Что известно о запросе к ФНС:
 * - `not-sent` — сервер его точно не получил, повтор безопасен;
 * - `maybe-sent` — мог быть обработан, перед повтором нужна сверка;
 * - `rejected` — сервер обработал и отказал, дохода нет.
 */
export type ErrorOutcome = 'not-sent' | 'maybe-sent' | 'rejected';

export interface LknpdErrorOptions {
    kind: ErrorKind;
    outcome: ErrorOutcome;
    status?: number;
    code?: string;
    fnsMessage?: string;
    cause?: unknown;
}

export interface LknpdErrorJSON {
    name: 'LknpdError';
    message: string;
    kind: ErrorKind;
    outcome: ErrorOutcome;
    status?: number;
    code?: string;
    fnsMessage?: string;
}

// Symbol.for, а не instanceof: при двух копиях пакета в дереве (ESM + CJS, разные версии)
// классы различаются, а глобальный символ — общий.
const BRAND = Symbol.for('lknpd.error');

export class LknpdError extends Error {
    override readonly name = 'LknpdError';
    readonly kind: ErrorKind;
    readonly outcome: ErrorOutcome;
    readonly status?: number;
    readonly code?: string;
    readonly fnsMessage?: string;

    constructor(message: string, options: LknpdErrorOptions) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        Object.defineProperty(this, BRAND, { value: true });
        this.kind = options.kind;
        this.outcome = options.outcome;
        if (options.status !== undefined) this.status = options.status;
        if (options.code !== undefined) this.code = options.code;
        if (options.fnsMessage !== undefined) this.fnsMessage = options.fnsMessage;
    }

    toJSON(): LknpdErrorJSON {
        const json: LknpdErrorJSON = {
            name: this.name,
            message: this.message,
            kind: this.kind,
            outcome: this.outcome,
        };
        if (this.status !== undefined) json.status = this.status;
        if (this.code !== undefined) json.code = this.code;
        if (this.fnsMessage !== undefined) json.fnsMessage = this.fnsMessage;
        return json;
    }
}

export function isLknpdError(value: unknown): value is LknpdError {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<symbol, unknown>)[BRAND] === true
    );
}

export function validationError(message: string): LknpdError {
    return new LknpdError(message, { kind: 'validation', outcome: 'not-sent' });
}

export function protocolError(message: string): LknpdError {
    return new LknpdError(message, { kind: 'protocol', outcome: 'maybe-sent' });
}
