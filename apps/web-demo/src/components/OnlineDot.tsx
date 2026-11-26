// Chấm trạng thái PRESENCE kiểu Zalo — NGUỒN DUY NHẤT dùng chung (item 13 + #22/#22c, 6/8, Admin Demo).
//
// #22c "HẾT nháy": online = XANH nhịp tim (chỉ khi presence-store đã xác nhận ỔN ĐỊNH ~4.5s, xem presence-store.ts
// hysteresis); offline HOẶC unknown (chưa biết / đang nền chập chờn) = chấm XÁM tĩnh (KHÔNG animation, KHÔNG đỏ) —
// kèm PresenceStatusText "Hoạt động X phút trước". BỎ chấm đỏ nháy hẳn (thống nhất online=xanh / offline=xám).
//
// CHỈ dùng cho chấm PRESENCE (KHÔNG dùng cho nhãn phân loại / badge số / chấm nhóm). `color`+`haloRgb` ép cho ca
// đặc biệt còn nhịp tim theo màu (vd away/busy ở PublicProfile theo username, không qua presence-store).
import type { CSSProperties, JSX } from 'react';
import { usePresence, resolveOnlineDotTone } from '../lib/presence-store';

const SUCCESS = '#16a34a';
const SUCCESS_RGB = '22,163,74';
// Xám trung tính cho offline + unknown (chuẩn Zalo, thay chấm đỏ nháy). KHÔNG animation.
const NEUTRAL = '#cbd5e1'; // slate-300

export function OnlineDot({
  online,
  agentId,
  size = 10,
  color,
  haloRgb,
  className = '',
  title
}: {
  /** true = đang hoạt động (xanh), false = ngoại tuyến (xám). Fallback khi presence-store CHƯA có `agentId`
   *  (hoặc không truyền agentId). */
  online: boolean;
  /** (6/8) agentId để đọc presence LIVE (đã qua hysteresis) từ presence-store. Không truyền (AvatarStack/
   *  PublicProfile away-busy) → dùng thẳng prop `online`. */
  agentId?: number;
  /** Đường kính px (mặc định 10). */
  size?: number;
  /** Ép màu chấm (vd trạng thái away/busy) — khi truyền, chấm nhịp tim theo màu này bất kể tone. */
  color?: string;
  /** Màu halo dạng "r,g,b" (mặc định theo trạng thái). */
  haloRgb?: string;
  /** Class THÊM cho định vị/viền (vd 'absolute -bottom-0.5 -right-0.5 border-2 border-white'). */
  className?: string;
  title?: string;
}): JSX.Element {
  // LIVE presence (agentId + store đã biết) THẮNG prop `online`. usePresence luôn được gọi (hook).
  const live = usePresence(agentId);
  const tone = resolveOnlineDotTone(agentId != null, live?.online, online);
  const isOnline = tone === 'online';

  // KHÔNG online (offline HOẶC unknown) và KHÔNG ép `color` → chấm XÁM tĩnh (không nháy), kiểu Zalo. Offline hiện
  // "X phút trước" ở PresenceStatusText; chấm chỉ để phân biệt trực quan, không cần đỏ/animation.
  if (!isOnline && color == null) {
    return (
      <span
        className={`rounded-full ${className}`}
        style={{ width: size, height: size, backgroundColor: NEUTRAL }}
        title={title}
        aria-hidden="true"
      />
    );
  }

  // online (hoặc `color` ép) → nhịp tim theo màu.
  const solid = color ?? SUCCESS;
  const rgb = haloRgb ?? SUCCESS_RGB;
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: solid,
    // Biến CSS cho keyframe onlinePulse (styles.css) — quầng halo theo đúng màu chấm.
    ['--online-dot-halo' as string]: `rgba(${rgb},0.55)`,
    ['--online-dot-halo-0' as string]: `rgba(${rgb},0)`
  };
  return <span className={`online-dot ${className}`} style={style} title={title} aria-hidden="true" />;
}
