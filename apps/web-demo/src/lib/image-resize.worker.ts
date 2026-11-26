// LAG-FIX v2 (Admin Demo 12/8) — WEB WORKER thu nhỏ ảnh: chạy TOÀN BỘ decode (`createImageBitmap`) + draw +
// encode (`OffscreenCanvas.convertToBlob`) NGOÀI main-thread → UI KHÔNG còn bị chặn ~370ms lúc bấm gửi.
// Được tạo lười bởi image-resize.ts qua `new Worker(new URL('./image-resize.worker.ts', import.meta.url),
// { type: 'module' })` (Vite bundle worker thành chunk riêng). Giao thức message: xem ResizeWorkerRequest/Response.
//
// AN TOÀN: mọi lỗi → trả `{ ok:false }` (caller tự lùi về main-thread hoặc giữ file gốc, KHÔNG chặn gửi).
// Worker CHỈ dùng nhánh OffscreenCanvas (không có `document`); nếu OffscreenCanvas thiếu, encodeResizedJpegBlob
// trả null → caller lùi main-thread.
import { encodeResizedJpegBlob } from './image-resize-core';

export interface ResizeWorkerRequest {
  id: number;
  blob: Blob;
  maxEdge: number;
  quality: number;
}

export interface ResizeWorkerResponse {
  id: number;
  /** true = worker chạy xong không lỗi. `blob` = Blob đã thu nhỏ, HOẶC null nếu không cần resize (giữ gốc). */
  ok: boolean;
  /** null khi ok=false HOẶC ok=true nhưng ảnh đã đủ nhỏ (caller giữ file gốc). */
  blob: Blob | null;
}

self.onmessage = async (e: MessageEvent<ResizeWorkerRequest>) => {
  const { id, blob, maxEdge, quality } = e.data;
  try {
    const out = await encodeResizedJpegBlob(blob, maxEdge, quality);
    self.postMessage({ id, ok: true, blob: out } satisfies ResizeWorkerResponse);
  } catch {
    // encodeResizedJpegBlob đã nuốt lỗi nội bộ, nhưng phòng lỗi lạ (postMessage/clone) vẫn báo ok:false.
    self.postMessage({ id, ok: false, blob: null } satisfies ResizeWorkerResponse);
  }
};
