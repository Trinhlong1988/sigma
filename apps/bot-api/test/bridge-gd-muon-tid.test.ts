// [Admin Demo 25/9 "doanh số TID đi mượn không chuyển về đúng phòng chat"] KHOÁ LUẬT GÁN KHÁCH CHO GIAO DỊCH.
//
// LỖI THẬT: tin bill đã về đúng phòng đại lý MƯỢN, nhưng bridgeBillLoToTransaction gọi createTransactionSystem
// KHÔNG truyền customerId ⇒ rơi về mặc định "lấy theo TID" = CHỦ MÁY. Mọi màn đọc bảng transactions (Doanh số,
// SigMa, báo cáo) vì thế ghi tiền cho CHỦ TID thay vì NHÀ MƯỢN — sai người, câm.
// Đo trên prod 25/9: 39 lô mượn có GD ghi sai nhà, tổng 1.653.771.000đ.
//
// Khoá 2 chiều: có mượn → GD ghi NHÀ MƯỢN · không mượn → GD giữ CHỦ TID (không đổi hành vi cũ).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { createLoFromBillTid } from '../src/lo-service.js';
import { makeBank, makeCardType, makeCustomer, makeTid, makeAgent, defaultFeeTypeForQuote, makeFeeSellQuote, makePartner, makeTidVisibleToAgentViaGroup, makeFeeRate, makeTidSellFee } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

async function thegioi() {
  const db = getBotDb();
  const bank = await makeBank();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const partner = await makePartner();
  const agent = await makeAgent();
  const nhaMuon = await makeCustomer();
  const tid = await makeTid({ tid: `96${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, bankId: bank.id, partnerId: partner.id, hkdName: uniq('HKD MUON ') });
  // Cho agent "thấy" TID qua chuỗi phòng/nhóm (createLoFromBillTid gate TID_NOT_IN_AGENT_SCOPE);
  // fixture này gán luôn tid.customerId = khách vừa dựng ⇒ đó chính là CHỦ TID.
  const noi = await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
  const chuTid = noi.customer;
  // giá mua (đối tác) + giá bán (TID) để bridge tính được doanh thu
  await makeFeeRate({ partnerId: partner.id, cardTypeId: cardType.id, phiMua: 1000, phiCaiMay: 1000 });
  await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1500, effectiveFrom: new Date('2020-01-01') });
  await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1500 });
  return { db, agent, cardType, feeType, tid, chuTid, nhaMuon };
}

describe('bridge lô → giao dịch: khách của GD phải theo NHÀ MƯỢN', () => {
  it('CÓ mượn TID → transactions.customer_id = nhà MƯỢN (không phải chủ máy)', async () => {
    const w = await thegioi();
    const r = await createLoFromBillTid(w.db, w.agent.id, {
      tidString: w.tid.tid, cardTypeId: w.cardType.id, amountBeforeFee: 10_000_000,
      billKey: uniq('nat|muon|'), allowDuplicate: true, borrowedByCustomerId: w.nhaMuon.id
    } as never);
    expect(r.ok).toBe(true);
    const lo = await w.db.$queryRawUnsafe<{ transaction_id: number | null; borrowed_by_customer_id: number | null }[]>(
      `SELECT transaction_id, borrowed_by_customer_id FROM los WHERE id = $1`, (r as { data: { id: number } }).data.id);
    expect(lo[0]!.borrowed_by_customer_id).toBe(w.nhaMuon.id);
    expect(lo[0]!.transaction_id).not.toBeNull();
    const gd = await w.db.transaction.findUniqueOrThrow({ where: { id: lo[0]!.transaction_id! }, select: { customerId: true } });
    expect(gd.customerId).toBe(w.nhaMuon.id);   // ← trước bản vá: bằng chuTid.id
  });

  it('KHÔNG mượn → transactions.customer_id giữ CHỦ TID (không đổi hành vi cũ)', async () => {
    const w = await thegioi();
    const r = await createLoFromBillTid(w.db, w.agent.id, {
      tidString: w.tid.tid, cardTypeId: w.cardType.id, amountBeforeFee: 8_000_000,
      billKey: uniq('nat|thuong|'), allowDuplicate: true
    } as never);
    expect(r.ok).toBe(true);
    const lo = await w.db.$queryRawUnsafe<{ transaction_id: number | null }[]>(
      `SELECT transaction_id FROM los WHERE id = $1`, (r as { data: { id: number } }).data.id);
    const gd = await w.db.transaction.findUniqueOrThrow({ where: { id: lo[0]!.transaction_id! }, select: { customerId: true } });
    expect(gd.customerId).toBe(w.chuTid.id);
  });
});
