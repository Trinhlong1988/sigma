// CỔNG QA ĐỐI SOÁT DOANH SỐ (Admin Demo 27/8 "QA đâu, chống sai tái diễn") — biến LỖ THỦNG doanh số thành CỜ ĐỎ
// HIỆN RÕ thay vì sai âm thầm (gốc "tái diễn": pipeline ghi mù, mỗi lần phải Admin Demo nhìn mắt mới bắt). Hàm THUẦN,
// test được: nhận doanh số vision-gộp-theo-lô (aggregateLotRevenue) + doanh số DB hiện có → sinh cờ đối soát.
//
// Nguyên tắc R196: hệ KHÔNG cần đọc đúng 100% mới dùng — chỉ cần MỌI chỗ chưa chắc đều HIỆN CỜ để người kiểm.
import type { LotRevenue } from './lot-revenue.js';

/** Doanh số DB hiện có theo TID (từ bảng transactions POSTED trong ngày). */
export interface DbTidRevenue {
  tid: string;
  amount: number; // tổng gross (trước phí) đã ghi
  count: number; // số GD
}

export type ReconcileSeverity = 'red' | 'yellow';
export interface ReconcileFlag {
  tid: string;
  severity: ReconcileSeverity;
  kind: 'MISSING' | 'GAP' | 'DB_EXTRA';
  visionAmount: number;
  dbAmount: number;
  message: string;
}

export interface ReconcileReport {
  flags: ReconcileFlag[];
  visionTotal: number;
  dbTotal: number;
  /** Tỉ lệ khớp = min(vision,db)/max(vision,db) tổng — chỉ số nhanh (1.0 = trùng khít). */
  matchRatio: number;
  /** Số lô cờ needsRecheck (settlement lệch Σ bill lẻ — nghi OCR nhầm digit). */
  recheckLots: number;
  /** Số lô THIẾU bill kết toán (chỉ có bill lẻ — rủi ro recall). */
  lotsWithoutSettlement: number;
  /** Số ảnh OCR thất bại (timeout/lỗi — caller đếm, KHÔNG nuốt câm R198). */
  failedImages: number;
  /** XANH khi: KHÔNG cờ đỏ + KHÔNG ảnh OCR thất bại. Cổng gate ship/tin số dùng cờ này. */
  ok: boolean;
}

export interface ReconcileOptions {
  /** Ngưỡng lệch tương đối coi là GAP (mặc định 0.15 = 15%). */
  gapThreshold?: number;
  /** Số ảnh OCR thất bại (readBillVision trả failed:true) — caller truyền vào. */
  failedImages?: number;
}

/** So doanh số vision (gộp lô) với DB hiện có → cờ đối soát. TID chuẩn hoá đã làm ở caller (normalizeTid). */
export function reconcileDayRevenue(lots: LotRevenue[], db: DbTidRevenue[], opts: ReconcileOptions = {}): ReconcileReport {
  const gapThreshold = opts.gapThreshold ?? 0.15;
  const failedImages = opts.failedImages ?? 0;

  const visionByTid = new Map<string, number>();
  for (const l of lots) visionByTid.set(l.tid, (visionByTid.get(l.tid) ?? 0) + l.amount);
  const dbByTid = new Map<string, number>();
  for (const d of db) dbByTid.set(d.tid, (dbByTid.get(d.tid) ?? 0) + d.amount);

  const flags: ReconcileFlag[] = [];
  const tids = new Set<string>([...visionByTid.keys(), ...dbByTid.keys()]);
  for (const tid of [...tids].sort()) {
    const v = visionByTid.get(tid) ?? 0;
    const d = dbByTid.get(tid) ?? 0;
    if (v > 0 && d === 0) {
      flags.push({ tid, severity: 'red', kind: 'MISSING', visionAmount: v, dbAmount: d, message: `TID ${tid}: có ${fmt(v)} doanh số qua bill nhưng DB 0đ — MẤT HẲN, kiểm ngay.` });
    } else if (d > 0 && v === 0) {
      flags.push({ tid, severity: 'yellow', kind: 'DB_EXTRA', visionAmount: v, dbAmount: d, message: `TID ${tid}: DB có ${fmt(d)} nhưng bill không đọc ra — kiểm nguồn GD (nhập tay?/ảnh thiếu).` });
    } else if (v > 0 && d > 0) {
      const rel = Math.abs(v - d) / Math.max(v, d);
      if (rel > gapThreshold) {
        flags.push({ tid, severity: 'yellow', kind: 'GAP', visionAmount: v, dbAmount: d, message: `TID ${tid}: lệch ${(rel * 100).toFixed(0)}% (bill ${fmt(v)} vs DB ${fmt(d)}) — đối soát.` });
      }
    }
  }

  const visionTotal = [...visionByTid.values()].reduce((s, a) => s + a, 0);
  const dbTotal = [...dbByTid.values()].reduce((s, a) => s + a, 0);
  const matchRatio = Math.max(visionTotal, dbTotal) === 0 ? 1 : Math.min(visionTotal, dbTotal) / Math.max(visionTotal, dbTotal);
  const recheckLots = lots.filter((l) => l.needsRecheck).length;
  const lotsWithoutSettlement = lots.filter((l) => !l.hasSettlement).length;
  const ok = !flags.some((f) => f.severity === 'red') && failedImages === 0;

  return { flags, visionTotal, dbTotal, matchRatio, recheckLots, lotsWithoutSettlement, failedImages, ok };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('vi-VN') + 'đ';
}
