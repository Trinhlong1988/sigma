// [PHẢN BIỆN ĐỐI KHÁNG 11/9 — agent 1, MẢNG B1] Logic chọn bậc giá lúc GỬI (/send-qr) trước đây nằm INLINE trong
// route (không test được) → tách hàm THUẦN chonBacGiaQr (ocr-send-service) — route dùng CHÍNH hàm này. Test khẳng định:
//  • giaNhanh=true nhưng mã KHÔNG có bậc nhanh (null/0) → rơi về giá CHỜ (fail-safe, không tự chế giá, không lỗi).
//  • chọn nhanh hợp lệ → dùng đúng giá nhanh; nhanh < mua → spreadNegative=true (route 422, fail-closed money).
//  • làm tròn effSellFeeAmount đồng công thức Math.round với review/computeFeeLine.
import { describe, expect, it } from 'vitest';
import { chonBacGiaQr } from '../src/ocr-send-service.js';

describe('chonBacGiaQr — bậc giá bán QR lúc gửi', () => {
  it('B1: giaNhanh=true + mã không có bậc nhanh (null) → rơi về CHỜ, không spread âm giả', () => {
    const r = chonBacGiaQr({ giaNhanhRequested: true, amount: 10_000_000, sellFeeMilli: 1050, sellFeeMilliNhanh: null, partnerFeeMilli: 880 });
    expect(r.giaNhanh).toBe(false);
    expect(r.effSellFeeMilli).toBe(1050);
    expect(r.effSellFeeAmount).toBe(105_000);
    expect(r.spreadNegative).toBe(false);
  });
  it('B1: bậc nhanh = 0 (dữ liệu rác) cũng rơi về CHỜ', () => {
    const r = chonBacGiaQr({ giaNhanhRequested: true, amount: 5_000_000, sellFeeMilli: 950, sellFeeMilliNhanh: 0, partnerFeeMilli: 880 });
    expect(r.giaNhanh).toBe(false);
    expect(r.effSellFeeMilli).toBe(950);
  });
  it('chọn nhanh hợp lệ (1150 > mua 880) → dùng giá nhanh, không spread âm', () => {
    const r = chonBacGiaQr({ giaNhanhRequested: true, amount: 10_000_000, sellFeeMilli: 950, sellFeeMilliNhanh: 1150, partnerFeeMilli: 880 });
    expect(r.giaNhanh).toBe(true);
    expect(r.effSellFeeMilli).toBe(1150);
    expect(r.effSellFeeAmount).toBe(115_000);
    expect(r.spreadNegative).toBe(false);
  });
  it('B2: nhanh (700) < mua (880) → spreadNegative=true (route phải 422, không ghi tiền)', () => {
    const r = chonBacGiaQr({ giaNhanhRequested: true, amount: 10_000_000, sellFeeMilli: 950, sellFeeMilliNhanh: 700, partnerFeeMilli: 880 });
    expect(r.giaNhanh).toBe(true);
    expect(r.spreadNegative).toBe(true);
  });
  it('không tích nhanh → luôn bậc CHỜ kể cả mã có nhanh', () => {
    const r = chonBacGiaQr({ giaNhanhRequested: false, amount: 10_000_000, sellFeeMilli: 950, sellFeeMilliNhanh: 1150, partnerFeeMilli: 880 });
    expect(r.giaNhanh).toBe(false);
    expect(r.effSellFeeMilli).toBe(950);
  });
  it('B5: amount lẻ 1.234.567 × nhanh 1150 → effSellFeeAmount = Math.round (từng đồng, khớp review)', () => {
    const amount = 1_234_567;
    const r = chonBacGiaQr({ giaNhanhRequested: true, amount, sellFeeMilli: 950, sellFeeMilliNhanh: 1150, partnerFeeMilli: 880 });
    expect(r.effSellFeeAmount).toBe(Math.round((amount * 1150) / 100000));
  });
});
