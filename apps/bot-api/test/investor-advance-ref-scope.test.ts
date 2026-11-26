// [Phản biện 11/9 — CAO-4/CAO-5] Ref NGẮN toàn-số (số biên lai theo bank/ngày, vd "2760") KHÔNG duy nhất toàn hệ
// (DB thật 83/127 dòng ref 4 số) → dedup toàn cục là NUỐT TRẮNG khoản ứng của NĐT KHÁC trùng số biên lai.
// Test 2 CHIỀU trên throwaway Postgres:
//   CHIỀU SAI (phải chặn): cùng NĐT + cùng ref → duplicate (advance lẫn repayment).
//   CHIỀU ĐÚNG (phải ghi): NĐT KHÁC + cùng ref NGẮN → recorded; ref DÀI (mã bank thật) vẫn dedup toàn cục.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { ingestInvestorAdvance, recordInvestorRepayment, refLaToanCuc } from '../src/investor-advance-ingest.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function makeInvestor(): Promise<number> {
  const db = getBotDb();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT ref-scope', nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: 0 } });
  return inv.id;
}
// Số biên lai NGẮN toàn-số nhưng unique giữa các lần chạy test (throwaway DB dùng chung nhiều suite).
const refNgan = (): string => String(Math.floor(Math.random() * 9000) + 1000);

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('refLaToanCuc — phạm vi khoá ref', () => {
  it('ref ngắn toàn số → KHÔNG toàn cục; ref dài / có chữ → toàn cục', () => {
    expect(refLaToanCuc('2760')).toBe(false);
    expect(refLaToanCuc('123456')).toBe(false);
    expect(refLaToanCuc('1234567')).toBe(false);
    expect(refLaToanCuc('')).toBe(false);
    expect(refLaToanCuc(null)).toBe(false);
    expect(refLaToanCuc('12345678')).toBe(true); // ≥8 ký tự
    expect(refLaToanCuc('6252VNIB02UQLZZ7')).toBe(true);
    expect(refLaToanCuc('FT26abc')).toBe(true); // có chữ → mã bank thật
  });
});

describe('ingestInvestorAdvance — dedup ref theo phạm vi', () => {
  it('CHIỀU SAI: cùng NĐT + cùng ref ngắn → lần 2 duplicate', async () => {
    const db = getBotDb();
    const inv = await makeInvestor();
    const ref = refNgan();
    const base = { investorId: inv, receiverName: 'KHACH HANG 01', amount: 5_000_000, ref, advanceDateIso: new Date().toISOString() };
    const r1 = await ingestInvestorAdvance(db, base);
    expect(r1.action).toBe('recorded');
    const r2 = await ingestInvestorAdvance(db, { ...base, amount: 7_000_000 }); // OCR lệch tiền vẫn phải chặn theo ref
    expect(r2.action).toBe('duplicate');
  });
  it('CHIỀU ĐÚNG: NĐT KHÁC + cùng ref ngắn → recorded (trước fix bị nuốt trắng)', async () => {
    const db = getBotDb();
    const invA = await makeInvestor();
    const invB = await makeInvestor();
    const ref = refNgan();
    const r1 = await ingestInvestorAdvance(db, { investorId: invA, receiverName: 'KHACH HANG 01', amount: 5_000_000, ref, advanceDateIso: new Date().toISOString() });
    expect(r1.action).toBe('recorded');
    const r2 = await ingestInvestorAdvance(db, { investorId: invB, receiverName: 'KHACH HANG 01', amount: 9_000_000, ref, advanceDateIso: new Date().toISOString() });
    expect(r2.action).toBe('recorded');
    if (r2.action === 'recorded') expect(r2.investorId).toBe(invB);
  });
  it('ref DÀI (mã bank thật): NĐT KHÁC vẫn duplicate (khoá toàn cục giữ nguyên)', async () => {
    const db = getBotDb();
    const invA = await makeInvestor();
    const invB = await makeInvestor();
    const ref = uniq('FT').slice(0, 16); // ≥8 ký tự, có chữ
    const r1 = await ingestInvestorAdvance(db, { investorId: invA, receiverName: 'KHACH HANG 01', amount: 5_000_000, ref, advanceDateIso: new Date().toISOString() });
    expect(r1.action).toBe('recorded');
    const r2 = await ingestInvestorAdvance(db, { investorId: invB, receiverName: 'KHACH HANG 01', amount: 5_000_000, ref, advanceDateIso: new Date().toISOString() });
    expect(r2.action).toBe('duplicate');
  });
});

describe('recordInvestorRepayment — cùng luật phạm vi ref', () => {
  it('cùng NĐT + ref ngắn → duplicate; NĐT KHÁC + ref ngắn → recorded', async () => {
    const db = getBotDb();
    const invA = await makeInvestor();
    const invB = await makeInvestor();
    const ref = refNgan();
    const r1 = await recordInvestorRepayment(db, { investorId: invA, amount: 3_000_000, ref, advanceDateIso: new Date().toISOString() });
    expect(r1.action).toBe('recorded');
    const r2 = await recordInvestorRepayment(db, { investorId: invA, amount: 3_000_000, ref, advanceDateIso: new Date().toISOString() });
    expect(r2.action).toBe('duplicate');
    const r3 = await recordInvestorRepayment(db, { investorId: invB, amount: 3_000_000, ref, advanceDateIso: new Date().toISOString() });
    expect(r3.action).toBe('recorded');
  });
});
