// SIGMA Phase 4 (30/7) — WebSocket signaling cho gọi thoại/video WebRTC tự xây (thay Rocket.Chat). Bot-api
// CHỈ làm trung gian trao đổi SDP/ICE (giao thức) — media (audio/video) đi P2P trực tiếp giữa 2 trình duyệt
// hoặc qua TURN relay (turn-credential-service.ts), KHÔNG bao giờ đi qua bot-api.
//
// Gắn vào ĐÚNG http.Server thật qua `server.on('upgrade')` THỨ 2, path RIÊNG CALL_SIGNALING_PATH — Node cho
// phép nhiều listener 'upgrade' cùng lúc, mỗi listener tự lọc theo req.url và bỏ qua path không khớp (xem
// rc-realtime-proxy.ts attachRcRealtimeProxy() làm MẪU — KHÔNG sửa file đó, chỉ tái dùng đúng 2 export thuần
// `parseCookieHeader`/`SESSION_EXPIRED_CLOSE_CODE` nó đã có sẵn, tránh viết lại trùng lặp).
//
// Xác thực: đọc cookie `sigma_ws` → getWebSession() → resolve agentId CÙNG logic ưu tiên rcUserId→agentId
// hệt `requireSession()` (session-middleware.ts) — KHÔNG kiểm CSRF header (browser KHÔNG THỂ set custom header
// trên WebSocket handshake theo spec WHATWG, đây là hạn chế nền tảng, không phải bug bỏ sót — CÙNG lý do
// rc-realtime-proxy.ts cũng KHÔNG kiểm CSRF ở upgrade, chỉ dựa vào cookie).
//
// Message envelope: JSON phẳng `{ type: '<tên>', ...field }` cho MỌI hướng (client→server VÀ server→client).
//
// QUYẾT ĐỊNH THIẾT KẾ (ghi rõ cho LEAD/Admin Demo xác nhận nếu cần mở rộng sau):
// 1. Registry (Map agentId→sockets, Map agentId→activeCallId, Map callId→CallRuntimeState) khai TRONG closure
//    của attachCallSignaling() — KHÔNG phải module-level. Mỗi lần gọi (mỗi test dựng 1 server riêng, hoặc
//    index.ts gọi đúng 1 lần lúc boot) có state HOÀN TOÀN độc lập, không cần hàm reset-cho-test (khác
//    rc-realtime-proxy.ts — các hàm thuần ở đó như `isAgentViewingRoom` PHẢI global vì bị gọi từ module khác
//    routes/rc-events.ts; state gọi điện ở đây không ai khác cần đọc, không có nhu cầu đó).
// 2. WS rớt kết nối trong lúc RINGING (trước accept): brief CHỈ yêu cầu tường minh "WS rớt SAU ACCEPTED KHÔNG
//    tự kết thúc call" — KHÔNG có yêu cầu tường minh nào cho lúc RINGING. Quyết định (tránh suy luận thêm hành
//    vi ngoài spec — R "CẤM SUY LUẬN"): lúc đóng kết nối CHỈ dọn registry (Set socket), KHÔNG tự động chuyển
//    trạng thái CallSession nào — cuộc gọi RINGING bị bỏ rơi (caller tắt app giữa chừng) vẫn tự hết hạn đúng
//    45s qua ring-timeout sẵn có, KHÔNG cần thêm nhánh riêng. LEAD xác nhận lại nếu muốn kết thúc NGAY khi
//    caller mất kết nối (nhanh hơn nhưng phức tạp hơn — phải phân biệt multi-device: 1 tab đóng không có nghĩa
//    agent đó đã rời khỏi cuộc gọi nếu còn tab khác).
// 3. `call_busy` gửi ĐÚNG như spec liệt kê — KHÔNG kèm callId (chưa từng tạo CallSession nào cho lần thử này).
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { getBotDb } from './db.js';
import { getWebSession, WEB_SESSION_COOKIE_NAME } from './web-session-service.js';
import { parseCookieHeader, SESSION_EXPIRED_CLOSE_CODE } from './ws-cookie-session.js';
import { isAllowedWsOrigin } from './ws-origin-check.js';
import { canMessageAgent } from './friend-service.js';
import { sendPushToAgent } from './push-notification-service.js';
import {
  createInvite,
  markAccepted,
  markRejected,
  markCancelled,
  markTimeout,
  markEnded,
  markFailed,
  CallServiceError,
  type CallKind
} from './call-session-service.js';

export const CALL_SIGNALING_PATH = '/v1/call-signaling';
// 45s đổ chuông + 15s chờ offer/answer — ĐÚNG số brief yêu cầu. Test tự truyền số nhỏ hơn qua
// AttachCallSignalingOptions (KHÔNG chờ 45s/15s thật, xem test/call-signaling-server.test.ts).
export const DEFAULT_RING_TIMEOUT_MS = 45_000;
export const DEFAULT_SIGNALING_TIMEOUT_MS = 15_000;
// Audit độc lập 30/7 (HIGH): connectionsByAgentId trước đây CHỈ được dọn phản ứng theo sự kiện 'close' — mất
// mạng đột ngột (app bị OS kill nền, rớt wifi không gửi được frame close) không tạo ra 'close' ngay, có thể để
// rất lâu, khiến `calleeHasOpenConnection` báo SAI là "đang mở" đúng lúc cần push đánh thức nhất. Thêm
// heartbeat ping/pong chuẩn thư viện `ws` — dọn kết nối chết trong vòng tối đa 1 chu kỳ.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

// LANE A Vòng 2 (3/8) — chống spam/DoS call_invite: giới hạn số lời mời gọi 1 caller được gửi trong 1 cửa sổ
// thời gian (đồng bộ TINH THẦN các limiter khác của dự án — rc-events 60/phút, ocr-preview...). 1 người thật
// KHÔNG thể gọi hợp lệ >10 lần/phút; ngưỡng này chặn kịch bản invite→cancel→invite lặp lại tạo hàng loạt
// CallSession/đánh thức push liên tục. Đếm trong RAM theo callerId (đủ dùng, quy mô ~400 user, không cần bền
// qua restart). Test tiêm ngưỡng nhỏ + cửa sổ riêng qua options (KHÔNG chờ số thật).
export const DEFAULT_MAX_INVITES_PER_WINDOW = 10;
export const DEFAULT_INVITE_WINDOW_MS = 60_000;

export interface AttachCallSignalingOptions {
  ringTimeoutMs?: number;
  signalingTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maxInvitesPerWindow?: number;
  inviteWindowMs?: number;
}

interface HeartbeatSocket extends WebSocket {
  isAlive?: boolean;
}

interface CallRuntimeState {
  callId: string;
  callerId: number;
  calleeId: number;
  kind: CallKind;
  status: 'RINGING' | 'ACCEPTED';
  ringTimer?: NodeJS.Timeout;
  signalingTimer?: NodeJS.Timeout;
  offerRelayed: boolean;
  answerRelayed: boolean;
}

// Audit độc lập 30/7 (MEDIUM): nhánh lỗi không phải CallServiceError (Prisma/DB thật) trước đây trả thẳng
// `err.message` cho client — rò rỉ chi tiết nội bộ (tên bảng/cột/constraint), khác hẳn quy ước REST đã hardening
// (error-handling.test.ts — lỗi bất ngờ luôn trả message chung chung, log chi tiết server-side). Đồng bộ lại.
function errCodeAndMessage(err: unknown): { code: string; message: string } {
  if (err instanceof CallServiceError) return { code: err.code, message: err.message };
  console.error('[call-signaling-server] lỗi nội bộ không xác định:', err);
  return { code: 'INTERNAL', message: 'Lỗi hệ thống, vui lòng thử lại.' };
}

export function attachCallSignaling(server: HttpServer, options: AttachCallSignalingOptions = {}): WebSocketServer {
  const ringTimeoutMs = options.ringTimeoutMs ?? DEFAULT_RING_TIMEOUT_MS;
  const signalingTimeoutMs = options.signalingTimeoutMs ?? DEFAULT_SIGNALING_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxInvitesPerWindow = options.maxInvitesPerWindow ?? DEFAULT_MAX_INVITES_PER_WINDOW;
  const inviteWindowMs = options.inviteWindowMs ?? DEFAULT_INVITE_WINDOW_MS;

  const wss = new WebSocketServer({ noServer: true });

  // Audit độc lập 30/7 (HIGH): sweep định kỳ toàn bộ wss.clients (bookkeeping có sẵn của thư viện `ws`, không
  // cần Map riêng) — socket không trả pong trong 1 chu kỳ coi là chết, terminate() ép đóng → bắn 'close' →
  // removeConnection() tự dọn registry. unref() để không giữ process Node sống chỉ vì interval này.
  const heartbeatTimer: NodeJS.Timeout = setInterval(() => {
    for (const client of wss.clients) {
      const hbClient = client as HeartbeatSocket;
      if (hbClient.isAlive === false) {
        hbClient.terminate();
        continue;
      }
      hbClient.isAlive = false;
      hbClient.ping();
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();
  wss.on('close', () => clearInterval(heartbeatTimer));

  // agentId → tập kết nối sống (nhiều thiết bị/tab cùng lúc).
  const connectionsByAgentId = new Map<number, Set<WebSocket>>();
  // agentId → callId đang RINGING/ACCEPTED của agent đó (chống gọi chồng — 1 agent chỉ ở trong ĐÚNG 1 cuộc gọi
  // tại 1 thời điểm, dù là caller hay callee).
  const activeCallByAgentId = new Map<number, string>();
  const callsById = new Map<string, CallRuntimeState>();
  // LANE A Vòng 2 (3/8) — cửa sổ trượt (sliding window) mốc thời gian lời mời gọi theo callerId, chống spam/DoS
  // call_invite. Đếm trong RAM trong closure này (state độc lập mỗi lần attach — mỗi test/mỗi boot process).
  const inviteTimestampsByCaller = new Map<number, number[]>();

  /** true nếu caller ĐƯỢC PHÉP gửi thêm 1 lời mời NGAY BÂY GIỜ (và ghi nhận mốc thời gian). false nếu đã chạm
   * ngưỡng trong cửa sổ (KHÔNG ghi nhận — lời mời bị chặn không tính vào hạn mức). Cắt tỉa các mốc cũ hơn cửa
   * sổ mỗi lần gọi để Map không phình vô hạn. */
  function allowInviteAndRecord(callerId: number): boolean {
    const now = Date.now();
    const cutoff = now - inviteWindowMs;
    const recent = (inviteTimestampsByCaller.get(callerId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= maxInvitesPerWindow) {
      inviteTimestampsByCaller.set(callerId, recent); // giữ bản đã cắt tỉa (không thêm mốc mới).
      return false;
    }
    recent.push(now);
    inviteTimestampsByCaller.set(callerId, recent);
    return true;
  }

  function addConnection(agentId: number, ws: WebSocket): void {
    let set = connectionsByAgentId.get(agentId);
    if (!set) {
      set = new Set();
      connectionsByAgentId.set(agentId, set);
    }
    set.add(ws);
  }

  function removeConnection(agentId: number, ws: WebSocket): void {
    const set = connectionsByAgentId.get(agentId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) connectionsByAgentId.delete(agentId);
  }

  function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcastToAgent(agentId: number, msg: Record<string, unknown>, exceptWs?: WebSocket): void {
    const set = connectionsByAgentId.get(agentId);
    if (!set) return;
    for (const client of set) {
      if (client === exceptWs) continue;
      sendJson(client, msg);
    }
  }

  function clearRingTimer(call: CallRuntimeState): void {
    if (call.ringTimer) {
      clearTimeout(call.ringTimer);
      call.ringTimer = undefined;
    }
  }
  function clearSignalingTimer(call: CallRuntimeState): void {
    if (call.signalingTimer) {
      clearTimeout(call.signalingTimer);
      call.signalingTimer = undefined;
    }
  }

  /** Dọn HOÀN TOÀN 1 call khỏi registry RAM (KHÔNG đụng DB — caller tự markXxx() trước khi gọi hàm này). Kiểm
   * `activeCallByAgentId.get(...) === callId` trước khi xóa — phòng lưới an toàn (không xóa nhầm nếu agent đó
   * đã vào 1 call MỚI khác trước khi cleanup của call CŨ kịp chạy, dù thực tế race này không nên xảy ra vì
   * activeCallByAgentId chặn gọi chồng ngay từ call_invite). */
  function cleanupCall(callId: string): void {
    const call = callsById.get(callId);
    if (!call) return;
    clearRingTimer(call);
    clearSignalingTimer(call);
    if (activeCallByAgentId.get(call.callerId) === callId) activeCallByAgentId.delete(call.callerId);
    if (activeCallByAgentId.get(call.calleeId) === callId) activeCallByAgentId.delete(call.calleeId);
    callsById.delete(callId);
  }

  function scheduleRingTimeout(call: CallRuntimeState): void {
    call.ringTimer = setTimeout(() => {
      handleRingTimeout(call.callId).catch((err) => console.error('[call-signaling-server] lỗi xử lý ring-timeout:', err));
    }, ringTimeoutMs);
  }

  async function handleRingTimeout(callId: string): Promise<void> {
    const call = callsById.get(callId);
    if (!call || call.status !== 'RINGING') return; // đã chuyển trạng thái trước khi timer bắn — race vô hại.
    try {
      await markTimeout(getBotDb(), callId);
    } catch (err) {
      console.error(`[call-signaling-server] markTimeout thất bại callId=${callId} (vẫn tiếp tục dọn registry, R198 — log rõ KHÔNG nuốt im):`, err);
    }
    broadcastToAgent(call.callerId, { type: 'call_timeout', callId });
    broadcastToAgent(call.calleeId, { type: 'call_timeout', callId });
    cleanupCall(callId);
  }

  /** (Re)đặt cửa sổ 15s chờ bước kế tiếp của đàm phán SDP — gọi lúc vừa ACCEPTED (chờ offer) VÀ lúc vừa relay
   * xong offer (chờ answer). Relay xong answer → clearSignalingTimer() hẳn, KHÔNG còn cửa sổ nào nữa (từ đó
   * media tự lo qua P2P/TURN, đúng spec "WS rớt sau ACCEPTED không tự kết thúc call"). */
  function scheduleSignalingTimeout(call: CallRuntimeState): void {
    clearSignalingTimer(call);
    call.signalingTimer = setTimeout(() => {
      handleSignalingTimeout(call.callId).catch((err) => console.error('[call-signaling-server] lỗi xử lý signaling-timeout:', err));
    }, signalingTimeoutMs);
  }

  async function handleSignalingTimeout(callId: string): Promise<void> {
    const call = callsById.get(callId);
    if (!call || call.status !== 'ACCEPTED' || call.answerRelayed) return; // đã đàm phán xong/đã kết thúc trước đó.
    try {
      await markFailed(getBotDb(), callId, 'SIGNALING_TIMEOUT');
    } catch (err) {
      console.error(`[call-signaling-server] markFailed thất bại callId=${callId}:`, err);
    }
    broadcastToAgent(call.callerId, { type: 'call_end', callId, reason: 'SIGNALING_TIMEOUT' });
    broadcastToAgent(call.calleeId, { type: 'call_end', callId, reason: 'SIGNALING_TIMEOUT' });
    cleanupCall(callId);
  }

  async function handleCallInvite(ws: WebSocket, agentId: number, agentName: string, msg: Record<string, unknown>): Promise<void> {
    const calleeAgentId = Number(msg.calleeAgentId);
    const kind = msg.kind;
    if (!Number.isInteger(calleeAgentId) || calleeAgentId <= 0 || (kind !== 'VOICE' && kind !== 'VIDEO')) {
      sendJson(ws, { type: 'call_error', code: 'VALIDATION', message: 'calleeAgentId/kind không hợp lệ.' });
      return;
    }
    if (calleeAgentId === agentId) {
      sendJson(ws, { type: 'call_error', code: 'VALIDATION', message: 'Không thể tự gọi cho chính mình.' });
      return;
    }
    // LANE A Vòng 2 (3/8) — chống spam/DoS: giới hạn số lời mời/1 caller trong 1 cửa sổ. Kiểm SỚM (sau validate
    // cơ bản, TRƯỚC tra bạn bè/DB createInvite) để lời mời spam bị chặn RẺ NHẤT — kể cả kịch bản invite→cancel→
    // invite lặp lại hay dội vào 1 callee đang bận đều tính vào hạn mức. Vượt ngưỡng → call_error RATE_LIMITED,
    // KHÔNG tạo CallSession/không đánh thức push.
    if (!allowInviteAndRecord(agentId)) {
      sendJson(ws, { type: 'call_error', code: 'RATE_LIMITED', message: 'Bạn gọi quá nhanh, vui lòng thử lại sau ít phút.' });
      return;
    }
    // Audit độc lập 30/7 (HIGH): thiếu gate bạn bè/chặn — friend-service.ts blockFriend() comment gốc ĐÃ ghi rõ
    // block phải chặn CẢ "voice/video call", nhưng handler này trước đây KHÔNG kiểm gì — bất kỳ agent nào cũng
    // gọi được người đã chặn mình. CÙNG lớp lỗi B44 cũ (im.create) — gate UI-only (ContactsScreen nút Gọi
    // disabled) không thay được kiểm tra server-side thật.
    const allowed = await canMessageAgent(getBotDb(), agentId, calleeAgentId);
    if (!allowed) {
      sendJson(ws, { type: 'call_error', code: 'CANNOT_CALL', message: 'Không thể gọi — chưa là bạn bè hoặc đã chặn nhau.' });
      return;
    }
    // Audit độc lập 30/7 (HIGH — race đã chạy thật xác nhận): PHẢI "đặt chỗ" (reserve) NGAY trong tick đồng bộ
    // này, TRƯỚC await createInvite() — nếu chỉ check .has() rồi mới await, 2 lời mời gần như đồng thời cho
    // CÙNG 1 callee đều lọt qua check trước khi request nào kịp .set(). Dùng giá trị tạm 'PENDING' làm khóa,
    // rollback nếu createInvite() lỗi.
    if (activeCallByAgentId.has(agentId) || activeCallByAgentId.has(calleeAgentId)) {
      sendJson(ws, { type: 'call_busy' });
      return;
    }
    activeCallByAgentId.set(agentId, 'PENDING');
    activeCallByAgentId.set(calleeAgentId, 'PENDING');

    let created;
    try {
      created = await createInvite(getBotDb(), agentId, calleeAgentId, kind as CallKind);
    } catch (err) {
      activeCallByAgentId.delete(agentId);
      activeCallByAgentId.delete(calleeAgentId);
      const e = errCodeAndMessage(err);
      sendJson(ws, { type: 'call_error', code: e.code, message: e.message });
      return;
    }

    const call: CallRuntimeState = {
      callId: created.id,
      callerId: agentId,
      calleeId: calleeAgentId,
      kind: kind as CallKind,
      status: 'RINGING',
      offerRelayed: false,
      answerRelayed: false
    };
    callsById.set(created.id, call);
    activeCallByAgentId.set(agentId, created.id);
    activeCallByAgentId.set(calleeAgentId, created.id);
    scheduleRingTimeout(call);

    sendJson(ws, { type: 'call_ringing', callId: created.id });
    // Callee offline (không có socket nào) — KHÔNG lỗi, cuộc gọi vẫn RINGING trong DB và tự hết hạn sau
    // ringTimeoutMs như bình thường (đúng hành vi "gọi nhỡ" tự nhiên, không cần nhánh riêng cho "offline").
    const calleeHasOpenConnection = (connectionsByAgentId.get(calleeAgentId)?.size ?? 0) > 0;
    broadcastToAgent(calleeAgentId, { type: 'incoming_call', callId: created.id, callerAgentId: agentId, callerName: agentName, kind });
    // Nợ độ tin cậy đánh thức cuộc gọi (30/7): callee KHÔNG có kết nối WS nào đang mở (app đã tắt/bị hệ điều
    // hành kill nền) — broadcastToAgent ở trên KHÔNG gửi được gì (không throw, chỉ lặng lẽ bỏ qua vì Set rỗng/
    // không tồn tại). Gửi thêm push FCM priority CAO best-effort để đánh thức app kịp hiển thị màn hình nhận
    // cuộc gọi (KHÔNG throw nếu lỗi, chỉ log — CÙNG nguyên tắc best-effort mọi lời gọi sendPushToAgent khác
    // trong dự án, xem push-notification-service.ts). CHỈ gửi khi THỰC SỰ offline — tránh double-ring khi
    // callee đang mở app (WS broadcast đã đủ, push thêm lúc này chỉ gây thông báo thừa/gây nhiễu).
    if (!calleeHasOpenConnection) {
      // sendPushToAgent() TỰ nuốt lỗi nội bộ (best-effort, KHÔNG BAO GIỜ throw — xem push-notification-
      // service.ts) — await trực tiếp, CÙNG pattern routes/rc-events.ts, KHÔNG cần .catch() thừa.
      await sendPushToAgent(getBotDb(), calleeAgentId, {
        title: 'Cuộc gọi đến',
        body: `${agentName} đang gọi cho bạn`,
        data: { kind: 'incoming_call', callId: created.id, callerAgentId: String(agentId), callerName: agentName },
        priority: 'high'
      });
    }
  }

  async function handleCallAccept(ws: WebSocket, agentId: number, msg: Record<string, unknown>): Promise<void> {
    const callId = String(msg.callId ?? '');
    const call = callsById.get(callId);
    if (!call) {
      sendJson(ws, { type: 'call_error', callId, code: 'CALL_NOT_FOUND', message: 'Cuộc gọi không tồn tại hoặc đã kết thúc.' });
      return;
    }
    if (call.calleeId !== agentId) {
      sendJson(ws, { type: 'call_error', callId, code: 'NOT_AUTHORIZED', message: 'Chỉ người được gọi mới có thể chấp nhận cuộc gọi này.' });
      return;
    }
    try {
      await markAccepted(getBotDb(), callId);
    } catch (err) {
      const e = errCodeAndMessage(err);
      sendJson(ws, { type: 'call_error', callId, code: e.code, message: e.message });
      return;
    }
    clearRingTimer(call);
    call.status = 'ACCEPTED';
    broadcastToAgent(call.callerId, { type: 'call_accepted', callId });
    // Thiết bị KHÁC của callee (nếu đăng nhập nhiều nơi) — dismiss màn hình gọi đến của họ, KHÔNG gửi cho
    // chính ws vừa bấm accept (exceptWs).
    broadcastToAgent(call.calleeId, { type: 'call_answered_elsewhere', callId }, ws);
    scheduleSignalingTimeout(call);
  }

  async function handleCallReject(ws: WebSocket, agentId: number, msg: Record<string, unknown>): Promise<void> {
    const callId = String(msg.callId ?? '');
    const reason = typeof msg.reason === 'string' ? msg.reason : undefined;
    const call = callsById.get(callId);
    if (!call) {
      sendJson(ws, { type: 'call_error', callId, code: 'CALL_NOT_FOUND', message: 'Cuộc gọi không tồn tại hoặc đã kết thúc.' });
      return;
    }
    if (call.calleeId !== agentId) {
      sendJson(ws, { type: 'call_error', callId, code: 'NOT_AUTHORIZED', message: 'Chỉ người được gọi mới có thể từ chối cuộc gọi này.' });
      return;
    }
    try {
      await markRejected(getBotDb(), callId, reason);
    } catch (err) {
      const e = errCodeAndMessage(err);
      sendJson(ws, { type: 'call_error', callId, code: e.code, message: e.message });
      return;
    }
    broadcastToAgent(call.callerId, { type: 'call_rejected', callId, reason: reason ?? null });
    cleanupCall(callId);
  }

  async function handleOffer(ws: WebSocket, agentId: number, msg: Record<string, unknown>): Promise<void> {
    const callId = String(msg.callId ?? '');
    const call = callsById.get(callId);
    if (!call || (call.callerId !== agentId && call.calleeId !== agentId)) {
      sendJson(ws, { type: 'call_error', callId, code: 'CALL_NOT_FOUND', message: 'Cuộc gọi không tồn tại hoặc bạn không thuộc cuộc gọi này.' });
      return;
    }
    if (call.status !== 'ACCEPTED') {
      sendJson(ws, { type: 'call_error', callId, code: 'INVALID_STATE', message: 'Cuộc gọi chưa được chấp nhận, chưa thể trao đổi offer.' });
      return;
    }
    const otherAgentId = agentId === call.callerId ? call.calleeId : call.callerId;
    // Relay NGUYÊN VĂN sdp — KHÔNG log/lưu nội dung (có thể chứa IP nội bộ, đúng yêu cầu brief).
    broadcastToAgent(otherAgentId, { type: 'offer', callId, sdp: msg.sdp });
    call.offerRelayed = true;
    scheduleSignalingTimeout(call); // reset cửa sổ 15s — giờ chờ ANSWER.
  }

  async function handleAnswer(ws: WebSocket, agentId: number, msg: Record<string, unknown>): Promise<void> {
    const callId = String(msg.callId ?? '');
    const call = callsById.get(callId);
    if (!call || (call.callerId !== agentId && call.calleeId !== agentId)) {
      sendJson(ws, { type: 'call_error', callId, code: 'CALL_NOT_FOUND', message: 'Cuộc gọi không tồn tại hoặc bạn không thuộc cuộc gọi này.' });
      return;
    }
    if (call.status !== 'ACCEPTED' || !call.offerRelayed) {
      sendJson(ws, { type: 'call_error', callId, code: 'INVALID_STATE', message: 'Chưa có offer nào để trả lời.' });
      return;
    }
    const otherAgentId = agentId === call.callerId ? call.calleeId : call.callerId;
    broadcastToAgent(otherAgentId, { type: 'answer', callId, sdp: msg.sdp });
    call.answerRelayed = true;
    clearSignalingTimer(call); // đàm phán xong — hết cửa sổ timeout, WS rớt từ đây không còn kết thúc call.
  }

  function handleIceCandidate(ws: WebSocket, agentId: number, msg: Record<string, unknown>): void {
    const callId = String(msg.callId ?? '');
    const call = callsById.get(callId);
    if (!call || (call.callerId !== agentId && call.calleeId !== agentId)) {
      sendJson(ws, { type: 'call_error', callId, code: 'CALL_NOT_FOUND', message: 'Cuộc gọi không tồn tại hoặc bạn không thuộc cuộc gọi này.' });
      return;
    }
    const otherAgentId = agentId === call.callerId ? call.calleeId : call.callerId;
    broadcastToAgent(otherAgentId, { type: 'ice_candidate', callId, candidate: msg.candidate });
  }

  async function handleCallEnd(ws: WebSocket, agentId: number, msg: Record<string, unknown>): Promise<void> {
    const callId = String(msg.callId ?? '');
    const reason = typeof msg.reason === 'string' ? msg.reason : undefined;
    const call = callsById.get(callId);
    if (!call || (call.callerId !== agentId && call.calleeId !== agentId)) {
      sendJson(ws, { type: 'call_error', callId, code: 'CALL_NOT_FOUND', message: 'Cuộc gọi không tồn tại hoặc bạn không thuộc cuộc gọi này.' });
      return;
    }
    const otherAgentId = agentId === call.callerId ? call.calleeId : call.callerId;
    try {
      if (call.status === 'RINGING') {
        // call_end gửi lúc CHƯA accept = caller tự hủy (CANCELLED) hoặc callee từ chối kiểu "gác máy ngay"
        // (REJECTED) — KHÔNG có message riêng "call_cancel" trong giao thức (xem spec brief), tái dùng call_end
        // cho cả 2 vai trò, phân biệt bằng agentId là caller hay callee.
        if (agentId === call.callerId) await markCancelled(getBotDb(), callId, reason);
        else await markRejected(getBotDb(), callId, reason);
      } else {
        await markEnded(getBotDb(), callId, reason);
      }
    } catch (err) {
      const e = errCodeAndMessage(err);
      sendJson(ws, { type: 'call_error', callId, code: e.code, message: e.message });
      return;
    }
    broadcastToAgent(otherAgentId, { type: 'call_end', callId, reason: reason ?? null });
    cleanupCall(callId);
  }

  async function handleMessage(ws: WebSocket, agentId: number, agentName: string, raw: string): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      sendJson(ws, { type: 'call_error', code: 'BAD_MESSAGE', message: 'Message không phải JSON hợp lệ.' });
      return;
    }
    switch (data.type) {
      case 'call_invite':
        await handleCallInvite(ws, agentId, agentName, data);
        return;
      case 'call_accept':
        await handleCallAccept(ws, agentId, data);
        return;
      case 'call_reject':
        await handleCallReject(ws, agentId, data);
        return;
      case 'offer':
        await handleOffer(ws, agentId, data);
        return;
      case 'answer':
        await handleAnswer(ws, agentId, data);
        return;
      case 'ice_candidate':
        handleIceCandidate(ws, agentId, data);
        return;
      case 'call_end':
        await handleCallEnd(ws, agentId, data);
        return;
      default:
        sendJson(ws, { type: 'call_error', code: 'UNKNOWN_MESSAGE_TYPE', message: `Loại message không hỗ trợ: ${String(data.type)}` });
    }
  }

  function rejectSessionInvalid(req: IncomingMessage, socket: Socket, head: Buffer): void {
    // CÙNG mẫu rc-realtime-proxy.ts: hoàn tất handshake WS rồi đóng NGAY với SESSION_EXPIRED_CLOSE_CODE (KHÔNG
    // socket.destroy() thô) — client phân biệt được "cần đăng nhập lại" khỏi mất mạng thường.
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(SESSION_EXPIRED_CLOSE_CODE);
    });
  }

  async function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const cookies = parseCookieHeader(req.headers.cookie);
    const sessionId = cookies[WEB_SESSION_COOKIE_NAME];
    if (!sessionId) {
      rejectSessionInvalid(req, socket, head);
      return;
    }

    const db = getBotDb();
    const session = await getWebSession(db, sessionId);
    if (!session) {
      rejectSessionInvalid(req, socket, head);
      return;
    }

    // CÙNG logic ưu tiên rcUserId→agentId hệt requireSession() (session-middleware.ts) — KHÔNG viết khác đi,
    // giữ nhất quán tuyệt đối giữa 2 đường xác thực (đọc kỹ session-middleware.ts trước khi viết đoạn này).
    const agent = session.rcUserId
      ? await db.agent.findFirst({ where: { rcUserId: session.rcUserId, deletedAt: null } })
      : session.agentId != null
        ? await db.agent.findFirst({ where: { id: session.agentId, deletedAt: null } })
        : null;
    if (!agent) {
      rejectSessionInvalid(req, socket, head);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const hbWs = ws as HeartbeatSocket;
      hbWs.isAlive = true;
      hbWs.on('pong', () => {
        hbWs.isAlive = true;
      });
      addConnection(agent.id, ws);
      ws.on('message', (raw) => {
        handleMessage(ws, agent.id, agent.name, raw.toString()).catch((err) => {
          console.error('[call-signaling-server] lỗi xử lý message:', err);
        });
      });
      ws.on('close', () => removeConnection(agent.id, ws));
      ws.on('error', (err) => {
        console.error('[call-signaling-server] lỗi WebSocket:', err);
      });
    });
  }

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? '';
    if (!url.startsWith(CALL_SIGNALING_PATH)) return;
    // CSWSH: kiểm Origin TRƯỚC khi tra cookie/DB — CÙNG khuôn chat-realtime-proxy.ts (xem ws-origin-check.ts).
    // Origin lạ → đóng thô NGAY (socket.destroy), không hoàn tất handshake.
    if (!isAllowedWsOrigin(req.headers.origin)) {
      try {
        socket.destroy();
      } catch {
        // socket đã đóng — bỏ qua.
      }
      return;
    }
    handleUpgrade(req, socket, head).catch((err) => {
      console.error('[call-signaling-server] lỗi xử lý upgrade:', err);
      try {
        socket.destroy();
      } catch {
        // socket đã đóng — bỏ qua.
      }
    });
  });

  return wss;
}
