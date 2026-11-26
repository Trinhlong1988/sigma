// SIGMA (1/8, mục 39 mở rộng — "Hồ sơ của tôi") — lưu/đọc avatar + ảnh bìa THẬT của Agent, thay Phase 0
// mock đổi màu/gradient cục bộ ở ProfileScreen.tsx (KHÔNG upload, mất khi reload). BLOB thẳng trong hàng Agent
// (cột avatarImage/avatarImageMime/avatarUpdatedAt + coverImage/coverImageMime/coverUpdatedAt, schema.prisma),
// CÙNG TIỀN LỆ qrImage đã có — xem comment schema.prisma cho lý do đầy đủ (bot-api có thể khác máy, đọc được
// mà không chung <userData> với Electron client). File RIÊNG (không nhét vào chat-attachment-service.ts) vì
// đây là 2 khái niệm khác hẳn: chat-attachment lưu FILE TRÊN ĐĨA + row metadata (ChatAttachment model), avatar
// là 1 CỘT BLOB trực tiếp trên Agent — sai khác đủ lớn để tách file, tránh 1 file gánh 2 mô hình lưu trữ khác
// nhau (đúng convention "route mỏng, service dày" — service dày CHO TỪNG mô hình, không gộp).
import { fileTypeFromBuffer } from 'file-type';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

// 5MB — nhỏ hơn giới hạn OCR bill (10MB, multipart-upload.ts MAX_OCR_IMAGE_SIZE_BYTES) vì avatar/bìa hiển thị
// thumbnail/khối nhỏ trên UI, không cần giữ ảnh gốc siêu to như ảnh chụp bill cần đọc rõ chữ số OCR. Route gọi
// parseSingleFileUpload() (multipart-upload.ts) VẪN dùng ceiling busboy chung 10MB (bảo vệ RAM tầng transport,
// KHÔNG parameterize theo mục đích — xem comment routes/me.ts) — giới hạn 5MB THẬT SỰ cho avatar/bìa enforce
// Ở ĐÂY, tầng business, sau khi buffer đã có trong RAM.
export const MAX_AGENT_MEDIA_SIZE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type AgentMediaKind = 'avatar' | 'cover';

export type SaveAgentMediaResult =
  | { ok: true }
  | { ok: false; reason: 'EMPTY_FILE' }
  | { ok: false; reason: 'FILE_TOO_LARGE' }
  | { ok: false; reason: 'MIME_NOT_ALLOWED'; detectedMime: string | null };

/** Lưu avatar/bìa cho agentId: kiểm cỡ (5MB) → sniff magic-bytes THẬT (KHÔNG tin Content-Type/tên file client
 * gửi, CÙNG nguyên tắc saveAttachment() chat-attachment-service.ts) → allowlist jpeg/png/webp → ghi BLOB +
 * mime + updatedAt vào ĐÚNG 3 cột theo `kind` (avatar* hoặc cover*, KHÔNG đụng 3 cột còn lại). KHÔNG throw cho
 * kết quả nghiệp vụ mong đợi (quá cỡ/sai loại) — trả `{ok:false,reason}`, đúng convention dự án. */
export async function saveAgentMedia(db: Db, agentId: number, kind: AgentMediaKind, buffer: Buffer): Promise<SaveAgentMediaResult> {
  if (buffer.length === 0) return { ok: false, reason: 'EMPTY_FILE' };
  if (buffer.length > MAX_AGENT_MEDIA_SIZE_BYTES) return { ok: false, reason: 'FILE_TOO_LARGE' };

  const detected = await fileTypeFromBuffer(buffer);
  const mimeType = detected?.mime ?? null;
  if (!mimeType || !ALLOWED_MIMES.has(mimeType)) {
    return { ok: false, reason: 'MIME_NOT_ALLOWED', detectedMime: mimeType };
  }

  const now = new Date();
  // Prisma 7 Bytes field kỳ vọng đúng `Uint8Array<ArrayBuffer>` — `Buffer` khai báo buffer nền `ArrayBufferLike`
  // (gồm cả SharedArrayBuffer) nên không thỏa mãn structurally, dù runtime Buffer LÀ Uint8Array thật. Copy sang
  // Uint8Array mới (backing luôn là ArrayBuffer thường theo overload constructor) thay vì ép kiểu `as any`.
  const bytes = new Uint8Array(buffer);
  if (kind === 'avatar') {
    await db.agent.update({ where: { id: agentId }, data: { avatarImage: bytes, avatarImageMime: mimeType, avatarUpdatedAt: now } });
  } else {
    await db.agent.update({ where: { id: agentId }, data: { coverImage: bytes, coverImageMime: mimeType, coverUpdatedAt: now } });
  }
  return { ok: true };
}

export interface AgentMediaFile {
  buffer: Buffer;
  mimeType: string;
}

/** Đọc avatar/bìa của agentId — dùng cho GET /v1/agents/:id/avatar|cover (BẤT KỲ agent nào đã đăng nhập được
 * xem, không chỉ chủ sở hữu — avatar là thông tin công khai trong app này, xem comment routes/me.ts). `null`
 * nếu agent không tồn tại/đã xóa mềm HOẶC chưa cấu hình ảnh — route tự map sang 404, KHÔNG phân biệt 2
 * trường hợp (tránh xác nhận sự tồn tại của agentId cho request không hợp lệ). */
export async function getAgentMedia(db: Db, agentId: number, kind: AgentMediaKind): Promise<AgentMediaFile | null> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    select:
      kind === 'avatar'
        ? { avatarImage: true, avatarImageMime: true }
        : { coverImage: true, coverImageMime: true }
  });
  if (!agent) return null;

  const image = kind === 'avatar' ? (agent as { avatarImage?: Uint8Array | null }).avatarImage : (agent as { coverImage?: Uint8Array | null }).coverImage;
  const mime = kind === 'avatar' ? (agent as { avatarImageMime?: string | null }).avatarImageMime : (agent as { coverImageMime?: string | null }).coverImageMime;
  if (!image || image.length === 0) return null;
  return { buffer: Buffer.from(image), mimeType: mime ?? 'image/jpeg' };
}

/** Tên hiển thị của agent (để render chữ cái đầu cho avatar fallback khi chưa có ảnh, xem fallback-avatar.ts).
 * `null` nếu agent không tồn tại / đã xóa mềm — route sẽ dùng '?' (KHÔNG lộ thêm thông tin, chỉ 1 ô màu). */
export async function getAgentDisplayName(db: Db, agentId: number): Promise<string | null> {
  const agent = await db.agent.findFirst({ where: { id: agentId, deletedAt: null }, select: { name: true } });
  return agent?.name ?? null;
}
