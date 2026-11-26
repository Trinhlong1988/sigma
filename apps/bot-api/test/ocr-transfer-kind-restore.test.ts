// UNIT TEST (Admin Demo 3/9) — "cái nào đã sửa phải cập nhật đúng, OCR lại phải đúng". CK loại ỨNG (SigMa ứng trước cho
// đại lý) auto KHÔNG đoán được (classifyTransfer luôn trả HOÀN) → user chọn tay ỨNG + gửi. OCR LẠI phải NHỚ là ỨNG,
// không revert về HOÀN. Fix: augmentTransferReviewWithSentKind đọc lại kind từ tin CK đã gửi (khớp ckTxnKey có ảnh).
import { describe, it, expect } from 'vitest';
import { augmentTransferReviewWithSentKind, buildCkTxnKey } from '../src/ocr-send-service.js';
import type { TransferReview } from '../src/ocr-send-service.js';

const IMG = Buffer.from('BILL-CK-UNG-TIEN-200TR');
const baseTr = (): TransferReview => ({
  senderName: 'NGUYEN VAN A', senderIsAlpha: true, senderAccount: '111', receiverName: 'KHACH HANG 52',
  receiverAccount: '222', content: null, amount: 200_000_000, bank: 'BIDV', date: '03/09/2026', time: '09:15:00', ref: 'FT123',
  senderBank: null, matchedRoomId: 'roomDealer', matchedRoomName: 'ĐL Nguyễn SG',
  direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null, needsManualPick: false, warnings: [], alreadySent: false
});

/** Db giả: chatMessage.findMany trả tin CK đã gửi (metadata có kind + ckTxnKey khớp). */
function fakeDb(metaList: Record<string, unknown>[]) {
  return {
    chatMessage: {
      findMany: async () => metaList.map((m, i) => ({ id: `msg${i}`, metadataJson: JSON.stringify(m), createdAt: new Date('2026-09-03T00:00:00Z') }))
    }
  } as never;
}

describe('augmentTransferReviewWithSentKind — khôi phục kind ứng/hoàn đã gửi', () => {
  it('CK đã gửi loại ỨNG → OCR lại giữ ADVANCE + alreadySent (không revert về HOÀN)', async () => {
    const tr = baseTr();
    const ckKey = buildCkTxnKey(tr, IMG); // key khớp lúc gửi
    const db = fakeDb([{ isTransferRefund: true, isDealerAdvanceCk: true, isDealerRefundCk: false, refundAmount: 200_000_000, ckTxnKey: ckKey }]);
    await augmentTransferReviewWithSentKind(db, [tr], IMG);
    expect(tr.direction).toBe('SIGMA_TO_DEALER_ADVANCE'); // NHỚ là ứng
    expect(tr.alreadySent).toBe(true);
    expect(tr.sentMessageId).toBe('msg0');
  });

  it('CK đã gửi loại HOÀN → giữ SIGMA_TO_DEALER + alreadySent', async () => {
    const tr = baseTr();
    const ckKey = buildCkTxnKey(tr, IMG);
    const db = fakeDb([{ isTransferRefund: true, isDealerRefundCk: true, isDealerAdvanceCk: false, refundAmount: 200_000_000, ckTxnKey: ckKey }]);
    await augmentTransferReviewWithSentKind(db, [tr], IMG);
    expect(tr.direction).toBe('SIGMA_TO_DEALER');
    expect(tr.alreadySent).toBe(true);
  });

  it('CK CHƯA gửi (không khớp ckTxnKey) → giữ nguyên direction OCR, alreadySent=false', async () => {
    const tr = baseTr();
    const db = fakeDb([{ isTransferRefund: true, isDealerAdvanceCk: true, refundAmount: 5, ckTxnKey: 'ck|nat|KHAC' }]);
    await augmentTransferReviewWithSentKind(db, [tr], IMG);
    expect(tr.direction).toBe('SIGMA_TO_DEALER'); // OCR default, không đổi
    expect(tr.alreadySent).toBe(false);
  });

  it('không có phòng đại lý khớp → bỏ qua (không tra)', async () => {
    const tr = { ...baseTr(), matchedRoomId: null };
    const db = fakeDb([{ isTransferRefund: true, isDealerAdvanceCk: true, refundAmount: 200_000_000, ckTxnKey: buildCkTxnKey(baseTr(), IMG) }]);
    await augmentTransferReviewWithSentKind(db, [tr], IMG);
    expect(tr.alreadySent).toBe(false);
  });
});
