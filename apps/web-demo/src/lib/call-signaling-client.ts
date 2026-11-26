// SIGMA Phase 4 (30/7) — client WebSocket cho signaling gọi thoại/video (apps/bot-api/src/
// call-signaling-server.ts, path /v1/call-signaling). CÙNG mẫu kết nối rc-realtime.ts (ensureSocket()) — kết
// nối 1 lần, tái dùng, tự dọn khi đóng — nhưng ĐƠN GIẢN HƠN: giao thức gọi điện KHÔNG có bước "connect+login"
// nội bộ nào cần đợi (bot-api tự xác thực cookie NGAY lúc upgrade, xem call-signaling-server.ts) — `open` là
// tín hiệu sẵn sàng DUY NHẤT cần đợi.
//
// QUYẾT ĐỊNH THIẾT KẾ (phạm vi Phase 4 CHỈ giới hạn ở file lib + CallScreen/IncomingCallScreen.tsx, KHÔNG sửa
// AppShell.tsx/App.tsx để mount kết nối này lúc đăng nhập xong toàn app — xem báo cáo build): kết nối ở đây
// CHỈ được CallScreen/IncomingCallScreen tự gọi `ensureCallSignalingSocket()` lúc mount — nghĩa là ĐANG Ở
// MÀN gọi/màn gọi đến thì mới nhận được message signaling. Để nhận `incoming_call` bất kỳ lúc nào (đang ở màn
// khác trong app) cần LEAD/Admin Demo xác nhận wiring vào AppShell.tsx (mount 1 lần lúc đăng nhập, điều hướng
// sang IncomingCallScreen khi nhận `incoming_call`) — NGOÀI PHẠM VI đợt build này.
import { getSession, handleSessionExpired } from './session';
import { ROUTES } from '../routes';

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

function callSignalingWsUrl(): string {
  return `${botApiBaseUrl().replace(/^http/, 'ws')}/v1/call-signaling`;
}

/** Đóng code riêng bot-api gửi khi cookie/phiên không hợp lệ lúc upgrade — xem
 * apps/bot-api/src/rc-realtime-proxy.ts SESSION_EXPIRED_CLOSE_CODE (call-signaling-server.ts TÁI DÙNG chính
 * hằng số đó, KHÔNG phát minh mã riêng), PHẢI khớp giá trị. */
const SESSION_EXPIRED_CLOSE_CODE = 4401;

export type CallSignalingMessage = Record<string, unknown> & { type: string };
type Listener = (msg: CallSignalingMessage) => void;

let socket: WebSocket | null = null;
let connectPromise: Promise<void> | null = null;
const listeners = new Set<Listener>();

/** Đăng ký nhận MỌI message server gửi xuống (call-signaling-server.ts) — trả về hàm hủy đăng ký (dùng trong
 * useEffect cleanup). CallScreen/IncomingCallScreen tự lọc `msg.type`/`msg.callId` mình quan tâm. */
export function onCallSignalingMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Mở (hoặc tái dùng) kết nối — gọi TRƯỚC khi sendCallSignalingMessage(). Reject nếu chưa đăng nhập (KHÔNG
 * có session cục bộ) hoặc bot-api từ chối cookie phiên (đóng SESSION_EXPIRED_CLOSE_CODE ngay lúc upgrade). */
export function ensureCallSignalingSocket(): Promise<void> {
  const session = getSession();
  if (!session) return Promise.reject(new Error('Chưa đăng nhập.'));

  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connectPromise) return connectPromise;

  connectPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(callSignalingWsUrl());
    socket = ws;
    let settled = false;

    ws.addEventListener('open', () => {
      settled = true;
      resolve();
    });

    ws.addEventListener('message', (ev) => {
      let data: CallSignalingMessage;
      try {
        data = JSON.parse(ev.data as string);
      } catch {
        return; // message không phải JSON hợp lệ — bỏ qua, KHÔNG throw làm vỡ kết nối.
      }
      listeners.forEach((fn) => fn(data));
    });

    ws.addEventListener('close', (ev) => {
      if (socket === ws) {
        socket = null;
        connectPromise = null;
      }
      if (!settled) {
        settled = true;
        reject(new Error('Không kết nối được signaling gọi điện.'));
      }
      // Token/phiên không hợp lệ → dọn phiên cục bộ + báo App.tsx điều hướng /login, CÙNG xử lý rc-realtime.ts.
      if (ev.code === SESSION_EXPIRED_CLOSE_CODE) {
        handleSessionExpired();
      }
      // KHÔNG tự auto-reconnect nền ở đây (KHÁC rc-realtime.ts — danh sách chat cần real-time liên tục suốt
      // phiên làm việc): gọi điện là hành động CHỦ ĐỘNG của người dùng, CallScreen/IncomingCallScreen tự gọi
      // lại ensureCallSignalingSocket() mỗi lần mount nếu cần.
    });

    ws.addEventListener('error', () => {
      // Để 'close' xử lý reject — WebSocket luôn bắn 'close' ngay sau 'error'.
    });
  });

  return connectPromise;
}

/** Gửi 1 message tới server — PHẢI gọi ensureCallSignalingSocket() thành công TRƯỚC. Không throw khi socket
 * chưa sẵn sàng (log lỗi, best-effort) — caller (CallScreen) tự xử lý qua callback lỗi nếu cần chặt hơn. */
export function sendCallSignalingMessage(msg: CallSignalingMessage): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    // eslint-disable-next-line no-console
    console.error('[call-signaling-client] gửi message lúc socket chưa sẵn sàng:', msg.type);
    return;
  }
  socket.send(JSON.stringify(msg));
}

export interface IncomingCallNavigation {
  path: string;
  state: { callId: unknown; callerAgentId: unknown; callerName: unknown; kind: unknown };
}

/**
 * Nợ độ tin cậy đánh thức cuộc gọi (30/7) — hàm THUẦN (không I/O, không React) dùng bởi AppShell.tsx (global
 * listener): cho 1 message signaling BẤT KỲ nhận từ onCallSignalingMessage(), trả về {path, state} cần
 * navigate() nếu ĐÚNG là 'incoming_call' (dữ liệu THẬT server gửi, xem call-signaling-server.ts
 * handleCallInvite() broadcastToAgent(calleeAgentId, {type:'incoming_call', callId, callerAgentId,
 * callerName, kind})), hoặc `null` nếu là type KHÁC (bỏ qua, KHÔNG điều hướng — mọi message call_accepted/
 * offer/answer/ice_candidate/call_end/... đều để nguyên cho CallScreen/IncomingCallScreen tự lọc theo callId).
 * Tách riêng để test được KHÔNG cần dựng cây React/JSDOM — repo NÀY chưa có hạ tầng render component
 * (@testing-library/react), pattern nhất quán đã dùng cho rc-message-split.ts/attachment-blob.ts (tách hàm
 * thuần, test bằng vitest environment 'node' thuần túy, xem vitest.config.ts root).
 */
export function buildIncomingCallNavigation(msg: CallSignalingMessage): IncomingCallNavigation | null {
  if (msg.type !== 'incoming_call') return null;
  return {
    path: ROUTES.incomingCall,
    state: { callId: msg.callId, callerAgentId: msg.callerAgentId, callerName: msg.callerName, kind: msg.kind }
  };
}

export interface StartCallNavigation {
  path: string;
  state: { roomId: string; calleeAgentId?: number; calleeName?: string };
}

/**
 * fix-call-wiring (31/7) — hàm THUẦN dùng bởi App.tsx `ConversationRoute` khi bấm "Gọi thoại"/"Gọi video" từ 1
 * hội thoại THẬT (ConversationScreen.tsx `onStartCall`). CÙNG lý do tách `buildIncomingCallNavigation()` ở
 * trên: test được không cần dựng cây React/router thật.
 *
 * `room.isGroup` true → trả `null` (KHÔNG điều hướng) — Phase 4 CHỈ làm gọi 1-1 (xem comment đầu
 * CallScreen.tsx/call-signaling-server.ts, KHÔNG có "gọi nhóm" nào để chọn 1 agentId đại diện). ConversationScreen.tsx
 * CŨNG tự ẩn nút gọi cho phòng GROUP (2 lớp phòng thủ độc lập, không dựa riêng 1 chỗ chặn).
 *
 * `peerAgentId` null (DIRECT nhưng chưa resolve được agentId đối phương — xem resolveDirectPeerAgentId()
 * chat-client.ts) → vẫn trả về điều hướng nhưng state KHÔNG có field `calleeAgentId` — CallScreen.tsx tự rơi về
 * "chế độ xem trước" (isRealMode false), CÙNG hành vi fallback demo mode đã có sẵn (route /app/call/incoming
 * không kèm state), KHÔNG throw/vỡ màn.
 *
 * `calleeName` (fix-call-name 31/7, B67 xem BUGS_FIXED.md) — TÙY CHỌN, tên hiển thị THẬT của người được gọi
 * (caller đã có sẵn, KHÔNG cần round-trip thêm) — App.tsx `CallRoute` dùng field này thay cho tra `CHAT_ROOMS`
 * (mock tĩnh, gần như luôn miss với phòng DIRECT thật → trước đây luôn hiện sai tên "Trần Thị Hồng" bất kể
 * đang gọi ai). Undefined (caller không có tên sẵn, vd route demo cũ) → CallRoute tự fallback về tên mock,
 * KHÔNG đổi hành vi cũ.
 */
export function buildStartCallNavigation(
  kind: 'voice' | 'video',
  room: { id: string; isGroup: boolean },
  peerAgentId: number | null,
  calleeName?: string
): StartCallNavigation | null {
  if (room.isGroup) return null;
  const state: { roomId: string; calleeAgentId?: number; calleeName?: string } = { roomId: room.id };
  if (peerAgentId != null) state.calleeAgentId = peerAgentId;
  if (calleeName != null) state.calleeName = calleeName;
  return { path: ROUTES.call(kind), state };
}

/**
 * fix-contacts-call (31/7) — hàm THUẦN dùng bởi App.tsx `ContactsRoute.onCall` khi bấm "Gọi"/"Video" từ 1 hồ sơ
 * bạn bè trong Danh bạ (ContactsScreen.tsx). CÙNG lớp bug B59 đã sửa cho `ConversationRoute` (ghi rõ trong
 * BUGS_FIXED.md B59 "Phát hiện phụ CHƯA sửa: ContactsRoute.onCall có cùng lỗ hổng, ngoài scope lúc đó") — giờ
 * đóng nốt.
 *
 * KHÁC `buildStartCallNavigation()` ở trên: ConversationRoute chỉ có sẵn `room` (không biết agentId đối
 * phương) nên phải tự dò qua `resolveDirectPeerAgentId()` (chat-client.ts, đọc `ChatRoomDetailDto.members`).
 * Ở đây thì NGƯỢC LẠI — ContactsScreen gọi `onCall(agentId, kind)` với `agentId` ĐÃ LÀ định danh chính xác
 * người được gọi (chính `profile.agentId` — người đang xem hồ sơ) — không cần dò lại từ danh sách thành viên
 * phòng (thêm 1 round-trip `getChatRoomDetail()` vô ích mà không tăng độ chính xác nào, vì phòng DIRECT tạo
 * qua `createOrGetDirectRoom(targetAgentId)` ĐẢM BẢO đúng 2 thành viên: mình + `targetAgentId` đó — xem
 * `findOrCreateDirectRoom()` chat-room-service.ts). Bọc lại `buildStartCallNavigation()` (tái dùng logic
 * path/state + chặn GROUP) thay vì viết lại — `room.type` suy `isGroup` (LUÔN `'DIRECT'` theo hợp đồng route
 * `POST /v1/chat/rooms/direct`, nhưng vẫn kiểm tường minh qua `buildStartCallNavigation`, không giả định).
 *
 * `calleeName` (fix-call-name 31/7, B67) — CÙNG lý do `buildStartCallNavigation()` ở trên: ContactsScreen.tsx
 * đã có sẵn `profile.nickname ?? profile.agentName` (tên hiển thị hồ sơ đang xem) lúc bấm nút gọi.
 */
export function buildContactCallNavigation(
  kind: 'voice' | 'video',
  room: { id: string; type: 'DIRECT' | 'GROUP' },
  peerAgentId: number,
  calleeName?: string
): StartCallNavigation | null {
  return buildStartCallNavigation(kind, { id: room.id, isGroup: room.type === 'GROUP' }, peerAgentId, calleeName);
}

/** Đóng kết nối chủ động (rời màn gọi/màn gọi đến) — idempotent, gọi nhiều lần không lỗi. */
export function closeCallSignalingSocket(): void {
  if (!socket) return;
  try {
    socket.close();
  } catch {
    // đã đóng — bỏ qua.
  }
  socket = null;
  connectPromise = null;
}
