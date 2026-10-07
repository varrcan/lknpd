/**
 * Сквозной сценарий 7.2 против живого API, только чтение: вход, список, поиск по отпечатку
 * существующего чека, печатная форма, JSON. Чеков не создаёт — чек это заявленный доход.
 */
module.exports = async function scenario(lib, label) {
    const { LknpdClient, MemoryTokenStore, isLknpdError } = lib;
    const env = name => {
        const value = process.env[name];
        if (!value) throw new Error(`Нет ${name} в окружении (.env)`);
        return value;
    };
    const client = new LknpdClient({
        deviceId: `lknpd-e2e-${label}`,
        timezone: process.env.LKNPD_TZ ?? 'Europe/Moscow',
        tokenStore: new MemoryTokenStore(),
        credentials: { inn: env('LKNPD_INN'), password: env('LKNPD_PASSWORD') },
    });
    try {
        const session = await client.loginWithPassword();
        console.log(`[${label}] вход: ИНН ${session.inn}`);
        const page = await client.listIncomes({ limit: 5 });
        const [income] = page.items;
        if (!income) throw new Error('в кабинете нет чеков — проверять нечего');
        console.log(`[${label}] последний чек ${income.receiptUuid}, ${income.totalAmount} ₽`);
        const found = await client.findIncomes({
            operationTime: income.operationTime,
            totalAmount: income.totalAmount,
            names: income.services.map(s => s.name),
        });
        console.log(`[${label}] findIncomes: ${found.length}`);
        if (!found.some(i => i.receiptUuid === income.receiptUuid)) {
            throw new Error('поиск по отпечатку не нашёл существующий чек');
        }
        const print = await fetch(client.receiptPrintUrl(session.inn, income.receiptUuid));
        console.log(`[${label}] печатная форма: ${print.status}`);
        const receipt = await client.getReceipt(income.receiptUuid);
        console.log(`[${label}] JSON чека: ${receipt.totalAmount}`);
    } catch (error) {
        console.error(`[${label}] ошибка:`, isLknpdError(error) ? error.toJSON() : error);
        process.exitCode = 1;
    }
};
