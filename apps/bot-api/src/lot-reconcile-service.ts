// [Admin Demo 2/9 "xây dựng phương án chống tái diễn TRIỆT ĐỂ với lọt bill tương tự"] LƯỚI AN TOÀN CUỐI, ĐỘC LẬP MỌI
// ĐƯỜNG NẠP: đối soát DÃY LÔ trên dữ liệu ĐÃ GHI (bảng `los`) theo TỪNG TID + TỪNG NGÀY. Bill vào từ nhiều đường
// (app folder-scan · watcher auto-ingest · recovery) → check ở tầng UI chỉ chạy khi có người quét. Check NÀY chạy
// trên DB nên bắt lô nhảy dù lọt ở bất kỳ đâu (vd lô 94 KHACH HANG 62 3 30/8: los có 93,95..99 → báo thiếu 94).
// THUẦN phần tính toán (parse + detect) để test hành vi (R198); phần query DB tách riêng.
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface LotTimeBackward { lot: number; time: string | null; prevLot: number; prevTime: string | null }
export interface LotGapRow {
  tid: string; hkdName: string | null; day: string;
  missing: number[];            // lô KHUYẾT trong CỤM CHÍNH (nghi SÓT bill)
  suspectMisread: number[];     // [Admin Demo 7/9] lô LẠC ngoài cụm chính (nghi OCR đọc SAI số lô — vd 1010/182) — kiểm tay
  timeBackward: LotTimeBackward[]; // [Admin Demo 7/9] cùng ngày lô↑ mà GIỜ↓ (nghi đọc sai giờ)
  seen: number[]; seenCount: number; sparse: boolean;
}

/** Rút SỐ LÔ từ bill_key. Các dạng: 'nat|tid|lô|hđ' · 'VL|tid|lô|ngày[|amt:X]' · 'V|tid|lô|tiền|iso'. Lô ở SEGMENT index 2.
 *  'amt:...'/'?'/rỗng/không-toàn-số → null (không phải lô đánh số → không xét dãy). '093'→93. */
export function parseLotFromBillKey(billKey: string | null | undefined): number | null {
  if (!billKey) return null;
  const parts = String(billKey).split('|');
  if (parts.length < 3) return null;
  const seg = (parts[2] ?? '').trim();
  if (!seg || seg === '?' || seg.startsWith('amt:') || !/^\d+$/.test(seg)) return null;
  const n = Number(seg);
  return Number.isFinite(n) ? n : null;
}

/** Dò khuyết dãy lô theo (tid, ngày). rows = mỗi GD đã ghi {tid, hkdName, day 'YYYY-MM-DD', lot, time?}.
 *  [Admin Demo 7/9 — vá "misread che sót"] TÁCH CỤM thay vì bỏ-cả-ngày khi biên rộng: 1 bill OCR đọc SAI số lô (vd 1010,
 *  182) làm biên min→max phình to → code cũ (hi-lo>maxSpan → continue) BỎ QUA cả ngày → CHE luôn lô sót THẬT. Nay:
 *  chia dãy thành các CỤM liền (khoảng cách ≤ clusterMaxGap), lấy CỤM CHÍNH (đông nhất) để dò khuyết; lô ngoài cụm
 *  chính = `suspectMisread` (nghi đọc sai lô, liệt riêng, kiểm tay). Cùng ngày lô↑ mà giờ↓ = `timeBackward` (sai giờ).
 *  ≥2 lô/ngày mới xét. THUẦN → test được. */
export function detectLotGapsFromRows(
  rows: { tid: string; hkdName: string | null; day: string; lot: number | null; time?: string | null }[],
  opts: { clusterMaxGap?: number } = {}
): LotGapRow[] {
  const clusterMaxGap = opts.clusterMaxGap ?? 60; // ≤60: giữ dãy thưa hợp lệ (vd 61→94) 1 cụm; >60 (vd 104→182, 144→1010) = tách.
  const byKey = new Map<string, { tid: string; hkdName: string | null; day: string; recs: { lot: number; time: string | null }[] }>();
  for (const r of rows) {
    if (r.lot == null || !Number.isFinite(r.lot)) continue;
    const k = `${r.tid}|${r.day}`;
    const e = byKey.get(k) ?? { tid: r.tid, hkdName: r.hkdName, day: r.day, recs: [] };
    e.recs.push({ lot: r.lot, time: r.time ?? null });
    if (!e.hkdName && r.hkdName) e.hkdName = r.hkdName;
    byKey.set(k, e);
  }
  const out: LotGapRow[] = [];
  for (const e of byKey.values()) {
    // 1 lô có thể xuất hiện nhiều dòng (đa-thẻ) → gộp giờ SỚM NHẤT cho lô đó.
    const timeByLot = new Map<number, string | null>();
    for (const rec of e.recs) {
      const cur = timeByLot.get(rec.lot);
      if (!timeByLot.has(rec.lot)) timeByLot.set(rec.lot, rec.time);
      else if (rec.time && (!cur || rec.time < cur)) timeByLot.set(rec.lot, rec.time);
    }
    const uniq = [...timeByLot.keys()].sort((a, b) => a - b);
    if (uniq.length < 2) continue;
    // Chia CỤM: cắt khi khoảng cách 2 lô liền kề > clusterMaxGap.
    const clusters: number[][] = [[uniq[0]]];
    for (let i = 1; i < uniq.length; i++) {
      if (uniq[i] - uniq[i - 1] <= clusterMaxGap) clusters[clusters.length - 1].push(uniq[i]);
      else clusters.push([uniq[i]]);
    }
    // CỤM CHÍNH = đông nhất (hoà → biên rộng hơn). Lô ngoài cụm chính = nghi đọc sai.
    const main = clusters.reduce((best, c) =>
      c.length > best.length || (c.length === best.length && (c[c.length - 1] - c[0]) > (best[best.length - 1] - best[0])) ? c : best, clusters[0]);
    const mainSet = new Set(main);
    const suspectMisread = uniq.filter((n) => !mainSet.has(n));
    const lo = main[0], hi = main[main.length - 1];
    const missing: number[] = [];
    for (let n = lo + 1; n < hi; n++) if (!mainSet.has(n)) missing.push(n);
    // timeBackward: trong CỤM CHÍNH, lô lớn hơn mà GIỜ nhỏ hơn (cùng ngày → không lo reset máy).
    const timeBackward: LotTimeBackward[] = [];
    for (let i = 1; i < main.length; i++) {
      const pl = main[i - 1], cl = main[i], pt = timeByLot.get(pl) ?? null, ct = timeByLot.get(cl) ?? null;
      if (pt && ct && ct < pt) timeBackward.push({ lot: cl, time: ct, prevLot: pl, prevTime: pt });
    }
    // Chỉ báo hàng khi CÓ vấn đề: khuyết, hoặc lô-nghi-sai (chỉ khi cụm chính là dãy THẬT ≥3 để tránh cờ [1,500]), hoặc giờ lùi.
    const reportSuspect = suspectMisread.length > 0 && main.length >= 3;
    if (missing.length > 0 || reportSuspect || timeBackward.length > 0) {
      const span = hi - lo + 1;
      const sparse = main.length / span < 0.5 || missing.length > main.length;
      out.push({ tid: e.tid, hkdName: e.hkdName, day: e.day, missing, suspectMisread, timeBackward, seen: uniq, seenCount: uniq.length, sparse });
    }
  }
  // Sắp: ngày mới nhất trước, rồi TID.
  out.sort((a, b) => (a.day === b.day ? a.tid.localeCompare(b.tid) : b.day.localeCompare(a.day)));
  return out;
}

/** ĐỐI SOÁT LÔ trên DB `los` trong khoảng [from, to] (theo ngày ghi = COALESCE(bill_txn_date, created_at), múi giờ VN).
 *  Trả danh sách (tid, ngày) có lô nhảy số. CHỈ ĐỌC (SELECT) — không đụng tiền. status<>'CANCELLED'. */
export async function findLotGaps(db: Db, opts: { from: Date; to: Date }): Promise<LotGapRow[]> {
  // Ngày local VN từ timestamptz: dùng AT TIME ZONE 'Asia/Ho_Chi_Minh' để không lệch ngày bill khuya.
  // [Admin Demo 7/9 FIX false-gap] TID lấy TỪ billKey (segment 2), KHÔNG từ transaction.tid_id. Lý do: sau khi CHUYỂN
  // máy/ sửa TID, billKey + lo_rows (nguồn báo cáo) đổi tid nhưng transaction.tid_id có thể CHƯA sync (bị gate chặn) →
  // findLotGaps cũ (join transaction) thấy lô ở TID CŨ → báo TID mới THIẾU lô ĐÃ CÓ (vd lô 138 chuyển sang DEMO-TID-07
  // vẫn báo thiếu). Dùng billKey tid = ĐỒNG NHẤT với parseLotFromBillKey + report. Join tids theo chuỗi tid cho hkd_name.
  const recs = await db.$queryRawUnsafe<{ tid: string; hkd_name: string | null; bill_key: string | null; day: string; hm: string | null }[]>(
    `SELECT split_part(l.bill_key, '|', 2) AS tid, td.hkd_name AS hkd_name, l.bill_key AS bill_key,
            to_char((COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day,
            CASE WHEN l.bill_txn_date IS NOT NULL
                 THEN to_char(l.bill_txn_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') ELSE NULL END AS hm
     FROM los l
     LEFT JOIN tids td ON td.tid = split_part(l.bill_key, '|', 2)
     WHERE l.status <> 'CANCELLED'
       AND l.bill_key LIKE 'nat|%'
       AND COALESCE(l.bill_txn_date, l.created_at) >= $1
       AND COALESCE(l.bill_txn_date, l.created_at) < $2`,
    opts.from, opts.to
  );
  const rows = recs.map((r) => ({ tid: r.tid, hkdName: r.hkd_name, day: r.day, lot: parseLotFromBillKey(r.bill_key), time: r.hm }));
  return detectLotGapsFromRows(rows);
}
