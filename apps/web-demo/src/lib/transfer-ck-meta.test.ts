// Bill CHUYỂN KHOẢN (CK) trong chat (1/9, Admin Demo "cấm text lộn xộn") — regression cho parseTransferCkMeta()
// + nhánh mapChatMessage() gắn `transferCk`. Shape metadata khớp CHÍNH XÁC backend apps/bot-api/src/
// ocr-send-service.ts (postDealerRefundCk meta line ~607, postInvestorTransferCk meta line ~706/724). Pure-logic
// environment node (repo chưa có hạ tầng render component — CÙNG quy ước bill-edit-mapping.test.ts).
import { describe, expect, it } from 'vitest';
import { mapChatMessage, parseTransferCkMeta, type ChatMessageDto } from './chat-client';

function imageDto(metadataJson: string | null, overrides: Partial<ChatMessageDto> = {}): ChatMessageDto {
  return {
    id: 'ck-1', roomId: 'room-1', senderId: 99, kind: 'IMAGE', body: 'caption thô nhiều dòng',
    attachmentId: 'att-1', metadataJson, replyToMessageId: null, forwardedFromMessageId: null,
    editedAt: null, deletedAt: null, createdAt: new Date().toISOString(),
    attachmentMimeType: 'image/jpeg', attachmentSizeBytes: 1000, ...overrides
  };
}

// Meta THẬT do backend sinh (đã đọc code, KHÔNG đoán).
const dealerRefund = JSON.stringify({ isTransferRefund: true, isDealerRefundCk: true, isDealerAdvanceCk: false, refundAmount: 122_859_000, ckTxnKey: 'ck|ref|FT24313ABC123', billDate: '31/08/2026', receiverAcct: '0900000600', senderName: 'KHACH HANG 01' });
const dealerRefundOver = JSON.stringify({ isTransferRefund: true, isDealerRefundCk: true, isDealerAdvanceCk: false, refundAmount: -300_000, ckTxnKey: 'ck|ref|FT24777QQ', billDate: '30/08/2026' });
const dealerAdvance = JSON.stringify({ isTransferRefund: true, isDealerRefundCk: false, isDealerAdvanceCk: true, refundAmount: 5_000_000, ckTxnKey: 'ck|ref|FT24999XY', billDate: '01/09/2026' });
const investorAdvance = JSON.stringify({ isTransferRefund: true, isInvestorAdvanceCk: true, direction: 'SIGMA_TO_INVESTOR', advanceAmount: 20_000_000, ckTxnKey: 'ck|hash|9f8a', investorId: 15 });
const investorRepay = JSON.stringify({ isTransferRefund: true, isInvestorRepaymentCk: true, direction: 'INVESTOR_TO_ALPHA', repaymentAmount: 1_500_000, ckTxnKey: 'ck|nat|1500000', investorId: 15 });

describe('parseTransferCkMeta()', () => {
  it('hoàn tiền đại lý (refundAmount ≥ 0) → REFUND + amount + billDate + ckTxnKey', () => {
    // toMatchObject (như các case anh em) — hàm nay trả thêm partyName/senderName/receiverName/status cho card-display
    // (Admin Demo 1/9), khớp một phần các trường lõi là đủ; status mặc định 'success' verify riêng ở dưới.
    expect(parseTransferCkMeta(dealerRefund)).toMatchObject({ kind: 'REFUND', amount: 122_859_000, billDate: '31/08/2026', ckTxnKey: 'ck|ref|FT24313ABC123', status: 'success' });
  });
  it('đại lý hoàn thừa (refundAmount < 0) → DEALER_REFUND_OVER (giữ số ÂM, UI tự trị tuyệt đối)', () => {
    expect(parseTransferCkMeta(dealerRefundOver)).toMatchObject({ kind: 'DEALER_REFUND_OVER', amount: -300_000 });
  });
  it('đại lý ứng trước → ADVANCE lấy refundAmount', () => {
    expect(parseTransferCkMeta(dealerAdvance)).toMatchObject({ kind: 'ADVANCE', amount: 5_000_000 });
  });
  it('tạm ứng NĐT → INVESTOR_ADVANCE lấy advanceAmount + direction (không có billDate)', () => {
    expect(parseTransferCkMeta(investorAdvance)).toMatchObject({ kind: 'INVESTOR_ADVANCE', amount: 20_000_000, ckTxnKey: 'ck|hash|9f8a', direction: 'SIGMA_TO_INVESTOR', status: 'success' });
  });
  it('NĐT hoàn thừa → INVESTOR_REPAYMENT lấy repaymentAmount', () => {
    expect(parseTransferCkMeta(investorRepay)).toMatchObject({ kind: 'INVESTOR_REPAYMENT', amount: 1_500_000, direction: 'INVESTOR_TO_ALPHA' });
  });

  it('KHÔNG phải CK (isTransferRefund thiếu) → null', () => {
    expect(parseTransferCkMeta(JSON.stringify({ isBillImage: true, billAmount: 1000 }))).toBeNull();
  });
  it('isTransferRefund nhưng không cờ loại nào → null (không đủ để render card)', () => {
    expect(parseTransferCkMeta(JSON.stringify({ isTransferRefund: true, ckTxnKey: 'ck|ref|x' }))).toBeNull();
  });
  it('amount = 0 hoặc không phải số → null', () => {
    expect(parseTransferCkMeta(JSON.stringify({ isTransferRefund: true, isDealerRefundCk: true, refundAmount: 0 }))).toBeNull();
    expect(parseTransferCkMeta(JSON.stringify({ isTransferRefund: true, isDealerAdvanceCk: true }))).toBeNull();
  });
  it('metadata hỏng / null → null (KHÔNG throw)', () => {
    expect(parseTransferCkMeta('{ hỏng json')).toBeNull();
    expect(parseTransferCkMeta(null)).toBeNull();
    expect(parseTransferCkMeta(undefined)).toBeNull();
  });
});

describe('mapChatMessage() gắn transferCk', () => {
  it('tin IMAGE CK → message.transferCk có giá trị, KHÔNG set isBillImage/isRefundImage (tách khỏi bill/hoàn lẻ)', () => {
    const ui = mapChatMessage(imageDto(dealerRefund), 42);
    expect(ui.transferCk).toMatchObject({ kind: 'REFUND', amount: 122_859_000 });
    expect(ui.isBillImage).toBeUndefined();
    expect(ui.isRefundImage).toBeUndefined();
    expect(ui.billMeta).toBeUndefined();
    expect(ui.refundMeta).toBeUndefined();
  });
  it('ảnh bill POS thường (isBillImage) → transferCk undefined', () => {
    const ui = mapChatMessage(imageDto(JSON.stringify({ isBillImage: true, billAmount: 4_000_000, billImageHeightPx: 800, billFields: {} })), 42);
    expect(ui.transferCk).toBeUndefined();
    expect(ui.isBillImage).toBe(true);
  });
});
