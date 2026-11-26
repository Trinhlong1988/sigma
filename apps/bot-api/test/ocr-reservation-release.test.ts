// [Dọn nợ 11/9 — RESERVATION MỒ CÔI ocr_bill_sent] 2 lỗ đã bắt trên prod (19 row POS mồ côi):
//   (1) XOÁ tin bill mà reservation KHÔNG nhả → gửi lại bị "đã gửi" vĩnh viễn.
//   (2) Crash giữa gửi → row treo không tin sống → mọi lần gửi sau deduped CÂM (bill mất không dấu vết).
// Test 2 CHIỀU trên throwaway Postgres qua đường THẬT sendTransferByDirection/deleteMessage.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { sendTransferByDirection, ensureOcrBillSentTable, type TransferReview } from '../src/ocr-send-service.js';
import { deleteMessage } from '../src/services/chat-message-service.js';
import { makeChatRoom, makeChatRoomDaGanKhach } from './fixtures.js';
// [14/10] Nhóm phải ĐÃ GÁN KHÁCH: service nay chặn gửi CK vào nhóm trống (ROOM_NO_CUSTOMER — nhóm không
// gắn khách thì tiền hoàn không vào đối soát). Chốt đó thêm sau loạt test này nên chúng đỏ hàng loạt.

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const anh = (tag: string): Buffer => Buffer.concat([PNG, Buffer.from(tag)]);
const tr = (over: Partial<TransferReview>): TransferReview => ({
  senderName: 'NGUYEN VAN A', senderIsAlpha: false, senderAccount: null,
  receiverName: 'KHACH HANG 01', receiverAccount: null, content: null,
  amount: 3_000_000, bank: 'MB', senderBank: null, date: '10/09/2026', time: '09:00:00',
  ref: uniq('FTRS').slice(0, 16),
  matchedRoomId: null, matchedRoomName: null,
  direction: 'DEALER_TO_ALPHA', entityType: 'DEALER', entityId: null, needsManualPick: false, warnings: [], ...over
});
const soReservation = async (roomId: string): Promise<number> => {
  const db = getBotDb();
  const r = await db.$queryRawUnsafe<{ n: bigint }[]>('SELECT COUNT(*)::bigint AS n FROM ocr_bill_sent WHERE dealer_room_id = $1', roomId);
  return Number(r[0]?.n ?? 0);
};

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); await ensureOcrBillSentTable(getBotDb()); });

describe('xoá tin bill → nhả reservation → gửi lại được', () => {
  it('CHIỀU ĐÚNG: gửi CK → xoá tin → reservation về 0 → gửi lại CÙNG CK ra tin MỚI (không deduped câm)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const buf = anh(uniq('d'));
    const ref = uniq('FTRS').slice(0, 16);
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref }), buf, 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    expect(await soReservation(room.id)).toBe(1);
    const msg = await db.chatMessage.findUnique({ where: { id: String(r1.messageId) }, select: { senderId: true } });
    await deleteMessage(db, String(r1.messageId), msg!.senderId!);
    expect(await soReservation(room.id)).toBe(0); // reservation ĐÃ nhả cùng lúc xoá tin
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref }), buf, 'ck.png', new Date());
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBeUndefined();           // tin MỚI thật — không bị "đã gửi" ma
    expect(r2.messageId).not.toBe(r1.messageId);
  });
});

describe('reserveSend self-heal reservation mồ côi', () => {
  it('CHIỀU ĐÚNG: row MỒ CÔI >10 phút (không tin sống) → tự nhả + gửi được (trước fix: deduped câm, bill MẤT)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const buf = anh(uniq('o'));
    const ref = uniq('FTRS').slice(0, 16);
    // Giả lập crash: reservation 20' tuổi, phòng KHÔNG có tin nào (key đúng định dạng ckTxnKey ref-tier).
    // [B210 19/11] Dựng `sent_at` ĐÚNG CÁCH ỨNG DỤNG GHI (truyền mốc từ chương trình), KHÔNG dùng now() của
    // máy chủ: mốc do ứng dụng ghi đang lưu sớm 7 tiếng, nên dựng bằng now() là dựng SAI HỆ QUY CHIẾU — bài
    // kiểm sẽ đỏ dù mã sản phẩm đúng (đã cắn đúng lần này).
    await db.$executeRawUnsafe(
      `INSERT INTO ocr_bill_sent (dealer_room_id, ocr_send_key, sent_at) VALUES ($1, $2, $3)`,
      room.id, `ck|ref|${ref}`, new Date(Date.now() - 20 * 60 * 1000));
    const r = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref }), buf, 'ck.png', new Date());
    expect(r.ok).toBe(true);
    expect(r.deduped).toBeUndefined();            // KHÔNG deduped câm — bill được gửi thật
    expect(r.messageId).toBeTruthy();
  });
  it('CHIỀU SAI (không heal bừa): row CÒN TƯƠI (<10 phút) → vẫn chặn trùng (nhường phiên song song)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const ref = uniq('FTRS').slice(0, 16);
    await db.$executeRawUnsafe(
      'INSERT INTO ocr_bill_sent (dealer_room_id, ocr_send_key) VALUES ($1, $2)',
      room.id, `ck|ref|${ref}`);
    const r = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref }), anh(uniq('f')), 'ck.png', new Date());
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);                 // giữ luật cũ — phiên kia đang gửi
    const inRoom = await db.chatMessage.count({ where: { roomId: room.id, deletedAt: null, metadataJson: { contains: '"isTransferRefund"' } } });
    expect(inRoom).toBe(0);                       // không đăng trùng
  });
  it('CHIỀU SAI: row cũ >10 phút NHƯNG tin sống còn mang key → KHÔNG heal (reservation đúng)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const buf = anh(uniq('g'));
    const ref = uniq('FTRS').slice(0, 16);
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref }), buf, 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    await db.$executeRawUnsafe(
      `UPDATE ocr_bill_sent SET sent_at = $2 WHERE dealer_room_id = $1`,
      room.id, new Date(Date.now() - 30 * 60 * 1000));
    // Gửi lại cùng CK: dup-theo-tin bắt trước (deduped, cập nhật tin cũ) — reservation KHÔNG bị heal mất.
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref }), buf, 'ck.png', new Date());
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBe(true);
    expect(await soReservation(room.id)).toBe(1); // row vẫn còn
  });
});
