// [Admin Demo 25/9 "sao drop chọn ĐL Lâm chưa có? CẤM TÁI DIỄN"] KHOÁ luật dropdown đại lý QR.
//
// CA THẬT bị lọt: tạo nhóm chat tên "ĐL- Lâm QN" (đúng chữ Admin Demo nhắn) → đại lý KHÔNG lên dropdown Báo cáo QR,
// vì /v1/digistore/dealer-names CHỈ rút tên từ nhóm tiền tố "QR". Lỗi tới tay Admin Demo mới lộ. Test này chốt luật
// để mọi thay đổi sau phải cố ý: nhóm "ĐL-" KHÔNG BAO GIỜ thành đại lý QR, nhóm "QR ..." thì có.
import { describe, it, expect } from 'vitest';
import { tenDaiLyTuNhomQr } from '../src/routes/digistore.js';

describe('dropdown đại lý QR — chỉ nhận nhóm tiền tố QR', () => {
  it('nhóm "ĐL- X" KHÔNG lên dropdown (đúng ca Lâm QN bị lọt 25/9)', () => {
    expect(tenDaiLyTuNhomQr(['ĐL- Lâm QN'])).toEqual([]);
    expect(tenDaiLyTuNhomQr(['ĐL - Đại lý A', 'ĐL- Đại lý C'])).toEqual([]);
  });

  it('nhóm "QR - X" lên dropdown và bị cắt tiền tố', () => {
    expect(tenDaiLyTuNhomQr(['QR - Lâm QN'])).toEqual(['Lâm QN']);
    expect(tenDaiLyTuNhomQr(['QR- Bảo SG', 'QR_Nam Hà', 'QR – Tuyên SG'])).toEqual(['Bảo SG', 'Nam Hà', 'Tuyên SG']);
  });

  it('gộp trùng không phân biệt hoa/thường, giữ bản viết ĐẦU TIÊN', () => {
    expect(tenDaiLyTuNhomQr(['QR - Bảo SG', 'QR- BẢO SG'])).toEqual(['Bảo SG']);
  });

  it('bỏ tên rỗng / null / nhóm chỉ có mỗi chữ QR', () => {
    expect(tenDaiLyTuNhomQr([null, '', '   ', 'QR - ', 'QR'])).toEqual([]);
  });

  it('không cắt nhầm tên khách bắt đầu bằng chữ khác', () => {
    expect(tenDaiLyTuNhomQr(['QR - QRS Corp'])).toEqual(['QRS Corp']);
  });

  it('DANH SÁCH THẬT 25/9: trộn nhóm QR và ĐL thì chỉ nhóm QR ra', () => {
    const that = ['QR - A BÌnh', 'QR - A Dương HL', 'QR - Bảo SG', 'QR - Lâm QN', 'QR - Nam Hà',
      'QR - Nguyễn', 'QR - Trường Thiện SG', 'QR - Tuyên SG', 'QR - ĐL Thông',
      'ĐL - Đại lý A', 'ĐL- Đại lý C', 'ĐL - Quỳnh SG', 'NĐT 1'];
    const ra = tenDaiLyTuNhomQr(that);
    expect(ra).toContain('Lâm QN');
    expect(ra).toHaveLength(9);
    expect(ra.some((x) => x.includes('Đại lý C'))).toBe(false);
  });
});
