// FCM-ping-on-view (6/8, Admin Demo chuẩn Zalo) — khi mình MỞ XEM 1 người (Danh bạ mount / mở phòng DIRECT), gọi
// `POST /v1/presence/check {agentIds}` để server PING (FCM đánh thức) máy người kia → nếu còn reachable thì họ
// báo online lại → server phát `presence-update` → chấm/nhãn của mình chuyển online gần real-time.
//
// THROTTLE phía client: KHÔNG gọi lại cùng agentId trong ~30s (dedupe) + GỘP nhiều id vào 1 request. Best-effort
// tuyệt đối — lỗi mạng/route chưa có → nuốt im (chỉ là "đánh thức", KHÔNG ảnh hưởng hiển thị presence hiện có).
import { proxyFetch } from './proxy-fetch';

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

export const PRESENCE_CHECK_THROTTLE_MS = 30_000;

/** THUẦN — lọc agentId ĐẾN HẠN kiểm tra: bỏ trùng trong cùng lô + bỏ id đã ping trong `throttleMs` gần đây (theo
 * `lastCheckedAt`). KHÔNG mutate map (caller tự ghi mốc cho các id trả về). Tách để test tất định. */
export function pickDuePresenceCheckIds(
  agentIds: Iterable<number>,
  lastCheckedAt: Map<number, number>,
  now: number,
  throttleMs: number = PRESENCE_CHECK_THROTTLE_MS
): number[] {
  const seen = new Set<number>();
  const due: number[] = [];
  for (const id of agentIds) {
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    const t = lastCheckedAt.get(id);
    if (t === undefined || now - t >= throttleMs) due.push(id);
  }
  return due;
}

const lastCheckedAt = new Map<number, number>();

/** Yêu cầu server ping (đánh thức) các agentId — throttle 30s/id, gộp 1 request. No-op nếu không có id đến hạn. */
export function requestPresenceCheck(agentIds: Iterable<number>, now: number = Date.now()): void {
  const due = pickDuePresenceCheckIds(agentIds, lastCheckedAt, now);
  if (due.length === 0) return;
  for (const id of due) lastCheckedAt.set(id, now);
  void proxyFetch(`${botApiBaseUrl()}/v1/presence/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentIds: due })
  }).catch(() => {
    // best-effort — chỉ là ping đánh thức, KHÔNG chặn/không hiện lỗi (presence hiện có vẫn giữ nguyên).
  });
}

/** Test hook — reset throttle map để test cách ly. */
export function __resetPresenceCheckThrottleForTest(): void {
  lastCheckedAt.clear();
}
