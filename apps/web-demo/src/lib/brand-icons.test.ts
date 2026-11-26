// QA bộ icon brand (Admin Demo 1/9 "kiểm chứng chi tiết, tường minh, đúng đủ"): mỗi nhãn trường → icon + màu ĐÚNG,
// và THỨ TỰ ưu tiên (nhãn cụ thể trước nhãn chung) để "Phải hoàn"/"Phí bán" KHÔNG rơi nhầm vào "tiền".
import { describe, it, expect } from 'vitest';
import { fieldIcon } from './brand-icons';

describe('brand-icons fieldIcon — map nhãn → icon + màu (đúng đủ, đúng ưu tiên)', () => {
  it('các nhãn chuẩn đều có icon (không null)', () => {
    for (const l of ['Số tiền', 'Ngân hàng', 'Ngày', 'Ngày giờ', 'TID', 'Khách', 'HKD', 'Lô', 'Phí bán', 'Phí cài máy', 'Phải hoàn', 'Tiền về', 'Đối tác', 'Người gửi', 'Người nhận', 'Mã GD']) {
      expect(fieldIcon(l), l).not.toBeNull();
    }
  });
  it('ƯU TIÊN: "Phải hoàn"/"Tiền về" → ví (emerald-600), KHÔNG rơi nhánh "tiền" (banknote emerald-500)', () => {
    expect(fieldIcon('Phải hoàn')!.className).toContain('emerald-600');
    expect(fieldIcon('Tiền về')!.className).toContain('emerald-600');
  });
  it('ƯU TIÊN: "Phí bán"/"Phí cài máy" → percent (amber), KHÔNG rơi "tiền"', () => {
    expect(fieldIcon('Phí bán')!.className).toContain('amber');
    expect(fieldIcon('Phí cài máy')!.className).toContain('amber');
  });
  it('"Số tiền" → banknote emerald-500', () => {
    expect(fieldIcon('Số tiền')!.className).toContain('emerald-500');
  });
  it('"Ngày"/"Ngày giờ" → sky (đồng hồ)', () => {
    expect(fieldIcon('Ngày')!.className).toContain('sky');
    expect(fieldIcon('Ngày giờ')!.className).toContain('sky');
  });
  it('nhãn lạ → null (không vẽ icon bừa)', () => {
    expect(fieldIcon('Xyz linh tinh')).toBeNull();
    expect(fieldIcon('')).toBeNull();
  });
});
