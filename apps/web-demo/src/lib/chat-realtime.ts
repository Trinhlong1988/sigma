// SIGMA Phase 3 "real-time" (29/7) — client WebSocket cho hệ chat lõi tự xây MỚI (`/v1/chat-realtime`,
// xem apps/bot-api/src/chat-realtime-proxy.ts), THAY THẾ rc-realtime.ts cho phần CHAT TEXT (tin nhắn/phòng/
// reaction/typing) theo hướng B Admin Demo chốt ("đổi hẳn giao diện luôn", KHÔNG chạy song song vô thời hạn).
// Mirror API bề mặt của rc-realtime.ts (ensureSocket() nội bộ, subscribeRoomMessages()/subscribeTypingIndicator()/
// sendTypingStatus(), auto-reconnect, resetRealtimeConnection()) NHƯNG giao thức dây (wire protocol) HOÀN TOÀN
// KHÁC — KHÔNG phải DDP Rocket.Chat, mà JSON đơn giản tự định nghĩa ở chat-realtime-proxy.ts:
//   client→server: {type:'subscribe-room',roomId} | {type:'unsubscribe-room',roomId} | {type:'typing',roomId,isTyping}
//   server→client: {msg:'ready'} | {msg:'subscribed',roomId} | {msg:'error',code,roomId?} |
//                  {msg:'new-message',roomId,message} | {msg:'message-edited',roomId,message} |
//                  {msg:'message-deleted',roomId,messageId,deletedAt} |
//                  {msg:'reaction-update',roomId,messageId,agentId,action,reaction} |
//                  {msg:'typing-indicator',roomId,agentId,isTyping} |
//                  {msg:'room-updated',roomId,room} | {msg:'room-member-changed',roomId,agentId,action,role?}
//
// KHÁC BIỆT so với rc-realtime.ts (không phải thiếu sót — đơn giản hơn CỐ Ý vì hạ tầng khác):
//   - KHÔNG cần bước "connect"+"login" DDP — cookie `sigma_ws` xác thực NGAY lúc upgrade (server tự resolve
//     agentId, xem chat-realtime-proxy.ts), client chỉ cần đợi ĐÚNG 1 message `{msg:'ready'}` là bắt đầu
//     subscribe được, KHÔNG có khái niệm username RC cho typing indicator (server tự biết agentId của kết nối).
//   - 1 lệnh `subscribe-room` DUY NHẤT phủ MỌI loại sự kiện của phòng đó (tin nhắn/sửa/xóa/reaction/typing/
//     room-updated/member-changed) — KHÔNG có 2 kênh sub riêng như DDP (`stream-room-messages` vs
//     `stream-notify-room`). Registry nội bộ ở dưới (roomRegistry) gộp NHIỀU loại listener (message/typing/...)
//     trên CÙNG 1 lượt subscribe-room — chỉ gửi `subscribe-room`/`unsubscribe-room` khi TỔNG số listener mọi
//     loại của phòng đó chuyển từ 0→1 hoặc về lại 0 (tránh gửi trùng lặp nếu ConversationScreen gọi cả
//     subscribeRoomMessages() lẫn subscribeTypingIndicator() cho CÙNG 1 phòng, như cách nó đang dùng).
import { getSession, handleSessionExpired, handleSessionRevoked } from './session';
import { parsePresenceUpdate, setPresence } from './presence-store';
import { emitRoomRead, emitAllRead } from './chat-read-events';
import type { ChatMessageDto, ChatReactionDto, ChatRoomDetailDto, PinnedMessageDto } from './chat-client';

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

function chatRealtimeWsUrl(): string {
  return `${botApiBaseUrl().replace(/^http/, 'ws')}/v1/chat-realtime`;
}

/** CÙNG GIÁ TRỊ chat-realtime-proxy.ts (phía bot-api re-dùng SESSION_EXPIRED_CLOSE_CODE của rc-realtime-proxy.ts
 * — cả 2 endpoint WS đều đóng với ĐÚNG code này khi phiên không hợp lệ) — client không cần phân biệt endpoint
 * nào đóng, xử lý GIỐNG HỆT rc-realtime.ts: điều hướng /login ngay, KHÔNG tự reconnect. */
const SESSION_EXPIRED_CLOSE_CODE = 4401;
// #3 (6/8) — CÙNG GIÁ TRỊ SESSION_REVOKED_CLOSE_CODE phía bot-api (ws-cookie-session.ts). Server đóng WS với
// code này khi phiên bị ĐÁ do đăng nhập thiết bị khác cùng nền → client hiện thông báo RIÊNG rồi về /login,
// KHÔNG tự reconnect (khác lỗi mạng thường).
const SESSION_REVOKED_CLOSE_CODE = 4409;

type MessageListener = (message: ChatMessageDto) => void;
type MessageDeletedListener = (messageId: string, deletedAt: string | null) => void;
// Audit độc lập 30/7 (MEDIUM): thêm `agentId` — action='removed' không kèm `reaction` (null), listener CẦN biết
// CHÍNH XÁC ai vừa bỏ thích để xóa đúng người đó khỏi state cục bộ theo agentId, KHÔNG được thay NGUYÊN mảng
// reactions bằng 1 giá trị (người thả sau đè mất người thả trước dù cả 2 vẫn tồn tại thật trong DB).
type ReactionListener = (messageId: string, agentId: number, action: 'added' | 'removed' | 'changed', reaction: ChatReactionDto | null) => void;
type TypingListener = (agentId: number, isTyping: boolean) => void;
// TICK "đã đọc" (5/8) — server phát `{msg:'read-receipt',roomId,agentId,messageId,lastReadAt}` sau mỗi
// markRead: `agentId` đã đọc TỚI tin `messageId` (createdAt=`lastReadAt` ISO). ConversationScreen dùng để đổi
// tick tin CỦA MÌNH sang "đã xem" khi người kia (DIRECT peer) đọc.
type ReadReceiptListener = (agentId: number, messageId: string, lastReadAt: string) => void;
// TICK "đã nhận" (6/8) — server phát `{msg:'delivery-receipt',roomId,agentId,deliveredAt}`: `agentId` đang
// ONLINE → đã NHẬN mọi tin tới mốc `deliveredAt` (ISO). ConversationScreen đổi tick tin của mình sang "đã
// nhận" (2 tick xám) khi DIRECT peer online (dù chưa mở phòng).
type DeliveryReceiptListener = (agentId: number, deliveredAt: string) => void;
type RoomUpdatedListener = (room: ChatRoomDetailDto) => void;
type MemberChangedListener = (agentId: number, action: 'added' | 'removed' | 'role-changed', role?: string) => void;
// GIẢI TÁN NHÓM (dissolve) — server phát `{msg:'room-dissolved',roomId}` khi trưởng nhóm giải tán nhóm
// (routes/chat.ts broadcastRoomDissolved()). Không mang payload thêm (chỉ là tín hiệu "phòng này không còn").
type RoomDissolvedListener = () => void;
// "Bảng tin" / GHIM NHIỀU (5/8) — server phát `{msg:'pins-updated',roomId,pins}` sau mỗi lần ghim/bỏ ghim
// (routes/chat.ts broadcastPinsUpdated()) — `pins` là NGUYÊN danh sách "Bảng tin" mới (PinnedMessageDto[]).
type PinsUpdatedListener = (pins: PinnedMessageDto[]) => void;

interface RoomListenerSets {
  message: Set<MessageListener>;
  edited: Set<MessageListener>;
  deleted: Set<MessageDeletedListener>;
  reaction: Set<ReactionListener>;
  typing: Set<TypingListener>;
  roomUpdated: Set<RoomUpdatedListener>;
  memberChanged: Set<MemberChangedListener>;
  roomDissolved: Set<RoomDissolvedListener>;
  pinsUpdated: Set<PinsUpdatedListener>;
  readReceipt: Set<ReadReceiptListener>;
  deliveryReceipt: Set<DeliveryReceiptListener>;
}

function emptyRoomListenerSets(): RoomListenerSets {
  return { message: new Set(), edited: new Set(), deleted: new Set(), reaction: new Set(), typing: new Set(), roomUpdated: new Set(), memberChanged: new Set(), roomDissolved: new Set(), pinsUpdated: new Set(), readReceipt: new Set(), deliveryReceipt: new Set() };
}

function isRoomEntryEmpty(sets: RoomListenerSets): boolean {
  return (
    sets.message.size === 0 &&
    sets.edited.size === 0 &&
    sets.deleted.size === 0 &&
    sets.reaction.size === 0 &&
    sets.typing.size === 0 &&
    sets.roomUpdated.size === 0 &&
    sets.memberChanged.size === 0 &&
    sets.roomDissolved.size === 0 &&
    sets.pinsUpdated.size === 0 &&
    sets.readReceipt.size === 0 &&
    sets.deliveryReceipt.size === 0
  );
}

const roomRegistry = new Map<string, RoomListenerSets>();

// B115-tiếp (2/8, Admin Demo "phải thông báo push nổi màn hình bất kể trường hợp nào như zalo") — listener MỚI
// KHÔNG gắn với 1 phòng cụ thể (KHÁC roomRegistry — mọi thứ ở trên gắn với subscribe-room 1 phòng). Server
// phát `{msg:'chat-notify',...}` (chat-realtime-hub.ts broadcastToAgent(), xem routes/chat.ts
// notifyRoomMembersOfNewMessage()) cho MỌI kết nối của agentId đó BẤT KỂ có subscribe-room nào hay không —
// dùng cho banner/toast "có tin nhắn mới" khi app đang mở nhưng KHÔNG ở đúng phòng vừa có tin (case B115 #2).
export interface ChatNotifyEvent {
  roomId: string;
  messageId: string;
  senderAgentId: number;
  senderName: string;
  roomType: 'DIRECT' | 'GROUP';
  roomName: string | null;
  preview: string;
  createdAt: string;
  /** ĐỒNG NHẤT SỐ ĐẾM (7/8) — tổng chưa đọc của CHÍNH người nhận trong phòng này NGAY SAU tin (server tính, nguồn
   * chân lý). Client SET số theo giá trị này thay vì +1 optimistic (hết lệch exe/web/apk). null/thiếu (payload cũ
   * hoặc server đếm lỗi) → client fallback +1 như cũ. */
  unreadCount: number | null;
}
const globalNotifyListeners = new Set<(payload: ChatNotifyEvent) => void>();

// #32 (6/8, Admin Demo "push nhật ký REALTIME") — listener MỚI KHÔNG gắn phòng nào (giống globalNotifyListeners).
// Server phát `{msg:'diary-notify', kind:'diary_post', authorAgentId, authorName, postId, at}` (chat-realtime-hub
// broadcastToAgent, xem notification-service.ts notifyFriendsOfNewPost) cho MỌI bạn bè khi có bài Nhật ký mới →
// NotificationBell nghe để +1 chuông đỏ NGAY (0 refetch). `postId` để dedupe với FCM tới cùng máy đang mở.
export interface DiaryNotifyEvent {
  // 'diary_post' = bạn bè đăng bài mới (notifyFriendsOfNewPost, field authorAgentId/authorName).
  // 'diary_comment'/'diary_reaction' (7/8, Admin Demo "bình luận/cảm xúc nhật ký không push/không chuông") = có người
  // bình luận/thả cảm xúc bài của MÌNH (notifyPostAuthorOfActivity, field actorAgentId/actorName). Parser dưới
  // nhận CẢ 2 bộ field, chuẩn hóa về authorAgentId/authorName = "người gây ra hành động".
  kind: 'diary_post' | 'diary_comment' | 'diary_reaction';
  authorAgentId: number;
  authorName: string;
  postId: string;
  at: string;
}
const globalDiaryNotifyListeners = new Set<(payload: DiaryNotifyEvent) => void>();

// 8/8 (Admin Demo "đồng bộ hóa mọi push event số đếm, cộng trừ mọi nền mượt-chuẩn-realtime") — kênh MỚI cho 3 sự kiện
// KẾT NỐI (kết bạn/nhóm). Server phát `{msg:'agent-notify', notifType, actorAgentId, actorName, targetId, at}`
// (broadcastToAgent, xem notification-service.ts notifyFriendConnectionEvent/notifyGroupAdded) khi có lời mời kết
// bạn / lời mời được chấp nhận / được thêm vào nhóm → NotificationBell nghe để chuông đỏ +1 NGAY + refetch đếm chuẩn
// theo server (nguồn chân lý, đồng bộ web/exe/apk). KHÔNG nhét vào 'diary-notify' vì kênh đó ràng buộc postId của
// bài Nhật ký; sự kiện kết bạn không có postId, GROUP_ADDED dùng targetId=roomId (ngữ nghĩa khác) → kênh riêng.
export interface AgentNotifyEvent {
  // 13/8 — thêm MENTION (được nhắc @ trong nhóm; targetId=roomId, click mở đúng phòng — CÙNG ngữ nghĩa GROUP_ADDED).
  notifType: 'FRIEND_REQUEST' | 'FRIEND_ACCEPT' | 'GROUP_ADDED' | 'MENTION';
  actorAgentId: number;
  actorName: string;
  // roomId cho GROUP_ADDED/MENTION (click deep-link mở đúng nhóm); null cho friend_* (deep-link về Danh bạ).
  targetId: string | null;
  at: string;
}
const globalAgentNotifyListeners = new Set<(payload: AgentNotifyEvent) => void>();

// "Thiết bị đăng nhập" realtime (5/8, Admin Demo "màn Bảo mật chưa show thiết bị realtime") — listener MỚI KHÔNG
// gắn phòng nào (giống globalNotifyListeners). Server phát `{msg:'sessions-updated'}` (chat-realtime-hub.ts
// broadcastToAgent) sau MỖI lần đăng nhập thiết bị mới (routes/auth.ts) hoặc revoke 1 phiên (routes/me.ts) —
// màn AccountSecurityScreen refetch danh sách thiết bị khi nhận. KHÔNG mang payload (chỉ là tín hiệu "hãy tải
// lại"), callback không nhận tham số.
const globalSessionsUpdatedListeners = new Set<() => void>();

let socket: WebSocket | null = null;
let socketConnectedForUserId: string | null = null;
let connectPromise: Promise<void> | null = null;
let ready = false;

// Lane D vòng 2 (3/8) — backoff luỹ thừa CÓ JITTER cho tự-reconnect WS. TRƯỚC ĐÂY reconnect luôn sau ĐÚNG
// 2000ms cố định: (1) nếu bot-api sập/khởi động lại, MỌI client (8 máy) đập lại đúng mỗi 2s đồng loạt → tải
// dồn (thundering herd) đúng lúc server yếu nhất; (2) mạng rớt lâu → spam kết nối vô ích mỗi 2s. Sửa: chờ
// tăng dần 2→4→8→16→30s (cap) + jitter ngẫu nhiên để rải các client ra, RESET về 2s ngay khi kết nối lại
// thành công (nhận 'ready') hoặc khi đăng xuất (resetChatRealtimeConnection).
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Tính thời gian chờ (ms) trước lần reconnect thứ `attempt` (0-based): base = min(2^attempt × 2000, 30000) →
 * 2s,4s,8s,16s,30s,30s... cộng jitter ngẫu nhiên trong [0, 25% base) để N client rớt mạng cùng lúc KHÔNG dồn
 * reconnect đồng bộ. Hàm THUẦN (nhận `rng` để test tất định — xem chat-realtime-backoff.test.ts), `attempt` âm
 * được kẹp về 0. */
export function computeReconnectDelay(attempt: number, rng: () => number = Math.random): number {
  const base = Math.min(2000 * 2 ** Math.max(0, attempt), 30000);
  const jitter = Math.floor(rng() * base * 0.25);
  return base + jitter;
}

/** Đóng kết nối hiện có (nếu còn) + xóa sạch state module-level — gọi lúc đăng xuất (logout.ts, CÙNG lý do đã
 * áp cho resetRealtimeConnection() của rc-realtime.ts, xem comment ở đó) để lần đăng nhập kế tiếp (dù cùng hay
 * khác tài khoản) khởi tạo lại từ đầu, không rò rỉ kết nối/kế thừa trạng thái cũ. */
export function resetChatRealtimeConnection(): void {
  if (socket) {
    try {
      socket.close();
    } catch {
      // đã đóng — bỏ qua.
    }
  }
  socket = null;
  socketConnectedForUserId = null;
  connectPromise = null;
  ready = false;
  globalDiaryNotifyListeners.clear();
  globalAgentNotifyListeners.clear();
  // Lane D vòng 2 — huỷ timer reconnect đang chờ (nếu có) + reset backoff: đăng xuất KHÔNG được để 1 timer cũ
  // âm thầm mở lại kết nối cho phiên vừa đóng, và lần đăng nhập kế phải bắt đầu lại từ 2s (không kế thừa số
  // lần thử cũ).
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  roomRegistry.clear();
  globalNotifyListeners.clear();
  globalSessionsUpdatedListeners.clear();
}

function sendRaw(payload: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

/** B115-tiếp — hàm THUẦN (không I/O) tách riêng để test được KHÔNG cần dựng WebSocket thật, CÙNG quy ước
 * `buildIncomingCallNavigation()` (call-signaling-client.ts, xem call-signaling-navigation.test.ts) — repo
 * CHƯA có hạ tầng mock WebSocket/render component, tách logic thuần khỏi phần I/O là cách test được. Trả `null`
 * nếu shape không khớp giao thức (server gửi hỏng/phiên bản lệch) — caller bỏ qua im lặng, KHÔNG throw (banner
 * chỉ là UX phụ, không phải dữ liệu nghiệp vụ bắt buộc). */
export function parseChatNotifyPayload(data: Record<string, unknown>): ChatNotifyEvent | null {
  if (
    typeof data.roomId !== 'string' ||
    typeof data.messageId !== 'string' ||
    typeof data.senderAgentId !== 'number' ||
    typeof data.senderName !== 'string' ||
    (data.roomType !== 'DIRECT' && data.roomType !== 'GROUP') ||
    typeof data.preview !== 'string'
  ) {
    return null;
  }
  return {
    roomId: data.roomId,
    messageId: data.messageId,
    senderAgentId: data.senderAgentId,
    senderName: data.senderName,
    roomType: data.roomType,
    roomName: typeof data.roomName === 'string' ? data.roomName : null,
    preview: data.preview,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    // Server truth cho badge (đồng nhất mọi nền). Chỉ nhận số hữu hạn >=0; sai kiểu/thiếu → null (client +1 fallback).
    unreadCount: typeof data.unreadCount === 'number' && Number.isFinite(data.unreadCount) && data.unreadCount >= 0 ? data.unreadCount : null
  };
}

/** #32 — parse `{msg:'diary-notify',...}` sang DiaryNotifyEvent. Hàm THUẦN (không I/O) để test KHÔNG cần WS thật,
 * CÙNG quy ước parseChatNotifyPayload. Shape lệch (server hỏng/phiên bản khác) → `null`, caller bỏ qua im lặng
 * (chuông là UX phụ, KHÔNG throw). `at` thiếu → dùng thời điểm nhận (client now). */
export function parseDiaryNotifyPayload(data: Record<string, unknown>): DiaryNotifyEvent | null {
  const kind = data.kind;
  if (kind !== 'diary_post' && kind !== 'diary_comment' && kind !== 'diary_reaction') return null;
  // diary_post gửi authorAgentId/authorName; comment/reaction gửi actorAgentId/actorName → nhận CẢ HAI (chuẩn hóa).
  const agentId = typeof data.authorAgentId === 'number' ? data.authorAgentId : typeof data.actorAgentId === 'number' ? data.actorAgentId : null;
  const name = typeof data.authorName === 'string' ? data.authorName : typeof data.actorName === 'string' ? data.actorName : null;
  if (agentId === null || name === null || typeof data.postId !== 'string' || data.postId.length === 0) {
    return null;
  }
  return {
    kind,
    authorAgentId: agentId,
    authorName: name,
    postId: data.postId,
    at: typeof data.at === 'string' ? data.at : new Date().toISOString()
  };
}

/** 8/8 — parse `{msg:'agent-notify',...}` sang AgentNotifyEvent. Hàm THUẦN (không I/O) để test KHÔNG cần WS thật,
 * CÙNG quy ước parseDiaryNotifyPayload. Shape lệch (server hỏng/phiên bản khác) → `null`, caller bỏ qua im lặng
 * (chuông là UX phụ, KHÔNG throw). `targetId` chỉ nhận chuỗi không rỗng (roomId), còn lại → null. `at` thiếu →
 * dùng thời điểm nhận (client now). */
export function parseAgentNotifyPayload(data: Record<string, unknown>): AgentNotifyEvent | null {
  const t = data.notifType;
  if (t !== 'FRIEND_REQUEST' && t !== 'FRIEND_ACCEPT' && t !== 'GROUP_ADDED' && t !== 'MENTION') return null;
  if (typeof data.actorAgentId !== 'number' || typeof data.actorName !== 'string' || data.actorName.length === 0) return null;
  return {
    notifType: t,
    actorAgentId: data.actorAgentId,
    actorName: data.actorName,
    targetId: typeof data.targetId === 'string' && data.targetId.length > 0 ? data.targetId : null,
    at: typeof data.at === 'string' ? data.at : new Date().toISOString()
  };
}

function dispatchServerMessage(data: Record<string, unknown>): void {
  // #3 (6/8, Admin Demo "đăng nhập máy mới đá phiên CŨ CÙNG NỀN như Zalo") — server phát {msg:'session-revoked',
  // reason:'logged-in-elsewhere'} rồi đóng WS: tài khoản vừa đăng nhập ở thiết bị KHÁC CÙNG NỀN. Dùng ĐÚNG luồng
  // dọn/điều hướng hiện có (handleSessionRevoked → clearSession + App.tsx về /login kèm banner riêng). Xử lý
  // TRƯỚC nhánh early-return dựa roomId (tín hiệu này KHÔNG gắn phòng nào).
  if (data.msg === 'session-revoked') {
    handleSessionRevoked();
    return;
  }

  // #32 — 'diary-notify' KHÔNG gắn roomRegistry (giống 'chat-notify'): phát cho MỌI listener chuông Nhật ký bất
  // kể có subscribe phòng nào không (xử lý TRƯỚC nhánh early-return dựa vào roomId/sets phía dưới).
  if (data.msg === 'diary-notify') {
    const payload = parseDiaryNotifyPayload(data);
    if (payload) globalDiaryNotifyListeners.forEach((fn) => fn(payload));
    return;
  }

  // 8/8 — 'agent-notify' (kết bạn/nhóm) KHÔNG gắn roomRegistry (giống 'diary-notify'/'chat-notify'): phát cho MỌI
  // listener chuông kết nối bất kể có subscribe phòng nào không (xử lý TRƯỚC nhánh early-return dựa roomId phía dưới).
  if (data.msg === 'agent-notify') {
    const payload = parseAgentNotifyPayload(data);
    if (payload) globalAgentNotifyListeners.forEach((fn) => fn(payload));
    return;
  }

  // B115-tiếp — 'chat-notify' KHÔNG gắn với roomRegistry (đọc docstring ChatNotifyEvent ở trên): phát cho MỌI
  // listener global bất kể có subscribe phòng roomId đó hay không, xử lý TRƯỚC nhánh early-return dựa vào
  // `sets` (nhánh đó CHỈ áp dụng cho sự kiện gắn với 1 phòng đã subscribe).
  if (data.msg === 'chat-notify') {
    const payload = parseChatNotifyPayload(data);
    if (payload) globalNotifyListeners.forEach((fn) => fn(payload));
    return;
  }

  // 'sessions-updated' — tín hiệu thuần (không payload), KHÔNG gắn roomRegistry: phát cho MỌI listener thiết
  // bị bất kể có subscribe phòng nào không (xử lý TRƯỚC nhánh early-return dựa vào roomId/sets phía dưới).
  if (data.msg === 'sessions-updated') {
    globalSessionsUpdatedListeners.forEach((fn) => fn());
    return;
  }

  // PRESENCE LIVE (6/8) — server (presence agent) broadcast agent-level `{msg:'presence-update', agentId, online,
  // at}` tới bạn bè + đồng-thành-viên khi 1 agent online/offline đổi. KHÔNG gắn roomRegistry: đẩy vào presence-store
  // (Map agentId→online) → mọi OnlineDot đang đọc agentId đó ĐỔI MÀU NGAY (0 refetch). Shape lạ → bỏ qua im (R198:
  // presence là UX phụ, KHÔNG throw; nhưng parse tách riêng có test khẳng định từng nhánh hợp lệ/không hợp lệ).
  if (data.msg === 'presence-update') {
    const p = parsePresenceUpdate(data);
    if (p) setPresence(p.agentId, p.online, p.lastSeenAt);
    return;
  }

  // ĐỒNG BỘ ĐÃ-ĐỌC ĐA THIẾT BỊ (7/8, Admin Demo) — máy KHÁC cùng tài khoản vừa đọc phòng → server broadcastToAgent
  // {msg:'room-read-self',roomId}. Máy này có thể ĐANG ở danh sách chat (KHÔNG subscribe phòng đó) nên PHẢI xử ở
  // early-return (trước gate roomId/roomRegistry). Gọi CHÍNH emitRoomRead → tái dùng luồng clear unread/badge/
  // notification cục bộ (AppShell markRoomRead + App.tsx clearRoomNotification). Idempotent với máy vừa đọc.
  if (data.msg === 'room-read-self') {
    const rid = typeof data.roomId === 'string' ? data.roomId : '';
    if (rid) emitRoomRead(rid);
    return;
  }
  // "Đọc tất cả" ở máy khác → clear TOÀN BỘ đỏ ở máy này.
  if (data.msg === 'all-read-self') {
    emitAllRead();
    return;
  }

  const roomId = typeof data.roomId === 'string' ? data.roomId : undefined;
  if (!roomId && data.msg !== 'ready') return;
  const sets = roomId ? roomRegistry.get(roomId) : undefined;

  switch (data.msg) {
    case 'new-message': {
      if (!sets || !data.message) return;
      sets.message.forEach((fn) => fn(data.message as ChatMessageDto));
      return;
    }
    case 'message-edited': {
      if (!sets || !data.message) return;
      sets.edited.forEach((fn) => fn(data.message as ChatMessageDto));
      return;
    }
    case 'message-deleted': {
      if (!sets || typeof data.messageId !== 'string') return;
      const deletedAt = typeof data.deletedAt === 'string' ? data.deletedAt : null;
      sets.deleted.forEach((fn) => fn(data.messageId as string, deletedAt));
      return;
    }
    case 'reaction-update': {
      if (!sets || typeof data.messageId !== 'string' || typeof data.agentId !== 'number') return;
      const action = data.action as 'added' | 'removed' | 'changed';
      sets.reaction.forEach((fn) => fn(data.messageId as string, data.agentId as number, action, (data.reaction as ChatReactionDto | null) ?? null));
      return;
    }
    case 'typing-indicator': {
      if (!sets || typeof data.agentId !== 'number') return;
      sets.typing.forEach((fn) => fn(data.agentId as number, !!data.isTyping));
      return;
    }
    case 'room-updated': {
      if (!sets || !data.room) return;
      sets.roomUpdated.forEach((fn) => fn(data.room as ChatRoomDetailDto));
      return;
    }
    case 'room-member-changed': {
      if (!sets || typeof data.agentId !== 'number') return;
      const action = data.action as 'added' | 'removed' | 'role-changed';
      sets.memberChanged.forEach((fn) => fn(data.agentId as number, action, typeof data.role === 'string' ? data.role : undefined));
      return;
    }
    case 'room-dissolved': {
      // GIẢI TÁN NHÓM (dissolve) — phòng đã bị trưởng nhóm giải tán (xóa mềm server). Báo mọi listener để màn
      // đang mở phòng tự rời về danh sách. Không mang payload (chỉ tín hiệu).
      if (!sets) return;
      sets.roomDissolved.forEach((fn) => fn());
      return;
    }
    case 'pins-updated': {
      // "Bảng tin" / GHIM NHIỀU (5/8) — `pins` là NGUYÊN danh sách mới (KHÔNG delta). Array.isArray check để
      // KHÔNG vỡ nếu payload lạ (fail-safe, KHÔNG throw — REST vẫn tải lại đúng ở lần mở panel sau).
      if (!sets || !Array.isArray(data.pins)) return;
      sets.pinsUpdated.forEach((fn) => fn(data.pins as PinnedMessageDto[]));
      return;
    }
    case 'read-receipt': {
      // TICK "đã đọc" (5/8) — `agentId` đã đọc tới `messageId` (createdAt=`lastReadAt`). Validate shape tối
      // thiểu (fail-safe, bỏ qua im nếu payload lạ — tick là UX phụ, KHÔNG throw).
      if (!sets || typeof data.agentId !== 'number' || typeof data.messageId !== 'string' || typeof data.lastReadAt !== 'string') return;
      sets.readReceipt.forEach((fn) => fn(data.agentId as number, data.messageId as string, data.lastReadAt as string));
      return;
    }
    case 'delivery-receipt': {
      // TICK "đã nhận" (6/8) — `agentId` online → đã nhận mọi tin tới mốc `deliveredAt`. Fail-safe shape check.
      if (!sets || typeof data.agentId !== 'number' || typeof data.deliveredAt !== 'string') return;
      sets.deliveryReceipt.forEach((fn) => fn(data.agentId as number, data.deliveredAt as string));
      return;
    }
    case 'error':
      // Audit độc lập 30/7 (INFO — comment cũ ở đây nói "xử lý riêng ở ensureSocket()" nhưng thực tế KHÔNG có
      // nơi nào đọc message này — sửa lại đúng sự thật + thêm log tối thiểu, KHÔNG nuốt câm hoàn toàn (R198)).
      // Không throw/không toast (server vẫn fail-safe: phòng đó chỉ không có real-time, REST vẫn hoạt động
      // bình thường ở lần tải tiếp theo) — chỉ log để debug khi 1 subscribe hợp lệ trước đó bỗng bị từ chối
      // (vd agent vừa bị xóa khỏi phòng).
      // eslint-disable-next-line no-console
      console.error(`[chat-realtime] server từ chối: code=${data.code} roomId=${data.roomId ?? '(không có)'}`);
      return;
    default:
      // 'ready'/'subscribed' — 'ready' được ensureSocket() tự đợi (message đầu tiên duy nhất cần); 'subscribed'
      // hiện chỉ là ACK thuần, không có state nào cần cập nhật khi nhận (subscribe-room đã coi là thành công
      // ngay khi gửi, optimistic) — bỏ qua có chủ đích, không phải bỏ sót.
      return;
  }
}

/** Mở (hoặc tái dùng) kết nối WS tới bot-api — đợi ĐÚNG 1 message `{msg:'ready'}` rồi coi là sẵn sàng, tự gửi
 * lại `subscribe-room` cho MỌI phòng đang có listener (phủ cả lần connect đầu lẫn reconnect sau khi rớt mạng,
 * CÙNG pattern ensureSocket() rc-realtime.ts). */
function ensureSocket(): Promise<void> {
  const session = getSession();
  if (!session) return Promise.reject(new Error('Chưa đăng nhập.'));

  if (socket && socket.readyState === WebSocket.OPEN && ready && socketConnectedForUserId === session.userId) {
    return Promise.resolve();
  }
  if (connectPromise) return connectPromise;

  connectPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(chatRealtimeWsUrl());
    socket = ws;
    socketConnectedForUserId = session.userId;
    ready = false;
    let settled = false;

    ws.addEventListener('message', (ev) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      if (data.msg === 'ready') {
        ready = true;
        reconnectAttempts = 0; // Lane D vòng 2 — kết nối lại thành công → reset backoff về 2s cho lần rớt kế.
        settled = true;
        for (const roomId of roomRegistry.keys()) {
          ws.send(JSON.stringify({ type: 'subscribe-room', roomId }));
        }
        resolve();
        return;
      }

      dispatchServerMessage(data);
    });

    ws.addEventListener('close', (ev) => {
      const wasThisSocket = socket === ws;
      if (!wasThisSocket) return;
      socket = null;
      socketConnectedForUserId = null;
      ready = false;
      connectPromise = null;

      if (!settled) {
        settled = true;
        reject(new Error(ev.code === SESSION_EXPIRED_CLOSE_CODE ? 'Phiên đăng nhập đã hết hạn.' : 'Không kết nối được real-time.'));
      }

      if (ev.code === SESSION_EXPIRED_CLOSE_CODE) {
        handleSessionExpired();
        return;
      }
      // #3 (6/8) — bị ĐÁ do đăng nhập thiết bị khác cùng nền: KHÔNG tự reconnect (phiên đã bị thu hồi, reconnect
      // sẽ bị từ chối ngay). handleSessionRevoked idempotent — message 'session-revoked' (nếu tới trước close)
      // đã dọn; gọi lại ở đây phủ ca close tới mà message rớt/không tới.
      if (ev.code === SESSION_REVOKED_CLOSE_CODE) {
        handleSessionRevoked();
        return;
      }
      // B115-tiếp — globalNotifyListeners CŨNG cần giữ kết nối sống/tự reconnect, KHÔNG chỉ roomRegistry: banner
      // "có tin nhắn mới" (case #2) phải hoạt động ngay cả khi KHÔNG có phòng nào đang mở (vd đang ở màn Cài đặt,
      // roomRegistry rỗng) — thiếu điều kiện này, rớt mạng 1 lần sẽ làm banner câm vĩnh viễn tới khi user tự mở
      // 1 phòng chat (subscribe-room) mới vô tình reconnect lại.
      if (roomRegistry.size > 0 || globalNotifyListeners.size > 0 || globalSessionsUpdatedListeners.size > 0) {
        // Lane D vòng 2 — chờ theo backoff luỹ thừa + jitter (thay 2000ms cố định), tăng dần mỗi lần thử liên
        // tiếp; reset ở 'ready' (kết nối lại được) / resetChatRealtimeConnection (đăng xuất).
        const delay = computeReconnectDelay(reconnectAttempts);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          ensureSocket().catch((err) => console.error('[chat-realtime] reconnect thất bại:', err));
        }, delay);
      }
    });

    ws.addEventListener('error', () => {
      // Để 'close' xử lý reject/reconnect — WebSocket luôn bắn 'close' ngay sau 'error'.
    });
  });

  return connectPromise;
}

/** Đăng ký `roomId` với hub nội bộ (registry) — TỰ gửi `subscribe-room` NẾU đây là listener ĐẦU TIÊN (mọi loại)
 * của phòng đó (chuyển 0→1), tận dụng kết nối đã sẵn sàng nếu có, hoặc đợi ensureSocket() nếu đang kết nối lần
 * đầu (lúc đó message-handler ở ensureSocket() đã tự gửi subscribe-room cho MỌI phòng trong registry). */
function registerRoomListener(roomId: string, mutate: (sets: RoomListenerSets) => void): void {
  let sets = roomRegistry.get(roomId);
  const isNewRoom = !sets;
  if (!sets) {
    sets = emptyRoomListenerSets();
    roomRegistry.set(roomId, sets);
  }
  mutate(sets);

  const alreadyReady = !!socket && socket.readyState === WebSocket.OPEN && ready;

  ensureSocket()
    .then(() => {
      if (isNewRoom && alreadyReady) sendRaw({ type: 'subscribe-room', roomId });
    })
    .catch((err) => console.error('[chat-realtime] không kết nối được real-time:', err));
}

/** Hủy đăng ký 1 listener khỏi `roomId` — nếu KHÔNG còn listener loại nào (mọi loại) cho phòng đó nữa, gửi
 * `unsubscribe-room` + xóa khỏi registry. */
function unregisterRoomListener(roomId: string, mutate: (sets: RoomListenerSets) => void): void {
  const sets = roomRegistry.get(roomId);
  if (!sets) return;
  mutate(sets);
  if (isRoomEntryEmpty(sets)) {
    roomRegistry.delete(roomId);
    sendRaw({ type: 'unsubscribe-room', roomId });
  }
}

/** Lắng nghe tin nhắn MỚI của 1 phòng (thay `subscribeRoomMessages()` rc-realtime.ts). Trả hàm hủy đăng ký —
 * PHẢI gọi khi rời phòng/unmount. */
export function subscribeRoomMessages(roomId: string, onMessage: MessageListener): () => void {
  registerRoomListener(roomId, (sets) => sets.message.add(onMessage));
  return () => unregisterRoomListener(roomId, (sets) => sets.message.delete(onMessage));
}

/** Tin nhắn ĐÃ SỬA (PATCH /v1/chat/messages/:id) — server phát `message-edited` với message MỚI đầy đủ, caller
 * tự upsert theo id (CÙNG cách xử lý `new-message`, xem ConversationScreen.tsx). */
export function subscribeMessageEdited(roomId: string, onEdited: MessageListener): () => void {
  registerRoomListener(roomId, (sets) => sets.edited.add(onEdited));
  return () => unregisterRoomListener(roomId, (sets) => sets.edited.delete(onEdited));
}

/** Tin nhắn ĐÃ XÓA (soft-delete, DELETE /v1/chat/messages/:id) — server phát `message-deleted` với
 * messageId/deletedAt (KHÔNG kèm message đầy đủ, hệ mới không giữ nội dung sau xóa). */
export function subscribeMessageDeleted(roomId: string, onDeleted: MessageDeletedListener): () => void {
  registerRoomListener(roomId, (sets) => sets.deleted.add(onDeleted));
  return () => unregisterRoomListener(roomId, (sets) => sets.deleted.delete(onDeleted));
}

/** Cảm xúc (reaction) thay đổi trên 1 tin nhắn của phòng — server phát `reaction-update`. */
export function subscribeReactionUpdate(roomId: string, onReaction: ReactionListener): () => void {
  registerRoomListener(roomId, (sets) => sets.reaction.add(onReaction));
  return () => unregisterRoomListener(roomId, (sets) => sets.reaction.delete(onReaction));
}

/** Lắng nghe trạng thái "đang gõ chữ" của 1 phòng (thay `subscribeTypingIndicator()` rc-realtime.ts) —
 * `onTypingChange(agentId, isTyping)`. KHÁC rc-realtime.ts: callback nhận `agentId` (số, Agent.id THẬT) thay vì
 * `username` (chuỗi RC) — hệ mới không có khái niệm username RC, caller tự tra tên hiển thị theo agentId qua
 * danh bạ hiện có (vd `listMyFriends()`, agent-api-client.ts) nếu cần hiện tên thay vì chỉ id. */
export function subscribeTypingIndicator(roomId: string, onTypingChange: TypingListener): () => void {
  registerRoomListener(roomId, (sets) => sets.typing.add(onTypingChange));
  return () => unregisterRoomListener(roomId, (sets) => sets.typing.delete(onTypingChange));
}

/** Phòng đổi cài đặt (tên/đại diện/ghim tin) — server phát `room-updated` (PATCH rooms/:roomId, PUT/DELETE
 * pin). */
export function subscribeRoomUpdated(roomId: string, onRoomUpdated: RoomUpdatedListener): () => void {
  registerRoomListener(roomId, (sets) => sets.roomUpdated.add(onRoomUpdated));
  return () => unregisterRoomListener(roomId, (sets) => sets.roomUpdated.delete(onRoomUpdated));
}

/** Thành viên phòng thay đổi (thêm/xóa/đổi vai trò) — server phát `room-member-changed`. */
export function subscribeRoomMemberChanged(roomId: string, onMemberChanged: MemberChangedListener): () => void {
  registerRoomListener(roomId, (sets) => sets.memberChanged.add(onMemberChanged));
  return () => unregisterRoomListener(roomId, (sets) => sets.memberChanged.delete(onMemberChanged));
}

/** GIẢI TÁN NHÓM (dissolve) — server phát `room-dissolved` khi trưởng nhóm giải tán nhóm. ConversationScreen
 * dùng để tự rời về danh sách khi phòng đang mở bị giải tán. Trả hàm hủy — gọi khi rời phòng/unmount. */
export function subscribeRoomDissolved(roomId: string, onRoomDissolved: RoomDissolvedListener): () => void {
  registerRoomListener(roomId, (sets) => sets.roomDissolved.add(onRoomDissolved));
  return () => unregisterRoomListener(roomId, (sets) => sets.roomDissolved.delete(onRoomDissolved));
}

/** "Bảng tin" / GHIM NHIỀU (5/8) — danh sách tin ghim thay đổi — server phát `pins-updated` (POST/DELETE .../pins,
 * PUT/DELETE .../pin) kèm NGUYÊN danh sách mới. Dùng cho PinBoardPanel + banner ghim trong ConversationScreen
 * (đồng bộ realtime khi OWNER/ADMIN khác ghim/bỏ ghim). */
export function subscribePinsUpdated(roomId: string, onPinsUpdated: PinsUpdatedListener): () => void {
  registerRoomListener(roomId, (sets) => sets.pinsUpdated.add(onPinsUpdated));
  return () => unregisterRoomListener(roomId, (sets) => sets.pinsUpdated.delete(onPinsUpdated));
}

/** TICK "đã đọc" (5/8) — nhận thông báo `agentId` đã đọc tới `messageId` (createdAt=`lastReadAt` ISO) trong
 * phòng `roomId`. ConversationScreen đổi tick tin CỦA MÌNH sang "đã xem" khi DIRECT peer đọc. Trả hàm hủy —
 * PHẢI gọi khi rời phòng/unmount. */
export function subscribeReadReceipt(roomId: string, onReadReceipt: ReadReceiptListener): () => void {
  registerRoomListener(roomId, (sets) => sets.readReceipt.add(onReadReceipt));
  return () => unregisterRoomListener(roomId, (sets) => sets.readReceipt.delete(onReadReceipt));
}

/** TICK "đã nhận" (6/8) — nhận thông báo `agentId` đang online (đã NHẬN mọi tin tới `deliveredAt` ISO) trong
 * phòng `roomId`. ConversationScreen đổi tick tin của mình sang "đã nhận" (2 tick xám) khi DIRECT peer online.
 * Trả hàm hủy — PHẢI gọi khi rời phòng/unmount. */
export function subscribeDeliveryReceipt(roomId: string, onDeliveryReceipt: DeliveryReceiptListener): () => void {
  registerRoomListener(roomId, (sets) => sets.deliveryReceipt.add(onDeliveryReceipt));
  return () => unregisterRoomListener(roomId, (sets) => sets.deliveryReceipt.delete(onDeliveryReceipt));
}

/** Báo phòng biết mình đang/ngừng gõ chữ (thay `sendTypingStatus()` rc-realtime.ts) — ĐƠN GIẢN HƠN HẲN bản RC:
 * KHÔNG cần tra username RC trước (server tự biết agentId của kết nối qua cookie xác thực lúc upgrade, xem
 * chat-realtime-proxy.ts), gửi thẳng. Best-effort — lỗi mạng/chưa kết nối được → im lặng bỏ qua (tính năng UX
 * phụ, KHÔNG chặn luồng gõ/gửi tin chính, CÙNG nguyên tắc rc-realtime.ts). KHÔNG debounce ở đây — caller
 * (MessageComposer.tsx) tự debounce trước khi gọi. */
export function sendTypingStatus(roomId: string, isTyping: boolean): void {
  ensureSocket()
    .then(() => sendRaw({ type: 'typing', roomId, isTyping }))
    .catch(() => {
      // best-effort — xem docstring.
    });
}

/** B115-tiếp — banner/toast "có tin nhắn mới" khi app đang mở nhưng KHÔNG ở đúng phòng vừa có tin (case #2).
 * KHÁC HẲN subscribeRoomMessages() — KHÔNG cần biết trước roomId nào (nhận `chat-notify` của MỌI phòng agent
 * đang là thành viên), và tự MỞ kết nối NGAY (ensureSocket()) thay vì đợi lượt subscribe-room đầu tiên — CÙNG
 * PATTERN `ensureCallSignalingSocket()` (call-signaling-client.ts) được AppShell.tsx mount 1 LẦN/phiên đăng
 * nhập để giữ kết nối signaling sống xuyên suốt app, BẤT KỂ có màn con nào đang mở. Trả hàm hủy đăng ký — PHẢI
 * gọi lúc unmount (KHÔNG đóng socket — socket dùng CHUNG cho mọi phòng khác, chỉ gỡ listener của riêng caller). */
export function subscribeChatNotify(onNotify: (payload: ChatNotifyEvent) => void): () => void {
  globalNotifyListeners.add(onNotify);
  ensureSocket().catch((err) => console.error('[chat-realtime] không kết nối được real-time (chat-notify):', err));
  return () => {
    globalNotifyListeners.delete(onNotify);
  };
}

/** "Thiết bị đăng nhập" realtime (5/8) — đăng ký nhận tín hiệu `sessions-updated` (đăng nhập thiết bị mới /
 * revoke 1 phiên). CÙNG PATTERN subscribeChatNotify(): tự MỞ kết nối NGAY (ensureSocket) thay vì đợi
 * subscribe-room, để màn "Tài khoản & bảo mật" nhận được cập nhật dù không mở phòng chat nào. Trả hàm hủy —
 * PHẢI gọi lúc unmount (KHÔNG đóng socket dùng chung, chỉ gỡ listener của caller). */
export function subscribeSessionsUpdated(onUpdate: () => void): () => void {
  globalSessionsUpdatedListeners.add(onUpdate);
  ensureSocket().catch((err) => console.error('[chat-realtime] không kết nối được real-time (sessions-updated):', err));
  return () => {
    globalSessionsUpdatedListeners.delete(onUpdate);
  };
}

/** #32 (6/8, Admin Demo "push nhật ký REALTIME") — đăng ký nhận `diary-notify` (bạn bè vừa đăng bài Nhật ký) để
 * chuông đỏ +1 NGAY, KHÔNG cần refresh. CÙNG PATTERN subscribeChatNotify(): tự MỞ kết nối NGAY (ensureSocket) để
 * NotificationBell (nằm ở TopBar, luôn hiển thị) nhận được dù không mở phòng chat/màn Nhật ký nào. Trả hàm hủy —
 * PHẢI gọi lúc unmount (KHÔNG đóng socket dùng chung, chỉ gỡ listener của caller). */
export function subscribeDiaryNotify(onNotify: (payload: DiaryNotifyEvent) => void): () => void {
  globalDiaryNotifyListeners.add(onNotify);
  ensureSocket().catch((err) => console.error('[chat-realtime] không kết nối được real-time (diary-notify):', err));
  return () => {
    globalDiaryNotifyListeners.delete(onNotify);
  };
}

/** 8/8 (Admin Demo "đồng bộ hóa mọi push event số đếm") — đăng ký nhận `agent-notify` (kết bạn/nhóm) để chuông đỏ +1
 * NGAY. CÙNG PATTERN subscribeDiaryNotify(): tự MỞ kết nối NGAY (ensureSocket) để NotificationBell (ở TopBar, luôn
 * hiển thị) nhận được dù không mở phòng/màn nào. Trả hàm hủy — PHẢI gọi lúc unmount (chỉ gỡ listener, KHÔNG đóng
 * socket dùng chung). */
export function subscribeAgentNotify(onNotify: (payload: AgentNotifyEvent) => void): () => void {
  globalAgentNotifyListeners.add(onNotify);
  ensureSocket().catch((err) => console.error('[chat-realtime] không kết nối được real-time (agent-notify):', err));
  return () => {
    globalAgentNotifyListeners.delete(onNotify);
  };
}
