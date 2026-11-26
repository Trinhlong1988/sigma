// BỘ ICON BRAND CHUNG (Admin Demo 1/9 "xây bộ icon brand chung cho mọi tab/menu/tính năng, tự động+thủ công"): map
// NHÃN trường → icon lucide + màu brand nhất quán. Dùng cho card bill POS/CK, review OCR, và mọi nơi hiển thị tham
// số. 1 nguồn duy nhất → đổi icon/màu 1 chỗ áp toàn hệ thống. Bank icon lấy MÀU BRAND ngân hàng (bank-visual.ts).
import type { LucideIcon } from 'lucide-react';
import { Banknote, Clock, Landmark, Store, Package, CreditCard, Percent, Wallet, UserRound, Users, FileText, Hash, ArrowLeftRight } from 'lucide-react';
import { bankColor } from './bank-visual';

export interface FieldIconInfo { Icon: LucideIcon; className: string; }

/** Nhãn trường (tiếng Việt) → icon + màu. Khớp theo THỨ TỰ ưu tiên (cụ thể trước, chung sau) để "Phải hoàn"/"Phí bán"
 *  không rơi nhầm vào "tiền". Trả null nếu nhãn không thuộc bộ chuẩn (KHÔNG vẽ icon lạ). */
export function fieldIcon(label: string): FieldIconInfo | null {
  const l = (label || '').toLowerCase().trim();
  // Hoàn tiền / phải hoàn / tiền về (kết quả tiền cuối) — ví tiền, xanh lá đậm.
  if (l.includes('hoàn') || l.includes('tiền về') || l.includes('về')) return { Icon: Wallet, className: 'text-emerald-600' };
  if (l.includes('phí')) return { Icon: Percent, className: 'text-amber-500' };
  if (l.includes('số tiền') || l === 'tiền' || l.includes('tiền')) return { Icon: Banknote, className: 'text-emerald-500' };
  if (l.includes('ngân hàng') || l.includes('bank')) return { Icon: Landmark, className: 'text-brand' }; // màu ghi đè theo bank ở dưới
  if (l.includes('ngày') || l.includes('giờ')) return { Icon: Clock, className: 'text-sky-500' };
  if (l === 'tid' || l.includes('mã máy')) return { Icon: CreditCard, className: 'text-indigo-500' };
  if (l.includes('khách') || l.includes('hkd') || l.includes('pos') || l.includes('cửa hàng')) return { Icon: Store, className: 'text-brand' };
  if (l.includes('lô')) return { Icon: Package, className: 'text-violet-500' };
  if (l.includes('đối tác')) return { Icon: Users, className: 'text-teal-600' };
  if (l.includes('người gửi') || l.includes('người nhận') || l.includes('gửi') || l.includes('nhận')) return { Icon: UserRound, className: 'text-teal-500' };
  if (l.includes('mã gd') || l.includes('mã') || l.includes('ref')) return { Icon: Hash, className: 'text-slate-400' };
  if (l.includes('nội dung') || l.includes('memo') || l.includes('phân loại')) return { Icon: FileText, className: 'text-slate-400' };
  if (l.includes('chuyển') || l.includes('hướng')) return { Icon: ArrowLeftRight, className: 'text-brand' };
  return null;
}

/** Icon đứng trước NHÃN trường. `bank` (tên NH) → tô MÀU BRAND ngân hàng cho icon Landmark (MB xanh, MBV đỏ...). */
export function FieldIcon({ label, bank, className }: { label: string; bank?: string | null; className?: string }): JSX.Element | null {
  const info = fieldIcon(label);
  if (!info) return null;
  const { Icon } = info;
  const isBank = /ngân hàng|bank/i.test(label);
  const brandHex = isBank ? bankColor(bank ?? undefined) : undefined;
  return <Icon className={(className ?? 'h-3 w-3') + ' shrink-0 ' + (brandHex ? '' : info.className)} style={brandHex ? { color: brandHex } : undefined} aria-hidden />;
}
