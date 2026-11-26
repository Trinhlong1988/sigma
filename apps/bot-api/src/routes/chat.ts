// SIGMA Phase 2 "chat lõi" (29/7) — REST routes cho hệ chat TỰ XÂY (bảng chat_rooms/chat_room_members/
// chat_messages/chat_message_reactions, xem schema.prisma) — THAY DẦN Rocket.Chat (rc-realtime.ts/rc-proxy.ts
// vẫn còn nguyên, CHẠY SONG SONG, chưa cắt gì — xem đầu file chat-client.ts phía web-demo).
//
// TÁCH LỚP route ↔ service NGHIÊM NGẶT: mọi nghiệp vụ (kiểm tra bạn bè, quyền thành viên, cửa sổ 48h thu hồi,
// v.v.) nằm ở services/chat-{room,message,reaction}-service.ts (agent khác build song song CÙNG worktree này,
// KHÔNG sửa 3 file đó) — route ở đây CHỈ: (1) đọc req, validate hình dạng input tối thiểu, (2) gọi đúng hàm
// service theo hợp đồng chữ ký đã brief, (3) map kết quả/lỗi sang response HTTP.
//
// Quy ước lỗi nghiệp vụ: MỌI hàm service ném lỗi đều là `Error` có thêm field `.code` (string) — xem
// `respondServiceError()` bên dưới map code → HTTP status. Lỗi KHÔNG có `.code` (bug thật/crash bất ngờ) được
// RE-THROW để `asyncHandler` chuyển tiếp cho `errorHandler` tập trung ở app.ts (R198 — KHÔNG được nuốt câm,
// PHẢI hiển thị qua console.error + 500 chung, không tự bịa response ở đây).
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { asyncHandler } from '../async-handler.js';
import { requireSession } from '../session-middleware.js';
import { getBotDb } from '../db.js';
import {
  findOrCreateDirectRoom,
  createGroupRoom,
  listRoomsForAgent,
  getRoomDetail,
  assertActiveMember,
  addMember,
  removeMember,
  dissolveRoom,
  changeMemberRole,
  pinMessage,
  unpinMessage,
  listPinnedMessages,
  requestJoin,
  approveJoin,
  rejectJoin,
  listPendingJoinRequests,
  saveRoomAvatar,
  getRoomAvatar,
  getRoomFallbackInfo,
  updateGroupSettings,
  MAX_ROOM_AVATAR_SIZE_BYTES,
  // MENU HỘI THOẠI (7/8) — hành động cấp-hội-thoại per-agent.
  setRoomMuted,
  setConversationPinned,
  markRoomUnread,
  setRoomHidden,
  setRoomRemoved,
  reportRoom,
  // APK badge cộng/trừ dồn (7/8) — đếm unread 1 recipient để đính vào payload FCM.
  countUnreadForRoomMember
} from '../services/chat-room-service.js';
import { parseSingleFileUpload } from '../multipart-upload.js';
import { renderFallbackAvatarPng } from '../fallback-avatar.js';
import { sendMessage, listMessages, deleteMessage, editMessage, markRead, markAllRead, listRoomAttachments, parseMentionAgentIds, parseMentionAll } from '../services/chat-message-service.js';
import { notifyMention } from '../notification-service.js';
import { listRefundConfirmationsForMessage } from '../refund-service.js';
import { toggleReaction, listReactionsForMessages } from '../services/chat-reaction-service.js';
import { listRoomTids, getRoomRevenueReport } from '../services/chat-room-tid-service.js';
import { buildRoomsRevenueKpi } from '../services/rooms-revenue-kpi.js';
import { correctLoCardType, listCardOptionsForLo } from '../lo-service.js';
import { resolveLoEditSource } from '../lo-bill-resolve.js';
import { buildDealerRefundReconcile } from '../ocr-send-service.js';
import { roomInvestorRevenue } from './me-investor-report.js';
import { searchMessages } from '../services/chat-search-service.js';
import { broadcastToRoom, broadcastToAgent, agentPresenceOnline, getAgentLastSeen, markAgentSeen } from '../chat-realtime-hub.js';
import { broadcastPresenceUpdate } from '../presence-service.js';
import { sendPushToAgent } from '../push-notification-service.js';
import { isAccountDeactivated, DEACTIVATED_DISPLAY_NAME } from '../deletion-service.js';
import { crossPostBillToInvestor } from '../investor-crosspost-service.js';

export const chatRouter = Router();

/** PRESENCE "Hoạt động X phút trước" (6/8) — ISO mốc last-seen của agent (getAgentLastSeen, chat-realtime-hub.ts)
 * hoặc null (đang online/chưa biết). Đính kèm cạnh `online` ở rooms list + room detail cho client hiện thời gian. */
function lastSeenIso(agentId: number): string | null {
  const ms = getAgentLastSeen(agentId);
  return ms != null ? new Date(ms).toISOString() : null;
}

// ── Phase 3 "real-time" (29/7) — helper broadcastXxx() gọi NGAY SAU mỗi ghi-thành-công, TRƯỚC res.json() ────
// (xem chat-realtime-hub.ts cho lý do broadcastToRoom() KHÔNG BAO GIỜ throw — mọi helper dưới đây an toàn gọi
// "fire and forget", KHÔNG bọc thêm try/catch ở call site). Giao thức JSON server→client — xem chat-realtime-
// proxy.ts đầu file + apps/web-demo/src/lib/chat-realtime.ts (client mirror đúng shape này).
function broadcastNewMessage(roomId: string, message: unknown): void {
  broadcastToRoom(roomId, { msg: 'new-message', roomId, message });
}
function broadcastMessageEdited(roomId: string, message: unknown): void {
  broadcastToRoom(roomId, { msg: 'message-edited', roomId, message });
}
function broadcastMessageDeleted(roomId: string, messageId: string, deletedAt: Date | null): void {
  broadcastToRoom(roomId, { msg: 'message-deleted', roomId, messageId, deletedAt });
}
// Audit độc lập 30/7 (MEDIUM): PHẢI kèm `agentId` (người vừa thao tác) NGAY CẢ khi action='removed' — lúc đó
// `reaction` là null (không còn hàng để đọc agentId từ đó), nhưng client CẦN biết AI vừa bỏ thích để xóa ĐÚNG
// người đó khỏi map cục bộ (merge theo agentId), KHÔNG được thay cả object bằng 1 giá trị duy nhất (client cũ
// làm vậy → người sau ghi đè mất reaction người trước, dù cả 2 vẫn tồn tại thật trong DB).
function broadcastReactionUpdate(roomId: string, messageId: string, agentId: number, action: string, reaction: unknown): void {
  broadcastToRoom(roomId, { msg: 'reaction-update', roomId, messageId, agentId, action, reaction });
}
function broadcastRoomUpdated(roomId: string, room: unknown): void {
  broadcastToRoom(roomId, { msg: 'room-updated', roomId, room });
}
function broadcastRoomMemberChanged(roomId: string, agentId: number, action: string, role?: string): void {
  broadcastToRoom(roomId, { msg: 'room-member-changed', roomId, agentId, action, role });
}
// GIẢI TÁN NHÓM (dissolve) — phát cho MỌI người đang xem phòng để client tự rời về danh sách + xóa khỏi cache
// phòng (phòng đã xóa mềm, không còn quyền vào). CÙNG kiểu fire-and-forget các broadcast khác.
function broadcastRoomDissolved(roomId: string): void {
  broadcastToRoom(roomId, { msg: 'room-dissolved', roomId });
}
// GHIM KHÔNG GIỚI HẠN / "Bảng tin" (5/8) — phát danh sách ghim mới cho mọi người đang xem phòng khi ghim/bỏ ghim.
function broadcastPinsUpdated(roomId: string, pins: unknown): void {
  broadcastToRoom(roomId, { msg: 'pins-updated', roomId, pins });
}
// TICK "đã đọc" (5/8, Admin Demo "trạng thái đã gửi/đã nhận/đã đọc" kiểu Zalo) — sau khi `markRead()` ghi
// `lastReadMessageId`, phát cho MỌI người đang xem phòng biết `agentId` đã đọc TỚI tin `messageId` (createdAt =
// `lastReadAt`). Người GỬI (đang mở phòng) so sánh: tin của họ có sentAt ≤ lastReadAt → đổi tick sang "đã xem"
// (2 tick xanh). CỐ Ý phát cho cả phòng (không loại trừ) — mọi tab/thiết bị của người gửi đều cần cập nhật.
function broadcastReadReceipt(roomId: string, agentId: number, messageId: string, lastReadAt: Date): void {
  broadcastToRoom(roomId, { msg: 'read-receipt', roomId, agentId, messageId, lastReadAt });
}
// TICK "đã nhận" (6/8, Admin Demo "online → đã nhận DÙ chưa mở phòng") — phát cho MỌI người đang xem phòng biết
// `agentId` đã NHẬN (online) mọi tin tới mốc `deliveredAt`. Người GỬI đổi tick tin của họ sang "đã nhận" (2
// tick xám). Suy từ trạng thái online THẬT (agentHasOpenConnection) — KHÔNG cột DB mới. 2 nguồn phát: (1) lúc
// gửi tin nếu người nhận đang online; (2) lúc người nhận VỪA online (WS connect) — chat-realtime-proxy.ts.
export function broadcastDeliveryReceipt(roomId: string, agentId: number, deliveredAt: Date): void {
  broadcastToRoom(roomId, { msg: 'delivery-receipt', roomId, agentId, deliveredAt });
}

// ── B115-tiếp (2/8, Admin Demo "phải thông báo push nổi màn hình bất kể trường hợp nào như zalo") ────────────
// Nhãn preview tiếng Việt cho tin KHÔNG phải TEXT — CÙNG khuôn `previewTextForLastMessage()` (chat-client.ts
// phía web-demo, giữ ĐÚNG chữ đã dùng ở đó để nhất quán tuyệt đối 1 loại tin = 1 câu chữ xuyên toàn app, KHÔNG
// bịa câu khác) + thêm nhánh Bill (B106/B112 — ảnh đã ghép bảng OCR, `metadataJson.isBillImage===true`) mà
// `previewTextForLastMessage()` KHÔNG có (hàm đó chỉ phục vụ danh sách phòng, chưa từng cần phân biệt bill).
// Hàm THUẦN (không I/O) — export để test độc lập không cần dựng DB/WS.
export function buildMessagePreviewText(kind: string, body: string | null, metadataJson: string | null): string {
  if (kind === 'TEXT') return (body ?? '').trim();
  if (kind === 'IMAGE') {
    if (metadataJson) {
      try {
        const parsed = JSON.parse(metadataJson) as { isBillImage?: boolean };
        if (parsed.isBillImage === true) return '[Bill]';
      } catch {
        // metadataJson hỏng — coi như ảnh thường, rơi xuống nhãn mặc định bên dưới (KHÔNG throw, đây chỉ là
        // hiển thị phụ cho thông báo, CÙNG nguyên tắc parse metadataJson ở chat-client.ts).
      }
    }
    return '[Hình ảnh]';
  }
  const KIND_PREVIEW_VI: Record<string, string> = {
    FILE: '[Tệp đính kèm]',
    VOICE: '[Tin nhắn thoại]',
    LOCATION: '[Vị trí]',
    QR: '[Mã QR]'
  };
  return KIND_PREVIEW_VI[kind] ?? '';
}

/** Case B115 #2/#3/#4 — sau khi tin nhắn ghi DB + broadcast phòng THÀNH CÔNG (broadcastNewMessage), báo cho
 * MỌI thành viên đang hoạt động KHÁC (trừ sender):
 *   (a) `broadcastToAgent()` (chat-realtime-hub.ts, registry cấp-agent MỚI) — đánh thức banner/toast trong-app
 *       BẤT KỂ đang xem phòng nào (khác broadcastToRoom() chỉ tới người ĐANG xem đúng phòng đó).
 *   (b) `sendPushToAgent()` (FCM) — LUÔN gửi cho MỌI người nhận (cụm #21, 6/8 — Admin Demo báo bug thật).
 *       GỐC BUG (A) đa-thiết-bị mất push: gate CŨ `!agentHasOpenConnection` suppress TOÀN CỤC theo AGENT —
 *       `agentHasOpenConnection` true nếu CÓ WS trên BẤT KỲ thiết bị (vd PC đang mở) → BỎ push cho TẤT CẢ →
 *       điện thoại (nền/khóa, KHÔNG WS) KHÔNG nhận. Nguyên tắc đúng: mỗi THIẾT BỊ tự quyết hiển thị — server
 *       LUÔN gửi FCM (tới mọi token/thiết bị), thiết bị đang FOREGROUND (đã thấy tin qua WS in-app) tự SUPPRESS
 *       notification phía native (SigMaMessagingService.java, cờ AppForeground) để tránh double-notify.
 *       GỐC BUG (B) delay/khóa-màn mất: thêm `priority:'high'` → FCM high-priority vượt Doze/App-Standby, giao
 *       ngay cả khi khóa màn (dataOnly thường bị trì hoãn/rớt trong Doze).
 * Best-effort TUYỆT ĐỐI — broadcastToAgent()/sendPushToAgent() đều tự KHÔNG BAO GIỜ throw (R198: log rõ ràng
 * KHÔNG nuốt câm), nhưng bọc thêm try/catch NGOÀI CÙNG ở đây vì `getRoomDetail()` (đọc room+members) CÓ THỂ
 * throw (lỗi DB bất ngờ) — lỗi bước này TUYỆT ĐỐI KHÔNG được làm fail response gửi tin chính (route đã ghi tin
 * + broadcast phòng thành công TRƯỚC khi gọi hàm này), chỉ log console.error.
 */
async function notifyRoomMembersOfNewMessage(
  db: ReturnType<typeof getBotDb>,
  roomId: string,
  senderAgentId: number,
  senderName: string,
  message: { id: string; kind: string; body: string | null; metadataJson: string | null; createdAt: Date }
): Promise<void> {
  try {
    const room = await getRoomDetail(db, roomId, senderAgentId);
    const recipients = room.members.filter((m) => m.leftAt === null && m.agentId !== senderAgentId);
    if (recipients.length === 0) return;

    const preview = buildMessagePreviewText(message.kind, message.body, message.metadataJson);
    // Kiểu Zalo: phòng GROUP hiện tên nhóm làm title + "Người gửi: nội dung" làm body; phòng DIRECT hiện thẳng
    // tên người gửi làm title (KHÔNG cần lặp lại tên trong body).
    const title = room.type === 'GROUP' ? room.name ?? 'Nhóm chat' : senderName;
    const body = room.type === 'GROUP' ? `${senderName}: ${preview}` : preview;
    const wsPayload = {
      msg: 'chat-notify',
      roomId,
      messageId: message.id,
      senderAgentId,
      senderName,
      roomType: room.type,
      roomName: room.name,
      preview,
      createdAt: message.createdAt
    };

    await Promise.all(
      recipients.map(async (m) => {
        // ĐỒNG NHẤT SỐ ĐẾM MỌI NỀN (7/8, Admin Demo "exe 3 / apk 2 lệch nhau") — đếm unread của recipient NGAY SAU
        // tin này (server = NGUỒN CHÂN LÝ) rồi đính vào CẢ chat-notify (WS) LẪN FCM push → client SET số theo server
        // thay vì mỗi máy tự +1 optimistic (trôi lệch giữa exe/web/apk). Best-effort: lỗi đọc → null (không chặn
        // gửi tin/thông báo; client fallback +1 như cũ).
        let unreadCount = null;
        try {
          unreadCount = await countUnreadForRoomMember(db, roomId, m);
        } catch (e) {
          console.error(`[routes/chat] đếm unread cho badge thất bại agentId=${m.agentId} room=${roomId} (best-effort):`, e);
        }
        // (a) WS cấp-agent — LUÔN gửi, bất kể agent đó có đang mở app hay không (best-effort, không throw nếu
        // không có kết nối nào — broadcastToAgent() tự bỏ qua im lặng khi Set rỗng). Kèm unreadCount (nếu đếm được).
        broadcastToAgent(m.agentId, unreadCount != null ? { ...wsPayload, unreadCount } : wsPayload);
        // TICK "đã nhận" (việc #25, 6/8 — Admin Demo "đã nhận rồi vẫn treo ✓ vì app đang online") — người nhận
        // ĐANG ONLINE → tin coi như ĐÃ GIAO NGAY: phát delivery-receipt về phòng (người gửi đang xem đổi tick sang
        // 2 tick xám). deliveredAt = mốc tin vừa tạo (client so `sentMs <= peerDeliveredAtMs`).
        //
        // GỐC BUG #25: trước đây gate `agentHasOpenConnection` (CHỈ có WS trực tiếp), NHƯNG chấm online + seed
        // "đã nhận" lúc MỞ phòng (ConversationScreen: `if(peer.online) setPeerDeliveredAtMs(now)`) đọc `peer.online`
        // = `agentPresenceOnline` (WS HOẶC nhịp sống gần đây, xem room-detail route). 2 định nghĩa LỆCH nhau →
        // peer hiện XANH (presence-online: đang trong grace 10s/được FCM-ping giữ, KHÔNG WS trực tiếp) thì tin MỚI
        // gửi KHÔNG bắn delivery-receipt → kẹt ✓ dù "app đang online". ĐỒNG BỘ: gate theo CÙNG `agentPresenceOnline`
        // với chấm online + seed-lúc-mở → online (chấm xanh) ⇒ delivered (✓✓), nhất quán tuyệt đối. Người nhận
        // không WS vẫn nhận tin thật qua FCM (cụm #21 LUÔN gửi) → Java POST /delivered xác nhận lại (idempotent).
        if (agentPresenceOnline(m.agentId)) {
          broadcastDeliveryReceipt(roomId, m.agentId, message.createdAt);
        }
        // MENU HỘI THOẠI (7/8) — "Tắt thông báo" (mute): thành viên đang mute (mutedUntil > now) thì BỎ QUA push
        // FCM (không đẩy chuông/notification nổi màn hình) NHƯNG VẪN broadcastToAgent chat-notify ở trên (badge
        // trong app + số chưa đọc vẫn cập nhật — mute chỉ tắt push/chuông, KHÔNG giấu số chưa đọc). delivery-
        // receipt giữ NGUYÊN (mute không ảnh hưởng tick "đã nhận"). m.mutedUntil từ RoomDetailDto member DTO.
        const isMuted = m.mutedUntil != null && m.mutedUntil.getTime() > Date.now();
        if (isMuted) return;
        // (b) Push FCM — LUÔN gửi (cụm #21, 6/8 — bỏ gate `!agentHasOpenConnection`, xem docstring hàm này về 2
        // gốc bug A/B). dataOnly:true BẮT BUỘC cho tin nhắn chat (data message LUÔN gọi onMessageReceived() bất
        // kể app nền/tắt, cho native tự xây notification + action "Trả lời"). priority:'high' để vượt Doze (khóa
        // màn vẫn giao ngay). Item 12: roomType + avatarAgentId để native tải đúng avatar làm largeIcon. Thiết bị
        // đang foreground tự suppress notification phía native (AppForeground) → không double-notify.
        // APK badge cộng/trừ dồn + push xếp chồng (7/8) — `unreadCount` (đã tính ở đầu handler, dùng chung với WS)
        // cho native setNumber(count) khớp tổng; `senderName`+`messageId` cho native MessagingStyle xếp chồng.
        await sendPushToAgent(db, m.agentId, {
          title,
          body,
          data: {
            roomId,
            kind: 'chat_message',
            roomType: room.type,
            avatarAgentId: String(senderAgentId),
            senderName,
            messageId: message.id,
            ...(unreadCount != null ? { unreadCount: String(unreadCount) } : {})
          },
          dataOnly: true,
          priority: 'high'
        });
      })
    );
  } catch (err) {
    console.error(`[routes/chat] notifyRoomMembersOfNewMessage thất bại (best-effort, KHÔNG chặn gửi tin chính) roomId=${roomId}:`, err);
  }
}

/** Tag @ mention kiểu Zalo (13/8) — sau khi tin nhắn ghi DB + broadcast phòng THÀNH CÔNG, với MỖI agentId được
 * nhắc trong `metadataJson.mentions` (parseMentionAgentIds) → tạo thông báo MENTION (chuông + WS, notifyMention)
 * + FCM push "… đã nhắc bạn trong <phòng>". CHỈ nhắc người ĐANG là thành viên hoạt động của phòng VÀ khác người
 * gửi (validate lại server-side, KHÔNG tin client — chống nhắc người ngoài phòng/tự nhắc mình). Đây là 1 kênh
 * RIÊNG, CHẤP NHẬN người được nhắc nhận CẢ thông báo tin nhắn thường (notifyRoomMembersOfNewMessage) LẪN thông
 * báo MENTION này — mention là loại nổi bật hơn (kiểu Zalo/Slack), 2 thông báo có ý nghĩa khác nhau (1 "có tin
 * mới", 1 "bạn được nhắc trực tiếp"). Best-effort TUYỆT ĐỐI: KHÔNG BAO GIỜ làm fail response gửi tin chính. */
async function notifyMentionsOfNewMessage(
  db: ReturnType<typeof getBotDb>,
  roomId: string,
  senderAgentId: number,
  senderName: string,
  message: { id: string; metadataJson: string | null }
): Promise<void> {
  try {
    const mentionAll = parseMentionAll(message.metadataJson); // @all (Admin Demo 24/8) — nhắc TẤT CẢ thành viên
    const mentionedIds = parseMentionAgentIds(message.metadataJson);
    if (!mentionAll && mentionedIds.length === 0) return;

    const room = await getRoomDetail(db, roomId, senderAgentId);
    // Mention CHỈ có nghĩa trong nhóm (DIRECT 1-1 không cần); bỏ qua nếu vì lý do nào đó là DIRECT.
    if (room.type !== 'GROUP') return;
    const activeMemberIds = new Set(room.members.filter((m) => m.leftAt === null).map((m) => m.agentId));
    const roomLabel = room.name ?? 'nhóm';

    // @all → MỌI thành viên đang trong nhóm (trừ người gửi); tự đúng cả người vào nhóm sau (backend resolve từ
    // membership hiện tại, không phụ thuộc danh sách agentId client gửi). Ngược lại: chỉ những agentId được nhắc.
    const recipients = mentionAll
      ? [...activeMemberIds].filter((id) => id !== senderAgentId)
      : mentionedIds.filter((id) => id !== senderAgentId && activeMemberIds.has(id));
    if (recipients.length === 0) return;

    await Promise.all(
      recipients.map(async (recipientAgentId) => {
        // (1) Chuông IN-APP + WS realtime (best-effort, không throw).
        await notifyMention(db, recipientAgentId, senderAgentId, roomId);
        // (2) FCM push riêng cho mention — title = tên người gửi, body nêu rõ "đã nhắc bạn trong <phòng>".
        // dataOnly + priority:'high' (CÙNG khuôn push tin nhắn — vượt Doze, native tự dựng notification).
        await sendPushToAgent(db, recipientAgentId, {
          title: senderName,
          body: `${senderName} đã nhắc bạn trong ${roomLabel}`,
          data: {
            roomId,
            kind: 'chat_mention',
            messageId: message.id,
            avatarAgentId: String(senderAgentId),
            senderName
          },
          dataOnly: true,
          priority: 'high'
        });
      })
    );
  } catch (err) {
    console.error(`[routes/chat] notifyMentionsOfNewMessage thất bại (best-effort, KHÔNG chặn gửi tin chính) roomId=${roomId}:`, err);
  }
}

const VALID_MESSAGE_KINDS = new Set(['TEXT', 'IMAGE', 'FILE', 'VOICE', 'LOCATION', 'QR']);
// Audit độc lập ĐỢT 2 (29/7, HIGH): thiếu 'OWNER' ở đây khiến OWNER_MUST_TRANSFER_FIRST (chat-room-service.ts
// removeMember) KHÔNG BAO GIỜ gỡ được qua API thật — service kỳ vọng đường thoát là gọi changeMemberRole với
// newRole:'OWNER' (chuyển nhượng), nhưng route chặn giá trị đó ở validate trước khi tới service → OWNER kẹt
// vĩnh viễn trong nhóm có người khác. Đã thêm 'OWNER' — an toàn vì service tự enforce "chỉ OWNER hiện tại mới
// được đặt OWNER mới" (assertOwnerOrAdmin + check requesterRole==='OWNER'), route không cần kiểm thêm gì.
const VALID_MEMBER_ROLES = new Set(['OWNER', 'ADMIN', 'MEMBER']);

/** Map `.code` (business error ném từ service) → HTTP status. Bảng cứng cho các mã ĐÃ BIẾT (đúng brief) +
 * fallback theo TIỀN TỐ/HẬU TỐ tên mã cho mã tương lai service có thể thêm mà route chưa kịp cập nhật — tránh
 * lệch âm thầm thành 400 vô nghĩa cho mọi lỗi "không tìm thấy"/"cấm" mới mà LEAD/Agent A thêm sau brief này. */
const CODE_TO_STATUS: Record<string, number> = {
  NOT_MEMBER: 403,
  CANNOT_MESSAGE: 403,
  FORBIDDEN: 403,
  FORBIDDEN_ROLE: 403,
  ATTACHMENT_NOT_OWNED: 403,
  NOT_ROOM_ADMIN: 403,
  NOT_OWNER: 403,
  // debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" (sendMessage(), chat-message-service.ts).
  ROOM_READ_ONLY: 403,
  // BUG "tài khoản đã xóa vẫn gửi tin" (5/8) — người gửi đã vô hiệu hóa (deletedAt/deletionRequestedAt) → 403.
  ACCOUNT_DEACTIVATED: 403,
  DELETE_WINDOW_EXPIRED: 409,
  EDIT_WINDOW_EXPIRED: 409,
  ALREADY_MEMBER: 409,
  // Audit độc lập 29/7 flag "LAST_OWNER_CANNOT_LEAVE" là dead code (khai trong map nhưng chưa từng ném) —
  // xóa mã đó, thay bằng OWNER_MUST_TRANSFER_FIRST THẬT (chat-room-service.ts removeMember, quyết định Admin Demo
  // 29/7 "phải nhường phó nhóm mới rời đi được").
  OWNER_MUST_TRANSFER_FIRST: 409,
  // "nhóm chat đầy đủ như Zalo" (5/8) — trần thành viên đầy / xung đột duyệt đồng thời → 409; hết yêu cầu chờ → 404.
  ROOM_FULL: 409,
  CONFLICT: 409,
  JOIN_REQUEST_NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  VALIDATION: 400
};

function statusForCode(code: string): number {
  if (CODE_TO_STATUS[code] !== undefined) return CODE_TO_STATUS[code];
  if (code.includes('NOT_FOUND')) return 404;
  if (code === 'NOT_MEMBER' || code.includes('FORBIDDEN') || code.includes('CANNOT') || code.includes('NOT_OWNER') || code.includes('NOT_ADMIN')) return 403;
  if (code.includes('EXPIRED') || code.includes('ALREADY') || code.includes('CONFLICT')) return 409;
  return 400;
}

function isCodedError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'string';
}

/** Bắt lỗi từ 1 lệnh gọi service — lỗi CÓ `.code` (nghiệp vụ, đã lường trước) trả response phù hợp; lỗi
 * KHÔNG có `.code` (bug/crash bất ngờ) RE-THROW để errorHandler tập trung xử lý (KHÔNG nuốt câm, đúng R198). */
function respondServiceError(err: unknown, res: Response): void {
  if (!isCodedError(err)) throw err;
  res.status(statusForCode(err.code)).json({ ok: false, error: err.code, message: err.message || 'Yêu cầu không hợp lệ.' });
}

// ── Phòng chat ────────────────────────────────────────────────────────────────────────────────────────────

// GET /v1/chat/rooms?unreadOnly=true — danh sách phòng của tôi (sắp theo lastMessageAt, xem RoomSummaryDto).
// unreadOnly (Admin Demo chốt 29/7, "lọc tin nhắn chưa đọc như Zalo") — chỉ trả phòng còn tin chưa đọc.
chatRouter.get(
  '/v1/chat/rooms',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      const unreadOnly = req.query.unreadOnly === 'true' || req.query.unreadOnly === '1';
      // hidden=true (7/8) — màn "Trò chuyện đã ẩn" (Cài đặt kiểu Zalo): CHỈ trả phòng ĐÃ ẨN để bỏ ẩn.
      const hiddenOnly = req.query.hidden === 'true' || req.query.hidden === '1';
      const rooms = await listRoomsForAgent(db, req.agent!.id, { unreadOnly, hiddenOnly });
      // Item 13 (6/8, Admin Demo "chat list phải có chấm online đồng nhất group/direct") — đính kèm presence ONLINE
      // cho phòng DIRECT = đối phương online? (agentPresenceOnline = WS sống HOẶC nhịp sống gần đây, chat-realtime-
      // hub.ts — KHÔNG cột DB mới, CÙNG cách route GET /rooms/:roomId đính `online` cho từng thành viên). Read-only,
      // best-effort. GROUP: presence NHÓM chưa được định nghĩa (vd ≥1 thành viên khác online?) — để `online`
      // undefined (client tự ẩn chấm), CHỜ Admin Demo/LEAD chốt ngữ nghĩa trước khi tính (KHÔNG bịa — R_SUPREME).
      const roomsWithPresence = rooms.map((r) =>
        r.type === 'DIRECT' && r.otherAgentId != null
          ? { ...r, online: agentPresenceOnline(r.otherAgentId), lastSeenAt: lastSeenIso(r.otherAgentId) }
          : r
      );
      res.json({ ok: true, data: roomsWithPresence });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// B122 (2/8, audit đối kháng "route tốn tài nguyên đã có rate-limit đủ chưa" — Admin Demo yêu cầu trực tiếp) —
// searchMessages() (chat-search-service.ts) quét tới CANDIDATE_SCAN_LIMIT=3000 tin nhắn GẦN NHẤT rồi lọc JS
// mỗi lần gọi (đắt hơn hẳn 1 SELECT có index thường) — TRƯỚC ĐỢT NÀY hoàn toàn KHÔNG rate-limit, khác các route
// tra cứu khác đã có (`friendLookupLimiter`, routes/me.ts, 20/phút) dù CÙNG rủi ro "gọi lặp lại dồn dập gây
// tải DB". FE có debounce 300ms lúc gõ (ChatListScreen.tsx) nhưng đó là phòng thủ CLIENT — không chặn được
// caller cố ý gọi thẳng API (DevTools/script). Scope theo agentId (CÙNG lý do friendLookupLimiter — nhiều đại
// lý dùng chung NAT không đủ phân biệt qua IP). Ngân sách 30 lần/phút — RỘNG HƠN friendLookupLimiter vì tìm
// kiếm gõ-từng-ký-tự là hành vi bình thường tần suất cao hơn tra cứu 1 mã/email, dù đã debounce phía FE.
const chatSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => String(req.agent?.id ?? 'unknown'),
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều lượt tìm kiếm trong 1 phút, vui lòng thử lại sau.' }
});

// GET /v1/chat/search/messages?q=...&roomId=... — B103: tìm tin nhắn THẬT trong các phòng tôi đang là thành
// viên (thay ChatListScreen.tsx tìm trên mock data cũ). q rỗng/thiếu → trả [] (KHÔNG lỗi, để client không
// phải tự chặn). `roomId` (B107, 2/8) tùy chọn — CHỈ tìm trong 1 phòng cụ thể (tìm kiếm trong khung chat, kiểu
// Zalo, có bộ đếm+điều hướng). Có `roomId` → `assertActiveMember` TRƯỚC (403 rõ ràng nếu không phải thành
// viên, KHÁC nhánh không roomId — searchMessages() tự lọc theo membership, không throw).
chatRouter.get(
  '/v1/chat/search/messages',
  asyncHandler(requireSession),
  chatSearchLimiter,
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const roomId = typeof req.query.roomId === 'string' && req.query.roomId ? req.query.roomId : undefined;
    const db = getBotDb();
    try {
      if (roomId) await assertActiveMember(db, roomId, req.agent!.id);
      const hits = await searchMessages(db, req.agent!.id, q, roomId);
      res.json({ ok: true, data: hits });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/direct — {targetAgentId} → lấy phòng DIRECT sẵn có hoặc tạo mới (service tự chặn nếu
// 2 agent chưa là bạn bè → CANNOT_MESSAGE → 403, xem canMessageAgent() friend-service.ts dùng nội bộ).
chatRouter.post(
  '/v1/chat/rooms/direct',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const targetAgentId = Number(req.body?.targetAgentId);
    if (!Number.isInteger(targetAgentId) || targetAgentId <= 0) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu hoặc sai targetAgentId.' });
      return;
    }
    const db = getBotDb();
    try {
      const room = await findOrCreateDirectRoom(db, req.agent!.id, targetAgentId);
      res.json({ ok: true, data: room });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/group — {name, memberAgentIds:number[]} → tạo nhóm.
chatRouter.post(
  '/v1/chat/rooms/group',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const memberAgentIds: number[] | null = Array.isArray(req.body?.memberAgentIds)
      ? req.body.memberAgentIds.map((v: unknown) => Number(v))
      : null;
    if (!name) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu tên nhóm.' });
      return;
    }
    if (!memberAgentIds || memberAgentIds.some((id: number) => !Number.isInteger(id) || id <= 0)) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu hoặc sai danh sách thành viên (memberAgentIds).' });
      return;
    }
    const db = getBotDb();
    try {
      const room = await createGroupRoom(db, req.agent!.id, name, memberAgentIds);
      res.status(201).json({ ok: true, data: room });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// GET /v1/chat/rooms/:roomId — chi tiết phòng (bao gồm thành viên, xem RoomDetailDto) — service tự chặn
// requester không phải thành viên (NOT_MEMBER → 403).
chatRouter.get(
  '/v1/chat/rooms/:roomId',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      const detail = await getRoomDetail(db, req.params.roomId, req.agent!.id);
      // TICK "đã nhận" (6/8, Admin Demo) — đính kèm `online` (agentPresenceOnline) cho TỪNG thành viên: người GỬI
      // mở phòng biết đối phương ĐANG online chưa để hiện "đã nhận" (2 tick xám) NGAY lúc mở, không phải đợi 1 sự
      // kiện delivery-receipt realtime (chỉ tới khi peer VỪA connect/tin VỪA gửi). Presence THẬT (WS sống HOẶC
      // nhịp sống gần đây, chat-realtime-hub.ts), KHÔNG bịa. Additive — client cũ bỏ qua field mới an toàn.
      const membersWithPresence = detail.members.map((m) => ({ ...m, online: agentPresenceOnline(m.agentId), lastSeenAt: lastSeenIso(m.agentId) }));
      res.json({ ok: true, data: { ...detail, members: membersWithPresence } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// PATCH /v1/chat/rooms/:roomId — {name?, avatarColor?, avatarUrl?} → đổi cài đặt nhóm (tên/đại diện). Admin Demo
// chốt 29/7 "chỉ trưởng nhóm, phó nhóm mới có quyền... thao tác cài đặt nhóm như Zalo" — CHỈ OWNER/ADMIN
// (updateGroupSettings tự gọi assertOwnerOrAdmin), CHỈ áp dụng phòng GROUP.
chatRouter.patch(
  '/v1/chat/rooms/:roomId',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const input: { name?: string; avatarColor?: string | null; avatarUrl?: string | null; readOnly?: boolean; requireApproval?: boolean; maxMembers?: number | null } = {};
    if (typeof body.name === 'string') input.name = body.name;
    if (body.avatarColor === null || typeof body.avatarColor === 'string') input.avatarColor = body.avatarColor;
    if (body.avatarUrl === null || typeof body.avatarUrl === 'string') input.avatarUrl = body.avatarUrl;
    // debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" (readOnly, xem comment
    // updateGroupSettings() chat-room-service.ts — hàm đó tự gate assertOwnerOrAdmin(), route không cần kiểm
    // thêm gì). Chỉ nhận boolean thật (không ép kiểu từ truthy string) — tránh client gửi nhầm giá trị mơ hồ.
    if (typeof body.readOnly === 'boolean') input.readOnly = body.readOnly;
    // "nhóm chat đầy đủ như Zalo" (5/8) — DUYỆT thành viên (requireApproval) + GIỚI HẠN số thành viên
    // (maxMembers: số nguyên dương, hoặc null để bỏ giới hạn). Service tự gate OWNER/ADMIN + validate.
    if (typeof body.requireApproval === 'boolean') input.requireApproval = body.requireApproval;
    if (body.maxMembers === null || typeof body.maxMembers === 'number') input.maxMembers = body.maxMembers;
    const db = getBotDb();
    try {
      const room = await updateGroupSettings(db, req.params.roomId, req.agent!.id, input);
      broadcastRoomUpdated(room.id, room);
      res.json({ ok: true, data: room });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/dissolve — GIẢI TÁN nhóm (CHỈ trưởng nhóm/OWNER — service tự gate). Xóa mềm
// phòng + phát room-dissolved để client mọi máy đang mở phòng tự rời về danh sách. Dùng path riêng .../dissolve
// (KHÔNG DELETE .../rooms/:roomId trần, KHÔNG đụng POST .../remove là "xóa hội thoại phía mình" của từng agent).
chatRouter.post(
  '/v1/chat/rooms/:roomId/dissolve',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      await dissolveRoom(db, req.params.roomId, req.agent!.id);
      broadcastRoomDissolved(req.params.roomId);
      res.json({ ok: true, data: { roomId: req.params.roomId } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// ── Tin nhắn ──────────────────────────────────────────────────────────────────────────────────────────────

// GET /v1/chat/rooms/:roomId/messages?before=&limit= — phân trang lùi (before = id tin nhắn cũ hơn).
chatRouter.get(
  '/v1/chat/rooms/:roomId/messages',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const db = getBotDb();
    try {
      const result = await listMessages(db, req.params.roomId, req.agent!.id, { before, limit });
      res.json({ ok: true, data: result });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// GET /v1/chat/rooms/:roomId/messages/reactions?messageIds=id1,id2,... — debt-chat-gaps (31/7, Việc 1) —
// khôi phục lịch sử reaction khi FE tải lại lịch sử tin nhắn (route `GET .../messages` KHÔNG kèm sẵn reactions
// — tách route riêng để KHÔNG đổi shape response đang chạy production, xem comment listReactionsForMessages()
// chat-reaction-service.ts). `assertActiveMember` TRƯỚC (chặn agent ngoài phòng dò reaction phòng khác), rồi
// LỌC `messageIds` client gửi lên chỉ giữ những id THẬT SỰ thuộc `roomId` này (CÙNG nguyên tắc chống rò rỉ
// cross-room đã áp cho cursor `before` ở listMessages() — client không tự "mượn" id tin nhắn phòng khác để dò
// xem ai đã react tin đó) TRƯỚC khi gọi service.
chatRouter.get(
  '/v1/chat/rooms/:roomId/messages/reactions',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.messageIds === 'string' ? req.query.messageIds : '';
    // Giới hạn hợp lý (client chỉ cần gọi cho 1 trang lịch sử vừa tải, mặc định ≤100 tin — MAX_LIST_LIMIT ở
    // listMessages()) — chặn 1 request cố tình nhồi hàng nghìn id vô nghĩa.
    const messageIds = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 200);
    const db = getBotDb();
    try {
      await assertActiveMember(db, req.params.roomId, req.agent!.id);
      let validIds: string[] = [];
      if (messageIds.length > 0) {
        const owned = await db.chatMessage.findMany({ where: { id: { in: messageIds }, roomId: req.params.roomId }, select: { id: true } });
        validIds = owned.map((m) => m.id);
      }
      const map = await listReactionsForMessages(db, validIds);
      res.json({ ok: true, data: Object.fromEntries(map) });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// GET /v1/chat/rooms/:roomId/attachments — debt-chat-gaps (31/7, Việc 3) — tab "File" GroupInfoPanel.tsx (đang
// ẨN, xem comment đầu file đó). Danh sách attachment đã gửi trong phòng (service tự chặn requester không phải
// thành viên → NOT_MEMBER 403, xem listRoomAttachments() chat-message-service.ts).
chatRouter.get(
  '/v1/chat/rooms/:roomId/attachments',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    // FIX-PERF (4/8) — phân trang cursor (before = id tin cũ hơn), CÙNG khuôn GET .../messages ở trên.
    const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    try {
      const result = await listRoomAttachments(db, req.params.roomId, req.agent!.id, { before, limit });
      res.json({ ok: true, data: result });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/messages — gửi tin nhắn mới (service tự kiểm requester đang là thành viên
// ACTIVE của phòng → NOT_MEMBER 403 nếu đã rời/chưa từng tham gia).
chatRouter.post(
  '/v1/chat/rooms/:roomId/messages',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const kind = typeof req.body?.kind === 'string' && req.body.kind ? req.body.kind : 'TEXT';
    if (!VALID_MESSAGE_KINDS.has(kind)) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: `Loại tin nhắn không hợp lệ: ${kind}.` });
      return;
    }
    const body = typeof req.body?.body === 'string' ? req.body.body : undefined;
    const attachmentId = typeof req.body?.attachmentId === 'string' ? req.body.attachmentId : undefined;
    const metadataJson = typeof req.body?.metadataJson === 'string' ? req.body.metadataJson : undefined;
    const replyToMessageId = typeof req.body?.replyToMessageId === 'string' ? req.body.replyToMessageId : undefined;
    if (kind === 'TEXT' && !body?.trim()) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Tin nhắn TEXT không được để trống.' });
      return;
    }
    const db = getBotDb();
    try {
      const message = await sendMessage(db, {
        roomId: req.params.roomId,
        senderId: req.agent!.id,
        kind: kind as 'TEXT' | 'IMAGE' | 'FILE' | 'VOICE' | 'LOCATION' | 'QR',
        body,
        attachmentId,
        metadataJson,
        replyToMessageId
      });
      broadcastNewMessage(req.params.roomId, message);
      // B115-tiếp (2/8) — case #2/#3/#4 (banner trong-app khi không đúng phòng + push khi app nền/khóa máy).
      // Await TRƯỚC res.json() (CÙNG mức "await trực tiếp" call-signaling-server.ts dùng cho sendPushToAgent) —
      // cả 2 hàm bên trong đều best-effort KHÔNG BAO GIỜ throw, độ trễ thêm không đáng kể (chủ yếu 1-2 query DB
      // đọc thành viên phòng), đổi lại hành vi DỄ TEST/DỰ ĐOÁN hơn hẳn so với "bắn nền không đợi".
      await notifyRoomMembersOfNewMessage(db, req.params.roomId, req.agent!.id, req.agent!.name, message);
      // Tag @ mention kiểu Zalo (13/8) — thông báo MENTION riêng cho người được nhắc (@) trong nhóm (best-effort,
      // KHÔNG chặn gửi tin chính, tự validate là thành viên phòng + khác người gửi). Xem notifyMentionsOfNewMessage.
      await notifyMentionsOfNewMessage(db, req.params.roomId, req.agent!.id, req.agent!.name, message);
      // TỰ ĐẨY BILL SANG NHÓM NĐT (Admin Demo) — nếu tin là ẢNH BILL của 1 TID đang uỷ cho Nhà đầu tư, bot SigMa
      // tự đăng lại ảnh + tóm tắt OCR vào nhóm chat NĐT. BEST-EFFORT: crossPostBillToInvestor() KHÔNG BAO GIỜ
      // throw (tự log + nuốt bên trong, R198) — fire-and-forget, KHÔNG chặn/không làm chậm response gửi tin
      // chính của đại lý (khác notify ở trên đợi vì cần badge chính xác; đẩy bill có thể copy file/gửi tin nên
      // để chạy nền). `.catch` bọc thêm 1 lớp phòng thủ dù hàm đã tự bắt hết.
      void crossPostBillToInvestor(db, message).catch((err) => {
        console.error('[routes/chat] crossPostBillToInvestor lỗi ngoài dự kiến (best-effort):', err);
      });
      res.status(201).json({ ok: true, data: message });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// DELETE /v1/chat/messages/:id — thu hồi tin nhắn (service tự tra roomId của message + enforce cửa sổ 48h +
// quyền: FORBIDDEN nếu không phải người gửi/không đủ quyền phòng, DELETE_WINDOW_EXPIRED nếu quá 48h).
chatRouter.delete(
  '/v1/chat/messages/:id',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      // deleteMessage() trả undefined khi tin nhắn ĐÃ bị xóa từ trước (nhánh idempotent, xem comment hàm đó) —
      // KHÔNG có gì mới để broadcast trong trường hợp đó (mọi subscriber đã nhận sự kiện xóa từ lần gọi trước).
      const deleted = await deleteMessage(db, req.params.id, req.agent!.id);
      if (deleted) broadcastMessageDeleted(deleted.roomId, deleted.id, deleted.deletedAt);
      res.json({ ok: true, data: { id: req.params.id } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// PATCH /v1/chat/messages/:id — {body, attachmentId?, metadataJson?} — sửa nội dung tin nhắn của chính mình.
// B112 (2/8) — {attachmentId, metadataJson} optional, CHỈ có ý nghĩa cho "Sửa bill đã gửi" (editMessage() tự
// validate kind IMAGE + isBillImage + ownership attachment mới, xem chat-message-service.ts). 2 field này PHẢI
// đi kèm nhau — chặn hình dạng input NỬA VỜI ngay ở route (rẻ hơn để service tự đoán "thiếu 1 trong 2 là cố ý
// hay bug client"), body VẪN bắt buộc (caption mới, dùng chung path validate cũ bên dưới).
chatRouter.patch(
  '/v1/chat/messages/:id',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const newBody = typeof req.body?.body === 'string' ? req.body.body : '';
    if (!newBody.trim()) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Nội dung tin nhắn không được để trống.' });
      return;
    }
    const newAttachmentId = typeof req.body?.attachmentId === 'string' && req.body.attachmentId ? req.body.attachmentId : undefined;
    const newMetadataJson = typeof req.body?.metadataJson === 'string' && req.body.metadataJson ? req.body.metadataJson : undefined;
    if ((newAttachmentId != null) !== (newMetadataJson != null)) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'attachmentId và metadataJson phải đi kèm nhau.' });
      return;
    }
    const db = getBotDb();
    try {
      const message = await editMessage(
        db,
        req.params.id,
        req.agent!.id,
        newBody,
        newAttachmentId && newMetadataJson ? { newAttachmentId, newMetadataJson } : undefined
      );
      broadcastMessageEdited(message.roomId, message);
      res.json({ ok: true, data: message });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// GET /v1/chat/messages/:id/refunds — SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — liệt kê MỌI lần "Hoàn
// tiền" ĐÃ XÁC NHẬN (kind IMAGE, metadataJson.isRefundImage:true) đang trả lời (replyToMessageId) tin nhắn bill
// gốc `:id` — dùng để tính lại TỔNG CỘNG DỒN (Admin Demo: cho phép hoàn tiền nhiều lần cho 1 bill) lúc mở panel
// "Hoàn tiền" MỚI/lúc "Sửa" 1 lần cụ thể. Service tự chặn requester không phải thành viên ĐANG hoạt động của
// phòng chứa tin nhắn gốc → NOT_MEMBER 403 (assertActiveMember, refund-service.ts), tin nhắn gốc không tồn tại
// → MESSAGE_NOT_FOUND 404.
chatRouter.get(
  '/v1/chat/messages/:id/refunds',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      const confirmations = await listRefundConfirmationsForMessage(db, req.agent!.id, req.params.id);
      res.json({ ok: true, data: confirmations });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/read — {messageId} → đánh dấu đã đọc tới tin nhắn này.
chatRouter.post(
  '/v1/chat/rooms/:roomId/read',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : '';
    if (!messageId) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu messageId.' });
      return;
    }
    const db = getBotDb();
    try {
      const { createdAt } = await markRead(db, req.params.roomId, req.agent!.id, messageId);
      // TICK "đã đọc" (5/8) — phát read-receipt cho phòng NGAY sau ghi (best-effort, broadcastToRoom KHÔNG BAO
      // GIỜ throw — xem chat-realtime-hub.ts) để người gửi đang mở phòng đổi tick tin của họ sang "đã xem".
      broadcastReadReceipt(req.params.roomId, req.agent!.id, messageId, createdAt);
      // ĐỒNG BỘ ĐÃ-ĐỌC ĐA THIẾT BỊ (7/8, Admin Demo "3 máy cùng online, máy nào xem trước thì máy kia clear đỏ") —
      // read-receipt ở trên đi qua broadcastToRoom (CHỈ tới ai đang XEM đúng phòng); máy khác cùng tài khoản đang
      // ở danh sách chat (KHÔNG subscribe phòng này) sẽ không nhận → badge đỏ kẹt tới khi refetch. Phát THÊM
      // room-read-self qua broadcastToAgent (MỌI WS của chính agent này) → mọi máy gọi emitRoomRead(roomId) =
      // đúng luồng clear unread/badge/notification cục bộ sẵn có. Idempotent (máy đã đọc nhận lại = no-op).
      broadcastToAgent(req.agent!.id, { msg: 'room-read-self', roomId: req.params.roomId, messageId });
      // APK ở NỀN (WS ngắt) KHÔNG nhận room-read-self → gửi data-FCM 'room_read' để native XOÁ notification thanh
      // trạng thái + badge của phòng (GỐC "badge đỏ APK kẹt số khi đã đọc ở máy khác", Admin Demo 7/8). dataOnly
      // (im lặng, KHÔNG nổi thông báo mới). Best-effort (sendPushToAgent không throw). Gửi cho MỌI thiết bị của
      // chính agent — máy đã đọc nhận lại = cancel idempotent, vô hại.
      void sendPushToAgent(db, req.agent!.id, { title: '', body: '', data: { kind: 'room_read', roomId: req.params.roomId }, dataOnly: true, priority: 'high' });
      res.json({ ok: true, data: { roomId: req.params.roomId, messageId } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/delivered — TICK "đã nhận" khi APP BỊ KILL (6/8, Admin Demo) — TRƯỚC ĐÂY delivery-
// receipt CHỈ bắn khi người nhận có WS sống (lúc gửi tin) hoặc lúc WS reconnect (chat-realtime-proxy.ts
// broadcastDeliveryOnConnect). App Android ĐÃ TẮT HẲN nhận tin qua FCM data (onMessageReceived vẫn chạy dù app
// kill) → KHÔNG có WS → người GỬI mãi thấy 1 tick ("đã gửi") dù máy nhận ĐÃ nhận thật. Route này để native
// (SigMaMessagingService.java) gọi NGAY khi nhận FCM chat_message → server broadcast delivery-receipt cho
// phòng → người gửi đổi sang ✓✓ "đã nhận". Auth requireSession (cookie phiên WebView + CSRF header, CÙNG cơ chế
// ReplyReceiver.java). assertActiveMember chặn agent ngoài phòng giả mạo "đã nhận". Best-effort: broadcast KHÔNG
// BAO GIỜ throw (chat-realtime-hub.ts); lỗi assert → respondServiceError như các route khác.
chatRouter.post(
  '/v1/chat/rooms/:roomId/delivered',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      await assertActiveMember(db, req.params.roomId, req.agent!.id);
      broadcastDeliveryReceipt(req.params.roomId, req.agent!.id, new Date());
      // "CÓ ĐÃ NHẬN THÌ PHẢI XANH" (Admin Demo 15/8) — thiết bị vừa XÁC NHẬN nhận tin (kể cả app ở NỀN, không WS) =
      // CHẮC CHẮN còn với tới được → đánh dấu ONLINE (markAgentSeen, cùng nguồn nhịp-sống REST TTL 40s như /ping).
      // Nếu TRƯỚC ĐÓ đang offline → broadcast presence-update online để người đang xem thấy chấm XANH ngay. Đây là
      // mảnh ghép cuối để "ở nền vẫn xanh vì có kết nối/có đã nhận" — hoạt động khi push f0c56 sống (APK 0.4.66+).
      const wasOnline = agentPresenceOnline(req.agent!.id);
      markAgentSeen(req.agent!.id);
      if (!wasOnline) void broadcastPresenceUpdate(db, req.agent!.id, true);
      res.json({ ok: true, data: { roomId: req.params.roomId } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/read-all — Admin Demo chốt 29/7 ("tích chọn đã đọc tất cả", giống Zalo) — đánh dấu đã đọc
// MỌI phòng đang tham gia cùng lúc, không cần gọi lặp lại /read cho từng phòng.
chatRouter.post(
  '/v1/chat/rooms/read-all',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    await markAllRead(db, req.agent!.id);
    // ĐỒNG BỘ ĐÃ-ĐỌC ĐA THIẾT BỊ (7/8) — "đọc tất cả" trên 1 máy → mọi máy khác cùng tài khoản clear TOÀN BỘ đỏ
    // NGAY (emitAllRead → xoá sạch unread map + badge + notification). broadcastToAgent = mọi WS của agent này.
    broadcastToAgent(req.agent!.id, { msg: 'all-read-self' });
    // APK ở NỀN → data-FCM 'all_read' để native cancelAll notification + xoá lịch sử (đồng bộ "đọc tất cả").
    void sendPushToAgent(db, req.agent!.id, { title: '', body: '', data: { kind: 'all_read' }, dataOnly: true, priority: 'high' });
    res.json({ ok: true, data: null });
  })
);

// ── MENU HỘI THOẠI (nhấn giữ 1 dòng danh sách chat, kiểu Zalo — 7/8) ───────────────────────────────────────
// Hành động CẤP-HỘI-THOẠI PER-AGENT — thao tác CHỈ trên hàng membership của CHÍNH agent (service tự
// assertActiveMember → NOT_MEMBER 403). Tất cả trả {ok:true, data:...}.

// POST /v1/chat/rooms/:roomId/mute — {muted:boolean} → tắt/bật thông báo (mutedUntil = muted ? '2099-01-01' : null).
chatRouter.post(
  '/v1/chat/rooms/:roomId/mute',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    if (typeof req.body?.muted !== 'boolean') {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu hoặc sai muted (boolean).' });
      return;
    }
    const db = getBotDb();
    try {
      await setRoomMuted(db, req.params.roomId, req.agent!.id, req.body.muted);
      res.json({ ok: true, data: { roomId: req.params.roomId, muted: req.body.muted } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/pin-conversation — {pinned:boolean} → ghim/bỏ ghim HỘI THOẠI lên đầu danh sách
// (pinnedAt = pinned ? now() : null). KHÁC /pin (ghim TIN trong phòng) — đừng nhầm 2 route.
chatRouter.post(
  '/v1/chat/rooms/:roomId/pin-conversation',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    if (typeof req.body?.pinned !== 'boolean') {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu hoặc sai pinned (boolean).' });
      return;
    }
    const db = getBotDb();
    try {
      await setConversationPinned(db, req.params.roomId, req.agent!.id, req.body.pinned);
      res.json({ ok: true, data: { roomId: req.params.roomId, pinned: req.body.pinned } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/mark-unread — đánh dấu CHƯA ĐỌC (lùi lastReadMessageId về tin ngay trước tin mới
// nhất để unreadCount>=1; phòng ≤1 tin → null). Sau đó broadcast 'room-unread-self' cho đa thiết bị đồng bộ.
chatRouter.post(
  '/v1/chat/rooms/:roomId/mark-unread',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      await markRoomUnread(db, req.params.roomId, req.agent!.id);
      // Đồng bộ đa thiết bị (kiểu room-read-self, /read) — mọi WS của chính agent này tự refetch/đánh dấu đỏ lại.
      broadcastToAgent(req.agent!.id, { msg: 'room-unread-self', roomId: req.params.roomId });
      res.json({ ok: true, data: { roomId: req.params.roomId } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/hide — {hidden:boolean} → ẩn/bỏ ẩn hội thoại (hiddenAt = hidden ? now() : null).
// Ẩn KHÔNG tự hiện lại khi có tin mới (khác /remove).
chatRouter.post(
  '/v1/chat/rooms/:roomId/hide',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    if (typeof req.body?.hidden !== 'boolean') {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu hoặc sai hidden (boolean).' });
      return;
    }
    const db = getBotDb();
    try {
      await setRoomHidden(db, req.params.roomId, req.agent!.id, req.body.hidden);
      res.json({ ok: true, data: { roomId: req.params.roomId, hidden: req.body.hidden } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/remove — xóa hội thoại phía mình (removedAt = now(); tin VẪN còn). TỰ hiện lại
// khi phòng có tin mới (clear removedAt ở sendMessage, chat-message-service.ts) — kiểu Zalo.
chatRouter.post(
  '/v1/chat/rooms/:roomId/remove',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      await setRoomRemoved(db, req.params.roomId, req.agent!.id);
      res.json({ ok: true, data: { roomId: req.params.roomId } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/report — {reason?:string} → báo xấu (INSERT chat_reports + ẩn phòng phía mình) +
// (nếu có env SIGMA_ADMIN_REPORT_ROOM_ID) gửi tin hệ thống báo cho kênh admin. Env trống → chỉ lưu record.
chatRouter.post(
  '/v1/chat/rooms/:roomId/report',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const db = getBotDb();
    try {
      const report = await reportRoom(db, req.params.roomId, req.agent!.id, reason);
      // Thông báo kênh admin — BEST-EFFORT (env chưa set / phòng admin không tồn tại KHÔNG được làm hỏng "báo
      // xấu" đã lưu thành công + phòng đã ẩn). Tạo tin hệ thống (senderId null) vào phòng admin + broadcast.
      const adminRoomId = process.env.SIGMA_ADMIN_REPORT_ROOM_ID;
      if (adminRoomId) {
        try {
          const noticeBody = `Báo xấu từ agent ${req.agent!.id} phòng ${req.params.roomId}${report.reason ? `: ${report.reason}` : ''}`;
          const notice = await db.chatMessage.create({ data: { roomId: adminRoomId, senderId: null, kind: 'TEXT', body: noticeBody } });
          await db.chatRoom.update({ where: { id: adminRoomId }, data: { lastMessageAt: new Date() } });
          broadcastNewMessage(adminRoomId, notice);
        } catch (notifyErr) {
          console.error(`[routes/chat] report admin-notify best-effort thất bại (KHÔNG chặn báo xấu) adminRoomId=${adminRoomId}:`, notifyErr);
        }
      }
      res.status(201).json({ ok: true, data: { id: report.id, roomId: report.roomId } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// PUT /v1/chat/rooms/:roomId/pin — {messageId} → ghim. DELETE .../pin → bỏ ghim (pinMessage(..., null)).
chatRouter.put(
  '/v1/chat/rooms/:roomId/pin',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : '';
    if (!messageId) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu messageId.' });
      return;
    }
    const db = getBotDb();
    try {
      await pinMessage(db, req.params.roomId, req.agent!.id, messageId);
      // pinMessage() đổi con trỏ ChatRoom.pinnedMessageId + thêm hàng PinnedMessage — broadcast CẢ room-updated
      // (cho con trỏ tương thích cũ) LẪN pins-updated (danh sách "Bảng tin" đầy đủ, GHIM NHIỀU 5/8).
      const room = await getRoomDetail(db, req.params.roomId, req.agent!.id);
      broadcastRoomUpdated(req.params.roomId, room);
      const pins = await listPinnedMessages(db, req.params.roomId, req.agent!.id);
      broadcastPinsUpdated(req.params.roomId, pins);
      res.json({ ok: true, data: { roomId: req.params.roomId, pinnedMessageId: messageId } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// LƯU Ý (29/7): hợp đồng brief ban đầu ghi `pinMessage(db, roomId, requesterAgentId, messageId: string|null)`
// (null = unpin) — Agent A (chat-room-service.ts) implement THÀNH 2 hàm tách riêng thay vì 1 hàm nhận null:
// `pinMessage(db, roomId, requesterAgentId, messageId: string)` (ghim) + `unpinMessage(db, roomId,
// requesterAgentId)` (gỡ ghim, không tham số messageId). Route ở đây bám THEO CODE THẬT của Agent A (đã đọc
// trực tiếp services/chat-room-service.ts), KHÔNG theo brief chữ ký cũ.
chatRouter.delete(
  '/v1/chat/rooms/:roomId/pin',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      await unpinMessage(db, req.params.roomId, req.agent!.id);
      const room = await getRoomDetail(db, req.params.roomId, req.agent!.id);
      broadcastRoomUpdated(req.params.roomId, room);
      const pins = await listPinnedMessages(db, req.params.roomId, req.agent!.id);
      broadcastPinsUpdated(req.params.roomId, pins);
      res.json({ ok: true, data: { roomId: req.params.roomId, pinnedMessageId: null } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// ── GHIM KHÔNG GIỚI HẠN / "Bảng tin" (5/8, Admin Demo nhấn mạnh) — GHIM NHIỀU tin như Zalo ────────────────────────
// GET /v1/chat/rooms/:roomId/pins — danh sách tin đã ghim (kèm nội dung + người ghim + thời gian). Thành viên
// nào trong phòng cũng xem được (service tự chặn NOT_MEMBER 403).
chatRouter.get(
  '/v1/chat/rooms/:roomId/pins',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      const pins = await listPinnedMessages(db, req.params.roomId, req.agent!.id);
      res.json({ ok: true, data: pins });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/pins — {messageId} → ghim thêm 1 tin (OWNER/ADMIN, không giới hạn số lượng).
chatRouter.post(
  '/v1/chat/rooms/:roomId/pins',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : '';
    if (!messageId) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu messageId.' });
      return;
    }
    const db = getBotDb();
    try {
      await pinMessage(db, req.params.roomId, req.agent!.id, messageId);
      const room = await getRoomDetail(db, req.params.roomId, req.agent!.id);
      broadcastRoomUpdated(req.params.roomId, room);
      const pins = await listPinnedMessages(db, req.params.roomId, req.agent!.id);
      broadcastPinsUpdated(req.params.roomId, pins);
      res.status(201).json({ ok: true, data: pins });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// DELETE /v1/chat/rooms/:roomId/pins/:messageId — bỏ ghim ĐÚNG 1 tin khỏi "Bảng tin" (OWNER/ADMIN). Idempotent.
chatRouter.delete(
  '/v1/chat/rooms/:roomId/pins/:messageId',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      await unpinMessage(db, req.params.roomId, req.agent!.id, req.params.messageId);
      const room = await getRoomDetail(db, req.params.roomId, req.agent!.id);
      broadcastRoomUpdated(req.params.roomId, room);
      const pins = await listPinnedMessages(db, req.params.roomId, req.agent!.id);
      broadcastPinsUpdated(req.params.roomId, pins);
      res.json({ ok: true, data: pins });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// ── Cảm xúc (reaction) ────────────────────────────────────────────────────────────────────────────────────

// POST /v1/chat/messages/:id/reactions — {emoji} → thả/thay cảm xúc (toggleReaction tự xử lý "bấm lại đúng
// emoji = bỏ thích", xem comment schema.prisma ChatMessageReaction).
chatRouter.post(
  '/v1/chat/messages/:id/reactions',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji.trim() : '';
    if (!emoji) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu emoji.' });
      return;
    }
    const db = getBotDb();
    try {
      const result = await toggleReaction(db, req.params.id, req.agent!.id, emoji);
      // toggleReaction() (chat-reaction-service.ts, KHÔNG sửa file đó) không trả roomId — tự tra lại đây (route
      // layer) CHỈ để phục vụ broadcast, best-effort: message có thể (hiếm) đã bị xóa GIỮA lúc toggle xong và
      // lúc tra roomId — không tìm thấy thì bỏ qua broadcast (client vẫn nhận đúng response REST bình thường).
      const msg = await db.chatMessage.findUnique({ where: { id: req.params.id }, select: { roomId: true } });
      if (msg) broadcastReactionUpdate(msg.roomId, req.params.id, req.agent!.id, result.action, result.reaction);
      res.json({ ok: true, data: result });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// DELETE /v1/chat/messages/:id/reactions — bỏ cảm xúc của chính mình trên tin nhắn này. Body {emoji} OPTIONAL
// (tự quyết định API shape, ghi rõ ở đây): nếu client gửi kèm emoji thì toggle thẳng bằng giá trị đó (tiết
// kiệm 1 lượt đọc DB, đúng "bấm lại đúng emoji = bỏ thích"); nếu KHÔNG gửi/emoji rỗng, route tự tra reaction
// HIỆN CÓ của requester trên tin nhắn này rồi mới toggle bằng đúng emoji đó — cho phép client gọi DELETE
// "trần" (không cần biết trước mình đã thả emoji gì) mà vẫn xóa đúng. Không có reaction nào → coi là no-op
// thành công (idempotent), KHÔNG lỗi.
chatRouter.delete(
  '/v1/chat/messages/:id/reactions',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    let emoji = typeof req.body?.emoji === 'string' ? req.body.emoji.trim() : '';
    try {
      if (!emoji) {
        const existing = await db.chatMessageReaction.findUnique({
          where: { messageId_agentId: { messageId: req.params.id, agentId: req.agent!.id } }
        });
        if (!existing) {
          res.json({ ok: true, data: { action: 'removed', reaction: null } });
          return;
        }
        emoji = existing.emoji;
      }
      const result = await toggleReaction(db, req.params.id, req.agent!.id, emoji);
      const msg = await db.chatMessage.findUnique({ where: { id: req.params.id }, select: { roomId: true } });
      if (msg) broadcastReactionUpdate(msg.roomId, req.params.id, req.agent!.id, result.action, result.reaction);
      res.json({ ok: true, data: result });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// ── Thành viên phòng ──────────────────────────────────────────────────────────────────────────────────────

// GET /v1/chat/rooms/:roomId/members — KHÔNG có hàm service riêng cho liệt kê (contract không khai listMembers)
// — dùng `assertActiveMember` (đã có sẵn trong hợp đồng, ném NOT_MEMBER nếu requester không thuộc phòng) để
// xác thực quyền xem rồi đọc trực tiếp bảng ChatRoomMember (đọc thuần, không phải nghiệp vụ cần tách lớp).
chatRouter.get(
  '/v1/chat/rooms/:roomId/members',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      await assertActiveMember(db, req.params.roomId, req.agent!.id);
      const members = await db.chatRoomMember.findMany({
        where: { roomId: req.params.roomId, leftAt: null },
        orderBy: { joinedAt: 'asc' }
      });
      // BUG "thành viên nhóm đã xóa vẫn hiện đang hoạt động" (5/8, Admin Demo) — ChatRoomMember KHÔNG có @relation
      // Prisma tới Agent (bolt-on, xem chat-room-service.ts) → join tay: 1 câu findMany theo agentId (KHÔNG lọc
      // deletedAt để soft-delete vẫn ra, isAccountDeactivated tự bắt) rồi gắn cờ `deactivated` + `name` (dùng
      // DEACTIVATED_DISPLAY_NAME khi vô hiệu hóa; agent hard-delete/không tìm thấy → deactivated:true). Additive:
      // GIỮ NGUYÊN mọi field ChatRoomMember cũ, chỉ THÊM `deactivated` + `name`.
      const agentIds = [...new Set(members.map((m) => m.agentId))];
      const agents = agentIds.length > 0 ? await db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, deletedAt: true, deletionRequestedAt: true } }) : [];
      const agentById = new Map(agents.map((a) => [a.id, a]));
      const data = members.map((m) => {
        const agent = agentById.get(m.agentId);
        const deactivated = agent ? isAccountDeactivated(agent) : true;
        return { ...m, deactivated, name: deactivated ? DEACTIVATED_DISPLAY_NAME : (agent?.name ?? DEACTIVATED_DISPLAY_NAME) };
      });
      res.json({ ok: true, data });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/members — {agentId} → thêm thành viên.
chatRouter.post(
  '/v1/chat/rooms/:roomId/members',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const newAgentId = Number(req.body?.agentId);
    if (!Number.isInteger(newAgentId) || newAgentId <= 0) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu hoặc sai agentId.' });
      return;
    }
    const db = getBotDb();
    try {
      await addMember(db, req.params.roomId, req.agent!.id, newAgentId);
      broadcastRoomMemberChanged(req.params.roomId, newAgentId, 'added');
      res.status(201).json({ ok: true, data: { roomId: req.params.roomId, agentId: newAgentId } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// DELETE /v1/chat/rooms/:roomId/members/:agentId — xóa/rời thành viên.
chatRouter.delete(
  '/v1/chat/rooms/:roomId/members/:agentId',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const targetAgentId = Number(req.params.agentId);
    if (!Number.isInteger(targetAgentId) || targetAgentId <= 0) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'agentId không hợp lệ.' });
      return;
    }
    const db = getBotDb();
    try {
      await removeMember(db, req.params.roomId, req.agent!.id, targetAgentId);
      // Broadcast TRƯỚC KHI người bị xóa/tự rời hết là subscriber — vẫn tới được kết nối của chính họ (nếu
      // đang mở phòng, WS đó chưa bị hub tự dọn) để client tự đóng màn hình/điều hướng ra danh sách phòng.
      broadcastRoomMemberChanged(req.params.roomId, targetAgentId, 'removed');
      res.json({ ok: true, data: { roomId: req.params.roomId, agentId: targetAgentId } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// PATCH /v1/chat/rooms/:roomId/members/:agentId — {role: 'ADMIN'|'MEMBER'} → đổi vai trò.
chatRouter.patch(
  '/v1/chat/rooms/:roomId/members/:agentId',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const targetAgentId = Number(req.params.agentId);
    const role = typeof req.body?.role === 'string' ? req.body.role : '';
    if (!Number.isInteger(targetAgentId) || targetAgentId <= 0) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'agentId không hợp lệ.' });
      return;
    }
    if (!VALID_MEMBER_ROLES.has(role)) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: "role phải là 'OWNER', 'ADMIN' hoặc 'MEMBER'." });
      return;
    }
    const db = getBotDb();
    try {
      await changeMemberRole(db, req.params.roomId, req.agent!.id, targetAgentId, role as 'OWNER' | 'ADMIN' | 'MEMBER');
      broadcastRoomMemberChanged(req.params.roomId, targetAgentId, 'role-changed', role);
      res.json({ ok: true, data: { roomId: req.params.roomId, agentId: targetAgentId, role } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// ── DUYỆT THÀNH VIÊN (5/8) — ChatRoomJoinRequest ──────────────────────────────────────────────────────────

// POST /v1/chat/rooms/:roomId/join — xin vào nhóm. requireApproval=false → vào thẳng (201, data.status='JOINED');
// requireApproval=true → tạo yêu cầu chờ duyệt (202, data.status='PENDING'). Service tự chặn phòng không tồn
// tại/không phải GROUP/đã là thành viên.
chatRouter.post(
  '/v1/chat/rooms/:roomId/join',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      const result = await requestJoin(db, req.params.roomId, req.agent!.id);
      if (result.status === 'JOINED') {
        broadcastRoomMemberChanged(req.params.roomId, req.agent!.id, 'added');
        res.status(201).json({ ok: true, data: result });
      } else {
        // Báo cho thành viên đang xem phòng (OWNER/ADMIN) biết có yêu cầu mới cần duyệt.
        broadcastToRoom(req.params.roomId, { msg: 'join-request-new', roomId: req.params.roomId, agentId: req.agent!.id });
        res.status(202).json({ ok: true, data: result });
      }
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// GET /v1/chat/rooms/:roomId/join-requests — danh sách yêu cầu ĐANG chờ (OWNER/ADMIN).
chatRouter.get(
  '/v1/chat/rooms/:roomId/join-requests',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      const pending = await listPendingJoinRequests(db, req.params.roomId, req.agent!.id);
      res.json({ ok: true, data: pending });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/join-requests/:agentId/approve — duyệt (OWNER/ADMIN) → tạo thành viên.
chatRouter.post(
  '/v1/chat/rooms/:roomId/join-requests/:agentId/approve',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const targetAgentId = Number(req.params.agentId);
    if (!Number.isInteger(targetAgentId) || targetAgentId <= 0) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'agentId không hợp lệ.' });
      return;
    }
    const db = getBotDb();
    try {
      const member = await approveJoin(db, req.params.roomId, req.agent!.id, targetAgentId);
      broadcastRoomMemberChanged(req.params.roomId, targetAgentId, 'added');
      res.json({ ok: true, data: member });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// POST /v1/chat/rooms/:roomId/join-requests/:agentId/reject — từ chối (OWNER/ADMIN).
chatRouter.post(
  '/v1/chat/rooms/:roomId/join-requests/:agentId/reject',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const targetAgentId = Number(req.params.agentId);
    if (!Number.isInteger(targetAgentId) || targetAgentId <= 0) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'agentId không hợp lệ.' });
      return;
    }
    const db = getBotDb();
    try {
      await rejectJoin(db, req.params.roomId, req.agent!.id, targetAgentId);
      res.json({ ok: true, data: { roomId: req.params.roomId, agentId: targetAgentId, status: 'REJECTED' } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// ── AVATAR NHÓM (5/8) — upload/đọc ảnh đại diện nhóm (TÁI DÙNG parseSingleFileUpload + magic-bytes) ───────────

// POST /v1/chat/rooms/:roomId/avatar — multipart field "file". OWNER/ADMIN, chỉ phòng GROUP (service enforce).
chatRouter.post(
  '/v1/chat/rooms/:roomId/avatar',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const parsed = await parseSingleFileUpload(req);
    if (!parsed.ok) {
      if (parsed.reason === 'TOO_LARGE') {
        res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE', message: `Ảnh vượt quá giới hạn ${MAX_ROOM_AVATAR_SIZE_BYTES / (1024 * 1024)}MB.` });
        return;
      }
      res.status(400).json({ ok: false, error: 'NO_FILE', message: 'Thiếu ảnh trong yêu cầu.' });
      return;
    }
    const db = getBotDb();
    try {
      const r = await saveRoomAvatar(db, req.params.roomId, req.agent!.id, parsed.buffer);
      if (!r.ok) {
        if (r.reason === 'FILE_TOO_LARGE') {
          res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE', message: `Ảnh vượt quá giới hạn ${MAX_ROOM_AVATAR_SIZE_BYTES / (1024 * 1024)}MB.` });
          return;
        }
        if (r.reason === 'EMPTY_FILE') {
          res.status(400).json({ ok: false, error: 'EMPTY_FILE', message: 'Ảnh rỗng, vui lòng chọn ảnh khác.' });
          return;
        }
        res.status(400).json({ ok: false, error: 'MIME_NOT_ALLOWED', message: 'Ảnh không đúng định dạng jpeg/png/webp — vui lòng chọn ảnh khác.' });
        return;
      }
      // Ảnh đổi → broadcast room-updated (avatarUrl mới) cho mọi người đang xem phòng.
      const room = await getRoomDetail(db, req.params.roomId, req.agent!.id);
      broadcastRoomUpdated(req.params.roomId, room);
      res.json({ ok: true, data: { roomId: req.params.roomId, avatarUrl: room.avatarUrl } });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// GET /v1/chat/rooms/:roomId/avatar — ảnh đại diện nhóm (thành viên đang hoạt động xem được). 404 nếu chưa đặt.
chatRouter.get(
  '/v1/chat/rooms/:roomId/avatar',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      const media = await getRoomAvatar(db, req.params.roomId, req.agent!.id);
      if (!media) {
        // Nhóm CHƯA đặt ảnh → PNG fallback (màu theo roomId + chữ cái đầu tên nhóm, KHỚP web avatarColorForKey)
        // THAY VÌ 404 → Android largeIcon/popup EXE hiển thị CÙNG avatar như web (Admin Demo 8/8). getRoomAvatar đã
        // assertActiveMember ở trên nên requester chắc chắn là thành viên; getRoomFallbackInfo chỉ lấy tên/loại.
        const info = await getRoomFallbackInfo(db, req.params.roomId);
        if (!info) {
          res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy phòng.' });
          return;
        }
        const png = await renderFallbackAvatarPng(req.params.roomId, null, info.name ?? 'Nhóm chat');
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(png);
        return;
      }
      res.setHeader('Content-Type', media.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      res.send(media.buffer);
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// ── Doanh số theo nhóm chat (1/8) — liên kết TID↔phòng (gán tay, xem chat-room-tid-service.ts) + tổng hợp
// doanh số. Router RIÊNG các route con dưới `/v1/chat/rooms/:roomId/tids*` — CÙNG router `chatRouter` (không
// tạo router mới, tránh thêm 1 chỗ mount app.ts).

// GET /v1/chat/rooms/:roomId/tids — TID đã gắn phòng (đòi requester là thành viên đang hoạt động).
chatRouter.get(
  '/v1/chat/rooms/:roomId/tids',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    try {
      const tids = await listRoomTids(db, req.agent!.id, req.params.roomId);
      res.json({ ok: true, data: tids });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// GỠ (21/8): POST/DELETE /v1/chat/rooms/:roomId/tids (gắn/gỡ TID tay) — Admin Demo "khách không tự thêm TID" +
// doanh số nay suy TỪ KHÁCH (customer_chat_groups), KHÔNG dùng chat_room_tids. 2 route đó gate tid.agentId (LUÔN
// null prod) nên vô dụng. TID↔khách do admin quản trên desktop.

// POST /v1/chat/rooms-revenue-kpi — [Admin Demo 10/9] KPI 1 dòng/nhóm cho màn "Doanh số theo nhóm" (đại lý + NĐT):
// hôm nay / hôm qua / trước phí / sau phí / cần hoàn / đã hoàn / thừa-thiếu / đã ứng / đã hoàn ứng.
// Dùng POST vì danh sách roomId có thể dài (client gửi ĐÚNG các phòng đang hiện). Quyền: mỗi phòng vẫn qua
// getRoomRevenueReport (tự ném lỗi nếu người gọi không thuộc phòng) → không lộ số nhóm mình không ở trong.
chatRouter.post(
  '/v1/chat/rooms-revenue-kpi',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { roomIds?: unknown; from?: unknown; to?: unknown };
    const ids = Array.isArray(body.roomIds) ? body.roomIds.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
    if (ids.length === 0) { res.json({ ok: true, data: [] }); return; }
    if (ids.length > 200) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Quá nhiều phòng trong 1 lượt (tối đa 200).' }); return; }
    // [Admin Demo 11/9] Chọn CHU KỲ ở đầu màn (hôm nay/hôm qua/tuần/tháng/30 ngày) → client gửi khoảng thời gian,
    // KHÔNG còn cứng "hôm nay". Thiếu/sai → về mặc định hôm nay (server tự dựng biên, không tin mù client).
    const doc = (v: unknown): Date | null => { if (typeof v !== 'string' || !v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
    const from = doc(body.from), to = doc(body.to);
    const db = getBotDb();
    const data = await buildRoomsRevenueKpi(db, req.agent!.id, ids, new Date(), 4, from && to && from < to ? { from, to } : undefined);
    res.json({ ok: true, data });
  })
);

// GET /v1/chat/rooms/:roomId/revenue?from=&to=&tidId= — báo cáo doanh số (mặc định 7 ngày gần nhất [now-7d,
// now) nếu thiếu from/to — CÙNG bound nửa-mở routes/kpi.ts, KHÁC mặc định 30 ngày ở đó vì báo cáo theo NHÓM
// thường xem theo tuần/ngày gần, không cần mặc định dài).
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
chatRouter.get(
  '/v1/chat/rooms/:roomId/revenue',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const toRaw = req.query.to;
    const fromRaw = req.query.from;
    const tidIdRaw = req.query.tidId;

    let to: Date;
    if (typeof toRaw === 'string' && toRaw.length > 0) {
      const parsed = new Date(toRaw);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ ok: false, error: 'VALIDATION', message: 'to phải là thời điểm ISO hợp lệ.' });
        return;
      }
      to = parsed;
    } else {
      to = new Date();
    }
    let from: Date;
    if (typeof fromRaw === 'string' && fromRaw.length > 0) {
      const parsed = new Date(fromRaw);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ ok: false, error: 'VALIDATION', message: 'from phải là thời điểm ISO hợp lệ.' });
        return;
      }
      from = parsed;
    } else {
      from = new Date(to.getTime() - SEVEN_DAYS_MS);
    }
    let tidId: number | undefined;
    if (typeof tidIdRaw === 'string' && tidIdRaw.length > 0) {
      tidId = Number(tidIdRaw);
      if (!Number.isInteger(tidId) || tidId <= 0) {
        res.status(400).json({ ok: false, error: 'VALIDATION', message: 'tidId không hợp lệ.' });
        return;
      }
    }

    const db = getBotDb();
    try {
      const report = await getRoomRevenueReport(db, req.agent!.id, req.params.roomId, { from, to, tidId });
      // Admin Demo 27/8: mở nhóm NĐT → "Doanh số" phải hiện doanh số NHÀ ĐẦU TƯ (không phải "chưa có TID"). Nhúng thêm
      // `investor` nếu phòng là nhóm NĐT + người gọi ở trong nhóm. Best-effort (lỗi không chặn báo cáo nhóm).
      let investor;
      try { investor = await roomInvestorRevenue(db, req.agent!.id, req.params.roomId, from, to); } catch { investor = undefined; }
      res.json({ ok: true, data: investor ? { ...report, investor } : report });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// SỬA THẺ đã ghi (Admin Demo 31/8 "chưa có nút sửa biểu phí chọn lại thẻ khi chọn nhầm và gửi vào nhóm rồi") —
// authorize theo PHẠM VI phòng: lô phải thuộc 1 TID gắn phòng người gọi đang xem (listRoomTids đã scope + ném lỗi
// nếu không có quyền). GET liệt kê thẻ + phí, POST áp sửa (đồng bộ đại lý + NĐT + SigMa).
/** Xuất riêng cho test khoá luật quyền-sửa-lô-mượn (bridge sang hàm nội bộ, không đổi hành vi). */
export const assertLoTidInRoomForTest = (db: ReturnType<typeof getBotDb>, agentId: number, roomId: string, loId: number): Promise<boolean> => assertLoTidInRoom(db, agentId, roomId, loId);
async function assertLoTidInRoom(db: ReturnType<typeof getBotDb>, agentId: number, roomId: string, loId: number): Promise<boolean> {
  const row = await db.loRow.findFirst({ where: { loId }, orderBy: { id: 'asc' }, select: { tidId: true } });
  if (!row) return false;
  const tids = await listRoomTids(db, agentId, roomId); // ném lỗi nếu người gọi không có quyền xem phòng
  if (tids.some((t) => t.tidId === row.tidId)) return true;            // ca thường: TID gắn đúng phòng đang mở
  // [Admin Demo 25/9 "TID Chí Đức BM-9 mượn của nhà Thiện, đang nằm ở nhà Tuyên, sao không cho sửa?"]
  // LÔ MƯỢN nằm ở phòng NGƯỜI MƯỢN, còn TID thuộc CHỦ MÁY ⇒ luật cũ (chỉ so TID↔phòng) CHẶN OAN, báo
  // "Lô không thuộc phạm vi doanh số phòng này". Ca thật: TID DEMO-TID-01 gắn "ĐL - Trường Thiện SG" nhưng lô
  // mượn nằm ở "ĐL - Tuyên SG" / "ĐL- Mss. Oanh SG" → nhà mượn thấy doanh số mà KHÔNG sửa được thẻ.
  // Nới ĐÚNG một cửa: lô ĐANG được MƯỢN bởi CHÍNH khách của phòng này. Quyền xem phòng vẫn do listRoomTids
  // ở trên gác (nó ném lỗi nếu người gọi không được vào phòng) ⇒ không nới lỏng bảo mật.
  const muon = await db.$queryRawUnsafe<Array<{ borrowed_by_customer_id: number | null }>>(
    `SELECT borrowed_by_customer_id FROM los WHERE id = $1`, loId);
  const khachMuon = muon[0]?.borrowed_by_customer_id ?? null;
  if (khachMuon == null) return false;
  const nhom = await db.customerChatGroup.findFirst({
    where: { roomId, unassignedAt: null }, select: { customerId: true }, orderBy: { assignedFrom: 'desc' }
  });
  return nhom?.customerId === khachMuon;
}

chatRouter.get(
  '/v1/chat/rooms/:roomId/lo/:loId/cards',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const loId = Number(req.params.loId);
    if (!Number.isInteger(loId) || loId <= 0) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'loId không hợp lệ.' }); return; }
    const db = getBotDb();
    try {
      if (!(await assertLoTidInRoom(db, req.agent!.id, req.params.roomId, loId))) {
        res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Lô không thuộc phạm vi doanh số phòng này.' });
        return;
      }
      const r = await listCardOptionsForLo(db, loId);
      if (!r.ok) { res.status(r.error === 'NOT_FOUND' ? 404 : 400).json(r); return; }
      res.json({ ok: true, data: r });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

chatRouter.post(
  '/v1/chat/rooms/:roomId/lo/:loId/correct-card',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const loId = Number(req.params.loId);
    const cardTypeId = Number((req.body as { cardTypeId?: unknown })?.cardTypeId);
    if (!Number.isInteger(loId) || loId <= 0 || !Number.isInteger(cardTypeId) || cardTypeId <= 0) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'loId và cardTypeId phải là số nguyên hợp lệ.' });
      return;
    }
    const db = getBotDb();
    try {
      if (!(await assertLoTidInRoom(db, req.agent!.id, req.params.roomId, loId))) {
        res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Lô không thuộc phạm vi doanh số phòng này.' });
        return;
      }
      const r = await correctLoCardType(db, { loId, cardTypeId, actorUserId: null });
      if (!r.ok) { res.status(r.error === 'NOT_FOUND' ? 404 : 400).json(r); return; }
      // [B307/S1 24/11 — audit R198] `ok:true` mà `bridgeError` có giá trị = GD CŨ ĐÃ HUỶ nhưng GD MỚI
      // KHÔNG ghi được ⇒ doanh số của lô BIẾN MẤT khỏi bảng transactions trong khi màn báo xanh "Đã sửa
      // thẻ — doanh số đã cập nhật" (tái hiện: 20tr rời sổ, toast vẫn xanh). Fail-closed nói thẳng.
      if (r.bridgeError) {
        res.status(409).json({
          ok: false, error: 'DONG_BO_GD_LOI', loId,
          message: 'Đã đổi thẻ của lô #' + loId + ' nhưng GIAO DỊCH MỚI chưa ghi được: ' + r.bridgeError
            + '. Doanh số của bill này đang KHÔNG nằm trong báo cáo — báo kỹ thuật hàn lại, ĐỪNG sửa thêm lần nữa.'
        });
        return;
      }
      res.json({ ok: true, data: r });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// [Admin Demo 7/9] RESOLVE lô → tin-bill gốc để nút "Sửa" báo cáo mở sửa full tham số (như review). CHỈ ĐỌC, gate như
// /cards (assertLoTidInRoom = thành viên phòng + lô thuộc phạm vi). Trả messageId + giá trị hiện tại (prefill modal).
// Sửa thực hiện qua /v1/ocr-send/bill-edit sẵn (password-gated) với messageId này.
chatRouter.get(
  '/v1/chat/rooms/:roomId/lo/:loId/edit-source',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const loId = Number(req.params.loId);
    if (!Number.isInteger(loId) || loId <= 0) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'loId không hợp lệ.' }); return; }
    const db = getBotDb();
    try {
      if (!(await assertLoTidInRoom(db, req.agent!.id, req.params.roomId, loId))) {
        res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Lô không thuộc phạm vi doanh số phòng này.' });
        return;
      }
      const r = await resolveLoEditSource(db, loId);
      if (!r.ok) {
        res.status(404).json({ ok: false, error: r.error, message: r.error === 'NO_BILLKEY' ? 'Lô này không gắn bill đánh-lô → không mở sửa được.' : 'Không tìm được tin bill gốc của lô này (kiểm tay).' });
        return;
      }
      res.json({ ok: true, data: r.data });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);

// ĐỐI SOÁT HOÀN TIỀN ĐẠI LÝ theo ngày (phase-2 hướng-1, Admin Demo 31/8) — cần hoàn (Σ net los) vs đã hoàn (CK). Scope
// như route revenue (listRoomTids ném lỗi nếu không quyền). LƯU Ý: gán ngày CK hiện theo NGÀY BILL — đang chờ tinh
// chỉnh "áp theo SỐ KHỚP + T±1 tolerance" (Admin Demo "ngày transfer không liên quan").
chatRouter.get(
  '/v1/chat/rooms/:roomId/refund-reconcile',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const toRaw = req.query.to, fromRaw = req.query.from;
    const to = typeof toRaw === 'string' && toRaw ? new Date(toRaw) : new Date();
    const from = typeof fromRaw === 'string' && fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'from/to không hợp lệ.' }); return; }
    const db = getBotDb();
    try {
      await listRoomTids(db, req.agent!.id, req.params.roomId); // scope-check (ném lỗi nếu không quyền)
      const data = await buildDealerRefundReconcile(db, req.params.roomId, from, to);
      res.json({ ok: true, data });
    } catch (err) {
      respondServiceError(err, res);
    }
  })
);
