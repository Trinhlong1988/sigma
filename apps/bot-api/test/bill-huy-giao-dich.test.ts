// [Admin Demo 17/9 — ca thật lô 75 TID 67512202 nhà Nguyễn Duy Linh M2] Bill TỔNG KẾT ABBank in 2 dòng:
//   THANH TOÁN 5  VND 109,613,000      HỦY 1  VND 11,000
// Doanh số ĐÚNG = 109.613.000 − 11.000 = 109.602.000. Trước đây hệ chỉ lấy dòng "Thanh toán" ⇒ ghi THỪA đúng
// bằng phần đã hủy, Admin Demo phải sửa tay từng bill.
//
// Nguyên tắc: OCR chỉ ĐỌC NGUYÊN VĂN 2 con số (totalAmount, voidAmount) — phép TRỪ do hệ thống làm (tienGhiNhan)
// để đối chiếu được từng bill; không giao cho model tự tính.
import { describe, expect, it } from 'vitest';
import { tienGhiNhan, normalizeBill, parseClientBill } from '../src/ocr-send-service.js';

describe('tienGhiNhan — trừ giao dịch hủy trên bill tổng kết', () => {
  it('CA THẬT lô 75: 109.613.000 − 11.000 = 109.602.000', () => {
    expect(tienGhiNhan({ totalAmount: 109_613_000, voidAmount: 11_000 })).toBe(109_602_000);
  });

  it('không có dòng hủy → giữ nguyên tổng quẹt', () => {
    expect(tienGhiNhan({ totalAmount: 50_000_000 })).toBe(50_000_000);
    expect(tienGhiNhan({ totalAmount: 50_000_000, voidAmount: 0 })).toBe(50_000_000);
    expect(tienGhiNhan({ totalAmount: 50_000_000, voidAmount: null })).toBe(50_000_000);
  });

  it('OCR đọc LỆCH CỘT (hủy > tổng, hủy âm) → KHÔNG trừ, giữ tổng (không đẻ số âm/vô lý)', () => {
    expect(tienGhiNhan({ totalAmount: 10_000_000, voidAmount: 99_000_000 })).toBe(10_000_000);
    expect(tienGhiNhan({ totalAmount: 10_000_000, voidAmount: -5_000 })).toBe(10_000_000);
  });

  it('hủy ĐÚNG BẰNG tổng (hủy hết lô) → ghi nhận 0', () => {
    expect(tienGhiNhan({ totalAmount: 11_000, voidAmount: 11_000 })).toBe(0);
  });
});

describe('normalizeBill / parseClientBill — trường hủy KHÔNG được rơi', () => {
  it('OCR service → OcrBill giữ voidCount/voidAmount', () => {
    const b = normalizeBill({ tid: '67512202', agencyName: 'HKD DEMO 27', batchNumber: '75', type: 'SETTLEMENT', totalAmount: 109_613_000, dateTime: '16/09/2026 11:51', voidCount: 1, voidAmount: 11_000 });
    expect(b.voidCount).toBe(1);
    expect(b.voidAmount).toBe(11_000);
    expect(b.totalAmount).toBe(109_613_000); // tổng quẹt GIỮ NGUYÊN, không tự trừ
    expect(tienGhiNhan(b)).toBe(109_602_000);
  });

  it('client gửi /send → parseClientBill giữ trường hủy (rơi field = doanh số ghi thừa)', () => {
    const b = parseClientBill({ tid: '67512202', batchNumber: '75', totalAmount: 109_613_000, voidCount: 1, voidAmount: 11_000 });
    expect(b.voidAmount).toBe(11_000);
    expect(tienGhiNhan(b)).toBe(109_602_000);
  });

  it('bill cũ KHÔNG có trường hủy → 0, hành vi y như trước (không phá dữ liệu cũ)', () => {
    const b = normalizeBill({ tid: '53550071', batchNumber: '12', totalAmount: 20_000_000 });
    expect(b.voidCount).toBe(0);
    expect(b.voidAmount).toBe(0);
    expect(tienGhiNhan(b)).toBe(20_000_000);
  });
});
