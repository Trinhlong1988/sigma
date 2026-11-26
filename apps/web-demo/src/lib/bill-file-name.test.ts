// Test QUY TẮC ĐẶT TÊN ẢNH BILL sau OCR (Admin Demo 8/9): "<HKD> - <TID> <lô>", sắp theo tên = lô tăng dần.
import { describe, expect, it } from 'vitest';
import { loSort, posBillFileName, ckBillFileName, qrBillFileName, failBillFileName, tenNgan, gioTenFile, danhSoCkTheoGio, giaySoTrongNgay } from './bill-file-name';

const pos = (tid: string, lo: string, hkd = 'ABB KHACH HANG 35 M2') => ({ hkdName: hkd, bill: { tid, batchNumber: lo, agencyName: hkd } });

describe('đặt tên ảnh bill sau OCR', () => {
  it('POS: "<HKD> - <TID> <lô đệm 0>" — đúng ví dụ Admin Demo đưa', () => {
    expect(posBillFileName([pos('53550081', '113')])).toBe('ABB KHACH HANG 35 M2 - 53550081 0113');
  });

  it('SẮP THEO TÊN thì SỐ LÔ TĂNG DẦN (đây là lý do phải đệm 0)', () => {
    const ten = [pos('53550081', '9'), pos('53550081', '10'), pos('53550081', '113')]
      .map((b) => posBillFileName([b])!)
      .sort();
    expect(ten).toEqual([
      'ABB KHACH HANG 35 M2 - 53550081 0009',
      'ABB KHACH HANG 35 M2 - 53550081 0010',
      'ABB KHACH HANG 35 M2 - 53550081 0113'
    ]);
  });

  it('KHÔNG đệm thì thứ tự loạn — chứng minh bằng chính dữ liệu trên', () => {
    const khongDem = ['... 9', '... 10', '... 113'].sort();
    expect(khongDem).toEqual(['... 10', '... 113', '... 9']); // "10" đứng trước "9"
  });

  // [Admin Demo 8/9] MỖI ẢNH CHỈ 1 LÔ (2 tờ SALE + KẾT TOÁN cùng lô) → tên chỉ mang 1 lô, không gộp "+".
  it('2 tờ cùng lô trong 1 ảnh → tên chỉ 1 lô', () => {
    expect(posBillFileName([pos('53550081', '113'), pos('53550081', '113')]))
      .toBe('ABB KHACH HANG 35 M2 - 53550081 0113');
  });
  it('hiếm khi ảnh có 2 lô → lấy lô nhỏ nhất, KHÔNG nối dài tên', () => {
    expect(posBillFileName([pos('53550081', '114'), pos('53550081', '113')]))
      .toBe('ABB KHACH HANG 35 M2 - 53550081 0113');
  });

  it('không đọc được TID → null (tầng gọi sẽ gắn đuôi "thất bại")', () => {
    expect(posBillFileName([{ hkdName: 'X', bill: { tid: null, batchNumber: '5' } }])).toBeNull();
    expect(posBillFileName([])).toBeNull();
  });

  it('thiếu tên HKD → vẫn đặt được theo TID + lô', () => {
    expect(posBillFileName([{ bill: { tid: '53590002', batchNumber: '56' } }])).toBe('53590002 0056');
  });

  it('lô không phải số (rỗng/chữ) → giữ nguyên, không đệm bừa', () => {
    expect(loSort('')).toBe('');
    expect(loSort('AB')).toBe('AB');
    expect(loSort(' 7 ')).toBe('0007');
  });

  it('CK: "CK - <TÊN NGẮN> - <số thứ tự theo thời gian>" đúng mẫu Admin Demo', () => {
    expect(ckBillFileName({ senderName: 'KHACH HANG 01' }, 1)).toBe('CK - KETOAN - 1');
    expect(ckBillFileName({ senderName: 'KHACH HANG 01' }, 2)).toBe('CK - KETOAN - 2');
    expect(ckBillFileName({ senderName: 'NGUYEN VAN A' }, 1)).toBe('CK - NGUOIDUNG - 1');
    expect(ckBillFileName({ senderName: 'KHACH HANG 22' })).toBe('CK - THU'); // chưa có STT → vẫn đặt được
    expect(ckBillFileName({ senderName: null, receiverName: 'NGUYEN VAN A' }, 3)).toBe('CK - A - 3');
    expect(ckBillFileName({})).toBeNull();
  });
  it('tên ngắn = từ cuối họ tên · giờ chuẩn hoá HHhMM', () => {
    expect(tenNgan('  KHACH HANG 01 ')).toBe('KETOAN');
    expect(tenNgan(null)).toBe('');
    expect(gioTenFile('9:07:11')).toBe('09h07');
    expect(gioTenFile('sai')).toBe('');
  });

  it('QR: "<HKD> - QR <số giao dịch>"', () => {
    expect(qrBillFileName('HKD DEMO 40', '6251VNIB024PKM8D')).toBe('HKD DEMO 40 - QR 6251VNIB024PKM8D');
    expect(qrBillFileName(null, '3171466579')).toBe('QR 3171466579');
    expect(qrBillFileName(null, null)).toBeNull();
  });

  it('thất bại: GIỮ tên gốc + " - thất bại", KHÔNG cộng dồn khi quét lại nhiều lần', () => {
    expect(failBillFileName('1788832452162_486724.jpg')).toBe('1788832452162_486724 - thất bại');
    expect(failBillFileName('1788832452162_486724 - thất bại.jpg')).toBe('1788832452162_486724 - thất bại');
  });
});

// [Admin Demo 8/9] "bill CK đầu tiên của NGƯỜI CHUYỂN trong NGÀY trong folder là 1, tiếp theo THEO TIME là n+1".
// Đây là bằng chứng cho điểm em từng làm SAI: đếm theo thứ tự QUÉT (thứ tự file) — folder không sắp theo giờ là lệch.
describe('đánh số bill CK theo GIỜ (không theo thứ tự quét)', () => {
  it('folder quét LỘN XỘN theo giờ → số vẫn đúng theo thời gian', () => {
    const map = danhSoCkTheoGio([
      { idx: 0, nguoi: 'KETOAN', ngay: '08/09/2026', gio: '15:20' }, // quét trước nhưng giờ MUỘN hơn
      { idx: 1, nguoi: 'KETOAN', ngay: '08/09/2026', gio: '09:05' },
      { idx: 2, nguoi: 'KETOAN', ngay: '08/09/2026', gio: '11:47' }
    ]);
    expect(map.get(1)).toBe(1); // 09:05 → 1
    expect(map.get(2)).toBe(2); // 11:47 → 2
    expect(map.get(0)).toBe(3); // 15:20 → 3
  });

  it('MỖI NGƯỜI đếm riêng', () => {
    const map = danhSoCkTheoGio([
      { idx: 0, nguoi: 'KETOAN', ngay: '08/09/2026', gio: '09:00' },
      { idx: 1, nguoi: 'LONG', ngay: '08/09/2026', gio: '10:00' },
      { idx: 2, nguoi: 'KETOAN', ngay: '08/09/2026', gio: '11:00' }
    ]);
    expect([map.get(0), map.get(2)]).toEqual([1, 2]); // KT Demo: 1, 2
    expect(map.get(1)).toBe(1);                        // Long: 1
  });

  it('SANG NGÀY KHÁC thì đếm lại từ 1', () => {
    const map = danhSoCkTheoGio([
      { idx: 0, nguoi: 'THU', ngay: '07/09/2026', gio: '16:00' },
      { idx: 1, nguoi: 'THU', ngay: '08/09/2026', gio: '08:00' }
    ]);
    expect([map.get(0), map.get(1)]).toEqual([1, 1]);
  });

  it('bill KHÔNG đọc được giờ → xếp CUỐI, không cướp số của bill có giờ', () => {
    const map = danhSoCkTheoGio([
      { idx: 0, nguoi: 'KETOAN', ngay: '08/09/2026', gio: null },
      { idx: 1, nguoi: 'KETOAN', ngay: '08/09/2026', gio: '09:05' }
    ]);
    expect(map.get(1)).toBe(1);
    expect(map.get(0)).toBe(2);
  });

  it('giây được tính (2 bill cùng phút vẫn đúng thứ tự)', () => {
    expect(giaySoTrongNgay('09:05:30')).toBe(9 * 3600 + 5 * 60 + 30);
    const map = danhSoCkTheoGio([
      { idx: 0, nguoi: 'LONG', ngay: '08/09/2026', gio: '09:05:40' },
      { idx: 1, nguoi: 'LONG', ngay: '08/09/2026', gio: '09:05:10' }
    ]);
    expect([map.get(1), map.get(0)]).toEqual([1, 2]);
  });
});
