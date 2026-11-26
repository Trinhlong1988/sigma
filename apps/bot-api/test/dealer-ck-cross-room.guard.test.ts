// [Dọn nợ 11/9 — audit #cross-room] 1 ảnh CK hoàn/ứng đại lý GỬI VÀO 2 PHÒNG khác nhau → alpha-aggregate dedup
// ckTxnKey toàn cục nuốt câm phòng sau (dạng lỗi 3 CK DakLak 169.392tr). Guard postDealerRefundCk phải CHẶN.
// Test 2 CHIỀU trên throwaway Postgres:
//   CHIỀU SAI (chặn):  CK đã gửi phòng A → gửi CÙNG ảnh/khoá vào phòng B ⇒ ok:false CK_SENT_OTHER_ROOM (cả REFUND lẫn ADVANCE).
//   CHIỀU ĐÚNG (cho):  gửi lại CHÍNH phòng A ⇒ deduped (không tin trùng); CK KHÁC (ảnh+ref khác) vào phòng B ⇒ ok bình thường.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { sendTransferByDirection, type TransferReview } from '../src/ocr-send-service.js';
import { makeChatRoom, makeChatRoomDaGanKhach } from './fixtures.js';
// [14/10] Nhóm phải ĐÃ GÁN KHÁCH: service nay chặn gửi CK vào nhóm trống (ROOM_NO_CUSTOMER — nhóm không
// gắn khách thì tiền hoàn không vào đối soát). Chốt đó thêm sau loạt test này nên chúng đỏ hàng loạt.

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
// PNG 1x1 hợp lệ (saveAttachment sniff magic bytes) + đuôi khác nhau để mỗi ca có HASH ẢNH riêng.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const anh = (tag: string): Buffer => Buffer.concat([PNG, Buffer.from(tag)]);

const tr = (over: Partial<TransferReview>): TransferReview => ({
  senderName: 'NGUYEN VAN A', senderIsAlpha: false, senderAccount: null,
  receiverName: 'KHACH HANG 01', receiverAccount: null, content: null,
  amount: 5_000_000, bank: 'MB', senderBank: null, date: '10/09/2026', time: '10:00:00',
  ref: uniq('FTCR').slice(0, 16), // ref DÀI có chữ → ckTxnKey ref-tier toàn cục
  matchedRoomId: null, matchedRoomName: null,
  direction: 'DEALER_TO_ALPHA', entityType: 'DEALER', entityId: null, needsManualPick: false, warnings: [], ...over
});

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('postDealerRefundCk — guard 1 CK không nằm 2 phòng', () => {
  it('CHIỀU SAI: cùng ảnh+ref đã gửi phòng A → phòng B bị CHẶN CK_SENT_OTHER_ROOM', async () => {
    const db = getBotDb();
    const roomA = await makeChatRoomDaGanKhach({ name: uniq('ĐL A ') });
    const roomB = await makeChatRoomDaGanKhach({ name: uniq('ĐL B ') });
    const buf = anh(uniq('x'));
    const ref = uniq('FTCR').slice(0, 16);
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: roomA.id, ref }), buf, 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: roomB.id, ref }), buf, 'ck.png', new Date());
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe(`CK_SENT_OTHER_ROOM:${roomA.id}`);
    expect(r2.message).toContain('ĐÃ GỬI ở nhóm KHÁC');
    // Phòng B KHÔNG được có tin CK nào (fail-closed thật, không chỉ trả lỗi).
    const inB = await db.chatMessage.count({ where: { roomId: roomB.id, deletedAt: null, metadataJson: { contains: '"isTransferRefund"' } } });
    expect(inB).toBe(0);
  });
  it('CHIỀU SAI: ẢNH y hệt nhưng OCR đọc lệch ref (khoá khác) → vẫn CHẶN theo hash ảnh', async () => {
    const db = getBotDb();
    const roomA = await makeChatRoomDaGanKhach({ name: uniq('ĐL A ') });
    const roomB = await makeChatRoomDaGanKhach({ name: uniq('ĐL B ') });
    const buf = anh(uniq('y'));
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: roomA.id }), buf, 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: roomB.id }), buf, 'ck.png', new Date()); // ref KHÁC (uniq) — chỉ hash trùng
    expect(r2.ok).toBe(false);
    expect(String(r2.error)).toMatch(/^CK_SENT_OTHER_ROOM:/);
  });
  it('CHIỀU SAI: ADVANCE (ứng trước) cũng bị chặn cross-room như REFUND', async () => {
    const db = getBotDb();
    const roomA = await makeChatRoomDaGanKhach({ name: uniq('ĐL A ') });
    const roomB = await makeChatRoomDaGanKhach({ name: uniq('ĐL B ') });
    const buf = anh(uniq('z'));
    const ref = uniq('FTCR').slice(0, 16);
    const r1 = await sendTransferByDirection(db, tr({ direction: 'SIGMA_TO_DEALER_ADVANCE', senderName: 'KHACH HANG 01', senderIsAlpha: true, receiverName: 'NGUYEN VAN A', matchedRoomId: roomA.id, ref }), buf, 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ direction: 'SIGMA_TO_DEALER_ADVANCE', senderName: 'KHACH HANG 01', senderIsAlpha: true, receiverName: 'NGUYEN VAN A', matchedRoomId: roomB.id, ref }), buf, 'ck.png', new Date());
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe(`CK_SENT_OTHER_ROOM:${roomA.id}`);
  });
  it('CHIỀU ĐÚNG: gửi lại CHÍNH phòng cũ → deduped (không chặn nhầm luật cập-nhật-tin-cũ)', async () => {
    const db = getBotDb();
    const roomA = await makeChatRoomDaGanKhach({ name: uniq('ĐL A ') });
    const buf = anh(uniq('t'));
    const ref = uniq('FTCR').slice(0, 16);
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: roomA.id, ref }), buf, 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: roomA.id, ref }), buf, 'ck.png', new Date());
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBe(true);
  });
  it('CHIỀU ĐÚNG: CK KHÁC (ảnh + ref khác) vào phòng B → gửi bình thường', async () => {
    const db = getBotDb();
    const roomA = await makeChatRoomDaGanKhach({ name: uniq('ĐL A ') });
    const roomB = await makeChatRoomDaGanKhach({ name: uniq('ĐL B ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: roomA.id }), anh(uniq('a')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: roomB.id }), anh(uniq('b')), 'ck.png', new Date());
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBeUndefined();
  });
});
