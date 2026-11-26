// Chuẩn hoá ảnh Zalo → PNG cho OCR. Zalo (25/8) lưu ảnh dạng JXL (JPEG XL codestream, magic ff 0a) — sharp
// KHÔNG hỗ trợ JXL (đã kiểm chứng: "unsupported image format"). Dùng @jsquash/jxl (WASM, không cần native) để
// decode JXL → RGBA rồi sharp raw → PNG. Ảnh jpg/png/webp: sharp đọc thẳng → PNG. Endpoint nhận buffer đồng nhất
// PNG (cùng cách băm hash dedup).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import decodeJxl, { init as initJxlDecode } from '@jsquash/jxl/decode.js';

const require = createRequire(import.meta.url);

let jxlReady = null;
/** Nạp WASM decoder JXL 1 lần (Node không tự fetch được WASM qua mạng → phải compile từ file trong package). */
async function ensureJxl() {
  if (!jxlReady) {
    jxlReady = (async () => {
      const wasmPath = require.resolve('@jsquash/jxl/codec/dec/jxl_dec.wasm');
      const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
      await initJxlDecode(mod);
    })();
  }
  return jxlReady;
}

const JXL_MAGIC_CODESTREAM = [0xff, 0x0a]; // JXL codestream thô
const JXL_MAGIC_CONTAINER = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20]; // ISOBMFF "JXL "

function looksLikeJxl(buf, ext) {
  if (ext === '.jxl') return true;
  if (buf.length >= 2 && buf[0] === JXL_MAGIC_CODESTREAM[0] && buf[1] === JXL_MAGIC_CODESTREAM[1]) return true;
  if (buf.length >= 8 && JXL_MAGIC_CONTAINER.every((b, i) => buf[i] === b)) return true;
  return false;
}

/** Đọc file ảnh (jxl/jpg/png/webp) → PNG buffer. Ném lỗi nếu không decode được (caller bắt, ghi log, bỏ qua file). */
export async function fileToPng(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  return bufferToPng(buf, ext);
}

/** Chuẩn hoá 1 BUFFER ảnh (jxl/jpg/png/webp) → PNG buffer — dùng cho ảnh UPLOAD (không có path trên đĩa).
 *  ext tuỳ chọn ('' = tự nhận JXL qua magic-bytes). Cùng đường xử lý fileToPng để hash/dedup đồng nhất. */
export async function bufferToPng(buf, ext = '') {
  if (looksLikeJxl(buf, ext)) {
    await ensureJxl();
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const img = await decodeJxl(ab); // { data: Uint8ClampedArray RGBA, width, height }
    if (!img || !img.width || !img.height) throw new Error('JXL decode rỗng');
    return await sharp(Buffer.from(img.data.buffer ?? img.data), {
      raw: { width: img.width, height: img.height, channels: 4 }
    })
      .png()
      .toBuffer();
  }

  // jpg/png/webp — sharp đọc thẳng.
  return await sharp(buf).png().toBuffer();
}

/** Buffer ảnh bất kỳ → JPEG preview downscale (cho UI hiện). Dùng sharp của gói này (bot-api import gián tiếp để
 *  tránh nạp binary sharp riêng của bot-api — binary đó lỗi DLOPEN trên win32). */
export async function bufferToPreviewJpeg(buf, maxSize = 1200, quality = 80) {
  const png = await bufferToPng(buf);
  return await sharp(png).resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer();
}

// Đường dẫn helper (dùng nơi khác nếu cần biết thư mục gói).
export const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
