// Test cho replyPreviewText() (reply-preview.ts) — tính năng "Trả lời" kiểu Zalo (1/8).
import { describe, expect, it } from 'vitest';
import { replyPreviewText } from './reply-preview';

describe('replyPreviewText', () => {
  it('tin TEXT ngắn → nguyên văn', () => {
    expect(replyPreviewText({ type: 'text', text: 'Hello Admin Demo' })).toBe('Hello Admin Demo');
  });

  it('tin TEXT dài vượt 80 ký tự → cắt bớt kèm "…"', () => {
    const longText = 'a'.repeat(120);
    const result = replyPreviewText({ type: 'text', text: longText });
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBe(81); // 80 ký tự + dấu "…"
  });

  it('đúng 80 ký tự (biên) → KHÔNG cắt, không thêm "…"', () => {
    const exact = 'b'.repeat(80);
    expect(replyPreviewText({ type: 'text', text: exact })).toBe(exact);
  });

  it('ảnh CÓ caption (text kèm ảnh) → dùng caption thay vì nhãn "[Hình ảnh]"', () => {
    expect(replyPreviewText({ type: 'image', text: 'Ảnh hóa đơn' })).toBe('Ảnh hóa đơn');
  });

  it('ảnh KHÔNG caption → nhãn "[Hình ảnh]"', () => {
    expect(replyPreviewText({ type: 'image', text: undefined })).toBe('[Hình ảnh]');
  });

  it('file/voice/location/qr KHÔNG text → nhãn ngắn gọn tương ứng', () => {
    expect(replyPreviewText({ type: 'file', text: undefined })).toBe('[Tệp đính kèm]');
    expect(replyPreviewText({ type: 'voice', text: undefined })).toBe('[Tin nhắn thoại]');
    expect(replyPreviewText({ type: 'location', text: undefined })).toBe('[Vị trí]');
    expect(replyPreviewText({ type: 'qr', text: undefined })).toBe('[Mã QR]');
  });

  it('tin đã xóa (type system, KHÔNG có text riêng) → rơi về nhãn "Tin nhắn đã bị xóa"', () => {
    expect(replyPreviewText({ type: 'system', text: undefined })).toBe('Tin nhắn đã bị xóa');
  });

  it('text chỉ toàn khoảng trắng → coi như rỗng, rơi về nhãn theo type', () => {
    expect(replyPreviewText({ type: 'file', text: '   ' })).toBe('[Tệp đính kèm]');
  });
});
