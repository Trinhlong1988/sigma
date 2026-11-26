// SIGMA LAG-FIX v2 (Admin Demo 12/8 — "gửi ảnh phải MƯỢT hẳn, xoá stall main-thread lúc gửi") — thu nhỏ ảnh
// PHÍA CLIENT TRƯỚC KHI upload cho luồng "Ảnh" thường (KHÔNG phải "Quét bill"/screenshot/refund).
//
// TIẾN HOÁ so với v1: v1 dùng createImageBitmap + OffscreenCanvas + convertToBlob NGAY TRÊN main-thread. Đo
// thật trên emulator GPU-phần-mềm: bước ENCODE vẫn chặn UI ~370ms → giật lúc bấm gửi. v2 DỜI toàn bộ
// decode+draw+encode vào 1 WEB WORKER (image-resize.worker.ts) → main-thread chỉ còn postMessage (clone Blob
// rẻ, KHÔNG copy dữ liệu ảnh). Fallback: thiếu Worker/OffscreenCanvas → dùng nhánh main-thread như v1 (không
// phá). Mọi lỗi/timeout → TRẢ FILE GỐC (không bao giờ chặn gửi).
//
// AN TOÀN — KHÔNG bao giờ chặn việc gửi: mọi lỗi (không hỗ trợ API/decode lỗi/encode lỗi/worker treo/kết quả
// to hơn bản gốc) → TRẢ VỀ chính file gốc, người dùng vẫn gửi được như cũ. KHÔNG phóng to (chỉ thu nhỏ). Ảnh
// đã nhỏ hơn ngưỡng → gửi NGUYÊN (không re-encode, giữ đúng chất lượng gốc).
//
// PHẠM VI (cố ý HẸP): CHỈ áp cho "Ảnh" thường (handlePickedImageFile/handleAttachImageClick,
// MessageComposer.tsx). KHÔNG áp cho:
//   - "Quét bill" (handleScanBillClick): dữ liệu TIỀN, OCR server đọc số/TID — GIỮ NGUYÊN full-res, chỉ resize
//     phía server (ocr-service). Ngưỡng 2000px ở đây chọn ĐỦ NÉT để bill vẫn đọc được BẰNG MẮT nếu người dùng
//     lỡ gửi bill qua nút "Ảnh" thường (không chạy OCR).
//   - Chụp màn hình (screen-capture.ts): đã fix riêng PNG→JPEG q=0.85.
//   - Đổi/hoàn ảnh bill (pick-image.ts): liên quan bill.
//
// LƯU Ý APK (CHƯA tự khẳng định xanh — CẦN LEAD test máy thật, R196): trên Android WebView, ảnh từ
// `Camera.getPhoto()` được camera native trả về ĐÃ nhỏ (width/height:2000) rồi vẫn qua worker-resize để chắc.
// Chất lượng ảnh sau resize + độ mượt lúc gửi PHẢI được LEAD nhìn/thao tác trên thiết bị thật trước khi coi
// APK là PASS (Engineering PASS ≠ Production PASS).

import {
  MAX_UPLOAD_IMAGE_EDGE,
  UPLOAD_IMAGE_JPEG_QUALITY,
  encodeResizedJpegBlob,
  isResizableImageType,
  toJpgFileName
} from './image-resize-core';
import type { ResizeWorkerRequest, ResizeWorkerResponse } from './image-resize.worker';

// Re-export để giữ NGUYÊN API công khai (MessageComposer + test import từ đây như cũ).
export {
  MAX_UPLOAD_IMAGE_EDGE,
  UPLOAD_IMAGE_JPEG_QUALITY,
  computeResizedDimensions
} from './image-resize-core';
export type { ResizeDimensions } from './image-resize-core';

/** Quá thời gian chờ worker (ms) → coi như worker treo, TRẢ FILE GỐC (không chặn gửi, không double-encode ở
 * main-thread). Ảnh ≤2000px encode trong worker rất nhanh (~vài trăm ms kể cả GPU-phần-mềm) → 12s là dư an toàn. */
const WORKER_TIMEOUT_MS = 12000;

/** true nếu môi trường đủ điều kiện dùng Worker (Worker + OffscreenCanvas — OffscreenCanvas là cách encode duy
 * nhất TRONG worker vì worker không có `document`). Thiếu → lùi nhánh main-thread. */
function canUseResizeWorker(): boolean {
  return typeof Worker === 'function' && typeof OffscreenCanvas === 'function';
}

// ---- Worker singleton + hàng đợi request theo id (1 worker phục vụ mọi lần gửi, tạo LƯỜI ở lần đầu) ----
let workerInstance: Worker | null = null;
let workerBroken = false; // worker phát lỗi cấp module (onerror) → không dùng lại, lùi main-thread từ đó.
let nextRequestId = 1;
const pending = new Map<number, (res: ResizeWorkerResponse | null) => void>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (workerInstance) return workerInstance;
  try {
    const worker = new Worker(new URL('./image-resize.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ResizeWorkerResponse>) => {
      const resolve = pending.get(e.data.id);
      if (resolve) {
        pending.delete(e.data.id);
        resolve(e.data);
      }
    };
    worker.onerror = () => {
      // Lỗi cấp worker (vd không load được script) → huỷ, giải phóng mọi request đang chờ về null (caller lùi
      // main-thread), đánh dấu broken để không thử lại.
      workerBroken = true;
      workerInstance = null;
      for (const [, resolve] of pending) resolve(null);
      pending.clear();
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
    };
    workerInstance = worker;
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Gửi 1 Blob vào worker, chờ Blob đã resize (hoặc null = giữ gốc). Trả `undefined` nếu worker không dùng được
 * / timeout / lỗi → caller lùi main-thread. */
function resizeViaWorker(blob: Blob, maxEdge: number, quality: number): Promise<Blob | null | undefined> {
  const worker = getWorker();
  if (!worker) return Promise.resolve(undefined);
  const id = nextRequestId++;
  return new Promise<Blob | null | undefined>((resolve) => {
    let settled = false;
    const done = (value: Blob | null | undefined) => {
      if (settled) return;
      settled = true;
      pending.delete(id);
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), WORKER_TIMEOUT_MS);
    pending.set(id, (res) => {
      if (!res || !res.ok) {
        done(undefined); // worker báo lỗi → lùi main-thread.
        return;
      }
      done(res.blob); // Blob đã resize, hoặc null (ảnh đã đủ nhỏ → giữ gốc).
    });
    try {
      const req: ResizeWorkerRequest = { id, blob, maxEdge, quality };
      worker.postMessage(req);
    } catch {
      done(undefined); // postMessage/clone lỗi → lùi main-thread.
    }
  });
}

/** Bọc Blob đã resize thành File .jpg (giữ tên gốc). Trả null nếu blob rỗng/không nhỏ hơn bản gốc (giữ gốc). */
function wrapResizedFile(blob: Blob | null, original: File): File | null {
  if (!blob || blob.size >= original.size) return null;
  return new File([blob], toJpgFileName(original.name), { type: 'image/jpeg', lastModified: Date.now() });
}

/** Thu nhỏ 1 ảnh phía client TRƯỚC upload (xem đầu file). LUÔN trả về 1 File gửi được — bản đã thu nhỏ khi
 * thành công & có lợi, ngược lại chính file gốc (KHÔNG bao giờ throw/chặn gửi).
 *
 * Đường đi: (1) Worker nếu có (encode NGOÀI main-thread — hết stall). (2) Fallback main-thread như v1 nếu
 * thiếu Worker/OffscreenCanvas. (3) Bất kỳ lỗi → file gốc. */
export async function resizeImageForUpload(
  file: File,
  opts?: { maxEdge?: number; quality?: number }
): Promise<File> {
  const maxEdge = opts?.maxEdge ?? MAX_UPLOAD_IMAGE_EDGE;
  const quality = opts?.quality ?? UPLOAD_IMAGE_JPEG_QUALITY;

  // Loại ảnh không nên đụng (GIF động/SVG vector/loại lạ) → gửi nguyên.
  if (!isResizableImageType(file.type)) return file;

  // (1) Worker path — dời encode khỏi UI thread.
  if (canUseResizeWorker()) {
    try {
      const result = await resizeViaWorker(file, maxEdge, quality);
      if (result !== undefined) {
        // Worker chạy xong: result = Blob đã resize (bọc File) hoặc null (giữ gốc).
        return wrapResizedFile(result, file) ?? file;
      }
      // result === undefined → worker không dùng được/timeout → rơi xuống fallback main-thread bên dưới.
    } catch {
      // rơi xuống fallback main-thread.
    }
  }

  // (2) Fallback main-thread (v1) — chỉ chạy khi thiếu Worker/OffscreenCanvas hoặc worker lỗi. Giữ NGUYÊN hành
  // vi cũ (không phá): vẫn không đọc base64 đồng bộ; encode có thể chặn UI như trước nhưng đây là đường lùi.
  try {
    const blob = await encodeResizedJpegBlob(file, maxEdge, quality);
    return wrapResizedFile(blob, file) ?? file;
  } catch {
    return file;
  }
}
