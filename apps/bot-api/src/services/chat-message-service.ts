// SIGMA Phase 2 (29/7) — chat lõi tự xây, gửi/đọc/xóa/sửa tin nhắn (ChatMessage). Xem chat-room-service.ts
// đầu file cho bối cảnh chung (thay Rocket.Chat, model mới tạo cùng migration 20260729100000_chat_core).
import { Prisma, type Db } from '@sigma/database';
import { assertActiveMember, ChatServiceError } from './chat-room-service.js';
import { annotateRefundMetadataOnSave } from '../refund-verify.js';
import { canMessageAgent } from '../friend-service.js';
import { isAccountDeactivated } from '../deletion-service.js';
import { broadcastToRoom } from '../chat-realtime-hub.js';
import { deleteAttachmentAndFile } from '../chat-attachment-service.js';

/** #33 (Admin Demo 8/8 "thông báo cập nhật trong nhóm như Zalo... lịch sử LƯU VĨNH VIỄN") — chèn 1 tin HỆ THỐNG vào
 * nhóm (senderId=null → client render dòng xám giữa, xem chat-client.ts kind SYSTEM) + broadcast realtime. LƯU
 * DB như tin thường nên nằm vĩnh viễn trong lịch sử phòng. Best-effort ở CALLER (không chặn thao tác đã ghi). */
export async function postSystemMessage(db: Db, roomId: string, body: string): Promise<void> {
  const created = await db.$transaction(async (tx) => {
    const m = await tx.chatMessage.create({ data: { roomId, senderId: null, kind: 'SYSTEM', body } });
    await tx.chatRoom.update({ where: { id: roomId }, data: { lastMessageAt: new Date() } });
    // Kiểu Zalo: biến động thành viên làm nhóm "sống lại" cho ai đã xóa hội thoại phía mình (removedAt) — CÙNG
    // hành vi sendMessage. KHÔNG đụng hiddenAt.
    await tx.chatRoomMember.updateMany({ where: { roomId, removedAt: { not: null } }, data: { removedAt: null } });
    return m;
  });
  const message = { ...created, attachmentMimeType: null, attachmentSizeBytes: null };
  broadcastToRoom(roomId, { msg: 'new-message', roomId, message });
}

export type ChatMessageKind = 'TEXT' | 'IMAGE' | 'FILE' | 'VOICE' | 'LOCATION' | 'QR';
const ALLOWED_KINDS: ReadonlySet<string> = new Set(['TEXT', 'IMAGE', 'FILE', 'VOICE', 'LOCATION', 'QR']);

// Audit độc lập 29/7 (MEDIUM): body/metadataJson trước đây chỉ bị chặn gián tiếp bởi giới hạn 100kb toàn bộ
// request body của Express (app.ts) — không có giới hạn RIÊNG per-field. Thêm chặn tường minh ở service layer
// (không phụ thuộc cấu hình tầng khác, đọc rõ ràng ngay tại nơi dùng).
const MAX_BODY_LENGTH = 8000; // đủ dư cho tin nhắn/caption dài nhất hợp lý, tránh 1 tin chiếm hàng chục KB.
const MAX_METADATA_JSON_LENGTH = 4000;

// Cửa sổ thời gian được XÓA tin nhắn (soft-delete/"thu hồi") — 48h. GIÁ TRỊ NÀY LẤY THEO
// `RECALL_WINDOW_HOURS` đã có sẵn ở `apps/web-demo/src/lib/rc-realtime.ts` (kiến trúc RC CŨ, quy tắc nghiệp vụ
// Admin Demo chốt 24/7 "Thu hồi CHỈ trong 48h kể từ lúc gửi") — tự grep tìm thấy TRƯỚC khi viết hằng số này, dùng
// LẠI ĐÚNG con số đó để không lệch. KHÔNG import thẳng từ apps/web-demo (app frontend Vite khác, phụ thuộc
// `fetch`/`Response` runtime trình duyệt, và code đó gắn với transport RC đang bị THAY THẾ — import chéo
// app→app ngược hướng phụ thuộc monorepo, không hợp lý) — khai lại hằng số ở ĐÂY (phía service backend chat
// mới), có comment trỏ ngược nguồn gốc con số để 2 nơi không lệch nhau nếu sau này Admin Demo đổi số giờ.
export const MESSAGE_DELETE_WINDOW_HOURS = 48;

// Admin Demo chốt 29/7 (KHÔNG còn TENTATIVE): cửa sổ SỬA tin nhắn = 1 GIỜ, KHÁC HẲN 48h của xóa — tách riêng
// hằng số, KHÔNG dùng chung MESSAGE_DELETE_WINDOW_HOURS như bản build ban đầu (đã tự đánh dấu TENTATIVE đúng
// quy trình, LEAD hỏi lại và có câu trả lời thật, ghi ở đây).
export const MESSAGE_EDIT_WINDOW_HOURS = 1;

function withinWindow(createdAt: Date, hours: number): boolean {
  const ageMs = Date.now() - createdAt.getTime();
  return ageMs >= 0 && ageMs <= hours * 60 * 60 * 1000;
}

/** Tag @ mention kiểu Zalo (13/8) — trích mảng agentId được nhắc từ `metadataJson` của tin nhắn (shape
 * `{"mentions":[agentId,...]}`, xem web-demo mention.ts buildMentionMetadataJson). Hàm THUẦN (test độc lập).
 * Bỏ qua giá trị không phải số nguyên dương + dedupe. Hỏng/không có/không đúng shape → [] (KHÔNG throw — đây là
 * metadata phụ, tin nhắn vẫn hợp lệ; routes/chat.ts tự best-effort tạo thông báo). */
export function parseMentionAgentIds(metadataJson: string | null | undefined): number[] {
  if (!metadataJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const raw = (parsed as { mentions?: unknown }).mentions;
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of raw) {
    if (typeof v === 'number' && Number.isInteger(v) && v > 0 && !seen.has(v)) {
      out.push(v);
      seen.add(v);
    }
  }
  return out;
}

/** Tag @all (Admin Demo 24/8) — tin nhắn có nhắc TẤT CẢ thành viên? (`{"mentionAll":true}`, xem mention.ts
 * buildMentionMetadataJson). Hàm THUẦN. Hỏng/không có → false (KHÔNG throw). */
export function parseMentionAll(metadataJson: string | null | undefined): boolean {
  if (!metadataJson) return false;
  try {
    const parsed = JSON.parse(metadataJson) as { mentionAll?: unknown };
    return parsed?.mentionAll === true;
  } catch {
    return false;
  }
}

export interface SendMessageParams {
  roomId: string;
  senderId: number;
  kind: ChatMessageKind;
  body?: string;
  attachmentId?: string;
  metadataJson?: string;
  replyToMessageId?: string;
}

/** debt-chat-gaps (31/7, Việc 2) — `ChatMessage` KHÔNG có `@relation` Prisma tới `ChatAttachment` (bolt-on,
 * scalar `attachmentId`, xem comment schema.prisma ChatAttachment) nên KHÔNG JOIN được ngay trong 1 query
 * model. GAP đã ghi ở chat-client.ts `guessFileKindFromName()`: FE phải ĐOÁN mimeType theo đuôi tên file vì
 * `ChatMessageDto` không mang `mimeType`/`sizeBytes` thật. Hàm này gom `attachmentId` của TOÀN BỘ `rows` truyền
 * vào rồi tra `chatAttachment` bằng ĐÚNG 1 câu `findMany({where:{id:{in:...}}})` (tránh N+1) — trả lại rows GỐC
 * kèm thêm 2 field `attachmentMimeType`/`attachmentSizeBytes` (`null` nếu không có attachmentId hoặc attachment
 * đã bị xóa/không tìm thấy — KHÔNG throw, đây chỉ là metadata hiển thị phụ). */
async function attachAttachmentMeta<T extends { attachmentId: string | null }>(
  db: Db,
  rows: T[]
): Promise<(T & { attachmentMimeType: string | null; attachmentSizeBytes: number | null })[]> {
  const ids = [...new Set(rows.map((r) => r.attachmentId).filter((id): id is string => id !== null))];
  if (ids.length === 0) {
    return rows.map((r) => ({ ...r, attachmentMimeType: null, attachmentSizeBytes: null }));
  }
  const attachments = await db.chatAttachment.findMany({ where: { id: { in: ids } }, select: { id: true, mimeType: true, sizeBytes: true } });
  const byId = new Map(attachments.map((a) => [a.id, a]));
  return rows.map((r) => {
    const meta = r.attachmentId ? byId.get(r.attachmentId) : undefined;
    return { ...r, attachmentMimeType: meta?.mimeType ?? null, attachmentSizeBytes: meta?.sizeBytes ?? null };
  });
}

/** Gửi 1 tin nhắn — PHẢI là thành viên đang hoạt động của phòng (assertActiveMember, throw NOT_MEMBER nếu
 * không). Nếu kind='TEXT' bắt buộc `body` không rỗng sau trim (các kind khác body chỉ là caption, KHÔNG bắt
 * buộc — nội dung chính nằm ở attachmentId/metadataJson). Nếu có attachmentId, PHẢI đúng chủ sở hữu file
 * (ChatAttachment.uploaderId === senderId — chặn gắn file người khác upload, CÙNG nguyên tắc
 * setAttachmentRoomId() ở chat-attachment-service.ts). Sau khi tạo, cập nhật ChatRoom.lastMessageAt=now()
 * (denormalize để listRoomsForAgent() sort O(1), xem comment schema.prisma). */
export async function sendMessage(db: Db, params: SendMessageParams) {
  // debt-chat-gaps (31/7, Việc 4) — giữ NGUYÊN giá trị trả về của assertActiveMember() (trước đây bị bỏ qua,
  // discard) — hàm đó ĐÃ tra sẵn `ChatRoomMember.role` của sender, tái dùng thẳng để quyết định gate readOnly
  // bên dưới, TRÁNH thêm 1 query role riêng (đã có sẵn dữ liệu, không cần đọc lại) — KHÔNG gọi
  // assertOwnerOrAdmin() (hàm đó THROW luôn nếu không phải OWNER/ADMIN, ở đây readOnly=false thì MEMBER
  // thường vẫn phải gửi được bình thường, ngữ nghĩa khác hẳn).
  const member = await assertActiveMember(db, params.roomId, params.senderId);

  // BUG "tài khoản đã xóa VẪN gửi được tin" (5/8, Admin Demo) — GỐC: trong 48h ân hạn `deletedAt=null` nên
  // assertActiveMember() (chỉ kiểm hàng thành viên phòng) VẪN pass, tin vẫn gửi được. CHẶN TẠI NGUỒN GỬI: người
  // gửi có `deletionRequestedAt` (đang chờ xóa) HOẶC `deletedAt` (đã xóa thật) = ĐÃ VÔ HIỆU HÓA → từ chối
  // (route map ACCOUNT_DEACTIVATED → 403). Kiểm SAU assertActiveMember (người ngoài phòng vẫn nhận NOT_MEMBER
  // trước), TRƯỚC mọi validate/ghi khác (fail sớm, không tốn công). 1 nguồn điều kiện duy nhất:
  // isAccountDeactivated() (deletion-service.ts) — KHÔNG tự viết lại `deletedAt||deletionRequestedAt` ở đây.
  const sender = await db.agent.findUnique({ where: { id: params.senderId }, select: { deletedAt: true, deletionRequestedAt: true, name: true } });
  if (!sender || isAccountDeactivated(sender)) {
    throw new ChatServiceError('ACCOUNT_DEACTIVATED', 'Tài khoản của bạn đã bị vô hiệu hóa — không thể gửi tin nhắn.');
  }

  if (!ALLOWED_KINDS.has(params.kind)) {
    throw new ChatServiceError('VALIDATION', `kind không hợp lệ: ${params.kind}.`);
  }
  const trimmedBody = params.body?.trim() ?? '';
  if (params.kind === 'TEXT' && !trimmedBody) {
    throw new ChatServiceError('VALIDATION', 'Tin nhắn TEXT phải có nội dung (body) không rỗng.');
  }
  if (trimmedBody.length > MAX_BODY_LENGTH) {
    throw new ChatServiceError('VALIDATION', `Nội dung tin nhắn tối đa ${MAX_BODY_LENGTH} ký tự.`);
  }
  if (params.metadataJson && params.metadataJson.length > MAX_METADATA_JSON_LENGTH) {
    throw new ChatServiceError('VALIDATION', `metadataJson tối đa ${MAX_METADATA_JSON_LENGTH} ký tự.`);
  }

  // debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" (ChatRoom.readOnly, xem comment
  // schema.prisma). CHỈ chặn khi phòng BẬT cờ này VÀ sender KHÔNG phải OWNER/ADMIN — kiểm SAU validate hình
  // dạng input (fail nhanh cho lỗi rẻ hơn trước khi tốn thêm 1 query đọc phòng).
  //
  // AUDIT-4 (3/8, E2E đồng bộ liên-tính-năng) — BỔ SUNG type + members để BỊT lỗ hổng "chặn/hủy kết bạn KHÔNG
  // có hiệu lực trong phòng DIRECT ĐÃ TỒN TẠI". `findOrCreateDirectRoom()` (chat-room-service.ts) CỐ Ý không
  // lặp kiểm bạn bè/chặn khi phòng cũ đã có, docstring hàm đó ghi RÕ: "enforcement gửi tin mới lại nằm ở
  // sendMessage()" — nhưng sendMessage() TRƯỚC ĐÂY KHÔNG hề kiểm → hợp đồng giữa 2 module bị đứt: B bị A chặn
  // (hoặc đã hủy kết bạn) VẪN gửi được tin mới + A vẫn nhận realtime (tái hiện thật status 201 trước fix; nay
  // regression ở test/direct-room-block-enforcement.test.ts + test/cross-feature-sync-e2e.test.ts).
  // Khôi phục ĐÚNG hợp đồng: dùng LẠI `canMessageAgent()` (CHỈ 1 nguồn logic bạn bè/chặn, đúng ý DRY của
  // docstring) cho phòng DIRECT. GROUP KHÔNG áp (block là quan hệ theo CẶP, 1 cặp bị chặn vẫn ở chung nhóm —
  // giống Zalo, khớp createGroupRoom chỉ gate lúc MỜI). Xem lịch sử (listMessages) VẪN dùng assertActiveMember
  // → 2 người hủy kết bạn/bị chặn vẫn XEM lại phòng cũ, chỉ KHÔNG gửi tin MỚI (đúng mô tả docstring).
  const room = await db.chatRoom.findUnique({
    where: { id: params.roomId },
    select: { readOnly: true, type: true, members: { where: { leftAt: null }, select: { agentId: true } } }
  });
  if (room?.readOnly && member.role !== 'OWNER' && member.role !== 'ADMIN') {
    throw new ChatServiceError('ROOM_READ_ONLY', 'Phòng đang bật chế độ chỉ trưởng/phó nhóm được gửi tin nhắn.');
  }
  if (room?.type === 'DIRECT') {
    const other = room.members.find((m) => m.agentId !== params.senderId);
    if (other && !(await canMessageAgent(db, params.senderId, other.agentId))) {
      throw new ChatServiceError('CANNOT_MESSAGE', 'Không thể gửi tin — hai bên không còn là bạn bè hoặc đã chặn nhau.');
    }
  }

  let attachment: { mimeType: string; sizeBytes: number } | null = null;
  if (params.attachmentId) {
    const found = await db.chatAttachment.findUnique({ where: { id: params.attachmentId } });
    if (!found || found.uploaderId !== params.senderId) {
      throw new ChatServiceError('ATTACHMENT_NOT_OWNED', 'Chỉ được gắn file đính kèm do chính bạn tải lên.');
    }
    attachment = found;
  }

  // TOÀN VẸN GHI (LANE C Vòng 2, 3/8) — validate `replyToMessageId` TRƯỚC KHI ghi. `ChatMessage.replyToMessageId`
  // là scalar String KHÔNG có FK (bolt-on, xem schema.prisma) → nếu không kiểm, client GHI ĐƯỢC id BẤT KỲ,
  // kể cả id tin của PHÒNG KHÁC (trả lời xuyên phòng — rò rỉ/nhiễu dữ liệu) hoặc id rác/tin đã xóa. Tin được
  // trả lời PHẢI: tồn tại + thuộc ĐÚNG phòng đang gửi (roomId===params.roomId) + chưa bị xóa (deletedAt null).
  // CÙNG ranh giới cross-room đã áp cho cursor `before` ở listMessages() (lọc roomId).
  if (params.replyToMessageId) {
    const replyTo = await db.chatMessage.findUnique({
      where: { id: params.replyToMessageId },
      select: { roomId: true, deletedAt: true }
    });
    if (!replyTo || replyTo.roomId !== params.roomId || replyTo.deletedAt !== null) {
      throw new ChatServiceError('VALIDATION', 'Tin nhắn được trả lời không tồn tại trong phòng này hoặc đã bị xóa.');
    }
  }

  // NỢ #2c (3/8, LANE B Vòng 2 — server re-OCR đối chiếu số hoàn) — nếu đây là tin "Hoàn tiền" (metadataJson
  // .isRefundImage:true), server TỰ đọc lại ảnh biên lai THẬT đang gắn → OCR → so số client khai với số OCR
  // đọc, gắn cờ `refundUnverified`/`refundVerification` vào metadata (ghi đè giá trị client tự nhét). KHÔNG
  // throw / KHÔNG chặn gửi (đúng triết lý cảnh báo). Không phải tin hoàn tiền → trả NGUYÊN metadata (bỏ qua
  // OCR, không đụng luồng ảnh/bill thường). Xem refund-verify.ts.
  const effectiveMetadataJson = await annotateRefundMetadataOnSave(db, params.attachmentId, params.metadataJson);

  // BUG#6 (6/8, Admin Demo "người NHẬN không mở/tải được đính kèm") — GẮN `roomId` cho attachment NGAY TRONG
  // CÙNG transaction gửi tin, SERVER-AUTHORITATIVE. TRƯỚC ĐÂY roomId chỉ được set qua PATCH best-effort phía
  // client (attachRoomToChatAttachment(), rc-realtime.ts) SAU khi gửi — nếu PATCH lỗi/chậm/bị đua (người nhận
  // mở file NGAY khi vừa tới, trước khi PATCH xong) thì `chat_attachments.room_id` còn NULL → GET
  // /v1/chat/attachments/:id bỏ qua check membership và CHỈ cho uploaderId xem → người nhận nhận 403. Gắn
  // ngay ở đây (attachment đã xác thực thuộc `senderId` ở trên, `params.roomId` là phòng đang gửi) loại bỏ
  // hoàn toàn cửa sổ đua này cho MỌI định dạng (ảnh/file/ghi âm) ở CẢ DM lẫn nhóm. Client vẫn giữ PATCH cũ
  // (vô hại, idempotent) để tương thích ngược, không cần gỡ. Dùng interactive transaction để gộp update
  // attachment CÓ ĐIỀU KIỆN mà vẫn giữ kiểu `message` rõ ràng (mảng $transaction dị kiểu làm mất tuple type).
  const message = await db.$transaction(async (tx) => {
    const created = await tx.chatMessage.create({
      data: {
        roomId: params.roomId,
        senderId: params.senderId,
        kind: params.kind,
        body: params.body?.trim() || null,
        attachmentId: params.attachmentId ?? null,
        metadataJson: effectiveMetadataJson ?? null,
        replyToMessageId: params.replyToMessageId ?? null
      }
    });
    await tx.chatRoom.update({ where: { id: params.roomId }, data: { lastMessageAt: new Date() } });
    // MENU HỘI THOẠI (7/8) — "Xóa hội thoại phía mình" (removedAt) TỰ hiện lại khi phòng có TIN MỚI (kiểu Zalo):
    // clear removedAt cho MỌI thành viên đã xóa hội thoại này. CHỈ removedAt — KHÔNG đụng hiddenAt ("Ẩn" cố ý
    // KHÔNG tự hiện lại). updateMany có điều kiện `removedAt IS NOT NULL` để không ghi thừa hàng không cần thiết.
    await tx.chatRoomMember.updateMany({
      where: { roomId: params.roomId, removedAt: { not: null } },
      data: { removedAt: null }
    });
    if (params.attachmentId) {
      await tx.chatAttachment.update({ where: { id: params.attachmentId }, data: { roomId: params.roomId } });
    }
    return created;
  });
  // debt-chat-gaps (31/7, Việc 2) — đính kèm mimeType/sizeBytes THẬT ngay ở tin nhắn VỪA GỬI (đã có sẵn
  // `attachment` từ bước kiểm quyền sở hữu ở trên, KHÔNG query lại) — để broadcastNewMessage() (routes/chat.ts)
  // đẩy real-time cũng mang đủ field này, nhất quán với listMessages() bên dưới (không phải đợi tải lại trang
  // mới thấy đúng icon/dung lượng file).
  // REALTIME senderName (Admin Demo 1/9 "tin BILL đến LIVE vẫn là Đại lý #412 tới khi tải lại") — đính TÊN người gửi
  // NGAY vào giá trị trả về của sendMessage() để MỌI nơi broadcast tin mới (routes/chat.ts broadcastNewMessage,
  // ocr-send-service các hướng bill CK, investor-crosspost-service, zalo-bill-ingest — TẤT CẢ đều broadcast CHÍNH
  // object này) tự mang senderName trong payload WS, KHÔNG phải đợi listMessages()/tải lại (attachSenderName ở đó
  // chỉ chạy cho lịch sử). 1 nguồn tên duy nhất = bảng agents.name (CÙNG nguồn attachSenderName), tái dùng LUÔN
  // query `sender` đã đọc ở trên (thêm select name, KHÔNG thêm 1 round-trip). sender chắc chắn non-null tại đây
  // (đã throw ACCOUNT_DEACTIVATED nếu !sender phía trên). Client mapChatMessage()+withSenderName() đã đọc sẵn
  // dto.senderName (ưu tiên danh bạ → server → fallback) nên chỉ cần payload mang field này là hết "Đại lý #id".
  return { ...message, attachmentMimeType: attachment?.mimeType ?? null, attachmentSizeBytes: attachment?.sizeBytes ?? null, senderName: sender.name ?? null };
}

export interface ListMessagesOpts {
  before?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

/** Danh sách tin nhắn của 1 phòng, phân trang CURSOR theo (createdAt,id) — KHÔNG dùng offset (offset lệch khi
 * có tin mới chen vào giữa 2 lần tải, xem yêu cầu spec). `before` = id của tin CŨ NHẤT client đã có (kéo lên
 * xem tin cũ hơn) — lọc `createdAt < đó` HOẶC (`createdAt = đó` VÀ `id < đó`) để xử lý đúng trường hợp nhiều
 * tin nhắn trùng millisecond y hệt nhau (id là cuid, đơn điệu theo thời gian sinh — tie-break ổn định).
 * Trả `messages` SẮP XẾP MỚI NHẤT TRƯỚC (cùng chiều truy vấn desc) — route/FE tự đảo chiều nếu cần hiển thị
 * cũ→mới trong khung chat. */
export async function listMessages(db: Db, roomId: string, requesterAgentId: number, opts: ListMessagesOpts = {}) {
  await assertActiveMember(db, roomId, requesterAgentId);

  // XÓA HỘI THOẠI kiểu Zalo (7/8) — nếu agent này đã "Xóa hội thoại" (clearedAt set) → CHỈ trả tin có createdAt >
  // clearedAt (ẩn toàn bộ lịch sử cũ phía mình; nhắn lại thấy trò chuyện TRỐNG). Phía kia không bị ảnh hưởng.
  const meMember = await db.chatRoomMember.findUnique({
    where: { roomId_agentId: { roomId, agentId: requesterAgentId } },
    select: { clearedAt: true }
  });
  const clearedAt = meMember?.clearedAt ?? null;

  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);

  let cursor: { id: string; createdAt: Date } | null = null;
  if (opts.before) {
    // Audit độc lập 29/7 (MEDIUM): PHẢI lọc thêm roomId ở đây — thiếu điều kiện này cho phép 1 agent dùng
    // messageId THẬT của phòng KHÁC (biết được qua push notification/reply cũ) làm "oracle" xác nhận tin nhắn
    // đó tồn tại + lộ đúng createdAt của nó, dù bản thân không phải thành viên phòng chứa tin đó. Body tin nhắn
    // KHÔNG lộ (where chính vẫn lọc roomId), nhưng vẫn là rò rỉ cross-room không nên có.
    const cursorRow = await db.chatMessage.findUnique({ where: { id: opts.before }, select: { id: true, createdAt: true, roomId: true } });
    if (!cursorRow || cursorRow.roomId !== roomId) {
      throw new ChatServiceError('VALIDATION', `before=${opts.before} không tồn tại trong phòng này.`);
    }
    cursor = cursorRow;
  }

  const clearedFilter = clearedAt ? { createdAt: { gt: clearedAt } } : {};
  const where = cursor
    ? {
        roomId,
        ...clearedFilter, // AND: tin phải sau clearedAt (nếu đã xóa hội thoại) VÀ trước cursor (phân trang).
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }]
      }
    : { roomId, ...clearedFilter };

  const rows = await db.chatMessage.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1
  });
  const hasMore = rows.length > limit;
  // debt-chat-gaps (31/7, Việc 2) — kèm mimeType/sizeBytes THẬT (xem attachAttachmentMeta() trên) cho tin
  // IMAGE/FILE, ĐÚNG 1 query bổ sung cho CẢ TRANG (không N+1 theo từng tin nhắn).
  const withAtt = await attachAttachmentMeta(db, rows.slice(0, limit));
  const messages = await attachSenderName(db, withAtt);
  return { messages, hasMore };
}

/** Gắn TÊN người gửi (Admin Demo 1/9 "người gửi bill sao lại là Đại lý #412? phải đúng tên") — ChatMessage KHÔNG
 *  relation Agent (bolt-on) nên client TRƯỚC ĐÂY để senderName='' rồi tự tra danh bạ; BOT (SIGMA_BOT) + agent
 *  KHÔNG phải thành viên phòng KHÔNG có trong danh bạ user → rơi fallback "Đại lý #<id>". Server tra tên THẲNG từ
 *  bảng agents (1 query/trang, KHÔNG N+1) → client hiện đúng tên cho MỌI tin (kể cả bill CŨ, tự đúng khi tải lại). */
async function attachSenderName<T extends { senderId: number | null }>(
  db: Db,
  rows: T[]
): Promise<(T & { senderName: string | null })[]> {
  const ids = [...new Set(rows.map((r) => r.senderId).filter((id): id is number => id != null))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, senderName: null }));
  const agents = await db.agent.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const byId = new Map(agents.map((a) => [a.id, a.name]));
  return rows.map((r) => ({ ...r, senderName: r.senderId != null ? (byId.get(r.senderId) ?? null) : null }));
}

/** debt-chat-gaps (31/7, Việc 3) — tab "File" GroupInfoPanel.tsx (đang ẨN, xem comment đầu file đó: "Phase 2
 * KHÔNG có endpoint liệt kê mọi file đã gửi trong 1 phòng"). Danh sách MỌI attachment đã gửi THÀNH CÔNG trong
 * phòng (tin nhắn chưa xóa — `deleteMessage()` đã null hóa `attachmentId` lúc xóa mềm, xem comment hàm đó, nên
 * tin đã xóa TỰ ĐỘNG rớt khỏi danh sách này mà không cần lọc thêm `deletedAt`). PHẢI là thành viên đang hoạt
 * động (assertActiveMember, throw NOT_MEMBER) — CÙNG gate mọi hàm đọc dữ liệu phòng khác. Sắp MỚI NHẤT TRƯỚC
 * (cùng chiều listMessages()). 2 câu query (tin nhắn có đính kèm → attachment theo id, KHÔNG N+1 theo từng
 * attachment). */
export interface RoomAttachmentDto {
  attachmentId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploaderId: number;
  createdAt: Date;
}

/** FIX-PERF (4/8) — phân trang cursor cho listRoomAttachments (giống listMessages): `before` = id tin CŨ NHẤT
 * client đã có (kéo lên xem file cũ hơn); `hasMore` = còn trang nữa không. Trước đây hàm này trả TOÀN BỘ (không
 * limit) → phòng nhiều nghìn file trả cả nghìn hàng 1 lượt (đo THẬT: phòng 10k tin bug cũ quét+lọc cả 10k). */
export interface ListRoomAttachmentsOpts {
  before?: string;
  limit?: number;
}

const DEFAULT_ATTACHMENT_LIMIT = 30;
const MAX_ATTACHMENT_LIMIT = 100;

export async function listRoomAttachments(
  db: Db,
  roomId: string,
  requesterAgentId: number,
  opts: ListRoomAttachmentsOpts = {}
): Promise<{ attachments: RoomAttachmentDto[]; hasMore: boolean }> {
  await assertActiveMember(db, roomId, requesterAgentId);

  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_ATTACHMENT_LIMIT), MAX_ATTACHMENT_LIMIT);

  // Cursor `before` — CÙNG khuôn listMessages(): lọc thêm roomId (chặn dùng id tin phòng KHÁC làm oracle) rồi
  // phân trang (createdAt < cursor) OR (createdAt = cursor AND id < cursor). KHÔNG đòi tin cursor còn attachment
  // (client chỉ cần 1 mốc thời gian/id hợp lệ trong phòng để kéo tiếp — vd tin cuối của trang trước).
  let cursor: { id: string; createdAt: Date } | null = null;
  if (opts.before) {
    const cursorRow = await db.chatMessage.findUnique({ where: { id: opts.before }, select: { id: true, createdAt: true, roomId: true } });
    if (!cursorRow || cursorRow.roomId !== roomId) {
      throw new ChatServiceError('VALIDATION', `before=${opts.before} không tồn tại trong phòng này.`);
    }
    cursor = cursorRow;
  }

  const where = cursor
    ? {
        roomId,
        deletedAt: null,
        attachmentId: { not: null },
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }]
      }
    : { roomId, deletedAt: null, attachmentId: { not: null } };

  // Partial index `chat_messages_room_attachment_idx (room_id, created_at DESC) WHERE attachment_id IS NOT NULL
  // AND deleted_at IS NULL` (migration 20260804120000) phục vụ ĐÚNG WHERE+ORDER này — Postgres nhặt thẳng tin
  // có đính kèm theo thứ tự thời gian, KHÔNG quét+lọc toàn bộ tin của phòng (đo THẬT: phòng 10k tin 0 file
  // 29ms→0.3ms; phòng 10k file lấy 1 trang 0.35ms).
  const rows = await db.chatMessage.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, attachmentId: true }
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const attachmentIds = page.map((m) => m.attachmentId).filter((id): id is string => id !== null);
  if (attachmentIds.length === 0) return { attachments: [], hasMore: false };

  const attachments = await db.chatAttachment.findMany({ where: { id: { in: attachmentIds } } });
  const byId = new Map(attachments.map((a) => [a.id, a]));

  const result: RoomAttachmentDto[] = [];
  for (const m of page) {
    if (!m.attachmentId) continue;
    const att = byId.get(m.attachmentId);
    if (!att) continue; // attachment row biến mất (không nên xảy ra bình thường) — bỏ qua, không vỡ danh sách.
    result.push({
      attachmentId: att.id,
      messageId: m.id,
      fileName: att.fileName,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
      uploaderId: att.uploaderId,
      createdAt: att.createdAt
    });
  }
  return { attachments: result, hasMore };
}

/** "Xóa" tin nhắn (soft — set deletedAt, KHÔNG xóa cứng). CHỈ chính người gửi, VÀ chỉ trong
 * MESSAGE_DELETE_WINDOW_HOURS (48h) kể từ createdAt — xem comment hằng số ở trên.
 *
 * Phase 3 real-time (29/7) — ĐỔI return từ `Promise<void>` sang trả row đã update (Prisma `update()` đã sẵn có
 * giá trị đó) để route (routes/chat.ts) dùng cho `broadcastMessageDeleted()` (roomId/deletedAt) mà KHÔNG cần
 * query lại. Nhánh idempotent (đã xóa từ trước) GIỮ NGUYÊN `return;` (undefined) — KHÔNG đổi logic nghiệp vụ,
 * chỉ đổi ĐÚNG 1 dòng cuối như brief yêu cầu; route tự coi undefined = "không có gì mới để broadcast". */
export async function deleteMessage(db: Db, messageId: string, requesterAgentId: number) {
  const message = await db.chatMessage.findUnique({ where: { id: messageId } });
  if (!message) {
    throw new ChatServiceError('NOT_FOUND', `Tin nhắn id=${messageId} không tồn tại.`);
  }
  if (message.senderId !== requesterAgentId) {
    throw new ChatServiceError('FORBIDDEN', 'Chỉ người gửi mới được xóa tin nhắn này.');
  }
  if (message.deletedAt !== null) return; // đã xóa từ trước — idempotent, không lỗi.
  if (!withinWindow(message.createdAt, MESSAGE_DELETE_WINDOW_HOURS)) {
    throw new ChatServiceError('DELETE_WINDOW_EXPIRED', `Chỉ có thể xóa tin nhắn trong vòng ${MESSAGE_DELETE_WINDOW_HOURS} giờ kể từ lúc gửi.`);
  }
  // Audit độc lập 30/7 (MEDIUM): "xóa" trước đây CHỈ set deletedAt, GIỮ NGUYÊN body/attachmentId/metadataJson
  // trong DB — bất kỳ ai gọi thẳng GET /v1/chat/rooms/:roomId/messages (DevTools/curl) vẫn đọc được nội dung
  // gốc, chỉ FE (mapChatMessage()) ẩn đi. Xóa THẬT ở nguồn: null hóa body/attachmentId/metadataJson NGAY lúc
  // set deletedAt — "Tin nhắn đã bị xóa" giờ đúng nghĩa đen, không chỉ che ở tầng hiển thị.
  const attachmentId = message.attachmentId; // GIỮ trước khi null hóa, để dọn file/quyền tải bên dưới.
  // [Dọn nợ 11/9 — NHẢ RESERVATION KHI XOÁ TIN] Tin bill (POS/CK/QR) giữ chỗ trong ocr_bill_sent theo key trên
  // metadata; xoá tin mà KHÔNG nhả → gửi lại bill đó bị chặn "đã gửi" vĩnh viễn (mồ côi). Nhả TRƯỚC khi null hoá
  // metadata (sau đó không còn đọc được key). Best-effort: lỗi nhả KHÔNG chặn việc xoá tin.
  if (message.metadataJson) {
    try {
      const meta = JSON.parse(message.metadataJson) as Record<string, unknown>;
      const keys = ['ocrSendKey', 'ckTxnKey', 'qrRefundKey', 'qrInvestorKey']
        .map((f) => meta[f]).filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (keys.length > 0) {
        await db.$executeRawUnsafe(
          'DELETE FROM ocr_bill_sent WHERE dealer_room_id = $1 AND ocr_send_key = ANY($2::text[])',
          message.roomId, keys);
        console.log(`[chat-delete] nhả ${keys.length} reservation gửi-bill của tin ${messageId} (phòng ${message.roomId}).`);
      }
    } catch (e) {
      console.error('[chat-delete] nhả reservation lỗi (không chặn xoá tin):', e instanceof Error ? e.message : e);
    }
  }
  const updated = await db.chatMessage.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), body: null, attachmentId: null, metadataJson: null }
  });

  // FIX thu-hồi-tin-ảnh (12/8) — tin có đính kèm bị thu hồi mà attachment vẫn tải được (room_id còn set) +
  // file vật lý còn lại làm rác đĩa. Sau khi đã null hóa attachmentId của CHÍNH tin này, kiểm còn tin CHƯA-XÓA
  // nào khác trỏ tới cùng attachment không (cùng 1 file có thể được gắn vào nhiều tin bởi chính uploader) —
  // nếu KHÔNG còn ai dùng → xóa HẲN row chat_attachments (gỡ quyền tải cho MỌI người) + unlink file vật lý.
  // KHÔNG đụng attachment còn tin khác dùng (đúng yêu cầu "cẩn thận không phá tin chưa xóa").
  if (attachmentId) {
    const stillReferenced = await db.chatMessage.findFirst({
      where: { attachmentId, deletedAt: null, id: { not: messageId } },
      select: { id: true }
    });
    if (!stillReferenced) {
      await deleteAttachmentAndFile(db, attachmentId);
    }
  }
  return updated;
}

/** B112 (2/8, Admin Demo "bill sau khi gửi chưa có nút sửa") — sửa ẢNH BILL đã gửi (ghép lại bảng OCR với số tiền
 * mới, xem `composeBillImage()`/`cropTopOfImage()` phía web-demo `lib/bill-table-image.ts`). CỐ Ý EXTEND
 * `editMessage()` hiện có (KHÔNG viết route/hàm song song mới, đúng nguyên tắc "ưu tiên mở rộng bug-class") —
 * tái dùng NGUYÊN `MESSAGE_EDIT_WINDOW_HOURS` (1h) đã có sẵn cho MỌI loại sửa tin nhắn, KHÔNG bịa cửa sổ thời
 * gian riêng cho bill (KHÁC brief gốc gợi ý "dùng chung khuôn Thu hồi 48h" — 48h là cửa sổ XÓA, đã có cửa sổ
 * SỬA riêng 1h do Admin Demo chốt 29/7 từ TRƯỚC B112, ưu tiên dùng đúng cơ chế edit đã tồn tại thay vì mượn cơ chế
 * delete). `newAttachmentId`/`newMetadataJson` PHẢI đi cùng nhau (route đã validate hình dạng input tối thiểu) —
 * validate NGHIỆP VỤ ở đây: (1) chỉ áp dụng cho `kind==='IMAGE'`, (2) tin GỐC phải ĐANG là bill đã ghép
 * (`metadataJson` hiện có `isBillImage:true` — bill fallback ảnh gốc chưa ghép KHÔNG có field này, KHÔNG sửa
 * được qua đường này, xem `bill-message-meta.ts` phía web-demo comment "hasAnyExtendedFieldRead false"), (3)
 * `newMetadataJson` phải parse được + `isBillImage:true` + `billAmount` là số hữu hạn > 0 (đúng yêu cầu tường
 * minh "amount hợp lệ >0" — server tự kiểm lại, KHÔNG chỉ tin client dù route này KHÔNG phải luồng transactional
 * thật, đúng nguyên tắc R198 "check phải chạy"), (4) `newAttachmentId` PHẢI do CHÍNH requester upload (CÙNG
 * check `sendMessage()` — `ATTACHMENT_NOT_OWNED` nếu không, chặn gắn file người khác upload vào tin của mình). */
export interface EditMessageBillPatch {
  newAttachmentId: string;
  newMetadataJson: string;
}

export async function editMessage(db: Db, messageId: string, requesterAgentId: number, newBody: string, billPatch?: EditMessageBillPatch) {
  const message = await db.chatMessage.findUnique({ where: { id: messageId } });
  if (!message) {
    throw new ChatServiceError('NOT_FOUND', `Tin nhắn id=${messageId} không tồn tại.`);
  }
  if (message.senderId !== requesterAgentId) {
    throw new ChatServiceError('FORBIDDEN', 'Chỉ người gửi mới được sửa tin nhắn này.');
  }
  if (message.deletedAt !== null) {
    throw new ChatServiceError('VALIDATION', 'Không thể sửa tin nhắn đã bị xóa.');
  }
  const trimmed = newBody.trim();
  if (!trimmed) {
    throw new ChatServiceError('VALIDATION', 'Nội dung sửa không được để trống.');
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    throw new ChatServiceError('VALIDATION', `Nội dung tin nhắn tối đa ${MAX_BODY_LENGTH} ký tự.`);
  }
  if (!withinWindow(message.createdAt, MESSAGE_EDIT_WINDOW_HOURS)) {
    throw new ChatServiceError('EDIT_WINDOW_EXPIRED', `Chỉ có thể sửa tin nhắn trong vòng ${MESSAGE_EDIT_WINDOW_HOURS} giờ kể từ lúc gửi.`);
  }

  const data: { body: string; editedAt: Date; attachmentId?: string; metadataJson?: string } = { body: trimmed, editedAt: new Date() };

  if (billPatch) {
    if (message.kind !== 'IMAGE') {
      throw new ChatServiceError('VALIDATION', 'Chỉ tin nhắn ảnh mới đổi được ảnh đính kèm.');
    }
    // SIGMA (2/8, tính năng "Hoàn tiền") — EXTEND discriminator chấp nhận CẢ `isBillImage:true` (bill gốc,
    // B112) LẪN `isRefundImage:true` (tin nhắn xác nhận hoàn tiền MỚI) — 2 loại tin ẢNH ĐÃ GHÉP bảng đều dùng
    // CHUNG cơ chế "Sửa" này (đổi số tiền/đổi ảnh), KHÔNG viết route/hàm song song mới (đúng nguyên tắc "ưu
    // tiên mở rộng bug-class" đã áp dụng cho chính billPatch ở B112). billAmount/refundAmount validate riêng vì
    // 2 shape metadata khác tên field số tiền (bill-message-meta.ts vs refund-message-meta.ts phía web-demo).
    let currentMeta: { isBillImage?: boolean; isRefundImage?: boolean } = {};
    try {
      currentMeta = message.metadataJson ? (JSON.parse(message.metadataJson) as { isBillImage?: boolean; isRefundImage?: boolean }) : {};
    } catch {
      currentMeta = {}; // metadataJson hiện có hỏng — coi như KHÔNG phải bill/hoàn tiền, chặn ở check dưới (KHÔNG throw ở đây, R198: lỗi phải thành finding rõ ràng bằng thông báo nghiệp vụ, không phải crash JSON.parse).
    }
    const currentIsBill = currentMeta.isBillImage === true;
    const currentIsRefund = currentMeta.isRefundImage === true;
    if (!currentIsBill && !currentIsRefund) {
      throw new ChatServiceError('VALIDATION', 'Chỉ tin nhắn bill đã quét hoặc tin nhắn hoàn tiền mới sửa được ảnh đính kèm theo cách này.');
    }
    if (billPatch.newMetadataJson.length > MAX_METADATA_JSON_LENGTH) {
      throw new ChatServiceError('VALIDATION', `metadataJson tối đa ${MAX_METADATA_JSON_LENGTH} ký tự.`);
    }
    let newMeta: { isBillImage?: boolean; isRefundImage?: boolean; billAmount?: number; refundAmount?: number } = {};
    try {
      newMeta = JSON.parse(billPatch.newMetadataJson) as typeof newMeta;
    } catch {
      throw new ChatServiceError('VALIDATION', 'metadataJson không hợp lệ (không parse được).');
    }
    // Tin GỐC là loại nào (bill/hoàn tiền) → metadata MỚI PHẢI giữ ĐÚNG loại đó (không cho "Sửa" đổi 1 bill gốc
    // thành tin hoàn tiền hay ngược lại qua đường này — 2 loại tin có ý nghĩa nghiệp vụ khác hẳn nhau).
    if (currentIsBill) {
      if (newMeta.isBillImage !== true || typeof newMeta.billAmount !== 'number' || !Number.isFinite(newMeta.billAmount) || newMeta.billAmount <= 0) {
        throw new ChatServiceError('VALIDATION', 'Số tiền không hợp lệ (phải là số lớn hơn 0).');
      }
    } else {
      if (newMeta.isRefundImage !== true || typeof newMeta.refundAmount !== 'number' || !Number.isFinite(newMeta.refundAmount) || newMeta.refundAmount <= 0) {
        throw new ChatServiceError('VALIDATION', 'Số tiền hoàn không hợp lệ (phải là số lớn hơn 0).');
      }
    }
    const foundAttachment = await db.chatAttachment.findUnique({ where: { id: billPatch.newAttachmentId } });
    if (!foundAttachment || foundAttachment.uploaderId !== requesterAgentId) {
      throw new ChatServiceError('ATTACHMENT_NOT_OWNED', 'Chỉ được gắn file đính kèm do chính bạn tải lên.');
    }
    data.attachmentId = billPatch.newAttachmentId;
    // AUDIT-1 (3/8) — BUG bảo mật: SỬA tin hoàn tiền TRƯỚC ĐÂY ghi thẳng `newMetadataJson` client cung cấp mà
    // KHÔNG chạy lại kiểm chứng server-side re-OCR (annotateRefundMetadataOnSave) như sendMessage() → chính chủ
    // bill có thể GỬI 1 tin hoàn tiền số nhỏ (được verify), rồi SỬA lên số lớn tùy ý + ảnh mới → server tin
    // metadata client (không cờ refundUnverified) → báo cáo KPI/cộng dồn coi là "Hoàn đủ" giả (né TOÀN BỘ lớp
    // #2c). Fix: chạy CÙNG annotateRefundMetadataOnSave qua ảnh MỚI đang gắn — hàm này TỰ no-op cho tin bill
    // (isRefundImage !== true → trả nguyên metadata), nên áp chung an toàn cho cả 2 nhánh bill/hoàn tiền; với
    // tin hoàn tiền nó ghi ĐÈ refundUnverified/refundVerification theo OCR ảnh thật (xóa cờ client tự nhét).
    data.metadataJson = (await annotateRefundMetadataOnSave(db, billPatch.newAttachmentId, billPatch.newMetadataJson)) ?? billPatch.newMetadataJson;
  }

  return db.chatMessage.update({ where: { id: messageId }, data });
}

/** Đánh dấu đã đọc tới messageId (cập nhật ChatRoomMember.lastReadMessageId). PHẢI là thành viên đang hoạt
 * động của phòng. KHÔNG kiểm messageId có "mới hơn" lastReadMessageId cũ hay không (cho phép client gửi lại
 * đúng thứ tự — đơn giản, tin tưởng client vì đây chỉ là con trỏ hiển thị "đã xem", không phải dữ liệu nhạy cảm
 * bảo mật; nếu client gửi lùi thời gian, hậu quả DUY NHẤT là unreadCount tính SAI cho chính agent đó, không ảnh
 * hưởng người khác — chấp nhận được, tránh query thêm 1 lần so sánh createdAt không cần thiết mỗi lần đọc tin). */
export async function markRead(db: Db, roomId: string, agentId: number, messageId: string): Promise<{ createdAt: Date }> {
  await assertActiveMember(db, roomId, agentId);
  // TOÀN VẸN GHI (LANE C Vòng 2, 3/8) — `lastReadMessageId` là scalar String KHÔNG có FK (bolt-on) → nếu không
  // kiểm, client GHI ĐƯỢC con trỏ "đã đọc" trỏ tới id BẤT KỲ (tin phòng khác / id rác). Dù comment cũ lập luận
  // "chỉ ảnh hưởng unreadCount của chính agent đó", đây vẫn là GHI DỮ LIỆU SAI (con trỏ trỏ ngoài phòng) — lớp
  // lỗi Vòng 2 cấm. Kiểm messageId THUỘC ĐÚNG phòng trước khi ghi (KHÔNG cần chưa-xóa: tin đã xóa vẫn là mốc
  // "đã đọc tới đây" hợp lệ, xóa không dời vị trí đọc).
  // TICK "đã đọc" (5/8, Admin Demo "trạng thái đã gửi/đã nhận/đã đọc") — CŨNG select `createdAt` để route phát
  // broadcast `read-receipt` (chat-realtime-hub → người GỬI đang mở phòng đổi tick tin của họ sang "đã xem"),
  // KHÔNG query lại (đã đọc tin ở đây rồi). `createdAt` là mốc so sánh: mọi tin của người gửi có createdAt ≤
  // mốc này = đã được agent này đọc.
  const target = await db.chatMessage.findUnique({ where: { id: messageId }, select: { roomId: true, createdAt: true } });
  if (!target || target.roomId !== roomId) {
    throw new ChatServiceError('VALIDATION', `messageId=${messageId} không thuộc phòng này — không thể đánh dấu đã đọc.`);
  }
  await db.chatRoomMember.update({
    where: { roomId_agentId: { roomId, agentId } },
    data: { lastReadMessageId: messageId }
  });
  return { createdAt: target.createdAt };
}

/** Admin Demo chốt 29/7 ("tích chọn đã đọc tất cả", giống Zalo) — đánh dấu ĐÃ ĐỌC cho MỌI phòng agentId đang là
 * thành viên hoạt động, mỗi phòng trỏ tới tin nhắn MỚI NHẤT (chưa xóa) của phòng đó (phòng chưa có tin nào →
 * giữ nguyên lastReadMessageId null, không có gì để trỏ tới).
 *
 * FIX-PERF (4/8) — ĐỔI từ N+1 (1 findMany membership + MỖI phòng thêm 1 findFirst + 1 update, chạy song song
 * qua Promise.allSettled nhưng vẫn là 1+2N round-trip DB — agent nhiều phòng "load rất lâu") sang ĐÚNG 2 câu
 * CỐ ĐỊNH (KHÔNG phụ thuộc số phòng N):
 *   (1) 1 câu CROSS JOIN LATERAL lấy (room_id, latest_id) — tin mới nhất chưa xóa MỖI phòng agent đang hoạt
 *       động, qua index `chat_messages_room_created_id_desc_idx` (migration 20260804120000). CROSS JOIN LATERAL
 *       (KHÔNG phải LEFT) TỰ LOẠI phòng không có tin nào (subquery LIMIT 1 trả 0 hàng → hàng ngoài bị loại) —
 *       GIỮ NGUYÊN đúng nhánh `if (!latest) return` cũ (phòng rỗng KHÔNG đụng lastReadMessageId).
 *   (2) 1 câu UPDATE gộp qua VALUES(room_id, latest_id) — thay N câu update lẻ.
 * Kết quả GIỐNG HỆT bản cũ (đã verify trên seed 500k tin: (room_id→latest_id) khớp 100%, 0 mismatch).
 *
 * ĐÁNH ĐỔI có chủ đích so bản cũ: bản cũ `Promise.allSettled` nuốt lỗi TỪNG phòng (best-effort). Bản mới là 1
 * UPDATE — hoặc thành công toàn bộ, hoặc throw (lỗi DB thật nổi lên route xử lý, KHÔNG còn báo thành công GIẢ
 * khi DB hỏng — đúng tinh thần R198 "check phải chạy, không nuốt lỗi im"). Đây thuần cập nhật con trỏ hiển thị
 * "đã xem" nên atomic-toàn-bộ hoàn toàn chấp nhận được (thực ra AN TOÀN hơn: không để 1 phần phòng lệch trạng
 * thái đọc mà caller vẫn tưởng đã đọc hết). `tie-break created_at DESC, id DESC` GIỮ NGUYÊN như findFirst cũ. */
export async function markAllRead(db: Db, agentId: number): Promise<void> {
  const rows = await db.$queryRaw<{ room_id: string; latest_id: string }[]>`
    SELECT rm.room_id, lm.id AS latest_id
    FROM chat_room_members rm
    CROSS JOIN LATERAL (
      SELECT m.id
      FROM chat_messages m
      WHERE m.room_id = rm.room_id AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) lm
    WHERE rm.agent_id = ${agentId} AND rm.left_at IS NULL
  `;
  if (rows.length === 0) return; // agent không ở phòng nào có tin — không có gì để đánh dấu.

  const pairs = rows.map((r) => Prisma.sql`(${r.room_id}::text, ${r.latest_id}::text)`);
  await db.$executeRaw`
    UPDATE chat_room_members AS rm
    SET last_read_message_id = v.latest_id
    FROM (VALUES ${Prisma.join(pairs)}) AS v(room_id, latest_id)
    WHERE rm.room_id = v.room_id AND rm.agent_id = ${agentId} AND rm.left_at IS NULL
  `;
}
