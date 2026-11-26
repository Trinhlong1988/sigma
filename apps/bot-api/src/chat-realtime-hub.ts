// SIGMA Phase 3 "real-time" (29/7) — hub broadcast NỘI BỘ trong RAM cho hệ chat lõi tự xây (Phase 2:
// chat_rooms/chat_room_members/chat_messages/chat_message_reactions). KHÁC HẲN rc-realtime-proxy.ts (file đó
// relay 2 chiều bot-api⇄Rocket.Chat cho hệ CŨ đang bị thay thế) — hub này KHÔNG có "phía trên" nào để relay,
// bot-api tự SINH RA sự kiện (routes/chat.ts gọi broadcastToRoom() ngay sau khi ghi DB thành công) và tự PHÁT
// LẠI cho mọi kết nối WebSocket đang subscribe đúng phòng đó — xem chat-realtime-proxy.ts (nơi DUY NHẤT gọi
// các hàm subscribe/unsubscribe ở đây lúc runtime).
//
// GIỚI HẠN QUAN TRỌNG (ghi rõ cho tương lai scale ngang): state (Map roomId→Set<connection>) sống HOÀN TOÀN
// trong RAM của 1 PROCESS bot-api DUY NHẤT — KHÔNG dùng Redis pub/sub hay bất kỳ cơ chế chia sẻ state nào giữa
// nhiều instance. Nếu sau này bot-api chạy ≥2 instance (load-balancer/PM2 cluster...), 1 broadcast chỉ tới được
// các client đang kết nối ĐÚNG instance đó — client kết nối instance khác SẼ KHÔNG nhận được tin nhắn real-time
// (vẫn tải được qua REST khi mở lại phòng, chỉ mất tính "ngay lập tức"). Quy mô hiện tại (~400 user, 1 process
// duy nhất, xem CLAUDE.md workspace) chưa cần xử lý — khi cần scale ngang PHẢI thêm 1 lớp pub/sub dùng chung
// (Redis/NATS...) để mọi instance đồng bộ được ai đang subscribe phòng nào.
import type { WebSocket } from 'ws';

/** 1 kết nối WebSocket đã xác thực (agentId/sessionId đã resolve xong ở chat-realtime-proxy.ts) đang subscribe
 * ít nhất 1 phòng. Định danh theo THAM CHIẾU object (KHÔNG có id riêng) — proxy tạo đúng 1 object này cho mỗi
 * kết nối, dùng lại y nguyên object đó cho mọi lần gọi subscribe/unsubscribe/broadcast liên quan tới nó. */
export interface ChatRealtimeConnection {
  ws: WebSocket;
  agentId: number;
  sessionId: string;
}

// B115-tiếp (2/8, Admin Demo "phải thông báo push nổi màn hình bất kể trường hợp nào như zalo") — registry MỚI
// SONG SONG roomSubscribers: agentId → tập MỌI kết nối đã xác thực của agent đó, BẤT KỂ đang subscribe phòng
// nào (hoặc chưa subscribe phòng nào cả — vd đang đứng ở danh sách chat/màn Cài đặt). CÙNG Ý TƯỞNG
// `connectionsByAgentId`/`broadcastToAgent()` đã có sẵn ở call-signaling-server.ts (blueprint đúng theo yêu
// cầu tái dùng, KHÔNG viết logic khác biệt vô cớ) — khác `roomSubscribers` (phát theo PHÒNG cho người ĐANG XEM
// đúng phòng), registry này phát theo AGENT cho MỌI kết nối bất kể đang xem gì, dùng để đánh thức banner/toast
// trong-app khi KHÔNG ở đúng phòng vừa có tin mới (case B115 #2) + biết agent có kết nối WS sống nào không
// (agentHasOpenConnection(), quyết định có cần bắn thêm push FCM hay không — CÙNG logic
// `calleeHasOpenConnection` ở call-signaling-server.ts, tránh double-notify khi app đang mở).
const agentConnections = new Map<number, Set<ChatRealtimeConnection>>();

// PRESENCE "còn đăng nhập + thiết bị còn kết nối được" (6/8, Admin Demo: online = như Zalo/PC, KHÔNG phải "app đang
// mở"; realtime KHÔNG độ trễ). Nguồn presence = WS-sống HOẶC "nhịp sống gần đây" (lastSeen) trong 1 CỬA SỔ NGẮN
// dành cho ca thiết-bị-còn-mạng-nhưng-không-có-WS-thường-trực (chủ yếu app bị KILL trên Android được đánh thức
// bằng FCM-ping → POST /v1/presence/ping → cập nhật lastSeen). KHÁC HẲN `agentHasOpenConnection()` (chỉ đếm WS
// thật, dùng để quyết định có cần bắn FCM push không — ngữ nghĩa "có socket sống", KHÔNG phải "người này online").
//
// GHI CHÚ HƯỚNG THIẾT KẾ (Admin Demo 6/8): offline PHẢI gần-tức-thì, KHÔNG chờ timeout dài. Vì vậy cửa sổ này CHỈ là
// "grace chờ pong/ping" NGẮN cho ca rớt đột ngột — KHÔNG phải cơ chế giữ-online-lâu. Giữ-online khi nền/clear-app
// được giải quyết bằng GIỮ KẾT NỐI WS sống (desktop tray / mobile giữ WS + reconnect nhanh) + FCM-ping cho app đã
// kill, KHÔNG bằng nới rộng ngưỡng này.
const agentLastSeenAt = new Map<number, number>();

// FIX PRESENCE (11/8, Admin Demo: thiết bị mở app nhưng KHÔNG giữ WS thường trực — chủ yếu APK chạy nền — bị coi
// offline sai) — nguồn presence "nhịp sống REST" (POST /v1/presence/ping) có CỬA SỔ RIÊNG, ĐỘC LẬP với cửa sổ
// grace WS-close. GỐC BUG cũ: dùng CHUNG 1 cửa sổ 10s cho cả 2 nguồn, trong khi client ping thưa hơn (45s) →
// mỗi chu kỳ agent "offline" ~35s dù đang online → account khác thấy "vừa mới truy cập" nhấp nháy. Tách riêng:
// agentHeartbeatAt (mốc ping REST gần nhất) + PRESENCE_HEARTBEAT_TTL_MS (40s) — đủ RỘNG để chịu ping 15s (client
// mới) rớt 1 nhịp (30s ≤ 40s) mà KHÔNG nháy offline. GIỮ NGUYÊN PRESENCE_STALE_MS=10s cho grace WS-close (đứt WS
// vẫn offline nhanh theo yêu cầu Admin Demo 6/8) — 2 nguồn KHÔNG lẫn nhau (xem agentPresenceOnline + unregisterAgentConnection).
const agentHeartbeatAt = new Map<number, number>();

/** Cửa sổ "grace" WS-close (ms) — Admin Demo chốt 6/8 phương án 1 = 10s. DÙNG CHO grace-timer WS-close (giữ online
 * 10s sau khi WS CUỐI đóng, chống nháy reconnect chớp nhoáng) + nhánh (c) của `agentPresenceOnline` (người MỚI mở
 * danh bạ thấy GIỐNG người đang xem: online 10s sau khi WS đóng rồi offline). KHÔNG áp cho nguồn heartbeat REST —
 * nguồn đó dùng PRESENCE_HEARTBEAT_TTL_MS riêng (thưa hơn). Chống nháy + đồng bộ tuyệt đối 2 hướng. */
export const PRESENCE_STALE_MS = 10_000;

/** Cửa sổ "nhịp sống REST còn tươi" (ms) — cho nguồn heartbeat POST /v1/presence/ping (thiết bị còn mạng nhưng
 * KHÔNG giữ WS thường trực, chủ yếu APK nền được FCM-ping đánh thức). 40s: BẤT BIẾN "2×ping ≤ TTL" với client
 * ping 15s (presence-heartbeat.ts) → rớt ĐÚNG 1 nhịp (30s) vẫn < 40s → KHÔNG nháy offline; ping thứ 3 (45s) mới
 * hết hạn. ĐỘC LẬP với PRESENCE_STALE_MS (grace WS-close 10s) — heartbeat KHÔNG rút ngắn theo cửa sổ WS. */
export const PRESENCE_HEARTBEAT_TTL_MS = 40_000;

// GRACE-TIMER WS-close (6/8, phương án 1) — khi WS CUỐI của agent đóng, KHÔNG offline NGAY mà hẹn giờ 10s; nếu
// có WS mới trong 10s (reconnect chớp nhoáng) → HỦY timer (giữ online). Hết 10s không reconnect → GIỜ mới phát
// offline (lastSeenAt = thời điểm ĐÓNG). Map agentId → timer đang chờ.
const graceOfflineTimers = new Map<number, ReturnType<typeof setTimeout>>();

// Cờ "đã offline TƯỜNG MINH" (agent gọi POST /v1/presence/offline: mất mạng/máy bay/đăng xuất — CHẮC CHẮN offline,
// bỏ qua grace). Chống ĐUA (race) logout: /offline tới TRƯỚC lúc WS đóng thật → khi WS đóng sau đó,
// unregisterAgentConnection thấy cờ này → KHÔNG re-online / KHÔNG hẹn lại grace (nếu không có cờ, WS-close sẽ set
// lastSeen=now làm agent "online" lại 10s + hẹn 1 offline nữa → người mới mở danh bạ thấy XANH nhầm sau logout).
const explicitlyOfflineAgents = new Set<number>();

/** Handler PHÁT offline khi grace-timer hết (không reconnect) — TIÊM từ chat-realtime-proxy.ts
 * (setPresenceGraceOfflineHandler) vì hub KHÔNG có DB/không import presence-service (tránh vòng phụ thuộc:
 * presence-service đã import broadcastToAgent của hub). `closedAtMs` = thời điểm WS đóng (cho lastSeenAt đúng). */
let graceOfflineHandler: ((agentId: number, closedAtMs: number) => void) | null = null;

/** Đăng ký handler phát offline sau grace (gọi 1 lần lúc attachChatRealtimeProxy). */
export function setPresenceGraceOfflineHandler(fn: (agentId: number, closedAtMs: number) => void): void {
  graceOfflineHandler = fn;
}

/** Hủy grace-timer đang chờ của agent (reconnect / markAgentSeen / markAgentOffline / offline tường minh). */
function cancelGraceOfflineTimer(agentId: number): void {
  const t = graceOfflineTimers.get(agentId);
  if (t !== undefined) {
    clearTimeout(t);
    graceOfflineTimers.delete(agentId);
  }
}

// roomId → tập kết nối đang subscribe phòng đó.
const roomSubscribers = new Map<string, Set<ChatRealtimeConnection>>();
// Chiều ngược lại (connection → tập roomId đang subscribe) — CẦN để unsubscribeAllForConnection() dọn sạch
// TOÀN BỘ phòng của 1 kết nối khi đóng mà KHÔNG phải quét hết mọi phòng trong roomSubscribers (O(số phòng
// đang subscribe của kết nối đó) thay vì O(tổng số phòng đang có người xem toàn hệ thống)). WeakMap — KHÔNG
// giữ connection sống mãi nếu proxy lỡ quên gọi cleanup (tự do bộ nhớ khi ws bị GC), dù trong thực tế proxy
// LUÔN gọi unsubscribeAllForConnection() ở sự kiện 'close' (không dựa vào GC làm cơ chế dọn chính).
const connectionRooms = new WeakMap<ChatRealtimeConnection, Set<string>>();

/** Đăng ký 1 kết nối vào phòng `roomId` — idempotent (gọi lại nhiều lần cho cùng 1 cặp connection/roomId an
 * toàn, Set tự loại trùng). Proxy PHẢI tự kiểm quyền (agent có phải thành viên phòng không) TRƯỚC KHI gọi hàm
 * này — hub KHÔNG tự kiểm quyền gì (thuần cơ chế đăng ký/phát, không biết gì về nghiệp vụ phòng chat). */
export function subscribeToRoom(roomId: string, conn: ChatRealtimeConnection): void {
  let subs = roomSubscribers.get(roomId);
  if (!subs) {
    subs = new Set();
    roomSubscribers.set(roomId, subs);
  }
  subs.add(conn);

  let rooms = connectionRooms.get(conn);
  if (!rooms) {
    rooms = new Set();
    connectionRooms.set(conn, rooms);
  }
  rooms.add(roomId);
}

/** Hủy đăng ký 1 kết nối khỏi 1 phòng cụ thể (client tự gửi `unsubscribe-room`, vd rời màn hình chat của phòng
 * đó nhưng vẫn còn mở kết nối cho phòng khác). Idempotent — gọi với cặp connection/roomId chưa từng subscribe
 * KHÔNG throw. */
export function unsubscribeFromRoom(roomId: string, conn: ChatRealtimeConnection): void {
  const subs = roomSubscribers.get(roomId);
  if (subs) {
    subs.delete(conn);
    if (subs.size === 0) roomSubscribers.delete(roomId);
  }
  connectionRooms.get(conn)?.delete(roomId);
}

/** Dọn sạch MỌI phòng 1 kết nối đang subscribe — gọi ĐÚNG 1 lần khi kết nối đóng (proxy: sự kiện 'close').
 * Idempotent — gọi lại lần 2 (hoặc gọi cho 1 connection chưa từng subscribe gì) KHÔNG throw. */
export function unsubscribeAllForConnection(conn: ChatRealtimeConnection): void {
  const rooms = connectionRooms.get(conn);
  if (!rooms) return;
  for (const roomId of rooms) {
    const subs = roomSubscribers.get(roomId);
    if (subs) {
      subs.delete(conn);
      if (subs.size === 0) roomSubscribers.delete(roomId);
    }
  }
  connectionRooms.delete(conn);
}

/** Phát `payload` (sẽ tự JSON.stringify) tới MỌI kết nối đang subscribe `roomId`, TRỪ agentId trong
 * `opts.excludeAgentId` nếu có (dùng cho typing-indicator — RC cũ cũng tự loại trừ sender khỏi phát lại, xem
 * comment rc-realtime.ts khối "Typing indicator" điểm 4; các sự kiện khác như new-message KHÔNG loại trừ sender
 * — sender CŨNG cần nhận lại để đồng bộ các tab/thiết bị khác của chính họ, cùng hành vi RC cũ đã verify thật).
 *
 * BEST-EFFORT TUYỆT ĐỐI (R198 — nhưng broadcast là hạ tầng real-time PHỤ, KHÔNG phải check nghiệp vụ bắt buộc
 * hiển thị lỗi cho người dùng): hàm này KHÔNG BAO GIỜ throw ra ngoài — 1 kết nối gửi lỗi/đã chết chỉ bị log +
 * tự dọn khỏi Set (client đó coi như đã rớt mạng, sẽ tự resubscribe khi reconnect qua chat-realtime.ts phía
 * FE), KHÔNG được làm fail response REST của route đang gọi hàm này TRƯỚC res.json(). */
export function broadcastToRoom(roomId: string, payload: unknown, opts: { excludeAgentId?: number } = {}): void {
  const subs = roomSubscribers.get(roomId);
  if (!subs || subs.size === 0) return;

  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch (err) {
    console.error(`[chat-realtime-hub] broadcastToRoom: payload không serialize được JSON được (roomId=${roomId}), bỏ qua:`, err);
    return;
  }

  for (const conn of [...subs]) {
    if (opts.excludeAgentId !== undefined && conn.agentId === opts.excludeAgentId) continue;
    // WebSocket.OPEN === 1 — tránh import cả class WebSocket chỉ để so sánh readyState (conn.ws đã đủ kiểu).
    if (conn.ws.readyState !== 1) {
      subs.delete(conn);
      connectionRooms.get(conn)?.delete(roomId);
      continue;
    }
    try {
      conn.ws.send(text);
    } catch (err) {
      console.error(`[chat-realtime-hub] broadcastToRoom: gửi thất bại tới 1 kết nối (roomId=${roomId}, agentId=${conn.agentId}), dọn khỏi Set:`, err);
      subs.delete(conn);
      connectionRooms.get(conn)?.delete(roomId);
    }
  }
  if (subs.size === 0) roomSubscribers.delete(roomId);
}

/** Đăng ký 1 kết nối vào registry cấp-agent — gọi NGAY lúc kết nối xác thực xong (chat-realtime-proxy.ts
 * `bindConnection()`), TRƯỚC/KHÔNG PHỤ THUỘC bất kỳ subscribe-room nào (khác `subscribeToRoom()` — connection
 * có thể ở registry này mà CHƯA subscribe phòng nào cả, đúng ý nghĩa "app đang mở nhưng chưa mở phòng nào").
 * Idempotent — gọi lại nhiều lần cho cùng 1 cặp agentId/conn an toàn (Set tự loại trùng). */
export function registerAgentConnection(agentId: number, conn: ChatRealtimeConnection): void {
  // Có WS mới = agent online lại → HỦY grace-timer WS-close đang chờ (reconnect chớp nhoáng trong 10s KHÔNG được
  // phát offline) + xóa cờ offline-tường-minh (đăng nhập lại sau khi /offline). CÙNG lý do phương án 1 (6/8).
  cancelGraceOfflineTimer(agentId);
  explicitlyOfflineAgents.delete(agentId);
  let set = agentConnections.get(agentId);
  if (!set) {
    set = new Set();
    agentConnections.set(agentId, set);
  }
  set.add(conn);
}

/** Gỡ 1 kết nối khỏi registry cấp-agent — gọi ĐÚNG 1 lần khi kết nối đóng (proxy: sự kiện 'close'), CÙNG lúc
 * gọi `unsubscribeAllForConnection()`. Idempotent — gọi lại lần 2 hoặc cho connection chưa từng đăng ký KHÔNG
 * throw. */
export function unregisterAgentConnection(agentId: number, conn: ChatRealtimeConnection): void {
  const set = agentConnections.get(agentId);
  if (!set) return;
  set.delete(conn);
  if (set.size > 0) return; // vẫn còn WS khác (đa thiết bị) → CHƯA offline, KHÔNG hẹn grace (điểm 5, phương án 1).
  agentConnections.delete(agentId);

  // WS CUỐI đóng → XÓA agentHeartbeatAt (FIX 11/8): agent-CÓ-WS mà cũng ping REST (web/exe làm cả hai) KHÔNG được
  // "ghost online" thêm tới 40s nhờ nhịp heartbeat cũ — sau khi đứt WS, CHỈ cửa sổ grace 10s (agentLastSeenAt=closedAt)
  // được quyết định online, đúng yêu cầu "đứt WS → offline nhanh". Nếu thiết bị THẬT SỰ còn mạng, nhịp ping kế
  // (≤15s) sẽ markAgentSeen lại → agentHeartbeatAt tươi trở lại (online lại) mà KHÔNG phá grace của lần đứt này.
  agentHeartbeatAt.delete(agentId);

  // WS CUỐI đã đóng. Nếu đã offline TƯỜNG MINH (POST /offline tới trước) → GIỮ offline, KHÔNG re-online/hẹn lại
  // (chống đua logout). Ngược lại → hẹn grace 10s: giữ online (lastSeen=thời-điểm-đóng) đến khi hết grace mới phát
  // offline; reconnect trong 10s sẽ hủy timer này (registerAgentConnection). lastSeen=closedAt để agentPresenceOnline
  // (WS OR now-lastSeen<10s) KHỚP với thời điểm timer phát offline → người-mới-mở và người-đang-xem thấy GIỐNG nhau.
  if (explicitlyOfflineAgents.has(agentId)) return;
  const closedAtMs = Date.now();
  agentLastSeenAt.set(agentId, closedAtMs);
  cancelGraceOfflineTimer(agentId); // an toàn (không nên có, nhưng tránh rò 1 timer cũ).
  const timer = setTimeout(() => {
    graceOfflineTimers.delete(agentId);
    // Hết 10s không reconnect → GIỜ mới thật sự offline. Handler (proxy) phát presence-offline với lastSeenAt=closedAt.
    if (graceOfflineHandler) graceOfflineHandler(agentId, closedAtMs);
  }, PRESENCE_STALE_MS);
  // unref: KHÔNG giữ tiến trình sống chỉ vì 1 grace-timer đang chờ (server shutdown không bị treo).
  if (typeof timer.unref === 'function') timer.unref();
  graceOfflineTimers.set(agentId, timer);
}

/** true nếu agentId có ÍT NHẤT 1 kết nối WS đang mở (bất kể đang subscribe phòng nào) — dùng để quyết định có
 * cần gửi thêm push FCM hay không (CÙNG logic `calleeHasOpenConnection` call-signaling-server.ts: đã có kết
 * nối WS sống thì broadcastToAgent() là đủ, KHÔNG cần push thêm gây thông báo thừa/double-notify). */
export function agentHasOpenConnection(agentId: number): boolean {
  return (agentConnections.get(agentId)?.size ?? 0) > 0;
}

/** Ghi "nhịp sống" cho agent (lastSeen=now) — gọi từ POST /v1/presence/ping (REST heartbeat web/PC + FCM-ping
 * đánh thức app đã kill). KHÔNG gọi từ WS pong (WS liveness đã do agentHasOpenConnection lo — nếu ghi lastSeen ở
 * pong sẽ khiến agent còn "online" tới 30s SAU khi WS đóng sạch, phá yêu cầu offline-tức-thì). `atEpochMs` cho
 * test tiêm mốc thời gian tất định. */
export function markAgentSeen(agentId: number, atEpochMs: number = Date.now()): void {
  agentLastSeenAt.set(agentId, atEpochMs); // mốc "hoạt động lần cuối" (getAgentLastSeen dùng cho "hoạt động X phút trước").
  // FIX 11/8: nguồn heartbeat REST có CỬA SỔ RIÊNG (PRESENCE_HEARTBEAT_TTL_MS=40s) — ghi agentHeartbeatAt để
  // agentPresenceOnline nhánh (b) giữ online tới 40s dù thiết bị KHÔNG có WS thường trực (APK nền). ĐỘC LẬP với
  // cửa sổ grace WS-close 10s (agentLastSeenAt) → không còn bị cửa sổ WS rút ngắn như bug cũ (offline 35s/45s).
  agentHeartbeatAt.set(agentId, atEpochMs);
  // Có nhịp sống = còn sống → xóa cờ offline-tường-minh + hủy grace-timer đang chờ (nếu FCM-ping đánh thức đúng
  // lúc đang trong 10s grace sau khi WS đóng → giữ online, KHÔNG để timer phát offline nữa).
  explicitlyOfflineAgents.delete(agentId);
  cancelGraceOfflineTimer(agentId);
}

/** Xóa "nhịp sống" của agent — gọi từ POST /v1/presence/offline (client chủ động báo mất mạng/đăng xuất). Sau
 * đó nếu agent cũng KHÔNG còn WS nào → agentPresenceOnline() trả false NGAY (offline tức thì). Idempotent. */
export function markAgentOffline(agentId: number): void {
  agentLastSeenAt.delete(agentId);
  agentHeartbeatAt.delete(agentId); // FIX 11/8: xóa CẢ nguồn heartbeat → offline tường minh chặn cả nhánh (b) 40s.
  // Offline TƯỜNG MINH (mất mạng/máy bay/đăng xuất — CHẮC CHẮN) → set cờ + hủy grace-timer (bỏ qua grace 10s, đi
  // ngay). Cờ chống đua logout: nếu WS đóng SAU lời gọi này, unregisterAgentConnection thấy cờ → KHÔNG re-online.
  explicitlyOfflineAgents.add(agentId);
  cancelGraceOfflineTimer(agentId);
}

/** NGUỒN PRESENCE THẬT (6/8, tách 2 cửa sổ 11/8) — agent "online" nếu BẤT KỲ nhánh nào đúng:
 *   (a) còn ÍT NHẤT 1 WS sống (agentHasOpenConnection); HOẶC
 *   (b) nhịp sống REST còn tươi: now − agentHeartbeatAt < PRESENCE_HEARTBEAT_TTL_MS (40s) — ca thiết-bị-còn-mạng-
 *       KHÔNG-giữ-WS (APK nền được FCM-ping / web-PC ping REST), cửa sổ RỘNG để chịu ping 15s rớt 1 nhịp; HOẶC
 *   (c) grace WS-close: now − agentLastSeenAt < PRESENCE_STALE_MS (10s) — giữ online NGẮN ngay sau khi WS CUỐI
 *       đóng, ĐỒNG BỘ với grace-timer WS-close để người-mới-mở và người-đang-xem thấy GIỐNG nhau.
 * FIX 11/8: TRƯỚC đây (b) và (c) DÙNG CHUNG 10s → client ping thưa (45s) làm agent nháy offline 35s mỗi chu kỳ
 * dù đang online. Nay (b) độc lập 40s, (c) giữ 10s cho đứt-WS-offline-nhanh. KHÁC agentHasOpenConnection (chỉ (a)).
 * `nowEpochMs` cho test tiêm mốc thời gian. Điều kiện "còn đăng nhập/chưa bị vô hiệu hóa" do TẦNG TRÊN lo
 * (requireSession chặn ping của phiên đã logout; friend-service/chat routes tự loại agent bị vô hiệu hóa TRƯỚC). */
export function agentPresenceOnline(agentId: number, nowEpochMs: number = Date.now()): boolean {
  if (agentHasOpenConnection(agentId)) return true; // (a)
  const hb = agentHeartbeatAt.get(agentId);
  if (hb !== undefined && nowEpochMs - hb < PRESENCE_HEARTBEAT_TTL_MS) return true; // (b) nhịp sống REST còn tươi.
  const last = agentLastSeenAt.get(agentId);
  return last !== undefined && nowEpochMs - last < PRESENCE_STALE_MS; // (c) grace WS-close.
}

/** Mốc "hoạt động lần cuối" (epoch ms) của agent để client hiện "Hoạt động X phút trước" khi họ OFFLINE — nguồn
 * = lần markAgentSeen gần nhất (REST heartbeat/FCM-ping). `null` nếu chưa biết (server vừa khởi động lại — presence
 * EPHEMERAL trong RAM, KHÔNG bền qua restart, chấp nhận theo chốt Admin Demo 6/8) hoặc đã markAgentOffline (đăng
 * xuất/mất mạng chủ động — client dựa vào mốc trong sự kiện presence-update offline thay cho snapshot lúc đó). */
export function getAgentLastSeen(agentId: number): number | null {
  return agentLastSeenAt.get(agentId) ?? null;
}

/** Phát `payload` (tự JSON.stringify) tới MỌI kết nối đang mở của `agentId`, BẤT KỂ đang subscribe phòng nào —
 * KHÁC HẲN `broadcastToRoom()` (chỉ phát cho ai đang xem ĐÚNG phòng đó). CÙNG best-effort tuyệt đối (KHÔNG BAO
 * GIỜ throw ra ngoài, tự dọn kết nối chết/lỗi khỏi Set) — xem docstring `broadcastToRoom()` cho lý do đầy đủ. */
export function broadcastToAgent(agentId: number, payload: unknown): void {
  const set = agentConnections.get(agentId);
  if (!set || set.size === 0) return;

  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch (err) {
    console.error(`[chat-realtime-hub] broadcastToAgent: payload không serialize được JSON (agentId=${agentId}), bỏ qua:`, err);
    return;
  }

  for (const conn of [...set]) {
    if (conn.ws.readyState !== 1) {
      set.delete(conn);
      continue;
    }
    try {
      conn.ws.send(text);
    } catch (err) {
      console.error(`[chat-realtime-hub] broadcastToAgent: gửi thất bại tới 1 kết nối (agentId=${agentId}), dọn khỏi Set:`, err);
      set.delete(conn);
    }
  }
  if (set.size === 0) agentConnections.delete(agentId);
}

/** Cho test đếm số kết nối đang subscribe 1 phòng (không cần dựng WebSocket thật để verify subscribe/
 * unsubscribe logic thuần). */
export function getRoomSubscriberCountForTest(roomId: string): number {
  return roomSubscribers.get(roomId)?.size ?? 0;
}

/** Cho test đếm số kết nối agent-level đang mở (registerAgentConnection/unregisterAgentConnection), KHÔNG
 * phụ thuộc room nào. */
export function getAgentConnectionCountForTest(agentId: number): number {
  return agentConnections.get(agentId)?.size ?? 0;
}

/** Cho test dọn sạch state giữa các case (Map module-level, không tự reset qua boundary vitest). */
export function resetChatRealtimeHubForTest(): void {
  roomSubscribers.clear();
  agentConnections.clear();
  agentLastSeenAt.clear();
  agentHeartbeatAt.clear();
  for (const t of graceOfflineTimers.values()) clearTimeout(t);
  graceOfflineTimers.clear();
  explicitlyOfflineAgents.clear();
}
