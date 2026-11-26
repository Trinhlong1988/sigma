// SIGMA Phase 3 "real-time" (29/7) — WebSocket THẬT cho hệ chat lõi tự xây (`/v1/chat-realtime`), THAY THẾ
// dần rc-realtime-proxy.ts (relay bot-api⇄Rocket.Chat cho hệ CŨ) cho phần CHAT TEXT. Đọc rc-realtime-proxy.ts
// làm MẪU (copy pattern upgrade/cookie/giới hạn kết nối/đóng phiên hết hạn) — KHÔNG sửa file đó, chỉ import lại
// đúng những gì dùng chung được (parseCookieHeader thuần, SESSION_EXPIRED_CLOSE_CODE — cùng ý nghĩa "phiên
// không hợp lệ" bất kể endpoint nào, client (chat-realtime.ts) coi cùng 1 tín hiệu).
//
// KHÁC BIỆT CỐ Ý so với rc-realtime-proxy.ts (không phải copy nhầm):
//   1. KHÔNG có "phía trên" (Rocket.Chat) để bắc cầu — mọi sự kiện SINH RA từ chính bot-api (routes/chat.ts gọi
//      broadcastToRoom() sau khi ghi DB), hub (chat-realtime-hub.ts) chỉ phát lại cho subscriber cùng phòng.
//   2. XÁC THỰC agentId — "SỬA LẦN 2" (session-middleware.ts, 27/7): `requireSession` ĐÃ TỪNG sai khi ưu tiên
//      thẳng `webSession.agentId` (có thể SAI/CŨ nếu route khác ghi đè) — bài học đó áp NGAY TỪ ĐẦU ở đây, KHÔNG
//      lặp lại lỗi cũ của rc-realtime-proxy.ts (file đó CHỈ dùng `session.agentId` trần, đủ cho mục đích presence-
//      tracking phụ trợ của nó — nhưng ở ĐÂY agentId dùng để CHECK QUYỀN THÀNH VIÊN PHÒNG thật, sai agentId =
//      lộ/chặn nhầm tin nhắn của người khác, rủi ro cao hơn hẳn). PHẢI resolve ĐÚNG cùng thứ tự ưu tiên
//      requireSession: rcUserId trước (nguồn chân lý, RC tự xác nhận) → agentId CHỈ dùng khi rcUserId rỗng.
//   3. Giới hạn số kết nối đồng thời — Map RIÊNG (activeConnectionCountBySession dưới đây), KHÔNG dùng chung
//      counter với rc-realtime-proxy.ts (2 endpoint độc lập, 1 agent có thể mở cả 2 loại kết nối cùng lúc trong
//      giai đoạn chạy song song, không nên cộng dồn chung 1 giới hạn).
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { getBotDb } from './db.js';
import { getWebSession, WEB_SESSION_COOKIE_NAME, setSessionKickHandler, type WebSessionRecord } from './web-session-service.js';
import { parseCookieHeader, SESSION_EXPIRED_CLOSE_CODE, SESSION_REVOKED_CLOSE_CODE } from './ws-cookie-session.js';
import { isAllowedWsOrigin } from './ws-origin-check.js';
import { assertActiveMember, ChatServiceError } from './services/chat-room-service.js';
import { isAccountDeactivated } from './deletion-service.js';
import {
  subscribeToRoom,
  unsubscribeFromRoom,
  unsubscribeAllForConnection,
  broadcastToRoom,
  registerAgentConnection,
  unregisterAgentConnection,
  agentHasOpenConnection,
  agentPresenceOnline,
  setPresenceGraceOfflineHandler,
  type ChatRealtimeConnection
} from './chat-realtime-hub.js';
import { broadcastPresenceUpdate } from './presence-service.js';
import type { Db } from '@sigma/database';

// Export path để guard "đóng upgrade path lạ" (ws-upgrade-guard.ts, index.ts) biết đây là 1 WS path HỢP LỆ.
export const CHAT_REALTIME_PATH = '/v1/chat-realtime';
const PROXY_PATH = CHAT_REALTIME_PATH;

// Giới hạn kết nối đồng thời/1 WebSession — CÙNG NGƯỠNG rc-realtime-proxy.ts (5) nhưng đếm RIÊNG (xem điểm 3
// đầu file). Quy mô ~400 user, ngưỡng này đủ dư cho nhiều tab/thiết bị mà vẫn chặn được rò rỉ kết nối bất
// thường (client lỗi tự mở lại liên tục không đóng cái cũ).
const MAX_CONCURRENT_WS_PER_SESSION = 5;
const activeConnectionCountBySession = new Map<string, number>();

// #3 (6/8, Admin Demo "đăng nhập máy mới đá phiên CŨ CÙNG NỀN như Zalo") — index sessionId → tập MỌI socket đang
// mở của phiên đó, để ĐÓNG đúng những socket của các phiên vừa bị đá (revokeOtherSessionsSamePlatform gọi
// kick-handler với danh sách sessionId). KHÁC activeConnectionCountBySession (chỉ ĐẾM số) — ở đây cần giữ tham
// chiếu socket thật để gửi 'session-revoked' + close(). Đăng ký lúc bindConnection, dọn lúc 'close'.
const socketsBySession = new Map<string, Set<WebSocket>>();

function registerSocketForSession(sessionId: string, ws: WebSocket): void {
  let set = socketsBySession.get(sessionId);
  if (!set) {
    set = new Set();
    socketsBySession.set(sessionId, set);
  }
  set.add(ws);
}
function unregisterSocketForSession(sessionId: string, ws: WebSocket): void {
  const set = socketsBySession.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) socketsBySession.delete(sessionId);
}

/** #3 — đá (gửi 'session-revoked' rồi đóng) MỌI socket realtime của các sessionId vừa bị thu hồi. Best-effort
 * tuyệt đối: 1 socket lỗi KHÔNG chặn các socket còn lại (mỗi thao tác bọc try/catch qua safeSend + close). */
function kickSessions(sessionIds: string[]): void {
  for (const sid of sessionIds) {
    const set = socketsBySession.get(sid);
    if (!set) continue;
    for (const ws of [...set]) {
      safeSend(ws, { msg: 'session-revoked', reason: 'logged-in-elsewhere' });
      try {
        ws.close(SESSION_REVOKED_CLOSE_CODE);
      } catch {
        // socket đã đóng/hỏng — 'close' sẽ tự dọn registry, bỏ qua.
      }
    }
  }
}

function incrementConnectionCount(sessionId: string): number {
  const next = (activeConnectionCountBySession.get(sessionId) ?? 0) + 1;
  activeConnectionCountBySession.set(sessionId, next);
  return next;
}
function decrementConnectionCount(sessionId: string): void {
  const cur = activeConnectionCountBySession.get(sessionId);
  if (cur === undefined) return;
  if (cur <= 1) activeConnectionCountBySession.delete(sessionId);
  else activeConnectionCountBySession.set(sessionId, cur - 1);
}

/** Cho test reset counter giữa các case (module-level Map, không tự reset qua boundary vitest). */
export function resetChatRealtimeConnectionCountForTest(): void {
  activeConnectionCountBySession.clear();
  socketsBySession.clear();
}

/** #3 — cho test đếm số socket đang mở của 1 session trong registry đá-phiên (socketsBySession). */
export function getSessionSocketCountForTest(sessionId: string): number {
  return socketsBySession.get(sessionId)?.size ?? 0;
}

/** Cho test đọc số kết nối đang đếm của 1 session (kiểm counter KHÔNG bị rò khi handshake fail giữa chừng — C2). */
export function getChatRealtimeConnectionCountForTest(sessionId: string): number {
  return activeConnectionCountBySession.get(sessionId) ?? 0;
}

// PRESENCE real-time (6/8, Admin Demo "offline gần-tức-thì, KHÔNG chờ phút") — HẠ chu kỳ ping/pong từ 30s → 15s để
// phát hiện kết nối CHẾT ĐỘT NGỘT (airplane/rớt sóng/kill không gửi 'close' TCP đúng chuẩn) trong ~15-30s (2 chu
// kỳ, đặc tính chuẩn của heartbeat ping/pong thư viện `ws` — xem comment sweep trong attachChatRealtimeProxy).
// TENTATIVE (Admin Demo/LEAD tinh chỉnh): 15s cân bằng giữa "phát hiện nhanh" và "không đóng nhầm kết nối chỉ đang
// chậm mạng". Khi terminate → 'close' bắn → bindConnection close handler phát presence-offline realtime NGAY.
const HEARTBEAT_INTERVAL_MS = 15_000;

interface HeartbeatSocket extends WebSocket {
  isAlive?: boolean;
}

/** Hook vào HTTP server thật (index.ts) — lắng nghe upgrade request tại `/v1/chat-realtime`, bỏ qua mọi upgrade
 * request khác (path check tường minh — CÙNG lý do rc-realtime-proxy.ts, để không "nuốt" nhầm upgrade của
 * endpoint khác nếu sau này có thêm). `heartbeatIntervalMs` optional CHỈ để test tiêm chu kỳ ngắn hơn (CÙNG
 * mẫu `call-signaling-server.ts` `attachCallSignaling()` — production KHÔNG truyền, dùng mặc định 30s). */
export function attachChatRealtimeProxy(server: HttpServer, options: { heartbeatIntervalMs?: number } = {}): WebSocketServer {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const wss = new WebSocketServer({ noServer: true });

  // PRESENCE grace-timer (6/8, phương án 1) — TIÊM handler phát offline khi grace-timer WS-close hết (hub không có
  // DB/không import presence-service để tránh vòng phụ thuộc). closedAtMs = thời điểm WS đóng → lastSeenAt đúng
  // ("X phút trước" tính từ lúc rời, KHÔNG phải lúc timer chạy). Best-effort (broadcastPresenceUpdate tự nuốt lỗi).
  setPresenceGraceOfflineHandler((agentId, closedAtMs) => {
    void broadcastPresenceUpdate(getBotDb(), agentId, false, { lastSeenAt: new Date(closedAtMs).toISOString() });
  });

  // #3 (6/8) — đăng ký kick-handler để revokeOtherSessionsSamePlatform (web-session-service.ts, gọi từ luồng
  // đăng nhập) có thể ĐÓNG socket realtime của các phiên vừa bị đá cùng nền. TIÊM qua setter (không import
  // ngược service→proxy) — CÙNG khuôn setPresenceGraceOfflineHandler ngay trên.
  setSessionKickHandler(kickSessions);

  // B115-tiếp-đính-chính (2/8, review độc lập tìm ra) — TRƯỚC ĐÂY mỗi kết nối tự có `setInterval` RIÊNG
  // (trong bindConnection) với `isAlive` khởi tạo `true` — lượt tick ĐẦU TIÊN không phát hiện được gì (chỉ
  // set isAlive=false rồi ping), phải đợi lượt tick THỨ HAI mới kết luận "chết" → cửa sổ tệ nhất ~2×interval
  // (~60s) trong khi comment cũ ngụ ý chỉ 30s. Trong cửa sổ đó `agentHasOpenConnection()` (chat-realtime-hub.ts)
  // vẫn báo `true` cho 1 kết nối ĐÃ CHẾT THẬT (khóa máy/rớt mạng đột ngột không gửi 'close' TCP đúng chuẩn) →
  // `notifyRoomMembersOfNewMessage()` (routes/chat.ts) tưởng còn WS sống nên KHÔNG gửi push, trong khi WS thật
  // sự không tới được nữa → người nhận mất tin nhắn hoàn toàn không cảnh báo trong cửa sổ đó.
  // Đổi sang CÙNG pattern "sweep toàn cục 1 interval duy nhất" đã có sẵn + verify đúng ở call-signaling-
  // server.ts (audit độc lập 30/7 HIGH) — GIỮ NGUYÊN đặc tính lý thuyết "cần 2 chu kỳ để chắc chắn 1 kết nối
  // chết" (đây là đặc tính CHUẨN, KHÔNG TRÁNH ĐƯỢC của mọi heartbeat ping/pong đúng chuẩn thư viện `ws` —
  // xiết chặt hơn nữa sẽ gây false-positive đóng nhầm kết nối chỉ đang chậm mạng thật), nhưng dùng CHUNG 1
  // lịch trình cố định cho MỌI kết nối thay vì mỗi kết nối tự set giờ riêng theo lúc nó connect — khớp đúng
  // hành vi ĐÃ ĐƯỢC KIỂM CHỨNG của call-signaling-server.ts, không tự nghĩ ra biến thể mới.
  const heartbeatTimer: NodeJS.Timeout = setInterval(() => {
    for (const client of wss.clients) {
      const hbClient = client as HeartbeatSocket;
      if (hbClient.isAlive === false) {
        hbClient.terminate();
        continue;
      }
      hbClient.isAlive = false;
      try {
        hbClient.ping();
      } catch {
        // kết nối đã hỏng — 'close' sẽ tự bắn ngay sau, không cần xử lý thêm ở đây.
      }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();
  wss.on('close', () => clearInterval(heartbeatTimer));

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? '';
    if (!url.startsWith(PROXY_PATH)) return;

    // CSWSH (Cross-Site WebSocket Hijacking): kiểm Origin TRƯỚC khi làm bất cứ việc gì (trước cả tra cookie/DB)
    // — trình duyệt KHÔNG áp same-origin cho WebSocket, nên trang web độc hại có thể mở WS xác thực bằng cookie
    // phiên của nạn nhân. Origin lạ → đóng thô NGAY (socket.destroy), KHÔNG hoàn tất handshake (kẻ tấn công
    // không đáng nhận tín hiệu sạch, và không có client hợp lệ nào cần thông báo). Xem ws-origin-check.ts cho
    // quyết định ca native (Origin rỗng/https://localhost) — CHUNG allowlist với CORS (cors-allowlist.ts).
    if (!isAllowedWsOrigin(req.headers.origin)) {
      try {
        socket.destroy();
      } catch {
        // socket đã đóng — bỏ qua.
      }
      return;
    }

    handleUpgrade(req, socket, head, wss).catch((err) => {
      console.error('[bot-api] chat-realtime-proxy: lỗi xử lý upgrade:', err);
      try {
        socket.destroy();
      } catch {
        // socket đã đóng — bỏ qua.
      }
    });
  });

  return wss;
}

function rejectWithSessionExpired(req: IncomingMessage, socket: Socket, head: Buffer, wss: WebSocketServer): void {
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    clientWs.close(SESSION_EXPIRED_CLOSE_CODE);
  });
}

/** Resolve agentId THẬT của phiên — CÙNG ĐÚNG thứ tự ưu tiên `requireSession` (session-middleware.ts, xem
 * comment "SỬA LẦN 2" ở đó): rcUserId trước (nếu có) → agentId CHỈ dùng khi rcUserId rỗng → null nếu không tra
 * được Agent nào còn sống (deletedAt: null) theo 1 trong 2 nhánh đó. KHÔNG BAO GIỜ trust thẳng
 * `session.agentId` như rc-realtime-proxy.ts (đó là quyết định CỐ Ý khác nhau, xem điểm 2 đầu file). */
async function resolveAgentId(db: Db, session: WebSessionRecord): Promise<number | null> {
  const agent = session.rcUserId
    ? await db.agent.findFirst({ where: { rcUserId: session.rcUserId, deletedAt: null }, select: { id: true, deletedAt: true, deletionRequestedAt: true } })
    : session.agentId != null
      ? await db.agent.findFirst({ where: { id: session.agentId, deletedAt: null }, select: { id: true, deletedAt: true, deletionRequestedAt: true } })
      : null;
  // BUG "tài khoản đã xóa vẫn 'đang hoạt động' + nhận/gửi realtime" (5/8, Admin Demo) — tài khoản đã VÔ HIỆU HÓA
  // (deletionRequestedAt đang chờ xóa HOẶC deletedAt đã xóa) KHÔNG được mở phiên realtime (không subscribe/gõ
  // typing/nhận broadcast) — CÙNG 1 nguồn điều kiện isAccountDeactivated() với sendMessage(). deletedAt đã bị
  // where lọc sẵn; điều kiện dưới thêm nhánh deletionRequestedAt (48h ân hạn) mà where không bắt. Từ chối như
  // "phiên hết hạn" (client quay về /login) — chủ tài khoản muốn hủy xóa vẫn dùng REST /v1/me/cancel-deletion.
  if (!agent || isAccountDeactivated(agent)) return null;
  return agent.id;
}

async function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer, wss: WebSocketServer): Promise<void> {
  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionId = cookies[WEB_SESSION_COOKIE_NAME];
  if (!sessionId) {
    rejectWithSessionExpired(req, socket, head, wss);
    return;
  }

  const db = getBotDb();
  const session = await getWebSession(db, sessionId);
  if (!session) {
    rejectWithSessionExpired(req, socket, head, wss);
    return;
  }

  const agentId = await resolveAgentId(db, session);
  if (agentId === null) {
    // Phiên RC hợp lệ nhưng KHÔNG (còn) liên kết Agent nào (chưa link/đã xóa tài khoản) — CÙNG ý nghĩa
    // "AGENT_NOT_LINKED" của requireSession, nhưng ở tầng WS chỉ có 1 tín hiệu đóng chung, dùng lại
    // SESSION_EXPIRED_CLOSE_CODE (client không cần phân biệt lý do — đều cần quay lại /login).
    rejectWithSessionExpired(req, socket, head, wss);
    return;
  }

  if (incrementConnectionCount(sessionId) > MAX_CONCURRENT_WS_PER_SESSION) {
    decrementConnectionCount(sessionId);
    socket.destroy();
    return;
  }

  // C2 (LANE A Vòng 2, 3/8) — RÒ COUNTER khi handshake fail giữa chừng: TRƯỚC ĐÂY decrement CHỈ gắn trong
  // callback của wss.handleUpgrade. Nếu handshake KHÔNG BAO GIỜ hoàn tất (socket chết/bị đóng SAU khi đã
  // incrementConnectionCount nhưng TRƯỚC khi callback chạy) thì decrement không bao giờ chạy → 1 slot bị chiếm
  // vĩnh viễn, tích lũy đủ MAX_CONCURRENT_WS_PER_SESSION lần thì session bị khóa oan không mở được WS nào nữa.
  // SỬA: gắn release lên CẢ socket thô ('close' bắn kể cả khi handshake chưa hoàn tất) LẪN clientWs sau khi
  // handshake xong; guard `released` đảm bảo decrement ĐÚNG 1 lần dù cả 2 cùng bắn (lúc hoạt động bình thường
  // clientWs 'close' và socket 'close' đều bắn).
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    decrementConnectionCount(sessionId);
  };
  // Gắn lên NHIỀU sự kiện của socket thô: 'close' (đóng hẳn), 'end' (peer FIN — half-open, KHÔNG bắn 'close'
  // nếu server chưa đóng phía mình), 'error' (ECONNRESET...). Bất kỳ cái nào xảy ra TRƯỚC khi handshake hoàn
  // tất đều release counter (guard `released` → decrement đúng 1 lần). Chỉ decrement counter, KHÔNG destroy
  // socket ở đây (tránh làm sai close-code của clientWs ở luồng đóng bình thường).
  socket.once('close', release);
  socket.once('end', release);
  socket.once('error', release);

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    clientWs.once('close', release);
    bindConnection(clientWs, db, agentId, sessionId);
  });
}

type ClientMessage =
  | { type: 'subscribe-room'; roomId: string }
  | { type: 'unsubscribe-room'; roomId: string }
  | { type: 'typing'; roomId: string; isTyping: boolean };

function parseClientMessage(raw: string): ClientMessage | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.type === 'subscribe-room' && typeof data.roomId === 'string' && data.roomId) {
    return { type: 'subscribe-room', roomId: data.roomId };
  }
  if (data.type === 'unsubscribe-room' && typeof data.roomId === 'string' && data.roomId) {
    return { type: 'unsubscribe-room', roomId: data.roomId };
  }
  if (data.type === 'typing' && typeof data.roomId === 'string' && data.roomId) {
    return { type: 'typing', roomId: data.roomId, isTyping: !!data.isTyping };
  }
  return null;
}

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error('[bot-api] chat-realtime-proxy: gửi message xuống client thất bại (bỏ qua, best-effort):', err);
  }
}

/** TICK "đã nhận" (6/8) — agent VỪA online → phát `delivery-receipt` (agentId, deliveredAt=now) tới MỌI phòng
 * họ đang tham gia, để người GỬI đang xem phòng đó đổi tick tin của họ sang "đã nhận" (2 tick xám). CÙNG shape
 * `delivery-receipt` với broadcastDeliveryReceipt() (routes/chat.ts) — inline ở đây (như typing-indicator) để
 * KHÔNG import ngược route vào proxy (tránh vòng phụ thuộc). Best-effort: lỗi DB KHÔNG được làm hỏng kết nối
 * (chỉ log, R198). broadcastToRoom tự no-op nếu không ai đang xem phòng đó. */
async function broadcastDeliveryOnConnect(db: Db, agentId: number): Promise<void> {
  try {
    const memberships = await db.chatRoomMember.findMany({ where: { agentId, leftAt: null }, select: { roomId: true } });
    const deliveredAt = new Date();
    for (const m of memberships) {
      broadcastToRoom(m.roomId, { msg: 'delivery-receipt', roomId: m.roomId, agentId, deliveredAt });
    }
  } catch (err) {
    console.error(`[bot-api] chat-realtime-proxy: broadcast delivery-on-connect thất bại cho agentId=${agentId} (best-effort):`, err);
  }
}

/** Gắn toàn bộ vòng đời 1 kết nối đã xác thực: gửi `ready`, xử lý subscribe/unsubscribe/typing, dọn sạch
 * subscription khi đóng. Heartbeat ping/pong dọn kết nối chết giờ chạy ở 1 sweep TOÀN CỤC DUY NHẤT trong
 * `attachChatRealtimeProxy()` (xem comment ở đó) — hàm này CHỈ khởi tạo `isAlive=true` lúc connect + cập nhật
 * lại lúc nhận 'pong', KHÔNG tự set interval riêng nữa. */
function bindConnection(clientWs: WebSocket, db: Db, agentId: number, sessionId: string): void {
  const conn: ChatRealtimeConnection = { ws: clientWs, agentId, sessionId };
  const subscribedRoomIds = new Set<string>(); // theo dõi RIÊNG ở đây để dọn sạch lúc 'close' (đối chiếu hub).

  // #3 (6/8) — index socket này theo sessionId để đá được khi phiên bị thu hồi cùng nền (kickSessions). Dọn ở
  // 'close' bên dưới.
  registerSocketForSession(sessionId, clientWs);

  // TICK "đã nhận" (6/8, Admin Demo "online → đã nhận DÙ chưa mở phòng") — agent VỪA online (đây là kết nối ĐẦU
  // TIÊN, chưa có WS nào khác đang mở TRƯỚC lượt đăng ký dưới) → mọi tin gửi cho họ trong các phòng họ tham gia
  // giờ coi như ĐÃ GIAO. Tính `wasOffline` TRƯỚC registerAgentConnection (sau đó agentHasOpenConnection thành
  // true). Nếu đã có kết nối khác (tab/thiết bị) → KHÔNG phát lại (người gửi đã biết online từ lần connect trước).
  const wasOffline = !agentHasOpenConnection(agentId);
  // PRESENCE real-time (6/8) — TRẠNG THÁI online TRƯỚC lượt đăng ký này (WS sống HOẶC nhịp sống gần đây). Nếu
  // TRƯỚC đó CHƯA online (agent thật sự vừa từ offline lên) → sau khi đăng ký sẽ phát presence-online. Dùng
  // agentPresenceOnline (KHÔNG chỉ agentHasOpenConnection) để KHÔNG phát trùng khi agent đã "online" nhờ FCM-ping
  // gần đây (lastSeen còn tươi) — tránh nhấp nháy/thừa sự kiện.
  const wasOnlineBefore = agentPresenceOnline(agentId);

  // B115-tiếp (2/8) — đăng ký registry cấp-agent NGAY lúc kết nối xác thực xong, KHÔNG đợi subscribe-room nào
  // (kết nối này CẦN nhận được broadcastToAgent() dù agent đang đứng ở màn nào trong app — vd danh sách chat/
  // Cài đặt, chưa từng subscribe phòng nào). Xem chat-realtime-hub.ts registerAgentConnection().
  registerAgentConnection(agentId, conn);

  if (wasOffline) void broadcastDeliveryOnConnect(db, agentId);
  // Vừa chuyển OFFLINE→ONLINE → phát presence-update online realtime cho bạn bè/đồng-thành-viên (0 độ trễ,
  // Admin Demo 6/8). Best-effort (broadcastPresenceUpdate tự nuốt lỗi có log, KHÔNG throw).
  if (!wasOnlineBefore) void broadcastPresenceUpdate(db, agentId, true);

  const hbWs = clientWs as HeartbeatSocket;
  hbWs.isAlive = true;
  clientWs.on('pong', () => {
    hbWs.isAlive = true;
  });

  safeSend(clientWs, { msg: 'ready' });

  clientWs.on('message', (raw) => {
    void handleClientMessage(raw.toString());
  });

  async function handleClientMessage(raw: string): Promise<void> {
    const message = parseClientMessage(raw);
    if (!message) return; // JSON hỏng/không khớp giao thức — bỏ qua im lặng, KHÔNG đóng kết nối vì 1 message lạ.

    if (message.type === 'subscribe-room') {
      try {
        await assertActiveMember(db, message.roomId, agentId);
      } catch (err) {
        // Sai quyền (KHÔNG phải thành viên phòng) hoặc lỗi bất ngờ khác — trả `error` cho ĐÚNG request đó,
        // KHÔNG đóng kết nối (agent vẫn có thể đang subscribe hợp lệ các phòng KHÁC qua CÙNG kết nối này).
        const code = err instanceof ChatServiceError ? err.code : 'SUBSCRIBE_FAILED';
        safeSend(clientWs, { msg: 'error', code, roomId: message.roomId });
        return;
      }
      subscribeToRoom(message.roomId, conn);
      subscribedRoomIds.add(message.roomId);
      safeSend(clientWs, { msg: 'subscribed', roomId: message.roomId });
      return;
    }

    if (message.type === 'unsubscribe-room') {
      unsubscribeFromRoom(message.roomId, conn);
      subscribedRoomIds.delete(message.roomId);
      return;
    }

    if (message.type === 'typing') {
      // Typing indicator KHÔNG cần kiểm lại quyền thành viên ở đây — CHỈ phát cho những ai ĐANG subscribe
      // đúng phòng đó (broadcastToRoom tự giới hạn phạm vi phát), và chỉ subscribe được sau khi đã qua
      // assertActiveMember() ở nhánh trên — không có đường nào 1 agent ngoài phòng lại "nghe lỏm" được chỉ
      // báo gõ chữ. Loại trừ CHÍNH agent đang gõ khỏi người nhận (CÙNG hành vi RC cũ đã verify thật — sender
      // không tự nhận lại broadcast của chính mình, xem rc-realtime.ts).
      broadcastToRoom(message.roomId, { msg: 'typing-indicator', roomId: message.roomId, agentId, isTyping: message.isTyping }, { excludeAgentId: agentId });
      return;
    }
  }

  clientWs.on('close', () => {
    unsubscribeAllForConnection(conn);
    unregisterSocketForSession(sessionId, clientWs); // #3 — dọn khỏi index đá-phiên.
    // PRESENCE grace-timer (6/8, phương án 1 — Admin Demo) — KHÔNG phát offline NGAY nữa. unregisterAgentConnection
    // tự hẹn grace 10s khi đây là WS CUỐI (giữ online 10s, đồng bộ với agentPresenceOnline; reconnect trong 10s
    // hủy timer chống nháy; hết 10s → grace-offline-handler ở attachChatRealtimeProxy phát offline). Offline-tường-
    // minh (POST /v1/presence/offline) đi ngay, bỏ grace — xem routes/presence.ts + markAgentOffline (hub).
    unregisterAgentConnection(agentId, conn);
    subscribedRoomIds.clear();
  });
  clientWs.on('error', (err) => {
    console.error('[bot-api] chat-realtime-proxy: lỗi kết nối client:', err);
  });
}
