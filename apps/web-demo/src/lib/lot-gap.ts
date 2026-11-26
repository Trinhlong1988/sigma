// [Admin Demo 2/9 "pos thiếu 1 lô bị nhảy cóc cũng không cảnh báo — rất nghiêm trọng, cấm tái diễn"] DÒ LÔ NHẢY SỐ.
// Lô POS của 1 TID tăng dần liên tục (…93,94,95…). KHUYẾT số giữa dãy = nghi SÓT bill (ảnh không có trong folder /
// OCR lỗi / bị nuốt câm). Sự cố thật 30/8: KHACH HANG 62 3 (TID DEMO-TID-07) có lô 93 rồi 95,96,97,98,99 — KHUYẾT 94, không
// ai báo. Bộ dò này bắt đúng ca đó. THUẦN (không React/DB) → test HÀNH VI khoá cứng (R198).
export interface LotGap { tid: string; hkdName?: string | null; missing: number[]; seen: number[] }

/** Parse số lô từ chuỗi batchNumber ('093' → 93; '?'/rỗng/'amt:...' → null). Bỏ số 0 đầu, chỉ nhận toàn chữ số. */
export function parseLotNumber(batch: string | null | undefined): number | null {
  if (batch == null) return null;
  const s = String(batch).trim();
  if (!s || s === '?' || s.startsWith('amt:')) return null;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Dò khuyết trong dãy lô MỖI TID. Điều kiện xét: ≥2 lô phân biệt + biên độ (max−min) ≤ maxSpan (tránh dương-tính-giả
 *  khi lô cách xa do gộp nhiều ngày / reset máy). Trả TID có lô khuyết + danh sách số lô thiếu (để cảnh báo + kiểm tay).
 *  KHÔNG tự suy tiền lô thiếu (cấm suy luận tiền) — chỉ báo "thiếu lô X, kiểm tay". */
export function detectLotGaps(
  lotsByTid: Map<string, { lots: number[]; hkdName?: string | null }>,
  opts: { maxSpan?: number } = {}
): LotGap[] {
  const maxSpan = opts.maxSpan ?? 40;
  const out: LotGap[] = [];
  for (const [tid, info] of lotsByTid) {
    const uniq = [...new Set(info.lots.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
    if (uniq.length < 2) continue;
    const lo = uniq[0], hi = uniq[uniq.length - 1];
    if (hi - lo > maxSpan) continue;
    const set = new Set(uniq);
    const missing: number[] = [];
    for (let n = lo + 1; n < hi; n++) if (!set.has(n)) missing.push(n);
    if (missing.length) out.push({ tid, hkdName: info.hkdName ?? null, missing, seen: uniq });
  }
  return out;
}

/** [Admin Demo 4/9] Parse ngày-giờ bill "dd/mm/yyyy hh:mm(:ss)" (giờ+giây tuỳ chọn) → mốc so sánh (epoch ms, cùng hệ giờ). null
 *  nếu không parse. Dùng để dò "lô tăng nhưng ngày lùi". */
export function parseBillDateMs(dateTime: string | null | undefined): number | null {
  if (!dateTime) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(dateTime).trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0);
  return Number.isFinite(t) ? t : null;
}

export interface LotDateBackward { tid: string; hkdName?: string | null; lot: number; date: string; prevLot: number; prevDate: string }
/** [Admin Demo 4/9 "số lô to hơn mà ngày lùi mà không có gate?"] BẤT BIẾN: lô POS là bộ đếm TĂNG theo thời gian → lô lớn
 *  hơn PHẢI có ngày/giờ ≥ lô nhỏ hơn (cùng TID). Vi phạm (lô↑ nhưng ngày LÙI) = trạng thái BẤT KHẢ THI → nghi OCR/máy
 *  đọc SAI NGÀY (vd lô 68 đọc 01/09 trong khi lô 67,69 = 04/09). Trả vi phạm để CỜ ĐỎ + kiểm tay. KHÔNG tự sửa (tiền). */
export function detectLotDateBackward(
  byTid: Map<string, { entries: { lot: number; dateMs: number; dateStr: string }[]; hkdName?: string | null }>
): LotDateBackward[] {
  const out: LotDateBackward[] = [];
  for (const [tid, info] of byTid) {
    const sorted = info.entries.filter((e) => Number.isFinite(e.lot) && Number.isFinite(e.dateMs)).sort((a, b) => a.lot - b.lot);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      if (cur.lot > prev.lot && cur.dateMs < prev.dateMs) {
        out.push({ tid, hkdName: info.hkdName ?? null, lot: cur.lot, date: cur.dateStr, prevLot: prev.lot, prevDate: prev.dateStr });
      }
    }
  }
  return out;
}

/** Gom (tid → số lô) từ danh sách bill đã đọc để feed detectLotGaps. Bỏ bill thiếu tid/lô (không đóng góp dãy). */
export function collectLotsByTid(
  bills: { tid: string | null | undefined; batchNumber: string | null | undefined; hkdName?: string | null }[]
): Map<string, { lots: number[]; hkdName?: string | null }> {
  const m = new Map<string, { lots: number[]; hkdName?: string | null }>();
  for (const b of bills) {
    const tid = (b.tid ?? '').trim();
    const lot = parseLotNumber(b.batchNumber);
    if (!tid || lot == null) continue;
    const e = m.get(tid) ?? { lots: [], hkdName: b.hkdName ?? null };
    e.lots.push(lot);
    if (!e.hkdName && b.hkdName) e.hkdName = b.hkdName;
    m.set(tid, e);
  }
  return m;
}
