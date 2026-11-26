// SIGMA — TỰ ĐẨY BILL SANG NHÓM NĐT (Admin Demo). Khi 1 đại lý gửi ẢNH BILL (kind IMAGE, metadataJson có
// isBillImage:true + billFields.tid đọc từ OCR) vào 1 phòng chat, NẾU TID đó đang được UỶ cho 1 Nhà đầu tư
// (qua TK nhận tiền → ReceiveAccount.investorId + investorChatGroupId đang gán) thì bot "SigMa" TỰ ĐỘNG đăng
// lại ẢNH bill đó (COPY sang attachment mới thuộc bot) + 1 dòng TÓM TẮT OCR vào nhóm chat riêng của NĐT.
//
// BẢO MẬT (mệnh lệnh Admin Demo): tin đẩy sang nhóm NĐT CHỈ chứa ẢNH bill + tóm tắt các trường đọc-TRÊN-BILL
// (TID · số tiền · ngân hàng · số hóa đơn · giờ quẹt). TUYỆT ĐỐI KHÔNG phí bán / % / net / doanh thu, KHÔNG
// tên khách (không in trên bill). NĐT chỉ thấy đúng thứ đã có sẵn trên tấm bill, không thêm dữ liệu nội bộ.
//
// TÁCH LỚP: hook `crossPostBillToInvestor(db, message)` gọi BEST-EFFORT ở routes/chat.ts SAU khi bill đã ghi
// DB + broadcast — KHÔNG BAO GIỜ throw ra ngoài (mọi lỗi log rõ ràng theo R198 rồi nuốt tại đây, để KHÔNG
// chặn luồng gửi tin chính của người dùng). Idempotent qua marker `alphaCrossPostSourceId` (dedupe).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { getBotDb } from './db.js';
import { getAttachmentFile, saveAttachment } from './chat-attachment-service.js';
import { sendMessage } from './services/chat-message-service.js';
import { broadcastToRoom } from './chat-realtime-hub.js';
import { roomCustomerTidRows } from './services/chat-room-tid-service.js';

type Db = ReturnType<typeof getBotDb>;

/** Mã Agent cố định cho bot hệ thống "SigMa". code là @unique → upsert idempotent (nhiều lần gọi = 1 hàng). */
export const SIGMA_BOT_CODE = 'SIGMA_BOT';
export const SIGMA_BOT_NAME = 'SigMa';

/** Đường dẫn ảnh icon master của brand (trong suốt) — dùng làm avatar bot SigMa (best-effort). Từ apps/bot-api/
 * src lên gốc repo 3 cấp (src → bot-api → apps → repoRoot), rồi assets/brand/alpha-icon-master.png. */
function alphaIconMasterPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // apps/bot-api/src
  const repoRoot = join(here, '..', '..', '..'); // repo root
  return join(repoRoot, 'assets', 'brand', 'alpha-icon-master.png');
}

/** Tạo/đảm bảo Agent bot "SigMa" tồn tại (idempotent). Avatar gán BEST-EFFORT từ icon master — thiếu file/lỗi
 * đọc KHÔNG chặn (bot vẫn dùng được, chỉ không có avatar). Dùng avatarImageMime làm cờ "đã có avatar chưa" để
 * KHÔNG tải lại BLOB mỗi lần gọi. KHÔNG cần migration (dùng cột Agent.avatar* có sẵn). */
export async function ensureAlphaBotAgent(db: Db): Promise<{ id: number }> {
  const bot = await db.agent.upsert({
    where: { code: SIGMA_BOT_CODE },
    update: {},
    create: { code: SIGMA_BOT_CODE, name: SIGMA_BOT_NAME },
    select: { id: true, avatarImageMime: true }
  });
  if (!bot.avatarImageMime) {
    try {
      const bytes = await readFile(alphaIconMasterPath());
      await db.agent.update({
        where: { id: bot.id },
        data: { avatarImage: bytes, avatarImageMime: 'image/png', avatarUpdatedAt: new Date() }
      });
    } catch (err) {
      // R198 — KHÔNG nuốt câm: log rõ nhưng KHÔNG chặn (avatar là phụ, bot vẫn hoạt động).
      console.error('[investor-crosspost] gán avatar bot SigMa thất bại (best-effort, bot vẫn dùng được):', err);
    }
  }
  return { id: bot.id };
}

/** Suy ra phòng chat NĐT (roomId) mà 1 bill gửi trong phòng KHÁCH `sourceRoomId` với `tidStr` (đọc OCR) cần được
 * đẩy tới — hoặc null (KHÔNG đẩy) nếu bất kỳ mắt xích nào đứt:
 *   1. TID phải thuộc KHÁCH của phòng gửi bill (roomCustomerTidRows — ĐÚNG scope B142). THAY gate cũ
 *      `tid.agentId = senderId` (DEAD: tids.agentId LUÔN null ở production → crosspost không bao giờ fire, bug
 *      Admin Demo 22/8 phát hiện). Đây cũng là hàng rào bảo mật: chỉ đẩy bill của TID đúng khách của phòng, không
 *      để 1 TID lạ OCR ra tuồn bill sang nhóm NĐT khác.
 *   2. Tid.receiveAccountId != null → ReceiveAccount (deletedAt=null) → investorId (= tài khoản uỷ quyền gắn TID).
 *   3. Route theo INVESTOR (Admin Demo chốt 22/8 "1 NĐT = 1 nhóm"): nhóm ĐANG-GÁN của investor đó có roomId. KHÔNG
 *      còn bắt buộc ReceiveAccount.investorChatGroupId (thực tế chưa set). >1 nhóm active có room = cấu hình sai
 *      → log cảnh báo (R198, KHÔNG nuốt câm) + chọn nhóm gán GẦN NHẤT (assignedFrom desc) để không chặn luồng. */
export async function resolveInvestorRoomForTid(db: Db, sourceRoomId: string, tidStr: string): Promise<string | null> {
  const tid = tidStr.trim();
  if (!tid) return null;

  // 1. TID có thuộc khách của phòng gửi bill không? (suy TỪ KHÁCH — CÙNG nguồn doanh số, KHÔNG dùng tid.agentId).
  const roomTids = await roomCustomerTidRows(db, sourceRoomId);
  const matched = roomTids.find((t) => t.tid.trim() === tid);
  if (!matched) return null;

  // 2. receiveAccount (TK uỷ quyền) của TID → investorId.
  const tidRow = await db.tid.findUnique({ where: { id: matched.id }, select: { receiveAccountId: true } });
  if (!tidRow?.receiveAccountId) return null;
  const acct = await db.receiveAccount.findFirst({
    where: { id: tidRow.receiveAccountId, deletedAt: null },
    select: { investorId: true }
  });
  if (!acct || acct.investorId == null) return null;

  // 3. Nhóm NĐT đang-gán của investor đó (có roomId). 1 NĐT = 1 nhóm; nếu lỡ >1 → cảnh báo + chọn gần nhất.
  const groups = await db.investorChatGroup.findMany({
    where: { investorId: acct.investorId, unassignedAt: null, roomId: { not: null } },
    select: { roomId: true, assignedFrom: true },
    orderBy: { assignedFrom: 'desc' }
  });
  if (groups.length === 0) return null;
  if (groups.length > 1) {
    console.error(
      `[investor-crosspost] CẤU HÌNH SAI: investorId=${acct.investorId} có ${groups.length} nhóm đang-gán có phòng (kỳ vọng 1). Chọn nhóm gán gần nhất, cần dọn cấu hình.`
    );
  }
  return groups[0].roomId ?? null;
}

/** Đảm bảo bot SigMa là thành viên ĐANG hoạt động (leftAt=null) của phòng NĐT với vai trò ADMIN (để gửi được
 * cả khi phòng bật readOnly). Idempotent (upsert theo khóa duy nhất roomId+agentId; đã rời thì clear leftAt). */
async function ensureBotMembership(db: Db, roomId: string, botId: number): Promise<void> {
  await db.chatRoomMember.upsert({
    where: { roomId_agentId: { roomId, agentId: botId } },
    update: { leftAt: null, role: 'ADMIN' },
    create: { roomId, agentId: botId, role: 'ADMIN' }
  });
}

/** COPY 1 attachment bill sang attachment MỚI thuộc `botId` (uploaderId = bot) — đọc file gốc trên đĩa rồi ghi
 * lại qua saveAttachment() (sniff magic-bytes + ghi row + file mới, id MỚI hoàn toàn — KHÔNG tái dùng file/row
 * gốc của đại lý). Trả id attachment mới, hoặc null nếu không đọc được file gốc / ghi lỗi (best-effort). */
async function copyBillAttachment(db: Db, sourceAttachmentId: string, botId: number): Promise<string | null> {
  const file = await getAttachmentFile(db, sourceAttachmentId);
  if (!file) {
    console.error(`[investor-crosspost] không đọc được file bill gốc attachmentId=${sourceAttachmentId} — bỏ đẩy.`);
    return null;
  }
  const buffer = await readFile(file.filePath);
  const result = await saveAttachment(db, buffer, file.fileName, botId);
  if (!result.ok) {
    console.error(`[investor-crosspost] copy attachment bill thất bại (reason=${result.reason}) attachmentId=${sourceAttachmentId} — bỏ đẩy.`);
    return null;
  }
  return result.id;
}

interface OcrFieldValue {
  value?: string;
}
interface BillMetaShape {
  isBillImage?: boolean;
  billAmount?: number;
  alphaCrossPostSourceId?: string;
  billFields?: {
    tid?: OcrFieldValue | null;
    bankName?: OcrFieldValue | null;
    invoiceNumber?: OcrFieldValue | null;
    dateTime?: OcrFieldValue | null;
  } | null;
}

function parseBillMeta(metadataJson: string | null): BillMetaShape | null {
  if (!metadataJson) return null;
  try {
    return JSON.parse(metadataJson) as BillMetaShape;
  } catch {
    return null; // metadataJson hỏng → coi như không phải bill (KHÔNG throw — chỉ là nhiển thị phụ).
  }
}

/** Số tiền VND kiểu "140.000.000" (nhóm nghìn bằng dấu chấm) — dùng en-US rồi thay ',' → '.' để KHÔNG phụ thuộc
 * bản dựng ICU của Node (Intl 'vi-VN' có thể thiếu trên vài môi trường). */
function formatVnd(n: number): string {
  return Math.round(n).toLocaleString('en-US').replace(/,/g, '.');
}

/** TÓM TẮT OCR CHỈ gồm các trường ĐỌC-TRÊN-BILL (không dữ liệu nội bộ): `Bill TID {tid} · {số tiền}đ · {bank} ·
 * HĐ {invoice} · {giờ quẹt}`. Trường thiếu (OCR không đọc được) thì BỎ QUA khỏi chuỗi (không in "· null"). TID
 * + số tiền luôn cố gắng có (đã kiểm tid tồn tại ở caller; số tiền lấy billAmount đã xác nhận). */
function buildBillSummary(tidStr: string, meta: BillMetaShape): string {
  const parts: string[] = [`Bill TID ${tidStr.trim()}`];
  if (typeof meta.billAmount === 'number' && Number.isFinite(meta.billAmount) && meta.billAmount > 0) {
    parts.push(`${formatVnd(meta.billAmount)}đ`);
  }
  const bank = meta.billFields?.bankName?.value?.trim();
  if (bank) parts.push(bank);
  const invoice = meta.billFields?.invoiceNumber?.value?.trim();
  if (invoice) parts.push(`HĐ ${invoice}`);
  const time = meta.billFields?.dateTime?.value?.trim();
  if (time) parts.push(time);
  return parts.join(' · ');
}

/** Hình dạng tối thiểu của tin nhắn bill vừa gửi mà hook cần (khớp giá trị trả về sendMessage()). */
export interface CrossPostSourceMessage {
  id: string;
  roomId: string;
  senderId: number | null;
  kind: string;
  attachmentId: string | null;
  metadataJson: string | null;
}

export type CrossPostResult =
  | { crossPosted: true; roomId: string; messageId: string }
  | { crossPosted: false; reason: string };

/** HOOK CHÍNH — gọi SAU khi 1 tin nhắn đã ghi DB + broadcast (routes/chat.ts). Nếu tin là ẢNH BILL của 1 TID
 * đang uỷ cho NĐT → bot SigMa tự đăng lại ẢNH + tóm tắt OCR vào nhóm NĐT. BEST-EFFORT tuyệt đối: KHÔNG BAO GIỜ
 * throw (mọi lỗi log rõ rồi trả {crossPosted:false}). Idempotent qua marker alphaCrossPostSourceId. */
export async function crossPostBillToInvestor(db: Db, message: CrossPostSourceMessage): Promise<CrossPostResult> {
  try {
    // 1. CHỈ tin ảnh có đính kèm + do 1 đại lý thật gửi (senderId != null).
    if (message.kind !== 'IMAGE' || !message.attachmentId || message.senderId == null) {
      return { crossPosted: false, reason: 'NOT_IMAGE_MESSAGE' };
    }
    const meta = parseBillMeta(message.metadataJson);
    if (!meta || meta.isBillImage !== true) {
      return { crossPosted: false, reason: 'NOT_BILL' };
    }
    // Chống vòng lặp: tin ĐÃ là bản đẩy của bot (có marker) thì KHÔNG đẩy tiếp.
    if (meta.alphaCrossPostSourceId) {
      return { crossPosted: false, reason: 'ALREADY_CROSSPOST' };
    }
    const tidStr = meta.billFields?.tid?.value?.trim();
    if (!tidStr) {
      return { crossPosted: false, reason: 'NO_TID' };
    }

    // 2. TID có thuộc khách của phòng + uỷ NĐT có nhóm? Không → bỏ (im lặng). Dùng roomId phòng GỬI bill (scope
    //    khách), KHÔNG dùng senderId (gate tid.agentId cũ đã chết — xem resolveInvestorRoomForTid).
    const roomId = await resolveInvestorRoomForTid(db, message.roomId, tidStr);
    if (!roomId) {
      return { crossPosted: false, reason: 'NO_INVESTOR_ROOM' };
    }
    // Phòng NĐT phải còn tồn tại (chưa giải tán/xóa mềm) — fail-closed.
    const room = await db.chatRoom.findFirst({ where: { id: roomId, deletedAt: null }, select: { id: true } });
    if (!room) {
      return { crossPosted: false, reason: 'ROOM_MISSING' };
    }

    // 3. DEDUPE — đã đẩy bill này vào phòng đó chưa (marker alphaCrossPostSourceId=<bill id> trong metadataJson).
    const marker = `"alphaCrossPostSourceId":${JSON.stringify(message.id)}`;
    const existing = await db.chatMessage.findFirst({
      where: { roomId, metadataJson: { contains: marker } },
      select: { id: true }
    });
    if (existing) {
      return { crossPosted: false, reason: 'DEDUPE' };
    }

    // 4. Đảm bảo bot + thành viên phòng + copy ảnh + gửi.
    const bot = await ensureAlphaBotAgent(db);
    await ensureBotMembership(db, roomId, bot.id);
    const newAttachmentId = await copyBillAttachment(db, message.attachmentId, bot.id);
    if (!newAttachmentId) {
      return { crossPosted: false, reason: 'ATTACHMENT_COPY_FAILED' };
    }

    const summary = buildBillSummary(tidStr, meta);
    // Metadata bản đẩy: CHỈ isBillImage (để client render khung bill) + marker dedupe. TUYỆT ĐỐI KHÔNG kèm
    // billFields/billAmount nội bộ khác (số tiền đã nằm trong ẢNH + dòng tóm tắt; không nhồi thêm dữ liệu).
    const crossMeta = JSON.stringify({ isBillImage: true, alphaCrossPostSourceId: message.id });

    const sent = await sendMessage(db, {
      roomId,
      senderId: bot.id,
      kind: 'IMAGE',
      body: summary,
      attachmentId: newAttachmentId,
      metadataJson: crossMeta
    });

    // Broadcast realtime cho ai đang xem nhóm NĐT (fire-and-forget — broadcastToRoom KHÔNG BAO GIỜ throw).
    broadcastToRoom(roomId, { msg: 'new-message', roomId, message: sent });

    return { crossPosted: true, roomId, messageId: sent.id };
  } catch (err) {
    // R198 — lỗi hook KHÔNG được chặn luồng gửi tin chính; log rõ để điều tra, trả kết quả "không đẩy".
    console.error('[investor-crosspost] crossPostBillToInvestor lỗi (best-effort, KHÔNG chặn gửi bill chính):', err);
    return { crossPosted: false, reason: 'ERROR' };
  }
}
