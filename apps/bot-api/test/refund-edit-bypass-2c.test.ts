// AUDIT-1 (3/8) — REGRESSION cho BUG bảo mật: SỬA (editMessage / PATCH /v1/chat/messages/:id) tin "Hoàn tiền"
// TRƯỚC ĐÂY BỎ QUA lớp kiểm chứng server-side re-OCR (annotateRefundMetadataOnSave — NỢ #2c) mà sendMessage()
// có. Hệ quả: chính chủ bill gửi 1 tin hoàn tiền số ĐÚNG (được verify), rồi SỬA lên số BỊA lớn hơn tùy ý → tin
// bị coi là "đã kiểm chứng" (không cờ refundUnverified) → KPI/cộng dồn tính thành "Hoàn đủ" giả.
//
// CÙNG khuôn refund-verify.test.ts: throwaway Postgres THẬT (global-setup) + attachment THẬT + stub global.fetch
// cho OCR (microservice Python không chạy trong test). ASSERT GIÁ TRỊ THẬT (không chỉ ok:true).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends, makeQuoteReadyTid } from './fixtures.js';
import { findOrCreateDirectRoom } from '../src/services/chat-room-service.js';
import { sendMessage, editMessage } from '../src/services/chat-message-service.js';
import { saveAttachment } from '../src/chat-attachment-service.js';
import { buildRefundKpiReport } from '../src/refund-report-service.js';

const REAL_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

/** OCR ảnh THẬT (mọi ảnh trong test này) LUÔN đọc ra 1.000.000 — mô phỏng biên lai thật 1 triệu. */
function stubOcrOneMillion() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: [{ text: 'VND 1000.000', score: 0.98 }] }) }));
}

function parseMeta(metadataJson: string | null): {
  refundAmount?: number;
  refundUnverified?: boolean;
  refundVerification?: { verified: boolean; outcome: string; ocrAmount: number | null; claimedAmount: number };
} {
  return metadataJson ? JSON.parse(metadataJson) : {};
}

describe('editMessage — SỬA tin hoàn tiền PHẢI re-OCR đối chiếu (NỢ #2c, KHÔNG né qua đường Sửa)', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function sendVerifiedRefund() {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);
    const room = await findOrCreateDirectRoom(db, a.id, b.id);
    const saved = await saveAttachment(db, REAL_PNG_BUFFER, 'bien-lai.png', a.id);
    if (!saved.ok) throw new Error(`saveAttachment thất bại: ${saved.reason}`);
    stubOcrOneMillion();
    const msg = await sendMessage(db, {
      roomId: room.id,
      senderId: a.id,
      kind: 'IMAGE',
      attachmentId: saved.id,
      metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_000_000 })
    });
    // Sanity: tin gốc đã được verify sạch (control).
    expect(parseMeta(msg.metadataJson).refundUnverified).not.toBe(true);
    expect(parseMeta(msg.metadataJson).refundVerification?.verified).toBe(true);
    return { db, a, room, msg };
  }

  it('SỬA bơm số hoàn 1tr → 9tr (ảnh vẫn 1tr) → server gắn cờ refundUnverified=true, outcome amount_mismatch', async () => {
    const { db, a, msg } = await sendVerifiedRefund();
    // Ảnh mới do CHÍNH a upload (điều kiện ownership), OCR vẫn đọc ra 1tr — nhưng client khai 9tr.
    const newAtt = await saveAttachment(db, REAL_PNG_BUFFER, 'bien-lai-2.png', a.id);
    if (!newAtt.ok) throw new Error('saveAttachment (2) thất bại');
    stubOcrOneMillion();

    const edited = await editMessage(db, msg.id, a.id, 'sửa số hoàn', {
      newAttachmentId: newAtt.id,
      newMetadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 9_000_000 })
    });
    const meta = parseMeta(edited.metadataJson);
    expect(meta.refundAmount).toBe(9_000_000); // giá trị khai vẫn giữ trong metadata...
    expect(meta.refundUnverified).toBe(true); // ...NHƯNG bị gắn cờ CHƯA kiểm chứng (OCR 1tr ≠ khai 9tr).
    expect(meta.refundVerification?.verified).toBe(false);
    expect(meta.refundVerification?.outcome).toBe('amount_mismatch');
    expect(meta.refundVerification?.ocrAmount).toBe(1_000_000);
    expect(meta.refundVerification?.claimedAmount).toBe(9_000_000);
  });

  it('SỬA và client TỰ NHÉT refundUnverified:false + refundVerification giả → server GHI ĐÈ theo OCR thật', async () => {
    const { db, a, msg } = await sendVerifiedRefund();
    const newAtt = await saveAttachment(db, REAL_PNG_BUFFER, 'bien-lai-3.png', a.id);
    if (!newAtt.ok) throw new Error('saveAttachment (3) thất bại');
    stubOcrOneMillion();

    const edited = await editMessage(db, msg.id, a.id, 'sửa số hoàn (cố khai đã kiểm chứng)', {
      newAttachmentId: newAtt.id,
      newMetadataJson: JSON.stringify({
        isRefundImage: true,
        refundAmount: 9_000_000,
        refundUnverified: false,
        refundVerification: { verified: true, outcome: 'verified', ocrAmount: 9_000_000, claimedAmount: 9_000_000 }
      })
    });
    const meta = parseMeta(edited.metadataJson);
    expect(meta.refundUnverified).toBe(true); // server ghi đè cờ client tự nhét.
    expect(meta.refundVerification?.verified).toBe(false);
    expect(meta.refundVerification?.ocrAmount).toBe(1_000_000); // theo OCR ảnh thật, KHÔNG theo 9tr client khai.
  });

  it('SỬA về số ĐÚNG khớp ảnh (1tr, lệch trong ngưỡng) → verified=true, KHÔNG cờ refundUnverified (control hợp lệ)', async () => {
    const { db, a, msg } = await sendVerifiedRefund();
    const newAtt = await saveAttachment(db, REAL_PNG_BUFFER, 'bien-lai-4.png', a.id);
    if (!newAtt.ok) throw new Error('saveAttachment (4) thất bại');
    stubOcrOneMillion();

    const edited = await editMessage(db, msg.id, a.id, 'sửa caption, giữ số đúng', {
      newAttachmentId: newAtt.id,
      newMetadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_000_000 })
    });
    const meta = parseMeta(edited.metadataJson);
    expect(meta.refundUnverified).not.toBe(true);
    expect(meta.refundVerification?.verified).toBe(true);
    expect(meta.refundVerification?.ocrAmount).toBe(1_000_000);
  });
});

describe('buildRefundKpiReport — SỬA bơm số hoàn KHÔNG được đẩy bill thành "Hoàn đủ" giả', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('bill 1tr + refund gửi đúng 1tr rồi SỬA lên 9tr → bill KHÔNG "Hoàn đủ" (over/matched=0), vẫn Hoàn thiếu/chưa hoàn', async () => {
    const { agent, tid } = await makeQuoteReadyTid({ phiBanMilli: 0 }); // phí 0% → required = billAmount = 1tr.
    const db = getBotDb();
    const room = await db.chatRoom.create({ data: { type: 'GROUP', name: `phong-edit2c-${Math.random().toString(36).slice(2)}` } });
    await db.chatRoomMember.create({ data: { roomId: room.id, agentId: agent.id, role: 'OWNER' } });
    await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: agent.id, createdAt: new Date('2020-01-01T00:00:00.000Z') } });

    const bill = await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: agent.id,
        kind: 'IMAGE',
        metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billFields: { tid: { value: tid.tid, uncertain: false } } })
      }
    });

    // Gửi refund ĐÚNG 1tr (verified) trả lời bill, có attachment thật.
    const att = await saveAttachment(db, REAL_PNG_BUFFER, 'bien-lai-kpi.png', agent.id);
    if (!att.ok) throw new Error('saveAttachment (kpi) thất bại');
    stubOcrOneMillion();
    const refund = await sendMessage(db, {
      roomId: room.id,
      senderId: agent.id,
      kind: 'IMAGE',
      attachmentId: att.id,
      replyToMessageId: bill.id,
      metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_000_000 })
    });

    // Control: trước khi sửa, refund 1tr khớp required 1tr → bill "Hoàn đủ".
    const before = await buildRefundKpiReport(db, agent.id, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    expect(before.totalRefundedCount).toBe(1);

    // Kẻ gian SỬA refund lên 9tr (ảnh vẫn 1tr).
    const att2 = await saveAttachment(db, REAL_PNG_BUFFER, 'bien-lai-kpi2.png', agent.id);
    if (!att2.ok) throw new Error('saveAttachment (kpi2) thất bại');
    stubOcrOneMillion();
    await editMessage(db, refund.id, agent.id, 'sửa bơm số', {
      newAttachmentId: att2.id,
      newMetadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 9_000_000 })
    });

    const after = await buildRefundKpiReport(db, agent.id, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    // Khoản bơm chưa kiểm chứng bị BỎ QUA → tổng đã hoàn KHÔNG cộng 9tr, bill KHÔNG "Hoàn đủ"/"Hoàn thừa".
    expect(after.totalRefundedCount).toBe(0);
    expect(after.totalOverCount).toBe(0);
    expect(after.totalRefundedAmount).toBe(0);
    expect(after.totalUnrefundedCount).toBe(1);
  });
});
