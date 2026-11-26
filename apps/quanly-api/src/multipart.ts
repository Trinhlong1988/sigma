// Parse "đúng 1 file multipart" cho route upload ảnh đính kèm (dossier/receive-account). TÁI DÙNG cách làm ĐÃ
// CHỨNG MINH của apps/bot-api/src/multipart-upload.ts (busboy, callback→Promise, discriminated union, KHÔNG
// throw cho lỗi nghiệp vụ) — bot-api dùng busboy chứ KHÔNG multer, và busboy đã có sẵn (transitive dep, 1.6.0)
// nên KHÔNG cần thêm dependency/npm install nào. KHÁC bản bot-api ở 1 điểm: GIỮ LẠI `fieldName` (bot-api bỏ) —
// route dossier phân biệt mặt ảnh (dkkdFront/dkkdBack/cccdFront/cccdBack) qua CHÍNH tên field multipart.
//
// express.json() (app.ts) chỉ đọc body cho content-type application/json → request multipart/form-data đi
// THẲNG xuống route mà stream chưa bị tiêu thụ, busboy đọc req.pipe được (cùng lý do bot-api hoạt động).
import busboy from 'busboy';
import type { Request } from 'express';

export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // ~10MB (ảnh chụp CCCD/ĐKKD bằng điện thoại)

export type ParsedUpload =
  | { ok: true; buffer: Buffer; fieldName: string; fileName: string }
  | { ok: false; reason: 'NO_FILE' | 'TOO_LARGE' };

/** Parse đúng 1 file field từ multipart body. KHÔNG throw cho lỗi nghiệp vụ (thiếu file/quá cỡ) — trả union. */
export function parseSingleUpload(req: Request): Promise<ParsedUpload> {
  return new Promise((resolvePromise) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_SIZE_BYTES, files: 1 } });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[quanly-api] multipart: header multipart không hợp lệ:', err);
      resolvePromise({ ok: false, reason: 'NO_FILE' });
      return;
    }

    let fileFound = false;
    let tooLarge = false;
    let fieldName = '';
    let fileName = 'file';
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: ParsedUpload): void => {
      if (settled) return; // 'error' + 'close' có thể cùng bắn — chỉ resolve 1 lần.
      settled = true;
      resolvePromise(result);
    };

    bb.on('file', (name, stream, info) => {
      fileFound = true;
      fieldName = name;
      fileName = info.filename || 'file';
      stream.on('data', (chunk: Buffer) => {
        if (!tooLarge) chunks.push(chunk);
      });
      stream.on('limit', () => {
        tooLarge = true;
      });
    });
    bb.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[quanly-api] multipart: lỗi parse multipart:', err);
      finish({ ok: false, reason: 'NO_FILE' });
    });
    bb.on('close', () => {
      if (!fileFound) return finish({ ok: false, reason: 'NO_FILE' });
      if (tooLarge) return finish({ ok: false, reason: 'TOO_LARGE' });
      finish({ ok: true, buffer: Buffer.concat(chunks), fieldName, fileName });
    });

    req.pipe(bb);
  });
}
