// SIGMA (31/7) — Bản DÙNG CHUNG của logic parse "đúng 1 file multipart" đã có sẵn trong
// routes/chat-attachments.ts (parseSingleFileUpload nội bộ, không export) — COPY Y HỆT logic (busboy,
// callback→Promise, discriminated union, KHÔNG throw cho lỗi nghiệp vụ) sang file riêng để route OCR preview
// dùng được mà KHÔNG sửa chat-attachments.ts (đúng phạm vi B71 phần 2: không đụng file ngoài danh sách giao).
//
// Giới hạn cỡ RIÊNG cho ảnh OCR (10MB, đủ cho ảnh chụp bill bằng điện thoại) — KHÔNG dùng chung hằng số 50MB
// của chat-attachments.ts (MAX_ATTACHMENT_SIZE_BYTES) vì đây là mục đích khác (ảnh chụp bill, không phải file
// đính kèm chat chung chung).
import busboy from 'busboy';
import type { Request } from 'express';

export const MAX_OCR_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export type ParsedSingleFileUpload =
  | { ok: true; buffer: Buffer; fileName: string }
  | { ok: false; reason: 'NO_FILE' | 'TOO_LARGE' };

/** Parse đúng 1 file field từ multipart body — bọc busboy (callback-based) vào Promise cho `async` handler
 * dùng được (đúng khuôn asyncHandler toàn dự án). KHÔNG throw cho lỗi nghiệp vụ (thiếu file/quá cỡ) — trả
 * discriminated union, route tự map sang response phù hợp. CÙNG logic parseSingleFileUpload nội bộ của
 * routes/chat-attachments.ts, chỉ đổi giới hạn cỡ (MAX_OCR_IMAGE_SIZE_BYTES thay vì MAX_ATTACHMENT_SIZE_BYTES). */
export function parseSingleFileUpload(req: Request): Promise<ParsedSingleFileUpload> {
  return new Promise((resolvePromise) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_OCR_IMAGE_SIZE_BYTES, files: 1 } });
    } catch (err) {
      console.error('[bot-api] multipart-upload: header multipart không hợp lệ:', err);
      resolvePromise({ ok: false, reason: 'NO_FILE' });
      return;
    }

    let fileFound = false;
    let tooLarge = false;
    let fileName = 'file';
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: ParsedSingleFileUpload): void => {
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
      console.error('[bot-api] multipart-upload: lỗi parse multipart:', err);
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
