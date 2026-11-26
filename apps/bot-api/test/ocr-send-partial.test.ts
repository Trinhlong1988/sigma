// LÕI DEDUP THEO TỪNG ĐÍCH gửi bill POS (Admin Demo 1/9 "rớt mạng chưa gửi 1 trong 2 NĐT/đại lý thì sao" + "cấm báo
// cáo láo, kiểm chứng"): gửi lại phải HOÀN TẤT bên THIẾU, KHÔNG gửi lại bên đã gửi (chống rác + đếm đôi doanh số).
// Chỉ khi ĐÃ gửi ĐỦ cả 2 mới báo trùng. Test hàm THUẦN decideBillSendTargets — đủ mọi tổ hợp trạng thái.
import { describe, it, expect } from 'vitest';
import { decideBillSendTargets } from '../src/ocr-send-service.js';

const d = (dealerSent: boolean, invSent: boolean, hasInvestor: boolean, allowDuplicate = false) =>
  decideBillSendTargets({ dealerSent, invSent, hasInvestor, allowDuplicate });

describe('decideBillSendTargets — dedup theo từng đích (đại lý/NĐT)', () => {
  it('MỚI hoàn toàn (chưa gửi gì, có NĐT) → gửi CẢ đại lý + NĐT', () => {
    expect(d(false, false, true)).toEqual({ isDuplicate: false, doDealer: true, doInvestor: true });
  });

  it('★ PARTIAL: đại lý ĐÃ gửi, NĐT CHƯA (rớt mạng) → CHỈ gửi NĐT (hoàn tất), KHÔNG gửi lại đại lý, KHÔNG báo trùng', () => {
    expect(d(true, false, true)).toEqual({ isDuplicate: false, doDealer: false, doInvestor: true });
  });

  it('ĐÃ GỬI ĐỦ cả 2 → TRÙNG (chặn), không gửi gì', () => {
    expect(d(true, true, true)).toEqual({ isDuplicate: true, doDealer: false, doInvestor: false });
  });

  it('KHÔNG có NĐT, chưa gửi → chỉ đại lý', () => {
    expect(d(false, true, false)).toEqual({ isDuplicate: false, doDealer: true, doInvestor: false });
  });

  it('KHÔNG có NĐT, đại lý đã gửi → TRÙNG', () => {
    expect(d(true, true, false)).toEqual({ isDuplicate: true, doDealer: false, doInvestor: false });
  });

  it('edge: NĐT đã có nhưng đại lý CHƯA (hiếm) → chỉ gửi đại lý', () => {
    expect(d(false, true, true)).toEqual({ isDuplicate: false, doDealer: true, doInvestor: false });
  });

  // Admin Demo 1/9 CHỐT: bill POS trùng CHẶN CỨNG như CK — "trùng bấm gửi VẪN KHÔNG gửi". allowDuplicate KHÔNG còn
  // force re-post bill đã gửi đủ (bỏ bypass "vẫn gửi"). Đã gửi đủ → TRÙNG dù allowDuplicate.
  it('★ CHẶN CỨNG: đã gửi đủ + allowDuplicate=true → VẪN TRÙNG, KHÔNG post lại (như CK)', () => {
    expect(d(true, true, true, true)).toEqual({ isDuplicate: true, doDealer: false, doInvestor: false });
  });

  it('★ CHẶN CỨNG: đã gửi đủ (không NĐT) + allowDuplicate=true → VẪN TRÙNG', () => {
    expect(d(true, true, false, true)).toEqual({ isDuplicate: true, doDealer: false, doInvestor: false });
  });

  it('PARTIAL vẫn hoàn tất bên thiếu dù allowDuplicate (không bỏ sót)', () => {
    expect(d(true, false, true, true)).toEqual({ isDuplicate: false, doDealer: false, doInvestor: true });
  });
});
