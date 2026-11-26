// [Admin Demo 16/9 "bank khác nhau thì phải là giao dịch khác nhau"] Miễn chặn CK_TRUNG_GIO_TIEN khi 2 bill là màn
// BÊN GỬI của 2 bank khác nhau (ca thật 15/9: 2 GD 100tr cùng 08:40 cùng người nhận — 1 từ app MBV, 1 từ app MB,
// cả 2 giấu mã GD sau "Xem thêm" → luật 11/9 chặn oan). VÁ PHẢN BIỆN kèm theo: cùng 1 GD vẫn ra 2 ảnh 2 bank
// (ảnh bên gửi app MB + ảnh BÁO CÓ bên nhận app BIDV) → ảnh báo có có appBank == bank nhận → KHÔNG được miễn.
// Thiếu bất kỳ dữ kiện bank nào (bill cũ chưa có appBank trong metadata) → fail-closed, chặn như cũ.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { sendTransferByDirection, canonBank, ckBothAppBankDistinct, type TransferReview } from '../src/ocr-send-service.js';
import { makeChatRoom, makeChatRoomDaGanKhach } from './fixtures.js';
// [14/10] Nhóm phải ĐÃ GÁN KHÁCH: service nay chặn gửi CK vào nhóm trống (ROOM_NO_CUSTOMER — nhóm không
// gắn khách thì tiền hoàn không vào đối soát). Chốt đó thêm sau loạt test này nên chúng đỏ hàng loạt.

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const anh = (tag: string): Buffer => Buffer.concat([PNG, Buffer.from(tag)]);
const tr = (over: Partial<TransferReview>): TransferReview => ({
  senderName: 'KHACH HANG 01', senderIsAlpha: false, senderAccount: null,
  receiverName: 'KHACH HANG 25', receiverAccount: null, content: null,
  amount: 100_000_000, bank: 'BIDV', senderBank: null, date: '15/09/2026', time: '08:40:00',
  ref: null, // không mã GD (ca thật: mã giấu sau "Xem thêm") → key rơi tier hash ảnh (unique, không đụng khoá toàn cục ck|ref|rác của test khác) + không lách được nhánh miễn-theo-mã (11/9); chỉ nhánh bank (16/9) quyết
  matchedRoomId: null, matchedRoomName: null,
  direction: 'DEALER_TO_ALPHA', entityType: 'DEALER', entityId: null, needsManualPick: false, warnings: [], ...over
});

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('canonBank / ckBothAppBankDistinct — đơn vị', () => {
  it('canonBank: bỏ dấu/ký tự rác + upper; MBBANK→MB (cùng nhà); MBV GIỮ NGUYÊN; rác <2 ký tự → null', () => {
    expect(canonBank('MBBank')).toBe('MB');
    expect(canonBank(' mb ')).toBe('MB');
    expect(canonBank('MBV')).toBe('MBV');
    expect(canonBank('VPBank')).toBe('VPBANK');
    expect(canonBank('M')).toBeNull();
    expect(canonBank('')).toBeNull();
    expect(canonBank(null)).toBeNull();
  });
  it('miễn CHỈ khi cả 2 là màn bên gửi (app ≠ bank nhận) và 2 app khác nhau', () => {
    const mbv = { appBank: 'MBV', receiverBank: 'BIDV' }, mb = { appBank: 'MB', receiverBank: 'BIDV' };
    expect(ckBothAppBankDistinct(mbv, mb)).toBe(true);           // ca thật 15/9 → 2 GD khác thật
    expect(ckBothAppBankDistinct(mb, mb)).toBe(false);           // cùng app → không phân biệt được
    expect(ckBothAppBankDistinct({ appBank: 'MBBank', receiverBank: 'BIDV' }, mb)).toBe(false); // MBBANK≡MB cùng nhà
    expect(ckBothAppBankDistinct({ appBank: 'BIDV', receiverBank: 'BIDV' }, mb)).toBe(false);   // BẪY: ảnh BÁO CÓ bên nhận
    expect(ckBothAppBankDistinct(mb, { appBank: 'BIDV', receiverBank: 'BIDV' })).toBe(false);   // bẫy chiều ngược
    expect(ckBothAppBankDistinct({ appBank: null, receiverBank: 'BIDV' }, mb)).toBe(false);     // thiếu appBank → fail-closed
    expect(ckBothAppBankDistinct({ appBank: 'MBV', receiverBank: null }, mb)).toBe(false);      // thiếu bank nhận → fail-closed
  });
});

describe('CK_TRUNG_GIO_TIEN — miễn theo bank (đường thật, DB)', () => {
  it('[CA THẬT 15/9] 2 bill cùng tiền+giờ+ngày, MBV ↔ MB đều màn bên gửi → CẢ 2 gửi được', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, appBank: 'MBV' }), anh(uniq('a')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, appBank: 'MB' }), anh(uniq('b')), 'ck.png', new Date());
    expect(r2.ok).toBe(true); // trước vá 16/9: false CK_TRUNG_GIO_TIEN
  });
  it('[BẪY BÁO CÓ] bill 2 là ảnh báo có bên nhận (appBank == bank nhận) → VẪN CHẶN (chống hoàn x2)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, appBank: 'MB' }), anh(uniq('c')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, appBank: 'BIDV' }), anh(uniq('d')), 'ck.png', new Date());
    expect(r2.ok).toBe(false);
    expect(r2.ok === false && r2.error?.startsWith('CK_TRUNG_GIO_TIEN')).toBe(true);
  });
  it('[FAIL-CLOSED] bill cũ KHÔNG có appBank (metadata trước 16/9) → VẪN CHẶN', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id }), anh(uniq('e')), 'ck.png', new Date()); // không appBank
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, appBank: 'MB' }), anh(uniq('f')), 'ck.png', new Date());
    expect(r2.ok).toBe(false);
  });
});
