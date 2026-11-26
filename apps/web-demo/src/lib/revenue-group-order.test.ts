// [Admin Demo 10/9] Khoá thứ tự màn "Doanh số theo nhóm": NĐT trước → đại lý → nhóm QR sau cùng.
import { describe, it, expect } from 'vitest';
import { hangNhom, xepNhomDoanhSo } from './revenue-group-order';

describe('thứ tự nhóm ở màn Doanh số theo nhóm', () => {
  it('phân hạng theo tên: NĐT/khác = 0 · đại lý = 1 · QR = 2', () => {
    expect(hangNhom('Thông Thái Nguyên')).toBe(0);
    expect(hangNhom('Trung CP')).toBe(0);
    expect(hangNhom('ĐL- Mr Nguyễn SG')).toBe(1);
    expect(hangNhom('ĐL - Lộc SG')).toBe(1);
    expect(hangNhom('DL-Nam Hà SG')).toBe(1); // viết không dấu vẫn nhận
    expect(hangNhom('QR Bảo SG')).toBe(2);
    expect(hangNhom('qr - thanh nam')).toBe(2);
  });

  it('sắp đúng: NĐT → đại lý → QR, trong mỗi hạng theo tên', () => {
    const ds = [
      { name: 'QR Bảo SG' },
      { name: 'ĐL- Mr Nguyễn SG' },
      { name: 'Trung CP' },
      { name: 'ĐL - Lộc SG' },
      { name: 'Thông Thái Nguyên' },
      { name: 'QR Anh Bình' }
    ];
    expect(xepNhomDoanhSo(ds).map((x) => x.name)).toEqual([
      'Thông Thái Nguyên', 'Trung CP',
      'ĐL - Lộc SG', 'ĐL- Mr Nguyễn SG',
      'QR Anh Bình', 'QR Bảo SG'
    ]);
  });

  it('không đổi mảng gốc (thuần) + chịu được tên rỗng/null', () => {
    const ds = [{ name: 'QR X' }, { name: null }, { name: 'ĐL A' }];
    const out = xepNhomDoanhSo(ds);
    expect(ds.map((x) => x.name)).toEqual(['QR X', null, 'ĐL A']); // gốc giữ nguyên
    expect(out.map((x) => x.name)).toEqual([null, 'ĐL A', 'QR X']);
  });
});
