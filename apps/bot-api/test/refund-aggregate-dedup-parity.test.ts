// [Agent-4 phản biện 11/9 — 2 SURFACE LỆCH NHAU] buildRefundKpiReport (KPI) KHỬ TRÙNG theo refundDedup.transferCode
// per-bill (2a 4/8) nhưng listRefundConfirmationsForMessage (panel "Hoàn tiền" + /v1/me/refund/aggregate +
// /v1/chat/messages/:id/refunds) CỘNG ĐỦ CẢ 2 lần cùng mã CK → cùng 1 bill: KPI nói "hoàn thiếu 400k/1tr" còn
// panel nói "đã hoàn 800k" (đếm đôi cùng 1 giao dịch thật) — vi phạm bài học parity 2 tab phải đồng nhất
// (feedback_ocr_send_two_tabs_parity). Test theo khuôn refund-service.test.ts (DB thật + fixtures, chỉ INSERT).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends, makeTid } from './fixtures.js';
import { findOrCreateDirectRoom } from '../src/services/chat-room-service.js';
import { sendMessage } from '../src/services/chat-message-service.js';
import { saveAttachment } from '../src/chat-attachment-service.js';
import { listRefundConfirmationsForMessage } from '../src/refund-service.js';
import { buildRefundKpiReport } from '../src/refund-report-service.js';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function stubOcrMatching(amount: number) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: [{ text: `VND ${amount}`, score: 0.97 }] }) }));
}
afterEach(() => vi.unstubAllGlobals());

describe('parity KPI ↔ panel: cùng mã CK gửi 2 lần cho 1 bill chỉ được tính 1 lần ở CẢ 2 nguồn', () => {
  it('2 confirmation CÙNG transferCode → tổng "đã hoàn" panel = 400k (không phải 800k), khớp KPI', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);
    const room = await findOrCreateDirectRoom(db, a.id, b.id);
    // Phòng "chính thức với SigMa" (KPI chỉ đếm bill trong phòng có TID gắn active TẠI thời điểm bill — khuôn kpi.test.ts).
    const tid = await makeTid({ agentId: a.id });
    await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: a.id, createdAt: new Date('2020-01-01T00:00:00.000Z') } });
    const up0 = await saveAttachment(db, PNG_1PX, 'bill.png', a.id);
    if (!up0.ok) throw new Error('setup thất bại');
    const bill = await sendMessage(db, {
      roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up0.id, body: 'bill goc',
      metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800, billFields: { tid: { value: '111', uncertain: false } } })
    });
    // Đại lý bỏ qua cảnh báo dedup, gửi 2 lần CÙNG mã CK FT9988TEST (cùng 1 giao dịch thật 400k chụp 2 ảnh).
    for (const name of ['hoan1.png', 'hoan2.png']) {
      const up = await saveAttachment(db, PNG_1PX, name, a.id);
      if (!up.ok) throw new Error('setup thất bại');
      stubOcrMatching(400_000);
      await sendMessage(db, {
        roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up.id, body: name, replyToMessageId: bill.id,
        metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 400_000, refundDedup: { transferCode: 'FT9988TEST' } })
      });
    }

    // Nguồn 1 — KPI (đã dedup từ 4/8): refundedAmount = 400k.
    const from = new Date(Date.now() - 3600_000), to = new Date(Date.now() + 3600_000);
    const kpi = await buildRefundKpiReport(db, a.id, from, to);
    expect(kpi.totalRefundedAmount).toBe(400_000);

    // Nguồn 2 — panel cộng dồn (route /refund/aggregate + /messages/:id/refunds sum list này): PHẢI khớp KPI.
    const confirmations = await listRefundConfirmationsForMessage(db, a.id, bill.id);
    const total = confirmations.reduce((s, c) => s + c.amount, 0);
    expect(total).toBe(400_000); // TRƯỚC FIX: 800.000 — cùng 1 CK đếm đôi, bill nhảy "Hoàn thiếu"→"Hoàn đủ" giả
  });

  it('2 confirmation KHÁC transferCode (2 GD thật) → vẫn cộng đủ cả 2 (không khử oan)', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);
    const room = await findOrCreateDirectRoom(db, a.id, b.id);
    const up0 = await saveAttachment(db, PNG_1PX, 'bill.png', a.id);
    if (!up0.ok) throw new Error('setup thất bại');
    const bill = await sendMessage(db, {
      roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up0.id, body: 'bill goc',
      metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800, billFields: { tid: { value: '111', uncertain: false } } })
    });
    const cases: [string, number][] = [['FTAAA1', 300_000], ['FTAAA2', 200_000]];
    for (const [code, amt] of cases) {
      const up = await saveAttachment(db, PNG_1PX, `${code}.png`, a.id);
      if (!up.ok) throw new Error('setup thất bại');
      stubOcrMatching(amt);
      await sendMessage(db, {
        roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up.id, body: code, replyToMessageId: bill.id,
        metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: amt, refundDedup: { transferCode: code } })
      });
    }
    const confirmations = await listRefundConfirmationsForMessage(db, a.id, bill.id);
    expect(confirmations.reduce((s, c) => s + c.amount, 0)).toBe(500_000);
    // Khoản KHÔNG có transferCode giữ hành vi cũ (cộng đủ) — đã cover bởi refund-service.test.ts hiện có.
  });
});
