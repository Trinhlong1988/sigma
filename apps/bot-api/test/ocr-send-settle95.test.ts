// REGRESSION — cảnh báo nghiêm trọng ĐÓNG LÔ 95 phải SỐNG QUA gộp lô (Admin Demo 1/9 "đóng 95 không nhận diện được
// lỗi quy trình"). BUG GỐC: reviewBills gộp bill có TID qua aggregateLotRevenue → dựng lại lotBills mà KHÔNG copy
// settlementCode → mã 95 bị nuốt cho MỌI bill có TID → cảnh báo không bao giờ bắn (bill Huệ Xinh lô 90 thật lọt).
// Test: (a) lô có 95 → cảnh báo có; (b) lô KHÔNG 95 cạnh lô có 95 → KHÔNG lây (đúng lô mới cảnh báo).
import { describe, it, expect } from 'vitest';
import { reviewBills } from '../src/ocr-send-service.js';

// fake-Db NULL-PROXY: mọi table.method → findMany:[] · count:0 · còn lại null → reviewBills chạy không ném, không
// routing/fee (ta chỉ kiểm nhánh cảnh báo 95, độc lập routing). resolveBillRouting/computeFee... nhận null → rỗng.
const tableProxy = new Proxy({}, { get: (_t, m) => async () => { const s = String(m); return s.startsWith('findMany') ? [] : s === 'count' ? 0 : null; } });
const nullDb = new Proxy({}, { get: () => tableProxy }) as never;
const mk = (batchNumber: string, settlementCode: string | null, amount = 25988000) => ({
  tid: '53550076', agencyName: 'HKD DEMO 21', batchNumber, type: 'SETTLEMENT' as const, totalAmount: amount, dateTime: '30/08/2026 13:59', settlementCode
});
const has95 = (w: string[] | undefined) => (w ?? []).some((x) => /ĐÓNG LÔ 95/.test(x));

describe('reviewBills — cảnh báo ĐÓNG LÔ 95 sống qua gộp lô', () => {
  it('(a) bill settlement có TID + settlementCode 95 → CÓ cảnh báo (không bị gộp lô nuốt)', async () => {
    const items = await reviewBills(nullDb, [mk('90', '95')], new Date());
    const lo90 = items.find((i) => i.bill.batchNumber === '90');
    expect(lo90).toBeDefined();
    expect(lo90!.bill.settlementCode).toBe('95'); // settlementCode SỐNG qua reconstruct
    expect(has95(lo90!.warnings)).toBe(true);
  });

  it('(b) lô 89 (không 95) cạnh lô 90 (có 95) → chỉ 90 cảnh báo, 89 KHÔNG lây', async () => {
    const items = await reviewBills(nullDb, [mk('89', null, 15837000), mk('90', '95')], new Date());
    const lo89 = items.find((i) => i.bill.batchNumber === '89');
    const lo90 = items.find((i) => i.bill.batchNumber === '90');
    expect(has95(lo90?.warnings)).toBe(true);
    expect(has95(lo89?.warnings)).toBe(false); // KHÔNG lây sang lô khác cùng TID
  });

  it('(c) không có mã 95 → không cảnh báo (không dương tính giả)', async () => {
    const items = await reviewBills(nullDb, [mk('91', null)], new Date());
    expect(has95(items[0]?.warnings)).toBe(false);
  });
});
