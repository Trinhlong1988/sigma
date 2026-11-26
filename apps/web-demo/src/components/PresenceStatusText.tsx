// Dòng trạng thái presence kiểu Zalo (6/8) — "Đang hoạt động" / "Vừa truy cập" / "X phút trước" / … / "Ngoại
// tuyến". Đọc presence LIVE từ presence-store theo `agentId` (usePresence) → tự đổi khi có presence-update; nếu
// store CHƯA biết agent đó → fallback `online`/`lastSeenAt` server tải kèm (props). Màu: online = xanh (success),
// offline = xám. Dùng ở ContactsScreen (dưới tên), ConversationScreen header (dưới tên đối phương DIRECT), …
import type { JSX } from 'react';
import { usePresence, formatLastSeen } from '../lib/presence-store';

export function PresenceStatusText({
  agentId,
  online,
  lastSeenAt,
  className = 'text-[11px]'
}: {
  /** agentId để đọc presence LIVE (bắt buộc để real-time). */
  agentId: number;
  /** Fallback online server tải kèm (khi store chưa có agent này). */
  online: boolean | null;
  /** Fallback lastSeenAt server tải kèm. */
  lastSeenAt?: string | null;
  /** Class cỡ chữ (mặc định 11px) — màu do component tự đặt theo trạng thái. */
  className?: string;
}): JSX.Element {
  const live = usePresence(agentId);
  const on = live !== undefined ? live.online : online ?? false;
  const seen = live !== undefined ? live.lastSeenAt : lastSeenAt ?? null;
  return <span className={`${className} ${on ? 'text-success' : 'text-slate-400'}`}>{formatLastSeen(on, seen)}</span>;
}
