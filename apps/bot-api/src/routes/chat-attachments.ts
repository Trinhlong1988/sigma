// SIGMA (27/7) — upload/tải file đính kèm chat THẬT. Chat message vẫn đi qua Rocket.Chat như trước
// (KHÔNG đổi) — 2 endpoint ở đây CHỈ lo phần lưu trữ file vật lý, KHÔNG tự gửi tin nhắn RC (client tự gọi
// sendMessage() hiện có SAU khi upload xong, xem apps/web-demo/src/lib/rc-realtime.ts uploadChatAttachment()).
//
// `requireSession` (session-middleware.ts, B39) — KHÔNG dùng `requireRcAuth` đã CẤM/deprecated theo
// BUGS_FIXED.md B39 (đọc thẳng WebSession cục bộ, không gọi mạng RC mỗi request — tránh rate-limit RC).
//
// busboy (KHÔNG multer — multer có nhiều CVE DoS còn mở tính tới 2026, busboy không có, xem package.json) —
// enforce giới hạn 50MB NGAY Ở TẦNG BUSBOY (limits.fileSize, event 'limit' trên file stream) — KHÔNG đợi
// buffer hết cả file vào RAM rồi mới kiểm cỡ sau (rủi ro memory exhaustion nếu client cố tình gửi file khổng
// lồ), dừng đọc stream ngay khi vượt ngưỡng.
import { createReadStream } from 'node:fs';
import busboy from 'busboy';
import { Router, type Request } from 'express';
import { asyncHandler } from '../async-handler.js';
import { requireSession } from '../session-middleware.js';
import { getBotDb } from '../db.js';
import { getWebSession, WEB_SESSION_COOKIE_NAME } from '../web-session-service.js';
import { getAttachmentFile, getAttachmentRow, saveAttachment, setAttachmentRoomId, MAX_ATTACHMENT_SIZE_BYTES } from '../chat-attachment-service.js';

export const chatAttachmentsRouter = Router();

type ParsedUpload = { ok: true; buffer: Buffer; fileName: string } | { ok: false; reason: 'NO_FILE' | 'TOO_LARGE' };

/** Parse đúng 1 file field từ multipart body — bọc busboy (callback-based) vào Promise cho `async` handler
 * dùng được (đúng khuôn asyncHandler toàn dự án). KHÔNG throw cho lỗi nghiệp vụ (thiếu file/quá cỡ) — trả
 * discriminated union, route tự map sang response phù hợp. */
function parseSingleFileUpload(req: Request): Promise<ParsedUpload> {
  return new Promise((resolvePromise) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES, files: 1 } });
    } catch (err) {
      console.error('[bot-api] chat-attachments: header multipart không hợp lệ:', err);
      resolvePromise({ ok: false, reason: 'NO_FILE' });
      return;
    }

    let fileFound = false;
    let tooLarge = false;
    let fileName = 'file';
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: ParsedUpload): void => {
      if (settled) return; // 'error' + 'close' có thể cùng bắn — chỉ resolve 1 lần.
      settled = true;
      resolvePromise(result);
    };

    bb.on('file', (_fieldName, stream, info) => {
      fileFound = true;
      fileName = info.filename || 'file';
      stream.on('data', (chunk: Buffer) => {
        if (!tooLarge) chunks.push(chunk);
      });
      stream.on('limit', () => {
        tooLarge = true;
      });
    });
    bb.on('error', (err) => {
      console.error('[bot-api] chat-attachments: lỗi parse multipart:', err);
      finish({ ok: false, reason: 'NO_FILE' });
    });
    bb.on('close', () => {
      if (!fileFound) return finish({ ok: false, reason: 'NO_FILE' });
      if (tooLarge) return finish({ ok: false, reason: 'TOO_LARGE' });
      finish({ ok: true, buffer: Buffer.concat(chunks), fileName });
    });

    req.pipe(bb);
  });
}

// POST /v1/chat/attachments — multipart field "file". {ok:true,data:{id,url}} thành công.
chatAttachmentsRouter.post(
  '/v1/chat/attachments',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const parsed = await parseSingleFileUpload(req);
    if (!parsed.ok) {
      if (parsed.reason === 'TOO_LARGE') {
        res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE', message: 'File vượt quá giới hạn 50MB.' });
        return;
      }
      res.status(400).json({ ok: false, error: 'NO_FILE', message: 'Thiếu file đính kèm trong yêu cầu.' });
      return;
    }

    const db = getBotDb();
    const result = await saveAttachment(db, parsed.buffer, parsed.fileName, req.agent!.id);
    if (!result.ok) {
      if (result.reason === 'FILE_TOO_LARGE') {
        res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE', message: 'File vượt quá giới hạn 50MB.' });
        return;
      }
      if (result.reason === 'EMPTY_FILE') {
        res.status(400).json({ ok: false, error: 'EMPTY_FILE', message: 'File rỗng, vui lòng chọn file khác.' });
        return;
      }
      res.status(400).json({
        ok: false,
        error: 'MIME_NOT_ALLOWED',
        message: 'Định dạng file không được hỗ trợ (chỉ nhận ảnh JPG/PNG/WEBP, PDF, hoặc Word/Excel .docx/.xlsx).'
      });
      return;
    }

    res.status(201).json({ ok: true, data: { id: result.id, url: `/v1/chat/attachments/${result.id}` } });
  })
);

/** Escape cho `Content-Disposition: ...; filename="..."` (ASCII fallback) — loại bỏ dấu ngoặc kép/xuống dòng
 * (header injection nếu không lọc), KHÔNG cần hỗ trợ unicode đầy đủ ở phần fallback này vì `filename*=UTF-8''`
 * (RFC 5987, thêm ngay sau) mới là phần trình duyệt hiện đại thực sự dùng để hiển thị tên có dấu tiếng Việt. */
function safeAsciiFileName(name: string): string {
  const stripped = name.replace(/["\r\n]/g, '_');
  // eslint-disable-next-line no-control-regex -- cố ý strip ký tự ngoài ASCII cho phần fallback thuần ASCII.
  return stripped.replace(/[^\x20-\x7e]/g, '_') || 'file';
}

// GET /v1/chat/attachments/:id — phục vụ file. Quyền xem (xem comment đầy đủ schema.prisma ChatAttachment):
//   - luôn cho phép chính uploaderId.
//   - roomId CHƯA set (mới upload, tin nhắn RC tham chiếu nó CHƯA gửi/CHƯA PATCH roomId) → CHỈ uploaderId.
//   - roomId ĐÃ set → xác thực THÊM: requester phải là thành viên phòng RC đó THẬT (gọi
//     `subscriptions.getOne?roomId=` bằng chính token RC của requester, KHÔNG suy đoán quyền theo agentId nào
//     khác — bot-api không có bảng room-membership riêng, RC là nguồn sự thật duy nhất, xem comment schema).
chatAttachmentsRouter.get(
  '/v1/chat/attachments/:id',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const row = await getAttachmentRow(db, req.params.id);
    if (!row) {
      res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy file đính kèm.' });
      return;
    }

    let authorized = row.uploader_id === req.agent!.id;
    if (!authorized && row.room_id) {
      authorized = await isRequesterRoomMember(req, row.room_id);
    }
    if (!authorized) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Bạn không có quyền xem file này.' });
      return;
    }

    const file = await getAttachmentFile(db, req.params.id);
    if (!file) {
      res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'File đã bị xóa khỏi máy chủ.' });
      return;
    }

    const isImage = file.mimeType.startsWith('image/');
    const disposition = isImage ? 'inline' : 'attachment';
    const encoded = encodeURIComponent(file.fileName);
    // LANE A Vòng 2 (3/8) — chống MIME sniffing: buộc trình duyệt tôn trọng Content-Type đã khai, KHÔNG tự
    // "đoán" file người dùng tải lên thành loại nguy hiểm hơn (vd HTML/JS trá hình → XSS lưu trữ khi phục vụ
    // inline). Áp cho MỌI response file bất kể ảnh hay tải về.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeAsciiFileName(file.fileName)}"; filename*=UTF-8''${encoded}`);
    createReadStream(file.filePath).pipe(res);
  })
);

/** Xác nhận requester đang là thành viên phòng `roomId`. Phase 3 (30/7, phát hiện lúc cutover UI): `roomId` giờ
 * có THỂ thuộc 1 trong 2 hệ — phòng chat MỚI (`chat_rooms`, cuid id) HOẶC phòng Rocket.Chat CŨ (id RC, chưa
 * cutover) — 2 hệ chạy SONG SONG (xem comment routes/chat.ts). Trước đây hàm này CHỈ kiểm qua RC
 * `subscriptions.getOne` — với phòng MỚI (id không tồn tại trong RC) luôn trả `success:false` → CHẶN NHẦM mọi
 * thành viên KHÔNG PHẢI người upload xem ảnh/file trong phòng mới (chỉ uploaderId lọt qua nhờ check riêng ở
 * GET handler, xem dưới). Fix: kiểm `chat_rooms` TRƯỚC (tra `ChatRoomMember` trực tiếp, KHÔNG throw — dùng
 * điều kiện thuần, KHÔNG gọi `assertActiveMember` vì hàm đó throw, không hợp hàm boolean này) — CHỈ fallback
 * sang RC khi `roomId` KHÔNG tồn tại trong `chat_rooms` (tức chắc chắn là phòng RC cũ). */
async function isRequesterRoomMember(req: Request, roomId: string): Promise<boolean> {
  const sessionId = req.cookies?.[WEB_SESSION_COOKIE_NAME] as string | undefined;
  if (!sessionId) return false;
  const db = getBotDb();
  const webSession = await getWebSession(db, sessionId);
  if (!webSession) return false;

  const newRoom = await db.chatRoom.findUnique({ where: { id: roomId }, select: { id: true, deletedAt: true } });
  if (newRoom) {
    // Audit độc lập 30/7 (LOW, cùng gốc với assertActiveMember() chat-room-service.ts): phòng đã xóa mềm
    // KHÔNG còn ai xem được file trong đó, dù ChatRoomMember row vẫn leftAt=null — nhất quán với getRoomDetail().
    if (newRoom.deletedAt !== null) return false;
    const agentId = req.agent?.id;
    if (agentId == null) return false;
    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId, agentId } } });
    return !!member && member.leftAt === null;
  }

  // 4/8 LOẠI RC — phiên độc lập RC (rcAuthToken/rcUserId null) KHÔNG kiểm được membership qua RC. Membership
  // phòng chat tự xây đã kiểm NỘI BỘ (chatRoomMember) ở trên; nhánh RC này chỉ còn cho phòng RC cũ. Thiếu token
  // RC → fail-closed (return false), KHÔNG gọi RC với header null.
  if (!webSession.rcAuthToken || !webSession.rcUserId) return false;
  const rcBaseUrl = process.env.RC_BASE_URL || 'https://chat.example.com';
  try {
    const rcRes = await fetch(`${rcBaseUrl}/api/v1/subscriptions.getOne?roomId=${encodeURIComponent(roomId)}`, {
      headers: { 'X-Auth-Token': webSession.rcAuthToken, 'X-User-Id': webSession.rcUserId }
    });
    if (!rcRes.ok) return false;
    const json = (await rcRes.json()) as { success?: boolean; subscription?: unknown };
    return json.success === true && !!json.subscription;
  } catch (err) {
    console.error('[bot-api] chat-attachments: lỗi kiểm tra thành viên phòng RC (fail-closed → từ chối):', err);
    return false;
  }
}

// PATCH /v1/chat/attachments/:id/room — {roomId} — gọi NGAY SAU khi client gửi tin nhắn RC marker thành công
// (xem uploadChatAttachment() phía web-demo), CHỈ chính uploaderId gắn được (xem setAttachmentRoomId comment).
chatAttachmentsRouter.patch(
  '/v1/chat/attachments/:id/room',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId.trim() : '';
    if (!roomId) {
      res.status(400).json({ ok: false, error: 'ROOM_ID_REQUIRED', message: 'Thiếu roomId.' });
      return;
    }
    const db = getBotDb();
    const updated = await setAttachmentRoomId(db, req.params.id, roomId, req.agent!.id);
    if (!updated) {
      res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy file đính kèm của bạn.' });
      return;
    }
    res.json({ ok: true, data: { id: req.params.id, roomId } });
  })
);
