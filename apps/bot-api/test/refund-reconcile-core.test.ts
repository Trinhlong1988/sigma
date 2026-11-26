import { describe, it, expect } from 'vitest';
import { computeRefundReconcileCore } from '../src/ocr-send-service';

type Ck = { refundAmount: number; billDate: string | null; kind: 'REFUND' | 'ADVANCE'; ckTxnKey: string | null };
const ck = (amount: number, billDate: string, kind: 'REFUND' | 'ADVANCE' = 'REFUND', key?: string): Ck =>
  ({ refundAmount: amount, billDate, kind, ckTxnKey: key ?? `${billDate}:${amount}:${kind}` });

const FROM01 = '2026-09-01T00:00:00+07:00', TO02 = '2026-09-02T00:00:00+07:00';
describe('computeRefundReconcileCore — THEO KỲ TAB, per-day theo ngày CK (Admin Demo 1/9 chốt period-bound)', () => {
  // Anh chốt "tab nào ra số đó theo doanh số, chuyển tab phải đổi số; đã hoàn theo ngày CK". CK chặn CẢ 2 biên
  // [fromDayIncl, toDayExcl); per-day daHoan = Σ CK có billDate = ngày đó (KHÔNG subset-sum). Ngày lẻ có thể thừa/thiếu
  // "giả" (hoàn ngày này cho bán ngày khác) — CHẤP NHẬN theo yêu cầu (số dư ròng THẬT xem tab kỳ dài bao trọn).
  it('per-day theo ngày CK: hoàn 01/09 > doanh số 01/09 → THỪA (theo kỳ, chấp nhận)', () => {
    const canByDay = new Map<string, number>([['2026-09-01', 133_000_000]]);
    const cks: Ck[] = [ck(133_000_000, '2026-09-01'), ck(100_000_000, '2026-09-01')];
    const r = computeRefundReconcileCore(canByDay, cks, '2026-09-02', FROM01, TO02, '2026-09-01');
    expect(r.totalCanHoan).toBe(133_000_000);
    expect(r.totalDaHoan).toBe(233_000_000); // Σ 2 CK ngày 01/09
    expect(r.totalThuaThieu).toBe(100_000_000);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].daHoan).toBe(233_000_000);
  });

  it('CHẶN biên DƯỚI (fromDayIncl): CK trước from → LOẠI (khác thiết kế lũy kế cũ)', () => {
    const canByDay = new Map<string, number>([['2026-09-01', 50_000_000]]);
    const cks: Ck[] = [ck(30_000_000, '2026-08-30'), ck(50_000_000, '2026-09-01')]; // 30/08 < from → loại
    const r = computeRefundReconcileCore(canByDay, cks, '2026-09-02', FROM01, TO02, '2026-09-01');
    expect(r.totalDaHoan).toBe(50_000_000); // CHỈ CK 01/09 trong kỳ
    expect(r.totalThuaThieu).toBe(0);
  });

  it('CHẶN biên TRÊN (toDayExcl): CK billDate = ngày kết thúc → LOẠI (nửa mở)', () => {
    const canByDay = new Map<string, number>([['2026-09-01', 50_000_000]]);
    const cks: Ck[] = [ck(50_000_000, '2026-09-02')];
    const r = computeRefundReconcileCore(canByDay, cks, '2026-09-02', FROM01, TO02, '2026-09-01');
    expect(r.totalDaHoan).toBe(0);
    expect(r.totalThuaThieu).toBe(-50_000_000);
  });

  it('TÁCH ứng-trước (ADVANCE) khỏi "đã hoàn" nhưng VẪN vào net', () => {
    const canByDay = new Map<string, number>([['2026-09-01', 30_000_000]]);
    const cks: Ck[] = [ck(20_000_000, '2026-09-01', 'REFUND'), ck(15_000_000, '2026-09-01', 'ADVANCE')];
    const r = computeRefundReconcileCore(canByDay, cks, '2026-09-02', FROM01, TO02, '2026-09-01');
    expect(r.totalDaHoan).toBe(20_000_000);
    expect(r.totalDaUng).toBe(15_000_000);
    expect(r.totalThuaThieu).toBe(5_000_000);
  });

  it('dedup CK trùng ckTxnKey → chỉ tính 1', () => {
    const canByDay = new Map<string, number>([['2026-09-01', 40_000_000]]);
    const cks: Ck[] = [ck(40_000_000, '2026-09-01', 'REFUND', 'K1'), ck(40_000_000, '2026-09-01', 'REFUND', 'K1')];
    const r = computeRefundReconcileCore(canByDay, cks, '2026-09-02', FROM01, TO02, '2026-09-01');
    expect(r.totalDaHoan).toBe(40_000_000);
    expect(r.totalThuaThieu).toBe(0);
  });

  it('[FAIL-SAFE Agent-1] canByDay có ngày NGOÀI cửa sổ (TZ lệch) → CLAMP loại, KHÔNG lệch CK', () => {
    // Mô phỏng TZ máy lệch: canByDay lọt 2 ngày nhưng kỳ chỉ [09-01,09-02). CK cùng 09-01. Trước fix: tCan cộng cả
    // 09-02 → thiếu giả -30tr. Sau fix (clamp canByDay theo cửa sổ): chỉ 09-01 → khớp.
    const canByDay = new Map<string, number>([['2026-09-01', 50_000_000], ['2026-09-02', 30_000_000]]);
    const cks: Ck[] = [ck(50_000_000, '2026-09-01')];
    const r = computeRefundReconcileCore(canByDay, cks, '2026-09-02', FROM01, TO02, '2026-09-01');
    expect(r.totalCanHoan).toBe(50_000_000); // 09-02 bị clamp
    expect(r.totalThuaThieu).toBe(0); // KHÔNG còn thiếu giả -30tr
    expect(r.days.every((d) => d.date >= '2026-09-01' && d.date < '2026-09-02')).toBe(true);
  });

  it('nhiều ngày trong kỳ: mỗi ngày CK riêng, tổng = Σ', () => {
    const canByDay = new Map<string, number>([['2026-08-30', 700_000_000], ['2026-09-01', 133_000_000]]);
    const cks: Ck[] = [ck(675_000_000, '2026-08-30'), ck(234_000_000, '2026-09-01')];
    const r = computeRefundReconcileCore(canByDay, cks, '2026-09-02', '2026-08-30T00:00:00+07:00', TO02, '2026-08-30');
    expect(r.days.find((d) => d.date === '2026-08-30')?.daHoan).toBe(675_000_000);
    expect(r.days.find((d) => d.date === '2026-09-01')?.daHoan).toBe(234_000_000);
    expect(r.totalDaHoan).toBe(909_000_000);
  });
});

// Test extractBillTime (list bill hoàn sắp theo giờ, Admin Demo 1/9) — rút "HH:mm" từ chuỗi OCR thô.
import { extractBillTime } from '../src/ocr-send-service';
describe('extractBillTime — giờ cho list bill hoàn', () => {
  it('có giờ dd/mm/yyyy HH:mm[:ss] → HH:mm', () => {
    expect(extractBillTime('01/09/2026 14:22')).toBe('14:22');
    expect(extractBillTime('01/09/2026 09:05:33')).toBe('09:05');
    expect(extractBillTime('7:30')).toBe('07:30'); // giờ 1 chữ số + phút 2 chữ số → pad giờ
  });
  it('không giờ (chỉ ngày) / rỗng / null → null (xếp lên đầu list)', () => {
    expect(extractBillTime('01/09/2026')).toBeNull();
    expect(extractBillTime('')).toBeNull();
    expect(extractBillTime(null)).toBeNull();
    expect(extractBillTime(undefined)).toBeNull();
  });
  it('giờ không hợp lệ (25:00) → null', () => {
    expect(extractBillTime('01/09/2026 25:00')).toBeNull();
  });
});
