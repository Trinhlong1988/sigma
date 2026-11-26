// SIGMA (31/7, việc #5 — ghi âm/phát tin nhắn thoại THẬT, thay nút mock cũ). Test cho các hàm THUẦN mới
// thêm ở chat-client.ts: `formatSecondsToDurationLabel()`/`parseDurationLabelToSeconds()` (định dạng/parse
// nhãn "m:ss" — dùng làm mẫu số progress bar dự phòng vì Chrome/Chromium có lỗi đã biết báo `audio.duration =
// Infinity` cho Blob WebM do MediaRecorder tạo ra, xem comment VoiceMessageBubble.tsx) + nhánh `mapChatMessage()`
// xử lý `dto.kind === 'VOICE'` (parse `metadataJson` → `{durationMs}`, gắn `attachmentId` → url tải thật).
// CÙNG quy ước "pure-logic, environment node" như call-peer-resolution.test.ts/rc-message-split.test.ts (repo
// CHƯA có hạ tầng render component @testing-library/react).
import { describe, expect, it } from 'vitest';
import { formatSecondsToDurationLabel, mapChatMessage, parseDurationLabelToSeconds, type ChatMessageDto } from './chat-client';

function voiceDto(overrides: Partial<ChatMessageDto> = {}): ChatMessageDto {
  return {
    id: 'msg-voice-1',
    roomId: 'room-1',
    senderId: 42,
    kind: 'VOICE',
    body: null,
    attachmentId: 'att-voice-1',
    metadataJson: null,
    replyToMessageId: null,
    forwardedFromMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-07-31T09:10:00.000Z',
    attachmentMimeType: 'video/webm',
    attachmentSizeBytes: 12_345,
    ...overrides
  };
}

describe('formatSecondsToDurationLabel', () => {
  it('định dạng số giây thành nhãn m:ss (vd 23 → "0:23")', () => {
    expect(formatSecondsToDurationLabel(23)).toBe('0:23');
  });

  it('vượt 60 giây → sang phút (vd 65 → "1:05", giây < 10 luôn 2 chữ số)', () => {
    expect(formatSecondsToDurationLabel(65)).toBe('1:05');
  });

  it('0 giây → "0:00"', () => {
    expect(formatSecondsToDurationLabel(0)).toBe('0:00');
  });

  it('giá trị âm/NaN/Infinity → clamp về "0:00" (KHÔNG throw, KHÔNG hiện "-1"/"NaN"/"Infinity" ra UI)', () => {
    expect(formatSecondsToDurationLabel(-5)).toBe('0:00');
    expect(formatSecondsToDurationLabel(NaN)).toBe('0:00');
    expect(formatSecondsToDurationLabel(Infinity)).toBe('0:00');
  });

  it('làm tròn số giây lẻ (vd 23.6 → "0:24")', () => {
    expect(formatSecondsToDurationLabel(23.6)).toBe('0:24');
  });
});

describe('parseDurationLabelToSeconds', () => {
  it('parse ngược ĐÚNG với formatSecondsToDurationLabel (round-trip)', () => {
    expect(parseDurationLabelToSeconds('0:23')).toBe(23);
    expect(parseDurationLabelToSeconds('1:05')).toBe(65);
    expect(parseDurationLabelToSeconds('0:00')).toBe(0);
  });

  it('nhãn hỏng/không đúng dạng → trả 0, KHÔNG throw (mẫu số dự phòng hiển thị, không phải dữ liệu nhạy cảm)', () => {
    expect(parseDurationLabelToSeconds('abc')).toBe(0);
    expect(parseDurationLabelToSeconds('')).toBe(0);
    expect(parseDurationLabelToSeconds('-1:30')).toBe(0);
  });
});

describe('mapChatMessage() — nhánh kind VOICE (việc #5)', () => {
  it('có attachmentId + metadataJson {durationMs} hợp lệ → gắn message.voice {duration, url}', () => {
    const dto = voiceDto({ metadataJson: JSON.stringify({ durationMs: 23_000 }) });
    const ui = mapChatMessage(dto, 99);
    expect(ui.type).toBe('voice');
    expect(ui.voice).toEqual({ duration: '0:23', url: expect.stringContaining('/v1/chat/attachments/att-voice-1') });
  });

  it('metadataJson thiếu/null → fallback nhãn "0:00", KHÔNG throw, url vẫn gắn (attachmentId vẫn còn)', () => {
    const dto = voiceDto({ metadataJson: null });
    const ui = mapChatMessage(dto, 99);
    expect(ui.voice?.duration).toBe('0:00');
    expect(ui.voice?.url).toContain('att-voice-1');
  });

  it('metadataJson hỏng (JSON không parse được) → fallback "0:00", KHÔNG vỡ (CÙNG nguyên tắc LOCATION/QR)', () => {
    const dto = voiceDto({ metadataJson: '{not valid json' });
    const ui = mapChatMessage(dto, 99);
    expect(ui.voice?.duration).toBe('0:00');
  });

  it('KHÔNG có attachmentId (dữ liệu bất thường) → KHÔNG gắn message.voice (undefined, không vỡ UI)', () => {
    const dto = voiceDto({ attachmentId: null, metadataJson: JSON.stringify({ durationMs: 5000 }) });
    const ui = mapChatMessage(dto, 99);
    expect(ui.voice).toBeUndefined();
  });

  it('tin đã xóa (deletedAt khác null) → placeholder hệ thống, KHÔNG chạm nhánh voice', () => {
    const dto = voiceDto({ deletedAt: '2026-07-31T10:00:00.000Z', metadataJson: JSON.stringify({ durationMs: 23_000 }) });
    const ui = mapChatMessage(dto, 99);
    expect(ui.type).toBe('system');
    expect(ui.voice).toBeUndefined();
  });
});
