// SIGMA Mobile Giai đoạn 1 (26/7) — TÁI DÙNG Ý TƯỞNG (KHÔNG import chéo được, khác runtime) từ
// apps/web-demo/src/lib/{bot-api-client,rc-client,agent-api-client,rc-realtime}.ts — cùng shape API/endpoint
// đã verify thật trước đó, viết lại tầng vận chuyển cho React Native (KHÁC web ở đúng 1 điểm: cookie phải tự
// quản lý thủ công, xem cookie-jar.ts — MỌI quyết định nghiệp vụ/shape response giữ NGUYÊN).
import { BOT_API_BASE_URL, CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from './config';
import { clearSessionCookie, getSessionCookieHeader, persistSetCookieHeader } from './cookie-jar';

const NETWORK_ERROR_VI = 'Không kết nối được máy chủ, vui lòng kiểm tra mạng và thử lại.';
const PARSE_ERROR_VI = 'Máy chủ trả về dữ liệu không hợp lệ, vui lòng thử lại.';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

/** Callback báo "phiên hết hạn" — App.tsx subscribe để điều hướng về màn đăng nhập. Cùng ý tưởng
 * onSessionExpired() của web-demo (session.ts) nhưng đơn giản hơn — Giai đoạn 1 chỉ có 1 nơi lắng nghe. */
type ExpiredListener = () => void;
let expiredListener: ExpiredListener | null = null;
export function onSessionExpired(listener: ExpiredListener): void {
  expiredListener = listener;
}

/** fetch() DÙNG CHUNG cho MỌI request bot-api — tự gắn header CSRF bắt buộc (`x-sigma-client: web`, xem
 * config.ts giải thích lý do giữ nguyên giá trị 'web') + cookie phiên thủ công (xem cookie-jar.ts) TRƯỚC khi
 * gửi, và tự đọc `set-cookie` từ response SAU khi nhận để lưu lại cho request kế tiếp — mô phỏng đúng hành vi
 * `credentials:'include'` mà trình duyệt tự làm nhưng React Native KHÔNG tự làm (xem cookie-jar.ts). */
async function mobileFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
  const cookieHeader = await getSessionCookieHeader();
  if (cookieHeader) headers.set('Cookie', cookieHeader);

  const res = await fetch(`${BOT_API_BASE_URL}${path}`, { ...init, headers });
  await persistSetCookieHeader(res);
  if (res.status === 401) {
    await clearSessionCookie();
    expiredListener?.();
  }
  return res;
}

async function botApiFetch<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await mobileFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: NETWORK_ERROR_VI };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as T };
}

async function botApiGet<T>(path: string): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await mobileFetch(path, { method: 'GET' });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: NETWORK_ERROR_VI };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as T };
}

/** POST KHÔNG có body nghiệp vụ (vd accept/reject/unfriend/block/unblock — agentId "mình" luôn lấy từ cookie
 * phiên phía server, route không đọc field nào thêm từ body) — tái dùng botApiFetch với body rỗng `{}`
 * (server không parse gì từ các route này, JSON.stringify({}) vô hại). Tách tên riêng cho rõ ý định. */
function botApiPostEmpty<T>(path: string): Promise<ApiResult<T>> {
  return botApiFetch<T>(path, {});
}

// ── Đăng ký qua OTP email (POST /v1/auth/register/request-otp, /verify-otp) ────────────────────────────────
export async function requestOtp(email: string): Promise<ApiResult<{ ok: true }>> {
  return botApiFetch('/v1/auth/register/request-otp', { email });
}

export interface VerifyOtpInput {
  email: string;
  code: string;
  username: string;
  password: string;
  name: string;
}
export interface VerifyOtpAgent {
  id: string;
  code: string;
  name: string;
  rcUserId: string;
  rcUsername: string;
}
export async function verifyOtp(
  input: VerifyOtpInput
): Promise<ApiResult<{ ok: true; agent: VerifyOtpAgent; sessionReady: boolean; deviceToken: string | null }>> {
  return botApiFetch('/v1/auth/register/verify-otp', input);
}

// ── Đăng nhập (POST /v1/auth/web-login, /web-login/totp) ───────────────────────────────────────────────────
export interface LoginInput {
  username: string; // email hoặc username RC
  password: string;
  code?: string; // mã 2FA-qua-email, chỉ gửi khi retry sau TOTP_REQUIRED
}
export type LoginResult = { ok: true } | { ok: false; kind: 'TOTP_REQUIRED' } | { ok: false; kind: 'ERROR'; message: string };

export async function webLogin(input: LoginInput): Promise<LoginResult> {
  const body: Record<string, string> = { identifier: input.username, password: input.password };
  if (input.code) body.code = input.code;
  const path = input.code ? '/v1/auth/web-login/totp' : '/v1/auth/web-login';
  const r = await botApiFetch<{ ok?: boolean; kind?: string; message?: string }>(path, body);
  if (!r.ok) return { ok: false, kind: 'ERROR', message: r.message };
  if (r.data.ok === true) return { ok: true };
  if (r.data.kind === 'TOTP_REQUIRED') return { ok: false, kind: 'TOTP_REQUIRED' };
  return { ok: false, kind: 'ERROR', message: r.data.message ?? 'Đăng nhập thất bại.' };
}

// ── GET /v1/auth/me — lấy rcUserId/tên hiển thị SAU khi đăng nhập thành công (cookie đã có) ─────────────────
export interface AuthenticatedAgentDto {
  id: number;
  code: string | null;
  name: string;
  rcUserId: string;
  rcUsername: string | null;
}
export async function fetchAuthenticatedAgent(): Promise<ApiResult<{ agent: AuthenticatedAgentDto }>> {
  return botApiGet('/v1/auth/me');
}

// ── POST /v1/auth/web-logout ────────────────────────────────────────────────────────────────────────────
export async function webLogout(): Promise<void> {
  try {
    await mobileFetch('/v1/auth/web-logout', { method: 'POST' });
  } catch {
    // best-effort, cùng nguyên tắc web-demo — caller vẫn xoá session cục bộ dù gọi lỗi.
  }
  await clearSessionCookie();
}

// ── Danh bạ: GET /v1/me/friends (bạn bè ACCEPTED + lời mời đang chờ) ────────────────────────────────────────
// Audit độc lập 26/7 (finding HIGH, xem BUGS_FIXED.md): field TRƯỚC ĐÂY khai `friendAgentId` — KHÔNG khớp
// response thật của bot-api (`apps/bot-api/src/friend-service.ts` hàm listFriends() push field tên `agentId`,
// route me.ts trả nguyên văn không transform) — đã đối chiếu trực tiếp source thật, sửa đúng tên field.
export interface FriendListItem {
  // requestId — id hàng FriendRequest gốc (ACCEPTED) đứng sau quan hệ bạn bè này. Thêm 29/7 (milestone 5.1,
  // đọc trực tiếp friend-service.ts xác nhận field CÓ THẬT trong response, trước đây bỏ sót vì Giai đoạn 1 chỉ
  // cần hiển thị, chưa cần key ổn định cho list) — dùng làm keyExtractor FlatList (agentId cũng ổn định nhưng
  // requestId khớp ĐÚNG khuôn web-demo đã dùng, xem ContactsScreen.tsx bản web).
  requestId: number;
  agentId: number;
  agentCode: string | null;
  agentName: string;
  online: boolean | null;
  rcUsername: string | null;
  nickname: string | null;
  blockedByMe: boolean;
  blockedThem: boolean;
}
export interface FriendRequestListItem {
  requestId: number;
  agentId: number;
  agentCode: string | null;
  agentName: string;
  createdAt: string;
}
export interface FriendListResult {
  friends: FriendListItem[];
  incomingRequests: FriendRequestListItem[];
  outgoingRequests: FriendRequestListItem[];
}
export async function listMyFriends(): Promise<ApiResult<FriendListResult>> {
  return botApiGet('/v1/me/friends');
}

// ── Kết bạn: gửi/chấp nhận/từ chối/hủy + chặn/bỏ chặn + biệt danh (POST /v1/me/friends/*, xem
// apps/bot-api/src/routes/me.ts + friend-service.ts — đọc trực tiếp source thật, KHÔNG đoán path/payload).
// Response các route này KHÔNG bọc {ok,data} — trả THẲNG DTO nghiệp vụ (khác /v1/chat/rooms bên dưới).
// agentId "mình" LUÔN suy từ cookie phiên phía server — client chỉ khai agentId/mã của ĐỐI PHƯƠNG.

export interface AgentLookupResult {
  id: number;
  code: string | null;
  name: string;
}
/** GET /v1/me/friends/lookup?agentCode=XXX — tra cứu CHÍNH XÁC 1 mã đại lý, làm căn cứ gửi lời mời kết bạn.
 * KHÔNG phải "Danh bạ nội bộ" tìm kiếm mờ theo tên/email/SĐT (mục đó còn treo riêng, xem lookupAgentByCode
 * phía bot-api) — chỉ tra đúng 1 mã. */
export async function lookupAgentByCode(code: string): Promise<ApiResult<AgentLookupResult>> {
  return botApiGet(`/v1/me/friends/lookup?agentCode=${encodeURIComponent(code)}`);
}

export interface FriendRequestDto {
  id: number;
  fromAgentId: number;
  toAgentId: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}
/** POST /v1/me/friends/request {toAgentId} — gửi lời mời kết bạn. Nếu chiều ngược lại đã có lời mời đang chờ
 * (người kia mời mình trước) → bot-api TỰ ĐỘNG chấp nhận (autoAccepted:true) thay vì báo lỗi trùng, giống
 * Zalo/Messenger — UI hiện đúng thông báo khác nhau tuỳ field này ("Đã thành bạn bè!" vs "Đã gửi lời mời"). */
export async function sendFriendRequest(toAgentId: number): Promise<ApiResult<FriendRequestDto & { autoAccepted: boolean }>> {
  return botApiFetch('/v1/me/friends/request', { toAgentId });
}

/** POST /v1/me/friends/:requestId/accept — CHỈ người NHẬN lời mời gọi được (bot-api tự đối chiếu qua cookie
 * phiên, người khác gọi hộ → 404 KHÔNG tiết lộ request tồn tại). */
export async function acceptFriendRequest(requestId: number): Promise<ApiResult<FriendRequestDto>> {
  return botApiPostEmpty(`/v1/me/friends/${requestId}/accept`);
}

/** POST /v1/me/friends/:requestId/reject — CHỈ người NHẬN lời mời từ chối được. */
export async function rejectFriendRequest(requestId: number): Promise<ApiResult<FriendRequestDto>> {
  return botApiPostEmpty(`/v1/me/friends/${requestId}/reject`);
}

/** POST /v1/me/friends/:friendAgentId/unfriend — hủy kết bạn (quan hệ ACCEPTED) HOẶC thu hồi lời mời CHÍNH
 * MÌNH đã gửi (PENDING) — KHÔNG dùng để hủy lời mời NGƯỜI KHÁC gửi tới mình (dùng rejectFriendRequest cho
 * trường hợp đó, xem quyết định thiết kế #1 friend-service.ts). */
export async function unfriend(friendAgentId: number): Promise<ApiResult<FriendRequestDto>> {
  return botApiPostEmpty(`/v1/me/friends/${friendAgentId}/unfriend`);
}

export interface FriendNicknameResult {
  friendAgentId: number;
  nickname: string | null;
}
/** POST /v1/me/friends/:friendAgentId/nickname {nickname: string|null} — nickname=null xóa biệt danh (về tên
 * thật). CHỈ áp dụng khi 2 bên ĐÃ là bạn bè (ACCEPTED) — bot-api tự chặn NO_ACTIVE_RELATION nếu chưa. Biệt danh
 * 1 CHIỀU tuyệt đối (mình đặt cho họ, chỉ mình thấy — không liên quan họ có đặt biệt danh cho mình hay không). */
export async function setFriendNickname(friendAgentId: number, nickname: string | null): Promise<ApiResult<FriendNicknameResult>> {
  return botApiFetch(`/v1/me/friends/${friendAgentId}/nickname`, { nickname });
}

export interface FriendBlockResult {
  friendAgentId: number;
  blockedByMe: boolean;
}
/** POST /v1/me/friends/:friendAgentId/block — chặn gọi/nhắn tin 1 CHIỀU (MÌNH chặn HỌ, không phải chặn lẫn
 * nhau) — KHÔNG xóa quan hệ bạn bè, chỉ đánh dấu cờ. */
export async function blockFriend(friendAgentId: number): Promise<ApiResult<FriendBlockResult>> {
  return botApiPostEmpty(`/v1/me/friends/${friendAgentId}/block`);
}
/** POST /v1/me/friends/:friendAgentId/unblock — gỡ chặn. */
export async function unblockFriend(friendAgentId: number): Promise<ApiResult<FriendBlockResult>> {
  return botApiPostEmpty(`/v1/me/friends/${friendAgentId}/unblock`);
}

// Phase 6 dọn RC-dead-code (30/7) — `listRooms()` (gọi `/v1/rc/subscriptions.get`, RC cũ) ĐÃ XÓA: zero-caller
// thật (ChatListScreen.tsx đã đổi hẳn sang `listChatRooms()`). Dọn tiếp (31/7): `mapAndSortRooms()`/
// `RcRoomListItem`/`RcSubscription` — chỉ còn caller là chính chúng + test riêng của chúng, tự thân đã chết
// transitively sau khi mất `listRooms()` — ĐÃ XÓA cùng test tương ứng (`__tests__/api-client.test.ts`).

// ── Danh sách phòng chat, Phase 2 "chat lõi" tự xây (GET /v1/chat/rooms — ĐÃ deploy production thật, ổn định,
// xem apps/bot-api/src/routes/chat.ts + services/chat-room-service.ts) — THAY THẾ nguồn Rocket.Chat cũ cho
// ChatListScreen.tsx,
// bước chuẩn bị hợp lý cho cutover khỏi RC. Response bọc `{ok:true,data:[...]}` — KHÁC shape /v1/me/friends/*
// (route đó trả DTO thẳng, xem comment nhóm hàm kết bạn phía trên) vì chat.ts wrap tường minh mọi response.
export type ChatRoomType = 'DIRECT' | 'GROUP';
export interface ChatRoomLastMessage {
  id: string;
  kind: string;
  body: string | null;
  senderId: number | null;
  createdAt: string;
}
export interface ChatRoomSummary {
  id: string;
  type: ChatRoomType;
  name: string | null;
  // Phòng DIRECT: room-service KHÔNG tự tra tên/avatar Agent đối phương (giữ service thuần domain chat, xem
  // comment RoomSummaryDto phía bot-api) — chỉ có otherAgentId, FE (ChatListScreen.tsx) tự tra tên qua danh
  // sách bạn bè đã tải (listMyFriends()) vì phòng DIRECT chỉ tồn tại giữa 2 bạn bè ACCEPTED.
  otherAgentId: number | null;
  avatarColor: string | null;
  avatarUrl: string | null;
  pinnedMessageId: string | null;
  lastMessageAt: string | null;
  lastMessage: ChatRoomLastMessage | null;
  unreadCount: number;
  myRole: string;
}
interface ChatRoomsResponse {
  ok: true;
  data: ChatRoomSummary[];
}
export async function listChatRooms(): Promise<ApiResult<ChatRoomSummary[]>> {
  const r = await botApiGet<ChatRoomsResponse>('/v1/chat/rooms');
  if (!r.ok) return r;
  return { ok: true, data: r.data.data };
}

// findOrCreateDirectRoom() (bot-api) trả nguyên `ChatRoomWithMembers` đầy đủ — ta CHỈ cần `id` để điều hướng
// (mở ConversationScreenPlaceholder.tsx), không khai đủ toàn bộ field response ở đây.
interface ChatDirectRoomResponse {
  ok: true;
  data: { id: string };
}
/** POST /v1/chat/rooms/direct {targetAgentId} — lấy phòng DIRECT sẵn có HOẶC tạo mới với 1 bạn bè (bot-api tự
 * chặn CANNOT_MESSAGE nếu 2 bên chưa là bạn bè hoặc đã chặn nhau, xem findOrCreateDirectRoom() chat-room-service.ts).
 * Dùng cho nút "Nhắn tin" ở ContactsScreen.tsx — điều hướng qua ConversationScreenPlaceholder.tsx bằng roomId
 * trả về (CHƯA có UI hội thoại thật, đó là việc milestone 5.2). */
export async function createOrOpenDirectRoom(targetAgentId: number): Promise<ApiResult<{ id: string }>> {
  const r = await botApiFetch<ChatDirectRoomResponse>('/v1/chat/rooms/direct', { targetAgentId });
  if (!r.ok) return r;
  return { ok: true, data: { id: r.data.data.id } };
}
