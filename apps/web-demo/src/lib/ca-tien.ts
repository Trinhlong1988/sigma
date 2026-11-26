// CA TIỀN VỀ theo NGÂN HÀNG — MIRROR THỦ CÔNG của packages/services/src/ca-tien.ts (mốc CHÍNH CHỦ Admin Demo,
// phiên 5/9 + đính chính MBV). Đổi mốc phải đổi CẢ 2 file. Dùng cho lọc ca ở màn báo cáo lô (client-side).
//   MB/MBB: ca 1 ≤ 09:40 · ca 2 ≤ 16:40 · ca 3 sau đó
//   ABB   : ca 1 ≤ 09:50 · ca 2 ≤ 14:50 · ca 3 sau đó
//   MBV   : ca 1 ≤ 11:50 · ca 2 ≤ 17:50 · ca 3 sau đó
// Ca xác định theo GIỜ TỔNG KẾT BILL (giờ HCM). Bank ngoài bảng → null (không xếp ca — lọc ca loại ra, không đoán).
export type CaTien = 1 | 2 | 3;

const MOC_CA: Record<string, [number, number]> = {
  MB: [9 * 60 + 40, 16 * 60 + 40],
  MBB: [9 * 60 + 40, 16 * 60 + 40],
  ABB: [9 * 60 + 50, 14 * 60 + 50],
  MBV: [11 * 60 + 50, 17 * 60 + 50]
};

export function khoaBankCa(bank: string | null | undefined): string | null {
  const b = (bank ?? '').trim().toUpperCase();
  if (!b) return null;
  if (b === 'MBV' || b.startsWith('MBV')) return 'MBV';
  if (b === 'ABB' || b.startsWith('ABB')) return 'ABB';
  if (b === 'MB' || b === 'MBB' || b.startsWith('MB ')) return 'MB';
  return null;
}

export function caCuaPhut(bank: string | null | undefined, phutTrongNgay: number): CaTien | null {
  const k = khoaBankCa(bank);
  if (!k || !Number.isFinite(phutTrongNgay) || phutTrongNgay < 0 || phutTrongNgay > 1439) return null;
  const [c1, c2] = MOC_CA[k];
  return phutTrongNgay <= c1 ? 1 : phutTrongNgay <= c2 ? 2 : 3;
}

/** Ca theo bank + chuỗi giờ "HH:MM"/"HH:MM:SS" (giờ HCM). Không đọc được giờ → null. */
export function caCuaGio(bank: string | null | undefined, gio: string | null | undefined): CaTien | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)/.exec((gio ?? '').trim());
  if (!m) return null;
  return caCuaPhut(bank, Number(m[1]) * 60 + Number(m[2]));
}
