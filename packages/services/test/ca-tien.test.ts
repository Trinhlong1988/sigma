// Khoá BẢNG CA TIỀN đúng mốc Admin Demo cung cấp (CẤM suy luận/xê dịch mốc — sai mốc là sai doanh số theo ca).
import { describe, it, expect } from 'vitest';
import { caCuaGio, caCuaInstant, khoaBankCa, khoaBankCaTu } from '../src/ca-tien.js';
import { nhanBank } from '../src/nhan-bank.js';

describe('ca tiền về theo bank (mốc chính chủ)', () => {
  it('MB: 09:40 hết ca 1 · 16:40 hết ca 2', () => {
    expect(caCuaGio('MB', '00:00')).toBe(1);
    expect(caCuaGio('MB', '09:40')).toBe(1);
    expect(caCuaGio('MB', '09:41')).toBe(2);
    expect(caCuaGio('MB', '16:40')).toBe(2);
    expect(caCuaGio('MB', '16:41')).toBe(3);
    expect(caCuaGio('MB', '23:59')).toBe(3);
  });
  it('ABB: 09:50 / 14:50', () => {
    expect(caCuaGio('ABB', '09:50')).toBe(1);
    expect(caCuaGio('ABB', '09:51')).toBe(2);
    expect(caCuaGio('ABB', '14:50')).toBe(2);
    expect(caCuaGio('ABB', '14:51')).toBe(3);
  });
  it('MBV: 11:50 / 17:50 (đính chính của Admin Demo: ca 3 bắt đầu SAU 17:50)', () => {
    expect(caCuaGio('MBV', '11:50')).toBe(1);
    expect(caCuaGio('MBV', '11:51')).toBe(2);
    expect(caCuaGio('MBV', '17:50')).toBe(2);
    expect(caCuaGio('MBV', '17:51')).toBe(3);
  });
  it('MBB = biểu MB · bank lạ/thiếu giờ → null (không xếp bừa)', () => {
    expect(caCuaGio('MBB', '10:00')).toBe(2);
    expect(khoaBankCa('VP')).toBeNull();
    expect(caCuaGio('VP', '10:00')).toBeNull();
    expect(caCuaGio('MB', '')).toBeNull();
  });
  it('caCuaInstant quy giờ HCM tường minh (UTC+7, không theo TZ máy)', () => {
    // 02:41 UTC = 09:41 HCM → MB ca 2
    expect(caCuaInstant('MB', new Date('2026-09-11T02:41:00.000Z'))).toBe(2);
    expect(caCuaInstant('MB', '2026-09-11T02:40:00.000Z')).toBe(1);
  });
});

describe('[B-L1 21/9] khoaBankCa theo TÊN BANK THẬT trong DB prod', () => {
  it('"AB Bank" (tên thật banks.name, không phải "ABB") phải ra ABB — trước trả null → lọc ca loại câm bill ABB', () => {
    expect(khoaBankCa('AB Bank')).toBe('ABB');
    expect(khoaBankCa('AB BANK')).toBe('ABB');
    expect(khoaBankCa('ABB')).toBe('ABB');
  });
  it('MB các biến thể + MBV không lẫn nhau; bank lạ vẫn null (cấm đoán)', () => {
    expect(khoaBankCa('MB')).toBe('MB');
    expect(khoaBankCa('MBBank')).toBe('MB');
    expect(khoaBankCa('MBV')).toBe('MBV');
    expect(khoaBankCa('VP bank')).toBeNull();
    expect(khoaBankCa('Sacombank')).toBeNull();
  });
});

// [B174 — Admin Demo 16/11] NHÃN BANK DÙNG ĐỂ XẾP CA PHẢI LÀ MÃ VIẾT TẮT.
// Chuyện đã xảy ra: danh mục ngân hàng trên sổ thật được đổi sang TÊN PHÁP NHÂN đầy đủ
// ("NH TMCP Quân đội MB", "NH TNHH MTV Việt Nam Hiện đại MBV", "NH TMCP An Bình ABB") — từ lúc đó
// `khoaBankCa(tên)` trả null cho CẢ BA ⇒ mọi báo cáo LỌC THEO CA loại sạch giao dịch, KHÔNG báo gì.
// Bài kiểm này khoá hợp đồng: thứ `nhanBank()` sinh ra (mã viết tắt) PHẢI tra được bảng mốc ca.
describe('[B174 16/11] nhãn bank của nhanBank() phải xếp được ca', () => {
  const DANH_MUC_THAT = [
    { code: 'MB', name: 'NH TMCP Quân đội MB', khoa: 'MB' },
    { code: 'MBV', name: 'NH TNHH MTV Việt Nam Hiện đại MBV', khoa: 'MBV' },
    { code: 'ABB', name: 'NH TMCP An Bình ABB', khoa: 'ABB' }
  ];
  it('mã viết tắt (thứ app hiển thị) tra được bảng mốc ca', () => {
    for (const b of DANH_MUC_THAT) expect(khoaBankCa(nhanBank(b))).toBe(b.khoa);
  });
  it('ĐỐI CHỨNG — tên pháp nhân đầy đủ KHÔNG tra được (chính là lỗi đã gặp)', () => {
    for (const b of DANH_MUC_THAT) expect(khoaBankCa(b.name)).toBeNull();
  });
  it('nhanBank: có mã thì lấy mã, không mã mới lấy tên, rỗng → null', () => {
    expect(nhanBank({ code: 'MBV', name: 'NH TNHH MTV Việt Nam Hiện đại MBV' })).toBe('MBV');
    expect(nhanBank({ code: '', name: 'Ngân hàng lạ' })).toBe('Ngân hàng lạ');
    expect(nhanBank({ code: null, name: null })).toBeNull();
    expect(nhanBank(null)).toBeNull();
  });
});

// [B174b 16/11] KHOÁ TRA CA phải chịu được CẢ HAI kiểu dữ liệu — đây là chỗ bug lọt câm:
// sổ thật để dấu hiệu ngân hàng ở MÃ (name = tên pháp nhân ⇒ null), bản ghi/bộ dựng cũ để ở TÊN (mã là chuỗi rác).
describe('[B174b 16/11] khoaBankCaTu — mã trước, mã không ra thì tên', () => {
  it('chiều SỔ THẬT: mã mang tên ngân hàng, tên là tên pháp nhân', () => {
    expect(khoaBankCaTu('MBV', 'NH TNHH MTV Việt Nam Hiện đại MBV')).toBe('MBV');
    expect(khoaBankCaTu('MB', 'NH TMCP Quân đội MB')).toBe('MB');
    expect(khoaBankCaTu('ABB', 'NH TMCP An Bình ABB')).toBe('ABB');
  });
  it('chiều BẢN GHI CŨ: mã là chuỗi sinh tự động, dấu hiệu nằm ở TÊN', () => {
    expect(khoaBankCaTu('BK1794803807134', 'MBV x12345')).toBe('MBV');
    expect(khoaBankCaTu('', 'AB Bank')).toBe('ABB');
  });
  it('ĐỐI CHỨNG: ngoài bảng mốc thì KHÔNG gán ca bừa', () => {
    expect(khoaBankCaTu('VP', 'NH TMCP Việt Nam Thịnh vượng VP')).toBeNull();
    expect(khoaBankCaTu('SMP', 'CTY TNHH TMDV Mạng lưới Thông minh SMARTPAY')).toBeNull();
    expect(khoaBankCaTu(null, null)).toBeNull();
  });
});
