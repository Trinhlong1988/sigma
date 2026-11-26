// [Admin Demo 27/9 "lại con 2 Đại lý C và ĐL Đại lý C"] KHOÁ: một khách/NĐT chỉ được hiện DUY NHẤT MỘT TÊN.
//
// LỖI THẬT: cùng đại lý #223 nhưng bảng tra soát tách 2 dòng —
//   · 53 GD ghi "Đại lý C"     (tên lấy từ ánh xạ tay = customers.nickname)
//   · 11 GD ghi "ĐL- Đại lý C" (tên lấy từ map học-từ-bill = tên PHÒNG CHAT)
// ⇒ cùng một đại lý cộng sổ ra 2 nơi, nhìn như 2 khách. Đây là LẶP LẠI lớp lỗi "2 Nguyễn" (8/9) — lần đó chỉ
// vá nhánh override, nên nguồn khớp khác vẫn đẻ tên khác.
//
// LUẬT: sau khi khớp xong, hễ có matchedCustomerId/matchedInvestorId thì tên hiển thị PHẢI là tên chuẩn trong
// DB, bất kể khớp bằng nguồn nào (ánh xạ tay / học-từ-bill / sửa tay / tài khoản nhận).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { reconcileStatement } from '../src/statement-recon.js';
import { getBotDb } from '../src/db.js';
import { makeBank, makeChatRoom, makeCustomer, makeCustomerChatGroup } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

/** 1 đại lý, khớp được bằng HAI nguồn khác nhau: (a) ánh xạ tay theo STK, (b) map học từ bill trong phòng
 *  chat có TÊN PHÒNG khác hẳn nickname khách. Hai GD, mỗi GD đi một đường. */
async function dung() {
  const db = getBotDb();
  await makeBank();
  const dl = await makeCustomer();                       // nickname do fixture sinh = TÊN CHUẨN
  const chuan = (await db.customer.findUnique({ where: { id: dl.id }, select: { nickname: true, fullName: true } }))!;
  const tenChuan = chuan.nickname || chuan.fullName!;
  // (a) ánh xạ tay theo STK
  const stkTay = String(3_000_000 + Math.floor(Math.random() * 1e6));
  await db.$executeRawUnsafe(
    `INSERT INTO statement_dealer_alias (key, key_kind, customer_id, note) VALUES ($1,'acct',$2,'test')
     ON CONFLICT (key, key_kind) DO UPDATE SET customer_id = EXCLUDED.customer_id`, stkTay, dl.id);
  // (b) map học-từ-bill: phòng chat có TÊN KHÁC nickname, bill hoàn ghi người nhận stkBill
  const room = await makeChatRoom({ type: 'GROUP', name: `ĐL- ${tenChuan}` });   // tên phòng ≠ nickname
  await makeCustomerChatGroup({ customerId: dl.id, roomId: room.id });
  const stkBill = String(4_000_000 + Math.floor(Math.random() * 1e6));
  const tenBill = uniq('NGUOI NHAN ');
  await db.chatMessage.create({
    data: { roomId: room.id, kind: 'IMAGE', body: '💸 HOÀN TIỀN ĐẠI LÝ',
      metadataJson: JSON.stringify({ isTransferRefund: true, isDealerRefundCk: true, refundAmount: 5_000_000, receiverName: tenBill, receiverAcct: stkBill }) }
  });
  return { db, dl, tenChuan, stkTay, stkBill, tenBill };
}

const saoKe = (rows: Array<{ stk: string; ten: string | null; tien: number }>) => ({
  accountHolder: 'KHACH HANG 01', accountNumber: 'DEMO-ACCT', accountBank: 'MB',
  txns: rows.map((r, i) => ({ rowIndex: i + 1, dateTime: '2026-09-26T10:00:00', ref: uniq('FT'),
    debit: r.tien, credit: 0, desc: 'chuyen tien', cpName: r.ten, cpAccount: r.stk, cpBank: 'MB', descName: null }))
});

describe('tra soát — một khách chỉ có MỘT tên hiển thị', () => {
  it('khớp bằng ánh xạ tay và bằng map học-từ-bill → CÙNG một tên chuẩn, không tách 2 nhóm', async () => {
    const w = await dung();
    const r = await reconcileStatement(w.db, saoKe([
      { stk: w.stkTay, ten: null, tien: 100_000_000 },
      { stk: w.stkBill, ten: w.tenBill, tien: 50_000_000 }
    ]) as never);
    const cua = r.txns.filter((t) => t.matchedCustomerId === w.dl.id);
    expect(cua.length, 'cả 2 GD phải về cùng khách').toBe(2);
    const ten = [...new Set(cua.map((t) => t.matchedName))];
    expect(ten, `phải CHỈ 1 tên, đang có: ${ten.join(' | ')}`).toEqual([w.tenChuan]);
  });

  it('tên hiển thị KHÔNG được là tên phòng chat khi khách có nickname riêng', async () => {
    const w = await dung();
    const r = await reconcileStatement(w.db, saoKe([{ stk: w.stkBill, ten: w.tenBill, tien: 50_000_000 }]) as never);
    const t = r.txns[0]!;
    expect(t.matchedCustomerId).toBe(w.dl.id);
    expect(String(t.matchedName)).not.toMatch(/^ĐL- /);
    expect(t.matchedName).toBe(w.tenChuan);
  });
});
