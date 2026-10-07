import { describe, expect, it } from 'vitest';
import { formatKopecks, kopecksFromResponse, parseAmount, type Amount } from '../src/money.js';

describe('parseAmount', () => {
    it.each([
        ['149', 14900n],
        ['149.9', 14990n],
        ['149.90', 14990n],
        ['0.01', 1n],
        ['90071992547409.91', 9007199254740991n],
    ])('строка %s → %i коп.', (input, expected) => {
        expect(parseAmount(input, 'amount')).toBe(expected);
    });

    it('копейки', () => {
        expect(parseAmount({ kopecks: 14990 }, 'amount')).toBe(14990n);
    });

    it.each<[string, unknown]>([
        ['три знака', '149.999'],
        ['минус', '-1'],
        ['ноль', '0'],
        ['ноль с копейками', '0.00'],
        ['запятая', '149,90'],
        ['пробел', ' 149'],
        ['дробные копейки', { kopecks: 1.5 }],
        ['отрицательные копейки', { kopecks: -100 }],
        ['небезопасное целое', { kopecks: 2 ** 53 }],
        ['число вместо строки', 149.9],
        ['null', null],
    ])('отказ: %s', (_, input) => {
        expect(() => parseAmount(input as Amount, 'amount')).toThrow(
            expect.objectContaining({ kind: 'validation', outcome: 'not-sent' })
        );
    });
});

describe('formatKopecks', () => {
    it.each([
        [0n, '0.00'],
        [1n, '0.01'],
        [44970n, '449.70'],
        [15000n, '150.00'],
        [9007199254740993n, '90071992547409.93'],
    ])('%i → %s', (input, expected) => {
        expect(formatKopecks(input)).toBe(expected);
    });

    it('149.90 × 3 без float-погрешности', () => {
        expect(formatKopecks(parseAmount('149.90', 'a') * 3n)).toBe('449.70');
    });

    it('смешанные формы суммируются в копейках', () => {
        const total = parseAmount({ kopecks: 14990 }, 'a') + parseAmount('0.10', 'b');
        expect(formatKopecks(total)).toBe('150.00');
    });
});

describe('kopecksFromResponse', () => {
    it.each([
        [449.7, 44970n],
        [149.9 * 3, 44970n],
        [0.1 + 0.2, 30n],
        [149, 14900n],
        [0, 0n],
        ['449.70', 44970n],
    ])('%s → %i коп.', (input, expected) => {
        expect(kopecksFromResponse(input, 'totalAmount')).toBe(expected);
    });

    it('449.7 из ответа → "449.70"', () => {
        expect(formatKopecks(kopecksFromResponse(449.7, 'x'))).toBe('449.70');
    });

    it.each<[string, unknown]>([
        ['дробь мельче копейки', 1.005],
        ['отрицательная', -1],
        ['NaN', NaN],
        ['бесконечность', Infinity],
        ['строка-мусор', 'abc'],
        ['null', null],
    ])('отказ: %s — protocol', (_, input) => {
        expect(() => kopecksFromResponse(input, 'x')).toThrow(
            expect.objectContaining({ kind: 'protocol' })
        );
    });
});
