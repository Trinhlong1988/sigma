// [Phản biện 11/9 — LỖ HỔNG CK x2 HOÀN QUA 2 ẢNH] Cùng 1 giao dịch CK có thể có 2 ẢNH khác nhau (bên gửi/bên nhận
// chụp riêng) + OCR đọc LỆCH ref 1 ký tự → ckTxnKey KHÁC + image-hash KHÁC → mọi tầng dedup hiện có (marker,
// reserveSend, findDealerCkGlobal, augment-hash) đều trượt → hoàn ghi 2 LẦN. POS có tier-2 lô+tiền+ngày
// (findSentByLoAmount) — CK trước giờ KHÔNG có gì. Fix: reviewTransfers cắm CỜ ĐỎ "NGHI TRÙNG" khi phòng đích đã có
// CK cùng |tiền| cùng NGÀY nhưng khoá khác (KHÔNG chặn — 2 CK thật cùng tiền/ngày vẫn hợp lệ, người duyệt quyết).
import { describe, it, expect } from 'vitest';
import { reviewTransfers } from '../src/ocr-send-service.js';

// Phòng đại lý giả + 1 bill CK ĐÃ GỬI trong phòng (metadata như postDealerRefundCk ghi).
const ROOM = 'roomKiemThuX1';
const sentCkMeta = JSON.stringify({
  isTransferRefund: true, isDealerRefundCk: true, refundAmount: 5_000_000,
  ckTxnKey: 'ck|ref|OLDREFABC', ocrImageHash: 'a'.repeat(64), billDate: '2026-09-10', billDateTimeRaw: '10/09/2026 09:00'
});

function fakeDb(opts: { firstMatchesKey?: string | null } = {}): never {
  return {
    customerChatGroup: { findMany: async () => [{ roomId: ROOM }] },
    chatRoom: { findMany: async () => [{ id: ROOM, name: 'DLY KIEM THU X1' }] },
    investor: { findMany: async () => [] },
    investorBankAccount: { findMany: async () => [] },
    chatMessage: {
      // ckAlreadySentInRoom: chỉ khớp khi marker chứa key chỉ định (giả lập bill đã gửi cùng ref).
      findFirst: async ({ where }: { where: { metadataJson: { contains: string } } }) =>
        opts.firstMatchesKey && where.metadataJson.contains.includes(opts.firstMatchesKey) ? { id: 'msgSent' } : null,
      // listDealerRefundCks: tin CK đã gửi trong phòng.
      findMany: async ({ where }: { where: { roomId: string } }) =>
        where.roomId === ROOM ? [{ id: 'msgSent', metadataJson: sentCkMeta, createdAt: new Date('2026-09-10T03:00:00Z') }] : []
    }
  } as never;
}

const trBase = {
  senderName: 'KHACH HANG 01', senderAccount: '0123456789',
  receiverName: 'DLY KIEM THU X1', receiverAccount: '9876543210',
  content: 'KHACH HANG 01 chuyen tien', date: '10/09/2026', time: '09:05'
};

describe('reviewTransfers — cờ NGHI TRÙNG CK cùng tiền cùng ngày khác khoá (chống hoàn x2 qua 2 ảnh)', () => {
  // [Admin Demo 11/9 chính sách] CẢ 2 có MÃ GD thật khác nhau → hệ tính 2 GD KHÁC THẬT: KHÔNG cờ đỏ/chặn, nhưng
  // [vá phản biện 11/9] KHÔNG được im lặng tuyệt đối → ℹ nhẹ cho người duyệt thấy (OCR lệch mã vẫn có thể xảy ra).
  it('chiều ĐÚNG (chính sách 11/9): cùng |tiền| + cùng ngày + CẢ 2 CÓ MÃ khác nhau → ℹ nhẹ "2 GD KHÁC THẬT" (không ⚠/⛔)', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 5_000_000, ref: 'NEWREF999' }]);
    expect(r.matchedRoomId).toBe(ROOM); // fixture khớp phòng (tiền đề của lưới)
    expect(r.alreadySent).toBe(false); // key khác → dedup key trượt (đúng kịch bản lỗ hổng)
    expect(r.warnings.some((w) => w.includes('NGHI TRÙNG'))).toBe(false); // chính sách: không cờ đỏ
    expect(r.warnings.some((w) => w.includes('2 GD KHÁC THẬT'))).toBe(true); // nhưng phải THẤY, không im lặng
    expect(r.warnings.find((w) => w.includes('2 GD KHÁC THẬT'))).toContain('5.000.000');
  });
  it('chiều ĐÚNG (lưới cũ còn sống): bill MỚI KHÔNG đọc được mã (nat) + cùng tiền cùng ngày → vẫn ⚠ NGHI TRÙNG', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 5_000_000, ref: null }]);
    expect(r.warnings.some((w) => w.includes('NGHI TRÙNG'))).toBe(true); // thiếu mã 1 bên → không được miễn
  });
  it('chiều ĐÚNG (vá min-length): ref RÁC <4 ký tự ("1") không đủ tư cách mã → vẫn ⚠ NGHI TRÙNG, không lách được', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 5_000_000, ref: '1' }]);
    expect(r.warnings.some((w) => w.includes('NGHI TRÙNG'))).toBe(true);
  });
  it('chiều ĐÚNG (vá chuẩn hoá): ref chỉ khác dấu "-"/space với mã đã gửi ("OLD-REF ABC" ≡ OLDREFABC) → CÙNG mã → ⚠/⛔, không miễn', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 5_000_000, ref: 'OLD-REF ABC' }]);
    expect(r.warnings.some((w) => w.includes('NGHI TRÙNG') || w.includes('TRÙNG GIỜ:PHÚT'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('2 GD KHÁC THẬT'))).toBe(false);
  });
  it('chiều SAI (a): tiền KHÁC → KHÔNG cờ (không dương tính giả)', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 5_100_000, ref: 'NEWREF999' }]);
    expect(r.warnings.some((w) => w.includes('NGHI TRÙNG'))).toBe(false);
  });
  it('chiều SAI (b): ngày KHÁC → KHÔNG cờ', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 5_000_000, ref: 'NEWREF999', date: '11/09/2026' }]);
    expect(r.warnings.some((w) => w.includes('NGHI TRÙNG'))).toBe(false);
  });
  it('chiều SAI (c): CÙNG ref (đã gửi thật) → alreadySent=true qua đường key cũ, KHÔNG cần cờ nghi trùng', async () => {
    const [r] = await reviewTransfers(fakeDb({ firstMatchesKey: 'ck|ref|OLDREFABC' }), [{ ...trBase, amount: 5_000_000, ref: 'OLDREFABC' }]);
    expect(r.alreadySent).toBe(true);
    expect(r.warnings.some((w) => w.includes('NGHI TRÙNG'))).toBe(false);
  });
});

// [KIỂM CHỨNG ĐỘC LẬP 11/9 — đối kháng chéo NGHI-TRÙNG × hash-match] Cùng 1 ẢNH re-scan, OCR đọc lệch ref → key
// trượt → reviewTransfers cắm cờ "NGHI TRÙNG … (tin X) … mã GD/ảnh KHÁC"; NHƯNG augmentTransferReviewWithSentKind
// sau đó khớp HASH ẢNH đúng CHÍNH tin X (ảnh KHÔNG hề khác) → cờ sai sự thật + thừa (card đã alreadySent). Fix:
// augment gỡ cờ NGHI TRÙNG trỏ vào chính tin vừa khớp; cờ trỏ tin KHÁC (2 CK thật cùng tiền/ngày) GIỮ NGUYÊN.
import { augmentTransferReviewWithSentKind, ocrImageHashOf } from '../src/ocr-send-service.js';

const BUF_CUNG_ANH = Buffer.from('anh-ck-cung-mot-tam-11-9');
const sentCkMeta2 = JSON.stringify({
  isTransferRefund: true, isDealerRefundCk: true, refundAmount: 5_000_000,
  ckTxnKey: 'ck|ref|OLDREF2XYZ', ocrImageHash: ocrImageHashOf(BUF_CUNG_ANH),
  billDate: '2026-09-10', billDateTimeRaw: '10/09/2026 09:05'
});
function fakeDb2(): never {
  return {
    customerChatGroup: { findMany: async () => [{ roomId: ROOM }] },
    chatRoom: { findMany: async () => [{ id: ROOM, name: 'DLY KIEM THU X1' }] },
    investor: { findMany: async () => [] },
    investorBankAccount: { findMany: async () => [] },
    chatMessage: {
      findFirst: async () => null, // ref mới chưa từng gửi theo key
      findMany: async ({ where }: { where: { roomId: string } }) =>
        where.roomId === ROOM ? [{ id: 'msgSent2', metadataJson: sentCkMeta2, createdAt: new Date('2026-09-10T03:00:00Z') }] : []
    }
  } as never;
}

describe('augmentTransferReviewWithSentKind — gỡ cờ NGHI TRÙNG khi hash ảnh khớp CHÍNH tin đó', () => {
  // [Admin Demo 11/9 chính sách + vá phản biện] Fixture: ref MỚI ≠ ref tin cũ, CẢ 2 CÓ MÃ thật → được miễn ⚠/⛔,
  // review cắm ℹ "2 GD KHÁC THẬT" (cùng giờ:phút 09:05). augment phải gỡ được CẢ ℹ khi hash khớp chính tin đó
  // (cùng ảnh = re-scan, không phải GD thứ 2 → ℹ cũng sai sự thật).
  const coTrung = (w: string): boolean => w.includes('NGHI TRÙNG') || w.includes('TRÙNG GIỜ:PHÚT') || w.includes('2 GD KHÁC THẬT');
  it('CHIỀU ĐÚNG: cùng ẢNH + ref OCR lệch (cả 2 có mã → ℹ cùng GIỜ:PHÚT) → augment khớp hash → alreadySent + cờ ĐƯỢC GỠ', async () => {
    const [r] = await reviewTransfers(fakeDb2(), [{ ...trBase, amount: 5_000_000, ref: 'NEWREF777' }]);
    expect(r.warnings.some((w) => coTrung(w) && w.includes('(tin msgSent2'))).toBe(true); // tiền đề: cờ đã cắm
    expect(r.warnings.some((w) => w.includes('2 GD KHÁC THẬT') && w.includes('cùng GIỜ:PHÚT'))).toBe(true); // chính sách: ℹ (không ⛔) + nêu rõ trùng giờ:phút
    await augmentTransferReviewWithSentKind(fakeDb2(), [r], BUF_CUNG_ANH);
    expect(r.alreadySent).toBe(true);
    expect(r.sentMessageId).toBe('msgSent2');
    expect(r.warnings.some(coTrung)).toBe(false); // cờ sai sự thật đã gỡ (⚠/⛔/ℹ)
  });
  it('CHIỀU SAI (không gỡ bừa): ẢNH KHÁC THẬT (hash không khớp) → cờ ℹ GIỮ NGUYÊN + không alreadySent', async () => {
    const [r] = await reviewTransfers(fakeDb2(), [{ ...trBase, amount: 5_000_000, ref: 'NEWREF888' }]);
    expect(r.warnings.some(coTrung)).toBe(true);
    await augmentTransferReviewWithSentKind(fakeDb2(), [r], Buffer.from('anh-hoan-toan-khac-11-9'));
    expect(r.alreadySent).toBe(false);
    expect(r.warnings.some((w) => coTrung(w) && w.includes('(tin msgSent2'))).toBe(true); // đúng kịch bản 2 ảnh — ℹ phải sống cho người duyệt thấy (chính sách 11/9: server KHÔNG chặn nữa)
  });
});

// [Admin Demo 11/9 + phản biện] GATE statusText: bill CK phải có xác nhận "THÀNH CÔNG" (OCR đọc nguyên văn #p5).
// Thiếu field (bill cũ/cache cũ) hay trạng thái khác ("Đang xử lý"/"thất bại") → ⚠ bắt kiểm; có → KHÔNG cờ oan.
describe('reviewTransfers — cờ ⚠ statusText (chỉ bill THÀNH CÔNG mới được tính)', () => {
  const coStatus = (w: string): boolean => w.includes('THÀNH CÔNG') && w.includes('KIỂM ảnh gốc');
  it('có "Chuyển tiền thành công" → KHÔNG cờ', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 1_234_000, ref: 'REFOKAY1', statusText: 'Chuyển tiền thành công' }]);
    expect(r.warnings.some(coStatus)).toBe(false);
  });
  it('viết thường không dấu "giao dich thanh cong" → vẫn nhận (normVi) → KHÔNG cờ', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 1_234_000, ref: 'REFOKAY2', statusText: 'giao dich thanh cong' }]);
    expect(r.warnings.some(coStatus)).toBe(false);
  });
  it('tiếng Anh "Transaction Successful" → KHÔNG cờ', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 1_234_000, ref: 'REFOKAY3', statusText: 'Transaction Successful' }]);
    expect(r.warnings.some(coStatus)).toBe(false);
  });
  it('"Giao dịch thất bại" → cờ ⚠ (kèm nguyên văn OCR đọc được)', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 1_234_000, ref: 'REFOKAY4', statusText: 'Giao dịch thất bại' }]);
    expect(r.warnings.some(coStatus)).toBe(true);
    expect(r.warnings.find(coStatus)).toContain('Giao dịch thất bại');
  });
  it('THIẾU field (bill OCR cũ, cache #p4 nhiễm) → cờ ⚠ "không thấy" (fail-visible, không nuốt câm)', async () => {
    const [r] = await reviewTransfers(fakeDb(), [{ ...trBase, amount: 1_234_000, ref: 'REFOKAY5' }]);
    expect(r.warnings.some(coStatus)).toBe(true);
    expect(r.warnings.find(coStatus)).toContain('không thấy');
  });
});
