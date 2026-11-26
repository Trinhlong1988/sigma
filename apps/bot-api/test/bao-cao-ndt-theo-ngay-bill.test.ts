// [Admin Demo 26/9 CHỐT "lấy ngày trên bill làm chuẩn"] KHOÁ MỐC NGÀY của báo cáo NĐT.
//
// LỖI THẬT: investorDailyReport (màn tổng) lọc theo t.txn_date, còn investorReportDetail (chi tiết/Excel) cũng
// lọc theo t.txn_date NHƯNG in cột ngày bằng l.bill_txn_date ⇒ chọn "hôm nay" vẫn thấy dòng đề ngày hôm qua.
// Ca thật 25→26/9: 9 GD / 625.714.000đ của NĐT NĐT 1 quẹt tối 25/9 nhưng bill ghi 26/9 (OCR sáng hôm sau).
//
// LUẬT NAY: CẢ HAI hàm lọc theo COALESCE(bill_txn_date, txn_date) — ngày TRÊN BILL là chuẩn; bill không có giờ
// thì mới rơi về ngày ghi GD (không để GD rớt khỏi mọi kỳ).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, investorDailyReport } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { makeBank, makeCardType, makeCustomer, makeTid, makePartner, defaultFeeTypeForQuote, makeFeeRate, makeTidSellFee } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });
const ctx = () => ({ db: getBotDb(), user: { id: 1, permissions: ['REVENUE_VIEW', 'INVESTOR_VIEW'] } }) as never;

/** 1 NĐT + 1 máy + 1 GD ghi ngày A, bill ngày B (mô phỏng quẹt tối hôm trước, OCR sáng hôm sau). */
async function dung(ghiIso: string, billIso: string | null) {
  const db = getBotDb();
  const bank = await makeBank();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const partner = await makePartner();
  const kh = await makeCustomer();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), nickname: uniq('NDT '), fullName: uniq('NDT ') } });
  const ra = await db.receiveAccount.create({ data: { investorId: inv.id, accountName: uniq('TK '), accountNumber: uniq('9'), bankId: bank.id, sourceId: 5, updatedAt: new Date() } });
  const tid = await makeTid({ tid: `93${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: kh.id, bankId: bank.id, partnerId: partner.id, hkdName: uniq('HKD NGAY ') });
  await db.$executeRawUnsafe(`UPDATE tids SET receive_account_id=$1, invest_fee_milli=1000 WHERE id=$2`, ra.id, tid.id);
  await makeFeeRate({ partnerId: partner.id, cardTypeId: cardType.id, phiMua: 1000, phiCaiMay: 1000 });
  await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1500 });
  const gd = await db.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO transactions (code, tid_id, customer_id, card_type_id, fee_type_id, amount, partner_margin_milli,
       sell_margin_milli, phi_cai_may_milli, revenue_partner, revenue_sell, revenue_amount, txn_date, status, settled, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5, 10000000, 0, 500, 1000, 0, 50000, 50000, $6::timestamptz, 'POSTED', false, now(), now()) RETURNING id`,
    uniq('GD'), tid.id, kh.id, cardType.id, feeType.id, ghiIso);
  const lo = await db.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO los (agent_id, expected_total_amount, status, transaction_id, bill_txn_date, created_at, updated_at)
     VALUES (1, 10000000, 'PENDING', $1, $2::timestamptz, now(), now()) RETURNING id`, gd[0]!.id, billIso);
  return { inv, tid, gd: gd[0]!.id, lo: lo[0]!.id };
}
const dt = (r: unknown, invId: number): number => {
  const rows = ((r as { data?: Array<Record<string, unknown>> }).data ?? []);
  const x = rows.find((y) => Number(y['investorId'] ?? y['id']) === invId);
  return Number(x?.['doanhThu'] ?? x?.['dt'] ?? 0);
};

describe('báo cáo NĐT — kỳ tính theo NGÀY TRÊN BILL', () => {
  it('quẹt tối 25/9 nhưng bill ghi 26/9 → nằm ở NGÀY 26, KHÔNG nằm ngày 25', async () => {
    const w = await dung('2026-03-25T20:18:00+07:00', '2026-03-26T10:18:00+07:00');
    const ngay25 = await investorDailyReport(ctx(), { from: '2026-03-25', to: '2026-03-25' } as never);
    const ngay26 = await investorDailyReport(ctx(), { from: '2026-03-26', to: '2026-03-26' } as never);
    expect(dt(ngay25, w.inv.id)).toBe(0);
    expect(dt(ngay26, w.inv.id)).toBe(10_000_000);
  });

  it('ngày ghi = ngày bill → nằm đúng ngày đó (không đổi hành vi ca thường)', async () => {
    const w = await dung('2026-03-27T14:00:00+07:00', '2026-03-27T14:00:00+07:00');
    const r = await investorDailyReport(ctx(), { from: '2026-03-27', to: '2026-03-27' } as never);
    expect(dt(r, w.inv.id)).toBe(10_000_000);
  });

  it('KHÔNG có ngày bill → rơi về ngày ghi GD, không rớt khỏi mọi kỳ', async () => {
    const w = await dung('2026-03-28T09:00:00+07:00', null);
    const r = await investorDailyReport(ctx(), { from: '2026-03-28', to: '2026-03-28' } as never);
    expect(dt(r, w.inv.id)).toBe(10_000_000);
  });
});
