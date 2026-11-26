// CA TIỀN VỀ theo NGÂN HÀNG (Admin Demo — mốc giờ CHÍNH CHỦ cung cấp, phiên 5/9 + đính chính MBV):
//   MB  (MBB): ca 1 = 00:00–09:40 · ca 2 = 09:41–16:40 · ca 3 = 16:41–23:59
//   ABB      : ca 1 = 00:00–09:50 · ca 2 = 09:51–14:50 · ca 3 = 14:51–23:59
//   MBV      : ca 1 = 00:00–11:50 · ca 2 = 11:51–17:50 · ca 3 = 17:51–23:59
// Ca xác định theo GIỜ TỔNG KẾT BILL (giờ HCM in trên bill). Bank ngoài bảng → null (không xếp ca, lọc ca bỏ qua).
// Module THUẦN — CẤM suy luận thêm mốc; đổi mốc phải sửa đúng 1 chỗ này (kèm chỉ đạo Admin Demo).

export type CaTien = 1 | 2 | 3;

/** Mốc PHÚT-trong-ngày kết thúc ca 1 và ca 2 (phút thứ N kể từ 00:00, inclusive). */
const MOC_CA: Record<string, [number, number]> = {
  MB: [9 * 60 + 40, 16 * 60 + 40],
  MBB: [9 * 60 + 40, 16 * 60 + 40], // cùng biểu MB
  ABB: [9 * 60 + 50, 14 * 60 + 50],
  MBV: [11 * 60 + 50, 17 * 60 + 50]
};

/** Chuẩn hoá mã bank về khoá bảng mốc ("MB Bank"/"mbb…" → MB). Không khớp → null. */
export function khoaBankCa(bank: string | null | undefined): string | null {
  const b = (bank ?? '').trim().toUpperCase();
  if (!b) return null;
  if (b === 'MBV' || b.startsWith('MBV')) return 'MBV';
  // [B-L1 21/9 — bug THẬT soi banks.name prod] Bank ABB trong DB tên "AB Bank" (không phải "ABB") → trước đây
  // không khớp prefix 'ABB' → trả null → LỌC CA loại CÂM toàn bộ bill AB Bank (Σ 3 ca thiếu đúng phần ABB).
  // Nhận cả "AB BANK"/"AB " + biến thể "MBBANK"/"MB BANK" (viết liền). Vẫn CẤM đoán bank lạ (ngoài bảng → null).
  if (b === 'ABB' || b.startsWith('ABB') || b === 'AB BANK' || b.startsWith('AB ')) return 'ABB';
  if (b === 'MB' || b === 'MBB' || b.startsWith('MB ') || b === 'MBBANK') return 'MB';
  return null;
}

/**
 * KHOÁ TRA CA từ 1 bản ghi ngân hàng: thử MÃ trước, mã không ra khoá thì thử TÊN.
 *
 * Vì sao cần cả hai (đo thật 16/11, không suy luận):
 *  - SỔ THẬT: `banks.code` = MB/MBV/ABB tra được; `banks.name` là tên pháp nhân
 *    ("NH TMCP Quân đội MB") ⇒ `khoaBankCa(name)` trả **null cho cả ba** ⇒ lọc ca loại sạch giao dịch.
 *  - DỮ LIỆU KHÁC (bản ghi cũ / bộ dựng test): mã là chuỗi sinh tự động vô nghĩa còn TÊN mới mang dấu hiệu
 *    ngân hàng ("MBV …", "AB Bank") ⇒ chỉ đọc mã là mất ca.
 * Chỉ nhận khoá khi THẬT SỰ khớp bảng mốc — vẫn CẤM gán ca bừa cho bank ngoài bảng.
 */
export function khoaBankCaTu(code: string | null | undefined, name: string | null | undefined): string | null {
  return khoaBankCa(code) ?? khoaBankCa(name);
}

/** Ca của 1 bill theo bank + phút-trong-ngày (giờ HCM). Bank ngoài bảng → null. */
export function caCuaPhut(bank: string | null | undefined, phutTrongNgay: number): CaTien | null {
  const k = khoaBankCa(bank);
  if (!k || !Number.isFinite(phutTrongNgay) || phutTrongNgay < 0 || phutTrongNgay > 1439) return null;
  const [c1, c2] = MOC_CA[k];
  return phutTrongNgay <= c1 ? 1 : phutTrongNgay <= c2 ? 2 : 3;
}

/** Ca của 1 bill theo bank + chuỗi giờ "HH:MM"/"HH:MM:SS" (giờ HCM). Không đọc được giờ → null. */
export function caCuaGio(bank: string | null | undefined, gio: string | null | undefined): CaTien | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)/.exec((gio ?? '').trim());
  if (!m) return null;
  return caCuaPhut(bank, Number(m[1]) * 60 + Number(m[2]));
}

/** Ca của 1 instant (Date/ISO) — quy về giờ HCM (UTC+7) tường minh, không phụ thuộc TZ tiến trình. */
export function caCuaInstant(bank: string | null | undefined, at: Date | string | null | undefined): CaTien | null {
  const d = at instanceof Date ? at : at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const hcm = new Date(d.getTime() + 7 * 3600_000);
  return caCuaPhut(bank, hcm.getUTCHours() * 60 + hcm.getUTCMinutes());
}
