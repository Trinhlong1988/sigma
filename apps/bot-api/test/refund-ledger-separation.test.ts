// SIGMA (Admin Demo 5/9) — TÁCH SỔ HOÀN TIỀN: SigMa có 3 SỔ hoàn tiền RIÊNG BIỆT, phân biệt bằng cờ trong
// chat_messages.metadataJson. Test này CHỨNG MINH (throwaway Postgres THẬT, CÙNG khuôn refund-edit-bypass-2c.test.ts):
//   1) Sổ POS refund  (isRefundImage:true)      — đọc bởi buildRefundKpiReport (refund-report-service.ts:164).
//   2) Sổ đại lý CK    (isDealerRefundCk:true)   — đọc bởi routes/alpha-aggregate.ts (SQL LIKE + p.isDealerRefundCk).
//   3) Sổ QR refund    (isQrRefundCk:true)       — hoạch toán ĐỘC LẬP (sendQrRefundToDealer, ocr-send-service.ts:817).
// QR refund KHÔNG set isRefundImage, KHÔNG set isDealerRefundCk → PHẢI KHÔNG rò vào 2 sổ kia (và ngược lại).
//
// Điều kiện lọc TRÍCH TỪ CODE (đảm bảo không suy diễn):
//   - POS: refund-report-service.ts:164 `if (parsed.isRefundImage !== true || ...) continue;`
//   - CK : routes/alpha-aggregate.ts:196 SQL `metadata_json LIKE '%"isDealerRefundCk":true%'`
//          + :202 `if (!p.isDealerRefundCk || typeof p.refundAmount !== 'number' || p.refundAmount === 0) continue;`
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeQuoteReadyTid } from './fixtures.js';
import { sendMessage } from '../src/services/chat-message-service.js';
import { saveAttachment } from '../src/chat-attachment-service.js';
import { buildRefundKpiReport } from '../src/refund-report-service.js';
import { buildAlphaDealerDetail } from '../src/routes/alpha-aggregate.js';

const REAL_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

/** OCR ảnh THẬT (trong test này) LUÔN đọc ra 1.000.000 — để tin POS refund gửi qua sendMessage được verified sạch
 *  (refund-verify.ts re-OCR khi isRefundImage:true; QR/CK KHÔNG có cờ đó nên KHÔNG kích hoạt re-OCR). */
function stubOcrOneMillion() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: [{ text: 'VND 1000.000', score: 0.98 }] }) }));
}

describe('TÁCH SỔ hoàn tiền — QR refund KHÔNG rò vào sổ POS/CK (và ngược lại)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('SỔ POS (buildRefundKpiReport) chỉ tính isRefundImage:true — KHÔNG cộng QR refund, KHÔNG cộng CK', async () => {
    const { agent, tid } = await makeQuoteReadyTid({ phiBanMilli: 0 }); // phí 0% → required = billAmount = 1tr.
    const db = getBotDb();
    const room = await db.chatRoom.create({ data: { type: 'GROUP', name: `phong-ledger-sep-${Math.random().toString(36).slice(2)}` } });
    await db.chatRoomMember.create({ data: { roomId: room.id, agentId: agent.id, role: 'OWNER' } });
    await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: agent.id, createdAt: new Date('2020-01-01T00:00:00.000Z') } });

    // BILL gốc (isBillImage) 1tr, có TID.
    const bill = await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: agent.id,
        kind: 'IMAGE',
        metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billFields: { tid: { value: tid.tid, uncertain: false } } })
      }
    });

    // (1) POS refund THẬT: reply bill, isRefundImage:true, 1tr — gửi qua sendMessage để re-OCR verify sạch.
    const attPos = await saveAttachment(db, REAL_PNG_BUFFER, 'pos-refund.png', agent.id);
    if (!attPos.ok) throw new Error('saveAttachment (pos) thất bại');
    stubOcrOneMillion();
    await sendMessage(db, {
      roomId: room.id,
      senderId: agent.id,
      kind: 'IMAGE',
      attachmentId: attPos.id,
      replyToMessageId: bill.id,
      metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_000_000 })
    });

    // (2) QR refund — cố tình reply CÙNG bill, CÙNG senderId=agent, kind IMAGE (để LỌT vào replyRows query của
    //     buildRefundKpiReport nếu filter isRefundImage bị hở). refundAmount 5tr — nếu rò sẽ đẩy bill thành "Hoàn thừa".
    await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: agent.id,
        kind: 'IMAGE',
        replyToMessageId: bill.id,
        metadataJson: JSON.stringify({ isTransferRefund: true, isQrRefundCk: true, refundAmount: 5_000_000, qrRefundKey: 'QR:REF123:5000000', qrRef: 'REF123' })
      }
    });

    // (3) Đại lý CK refund — reply CÙNG bill, cố lọt tương tự. refundAmount 7tr.
    await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: agent.id,
        kind: 'IMAGE',
        replyToMessageId: bill.id,
        metadataJson: JSON.stringify({ isDealerRefundCk: true, refundAmount: 7_000_000, ckTxnKey: 'CK:XYZ:7000000', billDate: '2020-01-02' })
      }
    });

    const rpt = await buildRefundKpiReport(db, agent.id, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    // CHỈ POS refund 1tr được cộng — QR (5tr) + CK (7tr) BỊ LOẠI bởi filter isRefundImage !== true.
    expect(rpt.totalRefundedAmount).toBe(1_000_000);
    expect(rpt.totalRefundedCount).toBe(1); // bill "Hoàn đủ" đúng 1tr.
    expect(rpt.totalOverCount).toBe(0);     // nếu QR/CK rò → 13tr > required → "Hoàn thừa" (over=1). PHẢI = 0.
    expect(rpt.totalBillCount).toBe(1);
  });

  it('SỔ đại lý CK (buildAlphaDealerDetail) chỉ tính isDealerRefundCk:true — KHÔNG cộng QR refund, KHÔNG cộng POS', async () => {
    const db = getBotDb();
    const room = await db.chatRoom.create({ data: { type: 'GROUP', name: `phong-ck-sep-${Math.random().toString(36).slice(2)}` } });

    // Kỳ báo cáo: from/to bao billDate '2020-01-02' (hcmDay(from)='2020-01-01', hcmDay(to)='2020-01-03').
    const from = new Date('2020-01-01T12:00:00.000Z');
    const to = new Date('2020-01-03T12:00:00.000Z');
    const billDate = '2020-01-02';

    // (1) CK refund THẬT — sổ đại lý CK, 500k.
    await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: null,
        kind: 'IMAGE',
        metadataJson: JSON.stringify({ isDealerRefundCk: true, refundAmount: 500_000, billDate, ckTxnKey: 'CK:REAL:500000' })
      }
    });

    // (2) QR refund — CÙNG phòng, CÙNG billDate. Nếu sổ CK hở, 700k sẽ rò vào.
    await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: null,
        kind: 'IMAGE',
        metadataJson: JSON.stringify({ isTransferRefund: true, isQrRefundCk: true, refundAmount: 700_000, qrRefundKey: 'QR:REFQR:700000', qrRef: 'REFQR', billDate })
      }
    });

    // (3) POS refund — CÙNG phòng. Nếu sổ CK hở, 300k sẽ rò vào.
    await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: null,
        kind: 'IMAGE',
        metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 300_000, billDate })
      }
    });

    const detail = await buildAlphaDealerDetail(from, to, room.id);
    // CHỈ CK refund 500k lọt qua filter `metadata_json LIKE '%"isDealerRefundCk":true%'` + p.isDealerRefundCk.
    expect(detail.refunds).toHaveLength(1);
    expect(detail.refunds[0].amount).toBe(500_000);
    expect(detail.refunds.map((r) => r.amount)).not.toContain(700_000); // QR KHÔNG rò.
    expect(detail.refunds.map((r) => r.amount)).not.toContain(300_000); // POS KHÔNG rò.
    expect(detail.totals.hoan).toBe(500_000); // tổng hoàn = chỉ CK (transactions rỗng → không có hoàn QR từ GD).
  });

  it('KHẲNG ĐỊNH metadata mẫu: QR refund có isQrRefundCk nhưng isDealerRefundCk/isRefundImage đều FALSY', () => {
    // Shape đúng như sendQrRefundToDealer (ocr-send-service.ts:817) ghi.
    const qrMeta = { isTransferRefund: true, isQrRefundCk: true, refundAmount: 700_000, qrRefundKey: 'QR:REFQR:700000', qrRef: 'REFQR' };
    const json = JSON.stringify(qrMeta);
    // Filter SQL sổ CK (alpha-aggregate.ts:196): chuỗi metadata KHÔNG chứa marker → SQL LIKE loại ngay.
    expect(json.includes('"isDealerRefundCk":true')).toBe(false);
    // Filter JS sổ CK (:202) + sổ POS (:164): cờ falsy → continue (bị loại).
    const p = qrMeta as { isDealerRefundCk?: boolean; isRefundImage?: boolean };
    expect(p.isDealerRefundCk).toBeFalsy();
    expect(p.isRefundImage).toBeFalsy();
  });
});
