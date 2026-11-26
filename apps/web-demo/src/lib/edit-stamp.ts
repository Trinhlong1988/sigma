// [Admin Demo 2/9 "log nhỏ trạng thái đã sửa ngay dưới thông số sửa"] Lõi theo-dõi-giờ-sửa từng trường cho card review
// OCR (POS + CK). Tách khỏi OcrSendScreen để TEST HÀM THẬT (R198), không test bản sao.

/** Giờ HH:mm hiện tại (local) — dấu mốc "đã sửa lúc". */
export function nowHHMM(): string { const d = new Date(); const p = (n: number): string => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; }

/** Diff giờ-sửa (key theo TÊN TRƯỜNG): field đổi khác giá trị OCR-gốc → dấu mốc giờ; quay về gốc → xoá dấu.
 *  edits[fieldName] = "HH:mm" → UI hiện log nhỏ NGAY DƯỚI trường đó. `now` tách tham số để test tất định. */
export function stampEdits(
  cur: Record<string, string>,
  prev: Record<string, string>,
  orig: Record<string, string>,
  edits: Record<string, string>,
  now: string = nowHHMM()
): { next: Record<string, string>; changed: boolean } {
  let changed = false; const next = { ...edits };
  for (const k of Object.keys(cur)) {
    if (cur[k] === prev[k]) continue;
    if (cur[k] !== (orig[k] ?? '')) { next[k] = now; changed = true; }
    else if (next[k]) { delete next[k]; changed = true; }
  }
  return { next, changed };
}
