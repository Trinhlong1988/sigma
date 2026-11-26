// [Phản biện 11/9 — vá chính sách miễn-chặn CK_TRUNG_GIO_TIEN] Chính sách Admin Demo 11/9: cả 2 bill CÓ MÃ GD khác
// nhau → 2 GD KHÁC THẬT → không chặn. LỖ HỔNG bị phản biện bắt: (a) ref RÁC 1-3 ký tự ("1"/"OK") cũng được tính
// "có mã" → 2 bill rác lách chặn cứng; (b) normUpperNoSpace chỉ bỏ space, KHÔNG bỏ "-" → OCR đọc "FT-2609" vs
// "FT2609" (CÙNG mã) thành 2 key khác → được miễn oan → hoàn x2. Vá: ckRefForPolicy (≥4 ký tự chữ-số, bỏ ký tự
// rác) CHỈ áp cho nhánh MIỄN — buildCkTxnKey/khoá lịch sử GIỮ NGUYÊN (không đụng dedup metadata đã ghi).
// Test đường THẬT sendTransferByDirection → postDealerRefundCk (throwaway rows tên uniq, không sửa data có sẵn).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { sendTransferByDirection, ckRefForPolicy, ckBothRefDistinct, type TransferReview } from '../src/ocr-send-service.js';
import { makeChatRoom, makeChatRoomDaGanKhach } from './fixtures.js';
// [14/10] Nhóm phải ĐÃ GÁN KHÁCH: service nay chặn gửi CK vào nhóm trống (ROOM_NO_CUSTOMER — nhóm không
// gắn khách thì tiền hoàn không vào đối soát). Chốt đó thêm sau loạt test này nên chúng đỏ hàng loạt.

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const anh = (tag: string): Buffer => Buffer.concat([PNG, Buffer.from(tag)]);
const tr = (over: Partial<TransferReview>): TransferReview => ({
  senderName: 'NGUYEN VAN A', senderIsAlpha: false, senderAccount: null,
  receiverName: 'KHACH HANG 01', receiverAccount: null, content: null,
  amount: 8_000_000, bank: 'MB', senderBank: null, date: '11/09/2026', time: '11:22:00',
  ref: uniq('FTPOL').slice(0, 16),
  matchedRoomId: null, matchedRoomName: null,
  direction: 'DEALER_TO_ALPHA', entityType: 'DEALER', entityId: null, needsManualPick: false, warnings: [], ...over
});
const soTinCk = async (roomId: string): Promise<number> =>
  getBotDb().chatMessage.count({ where: { roomId, deletedAt: null, metadataJson: { contains: '"isTransferRefund"' } } });

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('ckRefForPolicy / ckBothRefDistinct — đơn vị', () => {
  it('tier ref ≥4 ký tự → rút mã chuẩn hoá (bỏ "-"/space, UPPER)', () => {
    expect(ckRefForPolicy('ck|ref|FT2609X')).toBe('FT2609X');
    expect(ckRefForPolicy('ck|ref|ft-26 09x')).toBe('FT2609X'); // normUpperNoSpace lúc build giữ "-" — policy bỏ nốt
  });
  it('ref rác <4 ký tự chữ-số → null (không đủ tư cách mã)', () => {
    expect(ckRefForPolicy('ck|ref|1')).toBeNull();
    expect(ckRefForPolicy('ck|ref|OK')).toBeNull();
    expect(ckRefForPolicy('ck|ref|A-1')).toBeNull(); // sau bỏ rác còn "A1" = 2 ký tự
  });
  it('tier nat/hash hoặc null → null (không phải mã GD)', () => {
    expect(ckRefForPolicy('ck|nat|111|222|5000000|20260911')).toBeNull();
    expect(ckRefForPolicy('ck|hash|' + 'a'.repeat(64))).toBeNull();
    expect(ckRefForPolicy(null)).toBeNull();
  });
  it('ckBothRefDistinct: chỉ true khi CẢ 2 có mã thật và mã KHÁC NHAU THẬT sau chuẩn hoá', () => {
    expect(ckBothRefDistinct('ck|ref|FT2609X', 'ck|ref|FT9999Z')).toBe(true); // 2 mã thật khác nhau → miễn
    expect(ckBothRefDistinct('ck|ref|FT-2609', 'ck|ref|FT2609')).toBe(false); // CÙNG mã chỉ khác "-" → KHÔNG miễn
    expect(ckBothRefDistinct('ck|ref|1', 'ck|ref|2')).toBe(false); // 2 ref rác → KHÔNG miễn
    expect(ckBothRefDistinct('ck|ref|FT2609X', 'ck|nat|1|2|3|4')).toBe(false); // thiếu mã 1 bên → KHÔNG miễn
  });
});

describe('CK_TRUNG_GIO_TIEN — vá miễn-chặn (đường thật, DB)', () => {
  it('[LỖ HỔNG a] 2 bill cùng giờ:phút+tiền, ref RÁC khác nhau ("1" vs "2") → PHẢI CHẶN (trước vá: lách qua)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    // ref "1"/"2" quá ngắn → buildCkTxnKey vẫn tạo ck|ref|1 (khoá lịch sử giữ nguyên) NHƯNG policy không cho miễn.
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref: '1' }), anh(uniq('ra')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref: '2', time: '11:22:59' }), anh(uniq('rb')), 'ck.png', new Date());
    expect(r2.ok).toBe(false);
    expect(String(r2.error)).toMatch(/^CK_TRUNG_GIO_TIEN:/);
    expect(await soTinCk(room.id)).toBe(1); // fail-closed: không ghi tin thứ 2
  });
  it('[LỖ HỔNG b] 2 bill cùng giờ:phút+tiền, ref CHỈ KHÁC dấu "-"/space (CÙNG mã) → PHẢI CHẶN (trước vá: lách qua)', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const goc = uniq('FT').slice(0, 12);
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref: goc }), anh(uniq('rc')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const refLech = `${goc.slice(0, 4)}-${goc.slice(4)}`; // cùng mã, OCR chêm "-" → key khác
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref: refLech, time: '11:22:30' }), anh(uniq('rd')), 'ck.png', new Date());
    expect(r2.ok).toBe(false);
    expect(String(r2.error)).toMatch(/^CK_TRUNG_GIO_TIEN:/);
    expect(await soTinCk(room.id)).toBe(1);
  });
  it('[CHÍNH SÁCH GIỮ NGUYÊN] 2 bill cùng giờ:phút+tiền, 2 MÃ THẬT khác nhau (≥4 ký tự) → vẫn CHO GỬI cả 2', async () => {
    const db = getBotDb();
    const room = await makeChatRoomDaGanKhach({ name: uniq('ĐL ') });
    const r1 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref: uniq('FTAAA').slice(0, 16) }), anh(uniq('re')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    const r2 = await sendTransferByDirection(db, tr({ matchedRoomId: room.id, ref: uniq('FTBBB').slice(0, 16), time: '11:22:45' }), anh(uniq('rf')), 'ck.png', new Date());
    expect(r2.ok).toBe(true); // Admin Demo 11/9: mã GD khác thật = 2 GD khác — không chặn
    expect(await soTinCk(room.id)).toBe(2);
  });
});
