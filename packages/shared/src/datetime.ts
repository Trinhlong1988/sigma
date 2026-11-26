// Chuẩn hiển thị ngày/giờ toàn hệ thống (R_DATE_FORMAT, LEAD lock 9/7).
// Ngày = dd/mm/yyyy (dd, mm đủ 2 chữ số). Giờ = HH:mm:ss. Tách 2 cột Ngày | Giờ ở bảng.
// CẤM dùng toLocaleString tự do — mọi nơi hiển thị thời gian phải qua các hàm này.

const p2 = (n: number): string => String(n).padStart(2, '0');

// [B300 24/11 — agent Excel đo thật] Sổ ghi GIỜ VN — hiển thị/xuất file phải theo GIỜ VN, không theo
// đồng hồ MÁY NGƯỜI XEM: bill 23:30 VN mở trên máy múi giờ Tokyo (hoặc Windows đặt sai giờ) in sang
// NGÀY HÔM SAU cả trên màn lẫn trong Excel. Lấy các thành phần qua Intl với timeZone cố định.
const VN_TZ = 'Asia/Ho_Chi_Minh';
const vnParts = (d: Date): { y: number; mo: number; da: number; h: number; mi: number; se: number } => {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: VN_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const m: Record<string, string> = {};
  for (const pt of f.formatToParts(d)) m[pt.type] = pt.value;
  return { y: Number(m['year']), mo: Number(m['month']), da: Number(m['day']), h: Number(m['hour']) % 24, mi: Number(m['minute']), se: Number(m['second']) };
};

/**
 * Chuẩn hóa input → Date hợp lệ, hoặc null nếu sai. Chỉ chấp nhận Date/number/string;
 * loại thẳng boolean/symbol/function/object/array (tránh new Date(true)=1970, new Date(Symbol) throw).
 */
function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** dd/mm/yyyy — ví dụ 05/01/2026. Input sai → chuỗi rỗng (không crash). */
export function fmtDate(v: Date | string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return '';
  const t = vnParts(d); // [B300] theo giờ VN, không theo máy người xem
  return `${p2(t.da)}/${p2(t.mo)}/${t.y}`;
}

/** HH:mm — ví dụ 15:02 (cột Giờ mặc định, LEAD lock 9/7). Input sai → chuỗi rỗng. */
export function fmtTime(v: Date | string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return '';
  const t = vnParts(d); // [B300]
  return `${p2(t.h)}:${p2(t.mi)}`;
}

/** HH:mm:ss — chỉ dùng nơi cần chính xác giây (VD lịch sử thiết bị). Input sai → chuỗi rỗng. */
export function fmtTimeSec(v: Date | string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return '';
  const t = vnParts(d); // [B300]
  return `${p2(t.h)}:${p2(t.mi)}:${p2(t.se)}`;
}

/** dd/mm/yyyy HH:mm (khi cần 1 ô gộp). Input sai → chuỗi rỗng. */
export function fmtDateTime(v: Date | string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return '';
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

/** Cho bảng tách 2 cột: { date, time }. Input sai → { date:'', time:'' }. */
export function splitDateTime(v: Date | string | number | null | undefined): { date: string; time: string } {
  return { date: fmtDate(v), time: fmtTime(v) };
}
