// SIGMA PRESENCE client heartbeat (6/8, Admin Demo: online real-time kiểu Zalo/PC — "còn đăng nhập + thiết bị
// còn kết nối được") — DÙNG CHUNG cho cả 3 nền (web/exe/apk, cùng nguồn web-demo). Nhiệm vụ:
//   1. Gửi "nhịp sống" `POST /v1/presence/ping` định kỳ (~15s, xem PRESENCE_PING_INTERVAL_MS) khi CÒN MẠNG →
//      server giữ nhịp tươi cho ca thiết-bị-còn-mạng-nhưng-không-giữ-WS-thường-trực (chủ yếu APK nền); nguồn
//      presence CHÍNH vẫn là WS (chat-realtime.ts + hub server), nhịp REST là nguồn phụ cửa sổ 40s phía server.
//   2. Lắng `window 'offline'` (mất mạng) → gọi `POST /v1/presence/offline` NGAY (nếu còn kịp gửi) + DỪNG ping
//      → server phát presence-offline realtime cho người liên quan (0 độ trễ, đúng yêu cầu Admin Demo).
//   3. `window 'online'` (có mạng lại) → ping NGAY + tiếp tục vòng lặp.
//   4. `visibilitychange` → khi tab hiển thị lại → ping NGAY (bắt kịp nếu timer nền bị OS bóp).
//
// NGUYÊN TẮC "app chạy nền / bị clear khỏi recents mà mạng còn = VẪN ONLINE": KHÔNG gửi /offline chỉ vì tab ẩn
// (document hidden) — chỉ gửi khi MẤT MẠNG thật ('offline') hoặc đăng xuất (App.tsx cleanup gọi sendPresenceOffline).
// Việc giữ-online khi nền do KẾT NỐI WS sống + FCM-ping (native) lo, KHÔNG do lib này quyết định offline khi ẩn.
//
// Best-effort tuyệt đối — mọi POST nuốt lỗi (mất mạng → fetch reject là BÌNH THƯỜNG), KHÔNG throw/không hiện lỗi.
import { proxyFetch } from './proxy-fetch';

const PING_PATH = '/v1/presence/ping';
const OFFLINE_PATH = '/v1/presence/offline';
/** Chu kỳ ping (FIX PRESENCE 11/8: 45s → 15s). GỐC BUG: 45s >> cửa sổ "nhịp sống còn tươi" phía server nên thiết
 * bị mở app nhưng KHÔNG giữ WS thường trực (chủ yếu APK nền) bị coi offline giữa 2 nhịp → account khác thấy "vừa
 * mới truy cập" nhấp nháy. Server nay dùng PRESENCE_HEARTBEAT_TTL_MS=40s (chat-realtime-hub.ts) cho nguồn REST →
 * BẤT BIẾN "2×ping ≤ TTL": 2×15=30s ≤ 40s → rớt ĐÚNG 1 nhịp vẫn KHÔNG nháy offline. Đổi 1 hằng ở 1 nơi thì phải
 * giữ bất biến này (ping ≤ TTL/2). Vẫn thưa hơn WS heartbeat, ngân sách rate-limit 60/phút thoải mái (4/phút). */
export const PRESENCE_PING_INTERVAL_MS = 15_000;

function botApiBaseUrl(): string {
  // CÙNG cách bot-api-client.ts đọc base URL (2 package tách biệt, không import chéo được — khớp giá trị).
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

/** POST tới bot-api qua proxyFetch (tự gắn credentials:'include' + CSRF header `x-sigma-client: web`). Best-
 * effort — nuốt mọi lỗi (mất mạng/401 phiên hết hạn đều KHÔNG cần xử lý ở đây). Tách hàm để test inject được. */
async function defaultPost(path: string): Promise<void> {
  try {
    await proxyFetch(`${botApiBaseUrl()}${path}`, { method: 'POST' });
  } catch {
    // mất mạng / server không tới được — bình thường cho heartbeat, bỏ qua im lặng (best-effort).
  }
}

/** Báo server "tôi offline" NGAY (đăng xuất/mất mạng chủ động). Export riêng để App.tsx gọi lúc cleanup (logout/
 * hết phiên) — best-effort, KHÔNG throw. `post` inject cho test. */
export async function sendPresenceOffline(post: (path: string) => Promise<void> = defaultPost): Promise<void> {
  await post(OFFLINE_PATH);
}

export interface PresenceHeartbeatOptions {
  /** Chu kỳ ping (ms) — mặc định PRESENCE_PING_INTERVAL_MS. Test tiêm giá trị ngắn + fake timers. */
  intervalMs?: number;
  /** Hàm POST — mặc định defaultPost (proxyFetch). Test inject spy để assert path đã gọi. */
  post?: (path: string) => Promise<void>;
}

/**
 * Khởi động vòng lặp heartbeat presence. Trả về hàm STOP (gỡ mọi listener + dừng timer). CHỈ gọi khi ĐÃ đăng
 * nhập (App.tsx mount trong RequireAuth). stop() KHÔNG tự gửi /offline — App.tsx cleanup gọi sendPresenceOffline()
 * riêng (tách bạch để test start/stop thuần + tránh gửi /offline thừa khi chỉ teardown kỹ thuật).
 */
export function startPresenceHeartbeat(options: PresenceHeartbeatOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? PRESENCE_PING_INTERVAL_MS;
  const post = options.post ?? defaultPost;

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const isOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

  function ping(): void {
    if (stopped || !isOnline()) return;
    void post(PING_PATH);
  }
  function startInterval(): void {
    if (timer !== null || stopped) return;
    timer = setInterval(ping, intervalMs);
  }
  function stopInterval(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }
  function handleOffline(): void {
    // Mất mạng → dừng ping + báo offline NGAY (nếu còn kịp gửi; thường reject vì mạng đã mất — best-effort).
    stopInterval();
    void post(OFFLINE_PATH);
  }
  function handleOnline(): void {
    if (stopped) return;
    ping(); // ping NGAY để online lại tức thì, không chờ 1 chu kỳ.
    startInterval();
  }
  function handleVisibility(): void {
    if (stopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') ping();
  }

  // Khởi động: ping ngay + chạy vòng lặp nếu đang có mạng.
  if (isOnline()) {
    ping();
    startInterval();
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', handleVisibility);
  }

  return function stop(): void {
    stopped = true;
    stopInterval();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', handleVisibility);
    }
  };
}
