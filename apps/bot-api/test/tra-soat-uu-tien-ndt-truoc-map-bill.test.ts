// [Admin Demo 26/9 "đưa đúng các khoản hoàn đại lý Đại lý C"] KHOÁ THỨ TỰ ƯU TIÊN khi khớp đối ứng trong TRA SOÁT.
//
// CA THẬT: ĐÚNG MỘT bill hoàn 100.000.000đ, người nhận KHACH HANG 02 / STK 50704397, bị gửi nhầm vào phòng
// "ĐL- Đại lý C". Bộ khớp học từ bill ⇒ "50704397 = Đại lý C" ⇒ kéo theo **79 giao dịch** chuyển cho Khach Demo A
// (**20.785.209.478đ**) vào sổ hoàn của Đại lý C — trong khi KHACH HANG 02 là NĐT NĐT 2.
// MỘT bill đặt nhầm phòng bẻ cong hơn 20 tỷ ⇒ phải chặn ở LỚP KHỚP, không chỉ dọn dữ liệu.
//
// LUẬT: 1) ánh xạ TAY (người khai) → 2) là NHÀ ĐẦU TƯ → 3) map HỌC TỪ BILL OCR (yếu nhất, bill có thể lạc phòng).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { reconcileStatement } from '../src/statement-recon.js';
import { getBotDb } from '../src/db.js';
import { makeBank, makeChatRoom, makeCustomer, makeCustomerChatGroup } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

/** Dựng: 1 NĐT có TK STK_NDT + 1 phòng đại lý có bill hoàn LẠC (người nhận chính là STK_NDT). */
async function dung() {
  const db = getBotDb();
  const bank = await makeBank();
  const stkNdt = String(5_000_000 + Math.floor(Math.random() * 1e6));
  const tenNdt = uniq('NGUOI NDT ');
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), nickname: uniq('NDT '), fullName: tenNdt } });
  await db.receiveAccount.create({ data: { investorId: inv.id, accountName: tenNdt, accountNumber: stkNdt, bankId: bank.id, sourceId: 5, updatedAt: new Date() } });
  // Phòng ĐẠI LÝ + bill hoàn LẠC: người nhận là STK/tên của NĐT trên
  const room = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL LAC ') });
  const dl = await makeCustomer();
  await makeCustomerChatGroup({ customerId: dl.id, roomId: room.id });
  const bot = await db.agent.findFirst({ where: { code: 'SUPPORT_ALPHA' }, select: { id: true } });
  await db.chatMessage.create({
    data: {
      roomId: room.id, senderId: bot?.id ?? null, kind: 'IMAGE', body: '💸 HOÀN TIỀN ĐẠI LÝ',
      metadataJson: JSON.stringify({ isTransferRefund: true, isDealerRefundCk: true, refundAmount: 100_000_000, receiverName: tenNdt, receiverAcct: stkNdt })
    }
  });
  return { db, inv, stkNdt, tenNdt, dl, room };
}
const saoKe = (stk: string, ten: string) => ({
  accountHolder: 'KHACH HANG 01', accountNumber: '1900668888', accountBank: 'TCB',
  txns: [{ rowIndex: 1, dateTime: '2026-09-25T00:00:00', ref: uniq('FT'), debit: 455_232_000, credit: 0,
    desc: 'CUSTOMER KHACH HANG 01', cpName: ten, cpAccount: stk, cpBank: 'ACB', descName: 'KHACH HANG 01' }]
});

describe('tra soát — NHÀ ĐẦU TƯ thắng map học-từ-bill (1 bill lạc phòng không được bẻ cả sổ)', () => {
  it('đối ứng là TK của NĐT → về NĐT, KHÔNG về đại lý dù có bill hoàn lạc trong phòng đại lý', async () => {
    const w = await dung();
    const r = await reconcileStatement(w.db, saoKe(w.stkNdt, w.tenNdt) as never);
    const t = r.txns[0]!;
    expect(t.matchedInvestorId).toBe(w.inv.id);
    expect(t.matchedCustomerId).toBeNull();          // trước bản vá: = khách của phòng lạc
    expect(t.kind).toBe('INVESTOR_REPAY');
  });

  it('đối ứng KHÔNG dính NĐT → map học-từ-bill vẫn chạy bình thường (không phá ca thường)', async () => {
    const w = await dung();
    const stkLa = String(7_000_000 + Math.floor(Math.random() * 1e6));
    const tenLa = uniq('NGUOI DL ');
    // dạy map: bill hoàn trong phòng đại lý, người nhận KHÔNG phải NĐT nào
    await w.db.chatMessage.create({
      data: { roomId: w.room.id, kind: 'IMAGE', body: '💸 HOÀN TIỀN ĐẠI LÝ',
        metadataJson: JSON.stringify({ isTransferRefund: true, isDealerRefundCk: true, refundAmount: 5_000_000, receiverName: tenLa, receiverAcct: stkLa }) }
    });
    const r = await reconcileStatement(w.db, saoKe(stkLa, tenLa) as never);
    const t = r.txns[0]!;
    expect(t.matchedCustomerId).toBe(w.dl.id);
    expect(t.kind).toBe('DEALER_REFUND');
  });
});
