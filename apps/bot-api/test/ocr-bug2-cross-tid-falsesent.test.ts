// REPRO BUG 2 (Admin Demo stress-test POS) — bill CHƯA GỬI hiện "ĐÃ GỬI trước đó" (false positive).
// Gốc nghi: findSentByLoAmount khớp (phòng + lô + tiền + ngày) NHƯNG BỎ QUA TID → 2 MÁY POS khác nhau (TID khác)
// trong CÙNG phòng đại lý, cùng lô + cùng số tiền tròn + cùng ngày → bill máy B (chưa gửi) bị chấm = tin của máy A.
import { describe, it, expect } from 'vitest';
import { ocrImageHashOf, findSentByLoAmount, augmentReviewWithImageHash } from '../src/ocr-send-service.js';

function fakeDb(messages: { id: string; roomId: string; metadataJson: string; deletedAt?: Date | null }[]) {
  return {
    chatMessage: {
      findMany: async ({ where }: { where: { roomId?: string; metadataJson?: { contains: string }; deletedAt: null } }) =>
        messages.filter((m) => (m.deletedAt ?? null) === null && (where.roomId === undefined || m.roomId === where.roomId) && (!where.metadataJson || m.metadataJson.includes(where.metadataJson.contains)))
          .map((m) => ({ id: m.id, metadataJson: m.metadataJson, roomId: m.roomId })),
      findFirst: async ({ where }: { where: { roomId?: string; metadataJson?: { contains: string }; deletedAt: null } }) =>
        messages.filter((m) => (m.deletedAt ?? null) === null && (where.roomId === undefined || m.roomId === where.roomId) && (!where.metadataJson || m.metadataJson.includes(where.metadataJson.contains)))
          .map((m) => ({ id: m.id, metadataJson: m.metadataJson, roomId: m.roomId }))[0] ?? null
    }
  } as never;
}

// Tin ĐÃ GỬI của MÁY A (TID 53550005) — lô 5, 10.000.000đ, ngày 04/09/2026, ảnh A.
const IMG_A = Buffer.from('ANH-BILL-MAY-A-TID-53550005');
const sentMsgMayA = {
  id: 'msg-mayA', roomId: 'room-daily', deletedAt: null,
  metadataJson: JSON.stringify({ ocrImageHash: ocrImageHashOf(IMG_A), ocrLo: '5', ocrSendKey: 'VL|53550005|5|2026-09-04|amt:10000000' })
};

describe('BUG 2 — false "đã gửi" do trùng lô+tiền+ngày giữa 2 MÁY (TID) khác nhau', () => {
  it('findSentByLoAmount: máy B (TID khác) cùng lô+tiền+ngày → KHÔNG được coi là đã gửi', async () => {
    const db = fakeDb([sentMsgMayA]);
    // Máy B TID 53550088 — bill THẬT MỚI, chưa gửi bao giờ. Truyền tid máy B vào.
    const hit = await findSentByLoAmount(db, 'room-daily', '5', 10000000, '04/09/2026 09:30', '53550088');
    expect(hit).toBeNull(); // FIX: khác TID = khác bill → không khớp.
  });

  it('findSentByLoAmount: CÙNG máy (TID) cùng lô+tiền+ngày → VẪN khớp (giữ chống gửi trùng bill cũ pre-hash)', async () => {
    const db = fakeDb([sentMsgMayA]);
    const hit = await findSentByLoAmount(db, 'room-daily', '5', 10000000, '04/09/2026 09:30', '53550005');
    expect(hit).toBe('msg-mayA');
  });

  it('augmentReviewWithImageHash: bill máy B (ảnh khác, TID khác) KHÔNG bị set alreadySent', async () => {
    const db = fakeDb([sentMsgMayA]);
    const IMG_B = Buffer.from('ANH-BILL-MAY-B-TID-53550088-KHAC-HAN'); // ảnh KHÁC → hash khác → tier-1 miss.
    const review = [{ dealerRoomId: 'room-daily', alreadySent: false, sentMessageId: null, bill: { batchNumber: '5', tid: '53550088', totalAmount: 10000000, dateTime: '04/09/2026 09:30' } }] as never as Parameters<typeof augmentReviewWithImageHash>[1];
    await augmentReviewWithImageHash(db, review, IMG_B);
    expect(review[0].alreadySent).toBe(false);
    expect(review[0].sentMessageId).toBeNull();
  });

  it('augmentReviewWithImageHash: bill CÙNG máy A gửi lại (ảnh khác pre-hash) VẪN bị khóa alreadySent (giữ chống trùng)', async () => {
    const db = fakeDb([sentMsgMayA]);
    const IMG_A2 = Buffer.from('ANH-BILL-MAY-A-CHUP-LAI'); // ảnh khác bytes (pre-hash) → tier-1 miss → rơi tier-2 lô+tiền+ngày+TID.
    const review = [{ dealerRoomId: 'room-daily', alreadySent: false, sentMessageId: null, bill: { batchNumber: '5', tid: '53550005', totalAmount: 10000000, dateTime: '04/09/2026 09:30' } }] as never as Parameters<typeof augmentReviewWithImageHash>[1];
    await augmentReviewWithImageHash(db, review, IMG_A2);
    expect(review[0].alreadySent).toBe(true);
    expect(review[0].sentMessageId).toBe('msg-mayA');
  });
});
