// UNIT TEST (Admin Demo 3/9) — nhận diện "ĐÃ GỬI" theo HASH ẢNH, chống double-send + doanh số x2 khi OCR đọc lệch số.
// Bản chất: bill đã gửi mà OCR đọc sai tid/lô/tiền → ocrSendKey KHÔNG khớp → tưởng bill mới → gửi trùng → x2.
// Fix: khóa theo HASH ẢNH (ổn định) → luôn nhận "đã gửi" → buộc Cập nhật tin cũ, cấm gửi mới. R198 check chạy thật.
import { describe, it, expect } from 'vitest';
import { ocrImageHashOf, imageSentMarker, findSentByImageHash, augmentReviewWithImageHash } from '../src/ocr-send-service.js';

const IMG_A = Buffer.from('ANH-BILL-THAI-BINH-1-LO-3');
const IMG_B = Buffer.from('ANH-BILL-KHAC');

describe('ocrImageHashOf — hash ổn định theo ẢNH', () => {
  it('cùng buffer → cùng hash', () => { expect(ocrImageHashOf(IMG_A)).toBe(ocrImageHashOf(Buffer.from('ANH-BILL-THAI-BINH-1-LO-3'))); });
  it('ảnh khác → hash khác', () => { expect(ocrImageHashOf(IMG_A)).not.toBe(ocrImageHashOf(IMG_B)); });
  it('hash sha256 hex 64 ký tự', () => { expect(ocrImageHashOf(IMG_A)).toMatch(/^[0-9a-f]{64}$/); });
});

/** Db giả: chatMessage.findMany lọc theo metadataJson.contains + roomId + deletedAt. */
function fakeDb(messages: { id: string; roomId: string; metadataJson: string; deletedAt: Date | null }[]) {
  return {
    chatMessage: {
      findMany: async ({ where }: { where: { roomId: string; metadataJson: { contains: string }; deletedAt: null } }) =>
        messages.filter((m) => m.roomId === where.roomId && m.deletedAt === null && m.metadataJson.includes(where.metadataJson.contains))
          .map((m) => ({ id: m.id, metadataJson: m.metadataJson }))
    }
  } as never;
}

describe('findSentByImageHash', () => {
  const hashA = ocrImageHashOf(IMG_A);
  it('cùng ảnh → trả messageId (dù OCR đọc lệch số)', async () => {
    const db = fakeDb([{ id: 'msg1', roomId: 'room1', metadataJson: JSON.stringify({ ocrImageHash: hashA, ocrLo: '3', ocrSendKey: 'VL|5350003|3|02/09' }), deletedAt: null }]);
    expect(await findSentByImageHash(db, 'room1', hashA, '3')).toBe('msg1');
  });
  it('ảnh chưa gửi → null', async () => {
    const db = fakeDb([{ id: 'msg1', roomId: 'room1', metadataJson: JSON.stringify({ ocrImageHash: ocrImageHashOf(IMG_B), ocrLo: '9' }), deletedAt: null }]);
    expect(await findSentByImageHash(db, 'room1', hashA, '3')).toBeNull();
  });
  it('nhiều tin cùng ảnh (ảnh nhiều lô) → ưu tiên tin CÙNG lô', async () => {
    const db = fakeDb([
      { id: 'msgLo3', roomId: 'room1', metadataJson: JSON.stringify({ ocrImageHash: hashA, ocrLo: '3' }), deletedAt: null },
      { id: 'msgLo5', roomId: 'room1', metadataJson: JSON.stringify({ ocrImageHash: hashA, ocrLo: '5' }), deletedAt: null }
    ]);
    expect(await findSentByImageHash(db, 'room1', hashA, '5')).toBe('msgLo5');
  });
  it('phòng khác → không khớp', async () => {
    const db = fakeDb([{ id: 'msg1', roomId: 'room2', metadataJson: JSON.stringify({ ocrImageHash: hashA }), deletedAt: null }]);
    expect(await findSentByImageHash(db, 'room1', hashA, null)).toBeNull();
  });
});

describe('augmentReviewWithImageHash — khóa gửi-mới cho bill đã gửi (OCR đọc lệch tid)', () => {
  it('OCR đọc TID SAI (khác lúc gửi) nhưng CÙNG ảnh → set alreadySent + sentMessageId', async () => {
    const hashA = ocrImageHashOf(IMG_A);
    // Tin đã gửi lúc TID đúng 5350003; giờ OCR đọc lệch thành 51530003 → ocrSendKey miss → reviewBills để alreadySent=false.
    const db = fakeDb([{ id: 'msgSent', roomId: 'room1', metadataJson: JSON.stringify({ ocrImageHash: hashA, ocrLo: '3', ocrSendKey: 'VL|5350003|3|02/09|amt:100' }), deletedAt: null }]);
    const review = [{ dealerRoomId: 'room1', alreadySent: false, sentMessageId: null, bill: { batchNumber: '3', tid: '51530003' } }] as never as Parameters<typeof augmentReviewWithImageHash>[1];
    await augmentReviewWithImageHash(db, review, IMG_A);
    expect(review[0].alreadySent).toBe(true);
    expect(review[0].sentMessageId).toBe('msgSent');
  });
  it('ảnh chưa gửi bao giờ → giữ nguyên alreadySent=false (cho gửi mới)', async () => {
    const db = fakeDb([]);
    const review = [{ dealerRoomId: 'room1', alreadySent: false, sentMessageId: null, bill: { batchNumber: '3', tid: '5350003' } }] as never as Parameters<typeof augmentReviewWithImageHash>[1];
    await augmentReviewWithImageHash(db, review, IMG_A);
    expect(review[0].alreadySent).toBe(false);
    expect(review[0].sentMessageId).toBeNull();
  });
  it('item không có phòng đại lý → bỏ qua (không tra)', async () => {
    const db = fakeDb([{ id: 'x', roomId: 'room1', metadataJson: JSON.stringify({ ocrImageHash: ocrImageHashOf(IMG_A) }), deletedAt: null }]);
    const review = [{ dealerRoomId: null, alreadySent: false, sentMessageId: null, bill: { batchNumber: '3', tid: null } }] as never as Parameters<typeof augmentReviewWithImageHash>[1];
    await augmentReviewWithImageHash(db, review, IMG_A);
    expect(review[0].alreadySent).toBe(false);
  });
  it('imageSentMarker khớp format metadata thật', () => {
    const h = ocrImageHashOf(IMG_A);
    expect(JSON.stringify({ ocrImageHash: h }).includes(imageSentMarker(h))).toBe(true);
  });
});
