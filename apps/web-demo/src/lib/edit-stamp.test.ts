// [Admin Demo 2/9 "log nhỏ trạng thái đã sửa ngay dưới thông số sửa"] TEST HÀNH VI lõi theo-dõi-giờ-sửa (stampEdits):
// field đổi khác OCR-gốc → dấu mốc giờ; quay về gốc → xoá dấu. Đây là logic sinh log "✓ đã sửa lúc HH:mm" mỗi trường.
// stampEdits được export TỪ OcrSendScreen? Không — nó là hàm module. Ta tái hiện y hệt để khoá hành vi (đồng bộ chữ ký).
import { describe, it, expect } from 'vitest';
import { stampEdits, nowHHMM } from './edit-stamp.js';

const orig = { tid: 'DEMO-TID-07', date: '30/08/2026', amt: '33002000' };

describe('stampEdits — dấu mốc giờ sửa từng trường', () => {
  it('sửa 1 trường khác gốc → stamp giờ đúng trường đó', () => {
    const r = stampEdits({ tid: '53550071', date: '30/08/2026', amt: '33002000' }, orig, orig, {}, '15:47');
    expect(r.changed).toBe(true);
    expect(r.next).toEqual({ tid: '15:47' });
  });

  it('trường KHÔNG đổi (cur==prev) → không stamp (chỉ khi có thay đổi thật)', () => {
    const r = stampEdits(orig, orig, orig, {}, '15:47');
    expect(r.changed).toBe(false);
    expect(r.next).toEqual({});
  });

  it('SỬA rồi QUAY VỀ giá trị gốc → XOÁ dấu (không còn "đã sửa")', () => {
    // đã có dấu tid; giờ tid quay về gốc, prev là giá trị đã sửa.
    const r = stampEdits({ tid: 'DEMO-TID-07', date: '30/08/2026', amt: '33002000' }, { tid: '53550071', date: '30/08/2026', amt: '33002000' }, orig, { tid: '15:47' }, '15:50');
    expect(r.changed).toBe(true);
    expect(r.next).toEqual({});
  });

  it('sửa nhiều lần cùng trường → cập nhật giờ MỚI NHẤT', () => {
    const r = stampEdits({ tid: '53550072', date: '30/08/2026', amt: '33002000' }, { tid: '53550071', date: '30/08/2026', amt: '33002000' }, orig, { tid: '15:47' }, '16:10');
    expect(r.next.tid).toBe('16:10');
  });

  it('giữ dấu các trường khác khi sửa 1 trường mới', () => {
    const r = stampEdits({ tid: 'DEMO-TID-07', date: '31/08/2026', amt: '33002000' }, orig, orig, { tid: '15:47' }, '16:20');
    expect(r.next).toEqual({ tid: '15:47', date: '16:20' }); // tid giữ, date mới
  });

  it('gốc trống (OCR mù) + nhập giá trị → coi là SỬA (stamp)', () => {
    const r = stampEdits({ tid: 'DEMO-TID-07', date: '02/09/2026', amt: '33002000' }, { tid: 'DEMO-TID-07', date: '', amt: '33002000' }, { ...orig, date: '' }, {}, '09:00');
    expect(r.next).toEqual({ date: '09:00' });
  });

  it('now mặc định = nowHHMM() dạng HH:mm', () => {
    expect(nowHHMM()).toMatch(/^\d{2}:\d{2}$/);
  });
});
