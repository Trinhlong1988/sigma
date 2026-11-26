// ĐẶT TÊN FILE ẢNH BILL SAU KHI OCR (Admin Demo 8/9 — quy tắc mới).
//
// Mục tiêu: SẮP THEO TÊN trong Explorer là ảnh cùng HKD / cùng TID nằm liền nhau và SỐ LÔ TĂNG DẦN → dò bill nhanh.
//   POS: "<TÊN HKD> - <TID> <SỐ LÔ>"      vd  "ABB KHACH HANG 35 M2 - 53550081 0113"
//   CK : "CK - <TÊN NGẮN người chuyển> - <giờ>"   vd  "CK - KETOAN - 10h35"  (KT Demo / ND Demo / KH Demo)
//   QR : "<TÊN HKD> - QR <số giao dịch>"   vd  "HKD DEMO 40 - QR 6251VNIB024PKM8D"
//   Đọc KHÔNG ra: GIỮ NGUYÊN tên gốc + " - thất bại".  Ảnh chưa OCR: không đổi (tầng gọi tự quyết).
//
// SỐ LÔ ĐỆM 0 (4 chữ số): Explorer sắp theo CHUỖI — không đệm thì "10" đứng trước "9", mất đúng cái lợi cần có.
// Module THUẦN (không I/O, không React) để test được.

/** Đệm 0 số lô cho đủ 4 chữ số ("113" → "0113"). Lô không phải số (rỗng/chữ) → giữ nguyên. */
export function loSort(lo: string | null | undefined): string {
  const t = String(lo ?? '').trim();
  return /^\d+$/.test(t) ? t.padStart(4, '0') : t;
}

export interface BillItemForName {
  hkdName?: string | null;
  bill?: { tid?: string | null; agencyName?: string | null; batchNumber?: string | null } | null;
}

/** Tên file bill POS: "<HKD> - <TID> <lô>".
 *  [Admin Demo 8/9] MỖI ẢNH CHỈ 1 LÔ (2 tờ SALE + KẾT TOÁN trong 1 ảnh vẫn là CÙNG lô) → KHÔNG gộp "+" nữa, lấy
 *  đúng 1 lô. Ảnh hiếm hoi có nhiều lô → lấy lô NHỎ NHẤT (đầu dãy) để tên vẫn xác định, không dài lê thê.
 *  KHÔNG có TID nào → null (coi như đọc hụt → tầng gọi gắn đuôi "thất bại"). */
export function posBillFileName(items: BillItemForName[]): string | null {
  const tids = [...new Set(items.map((it) => (it.bill?.tid ?? '').trim()).filter(Boolean))];
  if (!tids.length) return null;
  const hkd = (items.find((it) => it.hkdName)?.hkdName ?? items.find((it) => it.bill?.agencyName)?.bill?.agencyName ?? '').trim();
  const lo = [...new Set(items.map((it) => loSort(it.bill?.batchNumber)).filter(Boolean))].sort()[0] ?? '';
  return `${hkd ? hkd + ' - ' : ''}${tids[0]}${lo ? ' ' + lo : ''}`;
}

/** TÊN NGẮN người chuyển = TỪ CUỐI của họ tên ("KHACH HANG 01" → "KETOAN", "NGUYEN VAN A" → "LONG",
 *  "KHACH HANG 22" → "THU") — đúng cách Admin Demo gọi tên 3 người SigMa. */
export function tenNgan(hoTen: string | null | undefined): string {
  const t = String(hoTen ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const tu = t.split(' ');
  return tu[tu.length - 1];
}

/** Giờ cho tên file: "10:35:07" → "10h35". Không đọc được giờ → ''. */
export function gioTenFile(gio: string | null | undefined): string {
  const m = /^(\d{1,2})[:h](\d{2})/.exec(String(gio ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}h${m[2]}` : '';
}

/** Tên file bill CHUYỂN KHOẢN (Admin Demo 8/9): "CK - <TÊN NGẮN người chuyển> - <SỐ THỨ TỰ>"  vd "CK - KETOAN - 1".
 *  Người chuyển là 1 trong 3 người SigMa (KT Demo / ND Demo / KH Demo) → chỉ cần tên ngắn.
 *  SỐ THỨ TỰ đếm THEO TỪNG NGƯỜI, tính theo THỜI GIAN: bill sớm nhất = 1, kế tiếp +1 → sắp theo tên là đúng
 *  trình tự chuyển tiền trong ngày. Không có cả người chuyển lẫn người nhận → null (coi như đọc hụt). */
export function ckBillFileName(
  t: { senderName?: string | null; receiverName?: string | null; time?: string | null; date?: string | null } | null | undefined,
  stt?: number
): string | null {
  const nguoi = tenNgan(t?.senderName ?? t?.receiverName);
  if (!nguoi) return null;
  return `CK - ${nguoi}${stt && stt > 0 ? ' - ' + stt : ''}`;
}

/** Tên file bill QR bán hàng: tên HKD + số giao dịch (một trong hai thiếu vẫn đặt được). */
export function qrBillFileName(hkdName: string | null | undefined, ref: string | null | undefined): string | null {
  const hkd = (hkdName ?? '').trim();
  const r = (ref ?? '').trim();
  if (!hkd && !r) return null;
  return `${hkd ? hkd + ' - ' : ''}QR ${r}`.trim();
}

/** Tên khi ĐỌC KHÔNG RA: giữ nguyên tên gốc (bỏ phần mở rộng + đuôi "- thất bại" cũ để không cộng dồn) + " - thất bại". */
export function failBillFileName(tenFileGoc: string): string {
  const goc = (tenFileGoc || '').replace(/\.[^.]+$/, '').replace(/\s*-\s*thất bại$/i, '').trim();
  return `${goc} - thất bại`;
}

/** 1 bill CK đã đọc trong phiên quét (để đánh SỐ THỨ TỰ theo giờ). */
export interface CkBillDaDoc {
  idx: number;            // vị trí ảnh trong folder
  nguoi: string;          // TÊN NGẮN người chuyển (KETOAN/LONG/THU…)
  ngay: string | null;    // dd/mm/yyyy trên bill
  gio: string | null;     // HH:mm[:ss] trên bill
}

/** Giây trong ngày từ "HH:mm[:ss]" — không đọc được → null (xếp CUỐI, không cướp số 1 của bill có giờ thật). */
export function giaySoTrongNgay(gio: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(gio ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/**
 * ĐÁNH SỐ bill CK theo yêu cầu Admin Demo: "bill CK đầu tiên CỦA NGƯỜI CHUYỂN trong NGÀY (trong folder) là 1,
 * tiếp theo THEO TIME là n+1".
 * → Nhóm theo (người + ngày), sắp theo GIỜ TRÊN BILL (không phải thứ tự quét — folder có thể không sắp theo giờ),
 *   rồi đánh 1,2,3… Bill KHÔNG đọc được giờ: xếp cuối nhóm (theo thứ tự quét) để không đẩy sai số của bill có giờ.
 * Trả map idx → số thứ tự. THUẦN, test được.
 */
export function danhSoCkTheoGio(ds: CkBillDaDoc[]): Map<number, number> {
  const nhom = new Map<string, CkBillDaDoc[]>();
  for (const b of ds) {
    const key = `${b.nguoi}|${(b.ngay ?? '').trim()}`;
    const arr = nhom.get(key) ?? [];
    arr.push(b);
    nhom.set(key, arr);
  }
  const out = new Map<number, number>();
  for (const arr of nhom.values()) {
    const sapXep = [...arr].sort((a, b) => {
      const ga = giaySoTrongNgay(a.gio), gb = giaySoTrongNgay(b.gio);
      if (ga == null && gb == null) return a.idx - b.idx;
      if (ga == null) return 1;   // thiếu giờ → cuối
      if (gb == null) return -1;
      return ga - gb || a.idx - b.idx;
    });
    sapXep.forEach((b, i) => out.set(b.idx, i + 1));
  }
  return out;
}
