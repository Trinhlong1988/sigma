// LAG-FIX (12/8) — test HÀM THUẦN computeResizedDimensions (giữ tỉ lệ, KHÔNG phóng to, ngưỡng an toàn OCR).
// Phần resize thật (createImageBitmap/OffscreenCanvas) là DOM/browser → KHÔNG unit-test được ở env node
// (repo chưa có jsdom, cùng quy ước screen-capture.ts) → verify bằng Playwright browser thật (xem báo cáo
// LAG-FIX: đo trước/sau kích thước + thời gian main-thread trên ảnh 4000×3000).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeResizedDimensions, MAX_UPLOAD_IMAGE_EDGE, resizeImageForUpload } from './image-resize';
import { encodeResizedJpegBlob } from './image-resize-core';

describe('computeResizedDimensions — thu nhỏ giữ tỉ lệ, không phóng to', () => {
  it('ảnh lớn ngang (4000×3000) → cạnh dài về 2000, giữ đúng tỉ lệ 4:3', () => {
    const r = computeResizedDimensions(4000, 3000, 2000);
    expect(r.resized).toBe(true);
    expect(r.width).toBe(2000);
    expect(r.height).toBe(1500); // 3000 * (2000/4000)
    expect(r.width / r.height).toBeCloseTo(4000 / 3000, 5);
  });

  it('ảnh lớn dọc (3000×4000) → cạnh dài (chiều cao) về 2000', () => {
    const r = computeResizedDimensions(3000, 4000, 2000);
    expect(r.resized).toBe(true);
    expect(r.height).toBe(2000);
    expect(r.width).toBe(1500);
  });

  it('KHÔNG phóng to — ảnh nhỏ hơn ngưỡng giữ nguyên (resized=false)', () => {
    const r = computeResizedDimensions(1200, 800, 2000);
    expect(r.resized).toBe(false);
    expect(r.width).toBe(1200);
    expect(r.height).toBe(800);
  });

  it('đúng bằng ngưỡng (2000 cạnh dài) → giữ nguyên (≤ maxEdge, không đụng)', () => {
    const r = computeResizedDimensions(2000, 1000, 2000);
    expect(r.resized).toBe(false);
    expect(r.width).toBe(2000);
  });

  it('trên ngưỡng 1px → có thu nhỏ', () => {
    const r = computeResizedDimensions(2001, 1000, 2000);
    expect(r.resized).toBe(true);
    expect(Math.max(r.width, r.height)).toBe(2000);
  });

  it('ảnh cực dẹt (4000×1) → cạnh ngắn không bao giờ về 0 (tối thiểu 1px)', () => {
    const r = computeResizedDimensions(4000, 1, 2000);
    expect(r.resized).toBe(true);
    expect(r.width).toBe(2000);
    // 1 * (2000/4000) = 0.5 -> round = 1 (JS round nửa lên: round(0.5)=1); max(1,..)=1, KHÔNG về 0.
    expect(r.height).toBe(1);
  });

  it('kích thước không hợp lệ (0/âm/NaN/Infinity) → resized=false, không đụng canvas', () => {
    expect(computeResizedDimensions(0, 0, 2000).resized).toBe(false);
    expect(computeResizedDimensions(-10, 100, 2000).resized).toBe(false);
    expect(computeResizedDimensions(Number.NaN, 100, 2000).resized).toBe(false);
    expect(computeResizedDimensions(Infinity, 100, 2000).resized).toBe(false);
  });

  it('maxEdge <= 0 → giữ nguyên (guard, không chia cho 0)', () => {
    expect(computeResizedDimensions(4000, 3000, 0).resized).toBe(false);
  });

  it('hằng ngưỡng mặc định = 2000 (an toàn đọc bill bằng mắt, không nhỏ hơn)', () => {
    expect(MAX_UPLOAD_IMAGE_EDGE).toBe(2000);
  });
});

// LAG-FIX v2 (12/8) — AN TOÀN: encode/resize CHỈ là tối ưu, KHÔNG bao giờ chặn gửi. Trong env node (KHÔNG có
// createImageBitmap/Worker/OffscreenCanvas), mọi nhánh PHẢI trả về CHÍNH file gốc (không throw).
describe('encodeResizedJpegBlob — an toàn khi thiếu API (env node)', () => {
  it('không có createImageBitmap → trả null (caller giữ file gốc), KHÔNG throw', async () => {
    expect(typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap).not.toBe('function');
    const blob = new Blob([new Uint8Array(1000)], { type: 'image/jpeg' });
    await expect(encodeResizedJpegBlob(blob, 2000, 0.85)).resolves.toBeNull();
  });
});

describe('resizeImageForUpload — LUÔN trả File gửi được, không chặn', () => {
  it('env node (không Worker/OffscreenCanvas/createImageBitmap) → fallback trả CHÍNH file gốc', async () => {
    const file = new File([new Uint8Array(5000)], 'anh.jpg', { type: 'image/jpeg' });
    const out = await resizeImageForUpload(file);
    expect(out).toBe(file); // cùng tham chiếu = không đụng gì, gửi nguyên.
  });

  it('loại ảnh KHÔNG resize được (gif động) → trả nguyên file ngay, không đụng canvas/worker', async () => {
    const file = new File([new Uint8Array(5000)], 'anim.gif', { type: 'image/gif' });
    const out = await resizeImageForUpload(file);
    expect(out).toBe(file);
  });

  // WIRE 12/8 — các đường "File" (pdf/docx/xlsx) + "Ghi âm" (audio/webm) trong MessageComposer đi THẲNG
  // uploadAndSend, KHÔNG qua sendResizedImage. Nhưng khẳng định thêm: kể cả nếu 1 loại KHÔNG-ẢNH lọt vào
  // resizeImageForUpload thì cũng trả NGUYÊN file gốc (isResizableImageType chặn) — không bao giờ nén nhầm.
  it('loại KHÔNG phải ảnh (pdf) → trả nguyên file gốc, không nén', async () => {
    const file = new File([new Uint8Array(5000)], 'tai-lieu.pdf', { type: 'application/pdf' });
    const out = await resizeImageForUpload(file);
    expect(out).toBe(file);
  });

  it('ghi âm (audio/webm) → trả nguyên file gốc, không nén', async () => {
    const file = new File([new Uint8Array(5000)], 'voice.webm', { type: 'audio/webm' });
    const out = await resizeImageForUpload(file);
    expect(out).toBe(file);
  });
});

// LAG-FIX v2 (12/8) — NHÁNH WORKER (đường đi chính trên APK/Chromium). Env node không có Worker thật → giả lập
// 1 Worker để KHẲNG ĐỊNH logic điều phối image-resize.ts: (a) worker trả Blob nhỏ → bọc File .jpg; (b) worker
// trả null (ảnh đủ nhỏ) → giữ gốc; (c) worker báo lỗi → lùi main-thread → giữ gốc; (d) blob to hơn gốc → giữ gốc.
// Dùng vi.resetModules để reset singleton worker + bộ đếm id giữa các test.
describe('resizeImageForUpload — nhánh Worker (giả lập), điều phối id/bọc File/fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  type WorkerResp = { id: number; ok: boolean; blob: Blob | null };
  /** Cài Worker + OffscreenCanvas giả (chỉ cần typeof===function để canUseResizeWorker() bật), rồi import mới. */
  async function withFakeWorker(reply: (req: { id: number; blob: Blob }) => WorkerResp | null) {
    vi.resetModules();
    vi.stubGlobal('OffscreenCanvas', class {}); // đủ cho typeof check.
    class FakeWorker {
      onmessage: ((e: { data: WorkerResp }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(req: { id: number; blob: Blob }) {
        const res = reply(req);
        if (res) queueMicrotask(() => this.onmessage?.({ data: res }));
        // res===null → không trả lời (mô phỏng treo) → dựa vào timeout (test riêng dùng fake timers).
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    return await import('./image-resize');
  }

  it('(a) worker trả Blob nhỏ → bọc thành File .jpg, đổi tên, size < gốc', async () => {
    const small = new Blob([new Uint8Array(50)], { type: 'image/jpeg' });
    const { resizeImageForUpload: fn } = await withFakeWorker((req) => ({ id: req.id, ok: true, blob: small }));
    const big = new File([new Uint8Array(5000)], 'photo.png', { type: 'image/png' });
    const out = await fn(big);
    expect(out).not.toBe(big);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('photo.jpg');
    expect(out.size).toBeLessThan(big.size);
  });

  it('(b) worker trả null (ảnh đã đủ nhỏ) → giữ NGUYÊN file gốc (không re-encode)', async () => {
    const { resizeImageForUpload: fn } = await withFakeWorker((req) => ({ id: req.id, ok: true, blob: null }));
    const file = new File([new Uint8Array(5000)], 'small.jpg', { type: 'image/jpeg' });
    const out = await fn(file);
    expect(out).toBe(file);
  });

  it('(c) worker báo lỗi (ok:false) → lùi main-thread → (không createImageBitmap) giữ file gốc', async () => {
    const { resizeImageForUpload: fn } = await withFakeWorker((req) => ({ id: req.id, ok: false, blob: null }));
    const file = new File([new Uint8Array(5000)], 'photo.jpg', { type: 'image/jpeg' });
    const out = await fn(file);
    expect(out).toBe(file);
  });

  it('(d) worker trả blob KHÔNG nhỏ hơn gốc → giữ file gốc (không làm ảnh to thêm)', async () => {
    const bigger = new Blob([new Uint8Array(9000)], { type: 'image/jpeg' });
    const { resizeImageForUpload: fn } = await withFakeWorker((req) => ({ id: req.id, ok: true, blob: bigger }));
    const file = new File([new Uint8Array(5000)], 'photo.jpg', { type: 'image/jpeg' });
    const out = await fn(file);
    expect(out).toBe(file);
  });

  it('điều phối ĐÚNG id: 2 lần gửi song song nhận đúng kết quả của mình', async () => {
    const { resizeImageForUpload: fn } = await withFakeWorker((req) => {
      // Blob nhỏ có kích thước = id để phân biệt (chỉ để chắc mapping theo id, giá trị không quan trọng nội dung).
      return { id: req.id, ok: true, blob: new Blob([new Uint8Array(10 + req.id)], { type: 'image/jpeg' }) };
    });
    const f1 = new File([new Uint8Array(5000)], 'a.png', { type: 'image/png' });
    const f2 = new File([new Uint8Array(5000)], 'b.png', { type: 'image/png' });
    const [o1, o2] = await Promise.all([fn(f1), fn(f2)]);
    expect(o1.name).toBe('a.jpg');
    expect(o2.name).toBe('b.jpg');
    expect(o1.size).not.toBe(o2.size); // mỗi request nhận đúng blob của id mình.
  });
});
