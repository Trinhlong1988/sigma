// [Admin Demo 29/9 "tại sao bill hoàn tiền đại lý này đã ocr nhưng không ghi nhận vào doanh số ngày 29/9"]
// KHOÁ BIÊN KỲ của ĐỐI SOÁT HOÀN TIỀN ĐẠI LÝ — bill HÔM NAY không được biến mất.
//
// LỖI THẬT: `buildDealerRefundReconcile` lọc bill bằng `billDate < fmtDayHcm(to)`. Nhưng `to` KHÔNG phải lúc
// nào cũng là đầu-ngày-hôm-sau:
//   · route GET /v1/chat/rooms/:id/refund-reconcile mặc định `to = new Date()` (BÂY GIỜ)
//   · rooms-revenue-kpi dùng `cuoiKy = ky?.to ?? now`
// ⇒ `fmtDayHcm(to)` ra CHÍNH HÔM NAY ⇒ `billDate < hôm nay` gạt SẠCH mọi bill hoàn của hôm nay.
// Đo thật phòng "ĐL- Mr Nguyễn SG" ngày 29/9: gọi mặc định ra 886 bill mà KHÔNG có bill nào của hôm nay
// (bill CK 22.857.000đ Admin Demo hỏi nằm trong số bị mất); gọi [đầu 29, đầu 30) ra đủ 32 bill / 2.727.634.000đ.
//
// LUẬT: ngày cuối THỰC của kỳ = ngày của thời điểm ngay TRƯỚC `to`; biên loại-trừ = ngày kế tiếp của nó.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { buildDealerRefundReconcile } from '../src/ocr-send-service.js';
import { getBotDb } from '../src/db.js';
import { makeChatRoom, makeCustomer, makeCustomerChatGroup } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

const NGAY = '2026-05-20';   // ngày cố định, tránh phụ thuộc "hôm nay" thật
const TIEN = 22_857_000;

/** 1 phòng đại lý + 1 bill CK hoàn có billDate = NGAY. */
async function dung() {
  const db = getBotDb();
  const room = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL HOAN ') });
  const dl = await makeCustomer();
  await makeCustomerChatGroup({ customerId: dl.id, roomId: room.id });
  await db.chatMessage.create({
    data: {
      roomId: room.id, kind: 'IMAGE', body: '💸 HOÀN TIỀN ĐẠI LÝ',
      metadataJson: JSON.stringify({
        isTransferRefund: true, isDealerRefundCk: true, refundAmount: TIEN,
        receiverName: 'KHACH HANG 52', receiverAcct: 'DEMO-ACCT',
        billDate: NGAY, billTime: '15:00', ckTxnKey: `ck|hash|${uniq('h')}`, senderName: 'KHACH HANG 01'
      })
    }
  });
  return { db, room, dl };
}
const moc = (s: string) => new Date(s);

describe('đối soát hoàn đại lý — bill HÔM NAY phải hiện với mọi kiểu mốc cuối kỳ', () => {
  it('to = ĐẦU NGÀY HÔM SAU (nửa mở) → thấy bill', async () => {
    const w = await dung();
    const r = await buildDealerRefundReconcile(w.db, w.room.id, moc(`${NGAY}T00:00:00+07:00`), moc('2026-05-21T00:00:00+07:00'));
    expect(r.bills.map((b) => b.amount)).toContain(TIEN);
  });

  it('to = 23:59:59 CÙNG NGÀY (kiểu đóng) → VẪN thấy bill', async () => {
    const w = await dung();
    const r = await buildDealerRefundReconcile(w.db, w.room.id, moc(`${NGAY}T00:00:00+07:00`), moc(`${NGAY}T23:59:59+07:00`));
    expect(r.bills.map((b) => b.amount), 'kiểu đóng KHÔNG được gạt bill trong ngày').toContain(TIEN);
  });

  it('to = GIỮA NGÀY (mặc định route dùng new Date()) → VẪN thấy bill', async () => {
    const w = await dung();
    const r = await buildDealerRefundReconcile(w.db, w.room.id, moc(`${NGAY}T00:00:00+07:00`), moc(`${NGAY}T17:45:00+07:00`));
    expect(r.bills.map((b) => b.amount), 'đây chính là ca đã mất bill hôm nay').toContain(TIEN);
  });

  it('kỳ NGÀY KHÁC → KHÔNG được kéo bill này vào (không nới lỏng quá tay)', async () => {
    const w = await dung();
    const r = await buildDealerRefundReconcile(w.db, w.room.id, moc('2026-05-21T00:00:00+07:00'), moc('2026-05-22T00:00:00+07:00'));
    expect(r.bills.map((b) => b.amount)).not.toContain(TIEN);
  });
});
