import { describe, it, expect } from 'vitest';
import { categorizeReloadFiles } from './OcrSendScreen';

// [Admin Demo 4/9] "reload phải kiểm THẬT KỸ bill đã OCR vs chưa OCR" — khoá chặt: chỉ THÊM bill chưa-OCR + chưa-trong-danh-sách.
type F = { path: string; alreadyOcr: boolean };
describe('categorizeReloadFiles — reload folder không quét lại/đếm đôi', () => {
  it('chỉ thêm bill MỚI (chưa OCR + chưa trong danh sách)', () => {
    const files: F[] = [
      { path: '/f/a.jpg', alreadyOcr: true },   // đã OCR → bỏ qua
      { path: '/f/b.jpg', alreadyOcr: false },  // chưa OCR nhưng đã trong queue → đang chờ
      { path: '/f/c.jpg', alreadyOcr: false },  // chưa OCR + MỚI tải về → thêm
      { path: '/f/d.jpg', alreadyOcr: false },  // chưa OCR + MỚI → thêm
    ];
    const existing = new Set(['/f/b.jpg']); // b đã trong danh sách
    const r = categorizeReloadFiles(files, existing);
    expect(r.daOcr).toBe(1);                      // a
    expect(r.dangCho).toBe(1);                    // b
    expect(r.added.map((f) => f.path)).toEqual(['/f/c.jpg', '/f/d.jpg']); // c, d
  });

  it('đã OCR thì KHÔNG thêm dù chưa trong danh sách (chống quét lại/đếm đôi)', () => {
    const files: F[] = [{ path: '/f/x.jpg', alreadyOcr: true }];
    const r = categorizeReloadFiles(files, new Set());
    expect(r.added.length).toBe(0);
    expect(r.daOcr).toBe(1);
  });

  it('không có bill mới → added rỗng', () => {
    const files: F[] = [{ path: '/f/a.jpg', alreadyOcr: false }];
    const r = categorizeReloadFiles(files, new Set(['/f/a.jpg']));
    expect(r.added.length).toBe(0);
    expect(r.dangCho).toBe(1);
  });
});
