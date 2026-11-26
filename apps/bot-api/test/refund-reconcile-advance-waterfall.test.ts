import { describe, it, expect } from 'vitest';
import { computeRefundReconcileCore } from '../src/ocr-send-service.js';

// [Admin Demo 4/9 "lỗi mù khoản tạm ứng — cấm tái diễn"] KHOÁ CHẶT logic tiền ứng↔hoàn 2 chiều SigMa↔đại lý.
// FIX: đại lý→SigMa (trả về) HẠ "Đã ứng" TRƯỚC (hoàn ứng), dư mới hạ "Đã hoàn" (hoàn thừa). Trước đây rơi mù vào
// "Đã hoàn" → ứng treo giả + hoàn hụt 200tr.
const DAY = '2026-08-31';
const FROM = DAY, TO = '2026-09-01';
type Ck = { refundAmount: number; billDate: string | null; kind: 'REFUND' | 'ADVANCE'; ckTxnKey: string | null };
// 13 bill hoàn THẬT phòng Nguyễn 31/8 = 1.358.705.000 (golden).
const REFUNDS = [267048000, 39430000, 108561000, 98695000, 98635000, 182660000, 118195000, 9867000, 236562000, 29660000, 77476000, 75159000, 16757000];
const refundCks = (): Ck[] => REFUNDS.map((a, i) => ({ refundAmount: a, billDate: DAY, kind: 'REFUND', ckTxnKey: `ref${i}` }));
const CAN = new Map([[DAY, 1358500420]]);
const run = (cks: Ck[]) => computeRefundReconcileCore(CAN, cks, TO, FROM, TO, FROM);

describe('refund reconcile — waterfall ứng↔hoàn (golden Nguyễn 31/8)', () => {
  it('GOLDEN: ứng 200 + đại lý TRẢ 200 + 13 hoàn → Đã ứng 0, Đã hoàn 1.358.705.000, thừa 204.580', () => {
    const cks: Ck[] = [
      { refundAmount: 200000000, billDate: DAY, kind: 'ADVANCE', ckTxnKey: 'adv' },
      ...refundCks(),
      { refundAmount: -200000000, billDate: DAY, kind: 'REFUND', ckTxnKey: 'return' }, // đại lý→SigMa trả ứng
    ];
    const r = run(cks);
    expect(r.totalDaUng).toBe(0);                 // ứng đã được trả → 0 (KHÔNG treo giả)
    expect(r.totalDaHoan).toBe(1358705000);       // hoàn ĐỦ 13 bill (KHÔNG bị trừ oan 200tr)
    expect(r.totalCanHoan).toBe(1358500420);
    expect(r.totalThuaThieu).toBe(204580);        // thừa 204.580
  });

  it('ĐẠI LÝ CHƯA TRẢ ứng → Đã ứng vẫn TREO 200tr (báo rõ, không mù)', () => {
    const cks: Ck[] = [{ refundAmount: 200000000, billDate: DAY, kind: 'ADVANCE', ckTxnKey: 'adv' }, ...refundCks()];
    const r = run(cks);
    expect(r.totalDaUng).toBe(200000000);         // ứng treo — đại lý chưa trả
    expect(r.totalDaHoan).toBe(1358705000);
    expect(r.totalThuaThieu).toBe(200204580);     // (hoàn + ứng) − cần = thừa 200tr (đại lý còn nợ SigMa 200tr ứng)
  });

  it('trả NHIỀU hơn ứng (250 > 200) → ứng 0 + hoàn thừa 50 trừ vào Đã hoàn', () => {
    const cks: Ck[] = [
      { refundAmount: 200000000, billDate: DAY, kind: 'ADVANCE', ckTxnKey: 'adv' }, ...refundCks(),
      { refundAmount: -250000000, billDate: DAY, kind: 'REFUND', ckTxnKey: 'return' },
    ];
    const r = run(cks);
    expect(r.totalDaUng).toBe(0);
    expect(r.totalDaHoan).toBe(1358705000 - 50000000); // dư 50tr hạ đã hoàn
  });

  it('trả ÍT hơn ứng (150 < 200) → ứng còn treo 50, hoàn KHÔNG bị trừ', () => {
    const cks: Ck[] = [
      { refundAmount: 200000000, billDate: DAY, kind: 'ADVANCE', ckTxnKey: 'adv' }, ...refundCks(),
      { refundAmount: -150000000, billDate: DAY, kind: 'REFUND', ckTxnKey: 'return' },
    ];
    const r = run(cks);
    expect(r.totalDaUng).toBe(50000000);          // còn treo 50tr
    expect(r.totalDaHoan).toBe(1358705000);       // hoàn nguyên
  });

  it('KHOÁ 2 — Đã ứng KHÔNG âm + tiền vào/ra cân theo chiều (mọi kịch bản)', () => {
    for (const ret of [0, -50000000, -200000000, -300000000]) {
      const cks: Ck[] = [{ refundAmount: 200000000, billDate: DAY, kind: 'ADVANCE', ckTxnKey: 'adv' }, ...refundCks()];
      if (ret !== 0) cks.push({ refundAmount: ret, billDate: DAY, kind: 'REFUND', ckTxnKey: 'return' });
      const r = run(cks);
      expect(r.totalDaUng).toBeGreaterThanOrEqual(0);
      // net theo chiều = Đã hoàn + Đã ứng
      const advOut = 200000000, refOut = 1358705000, retIn = -ret;
      expect((advOut + refOut) - retIn).toBe(r.totalDaHoan + r.totalDaUng);
    }
  });
});

// [Dọn nợ 11/9 — WATERFALL QUA NGÀY] Ứng ngày 1, đại lý trả ngày 2: trước đây per-day chỉ khớp TRONG-ngày → ngày 1
// treo ứng + ngày 2 "hoàn" ÂM, Σngày ≠ tổng. Nay carry ứng-treo qua ngày + tổng dẫn xuất từ vòng ngày.
describe('refund reconcile — waterfall QUA NGÀY (carry ứng treo)', () => {
  const D1 = '2026-08-30', D2 = '2026-08-31', TO2 = '2026-09-01';
  const run2 = (cks: Ck[], can: Map<string, number>) => computeRefundReconcileCore(can, cks, TO2, D1, TO2, D1);
  const sumDays = (r: ReturnType<typeof run2>) => ({
    ung: r.days.reduce((s, d) => s + d.daUng, 0),
    hoan: r.days.reduce((s, d) => s + d.daHoan, 0),
  });

  it('CHIỀU ĐÚNG: ứng 200 NGÀY 1 → đại lý trả 200 NGÀY 2 ⇒ ứng cuối kỳ 0, hoàn KHÔNG âm, Σngày = tổng', () => {
    const cks: Ck[] = [
      { refundAmount: 200_000_000, billDate: D1, kind: 'ADVANCE', ckTxnKey: 'advD1' },
      { refundAmount: 100_000_000, billDate: D2, kind: 'REFUND', ckTxnKey: 'refD2' },
      { refundAmount: -200_000_000, billDate: D2, kind: 'REFUND', ckTxnKey: 'retD2' }, // trả ứng của NGÀY 1
    ];
    const r = run2(cks, new Map([[D1, 0], [D2, 100_000_000]]));
    expect(r.totalDaUng).toBe(0);                    // ứng ngày 1 ĐÃ được trả ngày 2 (trước fix: treo 200tr)
    expect(r.totalDaHoan).toBe(100_000_000);         // hoàn ngày 2 nguyên vẹn (trước fix: tổng đúng nhưng ngày 2 âm 100tr)
    expect(r.totalHoanUng).toBe(200_000_000);
    const d2 = r.days.find((d) => d.date === D2);
    expect(d2?.daHoan).toBe(100_000_000);            // KHÔNG âm — 200tr trả về hạ carry ứng, không cắn vào hoàn
    expect(d2?.daUng).toBe(-200_000_000);            // biến động ứng treo ngày 2 = trả ứng ngày trước
    const s = sumDays(r);
    expect(s.ung).toBe(r.totalDaUng);                // INVARIANT Σngày = tổng
    expect(s.hoan).toBe(r.totalDaHoan);
  });

  it('CHIỀU SAI (không lạm dụng carry): trả về TRƯỚC khi có ứng → là hoàn-thừa, KHÔNG hạ ứng phát sinh SAU', () => {
    const cks: Ck[] = [
      { refundAmount: -50_000_000, billDate: D1, kind: 'REFUND', ckTxnKey: 'retD1' }, // ngày 1 chưa có ứng nào
      { refundAmount: 80_000_000, billDate: D1, kind: 'REFUND', ckTxnKey: 'refD1' },
      { refundAmount: 200_000_000, billDate: D2, kind: 'ADVANCE', ckTxnKey: 'advD2' },
    ];
    const r = run2(cks, new Map([[D1, 30_000_000], [D2, 0]]));
    expect(r.totalDaUng).toBe(200_000_000);          // ứng ngày 2 vẫn TREO nguyên — tiền trả ngày 1 không "trả trước tương lai"
    expect(r.totalDaHoan).toBe(30_000_000);          // 80 hoàn − 50 hoàn-thừa
    expect(r.totalHoanUng).toBe(0);
    const s = sumDays(r);
    expect(s.ung).toBe(r.totalDaUng);
    expect(s.hoan).toBe(r.totalDaHoan);
  });

  it('trả MỘT PHẦN qua ngày: ứng 200 ngày 1, trả 120 ngày 2 → treo 80, Σngày = tổng', () => {
    const cks: Ck[] = [
      { refundAmount: 200_000_000, billDate: D1, kind: 'ADVANCE', ckTxnKey: 'advD1' },
      { refundAmount: -120_000_000, billDate: D2, kind: 'REFUND', ckTxnKey: 'retD2' },
    ];
    const r = run2(cks, new Map());
    expect(r.totalDaUng).toBe(80_000_000);
    expect(r.totalDaHoan).toBe(0);
    expect(r.totalHoanUng).toBe(120_000_000);
    const s = sumDays(r);
    expect(s.ung).toBe(r.totalDaUng);
    expect(s.hoan).toBe(r.totalDaHoan);
  });
});
