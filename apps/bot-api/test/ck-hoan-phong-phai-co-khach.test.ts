// [Admin Demo 26/9 "bill chuyển khoản sửa phân loại xong lại không ghi nhận vào doanh số"]
// GỐC: đối soát hoàn (listDealerRefundCks) đọc CK THEO PHÒNG. Nếu CK được gửi vào nhóm CHƯA GÁN KHÁCH
// (vd "QR - Nguyễn") thì KHÔNG nhóm doanh số nào thấy ⇒ tiền hoàn biến mất khỏi sổ, câm.
// Khoá: postDealerRefundCk phải CHẶN phòng không có khách (ROOM_NO_CUSTOMER), phòng có khách vẫn gửi bình thường.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { postDealerRefundCk, listDealerRefundCks } from '../src/ocr-send-service.js';
import { makeChatRoom, makeCustomer, makeCustomerChatGroup } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
/** PNG 1×1 THẬT — attachment gate chặn MIME lạ (Buffer.from('chuỗi') bị từ chối ATT_FAIL:MIME_NOT_ALLOWED).
 *  Thêm đuôi ngẫu nhiên sau IEND để mỗi test có HASH ẢNH khác nhau, không dính dedup theo ảnh. */
function anhPng(): Buffer {
  const base = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  return Buffer.concat([base, Buffer.from(uniq('x'))]);
}
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

function ck(roomId: string, amount: number) {
  return {
    transfer: {
      amount, senderName: 'SIGMA', senderAccount: null, receiverName: 'KHACH HANG 52', receiverAccount: '6886281292',
      content: 'DL test', date: '26/09/2026', time: '09:55', bank: 'VPBank', appBank: 'MBV',
      matchedRoomId: roomId, matchedRoomName: 'x', direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null, needsManualPick: false
    },
    imageBuffer: anhPng(), imageName: 'ck.png', signedAmount: amount, caption: '💸 HOÀN TIỀN ĐẠI LÝ'
  } as never;
}

describe('CK hoàn đại lý — CHẶN gửi vào nhóm chưa gán khách', () => {
  it('nhóm CHƯA gán khách → từ chối ROOM_NO_CUSTOMER (không đăng bill)', async () => {
    const db = getBotDb();
    const room = await makeChatRoom({ type: 'GROUP', name: uniq('QR - Test ') }); // KHÔNG gán khách
    const r = await postDealerRefundCk(db, ck(room.id, 41_247_000));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('ROOM_NO_CUSTOMER');
    expect((await listDealerRefundCks(db, room.id)).length).toBe(0);
  });

  it('nhóm ĐÃ gán khách → gửi được và ĐỐI SOÁT THẤY ngay', async () => {
    const db = getBotDb();
    const room = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL- Test ') });
    const kh = await makeCustomer();
    await makeCustomerChatGroup({ customerId: kh.id, roomId: room.id });
    const r = await postDealerRefundCk(db, ck(room.id, 12_345_000));
    expect(r.ok).toBe(true);
    const cks = await listDealerRefundCks(db, room.id);
    expect(cks.length).toBe(1);
    expect(cks[0]!.refundAmount).toBe(12_345_000);
  });
});
