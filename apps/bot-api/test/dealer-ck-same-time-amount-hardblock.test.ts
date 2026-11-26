// [Admin Demo 11/9 — "2 giao dịch cùng giờ phút, cùng số tiền chặn cứng — hoặc phải xác nhận sửa giờ"]
// CK cùng phòng + cùng NGÀY + cùng |TIỀN| + cùng GIỜ:PHÚT nhưng khoá/ảnh KHÁC = nghi cùng 1 GD chụp 2 ảnh →
// CHẶN CỨNG (CK_TRUNG_GIO_TIEN). Đường thoát: sửa GIỜ rồi gửi lại. Test 2 CHIỀU trên throwaway Postgres, đường
// THẬT sendTransferByDirection → postDealerRefundCk.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { sendTransferByDirection, type TransferReview } from '../src/ocr-send-service.js';
import { makeChatRoom, makeChatRoomDaGanKhach } from './fixtures.js';
// [14/10] Nhóm phải ĐÃ GÁN KHÁCH: service nay chặn gửi CK vào nhóm trống (ROOM_NO_CUSTOMER — nhóm không
// gắn khách thì tiền hoàn không vào đối soát). Chốt đó thêm sau loạt test này nên chúng đỏ hàng loạt.

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const anh = (tag: string): Buffer => Buffer.concat([PNG, Buffer.from(tag)]);
const tr = (over: Partial<TransferReview>): TransferReview => ({
  senderName: 'NGUYEN VAN A', senderIsAlpha: false, senderAccount: null,
  receiverName: 'KHACH HANG 01', receiverAccount: null, content: null,
  amount: 7_000_000, bank: 'MB', senderBank: null, date: '11/09/2026', time: '10:30:00',
  ref: uniq('FTHB').slice(0, 16),
  matchedRoomId: null, matchedRoomName: null,
  direction: 'DEALER_TO_ALPHA', entityType: 'DEALER', entityId: null, needsManualPick: false, warnings: [], ...over
});
const soTinCk = async (roomId: string): Promise<number> =>
  getBotDb().chatMessage.count({ where: { roomId, deletedAt: null, metadataJson: { contains: '"isTransferRefund"' } } });

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('CK cùng giờ:phút + cùng tiền — chặn cứng (Admin Demo 11/9)', () => {
  it('[CHÍNH SÁCH 11/9] cả 2 CÓ MÃ GD khác nhau + cùng ngày+tiền+GIỜ:PHÚT → 2 GD KHÁC THẬT, KHÔNG chặn', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id }), anh(uniq('a')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, time: '10:30:45' }), anh(uniq('b')), 'ck.png', new Date()); // ref khác (uniq) — GIỜ:PHÚT trùng
    expect(r2.ok).toBe(true); // mã GD/mã chuẩn chi khác nhau = được coi là 2 GD khác nhau (Admin Demo 11/9)
    expect(await soTinCk(room.id)).toBe(2);
  });
  it('CHIỀU SAI: THIẾU MÃ GD (2 bill không ref) + cùng ngày+tiền+GIỜ:PHÚT → CHẶN CK_TRUNG_GIO_TIEN', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const stk = { ref: null, senderAccount: uniq('11'), receiverAccount: uniq('22') }; // key tier nat (không mã GD)
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ...stk }), anh(uniq('a2')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref: null, senderAccount: uniq('33'), receiverAccount: uniq('44'), time: '10:30:45' }), anh(uniq('b2')), 'ck.png', new Date());
    expect(r2.ok).toBe(false);
    expect(String(r2.error)).toMatch(/^CK_TRUNG_GIO_TIEN:/);
    expect(r2.message).toContain('sửa GIỜ');
    expect(await soTinCk(room.id)).toBe(1); // fail-closed thật
  });
  it('ĐƯỜNG THOÁT: sửa GIỜ (phút khác) → gửi được (xác nhận GD khác thật)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref: null, senderAccount: uniq('51'), receiverAccount: uniq('52') }), anh(uniq('c')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const buf2 = anh(uniq('d'));
    const t2 = tr({ matchedRoomId: room.id, ref: null, senderAccount: uniq('53'), receiverAccount: uniq('54') }); // cùng tiền cùng ngày, KHÔNG mã GD (chính sách 11/9: có mã khác nhau thì đã cho qua)
    const chan = await sendTransferByDirection(db, { ...t2, time: '10:30:59' }, buf2, 'ck.png', new Date());
    expect(chan.ok).toBe(false); // trước khi sửa giờ: chặn
    const qua = await sendTransferByDirection(db, { ...t2, time: '10:31:00' }, buf2, 'ck.png', new Date()); // sửa giờ → phút khác
    expect(qua.ok).toBe(true);
    expect(await soTinCk(room.id)).toBe(2);
  });
  it('CHIỀU ĐÚNG: cùng tiền cùng ngày nhưng KHÁC GIỜ ngay từ đầu → gửi bình thường (chỉ cờ đỏ review)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id }), anh(uniq('e')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, time: '15:45:00' }), anh(uniq('f')), 'ck.png', new Date());
    expect(r2.ok).toBe(true);
    expect(await soTinCk(room.id)).toBe(2);
  });
  it('CHIỀU ĐÚNG: gửi lại CHÍNH nó (cùng khoá) → vẫn deduped/update tin cũ, KHÔNG bị chặn oan', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const buf = anh(uniq('g'));
    const ref = uniq('FTHB').slice(0, 16);
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref }), buf, 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref }), buf, 'ck.png', new Date());
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBe(true);
  });
  it('CHIỀU SAI: cả HAI đều KHÔNG có giờ, cùng ngày+tiền, khoá khác → chặn (ép nhập giờ)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, time: null, ref: null, senderAccount: uniq('61'), receiverAccount: uniq('62') }), anh(uniq('h')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, time: null, ref: null, senderAccount: uniq('63'), receiverAccount: uniq('64') }), anh(uniq('i')), 'ck.png', new Date());
    expect(r2.ok).toBe(false);
    expect(String(r2.error)).toMatch(/^CK_TRUNG_GIO_TIEN:/);
  });
  it('CHIỀU ĐÚNG: 1 bên có giờ, 1 bên KHÔNG → không chặn oan (chỉ cờ đỏ)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id }), anh(uniq('j')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, time: null }), anh(uniq('k')), 'ck.png', new Date());
    expect(r2.ok).toBe(true);
  });
});
