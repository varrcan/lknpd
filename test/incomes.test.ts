import { describe, expect, it } from 'vitest';
import type { IncomeItem } from '../src/index.js';
import { incomeItem, json, makeClient, type RecordedCall } from './helpers.js';

const created = () => json(200, { approvedReceiptUuid: '20abcdef12' });

function body(call: RecordedCall | undefined): Record<string, unknown> {
    return call?.body as Record<string, unknown>;
}

function query(call: RecordedCall | undefined): URLSearchParams {
    return new URL(call?.url ?? 'http://x').searchParams;
}

describe('createIncome', () => {
    it('одна позиция: quantity 1, totalAmount, receiptUuid, значения по умолчанию', async () => {
        const { client, calls } = makeClient(created);
        const result = await client.createIncome({
            items: [{ name: 'Подписка Pro, 1 месяц', amount: '149.00' }],
            operationTime: new Date('2026-10-31T22:30:00Z'),
        });
        expect(calls[0]?.url).toBe('https://lknpd.nalog.ru/api/v1/income');
        expect(body(calls[0])).toMatchObject({
            operationTime: '2026-11-01T01:30:00+03:00',
            services: [{ name: 'Подписка Pro, 1 месяц', amount: '149.00', quantity: 1 }],
            totalAmount: '149.00',
            client: {
                contactPhone: null,
                displayName: null,
                incomeType: 'FROM_INDIVIDUAL',
                inn: null,
            },
            paymentType: 'CASH',
            ignoreMaxTotalIncomeRestriction: false,
        });
        expect(body(calls[0]).requestTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+03:00$/);
        expect(result).toMatchObject({
            receiptUuid: '20abcdef12',
            printUrl: 'https://lknpd.nalog.ru/api/v1/receipt/123456789012/20abcdef12/print',
            operationTime: '2026-11-01T01:30:00+03:00',
            totalAmount: '149.00',
        });
    });

    it('149.90 × 3 → 449.70', async () => {
        const { client, calls } = makeClient(created);
        await client.createIncome({ items: [{ name: 'x', amount: '149.90', quantity: 3 }] });
        expect(body(calls[0]).totalAmount).toBe('449.70');
        expect(body(calls[0]).services).toEqual([{ name: 'x', amount: '149.90', quantity: 3 }]);
    });

    it('копейки и строка суммируются: 150.00', async () => {
        const { client, calls } = makeClient(created);
        await client.createIncome({
            items: [
                { name: 'a', amount: { kopecks: 14990 } },
                { name: 'b', amount: '0.10' },
            ],
        });
        expect(body(calls[0]).totalAmount).toBe('150.00');
    });

    it('время в зоне клиента: Новосибирск', async () => {
        const { client, calls } = makeClient(created, { timezone: 'Asia/Novosibirsk' });
        await client.createIncome({
            items: [{ name: 'x', amount: '1' }],
            operationTime: new Date('2026-10-07T10:00:00Z'),
        });
        expect(body(calls[0]).operationTime).toBe('2026-10-07T17:00:00+07:00');
    });

    it('нулевой оффсет: UTC', async () => {
        const { client, calls } = makeClient(created, { timezone: 'UTC' });
        await client.createIncome({
            items: [{ name: 'x', amount: '1' }],
            operationTime: new Date('2026-01-15T00:00:00Z'),
        });
        expect(body(calls[0]).operationTime).toBe('2026-01-15T00:00:00+00:00');
    });

    it.each<[string, IncomeItem[]]>([
        ['без позиций', []],
        ['пустое наименование', [{ name: '  ', amount: '1' }]],
        ['сумма 149.999', [{ name: 'x', amount: '149.999' }]],
        ['сумма -1', [{ name: 'x', amount: '-1' }]],
        ['сумма 0', [{ name: 'x', amount: '0' }]],
        ['копейки 1.5', [{ name: 'x', amount: { kopecks: 1.5 } }]],
        ['количество 1.5', [{ name: 'x', amount: '1', quantity: 1.5 }]],
        ['количество 0', [{ name: 'x', amount: '1', quantity: 0 }]],
    ])('%s — validation / not-sent, запроса нет', async (_, items) => {
        const { client, calls } = makeClient(created);
        await expect(client.createIncome({ items })).rejects.toMatchObject({
            kind: 'validation',
            outcome: 'not-sent',
        });
        expect(calls).toHaveLength(0);
    });

    it('юрлицо без ИНН — validation, запроса нет', async () => {
        const { client, calls } = makeClient(created);
        await expect(
            client.createIncome({
                items: [{ name: 'x', amount: '1' }],
                client: { incomeType: 'FROM_LEGAL_ENTITY', displayName: 'ООО Ромашка' },
            })
        ).rejects.toMatchObject({ kind: 'validation' });
        expect(calls).toHaveLength(0);
    });

    it.each([
        ['ИНН 11 цифр', { inn: '12345678901', displayName: 'ООО' }],
        ['без наименования', { inn: '1234567890' }],
    ])('юрлицо: %s — validation', async (_, rest) => {
        const { client } = makeClient(created);
        await expect(
            client.createIncome({
                items: [{ name: 'x', amount: '1' }],
                client: { incomeType: 'FROM_LEGAL_ENTITY', ...rest },
            })
        ).rejects.toMatchObject({ kind: 'validation' });
    });

    it('юрлицо с ИНН и наименованием уходит в запрос', async () => {
        const { client, calls } = makeClient(created);
        await client.createIncome({
            items: [{ name: 'x', amount: '1' }],
            client: { incomeType: 'FROM_LEGAL_ENTITY', inn: '1234567890', displayName: 'ООО' },
        });
        expect(body(calls[0]).client).toEqual({
            contactPhone: null,
            displayName: 'ООО',
            incomeType: 'FROM_LEGAL_ENTITY',
            inn: '1234567890',
        });
    });

    it('иностранная организация без ИНН допустима', async () => {
        const { client, calls } = makeClient(created);
        await client.createIncome({
            items: [{ name: 'x', amount: '1' }],
            client: { incomeType: 'FROM_FOREIGN_AGENCY', displayName: 'Foo Ltd' },
        });
        expect(body(calls[0]).client).toMatchObject({ incomeType: 'FROM_FOREIGN_AGENCY' });
    });

    it('printUrl — на receiptBaseUrl, а не на прокси baseUrl', async () => {
        const { client, calls } = makeClient(created, { baseUrl: 'https://proxy.example/api' });
        const result = await client.createIncome({ items: [{ name: 'x', amount: '1' }] });
        expect(calls[0]?.url).toBe('https://proxy.example/api/v1/income');
        expect(result.printUrl.startsWith('https://lknpd.nalog.ru/api/v1/receipt/')).toBe(true);
    });

    it('после 401 повтор безопасен: дохода не было', async () => {
        let incomeCalls = 0;
        const { client } = makeClient(call => {
            if (call.path === '/v1/auth/token') {
                return json(200, {
                    token: 'T2',
                    tokenExpireIn: new Date(Date.now() + 3600_000).toISOString(),
                });
            }
            return ++incomeCalls === 1 ? json(401, {}) : created();
        });
        await expect(
            client.createIncome({ items: [{ name: 'x', amount: '1' }] })
        ).resolves.toMatchObject({ receiptUuid: '20abcdef12' });
        expect(incomeCalls).toBe(2);
    });
});

describe('cancelIncome', () => {
    const cancelled = () =>
        json(200, { incomeInfo: incomeItem({ cancellationInfo: { comment: 'Возврат средств' } }) });

    it('refund → «Возврат средств», время в поясе самозанятого', async () => {
        const { client, calls } = makeClient(cancelled);
        await client.cancelIncome({
            receiptUuid: '20abcdef12',
            reason: 'refund',
            operationTime: new Date('2026-10-31T22:30:00Z'),
        });
        expect(calls[0]?.url).toBe('https://lknpd.nalog.ru/api/v1/cancel');
        expect(body(calls[0])).toMatchObject({
            comment: 'Возврат средств',
            receiptUuid: '20abcdef12',
            operationTime: '2026-11-01T01:30:00+03:00',
            partnerCode: null,
        });
        expect(body(calls[0]).requestTime).toMatch(/\+03:00$/);
    });

    it('mistake → «Чек сформирован ошибочно»', async () => {
        const { client, calls } = makeClient(cancelled);
        await client.cancelIncome({ receiptUuid: '20abcdef12', reason: 'mistake' });
        expect(body(calls[0]).comment).toBe('Чек сформирован ошибочно');
    });

    it.each(['other', 'toString', '__proto__'])('причина "%s" — validation', async reason => {
        const { client, calls } = makeClient(cancelled);
        await expect(
            client.cancelIncome({ receiptUuid: '20abcdef12', reason: reason as 'refund' })
        ).rejects.toMatchObject({ kind: 'validation' });
        expect(calls).toHaveLength(0);
    });
});

describe('listIncomes', () => {
    it('фильтры, сортировка и лимит в запросе', async () => {
        const { client, calls } = makeClient(() => json(200, { content: [], hasMore: false }));
        await client.listIncomes({
            from: new Date('2026-10-31T22:29:00Z'),
            to: new Date('2026-10-31T22:31:00.500Z'),
            offset: 200,
            limit: 50,
            sortBy: 'total_amount:asc',
            buyerType: 'COMPANY',
            receiptType: 'CANCELLED',
        });
        const q = query(calls[0]);
        expect(calls[0]?.path).toBe('/v1/incomes');
        expect(Object.fromEntries(q)).toEqual({
            from: '2026-11-01T01:29:00.000+03:00',
            to: '2026-11-01T01:31:00.500+03:00',
            offset: '200',
            limit: '50',
            sortBy: 'total_amount:asc',
            buyerType: 'COMPANY',
            receiptType: 'CANCELLED',
        });
    });

    it.each([
        [500, '100'],
        [0, '1'],
        [-5, '1'],
        [undefined, '100'],
    ])('limit %s → %s', async (limit, expected) => {
        const { client, calls } = makeClient(() => json(200, { content: [], hasMore: false }));
        await client.listIncomes(limit === undefined ? {} : { limit });
        expect(query(calls[0]).get('limit')).toBe(expected);
    });

    it('модель чека: суммы строкой, время Date, сырой ответ, признак следующей страницы', async () => {
        const raw = incomeItem({ totalAmount: 449.7 });
        const { client } = makeClient(() => json(200, { content: [raw], hasMore: true }));
        const page = await client.listIncomes();
        expect(page.hasMore).toBe(true);
        const [income] = page.items;
        expect(income).toMatchObject({
            receiptUuid: '20abcdef12',
            totalAmount: '449.70',
            services: [{ name: 'Подписка Pro, 1 месяц', amount: '149.00', quantity: 1 }],
            cancelled: false,
            cancellation: null,
            raw,
        });
        expect(income?.operationTime.toISOString()).toBe('2026-10-31T22:30:00.000Z');
    });

    it('аннулированный чек несёт признак, причину и время аннулирования', async () => {
        const raw = incomeItem({
            cancellationInfo: {
                operationTime: '2026-11-02T10:00:00+03:00',
                registerTime: '2026-11-02T10:00:01+03:00',
                taxPeriodId: '202611',
                comment: 'Чек сформирован ошибочно',
            },
        });
        const { client } = makeClient(() => json(200, { content: [raw], hasMore: false }));
        const [income] = (await client.listIncomes()).items;
        expect(income?.cancelled).toBe(true);
        expect(income?.cancellation?.comment).toBe('Чек сформирован ошибочно');
        expect(income?.cancellation?.operationTime?.toISOString()).toBe('2026-11-02T07:00:00.000Z');
    });

    it('сумма мельче копейки в ответе — protocol', async () => {
        const raw = incomeItem({ totalAmount: 1.005 });
        const { client } = makeClient(() => json(200, { content: [raw], hasMore: false }));
        await expect(client.listIncomes()).rejects.toMatchObject({ kind: 'protocol' });
    });

    it('ответ без hasMore — protocol', async () => {
        const { client } = makeClient(() => json(200, { content: [] }));
        await expect(client.listIncomes()).rejects.toMatchObject({ kind: 'protocol' });
    });

    it('неизвестные поля не мешают и остаются в raw', async () => {
        const raw = incomeItem({ partnerLogo: null, newField: { a: 1 }, requestTime: 'мусор' });
        const { client } = makeClient(() => json(200, { content: [raw], hasMore: false }));
        const [income] = (await client.listIncomes()).items;
        expect(income?.requestTime).toBeNull();
        expect(income?.raw.newField).toEqual({ a: 1 });
    });
});

describe('findIncomes', () => {
    const fp = {
        operationTime: new Date('2026-10-31T22:30:00Z'),
        totalAmount: '149.00',
        names: ['Подписка Pro, 1 месяц'],
    };

    it('окно ±1 мин по возрастанию, совпадение найдено', async () => {
        const { client, calls } = makeClient(() =>
            json(200, { content: [incomeItem()], hasMore: false })
        );
        const found = await client.findIncomes(fp);
        expect(found.map(i => i.receiptUuid)).toEqual(['20abcdef12']);
        const q = query(calls[0]);
        expect(q.get('from')).toBe('2026-11-01T01:29:00.000+03:00');
        expect(q.get('to')).toBe('2026-11-01T01:31:00.000+03:00');
        expect(q.get('sortBy')).toBe('operation_time:asc');
        expect(q.get('limit')).toBe('100');
    });

    it('строка operationTime из результата createIncome тоже принимается', async () => {
        const { client } = makeClient(() => json(200, { content: [incomeItem()], hasMore: false }));
        const found = await client.findIncomes({
            ...fp,
            operationTime: '2026-11-01T01:30:00+03:00',
        });
        expect(found).toHaveLength(1);
    });

    it('другая сумма, другая секунда, другие наименования — пусто', async () => {
        const { client } = makeClient(() =>
            json(200, {
                content: [
                    incomeItem({ totalAmount: 150 }),
                    incomeItem({ operationTime: '2026-11-01T01:30:01+03:00' }),
                    incomeItem({ services: [{ name: 'Другое', amount: 149, quantity: 1 }] }),
                ],
                hasMore: false,
            })
        );
        await expect(client.findIncomes(fp)).resolves.toEqual([]);
    });

    it('та же секунда в другом оффсете и миллисекунды — совпадение', async () => {
        const { client } = makeClient(() =>
            json(200, {
                content: [incomeItem({ operationTime: '2026-10-31T22:30:00.700Z' })],
                hasMore: false,
            })
        );
        await expect(client.findIncomes(fp)).resolves.toHaveLength(1);
    });

    it('совпадение на второй странице — клиент листает', async () => {
        const filler = Array.from({ length: 100 }, (_, i) =>
            incomeItem({ approvedReceiptUuid: `other${i}`, totalAmount: 1 })
        );
        const { client, calls } = makeClient(call =>
            query(call).get('offset') === '0'
                ? json(200, { content: filler, hasMore: true })
                : json(200, { content: [incomeItem()], hasMore: false })
        );
        const found = await client.findIncomes(fp);
        expect(found.map(i => i.receiptUuid)).toEqual(['20abcdef12']);
        expect(calls.map(c => query(c).get('offset'))).toEqual(['0', '100']);
    });

    it('два одинаковых чека — оба, включая аннулированный', async () => {
        const { client } = makeClient(() =>
            json(200, {
                content: [
                    incomeItem({ approvedReceiptUuid: 'a1' }),
                    incomeItem({
                        approvedReceiptUuid: 'a2',
                        cancellationInfo: { comment: 'Чек сформирован ошибочно' },
                    }),
                ],
                hasMore: false,
            })
        );
        const found = await client.findIncomes(fp);
        expect(found.map(i => [i.receiptUuid, i.cancelled])).toEqual([
            ['a1', false],
            ['a2', true],
        ]);
    });

    it('порядок наименований не важен, количество — важно', async () => {
        const services = [
            { name: 'B', amount: 100, quantity: 1 },
            { name: 'A', amount: 49, quantity: 1 },
        ];
        const { client } = makeClient(() =>
            json(200, { content: [incomeItem({ services })], hasMore: false })
        );
        await expect(client.findIncomes({ ...fp, names: ['A', 'B'] })).resolves.toHaveLength(1);
        await expect(client.findIncomes({ ...fp, names: ['A'] })).resolves.toHaveLength(0);
    });

    it('hasMore на пустой странице — protocol, а не бесконечный цикл', async () => {
        const { client } = makeClient(() => json(200, { content: [], hasMore: true }));
        await expect(client.findIncomes(fp)).rejects.toMatchObject({ kind: 'protocol' });
    });
});
