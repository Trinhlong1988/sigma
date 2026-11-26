// PRESENCE STORE dùng chung (6/8, Admin Demo "chấm online + 'Hoạt động X phút trước' chuẩn Zalo, HẾT nháy") —
// Map `agentId→{online,lastSeenAt}` (trạng thái HIỂN THỊ đã ổn định) + pub-sub nhỏ. Nguồn cập nhật:
//   - SEED từ dữ liệu đã tải (`online`+`lastSeenAt` listChatRooms DIRECT / friends).
//   - LIVE: server broadcast `{msg:'presence-update', agentId, online, lastSeenAt|at}` qua WS → chat-realtime.ts
//     parse rồi setPresence().
//
// #22c (6/8) — CHỐNG NHÁY bằng HYSTERESIS phía client (APK chạy nền: Android suspend WebView → WS rớt/reconnect
// lặp → presence online↔offline chớp nhoáng → chấm nháy). QUY TẮC:
//   - online → offline: đổi hiển thị NGAY (ổn định về "vắng"/xám).
//   - offline/unknown → online: CHỈ chuyển XANH nếu giữ online ỔN ĐỊNH `ONLINE_STABLE_MS` (~4.5s). Trong cửa sổ
//     đó lại offline → HỦY (không nháy xanh). Blip <4.5s KHÔNG bao giờ hiện xanh.
//   - `lastSeenAt` LUÔN cập nhật NGAY (kể cả khi chưa chuyển xanh) để "X phút trước" tính đúng (#4).
// Hiển thị kiểu Zalo (OnlineDot): online = xanh nhịp tim (ổn định); offline/unknown = XÁM tĩnh (không đỏ, không
// nháy) + PresenceStatusText "Hoạt động X phút trước".
import { useSyncExternalStore } from 'react';

export interface PresenceState {
  online: boolean;
  /** ISO thời điểm hoạt động cuối (offline mới cần để hiện "X phút trước"); null = không rõ. */
  lastSeenAt: string | null;
}

/** Cửa sổ giữ-online-ổn-định trước khi hiện XANH (chống nháy khi WS reconnect chớp nhoáng ở APK chạy nền). */
export const ONLINE_STABLE_MS = 4500;

// display = trạng thái ĐÃ ỔN ĐỊNH mà UI đọc (usePresence). Vắng key = 'unknown' (OnlineDot ra xám-neutral).
const display = new Map<number, PresenceState>();
// raw = tín hiệu THÔ mới nhất (trước hysteresis) — để timer kiểm "còn online không" lúc đáo hạn + giữ lastSeen tươi.
const rawOnline = new Map<number, boolean>();
const rawLastSeen = new Map<number, string | null>();
// timer chờ xác nhận online ổn định, theo agentId.
const pendingOnline = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function clearPending(agentId: number): void {
  const t = pendingOnline.get(agentId);
  if (t !== undefined) {
    clearTimeout(t);
    pendingOnline.delete(agentId);
  }
}

/** Áp 1 tín hiệu presence (từ setPresence LIVE hoặc seed) qua HYSTERESIS. Emit khi trạng thái HIỂN THỊ đổi. */
function applyPresence(agentId: number, online: boolean, lastSeenAt: string | null): void {
  rawOnline.set(agentId, online);
  if (lastSeenAt != null) rawLastSeen.set(agentId, lastSeenAt);
  const cur = display.get(agentId);

  if (!online) {
    // OFFLINE NGAY (ổn định về xám) + cập nhật lastSeen.
    clearPending(agentId);
    const nextLastSeen = lastSeenAt ?? cur?.lastSeenAt ?? rawLastSeen.get(agentId) ?? null;
    if (!cur || cur.online !== false || cur.lastSeenAt !== nextLastSeen) {
      display.set(agentId, { online: false, lastSeenAt: nextLastSeen });
      emit();
    }
    return;
  }

  // online === true
  if (cur?.online === true) {
    // đã XANH → giữ, chỉ cập nhật lastSeen nếu đổi. Không cần timer.
    clearPending(agentId);
    const nextLastSeen = lastSeenAt ?? cur.lastSeenAt;
    if (cur.lastSeenAt !== nextLastSeen) {
      display.set(agentId, { online: true, lastSeenAt: nextLastSeen });
      emit();
    }
    return;
  }

  // online nhưng CHƯA xanh (đang offline hoặc unknown):
  //  - nếu đang offline → GIỮ xám nhưng cập nhật lastSeen mới (X phút trước tươi). Unknown → GIỮ unknown (không set
  //    offline giả → OnlineDot vẫn xám-neutral).
  if (cur && cur.online === false && lastSeenAt != null && cur.lastSeenAt !== lastSeenAt) {
    display.set(agentId, { online: false, lastSeenAt });
    emit();
  }
  //  - hẹn giờ xác nhận ỔN ĐỊNH (không reset nếu đã có timer → tính từ lần online ĐẦU của chuỗi).
  if (!pendingOnline.has(agentId)) {
    const t = setTimeout(() => {
      pendingOnline.delete(agentId);
      if (rawOnline.get(agentId) === true) {
        const seen = rawLastSeen.get(agentId) ?? display.get(agentId)?.lastSeenAt ?? null;
        display.set(agentId, { online: true, lastSeenAt: seen });
        emit();
      }
    }, ONLINE_STABLE_MS);
    pendingOnline.set(agentId, t);
  }
}

export function subscribePresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Trạng thái presence HIỂN THỊ (đã ổn định) của 1 agent, hoặc `undefined` = CHƯA biết → OnlineDot xám-neutral.
 * Trả CHÍNH object trong store (reference ổn định) để useSyncExternalStore không lặp render vô hạn. */
export function getPresence(agentId: number): PresenceState | undefined {
  return display.get(agentId);
}

/** LIVE presence-update (chat-realtime.ts) — qua hysteresis (online cần ổn định ~4.5s; offline ngay). lastSeen luôn
 * cập nhật tươi. */
export function setPresence(agentId: number, online: boolean, lastSeenAt: string | null = null): void {
  applyPresence(agentId, online, lastSeenAt);
}

/** SEED nhiều agent từ dữ liệu server đã tải (qua CÙNG hysteresis — online cũng cần ổn định để hiện xanh, tránh
 * nháy). Entry `[agentId, online, lastSeenAt?]` — bỏ qua `online` null/undefined.
 * #22b `opts.trustOffline`: `false` (nguồn CACHE có thể stale) → CHỈ áp `online=true`, BỎ QUA `online=false` (không
 * assert offline từ cache cũ). `true` (mặc định, FRESH server) → áp cả offline. */
export function seedPresence(
  entries: Iterable<readonly [number, boolean | null | undefined, (string | null | undefined)?]>,
  opts: { trustOffline?: boolean } = {}
): void {
  const trustOffline = opts.trustOffline !== false;
  for (const [agentId, online, lastSeenAt] of entries) {
    if (online == null) continue;
    if (online === false && !trustOffline) continue;
    applyPresence(agentId, online, lastSeenAt ?? null);
  }
}

export interface PresenceUpdate {
  agentId: number;
  online: boolean;
  /** ISO thời điểm hoạt động cuối; null nếu thiếu. */
  lastSeenAt: string | null;
}

/** Parse THUẦN payload `presence-update` từ WS (fail-safe: shape lạ → null). Đọc `lastSeenAt` (server mới) —
 * fallback `at` (payload cũ). Tách riêng để test KHÔNG cần WebSocket thật. */
export function parsePresenceUpdate(data: Record<string, unknown>): PresenceUpdate | null {
  if (typeof data.agentId !== 'number' || !Number.isFinite(data.agentId)) return null;
  if (typeof data.online !== 'boolean') return null;
  const lastSeenAt =
    typeof data.lastSeenAt === 'string' ? data.lastSeenAt : typeof data.at === 'string' ? data.at : null;
  return { agentId: data.agentId, online: data.online, lastSeenAt };
}

/** Hook đọc presence HIỂN THỊ (đã ổn định) của 1 agent. Re-render khi agent đó đổi. `agentId` null/undefined →
 * luôn `undefined` (vẫn gọi useSyncExternalStore mọi lần — không lỗi rule-of-hooks). */
export function usePresence(agentId: number | null | undefined): PresenceState | undefined {
  const getSnapshot = (): PresenceState | undefined => (agentId != null ? display.get(agentId) : undefined);
  return useSyncExternalStore(subscribePresence, getSnapshot, getSnapshot);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Nhãn trạng thái kiểu Zalo (THUẦN, `now` inject để test):
 *   online → "Đang hoạt động"
 *   offline + lastSeenAt: <60s "Vừa truy cập" / <60m "X phút trước" / <24h "X giờ trước" / <7 ngày "X ngày trước"
 *     / còn lại "dd/mm"
 *   offline + KHÔNG lastSeenAt (hoặc iso hỏng) → "Ngoại tuyến"
 * Mốc tương lai (lệch đồng hồ) → "Vừa truy cập". */
export function formatLastSeen(online: boolean, lastSeenAt: string | null | undefined, now: number = Date.now()): string {
  if (online) return 'Đang hoạt động';
  if (!lastSeenAt) return 'Ngoại tuyến';
  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return 'Ngoại tuyến';
  const diff = now - seen;
  if (diff < MINUTE_MS) return 'Vừa truy cập';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} phút trước`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} giờ trước`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} ngày trước`;
  const d = new Date(seen);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

/** Sắc thái chấm presence (#22): 'online' (xanh) / 'offline' (xám kiểu Zalo, KHÔNG đỏ) / 'unknown' (xám, chưa
 * biết). agent-tracked mà store CHƯA biết → 'unknown'. Không agentId → theo prop `online`. Hàm THUẦN. */
export function resolveOnlineDotTone(
  hasAgentId: boolean,
  live: boolean | undefined,
  onlineProp: boolean
): 'online' | 'offline' | 'unknown' {
  if (hasAgentId) {
    if (live === undefined) return 'unknown';
    return live ? 'online' : 'offline';
  }
  return onlineProp ? 'online' : 'offline';
}

/** Test hook (KHÔNG dùng trong sản phẩm) — reset toàn bộ state + huỷ timer. */
export function __resetPresenceStoreForTest(): void {
  for (const t of pendingOnline.values()) clearTimeout(t);
  pendingOnline.clear();
  display.clear();
  rawOnline.clear();
  rawLastSeen.clear();
  listeners.clear();
}
