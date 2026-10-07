import { describe, expect, it } from 'vitest';
import { receiptPrintUrl } from '../src/index.js';
import { json, makeClient } from './helpers.js';

describe('receiptPrintUrl', () => {
    it('ссылка по ИНН и номеру на базе по умолчанию', () => {
        expect(receiptPrintUrl('123456789012', '20abcdef12')).toBe(
            'https://lknpd.nalog.ru/api/v1/receipt/123456789012/20abcdef12/print'
        );
    });

    it('своя база, хвостовой слэш не дублируется', () => {
        expect(receiptPrintUrl('1', '2', 'https://r.example/api/')).toBe(
            'https://r.example/api/v1/receipt/1/2/print'
        );
    });

    it.each([
        ['', '20abcdef12'],
        ['123456789012', ''],
        [' ', '20abcdef12'],
    ])('пустые аргументы (%j, %j) — validation', (inn, uuid) => {
        expect(() => receiptPrintUrl(inn, uuid)).toThrow(
            expect.objectContaining({ kind: 'validation' })
        );
    });

    it('клиент через прокси строит ссылку на receiptBaseUrl', () => {
        const { client } = makeClient(() => json(200, {}), {
            baseUrl: 'https://proxy.example/api',
        });
        expect(client.receiptPrintUrl('1', '2')).toBe(
            'https://lknpd.nalog.ru/api/v1/receipt/1/2/print'
        );
    });
});

describe('getReceipt', () => {
    // Форма ответа снята живым спайком 2.6 (личные данные убраны).
    const liveReceiptJson = {
        receiptId: '200w7kjq6i',
        services: [
            {
                name: 'Услуга генерации тестовых данных (пакет 2000)',
                quantity: 1,
                serviceNumber: 0,
                amount: 149,
            },
        ],
        operationTime: '2026-10-07T15:39:13+03:00',
        requestTime: '2026-10-07T15:39:13+03:00',
        registerTime: '2026-10-07T12:39:13.52854Z',
        taxPeriodId: 202610,
        paymentType: 'CASH',
        incomeType: 'FROM_INDIVIDUAL',
        totalAmount: 149,
        cancellationInfo: null,
        sourceDeviceId: '94b22f256b2d42eb',
        clientInn: null,
        clientDisplayName: null,
        partnerDisplayName: null,
        partnerInn: null,
        inn: '123456789012',
        profession: '',
        description: [{ part: 'https://example.com', style: 'NO_STYLE' }],
        email: null,
        phone: null,
        invoiceId: null,
    };

    it('JSON чека по ИНН сессии: номер из receiptId', async () => {
        const { client, calls } = makeClient(() => json(200, liveReceiptJson));
        const receipt = await client.getReceipt('200w7kjq6i');
        expect(calls[0]?.url).toBe(
            'https://lknpd.nalog.ru/api/v1/receipt/123456789012/200w7kjq6i/json'
        );
        expect(calls[0]?.headers.Authorization).toBe('Bearer T1');
        expect(receipt).toMatchObject({
            receiptUuid: '200w7kjq6i',
            totalAmount: '149.00',
            services: [
                {
                    name: 'Услуга генерации тестовых данных (пакет 2000)',
                    amount: '149.00',
                    quantity: 1,
                },
            ],
            cancelled: false,
            raw: liveReceiptJson,
        });
        expect(receipt.operationTime.toISOString()).toBe('2026-10-07T12:39:13.000Z');
        expect(receipt.registerTime?.toISOString()).toBe('2026-10-07T12:39:13.528Z');
    });

    it('несуществующий чек: ФНС отвечает 422 receipt.not.found — http / rejected', async () => {
        const { client } = makeClient(() =>
            json(422, { code: 'receipt.not.found', message: 'Чек не найден', additionalInfo: {} })
        );
        await expect(client.getReceipt('0000000000')).rejects.toMatchObject({
            kind: 'http',
            outcome: 'rejected',
            status: 422,
            code: 'receipt.not.found',
            fnsMessage: 'Чек не найден',
        });
    });

    it('пустой номер — validation без запроса', async () => {
        const { client, calls } = makeClient(() => json(200, {}));
        await expect(client.getReceipt('')).rejects.toMatchObject({ kind: 'validation' });
        expect(calls).toHaveLength(0);
    });
});
