// B112 (2/8) — regression cho phần chat-client.ts liên quan "Sửa bill đã gửi": mapChatMessage() nhánh
// editedAt/attachmentId/billMeta + canEditChatMessage()/canEditBillMessage(). CÙNG quy ước "pure-logic,
// environment node" như voice-message-mapping.test.ts (repo chưa có hạ tầng render component).
import { describe, expect, it, vi } from 'vitest';
import { canEditBillMessage, canEditChatMessage, mapChatMessage, MESSAGE_EDIT_WINDOW_HOURS, type ChatMessageDto } from './chat-client';

function billImageDto(overrides: Partial<ChatMessageDto> = {}): ChatMessageDto {
  const metadataJson = JSON.stringify({
    isBillImage: true,
    billAmount: 4_000_000,
    billImageHeightPx: 812,
    billFields: { tid: { value: '57025362', uncertain: false } }
  });
  return {
    id: 'msg-bill-1',
    roomId: 'room-1',
    senderId: 42,
    kind: 'IMAGE',
    body: 'POS ... - 4.000.000đ',
    attachmentId: 'att-bill-1',
    metadataJson,
    replyToMessageId: null,
    forwardedFromMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    attachmentMimeType: 'image/jpeg',
    attachmentSizeBytes: 45_000,
    ...overrides
  };
}

describe('mapChatMessage() — editedAt/attachmentId (B112)', () => {
  it('editedAt null → message.editedAt undefined (chưa từng sửa, KHÔNG hiện "(đã chỉnh sửa)")', () => {
    const ui = mapChatMessage(billImageDto({ editedAt: null }), 42);
    expect(ui.editedAt).toBeUndefined();
  });

  it('editedAt có giá trị → map thẳng qua UI', () => {
    const ui = mapChatMessage(billImageDto({ editedAt: '2026-08-02T10:00:00.000Z' }), 42);
    expect(ui.editedAt).toBe('2026-08-02T10:00:00.000Z');
  });

  it('kind IMAGE có attachmentId → message.attachmentId gắn ĐÚNG id thô (khác imageUrl, dùng cho EditBillMessageModal fetch lại)', () => {
    const ui = mapChatMessage(billImageDto({ attachmentId: 'att-xyz' }), 42);
    expect(ui.attachmentId).toBe('att-xyz');
    expect(ui.imageUrl).toContain('att-xyz');
  });
});

describe('mapChatMessage() — billMeta (B112)', () => {
  it('bill ĐÃ GHÉP đủ dữ liệu (B112 shape) → billMeta parse đầy đủ', () => {
    const ui = mapChatMessage(billImageDto(), 42);
    expect(ui.isBillImage).toBe(true);
    expect(ui.billMeta).toEqual({
      billFields: { tid: { value: '57025362', uncertain: false } },
      amount: 4_000_000,
      imageHeightPx: 812
    });
  });

  it('bill fallback ảnh gốc chưa ghép (B106 cũ, chỉ {isBillImage:true}) → isBillImage=true nhưng billMeta undefined', () => {
    const ui = mapChatMessage(billImageDto({ metadataJson: JSON.stringify({ isBillImage: true }) }), 42);
    expect(ui.isBillImage).toBe(true);
    expect(ui.billMeta).toBeUndefined();
  });

  it('ảnh thường (không phải bill) → cả isBillImage lẫn billMeta đều undefined', () => {
    const ui = mapChatMessage(billImageDto({ metadataJson: null }), 42);
    expect(ui.isBillImage).toBeUndefined();
    expect(ui.billMeta).toBeUndefined();
  });
});

describe('canEditChatMessage', () => {
  it('sentAtIso undefined → false', () => {
    expect(canEditChatMessage(undefined)).toBe(false);
  });

  it(`vừa gửi (0s trước) → true (trong ${MESSAGE_EDIT_WINDOW_HOURS}h)`, () => {
    expect(canEditChatMessage(new Date().toISOString())).toBe(true);
  });

  it(`quá ${MESSAGE_EDIT_WINDOW_HOURS}h → false — KHÁC HẲN canDeleteChatMessage (48h), 2 cửa sổ ĐỘC LẬP`, () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-02T12:00:00.000Z');
    vi.setSystemTime(now);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    expect(canEditChatMessage(twoHoursAgo)).toBe(false);
    vi.useRealTimers();
  });
});

describe('canEditBillMessage — điều kiện ĐẦY ĐỦ hiện nút "Sửa" (mine + isBillImage + billMeta + trong cửa sổ 1h)', () => {
  const base = { mine: true, isBillImage: true as const, billMeta: { billFields: {} as never, amount: 1, imageHeightPx: 1 }, sentAtIso: new Date().toISOString() };

  it('đủ cả 4 điều kiện → true', () => {
    expect(canEditBillMessage(base)).toBe(true);
  });

  it('không phải tin của mình → false', () => {
    expect(canEditBillMessage({ ...base, mine: false })).toBe(false);
  });

  it('không phải bill (isBillImage undefined) → false', () => {
    expect(canEditBillMessage({ ...base, isBillImage: undefined })).toBe(false);
  });

  it('thiếu billMeta (bill fallback chưa ghép) → false', () => {
    expect(canEditBillMessage({ ...base, billMeta: undefined })).toBe(false);
  });

  it('hết cửa sổ 1h → false', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(canEditBillMessage({ ...base, sentAtIso: twoHoursAgo })).toBe(false);
  });
});
