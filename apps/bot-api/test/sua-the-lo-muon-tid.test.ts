// [Admin Demo 25/9 "TID Chí Đức BM-9 mượn của nhà Thiện, đang nằm ở nhà Tuyên, sao KHÔNG CHO SỬA?"]
// Cổng quyền `assertLoTidInRoom` (routes/chat.ts) chỉ hỏi "TID có gắn phòng đang mở không". Lô MƯỢN nằm ở phòng
// NGƯỜI MƯỢN còn TID thuộc CHỦ MÁY ⇒ chặn oan, báo "Lô không thuộc phạm vi doanh số phòng này".
// Khoá 3 chiều: (1) phòng CHỦ TID sửa được · (2) phòng NGƯỜI MƯỢN sửa được · (3) phòng NHÀ KHÁC vẫn BỊ CHẶN.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { assertLoTidInRoomForTest } from '../src/routes/chat.js';
import { makeBank, makeCardType, makeChatRoom, makeCustomer, makeCustomerChatGroup, makeTid, makeAgent, makeChatRoomMember, defaultFeeTypeForQuote } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

/** 3 nhà: CHỦ máy · NGƯỜI MƯỢN · NHÀ KHÁC. 1 lô của TID nhà CHỦ, đánh dấu mượn bởi nhà MƯỢN. */
async function dung(borrowed: boolean) {
  const db = getBotDb();
  const bank = await makeBank();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const agent = await makeAgent();
  const [rChu, rMuon, rKhac] = [await makeChatRoom({ type: 'GROUP', name: uniq('ĐL CHU ') }), await makeChatRoom({ type: 'GROUP', name: uniq('ĐL MUON ') }), await makeChatRoom({ type: 'GROUP', name: uniq('ĐL KHAC ') })];
  for (const r of [rChu, rMuon, rKhac]) await makeChatRoomMember(r.id, agent.id);
  const [kChu, kMuon, kKhac] = [await makeCustomer(), await makeCustomer(), await makeCustomer()];
  await makeCustomerChatGroup({ customerId: kChu.id, roomId: rChu.id });
  await makeCustomerChatGroup({ customerId: kMuon.id, roomId: rMuon.id });
  await makeCustomerChatGroup({ customerId: kKhac.id, roomId: rKhac.id });
  const tid = await makeTid({ tid: `95${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: kChu.id, bankId: bank.id, hkdName: uniq('HKD CHU ') });
  const lo = (await db.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO los (agent_id, expected_total_amount, status, borrowed_by_customer_id, created_at, updated_at)
     VALUES ($1, 1000000, 'PENDING', $2, now(), now()) RETURNING id`, agent.id, borrowed ? kMuon.id : null))[0]!;
  await db.$executeRawUnsafe(
    `INSERT INTO lo_rows (lo_id, tid_id, card_type_id, fee_type_id, amount_before_fee, fee_applied, amount_after_fee, created_at)
     VALUES ($1,$2,$3,$4,1000000,0,1000000, now())`, lo.id, tid.id, cardType.id, feeType.id);
  return { db, agent, lo, rChu, rMuon, rKhac };
}

describe('quyền SỬA THẺ của lô — phải mở cho phòng NGƯỜI MƯỢN', () => {
  it('lô MƯỢN: phòng NGƯỜI MƯỢN sửa được (trước bản vá bị chặn oan)', async () => {
    const w = await dung(true);
    expect(await assertLoTidInRoomForTest(w.db, w.agent.id, w.rMuon.id, w.lo.id)).toBe(true);
  });
  it('lô MƯỢN: phòng CHỦ MÁY vẫn sửa được', async () => {
    const w = await dung(true);
    expect(await assertLoTidInRoomForTest(w.db, w.agent.id, w.rChu.id, w.lo.id)).toBe(true);
  });
  it('lô MƯỢN: phòng NHÀ KHÁC vẫn BỊ CHẶN (không nới lỏng bảo mật)', async () => {
    const w = await dung(true);
    expect(await assertLoTidInRoomForTest(w.db, w.agent.id, w.rKhac.id, w.lo.id)).toBe(false);
  });
  it('lô THƯỜNG (không mượn): chỉ phòng CHỦ MÁY sửa được', async () => {
    const w = await dung(false);
    expect(await assertLoTidInRoomForTest(w.db, w.agent.id, w.rChu.id, w.lo.id)).toBe(true);
    expect(await assertLoTidInRoomForTest(w.db, w.agent.id, w.rMuon.id, w.lo.id)).toBe(false);
  });
});
