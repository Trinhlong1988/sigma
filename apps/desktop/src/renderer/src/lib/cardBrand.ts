// NHẬN DIỆN THƯƠNG HIỆU THẺ (Admin Demo 24/11 — BỔ SUNG 5: logo đứng trước tên loại thẻ).
//
// LƯU Ý BẢN QUYỀN: file này KHÔNG tái tạo logo thương hiệu gốc (Visa/Mastercard/JCB/Napas là nhãn hiệu
// đăng ký). Thay vào đó mỗi loại cho 1 HUY HIỆU ORIGINAL: ô bo góc màu đặc trưng + CHỮ VIẾT TẮT, dựng
// bằng SVG NHÚNG inline (CSP Electron chặn URL ngoài). Đủ để mắt phân biệt nhanh khi chọn, không vi phạm.
//
// Nguồn loại thẻ THẬT trong DB sigma (SELECT card_types 24/11, 11 tên phân biệt):
//   Visa(VS) · VISA, MASTER(code "VISA, MASTER") · Master(MT) · JCB(JCB) · Napas(NP) · Ngoài Napas(N-NP)
//   · MB(MB) · Ngoài MB(N-MB) · VP(VP) · Ngoài VP(N-VP) · Sacombank(SCB)
// Có huy hiệu riêng: visa, master, jcb, napas. Các loại nội bộ/bank (MB, VP, Sacombank, "Ngoài …") KHÔNG
// phải thương hiệu thẻ quốc tế → dùng huy hiệu CHUNG (icon thẻ) + chữ viết tắt (xem brandFallbackInitials).

export type CardBrandId = 'visa' | 'master' | 'jcb' | 'napas';

export interface CardBrandMeta {
  id: CardBrandId;
  nhan: string; // nhãn hiển thị
  initials: string; // chữ trên huy hiệu
  bg: string; // màu nền huy hiệu (hex)
  fg: string; // màu chữ (hex)
}

export const CARD_BRANDS: Record<CardBrandId, CardBrandMeta> = {
  visa: { id: 'visa', nhan: 'Visa', initials: 'VISA', bg: '#1a1f71', fg: '#ffffff' },
  master: { id: 'master', nhan: 'Mastercard', initials: 'MC', bg: '#cc5500', fg: '#ffffff' },
  jcb: { id: 'jcb', nhan: 'JCB', initials: 'JCB', bg: '#0b4ea2', fg: '#ffffff' },
  napas: { id: 'napas', nhan: 'Napas', initials: 'NP', bg: '#005bac', fg: '#ffffff' }
};

/**
 * Suy ra (các) thương hiệu thẻ từ TÊN + MÃ loại thẻ. Trả MẢNG vì có loại gộp "VISA, MASTER" → [visa, master].
 * Không khớp thương hiệu quốc tế nào → [] (dùng huy hiệu chung).
 */
export function brandOfCardType(name: string | null | undefined, code?: string | null): CardBrandId[] {
  const s = ((name ?? '') + ' ' + (code ?? '')).toLowerCase();
  const out: CardBrandId[] = [];
  if (s.includes('visa') || /\bvs\b/.test(s)) out.push('visa');
  if (s.includes('master') || /\bmt\b/.test(s) || /\bmc\b/.test(s)) out.push('master');
  if (s.includes('jcb')) out.push('jcb');
  if (s.includes('napas')) out.push('napas'); // bao gồm "Ngoài Napas"
  return out;
}

/** Chữ viết tắt cho loại thẻ KHÔNG có thương hiệu quốc tế (MB, VP, Sacombank, "Ngoài …"). */
export function brandFallbackInitials(name: string | null | undefined): string {
  const t = (name ?? '').trim();
  if (!t) return '?';
  // Lấy tối đa 3 ký tự chữ/số đầu của từ CÓ NGHĨA (bỏ "Ngoài").
  const chinh = t.replace(/^ngoài\s+/i, '').trim() || t;
  const chu = chinh.replace(/[^A-Za-zÀ-ỹ0-9]/g, '');
  return chu.slice(0, 3).toUpperCase() || '?';
}
