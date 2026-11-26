// LAG-FIX v2 WIRE (12/8) — test WIRING nén ảnh vào chỗ gửi (composer-image-send.ts). Env node (KHÔNG jsdom,
// cùng quy ước cả repo) → KHÔNG render MessageComposer; test hàm thuần `sendResizedImage` với spy để khẳng
// định: (a) đường ẢNH thường CÓ gọi resize rồi upload bản ĐÃ resize; (b) resize best-effort không chặn upload;
// (c) contract nền tảng của resizeImageForUpload — loại KHÔNG phải ảnh (file/voice/gif) trả NGUYÊN file gốc,
// nên các đường gửi File/Ghi âm (đi thẳng uploadAndSend, KHÔNG qua sendResizedImage) không bao giờ bị nén.
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock lớp resize để spy được lời gọi + tách khỏi DOM (createImageBitmap/Worker không có ở node).
vi.mock('./image-resize', () => ({
  resizeImageForUpload: vi.fn(async (f: File) => f)
}));

import { sendResizedImage } from './composer-image-send';
import { resizeImageForUpload } from './image-resize';

const mockedResize = vi.mocked(resizeImageForUpload);

afterEach(() => {
  vi.clearAllMocks();
});

describe('sendResizedImage — đường ẢNH thường: resize TRƯỚC rồi upload', () => {
  it('gọi resizeImageForUpload đúng file gốc, rồi upload bản ĐÃ resize (không phải file gốc)', async () => {
    const original = new File([new Uint8Array(5000)], 'photo.png', { type: 'image/png' });
    const resized = new File([new Uint8Array(500)], 'photo.jpg', { type: 'image/jpeg' });
    mockedResize.mockResolvedValueOnce(resized);

    const upload = vi.fn(async () => {});
    await sendResizedImage(original, upload);

    expect(mockedResize).toHaveBeenCalledTimes(1);
    expect(mockedResize).toHaveBeenCalledWith(original);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(resized); // upload nhận BẢN ĐÃ NÉN, không phải file gốc.
    // resize PHẢI xong TRƯỚC khi upload chạy (thứ tự await đúng).
    expect(mockedResize.mock.invocationCallOrder[0]).toBeLessThan(upload.mock.invocationCallOrder[0]);
  });

  it('ảnh đã đủ nhỏ (resize trả CHÍNH file gốc) → vẫn upload file gốc, không lỗi', async () => {
    const original = new File([new Uint8Array(800)], 'small.jpg', { type: 'image/jpeg' });
    // mock mặc định trả nguyên file → mô phỏng "đã đủ nhỏ, giữ gốc".
    const upload = vi.fn(async () => {});
    await sendResizedImage(original, upload);

    expect(upload).toHaveBeenCalledWith(original);
  });

  it('upload trả Promise → await được (giữ nguyên hợp đồng await của caller MessageComposer)', async () => {
    const order: string[] = [];
    const upload = vi.fn(async () => {
      order.push('upload-start');
      await Promise.resolve();
      order.push('upload-end');
    });
    await sendResizedImage(new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }), upload);
    expect(order).toEqual(['upload-start', 'upload-end']);
  });
});
