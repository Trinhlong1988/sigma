// HUY HIỆU LOẠI THẺ (Admin Demo 24/11 — BỔ SUNG 5). Dựng bằng SVG NHÚNG inline (CSP Electron chặn URL ngoài).
// KHÔNG tái tạo logo thương hiệu gốc: mỗi loại = ô bo góc màu đặc trưng + CHỮ VIẾT TẮT (huy hiệu original),
// đủ để mắt phân biệt nhanh khi chọn loại thẻ. Logic suy thương hiệu ở lib/cardBrand.ts (có unit test).
import { CreditCard } from 'lucide-react';
import { brandOfCardType, brandFallbackInitials, CARD_BRANDS, type CardBrandId } from '../lib/cardBrand.js';

function OneBadge({ brand }: { brand: CardBrandId }): JSX.Element {
  const m = CARD_BRANDS[brand];
  return (
    <span
      title={m.nhan}
      className="inline-flex h-[18px] min-w-[30px] items-center justify-center rounded px-1 text-[9px] font-extrabold leading-none tracking-wide shadow-sm"
      style={{ backgroundColor: m.bg, color: m.fg }}
    >
      {m.initials}
    </span>
  );
}

/** Huy hiệu đứng TRƯỚC tên loại thẻ. Loại gộp ("VISA, MASTER") hiện 2 huy hiệu; loại nội bộ/bank hiện ô chữ viết tắt. */
export function CardBrandBadge({ name, code }: { name: string | null | undefined; code?: string | null }): JSX.Element {
  const brands = brandOfCardType(name, code);
  if (brands.length === 0) {
    const kt = brandFallbackInitials(name);
    return (
      <span
        title={name ?? ''}
        className="inline-flex h-[18px] min-w-[30px] items-center justify-center gap-0.5 rounded border border-slate-300 bg-slate-100 px-1 text-[9px] font-bold leading-none text-slate-600 shadow-sm"
      >
        <CreditCard className="h-2.5 w-2.5 shrink-0 text-slate-400" />
        {kt}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {brands.map((b) => (
        <OneBadge key={b} brand={b} />
      ))}
    </span>
  );
}
