// Màu quy chuẩn NGÂN HÀNG (Admin Demo) — dùng CHUNG cho mọi màn (OCR gửi bill + Doanh số) để đồng nhất.
// Chuẩn hoá tên bank (bỏ dấu + hoa + bỏ ký tự lạ) rồi tra màu. Không khớp → null (dùng màu mặc định).
export const BANK_COLORS: Record<string, string> = {
  MB: '#1650a3', // MB — xanh
  MBV: '#d32f2f', // MBV — đỏ
  ANBINH: '#0a3d91', // An Bình (ABBank) — xanh coban đậm
  ABBANK: '#0a3d91',
  ABB: '#0a3d91',   // [8/9] sao kê ghi tắt "ABB" → thiếu khoá này nên trước đây rơi màu xám mặc định
  AB: '#0a3d91',
  VP: '#12923f', // VPBank — xanh lá
  VPBANK: '#12923f',
  VPB: '#12923f',
  // [Admin Demo 17/9 "các tab button tài khoản cho rõ màu riêng biệt theo màu brand của bank"] — bổ sung các bank
  // đang có trong danh bạ TK hoàn để mỗi thẻ TK mang đúng màu nhận diện, nhìn là biết ngân hàng nào.
  BIDV: '#00613d',      // BIDV — xanh lá đậm (logo hoa mai vàng)
  ACB: '#0057a6',       // ACB — xanh dương
  OCB: '#0b7a3b',       // OCB — xanh lá
  TPB: '#5b2d90',       // TPBank — tím
  TPBANK: '#5b2d90',
  VIB: '#0a4da2',       // VIB — xanh dương đậm
  SHB: '#0c4ea2',       // SHB — xanh dương
  VIKKI: '#7b2ff2',     // Vikki (DongA số) — tím
  SCB: '#0a58a6',
  SACOMBANK: '#0a58a6',
  EIB: '#1d4f91',
  EXIMBANK: '#1d4f91',
  HDB: '#c8102e',       // HDBank — đỏ
  BVB: '#0a7b4b',       // Bản Việt
  SHI: '#1f4e9c',       // Shinhan
  SMP: '#f26522',       // SmartPay — cam
  SMARTPAY: '#f26522',
  VCB: '#00703c',       // Vietcombank
  VIETCOMBANK: '#00703c'
};

/** Chuẩn hoá tên bank → khoá tra màu (bỏ dấu, hoa, chỉ giữ chữ-số). */
export function bankKey(bankName: string | null | undefined): string {
  return (bankName ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/** Màu quy chuẩn theo tên bank, hoặc undefined nếu không khớp. */
export function bankColor(bankName: string | null | undefined): string | undefined {
  return BANK_COLORS[bankKey(bankName)];
}

/** So sánh SỐ LÔ (chuỗi) theo số học tăng dần — số đọc-được lên trước, không phải số (rỗng/nội bộ) xuống cuối. */
export function compareLoNumber(a: string | null | undefined, b: string | null | undefined): number {
  const parse = (v: string | null | undefined): number => {
    const t = (v ?? '').trim();
    return /^\d+$/.test(t) ? Number(t) : Number.POSITIVE_INFINITY;
  };
  const na = parse(a), nb = parse(b);
  if (na !== nb) return na - nb;
  return (a ?? '').localeCompare(b ?? '');
}

/** THỨ TỰ CHUẨN dashboard doanh số (Admin Demo 31/8 "cùng TID lần lượt số lô, cùng bank rồi sang bank khác") —
 *  DÙNG CHUNG đại lý + NĐT để đồng nhất: NGÂN HÀNG → TID → SỐ LÔ. TID so numeric (TID là chuỗi số). */
export function compareBankTidLo(
  a: { bankName?: string | null; tid?: string | null; lo?: string | null },
  b: { bankName?: string | null; tid?: string | null; lo?: string | null }
): number {
  const bank = (a.bankName ?? '').localeCompare(b.bankName ?? '', 'vi');
  if (bank !== 0) return bank;
  const tid = (a.tid ?? '').localeCompare(b.tid ?? '', undefined, { numeric: true });
  if (tid !== 0) return tid;
  return compareLoNumber(a.lo, b.lo);
}
