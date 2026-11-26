// [Agent-4 phản biện 11/9 — KHOÁ BIÊN waterfall QUA NGÀY] Đổi 11/9 "fold theo thứ tự ngày với CARRY ứng-treo"
// (computeRefundReconcileCore) là logic TIỀN mới nhưng suite hiện có chỉ test cùng-ngày. Khoá các biên:
//  (1) ứng ngày 1, đại lý trả ngày 2 → carry hạ ứng ngày trước, Σdays == totals (cân sổ cấu trúc);
//  (2) đại lý trả TRƯỚC ngày ứng (bill OCR lệch ngày) → characterization: phần trả rơi "hoàn-thừa-về" (daHoan âm),
//      ứng sau vẫn treo — NET cả kỳ vẫn đúng 0 (không mất tiền, chỉ phân loại theo thứ tự thời gian);
//  (3) trả rải nhiều ngày < ứng → ứng treo giảm dần, không ngày nào âm ứng-treo.
import { describe, it, expect } from 'vitest';
import { computeRefundReconcileCore } from '../src/ocr-send-service.js';

type Ck = { refundAmount: number; billDate: string | null; kind: 'REFUND' | 'ADVANCE'; ckTxnKey: string | null };
const FROM = '2026-09-01', TO = '2026-09-05';
const run = (cks: Ck[], can = new Map<string, number>()) => computeRefundReconcileCore(can, cks, TO, FROM, TO, FROM);

describe('computeRefundReconcileCore — waterfall carry QUA NGÀY', () => {
  it('(1) ứng 200tr ngày 01, đại lý trả 200tr ngày 02 → ứng cuối kỳ 0, ngày 02 daUng = −200tr (trả ứng ngày trước), Σdays == totals', () => {
    const r = run([
      { refundAmount: 200_000_000, billDate: '2026-09-01', kind: 'ADVANCE', ckTxnKey: 'adv1' },
      { refundAmount: -200_000_000, billDate: '2026-09-02', kind: 'REFUND', ckTxnKey: 'ret1' }
    ]);
    expect(r.totalDaUng).toBe(0);
    expect(r.totalUngGoc).toBe(200_000_000);
    expect(r.totalHoanUng).toBe(200_000_000);
    expect(r.totalDaHoan).toBe(0); // trả ứng, KHÔNG phải hoàn-thừa → không trừ oan "Đã hoàn"
    const d1 = r.days.find((d) => d.date === '2026-09-01')!;
    const d2 = r.days.find((d) => d.date === '2026-09-02')!;
    expect(d1.daUng).toBe(200_000_000);
    expect(d2.daUng).toBe(-200_000_000);
    expect(r.days.reduce((s, d) => s + d.daUng, 0)).toBe(r.totalDaUng); // cân sổ Σngày = tổng
    expect(r.days.reduce((s, d) => s + d.daHoan, 0)).toBe(r.totalDaHoan);
  });

  it('(2) trả 100tr ngày 01 TRƯỚC, ứng 100tr ngày 02 SAU → characterization: NET kỳ = 0, ứng treo 100tr + hoàn −100tr, vẫn cân sổ', () => {
    const r = run([
      { refundAmount: -100_000_000, billDate: '2026-09-01', kind: 'REFUND', ckTxnKey: 'ret2' },
      { refundAmount: 100_000_000, billDate: '2026-09-02', kind: 'ADVANCE', ckTxnKey: 'adv2' }
    ]);
    // waterfall chỉ nhìn QUÁ KHỨ: tiền trả ngày 01 chưa có ứng treo → thành hoàn-thừa-về (daHoan âm); ứng 02 treo.
    expect(r.totalDaUng).toBe(100_000_000);
    expect(r.totalDaHoan).toBe(-100_000_000);
    expect(r.totalThuaThieu).toBe(0); // NET (hoàn + ứng) − cần = 0 — KHÔNG mất tiền cả kỳ
    expect(r.days.reduce((s, d) => s + d.daUng, 0)).toBe(r.totalDaUng);
    expect(r.days.reduce((s, d) => s + d.daHoan, 0)).toBe(r.totalDaHoan);
  });

  it('(3) ứng 300tr ngày 01, trả 100tr×3 ngày 02/03/04 → ứng cuối kỳ 0, mỗi ngày hạ 100tr, hoàn không âm', () => {
    const r = run([
      { refundAmount: 300_000_000, billDate: '2026-09-01', kind: 'ADVANCE', ckTxnKey: 'adv3' },
      { refundAmount: -100_000_000, billDate: '2026-09-02', kind: 'REFUND', ckTxnKey: 'r1' },
      { refundAmount: -100_000_000, billDate: '2026-09-03', kind: 'REFUND', ckTxnKey: 'r2' },
      { refundAmount: -100_000_000, billDate: '2026-09-04', kind: 'REFUND', ckTxnKey: 'r3' }
    ]);
    expect(r.totalDaUng).toBe(0);
    expect(r.totalHoanUng).toBe(300_000_000);
    expect(r.totalDaHoan).toBe(0);
    for (const d of r.days.filter((x) => x.date >= '2026-09-02')) expect(d.daUng).toBe(-100_000_000);
  });
});
