// 20/8 — regression cho BUG TIỀN NGHIÊM TRỌNG: dòng "Hoàn tiền" LỖI THỜI (preview tính cho số tiền CŨ) bị
// nướng vĩnh viễn vào ẢNH GHÉP gửi đi vì nút Gửi/Lưu KHÔNG gate theo độ tươi của preview. `isRefundTextStale()`
// là chốt chặn: caller (OcrBillPreview.tsx + EditBillMessageModal.tsx) disable Gửi/Lưu khi hàm trả `true`.
//
// GHI CHÚ: hook `useFeePreview` (React + timers + fetch) KHÔNG test trực tiếp được vì repo CHƯA có jsdom/
// @testing-library (vitest env='node' — xem vitest.config.ts). Nên phần freshness được TÁCH thành hàm THUẦN
// `isRefundTextStale()` để test trọn vẹn; phần debounce/fetch của hook verify bằng Playwright ở gate ship.
import { describe, expect, it } from 'vitest';
import { isRefundTextStale } from './use-fee-preview';

describe('isRefundTextStale — chốt chặn nướng dòng Hoàn tiền lỗi thời vào ảnh', () => {
  it('số tiền chưa hợp lệ (null/0/âm) → KHÔNG lỗi thời (không có gì để gửi; canSend tự chặn riêng)', () => {
    expect(isRefundTextStale({ hasTid: true, parsedAmount: null, pending: true, previewAmount: null })).toBe(false);
    expect(isRefundTextStale({ hasTid: true, parsedAmount: 0, pending: true, previewAmount: null })).toBe(false);
    expect(isRefundTextStale({ hasTid: true, parsedAmount: -5, pending: true, previewAmount: null })).toBe(false);
  });

  it('KHÔNG có TID → KHÔNG lỗi thời (không TID = không phí, dòng hoàn = nguyên số tiền, tươi ngay)', () => {
    // Kể cả khi pending=true / previewAmount lệch — không TID nghĩa là không bao giờ gọi API (hook trả IDLE),
    // dòng "phí 0%" đúng và không cần đợi.
    expect(isRefundTextStale({ hasTid: false, parsedAmount: 4_000_000, pending: false, previewAmount: null })).toBe(false);
  });

  it('CASE (a) OCR autofill rồi bấm Gửi ngay: có TID, đang chờ preview (pending) → LỖI THỜI → chặn Gửi', () => {
    // feePreview còn null (chưa fetch xong) → nếu không chặn, ảnh sẽ hiện "phí 0%" dù TID có phí.
    expect(isRefundTextStale({ hasTid: true, parsedAmount: 52_700_000, pending: true, previewAmount: null })).toBe(true);
  });

  it('CASE (b) sửa số tiền trong cửa sổ debounce/mạng: previewAmount ≠ số tiền hiện tại → LỖI THỜI → chặn', () => {
    // Preview cũ tính cho 100tr, người dùng đổi sang 200tr — "Số tiền" mới nhưng "Hoàn tiền" còn của 100tr.
    expect(isRefundTextStale({ hasTid: true, parsedAmount: 200_000_000, pending: false, previewAmount: 100_000_000 })).toBe(true);
    // Đang chờ fetch cho số tiền mới cũng lỗi thời (dù previewAmount tình cờ trùng do state cũ).
    expect(isRefundTextStale({ hasTid: true, parsedAmount: 200_000_000, pending: true, previewAmount: 100_000_000 })).toBe(true);
  });

  it('preview đã TƯƠI cho ĐÚNG số tiền hiện tại (không pending, previewAmount khớp) → KHÔNG lỗi thời → cho Gửi', () => {
    // Gồm cả trường hợp lỗi mạng resolved (feePreview=null nhưng pending=false, previewAmount khớp): coi là tươi
    // (phí 0%), KHÔNG kẹt gate. `isRefundTextStale` không nhận feePreview nên chỉ 1 assertion là đủ ở đây;
    // nhánh "phí 0%" của lỗi mạng được khẳng định giá trị THẬT ở bill-refund-text.test.ts.
    expect(isRefundTextStale({ hasTid: true, parsedAmount: 52_700_000, pending: false, previewAmount: 52_700_000 })).toBe(false);
  });
});
