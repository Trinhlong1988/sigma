// LAG-FIX v2 (Admin Demo 12/8 — "gửi ảnh phải MƯỢT hẳn, xoá stall main-thread lúc gửi") — LÕI dùng CHUNG cho
// cả Web Worker (image-resize.worker.ts) LẪN nhánh dự phòng main-thread (image-resize.ts). Tách ra module
// KHÔNG tham chiếu Worker để tránh chu trình import (worker import core, image-resize import core) và để
// cùng 1 đoạn encode chạy y hệt ở 2 nơi (worker = KHÔNG chặn UI; fallback = như bản cũ nếu môi trường thiếu
// Worker/OffscreenCanvas).
//
// VÌ SAO cần Worker: đo THẬT trên emulator GPU-phần-mềm cho thấy `createImageBitmap` + `OffscreenCanvas`
// vẫn để bước ENCODE (convertToBlob) chặn main-thread ~370ms → UI giật lúc bấm gửi. Dời TOÀN BỘ decode +
// draw + encode vào Worker → main-thread rảnh, chỉ còn postMessage (clone Blob rẻ, không copy dữ liệu ảnh).
//
// AN TOÀN: mọi hàm ở đây trả `null` khi KHÔNG resize (đã đủ nhỏ / môi trường thiếu API / lỗi decode-encode).
// Caller (resizeImageForUpload) hiểu null = "giữ file gốc", KHÔNG bao giờ chặn việc gửi.

/** Cạnh dài tối đa (px) sau khi thu nhỏ ảnh "Ảnh" thường trước upload. 2000px: đủ nét cho ảnh chat + đọc
 * được bill bằng mắt nếu lỡ gửi qua nút Ảnh thường, KHÔNG nhỏ hơn (tránh mờ). */
export const MAX_UPLOAD_IMAGE_EDGE = 2000;

/** Chất lượng JPEG khi re-encode ảnh đã thu nhỏ (khớp screen-capture.ts + Camera.getPhoto quality:85). */
export const UPLOAD_IMAGE_JPEG_QUALITY = 0.85;

export interface ResizeDimensions {
  width: number;
  height: number;
  /** true = cần thu nhỏ (cạnh dài > maxEdge); false = giữ nguyên (đã đủ nhỏ / kích thước không hợp lệ). */
  resized: boolean;
}

/** HÀM THUẦN (test được ở env node, KHÔNG DOM) — tính kích thước đích giữ ĐÚNG TỈ LỆ, cạnh dài = maxEdge.
 * KHÔNG BAO GIỜ phóng to (cạnh dài ≤ maxEdge → resized:false, giữ nguyên). Kích thước không hợp lệ
 * (0/âm/NaN/Infinity) → resized:false (caller trả file gốc, không đụng canvas). */
export function computeResizedDimensions(width: number, height: number, maxEdge: number): ResizeDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || maxEdge <= 0) {
    return { width, height, resized: false };
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height, resized: false };
  const scale = maxEdge / longEdge;
  // Math.round + max(1,...) — tránh ra 0px ở cạnh ngắn với ảnh cực dẹt (vd 4000×3 → cạnh ngắn round về 1, không 0).
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true
  };
}

/** Chỉ re-encode các loại ảnh raster phổ biến. Bỏ qua GIF (có thể là ảnh động — resize 1 khung sẽ mất động),
 * SVG (vector, không có "độ phân giải" để thu nhỏ theo pixel), và mọi loại khác → trả file gốc. */
export function isResizableImageType(type: string): boolean {
  return type === 'image/jpeg' || type === 'image/png' || type === 'image/webp';
}

/** Đổi đuôi tên file sang .jpg (đã re-encode JPEG) — giữ phần tên gốc để người nhận vẫn nhận ra. */
export function toJpgFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.jpg`;
}

/** Vẽ bitmap xuống canvas kích thước đích rồi encode JPEG. Chạy được CẢ trong Worker (chỉ nhánh OffscreenCanvas)
 * LẪN main-thread (fallback <canvas>). OffscreenCanvas ưu tiên (encode NGOÀI luồng UI khi ở main; và là cách
 * DUY NHẤT trong Worker vì Worker không có `document`). NỀN TRẮNG trước khi vẽ — ảnh PNG/webp có alpha khi
 * đổi sang JPEG sẽ thành nền đen nếu không tô trắng (JPEG không có kênh alpha). Trả null nếu không lấy được
 * 2D context / không có canvas khả dụng. */
export async function drawBitmapToJpegBlob(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number
): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  // Không có OffscreenCanvas → chỉ chạy được ở main-thread (có `document`). Trong Worker sẽ trả null → caller
  // tự lùi về nhánh main-thread.
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

/** LÕI encode dùng chung: decode `source` (Blob/File) → nếu cạnh dài > maxEdge thì vẽ + encode JPEG, trả Blob
 * ĐÃ thu nhỏ. Trả `null` khi: thiếu `createImageBitmap`, decode lỗi, ảnh đã đủ nhỏ (không cần re-encode), hoặc
 * không có canvas khả dụng. Caller quyết định giữ file gốc khi nhận null. KHÔNG throw. */
export async function encodeResizedJpegBlob(
  source: Blob,
  maxEdge: number,
  quality: number
): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null; // decode lỗi (file hỏng/định dạng lạ) — giữ gốc.
  }
  try {
    const dims = computeResizedDimensions(bitmap.width, bitmap.height, maxEdge);
    if (!dims.resized) return null; // đã đủ nhỏ → giữ NGUYÊN (không re-encode, giữ chất lượng gốc).
    return await drawBitmapToJpegBlob(bitmap, dims.width, dims.height, quality);
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
