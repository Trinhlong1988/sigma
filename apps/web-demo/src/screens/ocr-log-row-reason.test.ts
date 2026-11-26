import { describe, it, expect } from 'vitest';
import { parseLogRow } from './OcrSendScreen';

// [Admin Demo 3/9] "rất nhiều lần lỗi mà không trả lỗi rõ ràng" — GỐC: bảng vứt phần lý do, chỉ dò vài từ khoá cứng.
// Test này CHỐT: dòng log lỗi PHẢI hiện NGUYÊN VĂN lý do, không được về "Lỗi OCR" trơ khi log đã có lý do.
describe('parseLogRow — lý do lỗi OCR phải hiện rõ (không trơ)', () => {
  const mk = (reason: string) => `⚠️ Bill 4/54 (bill4.jpg): LỖI OCR — ${reason} — bấm "Quét lại ảnh này" hoặc kiểm tay.`;

  it('hiện nguyên văn lý do "quá hạn/không phản hồi"', () => {
    const r = parseLogRow(mk('OCR quá hạn / không phản hồi (máy chủ nghẽn — quét lại)'));
    expect(r.num).toBe('4/54');
    expect(r.status).toContain('Lỗi OCR:');
    expect(r.status).toMatch(/quá hạn|không phản hồi/);
    expect(r.status).not.toBe('Lỗi OCR');
  });

  it('hiện nguyên văn lý do "bị giới hạn/nghẽn"', () => {
    const r = parseLogRow(mk('OCR bị giới hạn/nghẽn (quét lại)'));
    expect(r.status).toContain('Lỗi OCR:');
    expect(r.status).not.toBe('Lỗi OCR');
  });

  it('lý do MẠNG/HTTP lạ (không khớp từ khoá cũ) vẫn phải hiện, KHÔNG về trơ', () => {
    const r = parseLogRow(mk('Lỗi mạng — kiểm tra kết nối'));
    expect(r.status).toContain('Lỗi OCR:');
    expect(r.status).not.toBe('Lỗi OCR');
  });

  it('lý do HTTP 502 lạ vẫn hiện verbatim', () => {
    const r = parseLogRow(mk('OCR_FAILED (HTTP 502)'));
    expect(r.status).toContain('Lỗi OCR:');
    expect(r.status).not.toBe('Lỗi OCR');
  });

  it('lý do dài bị cắt gọn nhưng vẫn có nội dung', () => {
    const long = 'X'.repeat(200);
    const r = parseLogRow(mk(long));
    expect(r.status.length).toBeLessThan(80);
    expect(r.status).toContain('Lỗi OCR:');
  });

  it('KHÔNG có lý do (CHƯA quét được) → về "Lỗi OCR" trơ là chấp nhận', () => {
    const r = parseLogRow(mk('CHƯA quét được'));
    expect(r.status).toBe('Lỗi OCR');
  });

  // [GỐC "loạn Lỗi OCR" 3/9] dòng "không đọc được" có ⚠️ KHÔNG được dán nhầm "Lỗi OCR" (là UNREAD, không phải lỗi OCR).
  it('⚠️ "KHÔNG đọc được POS/CK" → "Không đọc được", KHÔNG phải Lỗi OCR', () => {
    const r = parseLogRow('⚠️ Bill 20/54 (b20.jpg): KHÔNG đọc được POS/chuyển khoản — CHƯA ra bill, cần kiểm tay để clear nốt.');
    expect(r.status).toContain('Không đọc được');
    expect(r.status).not.toMatch(/Lỗi OCR/);
  });

  it('⚠️ cảnh báo khác (lệch TID-HKD) → "Cảnh báo", KHÔNG phải Lỗi OCR', () => {
    const r = parseLogRow('⚠️ Bill 8/54 (b8.jpg): LỆCH TID↔HKD — TID 53550078 nhưng tên khác.');
    expect(r.status).not.toMatch(/Lỗi OCR/);
  });

  // [Admin Demo 3/9 auto-retry] dòng "tự đọc lại" = đang thử lại, KHÔNG kết luận không-đọc-được/lỗi.
  it('dòng auto-retry "tự đọc lại" → "Đang đọc lại…", không đỏ, không kết luận', () => {
    const r = parseLogRow('Bill 20/54 (b20.jpg): OCR chưa ra bill (lần 2/3) — tự đọc lại…');
    expect(r.status).toContain('Đang đọc lại');
    expect(r.warn).toBe(false);
    expect(r.status).not.toMatch(/Lỗi OCR|Không đọc được/);
  });

  // Hết retry → 🔴 = ĐỎ (warn) + status MỞ kiểm tay (không nhảy cóc).
  it('🔴 hết 3 lần → warn=true (đỏ) + "MỞ kiểm tay"', () => {
    const r = parseLogRow('🔴 Bill 20/54 (b20.jpg): KHÔNG đọc được POS/CK sau 3 lần — MỞ ảnh để kiểm tay + OCR lại (không bỏ qua).');
    expect(r.warn).toBe(true);
    expect(r.status).toMatch(/MỞ kiểm tay/);
    expect(r.num).toBe('20/54');
  });
});
