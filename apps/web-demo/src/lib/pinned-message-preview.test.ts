// "BẢNG TIN" / GHIM KHÔNG GIỚI HẠN (5/8) — regression cho pinnedMessagePreview() (chat-client.ts), hàm THUẦN
// dựng nhãn xem trước 1 tin ĐÃ GHIM (banner ghim + PinBoardPanel). Cùng lớp "pure-logic test" (environment
// node, KHÔNG DOM) như call-peer-resolution.test.ts — repo CHƯA có jsdom để render component thật.
import { describe, expect, it } from 'vitest';
import { pinnedMessagePreview, type PinnedMessageDto } from './chat-client';

function msg(over: Partial<NonNullable<PinnedMessageDto['message']>>): PinnedMessageDto['message'] {
  return {
    id: 'm1',
    kind: 'TEXT',
    body: null,
    senderId: 1,
    attachmentId: null,
    metadataJson: null,
    createdAt: '2026-08-05T00:00:00.000Z',
    ...over
  };
}

describe('pinnedMessagePreview', () => {
  it('TEXT → hiện nguyên nội dung (đã trim)', () => {
    expect(pinnedMessagePreview(msg({ kind: 'TEXT', body: '  Xin chào nhóm  ' }))).toBe('Xin chào nhóm');
  });

  it('tin đã thu hồi sau khi ghim (message=null) → placeholder "Tin nhắn đã bị xóa"', () => {
    expect(pinnedMessagePreview(null)).toBe('Tin nhắn đã bị xóa');
  });

  it('IMAGE thường → [Hình ảnh]', () => {
    expect(pinnedMessagePreview(msg({ kind: 'IMAGE' }))).toBe('[Hình ảnh]');
  });

  it('IMAGE bill (metadataJson.isBillImage) → [Bill]', () => {
    expect(pinnedMessagePreview(msg({ kind: 'IMAGE', metadataJson: JSON.stringify({ isBillImage: true }) }))).toBe('[Bill]');
  });

  it('IMAGE hoàn tiền (metadataJson.isRefundImage) → [Hoàn tiền]', () => {
    expect(pinnedMessagePreview(msg({ kind: 'IMAGE', metadataJson: JSON.stringify({ isRefundImage: true }) }))).toBe('[Hoàn tiền]');
  });

  it('FILE/VOICE/LOCATION/QR → nhãn tiếng Việt tương ứng', () => {
    expect(pinnedMessagePreview(msg({ kind: 'FILE' }))).toBe('[Tệp đính kèm]');
    expect(pinnedMessagePreview(msg({ kind: 'VOICE' }))).toBe('[Tin nhắn thoại]');
    expect(pinnedMessagePreview(msg({ kind: 'LOCATION' }))).toBe('[Vị trí]');
    expect(pinnedMessagePreview(msg({ kind: 'QR' }))).toBe('[Mã QR]');
  });

  it('metadataJson hỏng → KHÔNG throw, rơi về nhãn [Hình ảnh]', () => {
    expect(pinnedMessagePreview(msg({ kind: 'IMAGE', metadataJson: '{broken' }))).toBe('[Hình ảnh]');
  });
});
