// TỔNG GỘP SIGMA v2 (Admin Demo 5/9) — LÃI (Công ty=Σrevenue_sell; NĐT QR=giá mua, NĐT POS=0.1% tiền về) + CHI TIẾT
// per-entity (investorId/dealerId) + mapping ngày HCM (parseBound). Khẳng định số THẬT trên throwaway Postgres.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { buildAlphaAggregate, buildAlphaInvestorDetail, buildAlphaDealerDetail, parseBound } from '../src/routes/alpha-aggregate.js';
import { createQrTransactionSystem } from '@sigma/services';
import { makeBank, makePartner, makeCardType, makeFeeType, makeCustomer, makeChatRoom, makeCustomerChatGroup, makeReceiveAccountSource, makeTid, makeAgent } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function makeInvestor(feeMilli: number): Promise<{ id: number; name: string }> {
  const db = getBotDb();
  const iv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: uniq('NDT '), nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: feeMilli } });
  return { id: iv.id, name: iv.nickname };
}
async function makeRaForInvestor(bankId: number, investorId: number): Promise<number> {
  const db = getBotDb();
  const src = await makeReceiveAccountSource();
  const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId, accountName: 'TK', accountNumber: uniq('AC').slice(0, 18), investorId } });
  return ra.id;
}
async function patchTidRaw(tidId: number, cols: { kind?: string; receiveAccountId?: number | null; customerId?: number | null; investFeeMilli?: number | null }): Promise<void> {
  const db = getBotDb();
  const sets: string[] = []; const vals: unknown[] = [];
  if (cols.kind != null) { vals.push(cols.kind); sets.push(`kind = $${vals.length}`); }
  if (cols.receiveAccountId !== undefined) { vals.push(cols.receiveAccountId); sets.push(`receive_account_id = $${vals.length}`); }
  if (cols.customerId !== undefined) { vals.push(cols.customerId); sets.push(`customer_id = $${vals.length}`); }
  if (cols.investFeeMilli !== undefined) { vals.push(cols.investFeeMilli); sets.push(`invest_fee_milli = $${vals.length}`); }
  if (sets.length === 0) return;
  vals.push(tidId);
  await db.$executeRawUnsafe(`UPDATE tids SET ${sets.join(', ')} WHERE id = $${vals.length}`, ...vals);
}
async function makePosTxn(o: { tidId: number; cardTypeId: number; feeTypeId: number; amount: number; txnDate: Date; revenueSell?: number; phiCaiMayMilli?: number }): Promise<void> {
  const db = getBotDb();
  await db.$executeRawUnsafe(
    `INSERT INTO transactions (tid_id, card_type_id, fee_type_id, amount, txn_date, status, revenue_sell, revenue_amount, phi_cai_may_milli, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::timestamptz,'POSTED',$6,$6,$7, now(), now())`,
    o.tidId, o.cardTypeId, o.feeTypeId, BigInt(o.amount), o.txnDate.toISOString(), BigInt(o.revenueSell ?? 0), o.phiCaiMayMilli ?? 0
  );
}

describe('alpha-aggregate v2 — LÃI + CHI TIẾT + ngày HCM', () => {
  it('[deep-audit C1] doanh số đại lý KHÔNG đếm đôi khi 1 khách gán 2 phòng active (chọn 1 phòng, Σ khớp)', async () => {
    const bank = await makeBank(); const partner = await makePartner();
    const cardType = await makeCardType(bank.id); const feeType = await makeFeeType();
    const cust = await makeCustomer();
    const roomA = await makeChatRoom(); const roomB = await makeChatRoom();
    await makeCustomerChatGroup({ customerId: cust.id, roomId: roomA.id });
    await makeCustomerChatGroup({ customerId: cust.id, roomId: roomB.id }); // 2 phòng active cùng khách (bất thường data)
    const tid = await makeTid({ partnerId: partner.id, bankId: bank.id, hkdName: uniq('HKD DUP ') });
    await patchTidRaw(tid.id, { kind: 'POS', customerId: cust.id });
    const mid = new Date('2026-09-10T05:00:00Z');
    await makePosTxn({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amount: 100_000_000, txnDate: mid, revenueSell: 100_000, phiCaiMayMilli: 0 });
    const from = parseBound('2026-09-01')!, to = parseBound('2026-10-01')!;
    const rep = await buildAlphaAggregate(from, to);
    const dealerRows = rep.byDealer.filter((d) => d.dealerId === roomA.id || d.dealerId === roomB.id);
    // TRƯỚC fix: 2 dòng × 100tr = 200tr (đếm đôi). SAU fix: đúng 1 phòng nhận 100tr, phòng kia 0.
    expect(dealerRows.reduce((s, d) => s + d.doanhSoPos, 0)).toBe(100_000_000);
    expect(dealerRows.filter((d) => d.doanhSoPos > 0).length).toBe(1);
    // Chi tiết phòng ĐƯỢC chọn khớp; phòng kia KHÔNG hiện GD (nhất quán summary).
    const picked = dealerRows.find((d) => d.doanhSoPos > 0)!.dealerId;
    const other = picked === roomA.id ? roomB.id : roomA.id;
    const detPicked = await buildAlphaDealerDetail(from, to, picked);
    const detOther = await buildAlphaDealerDetail(from, to, other);
    expect(detPicked.totals.amountPos).toBe(100_000_000);
    expect(detOther.totals.amountPos).toBe(0);
  });

  it('parseBound: "YYYY-MM-DD" → nửa đêm HCM (UTC+7) — preset Hôm nay/Hôm qua dựa vào', () => {
    // Nửa đêm 2028-05-10 giờ HCM = 2028-05-09T17:00:00Z.
    expect(parseBound('2028-05-10')?.toISOString()).toBe('2028-05-09T17:00:00.000Z');
    expect(parseBound('2028-05-11')?.toISOString()).toBe('2028-05-10T17:00:00.000Z');
    // ISO instant giữ nguyên; rác → null.
    expect(parseBound('2028-05-10T05:00:00Z')?.toISOString()).toBe('2028-05-10T05:00:00.000Z');
    expect(parseBound('rác')).toBeNull();
    expect(parseBound('')).toBeNull();
  });

  it('lãi QR (giá mua 85k / spread 20k) + lãi NĐT POS (0.1% tiền về, override TID + phí cài máy) + Công ty=Σrevenue_sell', async () => {
    const db = getBotDb();
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();

    // Kỳ ĐỘC NHẤT 2028-05-10 HCM [2028-05-09T17:00Z → 2028-05-10T17:00Z) — totals GLOBAL nên cần window riêng.
    const from = new Date('2028-05-09T17:00:00Z');
    const to = new Date('2028-05-10T17:00:00Z');
    const mid = new Date('2028-05-10T05:00:00Z'); // HCM 12:00 ngày 10 — trong kỳ

    // ── Investor P (POS, fee 100 = 0.1%) ; ĐL A (roomA) ──
    const invP = await makeInvestor(100);
    const raP = await makeRaForInvestor(bank.id, invP.id);
    const custA = await makeCustomer();
    const roomA = await makeChatRoom({ type: 'GROUP', name: 'ĐL A' });
    await makeCustomerChatGroup({ customerId: custA.id, roomId: roomA.id });
    // P1: 100tr, pcm=0, revenue_sell=150k → tiền về 100tr, lãi NĐT = 100tr×0.1% = 100.000
    const tidP1 = await makeTid({ partnerId: partner.id, bankId: bank.id, hkdName: uniq('HKD P1 ') });
    await patchTidRaw(tidP1.id, { kind: 'POS', receiveAccountId: raP, customerId: custA.id });
    await makePosTxn({ tidId: tidP1.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amount: 100_000_000, txnDate: mid, revenueSell: 150_000, phiCaiMayMilli: 0 });
    // P2: 40tr, override fee 250, pcm=1000(1%) → tiền về 39,6tr, lãi = 39.600.000×0.25% = 99.000 ; revenue_sell=60k
    const tidP2 = await makeTid({ partnerId: partner.id, bankId: bank.id, hkdName: uniq('HKD P2 ') });
    await patchTidRaw(tidP2.id, { kind: 'POS', receiveAccountId: raP, customerId: custA.id, investFeeMilli: 250 });
    await makePosTxn({ tidId: tidP2.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amount: 40_000_000, txnDate: mid, revenueSell: 60_000, phiCaiMayMilli: 1000 });
    // NGOÀI kỳ (HCM 00:30 ngày 11 = 17:30Z) — phải bị loại khỏi mọi tổng/chi tiết.
    await makePosTxn({ tidId: tidP1.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amount: 7_777, txnDate: new Date('2028-05-10T17:30:00Z'), revenueSell: 1, phiCaiMayMilli: 0 });

    // ── Investor Q (QR, fee 0) ; ĐL B (roomB) — 10tr, phiMua 850, phiBan 1050 → giá mua 85k, spread 20k ──
    const invQ = await makeInvestor(0);
    const raQ = await makeRaForInvestor(bank.id, invQ.id);
    const roomB = await makeChatRoom({ type: 'GROUP', name: 'ĐL B' });
    const tidQ = await makeTid({ partnerId: partner.id, bankId: bank.id, hkdName: uniq('HKD Q ') });
    await patchTidRaw(tidQ.id, { kind: 'QR', receiveAccountId: raQ });
    const rq = await createQrTransactionSystem(db, { tidId: tidQ.id, amount: 10_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: mid, dealerRoomId: roomB.id });
    expect(rq.ok).toBe(true);

    // Hoàn POS/CK cho ĐL A = 500k (tin, billDate trong kỳ).
    const bot = await makeAgent();
    await db.chatMessage.create({ data: { roomId: roomA.id, senderId: bot.id, kind: 'IMAGE', body: 'hoàn CK', metadataJson: JSON.stringify({ isDealerRefundCk: true, refundAmount: 500_000, ckTxnKey: `ck|${uniq('K')}`, billDate: '2028-05-10' }) } });

    const rep = await buildAlphaAggregate(from, to);

    // ── LÃI NĐT per-NĐT ──
    const rowP = rep.byInvestor.find((r) => r.investorId === invP.id)!;
    const rowQ = rep.byInvestor.find((r) => r.investorId === invQ.id)!;
    expect(rowP.doanhSoPos).toBe(140_000_000);
    expect(rowP.laiNdtPos).toBe(199_000); // 100.000 (P1) + 99.000 (P2 override+pcm)
    expect(rowP.laiNdtQr).toBe(0);
    expect(rowP.laiNdt).toBe(199_000);
    expect(rowQ.doanhSoQr).toBe(10_000_000);
    expect(rowQ.laiNdtQr).toBe(85_000); // giá mua QR = revenue_partner
    expect(rowQ.laiNdtPos).toBe(0);
    expect(rowQ.laiNdt).toBe(85_000);

    // ── LÃI CÔNG TY = Σ revenue_sell (window độc nhất → chỉ 3 GD của test này) ──
    expect(rep.totals.laiCongTyPos).toBe(210_000); // 150k + 60k
    expect(rep.totals.laiCongTyQr).toBe(20_000);   // spread QR
    expect(rep.totals.laiCongTy).toBe(230_000);
    expect(rep.totals.laiNdtPos).toBe(199_000);
    expect(rep.totals.laiNdtQr).toBe(85_000);
    expect(rep.totals.laiNdt).toBe(284_000);
    // Doanh số biên: GD 7.777 ngoài kỳ bị loại.
    expect(rep.totals.doanhSoPos).toBe(140_000_000);
    expect(rep.totals.doanhSoQr).toBe(10_000_000);

    // ── CHI TIẾT NĐT P (POS-only): 2 GD, tách kỳ, lãi per-GD; giá mua null cho POS ──
    const detP = await buildAlphaInvestorDetail(from, to, invP.id);
    expect(detP.rows.length).toBe(2); // GD ngoài kỳ KHÔNG có
    expect(detP.rows.every((r) => r.kind === 'POS')).toBe(true);
    expect(detP.rows.every((r) => r.giaMua === null && r.ndtTraAlpha === null)).toBe(true);
    expect(detP.totals.amountPos).toBe(140_000_000);
    expect(detP.totals.amountQr).toBe(0);
    expect(detP.totals.laiNdt).toBe(199_000);
    const laiSet = detP.rows.map((r) => r.laiNdt).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(laiSet).toEqual([99_000, 100_000]);

    // ── CHI TIẾT NĐT Q (QR-only): giá mua 85k, NĐT trả SigMa 9.915.000, lãi = giá mua ──
    const detQ = await buildAlphaInvestorDetail(from, to, invQ.id);
    expect(detQ.rows.length).toBe(1);
    expect(detQ.rows[0].kind).toBe('QR');
    expect(detQ.rows[0].giaMua).toBe(85_000);
    expect(detQ.rows[0].ndtTraAlpha).toBe(9_915_000);
    expect(detQ.rows[0].laiNdt).toBe(85_000);
    expect(detQ.totals.laiNdt).toBe(85_000);
    expect(detQ.totals.hoan).toBe(9_915_000); // = Σ NĐT trả SigMa (khớp summary rowQ.hoan)
    expect(rowQ.hoan).toBe(9_915_000);

    // ── CHI TIẾT ĐL B (QR): phí bán = revenue_amount(105k), đại lý hoàn = 9.895.000 ; refunds rỗng ──
    const detB = await buildAlphaDealerDetail(from, to, roomB.id);
    expect(detB.rows.length).toBe(1);
    expect(detB.rows[0].kind).toBe('QR');
    expect(detB.rows[0].phiBan).toBe(105_000);
    expect(detB.rows[0].daiLyHoan).toBe(9_895_000);
    expect(detB.refunds.length).toBe(0);
    expect(detB.totals.hoan).toBe(9_895_000);

    // ── CHI TIẾT ĐL A (POS): 2 GD POS (phí bán/hoàn null per-GD), hoàn POS/CK 500k ở `refunds` ──
    const detA = await buildAlphaDealerDetail(from, to, roomA.id);
    expect(detA.rows.filter((r) => r.kind === 'POS').length).toBe(2);
    expect(detA.rows.every((r) => r.phiBan === null && r.daiLyHoan === null)).toBe(true);
    expect(detA.totals.amountPos).toBe(140_000_000);
    expect(detA.refunds).toEqual([{ billDate: '2028-05-10', amount: 500_000 }]);
    expect(detA.totals.hoan).toBe(500_000); // khớp summary dealer A hoàn
    const dA = rep.byDealer.find((r) => r.dealerId === roomA.id)!;
    expect(dA.hoan).toBe(500_000);
  });
});
