// [Admin Demo 12/9 "đi mượn TID, chuyển về đúng nhà mượn — sau phí đúng nhưng CẦN HOÀN không tự nhảy"] CẦN HOÀN của
// buildDealerRefundReconcile phải CÙNG LUẬT GÁN với doanh số phòng: đại lý gán = los.borrowed_by_customer_id (MƯỢN/
// GHIM) ELSE chủ TID. 3 chiều: mượn-VÀO cộng cho phòng mượn · mượn-RA/ghim LOẠI khỏi phòng chủ TID · lô thường giữ nguyên.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { buildDealerRefundReconcile } from '../src/ocr-send-service.js';
import { makeBank, makeCardType, makeChatRoom, makeCustomer, makeCustomerChatGroup, makeTid, makeAgent, defaultFeeTypeForQuote } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

/** 2 nhà: A (mượn) + B (chủ TID). TID thuộc khách B. */
async function lamThegioi() {
  const db = getBotDb();
  const bank = await makeBank();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const agent = await makeAgent();
  const roomA = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL A ') });
  const roomB = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL B ') });
  const khachA = await makeCustomer();
  const khachB = await makeCustomer();
  await makeCustomerChatGroup({ customerId: khachA.id, roomId: roomA.id });
  await makeCustomerChatGroup({ customerId: khachB.id, roomId: roomB.id });
  const tidB = await makeTid({ tid: `97${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: khachB.id, bankId: bank.id, hkdName: uniq('HKD B ') });
  return { db, agent, cardType, feeType, roomA, roomB, khachA, khachB, tidB };
}
/** Ghi 1 lô thẳng DB (lo + lo_row + bill_txn_date + borrowed) — đủ cho query cần-hoàn. */
async function ghiLo(db: ReturnType<typeof getBotDb>, agentId: number, cardTypeId: number, feeTypeId: number, tidId: number, net: number, atIso: string, borrowedBy: number | null): Promise<void> {
  const lo = await db.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO los (agent_id, status, expected_total_amount, bill_txn_date, borrowed_by_customer_id, created_at, updated_at)
     VALUES ($1, 'PENDING', 0, $2::timestamptz, $3::int, now(), now()) RETURNING id`, agentId, atIso, borrowedBy);
  await db.$executeRawUnsafe(
    `INSERT INTO lo_rows (lo_id, tid_id, card_type_id, fee_type_id, amount_before_fee, fee_applied, amount_after_fee, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, $5, now())`, lo[0].id, tidId, cardTypeId, feeTypeId, net);
}

beforeAll(async () => {
  const db = getBotDb();
  await ensureAlphaExtraSchema(db);
  // Cột raw ngoài prisma (lo-service ensure lúc boot service — test DB throwaway phải tự thêm, idempotent).
  await db.$executeRawUnsafe(`ALTER TABLE los ADD COLUMN IF NOT EXISTS bill_txn_date timestamptz`);
  await db.$executeRawUnsafe(`ALTER TABLE los ADD COLUMN IF NOT EXISTS borrowed_by_customer_id integer`);
});

describe('cần hoàn theo luật MƯỢN TID (đồng nhất doanh số phòng)', () => {
  it('mượn-VÀO: lô trên TID nhà B, borrowed_by = khách A → CẦN HOÀN phòng A CÓ, phòng B KHÔNG', async () => {
    const w = await lamThegioi();
    const at = '2026-09-12T03:00:00Z'; // 10:00 HCM 12/9
    await ghiLo(w.db, w.agent.id, w.cardType.id, w.feeType.id, w.tidB.id, 5_000_000, at, w.khachA.id);
    const from = new Date('2026-09-11T17:00:00Z'), to = new Date('2026-09-12T17:00:00Z');
    const repA = await buildDealerRefundReconcile(w.db, w.roomA.id, from, to);
    const repB = await buildDealerRefundReconcile(w.db, w.roomB.id, from, to);
    expect(repA.totalCanHoan).toBe(5_000_000); // trước fix: 0 — "cần hoàn không tự nhảy"
    expect(repB.totalCanHoan).toBe(0); // chủ TID cho mượn KHÔNG gánh cần-hoàn lô mượn
  });
  it('ghim/mượn-RA: lô trên TID nhà B, borrowed_by = khách B khác (giữ nguyên B) vs khách A — chiều thường không đổi', async () => {
    const w = await lamThegioi();
    const at = '2026-09-12T04:00:00Z';
    await ghiLo(w.db, w.agent.id, w.cardType.id, w.feeType.id, w.tidB.id, 7_000_000, at, null); // lô thường của B
    const from = new Date('2026-09-11T17:00:00Z'), to = new Date('2026-09-12T17:00:00Z');
    const repB = await buildDealerRefundReconcile(w.db, w.roomB.id, from, to);
    expect(repB.totalCanHoan).toBe(7_000_000); // lô thường: như cũ
    const repA = await buildDealerRefundReconcile(w.db, w.roomA.id, from, to);
    expect(repA.totalCanHoan).toBe(0);
  });
  it('ghim quá khứ (đổi chủ TID): TID nay thuộc A nhưng lô cũ borrowed_by = khách B → cần hoàn A KHÔNG cộng lô ghim, B CÓ', async () => {
    const w = await lamThegioi();
    // đổi chủ: TID B → khách A (như ca Trà My 3), lô cũ ghim borrowed_by = B
    await w.db.$executeRawUnsafe(`UPDATE tids SET customer_id = $1 WHERE id = $2`, w.khachA.id, w.tidB.id);
    const at = '2026-09-12T05:00:00Z';
    await ghiLo(w.db, w.agent.id, w.cardType.id, w.feeType.id, w.tidB.id, 9_000_000, at, w.khachB.id); // lô ghim về B
    await ghiLo(w.db, w.agent.id, w.cardType.id, w.feeType.id, w.tidB.id, 4_000_000, at, null); // lô mới của A
    const from = new Date('2026-09-11T17:00:00Z'), to = new Date('2026-09-12T17:00:00Z');
    const repA = await buildDealerRefundReconcile(w.db, w.roomA.id, from, to);
    const repB = await buildDealerRefundReconcile(w.db, w.roomB.id, from, to);
    expect(repA.totalCanHoan).toBe(4_000_000); // trước fix: 13tr (cộng oan lô ghim)
    expect(repB.totalCanHoan).toBe(9_000_000); // trước fix: 0 (lô ghim rơi câm)
  });
});
