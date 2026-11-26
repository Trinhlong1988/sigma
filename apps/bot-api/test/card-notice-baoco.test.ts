// [Admin Demo 10/9 — quyết phương án 1] Ảnh THÔNG BÁO GIAO DỊCH THẺ (email/SMS ngân hàng gửi CHỦ THẺ) không in tên
// HKD/Số giao dịch → phải khớp BÁO-CÓ theo TIỀN + GIỜ + TÊN CHỦ THẺ. Test khoá luật thu hẹp theo người quẹt:
// khớp DUY NHẤT mới đủ để tự điền; nhiều/không ai khớp → giữ nguyên cho người duyệt chọn (CẤM đoán tiền).
// Số liệu = ca THẬT 10/9: 10.500.000đ, 12:59, KHACH HANG 15 ↔ báo-có HKD TRÀ MY NGUYỄN 13:00:14.
import { describe, it, expect } from 'vitest';
import { locUngVienTheoNguoiQuet } from '../src/digistore-reconcile.js';

const traMy = { billId: '6187F84D', qrCode: '99MPC0017370400000', hkdName: 'HKD TRÀ MY NGUYỄN', payerName: 'KHACH HANG 15', amount: 10500000, atMs: 1789045214000, externalRefNo: '6253VNIB02UBWFJP', sourceTidId: 9, reconcileStatus: 'UNRECONCILED' };
const khac = { ...traMy, billId: 'KHAC-1', hkdName: 'HKD KHAC', payerName: 'NGUYEN VAN B', externalRefNo: 'REF-KHAC' };

describe('thu hẹp gợi ý báo-có theo TÊN CHỦ THẺ (ảnh thông báo giao dịch thẻ)', () => {
  it('2 báo-có cùng tiền+giờ, chỉ 1 trùng tên chủ thẻ → còn đúng 1 (đủ để tự điền)', () => {
    const r = locUngVienTheoNguoiQuet([traMy, khac], 'KHACH HANG 15');
    expect(r.candidates.map((c) => c.billId)).toEqual(['6187F84D']);
    expect(r.thuHep).toBe(true);
  });

  it('sai chính tả nhẹ (OCR) vẫn khớp — dung sai edit-distance ≤ 2', () => {
    const r = locUngVienTheoNguoiQuet([traMy, khac], 'KHACH HANG 16');
    expect(r.candidates.map((c) => c.billId)).toEqual(['6187F84D']);
  });

  it('KHÔNG ai trùng tên → GIỮ NGUYÊN cả danh sách (không giấu dữ liệu của người duyệt)', () => {
    const r = locUngVienTheoNguoiQuet([traMy, khac], 'TRAN THI X');
    expect(r.candidates).toHaveLength(2);
    expect(r.thuHep).toBe(false);
  });

  it('ảnh không đọc được tên chủ thẻ / chỉ 1 ứng viên → không đụng gì', () => {
    expect(locUngVienTheoNguoiQuet([traMy, khac], null).candidates).toHaveLength(2);
    expect(locUngVienTheoNguoiQuet([traMy], 'AI ĐÓ').candidates).toHaveLength(1);
  });

  it('nhiều báo-có CÙNG tên người quẹt → vẫn trả nhiều (mơ hồ) → tầng trên bắt kiểm tay', () => {
    const trung = { ...traMy, billId: 'TRUNG-2', hkdName: 'HKD TRÀ MY NGUYỄN 2', externalRefNo: 'REF-2' };
    const r = locUngVienTheoNguoiQuet([traMy, trung, khac], 'KHACH HANG 15');
    expect(r.candidates.map((c) => c.billId)).toEqual(['6187F84D', 'TRUNG-2']);
  });
});

// [Admin Demo 10/9 — sau đợt phản biện] Khoá 2 lỗ mà đợt audit chỉ ra trên CHÍNH luồng thông báo giao dịch thẻ.
describe('cổng báo-có: số giao dịch khớp KHÔNG được tự kết luận', () => {
  const baoCo = { billId: 'B1', qrCode: 'QR1', hkdName: 'HKD TRÀ MY NGUYỄN', payerName: 'KHACH HANG 15', amount: 10_500_000, atMs: 1789045214000, externalRefNo: '6253VNIB02UBWFJP', sourceTidId: 9, reconcileStatus: null as string | null, description: 'QR', status: 'SUCCESS' };

  it('ref khớp + TIỀN khớp → MATCHED', async () => {
    const { checkBillAgainstBaoCo } = await import('../src/digistore-reconcile.js');
    const r = checkBillAgainstBaoCo({ hkdName: 'HKD TRÀ MY NGUYỄN', amount: 10_500_000, atMs: 1789045214000, ref: '6253VNIB02UBWFJP', payerName: null }, [baoCo]);
    expect(r.status).toBe('MATCHED');
  });

  it('ref ĐỌC TỪ ẢNH: giữ hành vi cũ — ref là khoá mạnh nhất, vẫn MATCHED', async () => {
    const { checkBillAgainstBaoCo } = await import('../src/digistore-reconcile.js');
    const r = checkBillAgainstBaoCo({ hkdName: 'HKD KHÁC', amount: 10_500_000, atMs: null, ref: '6253VNIB02UBWFJP', payerName: null }, [baoCo]);
    expect(r.status).toBe('MATCHED');
  });

  it('ref LẤY TỪ BÁO-CÓ + tên người quẹt LỆCH → AMBIGUOUS (bấm nhầm dòng thì không được tự xác nhận)', async () => {
    const { checkBillAgainstBaoCo } = await import('../src/digistore-reconcile.js');
    const r = checkBillAgainstBaoCo({ hkdName: 'HKD KHÁC', amount: 10_500_000, atMs: 1789045214000, ref: '6253VNIB02UBWFJP', payerName: 'NGUYEN VAN X', refTuBaoCo: true }, [baoCo]);
    expect(r.status).toBe('AMBIGUOUS');
  });

  it('ref LẤY TỪ BÁO-CÓ + đúng người quẹt + đúng giờ → MATCHED', async () => {
    const { checkBillAgainstBaoCo } = await import('../src/digistore-reconcile.js');
    const r = checkBillAgainstBaoCo({ hkdName: 'HKD TRÀ MY NGUYỄN', amount: 10_500_000, atMs: 1789045214000, ref: '6253VNIB02UBWFJP', payerName: 'KHACH HANG 15', refTuBaoCo: true }, [baoCo]);
    expect(r.status).toBe('MATCHED');
  });
});
