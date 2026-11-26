// [Admin Demo 17/9] "nội dung chuyển khoản khi gen VietQR chỉ để tên ĐL thôi — QR thì là QR a Bình SG, ĐL là ĐL a Bình SG"
// + "bill hoàn QR gen ra nội dung QR, bill hoàn nhanh gen ra nội dung ĐL".
// Nội dung CK là thứ đại lý NHÌN THẤY trên app ngân hàng để biết tiền của ai/nguồn nào → sai là gọi điện hỏi nhau.
import { describe, expect, it } from 'vitest';
import { noiDungChuyenKhoanQr } from './digistore-client';

describe('noiDungChuyenKhoanQr — nội dung CK trên VietQR', () => {
  it('bill hoàn QR → tiền tố QR; hoàn nhanh/lô POS → tiền tố DL', () => {
    expect(noiDungChuyenKhoanQr('QR', 'a Bình SG')).toBe('QR a Binh SG');
    expect(noiDungChuyenKhoanQr('DL', 'a Bình SG')).toBe('DL a Binh SG');
  });

  it('BỎ DẤU tiếng Việt (nội dung CK qua liên ngân hàng hay bị cắt dấu/lỗi ký tự)', () => {
    expect(noiDungChuyenKhoanQr('DL', 'Huy ĐắkLắk')).toBe('DL Huy DakLak');
    expect(noiDungChuyenKhoanQr('QR', 'Nam Hà Q1')).toBe('QR Nam Ha Q1');
  });

  it('KHÔNG nhân đôi tiền tố khi tên nhóm đã mang sẵn QR/ĐL (nhóm thật: "QR - ĐL Thông")', () => {
    expect(noiDungChuyenKhoanQr('QR', 'QR - ĐL Thông')).toBe('QR Thong');
    expect(noiDungChuyenKhoanQr('DL', 'ĐL- Mr Nguyễn SG')).toBe('DL Mr Nguyen SG');
    expect(noiDungChuyenKhoanQr('QR', 'QR Tuyên SG')).toBe('QR Tuyen SG');
  });

  it('gộp khoảng trắng thừa, không để lại đuôi rác', () => {
    expect(noiDungChuyenKhoanQr('DL', '  Bảo   SG  ')).toBe('DL Bao SG');
    expect(noiDungChuyenKhoanQr('QR', '')).toBe('QR');
  });
});
