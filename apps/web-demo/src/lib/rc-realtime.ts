// "Chat lõi" — hồ sơ công khai theo username, đính kèm ảnh/file, real-time reset khi đăng xuất, cắt tin nhắn
// dài — phần còn lại của module này (danh sách phòng/lịch sử/gửi tin/xóa-thu hồi/panel nhóm/QR mời/loại
// nhóm/typing-indicator qua DDP-RC) ĐÃ XÓA (Phase 6 dọn RC-dead-code, 30/7 — xem BUGS_FIXED.md): toàn bộ chat
// text đã cutover sang hệ chat lõi TỰ XÂY (chat-client.ts/chat-realtime.ts, REST + WebSocket riêng của
// bot-api, KHÔNG qua Rocket.Chat) từ Phase 3, các hàm RC cũ ở đây xác nhận ZERO-CALLER thật (grep toàn
// `apps/web-demo`/`apps/mobile` trước khi xóa, chỉ còn comment tham chiếu lịch sử).
//
// LOẠI SẠCH Rocket.Chat (4/8) — file này TRƯỚC ĐÂY gọi bot-api reverse-proxy `/v1/rc/*` (routes/rc-proxy.ts,
// ĐÃ XÓA) để trung chuyển REST Rocket.Chat. RC đã bị loại hoàn toàn: các hàm CÒN LẠI hoặc gọi endpoint NỘI BỘ
// của bot-api (`${VITE_BOT_API_URL}/v1/profile/...`, `/v1/chat/...`) hoặc trả cố định (getRoomReadOnly). Mọi
// request vẫn dùng `credentials:'include'` (cookie httpOnly `sigma_ws` tự gửi kèm — bot-api CÙNG allowlist
// CORS credentials:true + origin cụ thể, KHÔNG phải `*`). KHÔNG còn token RC nào ở trình duyệt (session cục
// bộ chỉ còn userId/agentName để hiển thị, xem session.ts).
import type { ChatMessage } from '../mock-data/types';
import { handleSessionExpired } from './session';
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

export type RcResult<T> = { ok: true; data: T } | { ok: false; message: string };

// 24/7 (task "duy trì đăng nhập 24/24, tự động về /login khi hết hạn") — VERIFY THẬT bằng curl trực tiếp RC
// production với X-Auth-Token giả (KHÔNG suy đoán shape): mọi endpoint REST RC khi authToken sai/hết hạn trả
// ĐÚNG `HTTP 401 { success:false, error:"You must be logged in to do this.", status:"error", message:"..." }`.
// SIGMA (26/7) — GIỜ cũng bao gồm 401 do bot-api TỰ trả (`WEB_SESSION_INVALID`/`RC_TOKEN_INVALID`, thiếu/
// hết hạn cookie `sigma_ws`) — handleRcAuthExpiry() chỉ kiểm STATUS CODE (401), KHÔNG phân biệt "401 do
// bot-api tự chặn" hay "401 do RC trả về qua pass-through" — cả 2 case đều đúng nghĩa "phiên hết hạn", xử lý
// GIỐNG HỆT nhau (đúng nguyên tắc "tầng gọi API chung" đã áp dụng từ trước).
const SESSION_EXPIRED_MESSAGE_VI = 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.';

/** Trả message "phiên hết hạn" (tiếng Việt) + tự dọn phiên/báo App.tsx nếu res LÀ 401 THẬT (đã xác nhận qua
 * thử lại); trả `null` nếu không phải 401 (caller tự dịch lỗi theo nhánh translateRcErrorMessage như cũ). Đặt
 * CHUNG 1 hàm để mọi endpoint trong file này xử lý giống hệt nhau, không lệch case này case khác.
 *
 * SIGMA (27/7, Admin Demo báo "vào QR/hồ sơ báo hết phiên" — điều tra sâu tìm ra RC thật tự nghẽn/rate-limit
 * khi bot-api gọi rcGetMe dồn dập, xem agent-api-client.ts giải thích đầy đủ) — TRƯỚC ĐÂY 1 lần 401 BẤT KỲ =
 * kết luận hết phiên ngay, không phân biệt được "RC nghẽn thoáng qua" với "phiên thật sự hết hạn". Sửa: khi
 * gặp 401, đợi 1.5s rồi gọi `GET /v1/auth/me` xác nhận LẠI — nếu xác nhận vẫn KHÔNG hợp lệ mới thật sự dọn
 * phiên; nếu xác nhận lại HỢP LỆ (RC chỉ nghẽn thoáng qua lúc nãy) thì KHÔNG đá về /login, chỉ trả lỗi mềm cho
 * request gốc (người dùng bấm lại thao tác vừa lỗi là được, không mất hẳn phiên đăng nhập). */
async function handleRcAuthExpiry(res: Response): Promise<string | null> {
  if (res.status !== 401) return null;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    const confirm = await fetch(`${botApiBaseUrl()}/v1/auth/me`, { credentials: 'include', headers: { 'x-sigma-client': 'web' } });
    if (confirm.ok) return 'Thao tác vừa rồi gặp lỗi tạm thời, vui lòng thử lại.';
  } catch {
    // lỗi mạng lúc xác nhận lại — coi như CHƯA xác nhận được, rơi xuống nhánh dọn phiên bên dưới cho an toàn.
  }
  handleSessionExpired();
  return SESSION_EXPIRED_MESSAGE_VI;
}

/** Loại phòng RC — cần biết để chọn đúng endpoint. CÒN DÙNG THẬT bởi getRoomReadOnly() (phía dưới) dù các hàm
 * lịch sử/danh sách phòng khác đã xóa (Phase 6 dọn RC-dead-code). */
export type RcRoomType = 'c' | 'p' | 'd';

// ── Đính kèm ảnh/file THẬT trong chat (27/7, "Phần 1" kế hoạch đính kèm) ────────────────────────────────
//
// Chat message VẪN đi qua Rocket.Chat như trước (KHÔNG đổi transport/store) — file vật lý lưu RIÊNG ở bot-api
// (xem apps/bot-api/src/chat-attachment-service.ts). Luồng: upload file → bot-api trả `id` → gửi 1 tin nhắn RC
// THẬT qua sendMessage() hiện có, nội dung là 1 dòng JSON "marker" bắt đầu bằng chuỗi cố định KHÔNG BAO GIỜ
// người dùng tự gõ trùng (không phải cụm từ tiếng Việt/tiếng Anh thông thường nào) → mapRcMessage (đọc lịch
// sử/real-time) phát hiện marker này, parse JSON, render `type:'image'`/`type:'file'` thay vì text thường.
// `id` trong marker trỏ tới `GET /v1/chat/attachments/:id` (bot-api, xem routes/chat-attachments.ts).
//
// Phase 6 dọn RC-dead-code (30/7) — `sendMessage()`/`mapRcMessage()` nhắc ở trên ĐÃ XÓA (zero-caller thật, hệ
// chat text đã cutover sang chat-client.ts). `buildAttachmentMarkerText`/`AttachmentMarkerPayload` GIỮ
// NGUYÊN dưới đây dù hiện cũng zero-caller (MessageComposer.tsx đã đổi sang luồng khác) — KHÔNG nằm trong
// danh sách được duyệt xóa đợt này, ngoài phạm vi, cờ lại cho LEAD (xem báo cáo).
const ATTACHMENT_MARKER_PREFIX = 'SIGMA_ATTACHMENT ';

interface AttachmentMarkerPayload {
  id: string;
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/** Dựng text tin nhắn marker — KHÔNG có API RC riêng cho "tin nhắn đính kèm", tái dùng đường gửi tin thường. */
export function buildAttachmentMarkerText(payload: AttachmentMarkerPayload): string {
  return `${ATTACHMENT_MARKER_PREFIX}${JSON.stringify(payload)}`;
}

// ── Panel thông tin nhóm (25/7) — CHỈ CÒN getRoomReadOnly() (xem dưới) — các hàm khác của panel nhóm
// (getRoomMembers/getRoomFiles/setRoomReadOnly/setMemberRole/getOrCreateGroupInvite/regenerateGroupInvite/
// setRoomType) ĐÃ XÓA Phase 6 dọn RC-dead-code (30/7, zero-caller thật) — xem BUGS_FIXED.md.
//
// LOẠI SẠCH Rocket.Chat (4/8) — getRoomReadOnly() TRƯỚC ĐÂY gọi RC `GET /api/v1/{groups|channels}.info?roomId`
// qua reverse-proxy `/v1/rc/*` để đọc cờ `ro` (chỉ-đọc). Hệ chat lõi tự xây (routes/chat.ts) hiện KHÔNG expose
// khái niệm "phòng chỉ-đọc" cho client (bảng ChatRoom CÓ cột `read_only` nhưng chưa có endpoint đọc/ghi nào —
// và hàm này zero-caller thật trong web-demo, grep xác nhận: chỉ định nghĩa ở đây, không màn nào gọi). Vì vậy
// trả `false` CỐ ĐỊNH (không phòng nào chỉ-đọc) — KHÔNG còn chạm `/v1/rc/*`. CỜ CHO LEAD: nếu sau này cần
// enforce phòng chỉ-đọc phía client thì thêm cột `readOnly` vào response `GET /v1/chat/rooms` rồi đọc ở đây.
/** Trạng thái "chỉ Trưởng/Phó được gửi tin" của phòng. Hệ chat nội bộ chưa expose khái niệm này ra client →
 * trả `false` cho MỌI phòng (KHÔNG gọi Rocket.Chat nữa). Giữ chữ ký (roomId/roomType) để caller tương lai
 * không phải đổi nếu sau này đọc thật từ ChatRoom nội bộ. */
export async function getRoomReadOnly(_roomId: string, _roomType: RcRoomType): Promise<RcResult<boolean>> {
  return { ok: true, data: false };
}

// ── Hồ sơ công khai theo username (25/7; 4/8 cutover sang endpoint NỘI BỘ) ───────────────────────────────
export interface RcPublicUserInfo {
  username: string;
  name: string;
  status: string; // 'online' | 'away' | 'busy' | 'offline'
}

// LOẠI SẠCH Rocket.Chat (4/8) — TRƯỚC ĐÂY gọi RC `GET /api/v1/users.info` qua `/v1/rc/*`. GIỜ gọi endpoint NỘI
// BỘ `GET /v1/profile/by-username/:username` (bot-api, routes/profile.ts) đọc thẳng bảng Agent — KHÔNG còn phụ
// thuộc Rocket.Chat. Shape RcPublicUserInfo GIỮ NGUYÊN để PublicProfileScreen.tsx không phải sửa: `status`
// đặt cố định 'offline' vì hệ nội bộ CHƯA có presence (RC đã loại) — KHÔNG bịa trạng thái online giả (CẤM
// SUY LUẬN). 404 (username chưa link Agent) → thông báo "không tìm thấy" như cũ.
export async function getRcUserInfoByUsername(username: string): Promise<RcResult<RcPublicUserInfo>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/profile/by-username/${encodeURIComponent(username)}`, { credentials: 'include' });
  } catch {
    return { ok: false, message: networkErrorMessage() };
  }
  let json: { name?: string; username?: string; message?: string };
  try {
    json = await res.json();
  } catch {
    return { ok: false, message: PARSE_ERROR_VI };
  }
  if (!res.ok || !json.username) {
    return { ok: false, message: (await handleRcAuthExpiry(res)) ?? json.message ?? 'Không tìm thấy người dùng này.' };
  }
  return { ok: true, data: { username: json.username, name: json.name || json.username, status: 'offline' } };
}

// ── Giới hạn ký tự 1 tin nhắn + tự tách khi vượt (26/7, B29-tiếp) ──────────────────────────────────────────
//
// ĐÃ TỰ VERIFY THẬT (script node gọi admin API production, KHÔNG suy đoán): `GET
// /api/v1/settings/Message_MaxAllowedSize` trả `{_id:'Message_MaxAllowedSize', value:5000, success:true}` —
// đây là giới hạn CỨNG của RC (RC tự chặn/cắt nếu vượt). MAX_MESSAGE_CHARS ở đây CHỌN THẤP HƠN NHIỀU (2000,
// không phải đúng 5000) — quyết định UX tự chọn (spec cho phép, không suy đoán hành vi RC ở đây, chỉ là
// ngưỡng trải nghiệm người dùng): 1 tin nhắn 5000 ký tự tràn màn hình di động rất khó đọc/khó theo dõi hội
// thoại, 2000 vẫn rộng rãi cho nhu cầu thực tế (copy/paste đoạn văn bản dài) mà vẫn luôn nằm dưới ngưỡng cứng
// RC — KHÔNG BAO GIỜ bị RC từ chối vì lý do độ dài.
export const MAX_MESSAGE_CHARS = 2000;

/** Tách 1 đoạn văn bản dài thành nhiều đoạn ≤ maxChars, ƯU TIÊN cắt tại ranh giới khoảng trắng/dòng (giữ
 * nguyên từ, không cắt giữa chừng) — chỉ cắt CỨNG giữa 1 "từ" khi bản thân từ đó (không có khoảng trắng nào)
 * đã dài hơn maxChars (trường hợp hiếm — link/chuỗi ký tự liền không dấu cách). Hàm THUẦN (không gọi RC/DOM),
 * test được độc lập — xem rc-message-split.test.ts. Trả mảng RỖNG cho input rỗng/toàn khoảng trắng. */
export function splitMessageIntoChunks(text: string, maxChars: number = MAX_MESSAGE_CHARS): string[] {
  if (maxChars <= 0) throw new Error('maxChars phải > 0');
  if (text.length <= maxChars) {
    const trimmed = text.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  // \S+ = 1 "từ" (chuỗi ký tự không khoảng trắng), \s+ = 1 khối khoảng trắng/xuống dòng — giữ nguyên token để
  // không làm mất dấu cách/newline khi ghép lại chunk.
  const tokens = text.match(/\S+|\s+/g) ?? [];
  const chunks: string[] = [];
  let current = '';

  for (const token of tokens) {
    const isWhitespace = /^\s+$/.test(token);

    if (token.length > maxChars) {
      // Từ đơn lẻ dài hơn cả ngưỡng (vd link/chuỗi liền rất dài, hoặc chuỗi emoji liên tiếp không dấu cách) —
      // không thể tách theo ranh giới từ được nữa, đành cắt cứng theo maxChars cho riêng token này.
      //
      // Audit độc lập 26/7 (finding MEDIUM, xem BUGS_FIXED.md): `token.slice(i, i+maxChars)` cắt theo UTF-16
      // CODE UNIT thô — emoji ngoài Basic Multilingual Plane (vd 😀) chiếm 2 code unit (surrogate pair cao+
      // thấp). Nếu điểm cắt rơi ĐÚNG GIỮA 1 cặp surrogate, cả 2 đoạn kết quả đều chứa 1 nửa ký tự mồ côi →
      // hiển thị vỡ (□/�) ở cả 2 đầu. SỬA: vẫn đếm theo CODE UNIT như phần còn lại của hàm (nhất quán với
      // `maxChars`/`.length` dùng khắp nơi — KHÔNG đổi sang đếm code point, tránh lệch nghĩa "maxChars ký tự"),
      // chỉ LÙI điểm cắt 1 vị trí nếu nó rơi đúng giữa 1 high surrogate (0xD800-0xDBFF) và low surrogate
      // (0xDC00-0xDFFF) liền sau — giữ nguyên cặp đó trọn vẹn trong đoạn TRƯỚC.
      if (current.trim()) chunks.push(current.trim());
      current = '';
      let i = 0;
      while (i < token.length) {
        let end = Math.min(i + maxChars, token.length);
        const codeBeforeEnd = token.charCodeAt(end - 1);
        const codeAtEnd = token.charCodeAt(end);
        if (codeBeforeEnd >= 0xd800 && codeBeforeEnd <= 0xdbff && codeAtEnd >= 0xdc00 && codeAtEnd <= 0xdfff) {
          end -= 1;
        }
        chunks.push(token.slice(i, end));
        i = end;
      }
      continue;
    }

    if (current.length + token.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      // Bắt đầu đoạn mới: nếu token vừa làm tràn là khoảng trắng thì bỏ (không mở đầu đoạn mới bằng dấu cách),
      // nếu là từ thì giữ lại làm đầu đoạn mới.
      current = isWhitespace ? '' : token;
    } else {
      current += token;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export interface UploadedChatAttachment {
  id: string;
  url: string;
}

/** POST multipart tới bot-api (KHÔNG qua RC — đây là endpoint RIÊNG của bot-api, `/v1/chat/attachments`,
 * KHÁC `rcProxyUrl()` dùng cho mọi hàm khác trong file này, xem comment đầu block đính kèm phía trên) — dùng
 * `proxyFetch()` để tự gắn `credentials:'include'` + header CSRF (CÙNG mọi request bot-api khác), KHÔNG tự
 * đặt `Content-Type` (để trình duyệt tự sinh `multipart/form-data; boundary=...` đúng chuẩn khi body là
 * `FormData` — đặt tay ở đây sẽ THIẾU boundary, busboy phía server không parse được). Trả `{ok:true,data:{id,
 * url}}` — caller (MessageComposer.tsx uploadAndSend()) tự gọi `sendMessage()` với `buildAttachmentMarkerText()`
 * SAU KHI upload xong (KHÔNG tự gửi tin nhắn ở đây — hàm này CHỈ lo tải file). */
export async function uploadChatAttachment(file: File): Promise<RcResult<UploadedChatAttachment>> {
  const formData = new FormData();
  formData.append('file', file, file.name);

  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/chat/attachments`, { method: 'POST', body: formData });
  } catch {
    return { ok: false, message: networkErrorMessage() };
  }

  let json: { ok?: boolean; data?: UploadedChatAttachment; error?: string; message?: string };
  try {
    json = await res.json();
  } catch {
    return { ok: false, message: PARSE_ERROR_VI };
  }
  if (!res.ok || json.ok !== true || !json.data) {
    return { ok: false, message: (await handleRcAuthExpiry(res)) ?? json.message ?? 'Không tải lên được file đính kèm, vui lòng thử lại.' };
  }
  return { ok: true, data: json.data };
}

/** PATCH roomId cho 1 attachment SAU KHI tin nhắn marker RC đã gửi thành công (xem comment schema.prisma
 * `ChatAttachment.roomId`/routes/chat-attachments.ts phía bot-api — attachment tải lên TRƯỚC khi biết thuộc
 * phòng nào). Best-effort THEO THIẾT KẾ — caller (ConversationScreen.tsx) gọi `void` KHÔNG đợi/KHÔNG chặn UI:
 * ảnh/file đã hiển thị được ngay cho CHÍNH người gửi dù bước này lỗi (GET vẫn cho phép uploaderId xem file của
 * chính mình bất kể roomId), chỉ ảnh hưởng quyền xem của NGƯỜI KHÁC trong phòng nếu thật sự lỗi — chấp nhận
 * được, không đáng chặn trải nghiệm gửi tin của người gửi vì 1 request phụ thất bại. */
export async function attachRoomToChatAttachment(attachmentId: string, roomId: string): Promise<RcResult<void>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/chat/attachments/${attachmentId}/room`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId })
    });
  } catch {
    return { ok: false, message: networkErrorMessage() };
  }
  if (!res.ok) {
    let message = 'Không gắn được phòng cho file đính kèm.';
    try {
      const json = (await res.json()) as { message?: string };
      message = json.message ?? message;
    } catch {
      // giữ message mặc định — best-effort, không quan trọng bằng chuỗi text lỗi chính xác.
    }
    return { ok: false, message };
  }
  return { ok: true, data: undefined };
}

// ---- Real-time (Phase 6 dọn RC-dead-code, 30/7) ----
//
// TOÀN BỘ giao thức DDP qua WebSocket relay bot-api⇄Rocket.Chat (ensureSocket/subscribeRoomMessages/
// subscribeTypingIndicator/sendTypingStatus + phụ trợ typing-indicator) ĐÃ XÓA — xác nhận zero-caller thật:
// KHÔNG màn hình nào trong web-demo/mobile còn gọi các hàm này (ConversationScreen.tsx đã đổi sang
// chat-realtime.ts, hệ WebSocket riêng của bot-api KHÔNG qua Rocket.Chat, xem BUGS_FIXED.md mục dọn
// RC-dead-code). CHỈ giữ `resetRealtimeConnection()` (KHAI RÕ TRONG DANH SÁCH ĐƯỢC DUYỆT — vẫn dùng thật bởi
// logout.ts) + state module-level nó cần reset — dù từ nay không còn đường nào khác GHI vào state này nữa
// (đã luôn zero-caller từ phía client TRƯỚC đợt dọn này rồi, KHÔNG PHẢI hành vi mới do đợt dọn gây ra).
type RoomMessageListener = (message: ChatMessage) => void;
type TypingChangeListener = (username: string, isTyping: boolean) => void;

/** roomId → tập listener đang lắng nghe phòng đó — module-level, reset bởi resetRealtimeConnection(). */
const activeSubscriptions = new Map<string, Set<RoomMessageListener>>();
/** roomId → tập listener đang lắng nghe trạng thái gõ chữ của phòng đó — reset bởi resetRealtimeConnection(). */
const activeTypingSubscriptions = new Map<string, Set<TypingChangeListener>>();

let cachedRcUsername: string | null = null;
let cachedRcUsernameForUserId: string | null = null;

let socket: WebSocket | null = null;
let socketConnectedForUserId: string | null = null; // userId đã dùng để mở kết nối hiện tại — đổi user thì phải mở kết nối mới.
let connectPromise: Promise<void> | null = null;
let loggedIn = false;

/** Audit độc lập 26/7 (finding LOW, xem BUGS_FIXED.md): đăng xuất user A rồi đăng nhập user B TRONG CÙNG TAB
 * (SPA, không reload trang) — TRƯỚC ĐÂY không có cách nào đóng kết nối WebSocket cũ (biến `socket` module-
 * level chỉ bị GHI ĐÈ bởi `ensureSocket()` lần sau, không `.close()` kết nối cũ trước đó) → rò rỉ 1 kết nối
 * WS treo phía bot-api/RC. Gọi hàm này trong `performLogout()` (logout.ts) — đóng socket hiện có (nếu còn) +
 * xóa sạch mọi state real-time module-level, đảm bảo lần đăng nhập kế tiếp (dù cùng hay khác tài khoản) khởi
 * tạo lại từ đầu, không thừa kế trạng thái cũ. */
export function resetRealtimeConnection(): void {
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
  loggedIn = false;
  activeSubscriptions.clear();
  activeTypingSubscriptions.clear();
  cachedRcUsername = null;
  cachedRcUsernameForUserId = null;
}
