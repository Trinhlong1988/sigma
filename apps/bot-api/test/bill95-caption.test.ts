import { describe, it, expect } from 'vitest';
import { bill95CaptionPrefix } from '../src/ocr-send-service.js';

// [Admin Demo 4/9] "đóng lô 95 phải ghim lên tin nhắn gửi kèm ảnh bill" — caption bill có 95 = cảnh báo rủi ro hoàn/hủy.
describe('bill95CaptionPrefix — ghim cảnh báo đóng lô 95 lên tin nhắn', () => {
  it('settlementCode 95 → có tiền tố cảnh báo', () => {
    expect(bill95CaptionPrefix('95')).toContain('ĐÓNG LÔ 95');
    expect(bill95CaptionPrefix('95')).toContain('RỦI RO');
    expect(bill95CaptionPrefix('ĐÓNG(95)')).toContain('ĐÓNG LÔ 95'); // chuẩn hoá bỏ ký tự không-số
  });
  it('không phải 95 → rỗng (không ghim)', () => {
    expect(bill95CaptionPrefix(null)).toBe('');
    expect(bill95CaptionPrefix('')).toBe('');
    expect(bill95CaptionPrefix('00')).toBe('');
    expect(bill95CaptionPrefix('9')).toBe('');
    expect(bill95CaptionPrefix('950')).toBe(''); // 950 ≠ 95
  });
});
