// REGRESSION (Admin Demo 6/9) — BUG THẬT: THÀNH NAM 2 lô 116 SÓT doanh số vì TRÙNG SỐ TIỀN với lô 111 (đều 5.504.000,
// cùng TID + cùng ngày). Tầng-3 "nghi trùng giao dịch" của createLoFromBillTid trước đây chỉ xét TID+tiền+24h → chặn
// NHẦM lô 116 (giao dịch KHÁC, khác số lô) = DUP_SUSPECT → không ghi → sót doanh số (bill đã gửi vào nhóm rồi).
// FIX: trùng tiền NHƯNG KHÁC SỐ LÔ (đọc được cả 2) → giao dịch KHÁC → VẪN GHI. Chỉ chặn khi CÙNG số lô (hoặc mù lô).
// Gate QA đường PROD createLoFromBillTid trên throwaway Postgres. 1 TID dùng chung (mỗi ca khác SỐ TIỀN → không lẫn).
import { describe, expect, it, beforeAll } from 'vitest';
import { getBotDb } from '../src/db.js';
import { createLoFromBillTid } from '../src/lo-service.js';
import { makeQuoteReadyTid } from './fixtures.js';

let S: Awaited<ReturnType<typeof makeQuoteReadyTid>>;
beforeAll(async () => { S = await makeQuoteReadyTid({ phiBanMilli: 1000 }); });
const mk = (amt: number, lo: string, hd: string, allowDuplicate = false) => createLoFromBillTid(getBotDb(), S.agent.id, {
  tidString: S.tid.tid, cardTypeId: S.cardType.id, amountBeforeFee: amt, billKey: `nat|${S.tid.tid}|${lo}|${hd}`, txnDate: new Date(), allowDuplicate
});

describe('createLoFromBillTid — tầng-3 nghi-trùng: trùng tiền KHÁC lô vẫn ghi (Admin Demo 6/9)', () => {
  it('(a) CÙNG tiền + TID + ngày nhưng KHÁC SỐ LÔ (111 vs 116) → CẢ HAI ghi (không DUP_SUSPECT) — chính bug lô 116', async () => {
    const r1 = await mk(5_504_000, '111', 'a');
    // [8/9] File này ĐỎ khi chạy SONG SONG với file khác nhưng XANH khi chạy riêng → in LÝ DO thật (R198: cấm
    // "expected false to be true" trống trơn, không truy được gốc).
    if (!r1.ok) console.error('r1 FAIL:', JSON.stringify(r1));
    expect(r1.ok).toBe(true);
    const r2 = await mk(5_504_000, '116', 'b'); // khác lô → giao dịch khác → PHẢI ghi
    if (!r2.ok) console.error('DUP_SUSPECT SAI (lô 116 khác lô 111 vẫn bị chặn):', (r2 as { error?: string }).error);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r2.data.id).not.toBe(r1.data.id);
  });

  it('(b) CÙNG số lô + CÙNG tiền + CÙNG ngày → VẪN chặn DUP_SUSPECT (chống đếm đôi thật)', async () => {
    const r1 = await mk(7_777_000, '55', 'a');
    expect(r1.ok).toBe(true);
    const r2 = await mk(7_777_000, '55', 'b'); // cùng lô 55 + cùng tiền → nghi trùng thật
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect((r2 as { error?: string }).error).toBe('DUP_SUSPECT');
  });

  it('(c) allowDuplicate=true → ghi được kể cả cùng lô (đại lý xác nhận là giao dịch khác)', async () => {
    const r1 = await mk(3_333_000, '9', 'a');
    expect(r1.ok).toBe(true);
    const r2 = await mk(3_333_000, '9', 'b', true);
    expect(r2.ok).toBe(true);
  });

  it('(d) MÙ số lô (billKey img|... không có số lô) + cùng tiền/ngày → GIỮ an toàn: chặn DUP_SUSPECT', async () => {
    const db = getBotDb();
    const r1 = await createLoFromBillTid(db, S.agent.id, { tidString: S.tid.tid, cardTypeId: S.cardType.id, amountBeforeFee: 6_006_000, billKey: `img|${S.tid.tid}|hashA`, txnDate: new Date() });
    expect(r1.ok).toBe(true);
    const r2 = await createLoFromBillTid(db, S.agent.id, { tidString: S.tid.tid, cardTypeId: S.cardType.id, amountBeforeFee: 6_006_000, billKey: `img|${S.tid.tid}|hashB`, txnDate: new Date() });
    expect(r2.ok).toBe(false); // mù lô → không phân biệt được → giữ chặn (an toàn, đại lý allowDuplicate nếu khác)
  });
});
