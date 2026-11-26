// Helper THUẦN cho khối "Giá bán thực tế" (SellFeeEditor, TidPage.tsx) — tách RA khỏi component để test được
// mà KHÔNG phải import cả cây renderer (React/lucide/preload) vào env node. Không phụ thuộc DOM/React.

export interface SellFeeEntry {
  cardTypeId: number;
  phiBan: number | null;
}

// anyCustom PHẢI suy từ GIÁ TRỊ đã resolve (phiBan hữu hạn ≠ null), KHÔNG từ MODE (audit 21/8 — fix bug wipe
// override): mode='custom' nhưng Ô TRỐNG → buildSellFeeEntries map ra phiBan:null (GIỐNG HỆT niêm yết). Nếu gate
// gửi tính theo mode, ca này ra anyCustom=true → sendSellFee=true → payload sellFees TOÀN null → server hiểu là
// "xóa mọi override" → WIPE giá bán thực tế đang có. Suy theo giá trị: chỉ khi có ≥1 thẻ thật sự nhập số custom
// hữu hạn mới coi là anyCustom (toàn niêm yết HOẶC custom-nhưng-trống → KHÔNG gửi gì).
export function anySellFeeCustom(entries: SellFeeEntry[]): boolean {
  return entries.some((e) => e.phiBan != null && Number.isFinite(e.phiBan));
}

/** 1 dòng loại thẻ trong bảng "Giá bán thực tế" — chỉ lấy 3 trường cần cho luật nền giá. */
export interface SellFeeRowNen {
  cardTypeId: number;
  phiBanThucTe: number | null;
  phiBanNiemYet: number | null;
}

/**
 * [Admin Demo 15/11] "KHÔNG nhập giá bán thì mặc định là GIÁ NIÊM YẾT; nếu giá bán khác thì để giá ĐÃ SET."
 *
 * VÌ SAO CẦN: trước đây ô trống ⇒ phiBan null ⇒ client KHÔNG gửi gì ⇒ TID giao xong không có giá bán thực tế
 * ⇒ mọi bill của TID đó bị chặn NO_ACTUAL_SELL_FEE (doanh số CẤM mượn giá niêm yết — luật P5). Ca thật:
 * TID 20280817 giao 15/11 mà 0 dòng giá bán.
 *
 * THỨ TỰ ƯU TIÊN: số người dùng vừa nhập → giá ĐÃ SET sẵn trên TID → giá NIÊM YẾT.
 * Thẻ không có cả 3 ⇒ LOẠI khỏi danh sách gửi (không bịa số cho loại thẻ chưa có biểu phí).
 */
export function buildSellFeeEntriesNen(rows: SellFeeRowNen[], daNhap: SellFeeEntry[]): SellFeeEntry[] {
  const ra: SellFeeEntry[] = [];
  for (const r of rows) {
    const nhap = daNhap.find((x) => x.cardTypeId === r.cardTypeId)?.phiBan;
    const gia = nhap != null && Number.isFinite(nhap) ? nhap : (r.phiBanThucTe ?? r.phiBanNiemYet);
    if (gia != null && Number.isFinite(gia)) ra.push({ cardTypeId: r.cardTypeId, phiBan: gia });
  }
  return ra;
}
