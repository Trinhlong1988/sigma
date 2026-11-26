// PHƯƠNG ÁN C (Admin Demo 1/9) — bill 1 lô NHIỀU LOẠI THẺ: ghi 1 Lô với N LoRow (mỗi thẻ 1 dòng, phí bán THỰC TẾ
// riêng) cho ĐẠI LÝ; bridge 1 GIAO DỊCH TỔNG (amount = Σ gross) cho NĐT/SigMa — giữ bất biến 1 Lô ↔ 1 GD
// (schema los.transaction_id @unique, KHÔNG sửa schema). Regression THẬT trên throwaway DB, gọi createLoFromBillTid
// (đường PROD, KHÔNG viết lại logic). Khẳng định: (a) Σ LoRow.amountBeforeFee = tổng bill; (b) đại lý (Σ los rows)
// = NĐT (GD tổng) = tổng bill, KHÔNG đếm đôi/sót; (c) phí mỗi dòng đúng theo loại thẻ; (d) NĐT phí cài máy đúng;
// (e) fail-closed: thiếu giá bán 1 loại → NO_ACTUAL_SELL_FEE, KHÔNG tạo Lô; (f) đường 1-thẻ chạy y như cũ.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { createLoFromBillTid } from '../src/lo-service.js';
import { makeQuoteReadyTid, makeCardType, makeFeeSellQuote, makeTidSellFee } from './fixtures.js';

const EPOCH = new Date('2020-01-01T00:00:00.000Z');

/** Seed FeeRate (phí mua/cài máy) cho 1 cặp (đối tác × thẻ) — bridge cần để tạo GD (resolveFeeForTxn). */
async function makeFeeRate(opts: { partnerId: number; cardTypeId: number; phiMuaMilli: number; phiCaiMayMilli: number }) {
  const db = getBotDb();
  return db.feeRate.create({
    data: { partnerId: opts.partnerId, cardTypeId: opts.cardTypeId, phiMua: opts.phiMuaMilli, phiCaiMay: opts.phiCaiMayMilli, effectiveFrom: EPOCH }
  });
}

/** marginToAmount CÙNG công thức nghiệp vụ: amount × milli / 100000. */
const feeOf = (amount: number, milli: number): number => Math.round((amount * milli) / 100000);

/** feeType MẶC ĐỊNH mà createLoFromBillTid/quoteRow dùng khi không truyền feeTypeId = FeeType đầu (id asc) TOÀN
 *  hệ thống (khớp fee-quote.ts). Test PHẢI seed phí bán trên ĐÚNG feeType này (throwaway DB có sẵn feeType seed
 *  id nhỏ hơn feeType của fixture) — nếu không quoteRow tra nhầm feeType → NO_SELL_QUOTE. */
async function defaultFeeTypeId(): Promise<number> {
  const db = getBotDb();
  const ft = await db.feeType.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, take: 1 });
  return ft[0].id;
}

describe('createLoFromBillTid — bill nhiều loại thẻ (Phương án C: 1 Lô N LoRow + 1 GD tổng)', () => {
  it('2 loại thẻ → 1 Lô 2 LoRow (phí riêng từng thẻ) + 1 GD TỔNG; đại lý = NĐT = tổng bill', async () => {
    const s = await makeQuoteReadyTid({ phiBanMilli: 1000 });
    const ft = await defaultFeeTypeId();
    const cardB = await makeCardType(s.bank.id);
    // Seed phí bán THỰC TẾ (override) cho CẢ 2 thẻ trên feeType mặc định — card A 1.0%, card B 1.5%. Card A đã được
    // makeQuoteReadyTid seed trên s.feeType; chỉ seed thêm khi feeType mặc định KHÁC s.feeType (tránh đụng unique).
    if (ft !== s.feeType.id) {
      await makeTidSellFee({ tidId: s.tid.id, cardTypeId: s.cardType.id, feeTypeId: ft, phiBanMilli: 1000 });
      await makeFeeSellQuote({ partnerId: s.partner.id, cardTypeId: s.cardType.id, feeTypeId: ft, phiBanMilli: 1000, effectiveFrom: EPOCH });
    }
    await makeTidSellFee({ tidId: s.tid.id, cardTypeId: cardB.id, feeTypeId: ft, phiBanMilli: 1500 });
    await makeFeeSellQuote({ partnerId: s.partner.id, cardTypeId: cardB.id, feeTypeId: ft, phiBanMilli: 1500, effectiveFrom: EPOCH });
    // FeeRate cả 2 thẻ (bridge cần) — A: mua/cài 0.8%/0.8%; B: 1.2%/1.1%
    await makeFeeRate({ partnerId: s.partner.id, cardTypeId: s.cardType.id, phiMuaMilli: 800, phiCaiMayMilli: 800 });
    await makeFeeRate({ partnerId: s.partner.id, cardTypeId: cardB.id, phiMuaMilli: 1200, phiCaiMayMilli: 1100 });

    const AMT_A = 1_000_000, AMT_B = 2_000_000, TOTAL = AMT_A + AMT_B;
    const db = getBotDb();
    const r = await createLoFromBillTid(db, s.agent.id, {
      tidString: s.tid.tid, amountBeforeFee: TOTAL, billKey: `nat|mc|${Date.now()}`, txnDate: new Date(),
      lines: [{ cardTypeId: s.cardType.id, amountBeforeFee: AMT_A }, { cardTypeId: cardB.id, amountBeforeFee: AMT_B }]
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const loId = r.data.id;

    // (a)+(c) ĐẠI LÝ — 2 LoRow, phí đúng từng thẻ, Σ = tổng bill
    const rows = await db.loRow.findMany({ where: { loId }, orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(2);
    const rowA = rows.find((x) => x.cardTypeId === s.cardType.id)!;
    const rowB = rows.find((x) => x.cardTypeId === cardB.id)!;
    expect(Number(rowA.feeApplied)).toBe(feeOf(AMT_A, 1000)); // 10.000
    expect(Number(rowB.feeApplied)).toBe(feeOf(AMT_B, 1500)); // 30.000
    expect(Number(rowA.amountAfterFee)).toBe(AMT_A - feeOf(AMT_A, 1000));
    expect(Number(rowB.amountAfterFee)).toBe(AMT_B - feeOf(AMT_B, 1500));
    const sumBefore = rows.reduce((acc, x) => acc + Number(x.amountBeforeFee), 0);
    expect(sumBefore).toBe(TOTAL);

    // (b) NĐT — đúng 1 GD tổng, amount = Σ gross = số đại lý; lô liên kết 1-1
    const lo = await db.lo.findUnique({ where: { id: loId } });
    expect(lo!.transactionId).not.toBeNull();
    const txn = await db.transaction.findUnique({ where: { id: lo!.transactionId! } });
    expect(Number(txn!.amount)).toBe(TOTAL);
    expect(Number(txn!.amount)).toBe(sumBefore); // đại lý == NĐT (KHÔNG lệch)
    // (d) MULTI-CARD BÌNH QUÂN GIA QUYỀN (Admin Demo 1/9 "đúng từng đồng, không cần cột"): phí cài máy GD tổng = BQGQ
    //     theo tiền = (1M×800 + 2M×1100)/3M = 1000; doanh thu bán/đối tác = Σ PER-THẺ TUYỆT ĐỐI (không phải thẻ đại diện).
    expect(Number(txn!.phiCaiMayMilli)).toBe(1000); // BQGQ (không phải 800 của thẻ đại diện)
    // revenuePartner Σ per-thẻ: A partnerMargin 0 → 0; B partnerMargin (1200-1100)=100 → 2000. Σ=2000.
    expect(Number(txn!.revenuePartner)).toBe(feeOf(AMT_A, 0) + feeOf(AMT_B, 100)); // 2.000
    // revenueSell Σ per-thẻ: A sellMargin (1000-800)=200 → 2000; B sellMargin (1500-1100)=400 → 8000. Σ=10000.
    expect(Number(txn!.revenueSell)).toBe(feeOf(AMT_A, 200) + feeOf(AMT_B, 400)); // 10.000
    const tienVe = Number(txn!.amount) - feeOf(Number(txn!.amount), Number(txn!.phiCaiMayMilli));
    // tiền về BQGQ = 3M − feeOf(3M,1000)=30k = 2.970.000 = Σ per-thẻ ĐÚNG (992.000 + 1.978.000) — khớp tuyệt đối ở ca này.
    expect(tienVe).toBe((AMT_A - feeOf(AMT_A, 800)) + (AMT_B - feeOf(AMT_B, 1100))); // 2.970.000 = Σ tiền về per-thẻ ĐÚNG
    // KHÔNG đếm đôi: chỉ 1 GD gắn lô này
    const cnt = await db.transaction.count({ where: { id: lo!.transactionId! } });
    expect(cnt).toBe(1);
  });

  it('fail-closed: 1 loại thẻ CHƯA cấu hình giá bán thực tế → NO_ACTUAL_SELL_FEE, KHÔNG tạo Lô (không ghi phí 0)', async () => {
    const s = await makeQuoteReadyTid({ phiBanMilli: 1000 });
    const ft = await defaultFeeTypeId();
    const cardB = await makeCardType(s.bank.id);
    // Card A có override (feeType mặc định) → dòng A qua được; card B CHỈ có niêm yết, KHÔNG override →
    // đại lý không mượn niêm yết → NO_ACTUAL_SELL_FEE (ABORT cả phiếu).
    if (ft !== s.feeType.id)
      await makeTidSellFee({ tidId: s.tid.id, cardTypeId: s.cardType.id, feeTypeId: ft, phiBanMilli: 1000 });
    await makeFeeSellQuote({ partnerId: s.partner.id, cardTypeId: cardB.id, feeTypeId: ft, phiBanMilli: 1500, effectiveFrom: EPOCH });
    await makeFeeRate({ partnerId: s.partner.id, cardTypeId: s.cardType.id, phiMuaMilli: 800, phiCaiMayMilli: 800 });

    const db = getBotDb();
    const before = await db.lo.count();
    const r = await createLoFromBillTid(db, s.agent.id, {
      tidString: s.tid.tid, amountBeforeFee: 3_000_000, billKey: `nat|fc|${Date.now()}`,
      lines: [{ cardTypeId: s.cardType.id, amountBeforeFee: 1_000_000 }, { cardTypeId: cardB.id, amountBeforeFee: 2_000_000 }]
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NO_ACTUAL_SELL_FEE');
    expect(await db.lo.count()).toBe(before); // KHÔNG tạo Lô nào (ABORT cả phiếu)
  });

  it('tổng các dòng thẻ KHÔNG khớp tổng bill → VALIDATION (chống ghi doanh số lệch)', async () => {
    const s = await makeQuoteReadyTid({ phiBanMilli: 1000 });
    const cardB = await makeCardType(s.bank.id);
    await makeTidSellFee({ tidId: s.tid.id, cardTypeId: cardB.id, feeTypeId: s.feeType.id, phiBanMilli: 1500 });
    const db = getBotDb();
    const r = await createLoFromBillTid(db, s.agent.id, {
      tidString: s.tid.tid, amountBeforeFee: 3_000_000, billKey: `nat|mis|${Date.now()}`,
      lines: [{ cardTypeId: s.cardType.id, amountBeforeFee: 1_000_000 }, { cardTypeId: cardB.id, amountBeforeFee: 1_500_000 }] // Σ=2.5tr ≠ 3tr
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('VALIDATION');
  });

  it('đường 1-thẻ (KHÔNG lines) chạy y như cũ — 1 Lô 1 LoRow 1 GD, số khớp', async () => {
    const s = await makeQuoteReadyTid({ phiBanMilli: 1000 });
    const ft = await defaultFeeTypeId();
    if (ft !== s.feeType.id) {
      await makeTidSellFee({ tidId: s.tid.id, cardTypeId: s.cardType.id, feeTypeId: ft, phiBanMilli: 1000 });
      await makeFeeSellQuote({ partnerId: s.partner.id, cardTypeId: s.cardType.id, feeTypeId: ft, phiBanMilli: 1000, effectiveFrom: EPOCH });
    }
    await makeFeeRate({ partnerId: s.partner.id, cardTypeId: s.cardType.id, phiMuaMilli: 800, phiCaiMayMilli: 800 });
    const db = getBotDb();
    const AMT = 5_000_000;
    const r = await createLoFromBillTid(db, s.agent.id, {
      tidString: s.tid.tid, cardTypeId: s.cardType.id, amountBeforeFee: AMT, billKey: `nat|single|${Date.now()}`, txnDate: new Date()
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = await db.loRow.findMany({ where: { loId: r.data.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amountBeforeFee)).toBe(AMT);
    expect(Number(rows[0].feeApplied)).toBe(feeOf(AMT, 1000));
    const lo = await db.lo.findUnique({ where: { id: r.data.id } });
    const txn = await db.transaction.findUnique({ where: { id: lo!.transactionId! } });
    expect(Number(txn!.amount)).toBe(AMT);
  });
});
