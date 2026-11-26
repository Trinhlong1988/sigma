// LỐI TẮT TỪ DÒNG LOG (Admin Demo 8/9): "log cảnh báo → click vào là sửa được bill đó ngay, hoặc mở đúng lô trong
// báo cáo". Không thêm cấu trúc dữ liệu mới: đọc thẳng từ CHUỖI log vốn đã có "Bill 7/32" và "(TID 53550071)".
// Module THUẦN để test được.

/** Số bill trong dòng log ("Bill 7/32" → idx 6, 0-based). Không có → null. */
export function docSoBill(s: string): number | null {
  const m = /Bill\s+(\d+)\s*\/\s*\d+/.exec(String(s ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n - 1 : null;
}

/** TID (+ số lô nếu có) trong dòng log sót lô: "… (TID 53550071): THIẾU lô 66, 67 …". */
export function docTidLo(s: string): { tid: string; lo?: string } | null {
  const t = /TID\s+(\d{6,})/.exec(String(s ?? ''));
  if (!t) return null;
  const l = /(?:THIẾU lô|lô)\s+(\d+)/.exec(String(s ?? ''));
  return l ? { tid: t[1], lo: l[1] } : { tid: t[1] };
}

/** Dòng log có phải CẢNH BÁO cần xử (đỏ) — dùng để bật lối tắt + đánh dấu "chờ sửa". */
export function laCanhBao(s: string): boolean {
  return /THIẾU lô|NGHI SÓT|LỆCH ĐẾM|CHƯA ra bill|NGÀY LÙI|lô sau mà ngày trước|NHẢY VỌT|GÁN NHẦM|🔴/.test(String(s ?? ''));
}
