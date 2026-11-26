// [Admin Demo 17/9 — file SAO_KE_00060792_MAI_ANH_NAM] Bản sao kê MBV rút gọn KHÔNG có cột "Tên/Số TK đối ứng" nên
// màn Tra soát chỉ khớp mò theo cả câu nội dung. Thông tin đối ứng THỰC RA nằm trong nội dung theo mẫu chi hộ cố
// định — bóc ra để khớp đúng đại lý/NĐT.
//
// RANH GIỚI: KHÔNG BỊA. Lệnh chuyển ĐI ("CUSTOMER KHACH HANG 02 chuyen tien") không ghi người nhận → phải trả null;
// số TK trong nội dung trùng TK của CHÍNH sao kê thì không phải đối ứng → cũng null.
import { describe, expect, it } from 'vitest';
import { bocDoiUngTuNoiDung } from '../src/statement-recon.js';

const TK_MINH = '00060792';

describe('bocDoiUngTuNoiDung — sao kê MBV thiếu cột đối ứng', () => {
  it('CHI HO TU TK <số>. TU: <tên> → lấy cả số TK đối ứng và tên', () => {
    const r = bocDoiUngTuNoiDung('8000122219 CHI HO TU TK DEMO-ACCT. TU: HKD DEMO 6', TK_MINH);
    expect(r.cpAccount).toBe('DEMO-ACCT');
    expect(r.cpName).toBe('HKD DEMO 6');
  });

  it('CHI HO VE TK <TK CỦA MÌNH> → KHÔNG nhận số TK đó là đối ứng, chỉ lấy tên', () => {
    const r = bocDoiUngTuNoiDung('8000122219 CHI HO VE TK 00060792. TU: HO KINH DOANH KHACH HANG 23 9100', TK_MINH);
    expect(r.cpAccount).toBeNull();
    expect(r.cpName).toBe('HO KINH DOANH KHACH HANG 23 9100');
  });

  it('biến thể "VE <số>" (thiếu chữ TK) vẫn đọc đúng', () => {
    const r = bocDoiUngTuNoiDung('8000122219 CHI HO VE 00060792. TU: HO KINH DOANH KHACH HANG 23 9100', TK_MINH);
    expect(r.cpAccount).toBeNull();
    expect(r.cpName).toBe('HO KINH DOANH KHACH HANG 23 9100');
  });

  it('lệnh chuyển ĐI không ghi người nhận → KHÔNG bịa, trả null cả hai', () => {
    const r = bocDoiUngTuNoiDung('CUSTOMER KHACH HANG 02 chuyen tien', TK_MINH);
    expect(r.cpName).toBeNull();
    expect(r.cpAccount).toBeNull();
  });

  it('nội dung rỗng / rác → null, không ném', () => {
    expect(bocDoiUngTuNoiDung(null, TK_MINH)).toEqual({ cpName: null, cpAccount: null });
    expect(bocDoiUngTuNoiDung('', TK_MINH)).toEqual({ cpName: null, cpAccount: null });
    expect(bocDoiUngTuNoiDung('TU: AB', TK_MINH).cpName).toBeNull(); // tên quá ngắn (<4 chữ) → không nhận
  });

  it('TK sao kê ghi có dấu cách/ký tự → vẫn nhận ra là TK của mình', () => {
    const r = bocDoiUngTuNoiDung('CHI HO VE TK 00060792. TU: HO KINH DOANH A B C', '0006 0792');
    expect(r.cpAccount).toBeNull();
  });
});
