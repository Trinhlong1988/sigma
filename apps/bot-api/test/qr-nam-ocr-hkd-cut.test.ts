// [Admin Demo 14/9 — CA THẬT prod ảnh 27.5] Bill QR quẹt 14/09/2026 15:04 nhưng OCR đọc "14/09/2025" + tên HKD bị
// app CẮT "HKD DEMO 62" → (a) tra báo-có theo NĂM SAI → "KHÔNG tìm thấy trong báo có", (b) không khớp mã QR nào.
// Fix 3 lớp: suaNamOcr (năm lệch nhưng ngày/tháng trong khung 10 ngày → năm nay + cờ ℹ) + gate kiemTraNgayBill
// cho luồng QR + fuzzy 2 CHIỀU (tên OCR là TIỀN TỐ của key mã).
import { describe, it, expect } from 'vitest';
import { suaNamOcr, normalizeHkdKey } from '../src/ocr-send-service.js';

describe('suaNamOcr — năm OCR sai (ca thật 14/09/2025 → 2026)', () => {
  const now = new Date('2026-09-14T08:30:00.000Z'); // 15:30 HCM 14/9/2026

  it('CA THẬT: "14/09/2025" hôm nay 14/09/2026 → sửa thành 2026 + cờ', () => {
    const r = suaNamOcr('14/09/2025', now);
    expect(r).toMatchObject({ date: '14/09/2026', daSua: true, namGoc: 2025 });
  });

  it('năm đúng → giữ nguyên, không cờ', () => {
    expect(suaNamOcr('14/09/2026', now)).toMatchObject({ date: '14/09/2026', daSua: false });
  });

  it('năm sai NHƯNG ngày/tháng ngoài khung 10 ngày (thay năm vẫn lệch xa) → KHÔNG sửa mù (để gate đỏ, người kiểm)', () => {
    expect(suaNamOcr('01/03/2025', now).daSua).toBe(false);
  });

  it('giao thừa: 31/12 năm trước khi now là 02/01 → vẫn sửa (lệch 2 ngày)', () => {
    const now2 = new Date('2027-01-02T05:00:00.000Z');
    expect(suaNamOcr('31/12/2026', now2).daSua).toBe(false); // 31/12/2027 là TƯƠNG LAI xa? lệch |now−31/12/2027| ~363d → không sửa. ĐÚNG: giữ nguyên vì 31/12/2026 chỉ cách 2 ngày — năm GỐC đã hợp lệ, không được đổi.
    expect(suaNamOcr('31/12/2026', now2).date).toBe('31/12/2026');
  });

  it('không phải ngày → giữ nguyên không ném', () => {
    expect(suaNamOcr(null, now)).toMatchObject({ date: null, daSua: false });
    expect(suaNamOcr('abc', now).daSua).toBe(false);
  });
});

describe('fuzzy 2 chiều tên HKD — tên OCR bị CẮT là tiền tố key mã', () => {
  it('CA THẬT: "HKD DEMO 62" là tiền tố của "HKD DEMO 38"', () => {
    const ocrKey = normalizeHkdKey('HKD DEMO 62');
    const maKey = normalizeHkdKey('HKD DEMO 38');
    expect(ocrKey.length).toBeGreaterThanOrEqual(6);
    expect(maKey.startsWith(ocrKey)).toBe(true); // điều kiện nhánh fuzzy chiều ngược trong reviewQr
  });
  it('tên khác họ KHÔNG dính ("HKD DEMO 46")', () => {
    expect(normalizeHkdKey('HKD DEMO 43').startsWith(normalizeHkdKey('HKD DEMO 62'))).toBe(false);
  });
});
