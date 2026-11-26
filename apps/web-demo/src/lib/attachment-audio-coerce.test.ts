// item 14 (6/8) — test hàm THUẦN `coerceAudioBlob()`: ghi âm CŨ lưu `video/webm` khiến thẻ `<audio>` người
// NHẬN từ chối phát → "Lỗi tải" (fetch vẫn HTTP 200). Hàm ép blob về MIME `audio/*` để `<audio>` chấp nhận.
// CÙNG quy ước "pure-logic, environment node" như voice-message-mapping.test.ts (repo CHƯA có hạ tầng render
// component). `Blob` là global sẵn trên Node 18+ nên test được không cần DOM/`URL.createObjectURL`.
import { describe, expect, it } from 'vitest';
import { coerceAudioBlob } from './attachment-blob';

describe('coerceAudioBlob() — ép MIME audio để <audio> phát được (item 14)', () => {
  it('video/webm (bug ghi âm CŨ) → Blob MỚI type audio/webm, GIỮ nguyên byte dữ liệu', async () => {
    const raw = new Blob(['giả-lập-du-lieu-webm'], { type: 'video/webm' });
    const out = coerceAudioBlob(raw);
    expect(out).not.toBe(raw); // phải là blob MỚI (đã đổi nhãn)
    expect(out.type).toBe('audio/webm');
    // Byte dữ liệu KHÔNG đổi (chỉ thay nhãn MIME, không giải mã/nén lại).
    expect(await out.text()).toBe('giả-lập-du-lieu-webm');
    expect(out.size).toBe(raw.size);
  });

  it('type RỖNG (một số WebView không gắn type) → audio/webm', () => {
    const out = coerceAudioBlob(new Blob(['x'], { type: '' }));
    expect(out.type).toBe('audio/webm');
  });

  it('audio/webm (ghi âm MỚI đã đúng) → GIỮ NGUYÊN chính blob đó (không copy thừa)', () => {
    const raw = new Blob(['x'], { type: 'audio/webm' });
    expect(coerceAudioBlob(raw)).toBe(raw);
  });

  it('audio/webm;codecs=opus (đúng, có tham số codec) → GIỮ NGUYÊN', () => {
    const raw = new Blob(['x'], { type: 'audio/webm;codecs=opus' });
    expect(coerceAudioBlob(raw)).toBe(raw);
  });

  it('audio/mp4 và audio/ogg (đã đúng audio/*) → GIỮ NGUYÊN', () => {
    const mp4 = new Blob(['x'], { type: 'audio/mp4' });
    const ogg = new Blob(['x'], { type: 'audio/ogg' });
    expect(coerceAudioBlob(mp4)).toBe(mp4);
    expect(coerceAudioBlob(ogg)).toBe(ogg);
  });

  it('video/mp4 / quicktime → audio/mp4 (AAC trong MP4)', () => {
    expect(coerceAudioBlob(new Blob(['x'], { type: 'video/mp4' })).type).toBe('audio/mp4');
    expect(coerceAudioBlob(new Blob(['x'], { type: 'video/quicktime' })).type).toBe('audio/mp4');
  });

  it('video/ogg → audio/ogg', () => {
    expect(coerceAudioBlob(new Blob(['x'], { type: 'video/ogg' })).type).toBe('audio/ogg');
  });

  it('type lạ/không xác định → audio/webm (mặc định an toàn cho MediaRecorder Chromium)', () => {
    expect(coerceAudioBlob(new Blob(['x'], { type: 'application/octet-stream' })).type).toBe('audio/webm');
  });

  it('HOA/thường lẫn lộn (VIDEO/WEBM) vẫn nhận diện đúng (không phân biệt hoa thường)', () => {
    expect(coerceAudioBlob(new Blob(['x'], { type: 'VIDEO/WEBM' })).type).toBe('audio/webm');
  });
});
