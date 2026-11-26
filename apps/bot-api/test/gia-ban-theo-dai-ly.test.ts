// [Admin Demo 25/9 "khi cho mượn thì được phép sửa giá bán ... cho từng bill, từng đại lý, giá đã áp dụng ở đại lý
// khác thì giữ nguyên"] KHOÁ chiều ĐẠI LÝ của bảng giá bán thực tế (tid_sell_fees.customer_id).
//   · customer_id NULL = giá CHUNG của máy (hành vi cũ, mọi đại lý).
//   · customer_id = X    = giá RIÊNG chỉ khi đại lý X cầm/mượn máy.
// Ca thật: máy Chí Đức BM-9 chủ Trường Thiện SG bán 1,28%; Tuyên SG mượn cần 1,25% mà KHÔNG đụng nhà khác.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, setTidSellFees, resolveFeeForTxn } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { makeBank, makeCardType, makeCustomer, makeTid, makePartner, defaultFeeTypeForQuote, makeFeeRate, makeFeeSellQuote } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

const ctx = (db: ReturnType<typeof getBotDb>) =>
  ({ db, user: { id: 1, permissions: ['TID_MANAGE', 'TID_VIEW', 'CONFIG_FEE_MANAGE', 'CONFIG_FEE_VIEW'] } }) as never;

async function dung() {
  const db = getBotDb();
  const bank = await makeBank();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const partner = await makePartner();
  const chu = await makeCustomer();     // chủ máy
  const muon = await makeCustomer();    // nhà mượn
  const tid = await makeTid({ tid: `94${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: chu.id, bankId: bank.id, partnerId: partner.id, hkdName: uniq('HKD GIA ') });
  await makeFeeRate({ partnerId: partner.id, cardTypeId: cardType.id, phiMua: 1000, phiCaiMay: 1000 });
  await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1500, effectiveFrom: new Date('2020-01-01') });
  return { db, bank, cardType, feeType, partner, chu, muon, tid };
}
const EFF = '2020-06-01T00:00:00+07:00';
const AT = new Date('2026-09-25T05:00:00Z');

describe('giá bán RIÊNG theo đại lý (tid_sell_fees.customer_id)', () => {
  it('giá chung 1,28% + giá riêng nhà MƯỢN 1,25% → mỗi nhà ăn đúng giá của mình', async () => {
    const w = await dung();
    // giá CHUNG của máy
    expect((await setTidSellFees(ctx(w.db), { tidId: w.tid.id, feeTypeId: w.feeType.id, effectiveFrom: EFF, entries: [{ cardTypeId: w.cardType.id, phiBan: 1.28 }] })).ok).toBe(true);
    // giá RIÊNG cho nhà mượn
    expect((await setTidSellFees(ctx(w.db), { tidId: w.tid.id, feeTypeId: w.feeType.id, effectiveFrom: EFF, customerId: w.muon.id, entries: [{ cardTypeId: w.cardType.id, phiBan: 1.25 }] })).ok).toBe(true);

    const tidRow = { id: w.tid.id, partnerId: w.partner.id, bankId: w.bank.id };
    const choMuon = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, AT, w.muon.id);
    const choChu = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, AT, w.chu.id);
    // sellMarginMilli = giá BÁN − giá MUA (phí mua đặt 1000 = 1,00%) ⇒ 1,25% → 250 · 1,28% → 280.
    expect(choMuon.ok && choMuon.fee.sellMarginMilli).toBe(250);    // nhà MƯỢN ăn giá riêng 1,25%
    expect(choChu.ok && choChu.fee.sellMarginMilli).toBe(280);      // CHỦ MÁY giữ giá chung 1,28%
  });

  it('giá riêng của nhà A KHÔNG lọt sang nhà B (nhà khác giữ nguyên)', async () => {
    const w = await dung();
    const nhaB = await makeCustomer();
    await setTidSellFees(ctx(w.db), { tidId: w.tid.id, feeTypeId: w.feeType.id, effectiveFrom: EFF, entries: [{ cardTypeId: w.cardType.id, phiBan: 1.28 }] });
    await setTidSellFees(ctx(w.db), { tidId: w.tid.id, feeTypeId: w.feeType.id, effectiveFrom: EFF, customerId: w.muon.id, entries: [{ cardTypeId: w.cardType.id, phiBan: 1.25 }] });
    const tidRow = { id: w.tid.id, partnerId: w.partner.id, bankId: w.bank.id };
    const choB = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, AT, nhaB.id);
    expect(choB.ok && choB.fee.sellMarginMilli).toBe(280);   // 1,28% − 1,00% phí mua
  });

  it('CHƯA đặt giá riêng → mọi đại lý vẫn ăn giá chung (không đổi hành vi cũ)', async () => {
    const w = await dung();
    await setTidSellFees(ctx(w.db), { tidId: w.tid.id, feeTypeId: w.feeType.id, effectiveFrom: EFF, entries: [{ cardTypeId: w.cardType.id, phiBan: 1.28 }] });
    const tidRow = { id: w.tid.id, partnerId: w.partner.id, bankId: w.bank.id };
    for (const kh of [w.chu.id, w.muon.id, null]) {
      const r = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, AT, kh);
      expect(r.ok && r.fee.sellMarginMilli).toBe(280);
    }
  });

  it('giá chung + giá riêng CÙNG NGÀY cùng tồn tại (unique index đã gộp customer)', async () => {
    const w = await dung();
    await setTidSellFees(ctx(w.db), { tidId: w.tid.id, feeTypeId: w.feeType.id, effectiveFrom: EFF, entries: [{ cardTypeId: w.cardType.id, phiBan: 1.28 }] });
    await setTidSellFees(ctx(w.db), { tidId: w.tid.id, feeTypeId: w.feeType.id, effectiveFrom: EFF, customerId: w.muon.id, entries: [{ cardTypeId: w.cardType.id, phiBan: 1.25 }] });
    const rows = await w.db.$queryRawUnsafe<Array<{ phi_ban: number; customer_id: number | null }>>(
      `SELECT phi_ban, customer_id FROM tid_sell_fees WHERE tid_id=$1 AND deleted_at IS NULL ORDER BY COALESCE(customer_id,0)`, w.tid.id);
    expect(rows.map((r) => [Number(r.phi_ban), r.customer_id])).toEqual([[1280, null], [1250, w.muon.id]]);
  });
});
