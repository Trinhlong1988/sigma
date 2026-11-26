// REGRESSION cho AUDIT 3/9 (deep-audit 6-finder + phản biện). Chống tái diễn các bug tiền đã CONFIRMED.
// #7 findSentByLoAmount PHẢI khớp NGÀY (lô cycle theo ngày → thiếu ngày = false 'đã gửi' xuyên ngày → SÓT).
// #1 findSentByImageHashGlobal dò TOÀN CỤC mọi phòng (chống x2 khi TID đổi sang máy khác PHÒNG).
import { describe, it, expect } from 'vitest';
import { findSentByLoAmount, findSentByImageHashGlobal, ocrImageHashOf } from '../src/ocr-send-service.js';

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

describe('#7 findSentByLoAmount — BẮT BUỘC khớp NGÀY (chống false đã-gửi xuyên ngày)', () => {
  const meta = (lo: string, day: string, amt: number) => JSON.stringify({ ocrSendKey: `VL|5350003|${lo}|${day}|amt:${amt}`, ocrLo: lo });
  it('cùng lô+tiền+NGÀY → khớp (đã gửi)', async () => {
    const db = fakeDb([{ id: 'm1', roomId: 'R1', metadataJson: meta('5', '2026-09-03', 1000000) }]);
    expect(await findSentByLoAmount(db, 'R1', '5', 1000000, '03/09/2026 10:00')).toBe('m1');
  });
  it('cùng lô+tiền nhưng KHÁC NGÀY → KHÔNG khớp (lô 5 hôm nay ≠ lô 5 hôm qua) → cho gửi, không SÓT', async () => {
    const db = fakeDb([{ id: 'm1', roomId: 'R1', metadataJson: meta('5', '2026-09-02', 1000000) }]);
    expect(await findSentByLoAmount(db, 'R1', '5', 1000000, '03/09/2026 10:00')).toBeNull();
  });
  it('thiếu ngày bill (OCR không đọc được) → KHÔNG match (tránh false-positive)', async () => {
    const db = fakeDb([{ id: 'm1', roomId: 'R1', metadataJson: meta('5', '2026-09-03', 1000000) }]);
    expect(await findSentByLoAmount(db, 'R1', '5', 1000000, null)).toBeNull();
  });
  it('khác tiền → KHÔNG match', async () => {
    const db = fakeDb([{ id: 'm1', roomId: 'R1', metadataJson: meta('5', '2026-09-03', 1000000) }]);
    expect(await findSentByLoAmount(db, 'R1', '5', 999999, '03/09/2026 10:00')).toBeNull();
  });
});

describe('#1 findSentByImageHashGlobal — dò TOÀN CỤC (chống x2 cross-phòng khi TID đổi máy)', () => {
  const IMG = Buffer.from('BILL-ANH-X');
  const h = ocrImageHashOf(IMG);
  it('ảnh đã gửi phòng R1 → tra global thấy (dù đang định gửi phòng R2)', async () => {
    const db = fakeDb([{ id: 'msgR1', roomId: 'R1', metadataJson: JSON.stringify({ ocrImageHash: h, ocrSendKey: 'VL|59930002|5|2026-09-03|amt:1' }) }]);
    const g = await findSentByImageHashGlobal(db, h);
    expect(g?.messageId).toBe('msgR1');
    expect(g?.roomId).toBe('R1');
  });
  it('ảnh chưa gửi → null', async () => {
    const db = fakeDb([{ id: 'x', roomId: 'R1', metadataJson: JSON.stringify({ ocrImageHash: ocrImageHashOf(Buffer.from('KHAC')) }) }]);
    expect(await findSentByImageHashGlobal(db, h)).toBeNull();
  });
});
