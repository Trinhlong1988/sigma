// REGRESSION — công thức KPI Doanh Số: quy đổi ngưỡng "tháng" khi kỳ ≠ 1 tháng + phân loại POS.
// Ngưỡng CHUNG mọi bank (Admin Demo 24/11): < 5 tỉ/tháng = THẤP, ≥ 13 tỉ/tháng = ĐẠT HẠN MỨC.
// 0 bill = KHÔNG CHẠY (mục riêng). Test ĐỎ-TRƯỚC-XANH-SAU: đổi ngưỡng/quy đổi sai là một case đổi màu.
import { describe, expect, it } from 'vitest';
import {
  quyDoiThang,
  phanLoaiPos,
  NGUONG_THAP_THANG,
  NGUONG_HAN_MUC_THANG
} from '../src/kpi-doanh-so.js';

const TI = 1_000_000_000;

describe('quyDoiThang — chuẩn hoá doanh số kỳ về /tháng (30 ngày)', () => {
  it('kỳ đúng 30 ngày: giữ nguyên', () => {
    expect(quyDoiThang(7 * TI, 30)).toBe(7 * TI);
  });
  it('kỳ 10 ngày, 2 tỉ → 6 tỉ/tháng (×3)', () => {
    expect(quyDoiThang(2 * TI, 10)).toBe(6 * TI);
  });
  it('kỳ 15 ngày, 3 tỉ → 6 tỉ/tháng (×2)', () => {
    expect(quyDoiThang(3 * TI, 15)).toBe(6 * TI);
  });
  it('soNgayKy < 1 bị kẹp về 1 (không chia 0)', () => {
    expect(quyDoiThang(1 * TI, 0)).toBe(30 * TI);
  });
});

describe('phanLoaiPos — ngưỡng 5 tỉ / 13 tỉ theo tháng', () => {
  it('0 bill → không chạy (dù doanh số = 0 < 5 tỉ, KHÔNG xếp "thấp")', () => {
    expect(phanLoaiPos(0, 0, 30)).toBe('khong_chay');
  });
  it('4,9 tỉ/tháng → thấp', () => {
    expect(phanLoaiPos(4.9 * TI, 3, 30)).toBe('thap');
  });
  it('đúng 5 tỉ/tháng → bình thường (ngưỡng thấp là "< 5", biên không tính thấp)', () => {
    expect(phanLoaiPos(NGUONG_THAP_THANG, 3, 30)).toBe('binh_thuong');
  });
  it('8 tỉ/tháng → bình thường', () => {
    expect(phanLoaiPos(8 * TI, 5, 30)).toBe('binh_thuong');
  });
  it('đúng 13 tỉ/tháng → đạt hạn mức (biên ≥ tính đạt)', () => {
    expect(phanLoaiPos(NGUONG_HAN_MUC_THANG, 5, 30)).toBe('dat_han_muc');
  });
  it('[F3] POS mới giao (moiGiao=true) chạy ít → "mới giao", KHÔNG "thấp" oan', () => {
    expect(phanLoaiPos(1 * TI, 2, 30, true)).toBe('moi_giao');
  });
  it('[F3] POS mới giao 0 bill → "mới giao", KHÔNG "không chạy" oan', () => {
    expect(phanLoaiPos(0, 0, 30, true)).toBe('moi_giao');
  });
  it('[F3] POS mới giao nhưng ĐÃ ≥13 tỉ/tháng → VẪN "đạt hạn mức" (cảnh báo trần vẫn phải hiện)', () => {
    expect(phanLoaiPos(13.1 * TI, 9, 30, true)).toBe('dat_han_muc');
  });
  it('13,1 tỉ/tháng → đạt hạn mức', () => {
    expect(phanLoaiPos(13.1 * TI, 9, 30)).toBe('dat_han_muc');
  });
  it('12,9 tỉ/tháng → bình thường (chưa đạt)', () => {
    expect(phanLoaiPos(12.9 * TI, 9, 30)).toBe('binh_thuong');
  });

  describe('kỳ ngắn phải QUY ĐỔI trước khi so ngưỡng (không so số thật trong kỳ)', () => {
    it('kỳ 10 ngày chạy 1,5 tỉ → 4,5 tỉ/tháng → thấp (dù 1,5 tỉ thật nhỏ)', () => {
      expect(phanLoaiPos(1.5 * TI, 4, 10)).toBe('thap');
    });
    it('kỳ 10 ngày chạy 1,7 tỉ → 5,1 tỉ/tháng → bình thường (vượt ngưỡng thấp sau quy đổi)', () => {
      expect(phanLoaiPos(1.7 * TI, 4, 10)).toBe('binh_thuong');
    });
    it('kỳ 10 ngày chạy 4,4 tỉ → 13,2 tỉ/tháng → đạt hạn mức', () => {
      expect(phanLoaiPos(4.4 * TI, 8, 10)).toBe('dat_han_muc');
    });
    it('kỳ 7 ngày chạy 1 tỉ → ~4,29 tỉ/tháng → thấp', () => {
      expect(phanLoaiPos(1 * TI, 3, 7)).toBe('thap');
    });
  });
});
