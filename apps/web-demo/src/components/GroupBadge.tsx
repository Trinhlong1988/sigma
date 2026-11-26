// Mini huy hiệu NHÓM (6/8, Admin Demo "nếu là group thêm mini icon group vào bên trái giống chấm trạng thái") —
// đặt Ở ĐÚNG VỊ TRÍ/KÍCH THƯỚC OnlineDot (góc dưới-trái avatar, border-2 border-white) để danh sách chat NHẤT
// QUÁN: mỗi item luôn có 1 badge góc dưới-trái — DIRECT = OnlineDot xanh/đỏ (presence), GROUP = GroupBadge này
// (nhóm KHÔNG có presence). Vòng tròn nền TRẮNG + glyph `Users` màu brand.
import { Users } from 'lucide-react';
import type { JSX } from 'react';

export function GroupBadge({
  size = 16,
  className = '',
  title = 'Nhóm'
}: {
  /** Đường kính px (mặc định 16 — khớp footprint OnlineDot 12px + viền 2px). */
  size?: number;
  /** Class THÊM cho định vị/viền (vd 'absolute -bottom-0.5 -left-0.5 border-2 border-white'). */
  className?: string;
  title?: string;
}): JSX.Element {
  return (
    <span
      className={`flex items-center justify-center rounded-full bg-white text-brand ${className}`}
      style={{ width: size, height: size }}
      title={title}
      aria-hidden="true"
    >
      <Users style={{ width: size * 0.62, height: size * 0.62 }} strokeWidth={2.5} />
    </span>
  );
}
