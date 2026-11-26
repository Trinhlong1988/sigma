// SIGMA (27/7) — lưu trữ file đính kèm chat THẬT (ảnh/file). Chat message vẫn đi qua Rocket.Chat như
// trước (KHÔNG đổi transport) — file vật lý lưu RIÊNG ở bot-api (CHAT_UPLOADS_DIR), tin nhắn RC chỉ chứa 1
// dòng JSON marker trỏ tới attachment này qua `id` (xem rc-realtime.ts).
//
// QUAN TRỌNG — model `ChatAttachment` (schema.prisma) CHƯA từng `prisma generate`/`migrate deploy` lên DB
// production hay client dùng chung `packages/database/generated/prisma` (đúng CẤM tuyệt đối đầu nhiệm vụ —
// B37/B42 CHÍNH LÀ 2 sự cố production do generate lệch DB thật cùng ngày hôm nay). Vì vậy file này KHÔNG dùng
// API model Prisma thường (`db.chatAttachment.create(...)` — KHÔNG TỒN TẠI trên client hiện tại, sẽ vỡ tsc)
// mà dùng raw SQL tham số hoá (`db.$queryRaw`/`$executeRaw` tagged-template, CÙNG khuôn otp-service.ts đã
// dùng cho `FOR UPDATE` lock) — an toàn SQL injection (Prisma tự parameterize), KHÔNG phụ thuộc client đã
// generate biết về bảng `chat_attachments` hay chưa, tự nhiên hoạt động ngay khi LEAD áp migration thật lên
// DB (raw SQL chỉ cần bảng tồn tại, không cần model trong schema). Sau khi LEAD áp migration + generate lại
// (đúng quy trình an toàn — generate ra thư mục cô lập trước, xem B37 process-change), có thể cân nhắc đổi
// sang API model thường — KHÔNG bắt buộc, raw SQL vẫn đúng/an toàn vĩnh viễn.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileTypeFromBuffer } from 'file-type';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50MB (LEAD xác nhận).

// Allowlist file-sharing hợp lý (quyết định build, ghi rõ lý do — KHÔNG suy đoán spec cấm/cho phép thêm):
// - 3 định dạng ảnh phổ biến nhất (jpeg/png/webp) — đủ cho camera/thư viện ảnh điện thoại lẫn ảnh chụp màn
//   hình desktop, KHÔNG thêm gif/bmp/tiff (hiếm dùng trong nhu cầu "gửi ảnh trong chat đại lý").
// - application/pdf — hồ sơ/hóa đơn/hợp đồng scan, nhu cầu thực tế rõ ràng cho nghiệp vụ đại lý bán TID.
// - docx/xlsx (OOXML, magic-bytes = ZIP + cấu trúc nội bộ đặc trưng mà file-type phân biệt được CHÍNH XÁC
//   với .zip thường) — 2 định dạng văn phòng phổ biến nhất. CỐ Ý KHÔNG thêm .doc/.xls (định dạng CŨ, cùng
//   container nhị phân "OLE Compound File Binary" — file-type CHỈ phát hiện được chung chung
//   "application/x-cfb", KHÔNG phân biệt được Word/Excel/PowerPoint bằng magic-bytes thuần, nhận cả 3 loại
//   này vào allowlist dưới cùng 1 mime sẽ mất khả năng phân loại đúng — an toàn hơn là từ chối, người dùng
//   convert sang .docx/.xlsx hoặc .pdf nếu cần gửi).
// - .zip/.exe/script (rủi ro bảo mật, không có nhu cầu nghiệp vụ nêu ra) — CỐ Ý KHÔNG thêm.
//
// SIGMA (31/7, việc #5 — nối "ghi âm tin nhắn thoại" mục 37 THẬT, thay nút mock cũ) — thêm 1 dòng
// `'video/webm': 'webm'` cho voice message. ĐÃ TỰ KIỂM CHỨNG THẬT (KHÔNG suy đoán mime string theo tên gọi
// "audio/webm" trực giác — đúng R198/CẤM SUY LUẬN) bằng cách sinh 1 file WebM/Opus CHỈ CÓ audio (ffmpeg
// `-c:a libopus -f webm`, mô phỏng CHÍNH XÁC output thật của `MediaRecorder({mimeType:'audio/webm;codecs=opus'})`
// — mimeType ưu tiên #1 của `voice-recording.ts` trên Chromium/Android WebView) rồi chạy `fileTypeFromBuffer()`
// (ĐÚNG bản `file-type` 22.0.1 cài trong repo này) trên file đó: kết quả THẬT là
// `{"ext":"webm","mime":"video/webm"}` — KHÔNG PHẢI `audio/webm`. Đọc thẳng source `file-type` xác nhận nguyên
// nhân: detector EBML/WebM (`source/detectors/ebml.js`) CHỈ đọc field `DocType` ("webm"/"matroska") của
// container, KHÔNG hề phân tích track bên trong để phân biệt audio-only hay có video — nó LUÔN trả về
// `video/webm` cho MỌI file WebM bất kể track thật là gì. Thư viện này (mọi phiên bản, xem `supported.js`)
// KHÔNG CÓ mime `audio/webm` trong danh sách hỗ trợ. Vì vậy allowlist PHẢI ghi `video/webm` (mime THẬT sẽ
// được detect) — ghi `audio/webm` (theo trực giác/tên MediaRecorder dùng) sẽ khiến MỌI voice message bị từ
// chối MIME_NOT_ALLOWED vĩnh viễn (mime detect được không bao giờ khớp allowlist).
// ĐÁNH ĐỔI ĐÃ BIẾT (ghi rõ, không giấu): endpoint này DÙNG CHUNG cho ảnh/file/voice — thêm `video/webm` cũng
// đồng nghĩa 1 file .webm VIDEO thật (không phải ghi âm) cũng sẽ lọt qua allowlist nếu ai đó gửi thẳng qua
// API (client UI "Đính kèm file" hiện chỉ gợi ý .pdf/.docx/.xlsx qua `FILE_ACCEPT`, không đổi — nhưng đó chỉ
// là gợi ý picker, KHÔNG phải lớp chặn, xem comment MessageComposer.tsx). Chấp nhận được vì: (1) không có mime
// nào khác để phân biệt audio-only WebM theo magic-bytes thuần với thư viện hiện có, (2) cùng giới hạn 50MB +
// KHÔNG có nhu cầu bảo mật đặc biệt chặn riêng .webm video (khác hẳn .exe/.zip — không phải rủi ro thực thi
// mã) — CHƯA thử `audio/mp4` (Safari/iOS fallback trong `voice-recording.ts`): tự kiểm chứng THẬT bằng ffmpeg
// (`-c:a aac -f mp4 -movflags frag_keyframe+empty_moov`, mô phỏng output MediaRecorder Safari) → kết quả
// `{"ext":"mp4","mime":"video/mp4"}` — CÙNG hạn chế (không phân biệt audio/video), và ngoài phạm vi (nền tảng
// mục tiêu hiện tại là Android WebView/Chromium, ưu tiên #1 luôn là webm — xem PREFERRED_MIME_TYPES
// voice-recording.ts) — KHÔNG thêm `video/mp4` vào allowlist đợt này (mở rộng thêm rủi ro cho phép mp4 video
// thật mà KHÔNG có nhu cầu nghiệp vụ tương ứng ngay bây giờ, để dành nếu sau này build iOS thật).
export const ALLOWED_MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'video/webm': 'webm'
});

function isAllowedMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME_TO_EXT, mime);
}

/** Thư mục lưu file — đọc `process.env.CHAT_UPLOADS_DIR` LÚC GỌI (không lúc import module), cùng nguyên tắc
 * `getBotDb()` (test/global-setup.ts đổi env trước khi gọi phải ăn đúng giá trị mới). Tương đối → resolve so
 * với thư mục gốc `apps/bot-api` (KHÔNG so với cwd tuỳ tiến trình gọi từ đâu — tsx watch/vitest có thể có cwd
 * khác nhau). */
function uploadsDir(): string {
  const configured = process.env.CHAT_UPLOADS_DIR || './uploads/chat';
  if (resolve(configured) === configured) return configured; // đã là đường dẫn tuyệt đối.
  const here = dirname(fileURLToPath(import.meta.url)); // apps/bot-api/src
  const botApiRoot = join(here, '..'); // apps/bot-api
  return resolve(botApiRoot, configured);
}

export type SaveAttachmentResult =
  | { ok: true; id: string; mimeType: string; sizeBytes: number }
  | { ok: false; reason: 'EMPTY_FILE' }
  | { ok: false; reason: 'FILE_TOO_LARGE' }
  | { ok: false; reason: 'MIME_NOT_ALLOWED'; detectedMime: string | null };

/** Lưu 1 file đính kèm chat: kiểm cỡ → sniff magic-bytes THẬT (KHÔNG tin Content-Type/tên file client gửi) →
 * kiểm allowlist → sha256 → ghi đĩa dưới tên `<uuid>.<ext theo mime THẬT>` (KHÔNG BAO GIỜ dùng originalFileName
 * cho đường dẫn vật lý — path traversal risk, xem comment schema.prisma) → insert row DB → trả metadata.
 * KHÔNG throw cho các kết quả nghiệp vụ mong đợi (quá cỡ/sai loại) — trả `{ok:false,reason}`, đúng convention
 * dự án (xem otp-service.ts/device-trust-service.ts). Chỉ throw cho lỗi hệ thống thật (ghi đĩa lỗi/DB lỗi). */
export async function saveAttachment(
  db: Db,
  buffer: Buffer,
  originalFileName: string,
  uploaderId: number
): Promise<SaveAttachmentResult> {
  if (buffer.length === 0) return { ok: false, reason: 'EMPTY_FILE' };
  if (buffer.length > MAX_ATTACHMENT_SIZE_BYTES) return { ok: false, reason: 'FILE_TOO_LARGE' };

  const detected = await fileTypeFromBuffer(buffer);
  const mimeType = detected?.mime ?? null;
  if (!mimeType || !isAllowedMime(mimeType)) {
    return { ok: false, reason: 'MIME_NOT_ALLOWED', detectedMime: mimeType };
  }

  const ext = ALLOWED_MIME_TO_EXT[mimeType];
  const id = randomUUID(); // id cột `id` (TEXT) — KHÔNG qua Prisma model API nên default cuid() không tự áp
  // dụng được (đó là hành vi client-side của Prisma Client generated, raw SQL bỏ qua) — dùng UUID ngẫu nhiên
  // CSPRNG (crypto.randomUUID, Node built-in) làm khóa chính thay thế, tương đương về entropy/không đoán được.
  const diskFileName = `${randomUUID()}.${ext}`; // TÁCH RIÊNG khỏi `id` DB — 2 giá trị ngẫu nhiên độc lập, dù
  // trùng cũng không ảnh hưởng gì (khác namespace: 1 là khóa DB, 1 là tên file đĩa) nhưng tách rõ ràng cho dễ
  // đọc code hơn là tái dùng chung 1 uuid cho cả hai.
  const checksum = createHash('sha256').update(buffer).digest('hex');

  const dir = uploadsDir();
  await mkdir(dir, { recursive: true });
  const storagePath = diskFileName; // TƯƠNG ĐỐI dưới CHAT_UPLOADS_DIR (đúng spec schema.prisma comment) — path
  // tuyệt đối tự resolve lại ở getAttachmentFile()/uploadsDir(), không lưu absolute path (đổi máy/đổi
  // CHAT_UPLOADS_DIR vẫn đọc lại đúng).
  await writeFile(join(dir, diskFileName), buffer);

  const safeName = originalFileName.slice(0, 500); // giới hạn hợp lý, tránh tên file quá dài bất thường.
  await db.$executeRaw`
    INSERT INTO chat_attachments (id, uploader_id, file_name, mime_type, size_bytes, checksum, storage_path)
    VALUES (${id}, ${uploaderId}, ${safeName}, ${mimeType}, ${buffer.length}, ${checksum}, ${storagePath})
  `;

  return { ok: true, id, mimeType, sizeBytes: buffer.length };
}

interface ChatAttachmentRow {
  id: string;
  uploader_id: number;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  storage_path: string;
  room_id: string | null;
  created_at: Date;
}

/** Đọc thẳng 1 row (KHÔNG resolve path đĩa) — dùng cho kiểm quyền (uploaderId/roomId) trước khi quyết định có
 * phục vụ file hay không, xem routes/chat-attachments.ts GET handler. */
export async function getAttachmentRow(db: Db, attachmentId: string): Promise<ChatAttachmentRow | null> {
  const rows = await db.$queryRaw<ChatAttachmentRow[]>`
    SELECT id, uploader_id, file_name, mime_type, size_bytes, checksum, storage_path, room_id, created_at
    FROM chat_attachments WHERE id = ${attachmentId}
  `;
  return rows[0] ?? null;
}

/** Metadata + đường dẫn TUYỆT ĐỐI thật trên đĩa để phục vụ file (route tự `res.sendFile`/stream) — trả `null`
 * nếu không tìm thấy row HOẶC file đã biến mất khỏi đĩa (kiểm tồn tại thật bằng `readFile` catch, KHÔNG chỉ
 * tin DB — tránh 500 lỗi lạ nếu ai đó dọn tay thư mục uploads). */
export async function getAttachmentFile(db: Db, attachmentId: string): Promise<{ filePath: string; mimeType: string; fileName: string } | null> {
  const row = await getAttachmentRow(db, attachmentId);
  if (!row) return null;
  const filePath = join(uploadsDir(), row.storage_path);
  try {
    await readFile(filePath); // xác nhận đọc được thật — ném nếu thiếu quyền/không tồn tại, bắt ở dưới.
  } catch {
    return null;
  }
  return { filePath, mimeType: row.mime_type, fileName: row.file_name };
}

/** Gắn `roomId` cho 1 attachment SAU KHI tin nhắn RC tham chiếu nó đã gửi thành công (xem comment schema.prisma
 * — attachment tải lên TRƯỚC khi biết thuộc phòng nào). CHỈ chính uploaderId mới gắn được (chặn 1 agent gán
 * bừa roomId cho attachment KHÔNG PHẢI của mình — dù id ngẫu nhiên khó đoán, vẫn kiểm rõ ràng, không tin
 * riêng "biết id là đủ quyền"). Trả `false` nếu không tìm thấy/không phải chủ sở hữu — KHÔNG throw (nghiệp vụ
 * mong đợi). */
export async function setAttachmentRoomId(db: Db, attachmentId: string, roomId: string, requesterAgentId: number): Promise<boolean> {
  const row = await getAttachmentRow(db, attachmentId);
  if (!row || row.uploader_id !== requesterAgentId) return false;
  // FIX membership-gate (12/8) — TRƯỚC ĐÂY chỉ kiểm uploader → 1 agent gắn được attachment của MÌNH vào phòng
  // mình KHÔNG thuộc (rồi thành viên phòng đó tải được file, hoặc "đẩy" file rác vào phòng lạ). Bịt: requester
  // PHẢI là thành viên đang hoạt động của phòng ĐÍCH, phòng chưa xóa mềm (fail-closed). Mirror ĐÚNG logic dual-
  // system của routes/chat-attachments.ts isRequesterRoomMember(): phòng thuộc hệ chat mới (`chat_rooms`) →
  // kiểm chat_room_members thật; phòng KHÔNG có trong chat_rooms (id RC cũ, chưa cutover) → không kiểm được
  // membership ở service này, GIỮ hành vi cũ (chỉ uploader) để không phá luồng RC legacy còn sót. Raw SQL để
  // đồng nhất phong cách file này + không phụ thuộc model generate (xem comment đầu file).
  const roomRows = await db.$queryRaw<Array<{ deleted_at: Date | null }>>`
    SELECT deleted_at FROM chat_rooms WHERE id = ${roomId} LIMIT 1
  `;
  if (roomRows.length > 0) {
    if (roomRows[0].deleted_at !== null) return false; // phòng đã xóa mềm — fail-closed.
    const memberRows = await db.$queryRaw<Array<{ left_at: Date | null }>>`
      SELECT left_at FROM chat_room_members WHERE room_id = ${roomId} AND agent_id = ${requesterAgentId} LIMIT 1
    `;
    if (memberRows.length === 0 || memberRows[0].left_at !== null) return false; // không phải thành viên đang hoạt động.
  }
  await db.$executeRaw`UPDATE chat_attachments SET room_id = ${roomId} WHERE id = ${attachmentId}`;
  return true;
}

/** FIX thu-hồi-tin-ảnh (12/8) — khi 1 tin nhắn CÓ đính kèm bị thu hồi (soft-delete), attachment vật lý + row
 * `chat_attachments` TRƯỚC ĐÂY vẫn còn → (a) file vẫn TẢI được qua GET /v1/chat/attachments/:id (uploader luôn
 * qua cửa, thành viên phòng vẫn qua vì room_id còn set) dù tin đã "thu hồi", (b) file vật lý nằm lại làm rác
 * đĩa vĩnh viễn. Hàm này: xóa HẲN row DB (getAttachmentRow → null → route trả 404 cho MỌI người, kể cả uploader)
 * + unlink file vật lý (best-effort — lỗi unlink KHÔNG chặn xóa tin, chỉ log rõ theo R198, ENOENT coi như đã
 * sạch). Gọi từ deleteMessage() SAU khi đã kiểm KHÔNG còn tin CHƯA-XÓA nào khác trỏ tới attachment này (an toàn
 * với trường hợp cùng 1 file gắn vào nhiều tin). KHÔNG throw cho lỗi nghiệp vụ (attachment đã biến mất → no-op). */
export async function deleteAttachmentAndFile(db: Db, attachmentId: string): Promise<void> {
  const row = await getAttachmentRow(db, attachmentId);
  if (!row) return; // đã xóa từ trước — idempotent.
  await db.$executeRaw`DELETE FROM chat_attachments WHERE id = ${attachmentId}`;
  try {
    await unlink(join(uploadsDir(), row.storage_path));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      // R198 — KHÔNG nuốt lỗi im: row DB đã xóa nhưng file vật lý còn → cảnh báo rõ để dọn tay, KHÔNG làm sập
      // luồng thu hồi tin (quyền tải đã bị gỡ ở tầng DB, rác đĩa là hệ quả phụ chấp nhận được tạm thời).
      console.error(`[chat-attachment-service] deleteAttachmentAndFile: KHÔNG xóa được file vật lý storage_path=${row.storage_path} cho attachment id=${attachmentId} (row DB đã xóa, quyền tải đã gỡ; file rác cần dọn tay):`, err);
    }
  }
}
