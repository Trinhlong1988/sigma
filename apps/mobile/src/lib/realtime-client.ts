// SIGMA Mobile Milestone 5.1 (29/7) — RealtimeClient: interface GIỮ CHỖ cho kết nối chat thời gian thực.
// CHƯA nối vào bất kỳ URL/endpoint thật nào — Phase 3 (bot-api) CHƯA CHỐT XONG giao thức WebSocket (shape
// message cụ thể). File này CHỈ dựng phần hạ tầng KHÔNG phụ thuộc shape message: state machine kết nối, backoff
// reconnect, theo dõi AppState để chủ động đóng+mở lại khi app quay lại foreground. Việc parse/định tuyến message
// theo shape thật của Phase 3 là việc milestone SAU (5.2), khi giao thức đã chốt.
//
// Phong cách "subscribe" CÙNG KHUÔN onSessionExpired() (api-client.ts) — 1 listener duy nhất/loại sự kiện, KHÔNG
// phải mảng nhiều subscriber (Giai đoạn này chỉ có 1 nơi lắng nghe: màn hình chat sẽ nối ở milestone 5.2).
import { AppState, type AppStateStatus } from 'react-native';

export type RealtimeState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting';

type StateListener = (state: RealtimeState) => void;
type MessageListener = (raw: unknown) => void;

// ── Backoff reconnect — PURE FUNCTION tách riêng để unit-test không cần WebSocket thật (xem
// __tests__/realtime-client.test.ts). Công thức:
// exponential 1s→2s→4s→...→trần 30s (BASE_DELAY_MS * 2^(attempt-1), clamp MAX_DELAY_MS) + jitter nhỏ ngẫu
// nhiên [0, JITTER_MAX_MS) — jitter tránh nhiều client cùng dồn reconnect đúng 1 thời điểm (thundering herd)
// sau khi máy chủ/mạng phục hồi, nhưng KHÔNG lớn tới mức làm sai lệch rõ rệt bậc thang thời gian dự kiến.
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 30000;
export const JITTER_MAX_MS = 250;

/** Tính độ trễ (ms) trước lần thử kết nối lại thứ `attempt` (1 = lần thử đầu tiên sau khi mất kết nối). */
export function computeReconnectDelayMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const exponential = BASE_DELAY_MS * Math.pow(2, safeAttempt - 1);
  const capped = Math.min(exponential, MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
  return capped + jitter;
}

let ws: WebSocket | null = null;
let state: RealtimeState = 'idle';
let currentUrl: string | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let manualDisconnect = false; // true khi disconnect() được gọi CHỦ ĐỘNG — chặn auto-reconnect sau đó.
let appStateSub: { remove: () => void } | null = null;
let lastAppState: AppStateStatus = AppState.currentState;

let stateListener: StateListener | null = null;
let messageListener: MessageListener | null = null;

/** Đăng ký lắng nghe đổi trạng thái kết nối — CÙNG khuôn onSessionExpired() (api-client.ts), 1 listener duy
 * nhất (gọi lại onStateChange() lần sau sẽ THAY THẾ listener cũ, không cộng dồn). */
export function onStateChange(listener: StateListener): void {
  stateListener = listener;
}

/** Đăng ký lắng nghe message THÔ nhận từ socket — CHƯA parse shape cụ thể (việc đó thuộc milestone 5.2 khi
 * Phase 3 đã chốt giao thức). `raw` là `event.data` nguyên văn từ WebSocketMessageEvent. */
export function onMessage(listener: MessageListener): void {
  messageListener = listener;
}

/** Trạng thái kết nối hiện tại — dùng cho test/debug, UI thật sẽ đọc qua onStateChange(). */
export function getRealtimeState(): RealtimeState {
  return state;
}

function setState(next: RealtimeState): void {
  state = next;
  stateListener?.(next);
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function openSocket(): void {
  if (!currentUrl) return;
  setState('connecting');
  let socket: WebSocket;
  try {
    socket = new WebSocket(currentUrl);
  } catch {
    // Môi trường/URL không tạo được socket (vd sai scheme) — coi như 1 lần thất bại, đi vào backoff giống
    // đóng bất ngờ, KHÔNG throw ra ngoài (transport nền, caller không nên phải try/catch connect()).
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    reconnectAttempt = 0;
    setState('open');
  };
  socket.onmessage = (event) => {
    messageListener?.(event.data);
  };
  // onerror KHÔNG tự chuyển state — WebSocket chuẩn luôn bắn `close` NGAY SAU `error` khi kết nối hỏng, xử lý
  // reconnect tập trung ở onclose (tránh double-schedule nếu cả 2 handler đều tự ý gọi scheduleReconnect()).
  socket.onerror = () => {};
  socket.onclose = () => {
    if (ws !== socket) return; // socket cũ đã bị thay (vd connect() gọi lại) — bỏ qua sự kiện muộn.
    ws = null;
    if (manualDisconnect) {
      setState('closed');
      return;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  clearReconnectTimer();
  setState('reconnecting');
  reconnectAttempt += 1;
  const delay = computeReconnectDelayMs(reconnectAttempt);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
}

function handleAppStateChange(next: AppStateStatus): void {
  const wasBackgrounded = lastAppState === 'background' || lastAppState === 'inactive';
  const isNowActive = next === 'active';
  // Android có thể đã âm thầm cắt kết nối ngầm trong lúc app nền — KHÔNG tin socket cũ còn sống, chủ động
  // đóng (nếu còn) rồi mở lại ngay khi quay lại foreground, thay vì chờ tới khi gửi/nhận thất bại mới phát hiện.
  if (wasBackgrounded && isNowActive && currentUrl && !manualDisconnect) {
    clearReconnectTimer();
    if (ws) {
      const stale = ws;
      ws = null;
      stale.onclose = null; // đã tự xử lý ở đây — không để onclose gốc chạy lại scheduleReconnect() lần 2.
      stale.close();
    }
    reconnectAttempt = 0;
    openSocket();
  }
  lastAppState = next;
}

function ensureAppStateWatcher(): void {
  if (appStateSub) return;
  appStateSub = AppState.addEventListener('change', handleAppStateChange);
}

function removeAppStateWatcher(): void {
  appStateSub?.remove();
  appStateSub = null;
}

/** Mở kết nối tới `url` — CHỈ là transport, KHÔNG tự gửi bất kỳ message xác thực/subscribe nào (caller ở
 * milestone 5.2 tự quyết định gửi gì sau khi `open`, theo giao thức Phase 3 lúc đó đã chốt). Gọi lại connect()
 * trong lúc đang kết nối/đã kết nối sẽ đóng phiên cũ và mở phiên mới theo `url` mới. */
export function connect(url: string): void {
  manualDisconnect = false;
  currentUrl = url;
  reconnectAttempt = 0;
  clearReconnectTimer();
  if (ws) {
    const stale = ws;
    ws = null;
    stale.onclose = null;
    stale.close();
  }
  openSocket();
  ensureAppStateWatcher();
}

/** Đóng kết nối CHỦ ĐỘNG — tắt hẳn auto-reconnect (khác 1 lần đóng ngoài ý muốn), gỡ theo dõi AppState. */
export function disconnect(): void {
  manualDisconnect = true;
  clearReconnectTimer();
  removeAppStateWatcher();
  if (ws) {
    setState('closing');
    const stale = ws;
    ws = null;
    stale.close();
  }
  setState('closed');
}

/** Gửi `obj` (sẽ JSON.stringify) qua socket — no-op an toàn nếu chưa ở trạng thái `open` (KHÔNG throw, transport
 * nền không nên làm crash caller vì lỡ gọi send() lúc đang reconnect). */
export function send(obj: unknown): void {
  if (!ws || state !== 'open') return;
  ws.send(JSON.stringify(obj));
}
