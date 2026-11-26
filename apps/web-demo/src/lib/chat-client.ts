// SIGMA Phase 2 "chat lõi" (29/7) — adapter frontend cho REST chat TỰ XÂY mới (`/v1/chat/*`, xem
// apps/bot-api/src/routes/chat.ts) — SONG SONG `rc-realtime.ts` (Rocket.Chat cũ), KHÔNG sửa/KHÔNG cắt file đó
// — Phase 2 chạy CHUNG với RC cũ cho tới khi LEAD quyết định cắt hẳn RC (chưa xảy ra ở phiên này).
//
// ĐỘ TIN CẬY SHAPE DTO (đọc trước khi sửa mapping bên dưới):
//   - CẬP NHẬT (29/7, SAU KHI Agent A hoàn tất `services/chat-room-service.ts` giữa lúc viết file này — đã tự
//     ĐỌC LẠI CODE THẬT, KHÔNG còn giả định): mọi DTO bên dưới (`ChatMessageDto`/`ChatReactionDto`/
//     `ChatRoomSummaryDto`/`ChatRoomDetailDto`/`ChatRoomEmbeddedMemberDto`) map TRỰC TIẾP field export type
//     thật `RoomSummaryDto`/`ChatRoomWithMembers`(=`RoomDetailDto`)/`ChatRoomMemberDto` trong
//     apps/bot-api/src/services/chat-room-service.ts + model Prisma `ChatMessage`/`ChatMessageReaction`. Ngày
//     tháng Prisma (kiểu `Date` phía TS server) serialize qua JSON là chuỗi ISO, map thẳng sang `string` ở FE.
//   - LƯU Ý QUAN TRỌNG: `RoomSummaryDto` (danh sách phòng) và `RoomDetailDto` (chi tiết 1 phòng) là **2 SHAPE
//     KHÁC HẲN NHAU** (KHÔNG phải 1 mở rộng của cái kia) — summary có `otherAgentId`/`lastMessage`/
//     `unreadCount`/`myRole` (không có `members`), detail có `members`/`directPairKey`/`createdBy`/`createdAt`/
//     `updatedAt` (KHÔNG có `otherAgentId`/`lastMessage`/`unreadCount`). Đừng gộp 2 type này lại.
//   - Phòng DIRECT KHÔNG có `name` sẵn (`null` — service CỐ Ý không tự tra Agent.name, xem comment
//     `RoomSummaryDto.otherAgentId` trong chat-room-service.ts: "route/FE tự tra Agent.name/avatar") —
//     `mapChatRoomSummary()` nhận thêm tham số optional `resolveDirectName` để caller tự cung cấp tên thật từ
//     danh bạ Agent hiện có (vd agents.ts) nếu có, fallback về "Đại lý #<id>" nếu không truyền.
//   - `ChatRoomMemberDto` (thành viên nhúng trong `ChatRoomWithMembers.members`, qua `toMemberDto()`) KHÔNG có
//     `id`/`roomId` riêng — KHÁC HẲN response `GET /v1/chat/rooms/:roomId/members` (route riêng ở
//     routes/chat.ts, đọc thẳng `db.chatRoomMember.findMany()` → CÓ `id`/`roomId`) — 2 type tách biệt bên dưới
//     (`ChatRoomEmbeddedMemberDto` vs `ChatRoomMemberDto`), đừng lẫn.
//   - `myAgentId` (số, Agent.id) KHÔNG có sẵn trong `SigMaSession` cục bộ hiện tại (`session.ts` chỉ giữ
//     `userId` = rcUserId RC dạng string + `agentName`, xem comment đầu session.ts "userId Rocket.Chat") —
//     CÙNG PATTERN mọi screen hiện có (ProfileScreen.tsx/MyQrScreen.tsx/SettingsScreen.tsx) đang tự gọi
//     `fetchAuthenticatedAgent()` (bot-api-client.ts, GET /v1/auth/me) mỗi màn để lấy id thật — file này
//     KHÔNG tự cache/gọi lại, các hàm map cần `myAgentId` nhận nó làm THAM SỐ do caller tự lấy trước (component
//     màn hình chat tự gọi fetchAuthenticatedAgent() 1 lần, giữ agent.id ở state, truyền vào).
import type { ChatMessage as UiChatMessage, ChatMessageStatus, ChatMessageType, ChatRoom as UiChatRoom, MessageReaction, TransferCkMeta, TransferCkKind, PosBillMeta } from '../mock-data/types';
import { handleSessionExpired } from './session';
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';
import { getCachedFriends } from './friends-cache';
import { avatarColorForAgent, avatarColorForKey } from './avatar-color';
import { parseBillMetadata } from './bill-message-meta';
import { parseRefundMetadata } from './refund-message-meta';
import { parseMentionNames } from './mention';

// Phase 3 "real-time" (29/7, cutover chat text khỏi RC) — CÙNG CON SỐ `MESSAGE_DELETE_WINDOW_HOURS` thật ở
// apps/bot-api/src/services/chat-message-service.ts (server LUÔN là nguồn enforce thật — hằng số ở đây CHỈ để
// UI tự ẩn/khóa nút "Xóa" TRƯỚC khi gọi, tránh round-trip vô ích, giống hệt cách RECALL_WINDOW_HOURS cũ ở
// rc-realtime.ts từng làm cho luồng "Thu hồi" cũ). Đổi số giờ ở backend PHẢI đổi cả ở đây (2 nơi, chưa có cách
// nào chia sẻ hằng số giữa app Node backend và app Vite frontend trong monorepo này, xem comment tương tự ở
// chat-message-service.ts giải thích lý do không import chéo app→app).
export const MESSAGE_DELETE_WINDOW_HOURS = 48;

/** true nếu tin nhắn còn trong cửa sổ được xóa (48h kể từ lúc gửi) — dùng để ẩn/khóa nút "Xóa" ở UI TRƯỚC khi
 * gọi `deleteChatMessage()` (server tự kiểm lại lần nữa — belt-and-suspenders, không tin riêng UI). */
export function canDeleteChatMessage(sentAtIso: string | undefined): boolean {
  if (!sentAtIso) return false;
  const sentMs = new Date(sentAtIso).getTime();
  if (Number.isNaN(sentMs)) return false;
  const ageMs = Date.now() - sentMs;
  return ageMs >= 0 && ageMs <= MESSAGE_DELETE_WINDOW_HOURS * 60 * 60 * 1000;
}

// B112 (2/8, "Sửa" bill đã gửi) — CÙNG CON SỐ `MESSAGE_EDIT_WINDOW_HOURS` thật ở chat-message-service.ts
// (Admin Demo chốt 29/7, cửa sổ SỬA = 1h, KHÁC HẲN 48h của Xóa/Thu hồi ở trên — 2 hằng số ĐỘC LẬP, KHÔNG dùng
// chung, xem comment `MESSAGE_DELETE_WINDOW_HOURS`/regression "2 cửa sổ ĐỘC LẬP nhau" chat-message-service.test.ts).
export const MESSAGE_EDIT_WINDOW_HOURS = 1;

/** true nếu tin nhắn còn trong cửa sổ được sửa (1h kể từ lúc gửi) — dùng để ẩn/khóa nút "Sửa" ở UI TRƯỚC khi
 * gọi `editChatMessage()` (server tự kiểm lại lần nữa). CÙNG khuôn `canDeleteChatMessage()`. */
export function canEditChatMessage(sentAtIso: string | undefined): boolean {
  if (!sentAtIso) return false;
  const sentMs = new Date(sentAtIso).getTime();
  if (Number.isNaN(sentMs)) return false;
  const ageMs = Date.now() - sentMs;
  return ageMs >= 0 && ageMs <= MESSAGE_EDIT_WINDOW_HOURS * 60 * 60 * 1000;
}

/** B112 (2/8) — điều kiện ĐẦY ĐỦ để hiện nút "Sửa" trên 1 bong bóng ẢNH bill: của CHÍNH mình, ĐÃ ghép đủ dữ
 * liệu (`billMeta` parse được — bill fallback ảnh gốc chưa ghép KHÔNG đủ field, xem `parseBillMetadata()`
 * bill-message-meta.ts), CÒN trong cửa sổ sửa 1h. Hàm THUẦN (không I/O) — dùng CHUNG cho ChatBubble.tsx (hiện/
 * ẩn nút) VÀ ConversationScreen.tsx (chặn mở panel sửa nếu bấm đúng lúc hết hạn). */
export function canEditBillMessage(message: Pick<UiChatMessage, 'mine' | 'isBillImage' | 'billMeta' | 'sentAtIso'>): boolean {
  return !!message.mine && message.isBillImage === true && !!message.billMeta && canEditChatMessage(message.sentAtIso);
}

/** B123 (2/8, tính năng "Hoàn tiền" MỚI) — điều kiện hiện nút "Hoàn tiền" trong menu ngữ cảnh: tin là ẢNH BILL
 * GỐC đã ghép ĐỦ dữ liệu (`billMeta` parse được — CÙNG điều kiện cấu trúc `canEditBillMessage()`, KHÔNG bịa
 * điều kiện mới) — CỐ Ý KHÔNG đòi `mine` (Admin Demo chốt trực tiếp 2/8: "xác nhận hoàn tiền = quyền y hệt gửi
 * tin nhắn thường trong phòng, không hơn không kém" — BẤT KỲ thành viên đang hoạt động nào của phòng đều xác
 * nhận được, không riêng người gửi bill gốc) và KHÔNG đòi cửa sổ thời gian nào (hoàn tiền có thể xảy ra rất lâu
 * sau khi bill gốc đã gửi, KHÁC hẳn "Sửa" — cửa sổ 1h chỉ áp cho SỬA NỘI DUNG tin nhắn, không áp cho hành động
 * nghiệp vụ mới tạo tin nhắn riêng). */
export function canOpenRefund(message: Pick<UiChatMessage, 'isBillImage' | 'billMeta'>): boolean {
  return message.isBillImage === true && !!message.billMeta;
}

/** B123 (2/8) — điều kiện hiện nút "Sửa" cho MỘT LẦN HOÀN TIỀN cụ thể (tin nhắn ẢNH hoàn tiền ĐÃ GỬI) — CÙNG
 * khuôn `canEditBillMessage()` (của CHÍNH mình + đủ dữ liệu + còn cửa sổ 1h) — sửa NỘI DUNG 1 tin ĐÃ GỬI vẫn
 * theo đúng quy tắc "Sửa" chung toàn hệ thống (KHÁC quyền MỞ panel hoàn tiền MỚI ở trên, đây là sửa tin đã có). */
export function canEditRefundMessage(message: Pick<UiChatMessage, 'mine' | 'isRefundImage' | 'refundMeta' | 'sentAtIso'>): boolean {
  return !!message.mine && message.isRefundImage === true && !!message.refundMeta && canEditChatMessage(message.sentAtIso);
}

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

/** CÙNG khuôn `BotApiResult` (bot-api-client.ts) — giữ `error` (mã lỗi thô từ route, vd `NOT_MEMBER`/
 * `CANNOT_MESSAGE`/`DELETE_WINDOW_EXPIRED`, xem routes/chat.ts) để UI tự quyết định hiển thị/khóa nút theo
 * TỪNG mã thay vì chỉ đọc `message` chung chung. */
export type ChatApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

const SESSION_EXPIRED_MESSAGE_VI = 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.';

/** Gói fetch chung cho MỌI endpoint `/v1/chat/*`. Dùng `proxyFetch()` (không phải `fetch()` trần, KHÁC
 * `botApiFetch()` ở bot-api-client.ts vốn chỉ hardcode POST) để hỗ trợ GET/POST/PATCH/PUT/DELETE tùy route.
 * 401 THẬT ở đây LUÔN là "chưa đăng nhập/phiên hết hạn" (route dùng `requireSession` đọc thẳng WebSession cục
 * bộ, KHÔNG proxy sang RC) — KHÁC `rc-realtime.ts` (handleRcAuthExpiry() ở đó phải thử xác nhận lại 401 vì RC
 * thật có thể chỉ rate-limit thoáng qua, xem comment ở đó) — 401 ở đây dọn phiên NGAY, không cần bước xác
 * nhận lại đó. */
async function chatFetch<T>(path: string, init: RequestInit = {}): Promise<ChatApiResult<T>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}${path}`, init);
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }
  const body = json as { ok?: boolean; data?: T; error?: string; message?: string } | null;
  if (!res.ok || body?.ok !== true) {
    if (res.status === 401) {
      handleSessionExpired();
      return { ok: false, error: 'SESSION_INVALID', message: SESSION_EXPIRED_MESSAGE_VI };
    }
    return { ok: false, error: body?.error ?? 'UNKNOWN_ERROR', message: body?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: body!.data as T };
}

function jsonInit(method: string, payload?: unknown): RequestInit {
  if (payload === undefined) return { method };
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

// ── DTO thô trả từ bot-api ───────────────────────────────────────────────────────────────────────────────

/** Map TRỰC TIẾP model Prisma `ChatMessage` — xem ghi chú độ tin cậy đầu file. */
export interface ChatMessageDto {
  id: string;
  roomId: string;
  senderId: number | null;
  /** Tên người gửi (Admin Demo 1/9) — server tra thẳng bảng agents (listMessages attachSenderName), kể cả BOT/agent
   *  ngoài danh bạ. `null` nếu senderId rỗng. Client ưu tiên danh bạ user → field này → fallback "Đại lý #id". */
  senderName?: string | null;
  kind: 'TEXT' | 'IMAGE' | 'FILE' | 'VOICE' | 'LOCATION' | 'QR' | 'SYSTEM';
  body: string | null;
  attachmentId: string | null;
  metadataJson: string | null;
  replyToMessageId: string | null;
  forwardedFromMessageId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  // debt-chat-gaps (31/7, Việc 2) — mimeType/sizeBytes THẬT của attachment (magic-bytes lúc upload, xem
  // chat-attachment-service.ts) — server giờ JOIN sẵn vào response `POST/GET .../messages` (sendMessage()/
  // listMessages(), chat-message-service.ts). `null` = tin KHÔNG có attachmentId (TEXT/VOICE/LOCATION/QR) hoặc
  // attachment đã bị xóa khỏi bảng chat_attachments (không nên xảy ra bình thường).
  attachmentMimeType: string | null;
  attachmentSizeBytes: number | null;
}

/** Map TRỰC TIẾP model Prisma `ChatMessageReaction`. */
export interface ChatReactionDto {
  id: number;
  messageId: string;
  agentId: number;
  emoji: string;
  createdAt: string;
}

/** Response THẬT của `GET /v1/chat/rooms/:roomId/members` (routes/chat.ts đọc thẳng
 * `db.chatRoomMember.findMany()`, KHÔNG qua `toMemberDto()`) — CÓ `id`/`roomId`, KHÁC
 * `ChatRoomEmbeddedMemberDto` bên dưới (nhúng trong chi tiết phòng). */
export interface ChatRoomMemberDto {
  id: number;
  roomId: string;
  agentId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: string;
  leftAt: string | null;
  lastReadMessageId: string | null;
  mutedUntil: string | null;
  // #32 (8/8, Admin Demo "member list hiện Đại lý #id sai") — server ĐÃ trả `name` + `deactivated` (routes/chat.ts
  // members endpoint) nhưng TRƯỚC ĐÂY DTO không khai → client vứt, phải dựa resolveName (map thiếu → "Đại lý #id").
  // Khai để dùng THẲNG m.name (tên thật, đồng nhất mọi user vì do server enrich).
  name?: string | null;
  deactivated?: boolean;
}

/** Thành viên nhúng trong `ChatRoomDetailDto.members` — map `chat-room-service.ts` `ChatRoomMemberDto`/
 * `toMemberDto()` (KHÔNG có `id`/`roomId` riêng, xem ghi chú đầu file). */
export interface ChatRoomEmbeddedMemberDto {
  agentId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: string;
  leftAt: string | null;
  lastReadMessageId: string | null;
  mutedUntil: string | null;
  // TICK "đã nhận" (6/8) — CHỈ có ở GET /v1/chat/rooms/:roomId (route đính kèm từ agentHasOpenConnection, xem
  // routes/chat.ts) — true = thành viên đang có WS mở (online). `undefined` cho response KHÁC không đính kèm
  // presence (createGroupRoom/findOrCreateDirectRoom trả detail KHÔNG qua nhánh enrich đó). ConversationScreen
  // dùng để hiện "đã nhận" (2 tick xám) NGAY lúc mở phòng nếu đối phương đang online.
  online?: boolean;
  /** Presence "X phút trước" (6/8) — ISO hoạt động cuối của thành viên (offline) hoặc null. Server đính kèm cùng
   *  `online` ở GET /v1/chat/rooms/:roomId. FE seed vào presence-store cho header phòng DIRECT. */
  lastSeenAt?: string | null;
}

/** Tin nhắn gần nhất rút gọn, nhúng trong `ChatRoomSummaryDto.lastMessage`. */
export interface ChatRoomLastMessagePreview {
  id: string;
  kind: string;
  body: string | null;
  senderId: number | null;
  createdAt: string;
}

/** Map ĐÚNG `RoomSummaryDto` thật (`listRoomsForAgent()`, chat-room-service.ts) — xem ghi chú đầu file. */
export interface ChatRoomSummaryDto {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  otherAgentId: number | null;
  avatarColor: string | null;
  avatarUrl: string | null;
  pinnedMessageId: string | null;
  lastMessageAt: string | null;
  lastMessage: ChatRoomLastMessagePreview | null;
  unreadCount: number;
  myRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  /** Item 13 (6/8) — presence ONLINE của đối phương phòng DIRECT (agentHasOpenConnection, đính ở route GET
   *  /rooms). undefined cho GROUP (presence nhóm chưa định nghĩa) hoặc response cũ không đính. */
  online?: boolean;
  /** Presence "X phút trước" (6/8) — ISO hoạt động cuối của đối phương DIRECT (offline) hoặc null. Server đính
   *  kèm; FE seed vào presence-store. */
  lastSeenAt?: string | null;
  /** Menu hội thoại (7/8) — trạng thái tắt thông báo / ghim hội thoại lên đầu (per-agent). Server đính kèm
   *  (mutedUntil>now / pinnedAt!=null). undefined ở response cũ → coi như false. */
  muted?: boolean;
  pinned?: boolean;
}

/** Map ĐÚNG `RoomDetailDto` = `ChatRoomWithMembers` thật (`getRoomDetail()`/`findOrCreateDirectRoom()`/
 * `createGroupRoom()`, chat-room-service.ts) — KHÔNG mở rộng `ChatRoomSummaryDto` (2 shape khác hẳn, xem ghi
 * chú đầu file). */
export interface ChatRoomDetailDto {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  avatarColor: string | null;
  avatarUrl: string | null;
  directPairKey: string | null;
  pinnedMessageId: string | null;
  lastMessageAt: string | null;
  // debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" (ChatRoom.readOnly, xem comment
  // schema.prisma + GroupInfoPanel.tsx). true = CHỈ OWNER/ADMIN gửi được tin (enforce THẬT ở server
  // sendMessage(), field này CHỈ để FE tự khóa MessageComposer/hiện thông báo trước).
  readOnly: boolean;
  // "nhóm chat đầy đủ như Zalo" (5/8) — cờ DUYỆT thành viên + GIỚI HẠN số thành viên (null = không giới hạn).
  // Map TRỰC TIẾP `ChatRoomWithMembers.requireApproval`/`maxMembers` thật (chat-room-service.ts, đã đọc code):
  // enforce THẬT ở server (requestJoin/addMember/approveJoin) — FE dùng để hiện đúng trạng thái toggle + ô số.
  requireApproval: boolean;
  maxMembers: number | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  members: ChatRoomEmbeddedMemberDto[];
}

/** fix-call-wiring (31/7) — trước đây `ConversationRoute` (App.tsx) chưa từng resolve agentId đối phương nên
 * nút "Gọi thoại"/"Gọi video" từ 1 hội thoại THẬT luôn rơi vào "chế độ xem trước" (KHÔNG đổ chuông thật, xem
 * comment đầu CallScreen.tsx) — gap để lại CỐ Ý lúc build Phase 4 ("nối 1 agentId cụ thể vào route thật là việc
 * CỦA LEAD sau khi ChatRoom có field agentId thật"). `ChatRoom` (UI, mock-data/types.ts) KHÔNG mang agentId đối
 * phương — phải tự tra qua `ChatRoomDetailDto.members` (đã có `agentId` trên từng thành viên, xem
 * `ChatRoomEmbeddedMemberDto`). Hàm THUẦN (không I/O) — test được không cần dựng cây React, CÙNG pattern
 * `buildIncomingCallNavigation()` (call-signaling-client.ts).
 *
 * CHỈ áp dụng phòng DIRECT (GROUP luôn trả `null` — Phase 4 "CHỈ làm gọi 1-1", xem comment đầu
 * CallScreen.tsx/call-signaling-server.ts, KHÔNG có khái niệm "gọi nhóm" để mà chọn 1 agentId nào đại diện).
 * Loại cả thành viên ĐÃ RỜI phòng (`leftAt !== null` — `RoomDetailDto` trả kèm CẢ người đã rời, xem comment
 * `ChatRoomWithMembers`/`toRoomWithMembers()` chat-room-service.ts) — nếu đối phương đã rời (rất hiếm với DM,
 * nhưng `removeMember()` không chặn theo type phòng) trả `null`, KHÔNG trả nhầm agentId của người không còn ở
 * phòng. Trả `null` cũng nếu không tìm thấy ai khác `myAgentId` (dữ liệu bất thường — phòng DIRECT lẽ ra luôn
 * có đúng 2 thành viên, xem `findOrCreateDirectRoom()`) — caller (ConversationScreen.tsx) tự fallback: vẫn điều
 * hướng sang màn gọi nhưng KHÔNG kèm `calleeAgentId`, CallScreen tự rơi về "chế độ xem trước" y hệt hành vi cũ,
 * KHÔNG throw/vỡ màn. */
export function resolveDirectPeerAgentId(detail: ChatRoomDetailDto, myAgentId: number): number | null {
  if (detail.type !== 'DIRECT') return null;
  const peer = detail.members.find((m) => m.agentId !== myAgentId && m.leftAt === null);
  return peer ? peer.agentId : null;
}

// ── Mapping DTO → kiểu UI hiện có (mock-data/types.ts, KHÔNG tạo type trùng lặp mới) ────────────────────────

/** Việc 2 (1/8, fix "avatar cùng 1 agent hiện 2 màu khác nhau" — BUG CŨ: hàm `colorForId()` ở đây hash theo
 * ROOM id (cuid), KHÔNG PHẢI agentId — 2 người trò chuyện DIRECT không liên quan gì tới roomId nên màu hiển
 * thị ở đây LUÔN lệch với màu ContactsScreen.tsx tính theo agentId, dù CÙNG 1 người. Sửa: phòng DIRECT dùng
 * `avatarColorForAgent(otherAgentId)` — CÙNG khóa agentId với ContactsScreen/GroupInfoPanel (đã hợp nhất về
 * avatar-color.ts, xem comment đầu file đó) — chỉ phòng GROUP (không đại diện 1 người, không có agentId nào
 * phù hợp) mới fallback về `avatarColorForKey(dto.id)` theo roomId như cũ. */
function fallbackRoomAvatarColor(dto: ChatRoomSummaryDto): string {
  if (dto.type === 'DIRECT' && dto.otherAgentId != null) return avatarColorForAgent(dto.otherAgentId);
  return avatarColorForKey(dto.id);
}

/** CÙNG Ý TƯỞNG `formatMessageTime()` ở rc-realtime.ts (không export được, viết lại tối giản). EXPORT (6/8,
 * bug E) — ChatListScreen cập nhật `lastTime` phòng khi có tin MỚI realtime (chat-notify) dùng CÙNG format,
 * tránh lệch cách hiển thị giờ so với dữ liệu tải từ server (mapChatRoomSummary cũng dùng hàm này). */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Hôm qua';
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}

const KIND_TO_TYPE: Record<ChatMessageDto['kind'], ChatMessageType> = {
  TEXT: 'text',
  IMAGE: 'image',
  FILE: 'file',
  VOICE: 'voice',
  LOCATION: 'location',
  QR: 'qr',
  SYSTEM: 'system'
};

/** Preview hiển thị cho tin nhắn gần nhất — TEXT hiện nguyên `body`, các kind khác hiện nhãn ngắn gọn (server
 * KHÔNG tự sinh caption hiển thị, tự quyết định câu chữ ở FE, CÙNG tinh thần `file`/`voice`/`location` đã có
 * label riêng trong UI hiện có). */
function previewTextForLastMessage(msg: ChatRoomLastMessagePreview | null): string {
  if (!msg) return '';
  if (msg.kind === 'TEXT') return msg.body ?? '';
  const KIND_PREVIEW_VI: Record<string, string> = {
    IMAGE: '[Hình ảnh]',
    FILE: '[Tệp đính kèm]',
    VOICE: '[Tin nhắn thoại]',
    LOCATION: '[Vị trí]',
    QR: '[Mã QR]'
  };
  return KIND_PREVIEW_VI[msg.kind] ?? msg.body ?? '';
}

/** "Bảng tin" (5/8) — nhãn xem trước cho 1 tin ĐÃ GHIM. TEXT hiện nguyên nội dung; kind khác hiện nhãn tiếng
 * Việt ngắn (CÙNG bộ chữ `previewTextForLastMessage()` ở trên để 1 loại tin = 1 câu chữ xuyên toàn app, KHÔNG
 * bịa câu khác). `null` (tin đã thu hồi sau khi ghim) → "Tin nhắn đã bị xóa" (CÙNG placeholder mapChatMessage()).
 * Hàm THUẦN (không I/O) — export để PinBoardPanel dùng + test độc lập không cần dựng React. */
export function pinnedMessagePreview(message: PinnedMessageDto['message']): string {
  if (!message) return DELETED_MESSAGE_PLACEHOLDER_VI;
  if (message.kind === 'TEXT') return (message.body ?? '').trim();
  if (message.kind === 'IMAGE' && message.metadataJson) {
    try {
      const parsed = JSON.parse(message.metadataJson) as { isBillImage?: boolean; isRefundImage?: boolean };
      if (parsed.isBillImage === true) return '[Bill]';
      if (parsed.isRefundImage === true) return '[Hoàn tiền]';
    } catch {
      // metadataJson hỏng — coi như ảnh thường, rơi xuống nhãn mặc định (KHÔNG throw — hiển thị phụ, CÙNG
      // nguyên tắc parse metadataJson ở mapChatMessage()).
    }
  }
  const KIND_PREVIEW_VI: Record<string, string> = {
    IMAGE: '[Hình ảnh]',
    FILE: '[Tệp đính kèm]',
    VOICE: '[Tin nhắn thoại]',
    LOCATION: '[Vị trí]',
    QR: '[Mã QR]'
  };
  return KIND_PREVIEW_VI[message.kind] ?? (message.body ?? '').trim();
}

/** `resolveDirectName` — optional: với phòng DIRECT (`dto.name` LUÔN `null`, service cố ý không tự tra tên đối
 * phương, xem ghi chú đầu file), caller tự cung cấp tên hiển thị thật (tra từ danh bạ Agent hiện có, vd
 * agents.ts) theo `otherAgentId`. Không truyền → fallback "Đại lý #<id>". */
export function mapChatRoomSummary(dto: ChatRoomSummaryDto, resolveDirectName?: (otherAgentId: number) => string | undefined): UiChatRoom {
  const directName = dto.type === 'DIRECT' && dto.otherAgentId != null ? resolveDirectName?.(dto.otherAgentId) : undefined;
  return {
    id: dto.id,
    name: dto.name ?? directName ?? (dto.type === 'DIRECT' ? `Đại lý #${dto.otherAgentId ?? '?'}` : 'Nhóm chat'),
    isGroup: dto.type === 'GROUP',
    // BUG#7 (6/8, Admin Demo "màu avatar cùng người lệch nhau giữa chat-list và danh bạ/thông báo") — phòng
    // DIRECT LUÔN lấy màu theo `avatarColorForAgent(otherAgentId)` (CÙNG hàm hợp nhất mà Danh bạ/thông báo
    // dùng), BỎ QUA `dto.avatarColor` do server sinh theo room (roomId cuid không liên quan danh tính đối
    // phương → màu lệch). GROUP giữ nguyên `dto.avatarColor` (nhóm có màu riêng, không đại diện 1 agent) rồi
    // mới fallback. fallbackRoomAvatarColor() cũng đã dùng avatarColorForAgent cho DIRECT nên nhánh này chỉ
    // BỎ ưu tiên sai của dto.avatarColor với DIRECT — cùng người ở mọi màn ra CÙNG màu.
    avatarColor:
      dto.type === 'DIRECT' && dto.otherAgentId != null
        ? avatarColorForAgent(dto.otherAgentId)
        : (dto.avatarColor ?? fallbackRoomAvatarColor(dto)),
    lastMessage: previewTextForLastMessage(dto.lastMessage),
    lastTime: dto.lastMessageAt ? formatMessageTime(dto.lastMessageAt) : '',
    unreadCount: dto.unreadCount,
    pinnedMessageId: dto.pinnedMessageId ?? undefined,
    // 5/8 — giữ agentId đối phương (phòng DIRECT) để danh sách chat/header hiện ẢNH avatar THẬT của người đó
    // (AgentAvatar) thay vì chỉ chữ cái đầu. GROUP → null (nhóm có avatar riêng, không đại diện 1 agent).
    otherAgentId: dto.type === 'DIRECT' ? dto.otherAgentId : null,
    // Avatar nhóm đồng bộ (8/8, Admin Demo "avatar nhóm các giao diện chưa đồng bộ") — server ĐÃ trả `avatarUrl`
    // (đường dẫn /v1/chat/rooms/:id/avatar khi nhóm đã upload ảnh, null nếu chưa — xem saveRoomAvatar()
    // chat-room-service.ts). Rút thành cờ boolean để MỌI nơi render (RoomAvatar) biết CÓ ảnh nhóm hay không mà
    // KHÔNG phải tự dò 404 từng phòng. Chỉ GROUP mới có khái niệm này; DIRECT → undefined.
    hasGroupAvatar: dto.type === 'GROUP' ? dto.avatarUrl != null : undefined,
    // Item 13 (6/8) — presence ONLINE đối phương (DIRECT). GROUP: undefined (chưa định nghĩa presence nhóm) →
    // ChatList tự ẩn chấm. Chỉ passthrough, KHÔNG suy diễn.
    online: dto.online,
    // "X phút trước" (6/8) — ISO hoạt động cuối đối phương DIRECT (passthrough, seed presence-store ở ChatListScreen).
    lastSeenAt: dto.lastSeenAt ?? null,
    // Menu hội thoại (7/8) — mute/pin (server đính; response cũ thiếu → false).
    muted: dto.muted ?? false,
    pinned: dto.pinned ?? false
  };
}

/** Phase 3 "real-time" (29/7) — trỏ tới `GET /v1/chat/attachments/:id` (bot-api, xem routes/chat-attachments.ts,
 * KHÔNG đổi bởi Phase 3 — endpoint đã có sẵn từ 27/7). Đặt tên khác `attachmentDownloadUrl` ở rc-realtime.ts
 * (file đó KHÔNG sửa) dù cùng URL pattern — 2 hệ thống độc lập, tránh import chéo. EXPORT (debt-chat-gaps 31/7,
 * Việc 3) — GroupInfoPanel.tsx tab "File" cần dựng link tải MỖI attachment trong danh sách phòng, tái dùng
 * ĐÚNG hàm này thay vì tự viết lại URL pattern ở nơi khác. */
export function chatAttachmentDownloadUrl(attachmentId: string): string {
  return `${botApiBaseUrl()}/v1/chat/attachments/${attachmentId}`;
}

/** debt-chat-gaps (31/7, Việc 2) — GAP đã ghi trong báo cáo Phase 3 giờ ĐÃ ĐÓNG: `ChatMessageDto` giờ mang
 * `attachmentMimeType` THẬT (magic-bytes, xem comment interface trên) — suy ra loại file theo MIME THẬT thay vì
 * đoán theo đuôi tên (`guessFileKindFromName()` CŨ, ĐÃ XÓA — không còn cần đoán vì đã có dữ liệu thật). Fallback
 * 'pdf' cho mime lạ/null (không nên xảy ra với luồng upload mới — allowlist chat-attachment-service.ts chỉ 3
 * loại FILE hợp lệ: pdf/docx/xlsx) — giữ UI không vỡ icon nếu gặp dữ liệu cũ/lạ. */
function fileKindFromMime(mime: string | null): 'pdf' | 'xlsx' | 'docx' {
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  return 'pdf';
}

/** debt-chat-gaps (31/7, Việc 2) — định dạng `sizeBytes` THẬT thành chuỗi hiển thị ngắn gọn (KB/MB), CÙNG ngưỡng
 * đơn vị phổ biến các app chat khác dùng — trước đây `FileMessageCard` luôn nhận `size: ''` (rỗng, KHÔNG có dữ
 * liệu thật để hiển thị, xem comment cũ guessFileKindFromName()). */
function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** SIGMA (31/7, việc #5 — ghi âm/phát tin nhắn thoại THẬT) — định dạng số giây thành nhãn `m:ss` hiển thị
 * (vd 23 → "0:23", 65 → "1:05"), CÙNG khuôn nhãn mock cũ (`mock-data/chats.ts` `voice.duration`). Hàm THUẦN,
 * export để test + để `VoiceMessageBubble.tsx` dùng lại (parse ngược, xem `parseDurationLabelToSeconds` dưới)
 * khi cần 1 mẫu số làm mẫu số progress bar (audio.duration của Blob MediaRecorder-ghi THƯỜNG là `Infinity` ở
 * Chrome/Chromium ngay sau khi tải — lỗi trình duyệt đã biết rộng rãi với WebM do MediaRecorder tạo ra, không
 * ghi sẵn Duration/Cues trong header — nên KHÔNG thể tin `audio.duration` làm mẫu số đáng tin cậy, phải có
 * phương án dự phòng từ giá trị đã đo THẬT lúc ghi âm, xem MessageComposer.tsx). Âm/NaN → clamp về 0.
 */
export function formatSecondsToDurationLabel(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.round(totalSeconds) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Ngược lại `formatSecondsToDurationLabel()` — parse nhãn "m:ss" (hoặc "h:mm:ss" hiếm khi ghi âm rất dài)
 * thành tổng số giây. Nhãn hỏng/không đúng dạng số → trả 0 (KHÔNG throw — đây chỉ là mẫu số dự phòng hiển thị,
 * không phải dữ liệu nghiệp vụ nhạy cảm, cùng nguyên tắc parse metadataJson LOCATION/QR ở mapChatMessage()). */
export function parseDurationLabelToSeconds(label: string): number {
  const parts = label.split(':').map((p) => Number(p));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p) || p < 0)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const DELETED_MESSAGE_PLACEHOLDER_VI = 'Tin nhắn đã bị xóa';

/** Shape THÔ của `metadataJson` bill CHUYỂN KHOẢN (CK) — khớp CHÍNH XÁC field backend sinh ở
 *  apps/bot-api/src/ocr-send-service.ts (đã đọc code THẬT, KHÔNG đoán):
 *   - Đại lý (postDealerRefundCk): `{ isTransferRefund, isDealerRefundCk|isDealerAdvanceCk, refundAmount (signed),
 *     ckTxnKey, billDate, receiverAcct, senderName }` — KHÔNG có `direction`.
 *   - NĐT tạm ứng (postInvestorTransferCk): `{ isTransferRefund, isInvestorAdvanceCk, direction, advanceAmount,
 *     ckTxnKey, investorId }` — KHÔNG có `billDate`.
 *   - NĐT hoàn thừa: `{ isTransferRefund, isInvestorRepaymentCk, direction, repaymentAmount, ckTxnKey, investorId }`. */
interface RawTransferCkMetadata {
  isTransferRefund?: boolean;
  isDealerRefundCk?: boolean;
  isDealerAdvanceCk?: boolean;
  isInvestorAdvanceCk?: boolean;
  isInvestorRepaymentCk?: boolean;
  refundAmount?: number;
  advanceAmount?: number;
  repaymentAmount?: number;
  ckTxnKey?: string;
  billDate?: string;
  direction?: string;
  senderName?: string; // tên người GỬI trên bill CK (Admin Demo 1/9 "hiện tên đại lý/NĐT trên card")
  receiverName?: string; // tên người NHẬN
  partyName?: string; // tên ĐẠI LÝ/NĐT (đích) do server gắn từ nhóm/entity — ưu tiên hiện
  status?: string; // 'success' | 'failed' — trạng thái chuyển khoản (Admin Demo 1/9). Thiếu → coi như success.
}

/** Parse `metadataJson` → `TransferCkMeta` cho bill CHUYỂN KHOẢN gửi vào phòng chat (1/9). Trả `null` nếu KHÔNG
 *  phải bill CK (không `isTransferRefund`, không cờ loại nào, hoặc số tiền không hợp lệ) — CÙNG nguyên tắc
 *  `parseRefundMetadata()`/`parseBillMetadata()`: JSON hỏng/thiếu field → `null`, KHÔNG throw (hiển thị phụ,
 *  không phải check bắt buộc). Suy `kind` từ cờ loại: đại lý hoàn (refundAmount<0 = hoàn-thừa DEALER_REFUND_OVER),
 *  đại lý ứng (ADVANCE), NĐT tạm ứng (INVESTOR_ADVANCE), NĐT hoàn thừa (INVESTOR_REPAYMENT). EXPORT để test độc
 *  lập (transfer-ck-meta.test.ts) không cần dựng React. */
export function parseTransferCkMeta(metadataJson: string | null | undefined): TransferCkMeta | null {
  if (!metadataJson) return null;
  let p: RawTransferCkMetadata;
  try {
    p = JSON.parse(metadataJson) as RawTransferCkMetadata;
  } catch {
    return null;
  }
  if (!p || p.isTransferRefund !== true) return null;

  let kind: TransferCkKind;
  let amount: number | undefined;
  if (p.isDealerAdvanceCk === true) {
    kind = 'ADVANCE';
    amount = p.refundAmount;
  } else if (p.isDealerRefundCk === true) {
    amount = p.refundAmount;
    kind = typeof amount === 'number' && amount < 0 ? 'DEALER_REFUND_OVER' : 'REFUND';
  } else if (p.isInvestorAdvanceCk === true) {
    kind = 'INVESTOR_ADVANCE';
    amount = p.advanceAmount;
  } else if (p.isInvestorRepaymentCk === true) {
    kind = 'INVESTOR_REPAYMENT';
    amount = p.repaymentAmount;
  } else {
    return null; // isTransferRefund nhưng không cờ loại nào rõ → không đủ để render card, coi như không phải CK.
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return null;

  const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    kind,
    amount,
    billDate: typeof p.billDate === 'string' && p.billDate ? p.billDate : undefined,
    ckTxnKey: typeof p.ckTxnKey === 'string' && p.ckTxnKey ? p.ckTxnKey : undefined,
    direction: typeof p.direction === 'string' && p.direction ? p.direction : undefined,
    partyName: s(p.partyName), senderName: s(p.senderName), receiverName: s(p.receiverName),
    status: p.status === 'failed' ? 'failed' : 'success' // thiếu/không rõ → success (card tồn tại = đã post OK)
  };
}

/** Parse `metadataJson.posBill` (server gắn khi gửi bill POS đại lý/NĐT). ƯU TIÊN cho card POS hiện đủ tham số
 *  NGANG. Thiếu `amount` (dữ liệu chính) hoặc parse hỏng → null (bill CŨ chỉ có caption → card fallback caption).
 *  KHÔNG throw (CÙNG nguyên tắc parseTransferCkMeta/refund). */
export function parsePosBillMeta(metadataJson: string | null | undefined): PosBillMeta | null {
  if (!metadataJson) return null;
  let p: { posBill?: Record<string, unknown> };
  try {
    p = JSON.parse(metadataJson) as { posBill?: Record<string, unknown> };
  } catch {
    return null;
  }
  const pb = p?.posBill;
  if (!pb || typeof pb !== 'object') return null;
  const amount = Number(pb.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null; // amount là dữ liệu chính — thiếu → không đủ để render.
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    tid: s(pb.tid), hkd: s(pb.hkd), bank: s(pb.bank), dateTime: s(pb.dateTime),
    amount, lo: s(pb.lo), feeLabel: s(pb.feeLabel), feePct: num(pb.feePct),
    netLabel: s(pb.netLabel), netAmount: num(pb.netAmount),
    title: s(pb.title), ref: s(pb.ref), hideEdit: pb.hideEdit === true
  };
}

/** `myAgentId` — id số của chính người dùng hiện tại (caller tự lấy qua `fetchAuthenticatedAgent()`, xem ghi
 * chú đầu file), dùng để tính `mine`. `reactions` optional — truyền vào nếu caller đã có sẵn (server hiện
 * KHÔNG trả kèm reactions trong `ChatMessageDto`/`listMessages`, xem schema — muốn có phải gọi riêng, phần
 * này chưa có endpoint "reactions theo phòng/hàng loạt" trong hợp đồng brief, chỉ có theo TỪNG message qua
 * `toggleReaction`; để trống nếu chưa có). */
export function mapChatMessage(dto: ChatMessageDto, myAgentId: number | null, reactions?: ChatReactionDto[]): UiChatMessage {
  const status: ChatMessageStatus = 'sent'; // bot-api chưa trả trạng thái đã-nhận/đã-xem theo từng tin — mặc định hợp lý, không suy đoán thêm.
  const mine = myAgentId != null && dto.senderId === myAgentId;

  // Phase 3 (29/7) — tin đã "xóa" (soft-delete, `deletedAt` khác null, xem chat-message-service.ts
  // deleteMessage()) — LƯU Ý: KHÁC `RECALL_PLACEHOLDER_TEXT` rc-realtime.ts (RC "sửa nội dung" qua chat.update,
  // hệ MỚI không sửa nội dung — chỉ đánh dấu deletedAt, `body` GỐC vẫn còn nguyên trong DB/response). FE PHẢI
  // tự thay bằng placeholder ở ĐÂY (KHÔNG hiện `dto.body` gốc) — server KHÔNG tự scrub nội dung, xem comment
  // routes/chat.ts. Render dạng `type:'system'` (bong bóng căn giữa) — CÙNG UX "Thu hồi" cũ (rc-realtime.ts) để
  // người dùng không thấy lệch trải nghiệm dù cơ chế backend đổi khác (gộp 2 nút "Xóa"/"Thu hồi" cũ RC thành 1
  // hành động "Xóa" duy nhất — quyết định cutover, xem báo cáo Phase 3: hệ mới chỉ có 1 khái niệm xóa 48h).
  if (dto.deletedAt) {
    return {
      id: dto.id,
      roomId: dto.roomId,
      senderId: dto.senderId != null ? String(dto.senderId) : 'system',
      senderName: dto.senderName ?? '', // Admin Demo 1/9: server nay tra tên agent (kể cả BOT) → dùng thẳng, hết "Đại lý #id".
      mine,
      type: 'system',
      text: DELETED_MESSAGE_PLACEHOLDER_VI,
      time: formatMessageTime(dto.createdAt),
      status,
      pinned: false,
      sentAtIso: dto.createdAt
    };
  }

  const message: UiChatMessage = {
    id: dto.id,
    roomId: dto.roomId,
    senderId: dto.senderId != null ? String(dto.senderId) : 'system',
    // GIẢ ĐỊNH: model ChatMessage KHÔNG relation trực tiếp Agent (bolt-on, xem comment schema.prisma) nên
    // sendMessage/listMessages trả THUẦN field Prisma — KHÔNG có tên người gửi kèm sẵn. Để rỗng, caller (màn
    // hình chat) tự tra tên qua danh sách thành viên phòng (ChatRoomMemberDto không có tên sẵn cũng — CẦN
    // ghép thêm với danh bạ Agent hiện có, vd agents.ts) nếu cần hiển thị.
    senderName: dto.senderName ?? '', // Admin Demo 1/9: server nay tra tên agent (kể cả BOT) → dùng thẳng, hết "Đại lý #id".
    mine,
    type: KIND_TO_TYPE[dto.kind] ?? 'text',
    text: dto.body ?? undefined,
    time: formatMessageTime(dto.createdAt),
    status,
    pinned: false,
    sentAtIso: dto.createdAt,
    // Tính năng "Trả lời" (1/8) — server đã nhận/trả field này từ trước (route chat.ts POST .../messages +
    // ChatMessageDto.replyToMessageId, xem ghi chú độ tin cậy đầu file) — CHỈ map thẳng qua UI type, KHÔNG
    // resolve nội dung tin gốc ở đây (đó là việc của ConversationScreen.tsx, tự tra trong `messages` state
    // đã tải theo id, xem comment `ChatMessage.replyToMessageId` mock-data/types.ts).
    replyToMessageId: dto.replyToMessageId ?? undefined,
    // B112 (2/8) — "(đã chỉnh sửa)" (ChatBubble.tsx) + gate cửa sổ sửa (canEditChatMessage() dùng sentAtIso
    // GỐC, KHÔNG phải editedAt — sửa nhiều lần vẫn tính từ lúc GỬI lần đầu, đúng quyết định Admin Demo 29/7 "1h kể
    // từ lúc gửi", KHÔNG phải "1h kể từ lần sửa gần nhất").
    editedAt: dto.editedAt ?? undefined
  };
  // Phase 3 (29/7) — đính kèm ảnh/file THẬT qua hệ chat lõi mới (`attachmentId`, KHÔNG còn marker text kiểu
  // RC cũ `SIGMA_ATTACHMENT {...}` — xem GAP mimeType/sizeBytes ở guessFileKindFromName() trên).
  if (dto.kind === 'IMAGE' && dto.attachmentId) {
    message.imageUrl = chatAttachmentDownloadUrl(dto.attachmentId);
    // B112 (2/8) — cần id thô để EditBillMessageModal.tsx fetch lại ẢNH GHÉP hiện có (khác `imageUrl`, vốn CHỈ
    // dùng để render trực tiếp qua AttachmentImage).
    message.attachmentId = dto.attachmentId;
  }
  if (dto.kind === 'FILE' && dto.attachmentId) {
    const name = dto.body || 'file';
    message.file = {
      name,
      size: formatFileSize(dto.attachmentSizeBytes),
      kind: fileKindFromMime(dto.attachmentMimeType),
      url: chatAttachmentDownloadUrl(dto.attachmentId)
    };
  }
  // SIGMA (31/7, việc #5) — tin nhắn thoại THẬT: `attachmentId` trỏ file audio (ChatAttachment, xem
  // chat-attachment-service.ts) + `metadataJson` mang `{durationMs}` đo THẬT lúc ghi âm (wall-clock, xem
  // MessageComposer.tsx — KHÔNG suy ra từ audio.duration, lý do xem formatSecondsToDurationLabel() trên).
  // metadataJson thiếu/hỏng (không nên xảy ra với luồng gửi mới, nhưng phòng dữ liệu cũ/lạ) → fallback nhãn
  // "0:00", KHÔNG throw (CÙNG nguyên tắc LOCATION/QR dưới đây — parse hiển thị phụ, không phải check bắt buộc).
  if (dto.kind === 'VOICE' && dto.attachmentId) {
    let durationLabel = '0:00';
    if (dto.metadataJson) {
      try {
        const parsed = JSON.parse(dto.metadataJson) as { durationMs?: number };
        if (typeof parsed.durationMs === 'number' && parsed.durationMs >= 0) {
          durationLabel = formatSecondsToDurationLabel(parsed.durationMs / 1000);
        }
      } catch {
        // metadataJson hỏng — giữ fallback "0:00", không vỡ UI (như LOCATION/QR).
      }
    }
    message.voice = { duration: durationLabel, url: chatAttachmentDownloadUrl(dto.attachmentId) };
  }
  if (dto.kind === 'LOCATION' && dto.metadataJson) {
    try {
      const parsed = JSON.parse(dto.metadataJson) as { lat?: number; lng?: number; label?: string };
      if (typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
        message.location = { lat: parsed.lat, lng: parsed.lng, label: parsed.label ?? '' };
      }
    } catch {
      // metadataJson hỏng/không đúng shape mong đợi — KHÔNG throw, coi như không có location (R198: không
      // nuốt câm — nhưng đây KHÔNG phải 1 "check" bắt buộc chạy, chỉ là parse hiển thị phụ, giữ nguyên tin
      // nhắn dạng text để không vỡ UI).
    }
  }
  // B106 (2/8) — đánh dấu ảnh bill đã ghép bảng OCR, thay heuristic cũ dựa vào caption text (giòn, vỡ khi
  // đổi format caption — xem comment field isBillImage, mock-data/types.ts).
  if (dto.kind === 'IMAGE' && dto.metadataJson) {
    try {
      const parsed = JSON.parse(dto.metadataJson) as { isBillImage?: boolean };
      if (parsed.isBillImage === true) message.isBillImage = true;
    } catch {
      // metadataJson hỏng — coi như ảnh thường, không vỡ UI (CÙNG nguyên tắc LOCATION/QR).
    }
    // B112 (2/8) — parse ĐẦY ĐỦ metadata bill (billFields/amount/imageHeightPx, xem bill-message-meta.ts) để
    // "Sửa" dùng — `null` (bill fallback ảnh gốc chưa ghép, KHÔNG đủ field mới) → `billMeta` giữ `undefined`,
    // nút "Sửa" tự ẩn (canEditBillMessage() ở trên).
    message.billMeta = parseBillMetadata(dto.metadataJson) ?? undefined;
    // B123 (2/8, tính năng "Hoàn tiền" MỚI) — CÙNG cơ chế, đánh dấu tin nhắn XÁC NHẬN HOÀN TIỀN (isRefundImage,
    // LOẠI TRỪ isBillImage — 1 tin nhắn ẢNH chỉ là ĐÚNG 1 trong 2 loại, KHÔNG BAO GIỜ cả 2, vì backend
    // editMessage() cũng chặn đổi loại qua đường "Sửa", xem chat-message-service.ts).
    try {
      const parsedRefund = JSON.parse(dto.metadataJson) as { isRefundImage?: boolean };
      if (parsedRefund.isRefundImage === true) message.isRefundImage = true;
    } catch {
      // như trên.
    }
    message.refundMeta = parseRefundMetadata(dto.metadataJson) ?? undefined;
    // Bill CHUYỂN KHOẢN (CK, 1/9) — tin IMAGE có `metadataJson.isTransferRefund` (postDealerRefundCk /
    // postInvestorTransferCk, ocr-send-service.ts) KHÁC hẳn bill POS/hoàn-tiền-lẻ (KHÔNG set isBillImage/
    // isRefundImage → TRƯỚC ĐÂY rơi vào ảnh-thô+caption lộn xộn). Có → ChatBubble render TransferCkCard (ẢNH
    // trái + bảng tham số phải). Parse an toàn, hỏng/không phải CK → undefined (KHÔNG throw, CÙNG bill/refund).
    message.transferCk = parseTransferCkMeta(dto.metadataJson) ?? undefined;
    // Bill POS (Admin Demo 1/9) — server gắn `metadataJson.posBill` (bank/dateTime/feeLabel/feePct + tid/hkd/amount/lo)
    // để card POS hiện đủ tham số NGANG, không chỉ parse caption (caption thiếu Bank/Ngày/Phí). Parse an toàn: thiếu
    // `amount` (dữ liệu chính) → undefined (bill cũ) → card fallback parse caption. KHÔNG throw (CÙNG bill/refund/CK).
    message.posBillMeta = parsePosBillMeta(dto.metadataJson) ?? undefined;
  }
  if (dto.kind === 'QR' && dto.metadataJson) {
    try {
      const parsed = JSON.parse(dto.metadataJson) as { amount?: number; tid?: string; bank?: string };
      if (typeof parsed.amount === 'number' && parsed.tid && parsed.bank) {
        message.qr = { amount: parsed.amount, tid: parsed.tid, bank: parsed.bank };
      }
    } catch {
      // như trên.
    }
  }
  // Tag @ mention kiểu Zalo (13/8) — TEXT có `metadataJson.mentionNames` (mảng tên đã nhắc, xem mention.ts) →
  // ChatBubble.tsx tô đậm các `@Tên` này. Chỉ áp cho TEXT (mention chỉ có nghĩa trong tin chữ). Hỏng/không có
  // → `undefined` (parseMentionNames trả [], không gán) — KHÔNG throw (hiển thị phụ, CÙNG nguyên tắc trên).
  if (dto.kind === 'TEXT' && dto.metadataJson) {
    const mentionNames = parseMentionNames(dto.metadataJson);
    if (mentionNames.length > 0) message.mentions = mentionNames;
  }
  if (reactions && reactions.length) {
    const counts = new Map<string, number>();
    for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
    message.reactions = [...counts.entries()].map(([emoji, count]): MessageReaction => ({ emoji, count }));
  }
  return message;
}

// ── Phòng chat ────────────────────────────────────────────────────────────────────────────────────────────

/** GET /v1/chat/rooms?unreadOnly= — danh sách phòng của tôi (sort lastMessageAt DESC, 1-1/nhóm mới nhất lên
 * đầu — server tự sort, xem listRoomsForAgent()). `unreadOnly:true` (Admin Demo chốt 29/7, "lọc chưa đọc như
 * Zalo") — chỉ trả phòng còn tin chưa đọc. */
export async function listChatRooms(opts: { unreadOnly?: boolean; hiddenOnly?: boolean } = {}): Promise<ChatApiResult<ChatRoomSummaryDto[]>> {
  const q: string[] = [];
  if (opts.unreadOnly) q.push('unreadOnly=true');
  if (opts.hiddenOnly) q.push('hidden=true'); // màn "Trò chuyện đã ẩn" (Cài đặt kiểu Zalo) — chỉ phòng đã ẩn.
  const qs = q.length ? `?${q.join('&')}` : '';
  return chatFetch<ChatRoomSummaryDto[]>(`/v1/chat/rooms${qs}`);
}

/** Danh sách hội thoại ĐÃ ẨN (để bỏ ẩn) — màn Cài đặt "Trò chuyện đã ẩn" kiểu Zalo. */
export async function listHiddenConversations(): Promise<ChatApiResult<UiChatRoom[]>> {
  const [roomsRes, resolveName] = await Promise.all([listChatRooms({ hiddenOnly: true }), buildAgentNameResolver()]);
  if (!roomsRes.ok) return roomsRes;
  return { ok: true, data: roomsRes.data.map((dto) => mapChatRoomSummary(dto, resolveName)) };
}

/** Phase 3 "real-time" (29/7, cutover) — tra tên hiển thị theo `agentId` qua danh bạ BẠN BÈ (`listMyFriends()`,
 * agent-api-client.ts) — nguồn hợp lý nhất hiện có vì mọi phòng DIRECT/GROUP chỉ tạo được giữa những người ĐÃ
 * là bạn bè (canMessageAgent(), xem chat-room-service.ts) nên tuyệt đại đa số thành viên phòng nằm trong danh
 * bạ này. Lỗi tải danh bạ KHÔNG throw — trả resolver LUÔN trả `undefined` (caller tự fallback "Đại lý #<id>",
 * xem mapChatRoomSummary()), CÙNG nguyên tắc "lỗi phụ không chặn luồng chính" toàn dự án.
 *
 * B86-tiếp (1/8, việc 1) — ĐỔI sang `getCachedFriends()` (friends-cache.ts, THAY gọi thẳng `listMyFriends()`)
 * — hàm này được gọi TỪ ConversationScreen.tsx (mỗi lần mở 1 phòng) + `listChatRoomsWithNames()` ngay dưới
 * (ChatListScreen.tsx + App.tsx ConversationRoute) + GroupInfoPanel.tsx, tức MỖI lần điều hướng qua lại giữa
 * các màn chat đều gọi lại `GET /v1/me/friends` dù danh sách bạn bè hiếm khi đổi (audit tốc độ B86 đo THẬT).
 * Cache dùng CHUNG 1 module-level state cho CẢ ContactsScreen.tsx lẫn nơi này — invalidate CHỦ ĐỘNG (xem
 * ContactsScreen.tsx) đảm bảo KHÔNG hiện tên cũ sau khi chính mình đổi biệt danh/kết bạn mới. */
export async function buildAgentNameResolver(): Promise<(agentId: number) => string | undefined> {
  try {
    const res = await getCachedFriends();
    if (!res.ok) return () => undefined;
    const nameByAgentId = new Map(res.data.friends.map((f) => [f.agentId, f.nickname || f.agentName]));
    return (agentId: number) => nameByAgentId.get(agentId);
  } catch {
    return () => undefined;
  }
}

/** Bọc `listChatRooms()` + TỰ resolve tên hiển thị phòng DIRECT qua `buildAgentNameResolver()` (server KHÔNG
 * tự trả tên đối phương, xem ghi chú `RoomSummaryDto.otherAgentId`/`mapChatRoomSummary()`). Dùng CHUNG cho
 * ChatListScreen.tsx (danh sách) và App.tsx `ConversationRoute` (tìm 1 phòng theo :roomId) để không lặp logic
 * tra tên ở 2 nơi.
 *
 * Perf audit 1/8 (Admin Demo báo "vẫn chậm" sau B84) — TRƯỚC ĐÂY 2 lệnh gọi này chạy TUẦN TỰ (`await
 * listChatRooms()` XONG mới `await buildAgentNameResolver()`), dù 2 API hoàn toàn ĐỘC LẬP (không API nào cần
 * kết quả của API kia) — tốn thêm 1 vòng round-trip mạng thừa mỗi lần mở "Nhóm chat". Đổi sang `Promise.all`
 * (song song) — ĐÃ đo THẬT qua HTTP (createApp()+supertest, throwaway DB, 40 phòng+40 bạn bè, 10 lần đo sau
 * warmup, xem `test/_bench-perf-audit-01aug.test.ts` — file benchmark tạm, không phải regression test):
 * TUẦN TỰ median 28.7ms so SONG SONG median 22.9ms (~20% nhanh hơn) NGAY CẢ trên localhost gần như không có độ
 * trễ mạng thật — trên mạng di động/LAN thật (round-trip đắt hơn nhiều so với localhost), khoản tiết kiệm này
 * sẽ RÕ RỆT hơn (tiết kiệm ĐÚNG 1 round-trip trọn vẹn thay vì cộng dồn 2 round-trip nối tiếp). KHÁC với bài học
 * B84 (Promise.all N-count DB query CHẬM HƠN vì tranh chấp `pg.Pool max=10`) — ở ĐÂY chỉ có 2 request HTTP độc
 * lập chạy song song (không phải N query cùng lúc), không chạm giới hạn connection pool, nên song song hoá
 * THẬT SỰ có lợi (đã đo, không suy đoán). */
export async function listChatRoomsWithNames(opts: { unreadOnly?: boolean } = {}): Promise<ChatApiResult<UiChatRoom[]>> {
  const [roomsRes, resolveName] = await Promise.all([listChatRooms(opts), buildAgentNameResolver()]);
  if (!roomsRes.ok) return roomsRes;
  return { ok: true, data: roomsRes.data.map((dto) => mapChatRoomSummary(dto, resolveName)) };
}

/** POST /v1/chat/rooms/direct — lấy/tạo phòng DIRECT với `targetAgentId`. 403 `CANNOT_MESSAGE` nếu 2 agent
 * chưa là bạn bè (service tự chặn, xem comment routes/chat.ts). */
export async function createOrGetDirectRoom(targetAgentId: number): Promise<ChatApiResult<ChatRoomDetailDto>> {
  return chatFetch<ChatRoomDetailDto>('/v1/chat/rooms/direct', jsonInit('POST', { targetAgentId }));
}

/** POST /v1/chat/rooms/group — tạo nhóm mới. */
export async function createGroupChatRoom(name: string, memberAgentIds: number[]): Promise<ChatApiResult<ChatRoomDetailDto>> {
  return chatFetch<ChatRoomDetailDto>('/v1/chat/rooms/group', jsonInit('POST', { name, memberAgentIds }));
}

/** GET /v1/chat/rooms/:roomId — chi tiết phòng (bao gồm thành viên). 403 `NOT_MEMBER` nếu không phải thành viên. */
export async function getChatRoomDetail(roomId: string): Promise<ChatApiResult<ChatRoomDetailDto>> {
  return chatFetch<ChatRoomDetailDto>(`/v1/chat/rooms/${encodeURIComponent(roomId)}`);
}

/** PATCH /v1/chat/rooms/:roomId — đổi cài đặt nhóm (tên/đại diện/`readOnly`, xem updateGroupSettings()
 * chat-room-service.ts). CHỈ OWNER/ADMIN gọi được (403 `FORBIDDEN_ROLE` nếu không đủ quyền, service tự gate) —
 * KHÔNG áp dụng phòng DIRECT (403 `FORBIDDEN_ROLE` — DIRECT không có "cài đặt nhóm" để đổi). debt-chat-gaps
 * (31/7, Việc 4) — thêm hàm này vì trước đây route ĐÃ có (chat.ts) nhưng chưa từng có wrapper phía FE
 * (GroupInfoPanel.tsx chỉ port phần Thành viên ở Phase 3, "Cài đặt nhóm" đổi tên/ảnh CHƯA nối UI thật — ngoài
 * phạm vi ở đây, chỉ thêm phần readOnly theo đúng brief). */
export async function updateChatRoomSettings(
  roomId: string,
  // "nhóm chat đầy đủ như Zalo" (5/8) — nới thêm `requireApproval`/`maxMembers` (route PATCH ĐÃ nhận 2 field
  // này, xem routes/chat.ts + updateGroupSettings() chat-room-service.ts — service tự gate OWNER/ADMIN +
  // validate `maxMembers` là số nguyên dương hoặc null). `maxMembers:null` = bỏ giới hạn.
  input: { name?: string; avatarColor?: string | null; avatarUrl?: string | null; readOnly?: boolean; requireApproval?: boolean; maxMembers?: number | null }
): Promise<ChatApiResult<ChatRoomDetailDto>> {
  return chatFetch<ChatRoomDetailDto>(`/v1/chat/rooms/${encodeURIComponent(roomId)}`, jsonInit('PATCH', input));
}

/** GET /v1/chat/rooms/:roomId/attachments — debt-chat-gaps (31/7, Việc 3) — danh sách file đã gửi trong phòng
 * (tab "File" GroupInfoPanel.tsx, trước đây ẨN vì thiếu endpoint — xem comment đầu file đó). 403 `NOT_MEMBER`
 * nếu không phải thành viên (service tự chặn, listRoomAttachments() chat-message-service.ts). */
export interface ChatRoomAttachmentDto {
  attachmentId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploaderId: number;
  createdAt: string;
}

/** FIX-PERF (4/8) — server giờ PHÂN TRANG cursor (`before`=id tin cũ hơn, `limit` mặc định 30 tối đa 100) + trả
 * `{ attachments, hasMore }` thay mảng trơn (phòng nhiều nghìn file không trả 1 lượt nữa). */
export interface ListChatRoomAttachmentsResult {
  attachments: ChatRoomAttachmentDto[];
  hasMore: boolean;
}

export async function listChatRoomAttachments(
  roomId: string,
  opts: { before?: string; limit?: number } = {}
): Promise<ChatApiResult<ListChatRoomAttachmentsResult>> {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return chatFetch<ListChatRoomAttachmentsResult>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/attachments${qs ? `?${qs}` : ''}`);
}

// ── Tin nhắn ──────────────────────────────────────────────────────────────────────────────────────────────

export interface ListChatMessagesResult {
  messages: ChatMessageDto[];
  hasMore: boolean;
}

/** GET /v1/chat/rooms/:roomId/messages?before=&limit= — phân trang lùi (before = id tin nhắn cũ hơn cần tải
 * tiếp, bỏ trống cho trang đầu). */
export async function listChatMessages(roomId: string, opts: { before?: string; limit?: number } = {}): Promise<ChatApiResult<ListChatMessagesResult>> {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return chatFetch<ListChatMessagesResult>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/messages${qs ? `?${qs}` : ''}`);
}

export interface SendChatMessageInput {
  kind?: ChatMessageDto['kind'];
  body?: string;
  attachmentId?: string;
  metadataJson?: string;
  replyToMessageId?: string;
}

/** POST /v1/chat/rooms/:roomId/messages — gửi tin nhắn mới. 403 `NOT_MEMBER` nếu đã rời/chưa từng ở phòng. */
export async function sendChatMessage(roomId: string, input: SendChatMessageInput): Promise<ChatApiResult<ChatMessageDto>> {
  return chatFetch<ChatMessageDto>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/messages`, jsonInit('POST', input));
}

/** DELETE /v1/chat/messages/:id — thu hồi tin nhắn. 403 `FORBIDDEN` (không đủ quyền) hoặc 409
 * `DELETE_WINDOW_EXPIRED` (quá cửa sổ cho phép). */
export async function deleteChatMessage(messageId: string): Promise<ChatApiResult<{ id: string }>> {
  return chatFetch<{ id: string }>(`/v1/chat/messages/${encodeURIComponent(messageId)}`, jsonInit('DELETE'));
}

/** PATCH /v1/chat/messages/:id — sửa nội dung tin nhắn của chính mình. `billPatch` (B112, 2/8) OPTIONAL — CHỈ
 * truyền khi "Sửa" bill đã gửi (đổi cả ảnh đính kèm, xem EditBillMessageModal.tsx) — server tự validate kind
 * IMAGE + isBillImage + ownership attachment mới (editMessage(), chat-message-service.ts), 403
 * `ATTACHMENT_NOT_OWNED`/400 `VALIDATION` nếu sai. */
export async function editChatMessage(
  messageId: string,
  body: string,
  billPatch?: { attachmentId: string; metadataJson: string }
): Promise<ChatApiResult<ChatMessageDto>> {
  return chatFetch<ChatMessageDto>(`/v1/chat/messages/${encodeURIComponent(messageId)}`, jsonInit('PATCH', { body, ...billPatch }));
}

/** POST /v1/chat/rooms/read-all — Admin Demo chốt 29/7 ("tích chọn đã đọc tất cả", giống Zalo) — đánh dấu đã đọc
 * MỌI phòng cùng lúc. */
export async function markAllChatRoomsRead(): Promise<ChatApiResult<null>> {
  return chatFetch<null>('/v1/chat/rooms/read-all', jsonInit('POST'));
}

/** POST /v1/chat/rooms/:roomId/read — đánh dấu đã đọc tới `messageId`. */
export async function markChatRoomRead(roomId: string, messageId: string): Promise<ChatApiResult<{ roomId: string; messageId: string }>> {
  return chatFetch<{ roomId: string; messageId: string }>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/read`, jsonInit('POST', { messageId }));
}

// ── MENU HỘI THOẠI kiểu Zalo (7/8, Admin Demo) — hành động cấp-hội-thoại per-agent (nhấn giữ 1 dòng trong danh
// sách). Contract khớp backend (routes/chat.ts): mute/pin-conversation/mark-unread/hide/remove/report. ─────────
const rp = (roomId: string, seg: string): string => `/v1/chat/rooms/${encodeURIComponent(roomId)}/${seg}`;

/** Tắt/bật thông báo hội thoại (mute). */
export async function muteConversation(roomId: string, muted: boolean): Promise<ChatApiResult<unknown>> {
  return chatFetch(rp(roomId, 'mute'), jsonInit('POST', { muted }));
}
/** Ghim/bỏ ghim hội thoại lên đầu danh sách. */
export async function pinConversation(roomId: string, pinned: boolean): Promise<ChatApiResult<unknown>> {
  return chatFetch(rp(roomId, 'pin-conversation'), jsonInit('POST', { pinned }));
}
/** Đánh dấu hội thoại là CHƯA đọc (unreadCount>=1). */
export async function markConversationUnread(roomId: string): Promise<ChatApiResult<unknown>> {
  return chatFetch(rp(roomId, 'mark-unread'), jsonInit('POST'));
}
/** Ẩn hội thoại (không tự hiện lại khi có tin mới). `hidden=false` để bỏ ẩn. */
export async function hideConversation(roomId: string, hidden: boolean): Promise<ChatApiResult<unknown>> {
  return chatFetch(rp(roomId, 'hide'), jsonInit('POST', { hidden }));
}
/** Xóa hội thoại phía mình (tin vẫn còn; hiện lại khi có tin mới — như Zalo). */
export async function removeConversation(roomId: string): Promise<ChatApiResult<unknown>> {
  return chatFetch(rp(roomId, 'remove'), jsonInit('POST'));
}
/** Báo xấu hội thoại (lưu bản ghi + gửi kênh admin + tự ẩn). */
export async function reportConversation(roomId: string, reason?: string): Promise<ChatApiResult<unknown>> {
  return chatFetch(rp(roomId, 'report'), jsonInit('POST', { reason }));
}

/** PUT /v1/chat/rooms/:roomId/pin — ghim `messageId`. */
export async function pinChatMessage(roomId: string, messageId: string): Promise<ChatApiResult<{ roomId: string; pinnedMessageId: string }>> {
  return chatFetch<{ roomId: string; pinnedMessageId: string }>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/pin`, jsonInit('PUT', { messageId }));
}

/** DELETE /v1/chat/rooms/:roomId/pin — bỏ ghim. */
export async function unpinChatMessage(roomId: string): Promise<ChatApiResult<{ roomId: string; pinnedMessageId: null }>> {
  return chatFetch<{ roomId: string; pinnedMessageId: null }>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/pin`, jsonInit('DELETE'));
}

// ── "BẢNG TIN" / GHIM KHÔNG GIỚI HẠN (5/8, Admin Demo nhấn mạnh) — GHIM NHIỀU tin như Zalo ─────────────────────
// Map TRỰC TIẾP `PinnedMessageDto` thật (listPinnedMessages(), chat-room-service.ts — đã đọc code): mỗi hàng
// ghim = con trỏ (id/pinnedByAgentId/pinnedAt) + nội dung tin gốc `message` (null nếu tin đã bị thu hồi SAU khi
// ghim — client hiện "tin đã thu hồi", KHÔNG tự ẩn hàng ghim). Ngày tháng Prisma serialize JSON → chuỗi ISO.
export interface PinnedMessageEmbeddedDto {
  id: string;
  kind: string;
  body: string | null;
  senderId: number | null;
  attachmentId: string | null;
  metadataJson: string | null;
  createdAt: string;
}
export interface PinnedMessageDto {
  id: number;
  roomId: string;
  messageId: string;
  pinnedByAgentId: number;
  pinnedAt: string;
  message: PinnedMessageEmbeddedDto | null;
}

/** GET /v1/chat/rooms/:roomId/pins — danh sách "Bảng tin" (mọi tin đã ghim, MỚI ghim trước). Thành viên nào
 * trong phòng cũng xem được (service assertActiveMember → 403 NOT_MEMBER nếu không thuộc phòng). */
export async function listRoomPins(roomId: string): Promise<ChatApiResult<PinnedMessageDto[]>> {
  return chatFetch<PinnedMessageDto[]>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/pins`);
}

/** POST /v1/chat/rooms/:roomId/pins — {messageId} → ghim thêm 1 tin (OWNER/ADMIN, KHÔNG giới hạn số). Route trả
 * VỀ danh sách "Bảng tin" ĐÃ CẬP NHẬT (không phải 1 hàng) — caller dùng thẳng khỏi gọi lại listRoomPins(). 403
 * FORBIDDEN_ROLE nếu không đủ quyền (service assertOwnerOrAdmin). */
export async function pinRoomMessage(roomId: string, messageId: string): Promise<ChatApiResult<PinnedMessageDto[]>> {
  return chatFetch<PinnedMessageDto[]>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/pins`, jsonInit('POST', { messageId }));
}

/** DELETE /v1/chat/rooms/:roomId/pins/:messageId — bỏ ghim ĐÚNG 1 tin (OWNER/ADMIN). Idempotent. Trả danh sách
 * "Bảng tin" còn lại. */
export async function unpinRoomMessage(roomId: string, messageId: string): Promise<ChatApiResult<PinnedMessageDto[]>> {
  return chatFetch<PinnedMessageDto[]>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/pins/${encodeURIComponent(messageId)}`,
    jsonInit('DELETE')
  );
}

// ── DUYỆT THÀNH VIÊN (5/8) — ChatRoomJoinRequest ────────────────────────────────────────────────────────────
// Map TRỰC TIẾP model Prisma `ChatRoomJoinRequest` (route trả thẳng findMany, xem listPendingJoinRequests()
// chat-room-service.ts + schema.prisma model ChatRoomJoinRequest). `requestedAt`/`decidedAt` ISO string.
export interface JoinRequestDto {
  id: number;
  roomId: string;
  agentId: number;
  status: string;
  requestedAt: string;
  decidedBy: number | null;
  decidedAt: string | null;
}

/** GET /v1/chat/rooms/:roomId/join-requests — yêu cầu ĐANG chờ duyệt (OWNER/ADMIN, cũ nhất trước). 403
 * FORBIDDEN_ROLE nếu requester không phải OWNER/ADMIN. */
export async function listRoomJoinRequests(roomId: string): Promise<ChatApiResult<JoinRequestDto[]>> {
  return chatFetch<JoinRequestDto[]>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/join-requests`);
}

/** POST /v1/chat/rooms/:roomId/join-requests/:agentId/approve — duyệt (OWNER/ADMIN) → tạo thành viên. 404
 * JOIN_REQUEST_NOT_FOUND nếu không còn yêu cầu chờ; 409 ROOM_FULL nếu đã đầy trần maxMembers. */
export async function approveRoomJoinRequest(roomId: string, agentId: number): Promise<ChatApiResult<ChatRoomEmbeddedMemberDto>> {
  return chatFetch<ChatRoomEmbeddedMemberDto>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/join-requests/${agentId}/approve`,
    jsonInit('POST')
  );
}

/** POST /v1/chat/rooms/:roomId/join-requests/:agentId/reject — từ chối (OWNER/ADMIN). */
export async function rejectRoomJoinRequest(
  roomId: string,
  agentId: number
): Promise<ChatApiResult<{ roomId: string; agentId: number; status: string }>> {
  return chatFetch<{ roomId: string; agentId: number; status: string }>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/join-requests/${agentId}/reject`,
    jsonInit('POST')
  );
}

// ── AVATAR NHÓM (5/8) — upload/hiển thị ảnh đại diện nhóm ────────────────────────────────────────────────────
/** GET /v1/chat/rooms/:roomId/avatar — URL ảnh đại diện nhóm (render trực tiếp qua <img>/AttachmentImage, KHÔNG
 * fetch JSON). Route trả BLOB ảnh (404 nếu chưa đặt) — CÙNG pattern chatAttachmentDownloadUrl(). `cacheBust`
 * (tùy chọn) — thêm query để buộc trình duyệt tải lại NGAY sau khi vừa upload ảnh mới (URL cố định, tránh cache cũ). */
export function roomAvatarUrl(roomId: string, cacheBust?: string | number): string {
  const bust = cacheBust != null ? `?t=${encodeURIComponent(String(cacheBust))}` : '';
  return `${botApiBaseUrl()}/v1/chat/rooms/${encodeURIComponent(roomId)}/avatar${bust}`;
}

/** POST /v1/chat/rooms/:roomId/avatar — upload ảnh đại diện nhóm (multipart, field "file"). OWNER/ADMIN, CHỈ
 * phòng GROUP (service enforce). KHÔNG set Content-Type tay (để trình duyệt tự gắn boundary multipart, CÙNG
 * khuôn previewLoOcr() agent-api-client.ts). 413 FILE_TOO_LARGE (>5MB) / 400 MIME_NOT_ALLOWED (không phải
 * jpeg/png/webp). Trả `{roomId, avatarUrl}` (avatarUrl là đường dẫn tương đối server tự set). */
export async function uploadRoomAvatar(roomId: string, file: File): Promise<ChatApiResult<{ roomId: string; avatarUrl: string | null }>> {
  const form = new FormData();
  form.append('file', file);
  return chatFetch<{ roomId: string; avatarUrl: string | null }>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/avatar`,
    { method: 'POST', body: form }
  );
}

// ── Cảm xúc (reaction) ────────────────────────────────────────────────────────────────────────────────────

export interface ToggleReactionResult {
  action: 'added' | 'removed' | 'changed';
  reaction: ChatReactionDto | null;
}

/** POST /v1/chat/messages/:id/reactions — thả/thay cảm xúc `emoji` (bấm lại đúng emoji đã thả = bỏ thích, xem
 * comment schema.prisma ChatMessageReaction — service tự xử lý, route/chat-client chỉ chuyển tiếp). */
export async function addChatReaction(messageId: string, emoji: string): Promise<ChatApiResult<ToggleReactionResult>> {
  return chatFetch<ToggleReactionResult>(`/v1/chat/messages/${encodeURIComponent(messageId)}/reactions`, jsonInit('POST', { emoji }));
}

/** DELETE /v1/chat/messages/:id/reactions — bỏ cảm xúc của chính mình. `emoji` OPTIONAL (route tự tra reaction
 * hiện có của mình nếu không truyền, xem comment routes/chat.ts) — truyền vào nếu caller đã biết sẵn (tiết
 * kiệm 1 lượt tra DB phía server), bỏ trống vẫn hợp lệ. */
export async function removeChatReaction(messageId: string, emoji?: string): Promise<ChatApiResult<ToggleReactionResult>> {
  return chatFetch<ToggleReactionResult>(`/v1/chat/messages/${encodeURIComponent(messageId)}/reactions`, jsonInit('DELETE', emoji ? { emoji } : undefined));
}

/** GET /v1/chat/rooms/:roomId/messages/reactions?messageIds= — debt-chat-gaps (31/7, Việc 1) — khôi phục lịch
 * sử reaction khi tải lại lịch sử tin nhắn (GAP đã ghi ở ConversationScreen.tsx `reactionsByMessageRef`/báo cáo
 * Phase 3: trước đây CHỈ có real-time qua `toggleReaction()`, KHÔNG có cách lấy TOÀN BỘ reaction hiện có của N
 * tin nhắn cùng lúc). `messageIds` rỗng → trả `{ok:true,data:{}}` NGAY, KHÔNG gọi mạng (tránh round-trip vô ích
 * khi phòng chưa tải được tin nào). Response = object `{messageId: ChatReactionDto[]}` (KHÔNG phải Map — JSON
 * không tự serialize Map, xem route chat.ts `Object.fromEntries()`). */
export async function listChatMessageReactions(roomId: string, messageIds: string[]): Promise<ChatApiResult<Record<string, ChatReactionDto[]>>> {
  if (messageIds.length === 0) return { ok: true, data: {} };
  const qs = new URLSearchParams({ messageIds: messageIds.join(',') }).toString();
  return chatFetch<Record<string, ChatReactionDto[]>>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/messages/reactions?${qs}`);
}

// ── Thành viên phòng ──────────────────────────────────────────────────────────────────────────────────────

/** GET /v1/chat/rooms/:roomId/members — danh sách thành viên đang hoạt động (đã rời bị lọc phía server). */
export async function listChatRoomMembers(roomId: string): Promise<ChatApiResult<ChatRoomMemberDto[]>> {
  return chatFetch<ChatRoomMemberDto[]>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/members`);
}

/** POST /v1/chat/rooms/:roomId/members — thêm thành viên `agentId`. */
export async function addChatRoomMember(roomId: string, agentId: number): Promise<ChatApiResult<{ roomId: string; agentId: number }>> {
  return chatFetch<{ roomId: string; agentId: number }>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/members`, jsonInit('POST', { agentId }));
}

/** DELETE /v1/chat/rooms/:roomId/members/:agentId — xóa/rời thành viên. */
export async function removeChatRoomMember(roomId: string, agentId: number): Promise<ChatApiResult<{ roomId: string; agentId: number }>> {
  return chatFetch<{ roomId: string; agentId: number }>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/members/${agentId}`, jsonInit('DELETE'));
}

/** POST /v1/chat/rooms/:roomId/dissolve — GIẢI TÁN nhóm (CHỈ trưởng nhóm/OWNER — server gate). Xóa mềm phòng;
 * server phát room-dissolved cho mọi máy đang mở phòng tự rời về danh sách. */
export async function dissolveChatRoom(roomId: string): Promise<ChatApiResult<{ roomId: string }>> {
  return chatFetch<{ roomId: string }>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/dissolve`, jsonInit('POST'));
}

/** PATCH /v1/chat/rooms/:roomId/members/:agentId — đổi vai trò.
 * Phase 3 (29/7, cutover GroupInfoPanel.tsx) — nới thêm `'OWNER'` (route/service ĐÃ LUÔN chấp nhận giá trị này,
 * xem VALID_MEMBER_ROLES/changeMemberRole() routes/chat.ts+chat-room-service.ts — service tự xử lý CHUYỂN
 * NHƯỢNG, requester cũ tự động hạ ADMIN trong cùng transaction, KHÔNG BAO GIỜ có 2 OWNER) — hạn chế
 * `'ADMIN'|'MEMBER'` trước đây chỉ là kiểu TS tự đặt hẹp hơn thực tế backend hỗ trợ, KHÔNG phải giới hạn API. */
export async function changeChatRoomMemberRole(
  roomId: string,
  agentId: number,
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
): Promise<ChatApiResult<{ roomId: string; agentId: number; role: string }>> {
  return chatFetch<{ roomId: string; agentId: number; role: string }>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/members/${agentId}`,
    jsonInit('PATCH', { role })
  );
}

// ── Doanh số theo nhóm chat (1/8, B100 hạ tầng đã build + kiểm chứng độc lập trên production) — Type mirror
// THỦ CÔNG của chat-room-tid-service.ts (apps/bot-api) — field PHẢI khớp CHÍNH XÁC, đổi 1 bên phải đổi bên
// kia tay (CÙNG convention agent-api-client.ts đã dùng cho OcrBillPreview/MyLoViolation).
export interface RoomTidDto {
  tidId: number;
  tid: string;
  hkdName: string | null;
  bankName: string | null;
  linkedAt: string;
  linkedBy: number | null;
}

/** GET /v1/chat/rooms/:roomId/tids — TID ghi nhận doanh số của phòng (đòi requester là thành viên đang hoạt
 * động). Hàm ĐỌC — GIỮ để dùng chung. (Gỡ linkRoomTid/unlinkRoomTid ngày 21/8: khách/đại lý KHÔNG còn tự gắn
 * TID vào phòng — TID↔khách do admin quản trên desktop, doanh số suy TỪ KHÁCH qua customer_chat_groups.) */
export async function listRoomTids(roomId: string): Promise<ChatApiResult<RoomTidDto[]>> {
  return chatFetch<RoomTidDto[]>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/tids`);
}

export interface RoomRevenueRow {
  loId: number;
  tidId: number;
  date: string; // "YYYY-MM-DD" ngày LOCAL
  effDateIso: string; // MỐC BILL THẬT có GIỜ (ISO/UTC) → format "HH:mm" theo TZ VN cho cột Giờ
  bankReportedLoNumber: number | null;
  billLoNumber: string | null; // số lô trên BILL (từ billKey) — hiện khi chưa đối soát bank
  /** [Admin Demo 16/9 khuya] MÃ ĐÓNG LÔ ("95") — số lô hiển thị thành "84(95)" để theo dõi lô rủi ro hoàn/hủy GD. */
  settlementCode?: string | null;
  investorNickname: string | null; // tên NĐT của lô (null = không resolve được → '—')
  gross: number;
  fee: number;
  net: number;
  borrowed: boolean; // [Admin Demo 7/9] lô này đại lý phòng MƯỢN TID của đại lý khác để quẹt (doanh số về phòng này)
  tidOwnerName: string | null; // tên CHỦ TID được mượn (hiện "Mượn TID của <chủ>"); null khi không mượn
  borrowedTid?: string; // TID được mượn (∉ danh sách phòng → backend trả kèm để hiện đúng)
  borrowedHkd?: string | null;
  borrowedBank?: string | null;
}

export interface RoomRevenueReport {
  from: string;
  to: string;
  tids: RoomTidDto[];
  totalGross: number;
  totalFee: number;
  totalNet: number;
  loCount: number;
  daily: { date: string; gross: number; net: number }[];
  rows: RoomRevenueRow[];
  /** Admin Demo 27/8: nếu phòng là nhóm NHÀ ĐẦU TƯ → doanh số NĐT của nhóm (thay vì "chưa có TID"). Chỉ có khi phòng
   *  là nhóm NĐT và người xem ở trong nhóm. Kèm nút tải Excel chi tiết. */
  investor?: { investorId: number; investorName: string; from: string; to: string; doanhThu: number; tienVe: number; laiNDT: number; soBill: number; tamUng?: number; daHoan?: number; qr?: { gross: number; phiMuaGiu: number; traAlpha: number; soBill: number; tvTrongReport: number; laiTrongReport: number } | null };
}

// ── [Admin Demo 7/9] LƯỚI LÔ SÓT / SAI GIỜ ghim đầu báo cáo (mirror LotGapRow của lot-reconcile-service.ts) ──
export interface LotTimeBackwardDto { lot: number; time: string | null; prevLot: number; prevTime: string | null }
export interface LotGapDto {
  tid: string; hkdName: string | null; day: string;
  missing: number[];          // lô SÓT thật (khuyết trong cụm chính)
  suspectMisread: number[];   // lô LẠC → nghi OCR đọc sai số lô (kiểm tay)
  timeBackward: LotTimeBackwardDto[]; // lô↑ giờ↓ cùng ngày → nghi sai giờ
  seenCount: number; sparse: boolean;
}
// [Admin Demo 7/9] Nguồn sửa full tham số 1 lô (messageId + giá trị hiện tại) → nút "Sửa" báo cáo mở modal như review.
export interface LoEditSourceDto {
  messageId: string;
  current: { amount: number | null; lo: string | null; tid: string | null; dateTime: string | null; hkdName: string | null; bank: string | null };
}
/** GET /v1/chat/rooms/:roomId/lo/:loId/edit-source — resolve lô → tin bill gốc + giá trị hiện tại (prefill modal sửa). */
export async function getLoEditSource(roomId: string, loId: number): Promise<ChatApiResult<LoEditSourceDto>> {
  return chatFetch<LoEditSourceDto>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/lo/${loId}/edit-source`);
}

/** GET /v1/ocr-send/lot-gaps?from=&to= — đối soát dãy lô trên DB (LƯỚI CUỐI). Trả (tid,ngày) có lô sót/nghi-sai/sai-giờ.
 *  Truyền from/to (khớp kỳ báo cáo đang xem, kể cả quá khứ); server fallback days-từ-nay nếu thiếu. */
export async function getLotGaps(opts: { from?: Date; to?: Date } = {}): Promise<ChatApiResult<{ days: number; gaps: LotGapDto[] }>> {
  const p = new URLSearchParams();
  if (opts.from) p.set('from', opts.from.toISOString());
  if (opts.to) p.set('to', opts.to.toISOString());
  const qs = p.toString();
  return chatFetch<{ days: number; gaps: LotGapDto[] }>(`/v1/ocr-send/lot-gaps${qs ? `?${qs}` : ''}`);
}

/** GET /v1/chat/rooms/:roomId/revenue?from=&to=&tidId= — báo cáo doanh số. Thiếu from/to → mặc định 7 ngày
 * gần nhất (server tự tính, xem routes/chat.ts). `tidId` bỏ trống = gộp TẤT CẢ TID đã gắn phòng. */
// ── [Admin Demo 10/9] KPI 1 DÒNG/NHÓM cho màn "Doanh số theo nhóm" (đại lý + NĐT) ───────────────────────────
/** Số của 1 nhóm — LẤY TỪ CHÍNH engine của màn doanh số phòng (server không tính lại) nên bấm vào phòng phải khớp. */
export interface RoomRevenueKpi {
  roomId: string;
  grossHomNay: number;   // trước phí hôm nay (NĐT: doanh thu)
  netHomNay: number;     // sau phí hôm nay (NĐT: tiền về)
  grossHomQua: number;   // trước phí hôm qua
  soLoHomNay: number;    // số lô (NĐT: số bill)
  laNdt: boolean;
  ndtDaTamUng: number | null;   // [11/9] KPI NĐT: tạm ứng / hoàn lại / lợi nhuận trong kỳ
  ndtDaHoanLai: number | null;
  ndtLoiNhuan: number | null;
  canHoan: number | null;   // các ô đối soát: null = nhóm NĐT (không cùng hệ) hoặc chưa tính được
  daHoan: number | null;
  thuaThieu: number | null;
  daUng: number | null;
  hoanUng: number | null;
  error?: string;        // R198: lý do thiếu số của ĐÚNG nhóm này — hiện lên, không im lặng trả 0
}
export async function getRoomsRevenueKpi(roomIds: string[], ky?: { from: Date; to: Date }): Promise<ChatApiResult<RoomRevenueKpi[]>> {
  // [Admin Demo 11/9] Kỳ chọn ở ĐẦU màn "Doanh số theo nhóm" → gửi lên để server dùng ĐÚNG engine với kỳ đó.
  return chatFetch<RoomRevenueKpi[]>('/v1/chat/rooms-revenue-kpi', jsonInit('POST', ky ? { roomIds, from: ky.from.toISOString(), to: ky.to.toISOString() } : { roomIds }));
}

export async function getRoomRevenue(roomId: string, opts: { from?: Date; to?: Date; tidId?: number } = {}): Promise<ChatApiResult<RoomRevenueReport>> {
  const params = new URLSearchParams();
  if (opts.from) params.set('from', opts.from.toISOString());
  if (opts.to) params.set('to', opts.to.toISOString());
  if (opts.tidId != null) params.set('tidId', String(opts.tidId));
  const qs = params.toString();
  return chatFetch<RoomRevenueReport>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/revenue${qs ? `?${qs}` : ''}`);
}

// ── ĐỐI SOÁT HOÀN TIỀN ĐẠI LÝ (hướng-1, Admin Demo 31/8) — cần hoàn (Σ net lô) vs đã hoàn (Σ CK waterfall khớp số) ──
export interface RefundReconcileDay {
  date: string; // YYYY-MM-DD
  canHoan: number; // Σ net lô ngày đó (đại lý được hoàn)
  daHoan: number; // Σ CK gán vào ngày đó (waterfall khớp số tiền)
  thuaThieu: number; // đã − cần (2 chiều)
  status: 'match' | 'over' | 'partial' | 'none'; // đủ | thừa | thiếu | chưa hoàn
}
export interface RefundReconcileReport {
  from: string;
  to: string;
  days: RefundReconcileDay[];
  totalCanHoan: number;
  totalDaHoan: number;
  totalThuaThieu: number;
  unmatchedDaHoan: number; // CK dư chưa gán được ngày nào (cờ cảnh báo)
  totalDaUng: number; // Σ ứng-trước (kind=ADVANCE) trong kỳ — tách riêng khỏi hoàn để hiển thị (Admin Demo 1/9).
  /** DANH SÁCH bill hoàn/ứng THẬT trong kỳ (Admin Demo 1/9) — sắp KHÔNG-giờ trước → giờ tăng dần → ngày. */
  bills: RefundBillItem[];
}
export interface RefundBillItem { messageId: string; billDate: string | null; billTime: string | null; amount: number; kind: 'REFUND' | 'ADVANCE'; senderName: string | null; receiverName: string | null; bank: string | null;
  /** NGÂN HÀNG NGƯỜI GỬI (Admin Demo 2/9) — học qua sender-bank-alias theo STK/tên người gửi. null → cột "NH gửi" hiện '—'. */
  senderBank: string | null }
export async function getRefundReconcile(roomId: string, opts: { from?: Date; to?: Date } = {}): Promise<ChatApiResult<RefundReconcileReport>> {
  const params = new URLSearchParams();
  if (opts.from) params.set('from', opts.from.toISOString());
  if (opts.to) params.set('to', opts.to.toISOString());
  const qs = params.toString();
  return chatFetch<RefundReconcileReport>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/refund-reconcile${qs ? `?${qs}` : ''}`);
}

// ── SỬA THẺ lô đã ghi (Admin Demo 31/8: chọn nhầm thẻ, gửi rồi doanh số sai không sửa được) ──────────────────
export interface LoCardOptionDto {
  cardTypeId: number;
  name: string;
  isCurrent: boolean;
  available: boolean;
  phiBanMilli?: number; // % × 1000 (1400 = 1.40%)
  feeApplied?: number;
  amountAfterFee?: number;
  reason?: string; // vì sao không dùng được (vd chưa cấu hình giá bán thực tế)
}
export interface LoCardOptionsDto {
  loId: number;
  tidId: number;
  currentCardTypeId: number;
  amountBeforeFee: string;
  options: LoCardOptionDto[];
}
export interface CorrectLoCardDto {
  loId: number;
  oldTransactionId: number | null;
  newTransactionId: number | null;
  cardTypeId: number;
  feeApplied: number;
  amountAfterFee: number;
  phiBanMilli: number;
  bridgeError?: string;
}

/** GET /v1/chat/rooms/:roomId/lo/:loId/cards — liệt kê loại thẻ hợp lệ cho lô + phí bán % thực tế (picker Sửa thẻ). */
export async function fetchLoCardOptions(roomId: string, loId: number): Promise<ChatApiResult<LoCardOptionsDto>> {
  return chatFetch<LoCardOptionsDto>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/lo/${loId}/cards`);
}

/** POST /v1/chat/rooms/:roomId/lo/:loId/correct-card {cardTypeId} — đổi thẻ lô đã ghi (tính lại đại lý + NĐT +
 *  hủy GD cũ tạo GD mới, giữ ngày GD gốc). */
export async function correctLoCard(roomId: string, loId: number, cardTypeId: number): Promise<ChatApiResult<CorrectLoCardDto>> {
  return chatFetch<CorrectLoCardDto>(`/v1/chat/rooms/${encodeURIComponent(roomId)}/lo/${loId}/correct-card`, jsonInit('POST', { cardTypeId }));
}

// ── Tìm kiếm tin nhắn (B103) ─────────────────────────────────────────────────────────────────────────────

export interface MessageSearchHitDto {
  messageId: string;
  roomId: string;
  roomName: string | null; // null cho phòng DIRECT — resolve tên đối phương ở caller qua buildAgentNameResolver()/rcRooms đã tải.
  roomType: string;
  senderId: number | null;
  snippet: string;
  createdAt: string;
}

/** GET /v1/chat/search/messages?q=... — tìm tin nhắn THẬT trong các phòng đang là thành viên (B103, thay
 * ChatListScreen.tsx tìm trên mock data cũ — bug Admin Demo báo trực tiếp 1/8: tin nhắn thật không tìm ra). */
/** `roomId` (B107, 2/8) tùy chọn — CHỈ tìm trong 1 phòng cụ thể (tìm kiếm ngay trong khung chat). */
export async function searchChatMessages(q: string, roomId?: string): Promise<ChatApiResult<MessageSearchHitDto[]>> {
  const qs = roomId ? `&roomId=${encodeURIComponent(roomId)}` : '';
  return chatFetch<MessageSearchHitDto[]>(`/v1/chat/search/messages?q=${encodeURIComponent(q)}${qs}`);
}
