// Test đọc LỐI TẮT từ dòng log (Admin Demo 8/9) — dùng chính các câu log THẬT hệ thống đang in ra.
import { describe, expect, it } from 'vitest';
import { docSoBill, docTidLo, laCanhBao } from './log-shortcut';

describe('lối tắt từ log', () => {
  it('đọc số bill từ câu log thật → idx 0-based', () => {
    expect(docSoBill('🔴 Bill 7/32 (bill_7.jpg): KHÔNG đọc được POS/CK sau 3 lần')).toBe(6);
    expect(docSoBill('Bill 1/3 (bill_1.jpg): OCR MỚI (Sonnet@2400 — tốn quota)')).toBe(0);
    expect(docSoBill('không có số bill')).toBeNull();
  });

  it('đọc TID + lô từ dòng sót lô thật', () => {
    const r = docTidLo('    · HKD DEMO 43 (TID 53550071): THIẾU lô 66, 67  (đã thấy 63…65)');
    expect(r).toEqual({ tid: '53550071', lo: '66' });
    expect(docTidLo('không có tid')).toBeNull();
  });

  it('chỉ có TID (không có lô) vẫn mở được báo cáo', () => {
    expect(docTidLo('Bill 5/9 — TID 59930002 nghi gán nhầm máy')?.tid).toBe('59930002');
  });

  it('nhận đúng dòng CẢNH BÁO (bật lối tắt) và bỏ qua dòng thường', () => {
    expect(laCanhBao('🔴 NGÀY BILL 08/05/2026 cách hôm nay 123 ngày')).toBe(true);
    expect(laCanhBao('SỐ LÔ 500 NHẢY VỌT so với lô gần nhất')).toBe(true);
    expect(laCanhBao('NGHI GÁN NHẦM MÁY: lô 101 nối tiếp dãy lô của HKD DEMO 50')).toBe(true);
    expect(laCanhBao('📁 Bill 2/3: ĐỌC CACHE (đã quét trước — 0 quota)')).toBe(false);
  });
});
