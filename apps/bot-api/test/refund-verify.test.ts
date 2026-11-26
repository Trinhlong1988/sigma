// NỢ #2c (LANE B Vòng 2 để lại TODO — 3/8) — CHẶN client tự khai `refundAmount` bằng ĐỐI CHIẾU SERVER-SIDE
// với OCR ảnh biên lai đính kèm. Lane B đã lọc `senderId` (chỉ chủ bill được xác nhận hoàn) — đây là LỚP 2:
// lúc LƯU tin "Hoàn tiền" (kind IMAGE, isRefundImage:true, có attachment ảnh), server TỰ OCR lại ảnh THẬT đang
// gắn vào tin → so số OCR đọc được với `refundAmount` client khai. Khớp (≤ ngưỡng REFUND_MATCH_TOLERANCE_VND)
// → giữ (refundVerification.verified:true). LỆCH / OCR không đọc được / OCR service chết → cờ `refundUnverified:
// true` trong metadata (KHÔNG throw — đúng triết lý "cảnh báo, không chặn gửi"), và báo cáo KPI + danh sách
// hoàn tiền KHÔNG tính khoản chưa kiểm chứng đó là "đã hoàn đủ".
//
// Chạy trên throwaway Postgres THẬT (global-setup.ts) + attachment ảnh THẬT trên đĩa (saveAttachment). OCR
// microservice Python KHÔNG chạy trong CI → stub `global.fetch` (CÙNG khuôn me.test.ts) — callOcrService()
// dùng fetch built-in, nên chỉ cần chặn tại đó, KHÔNG cần mock hàm nội bộ nào.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends, makeQuoteReadyTid } from './fixtures.js';
import { findOrCreateDirectRoom } from '../src/services/chat-room-service.js';
import { sendMessage } from '../src/services/chat-message-service.js';
import { saveAttachment } from '../src/chat-attachment-service.js';
import { buildRefundKpiReport } from '../src/refund-report-service.js';
import { listRefundConfirmationsForMessage } from '../src/refund-service.js';
import { reconcileRefundAmount } from '../src/refund-verify.js';

// PNG 1x1 THẬT (CÙNG buffer me.test.ts/ocr-bridge.test.ts) — cần magic-bytes hợp lệ để file-type sniff ra
// image/png (saveAttachment + callOcrService đều sniff trước khi chấp nhận/forward).
const REAL_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

/** Stub OCR service trả về ĐÚNG 1 dòng "VND <n>" (buildAmountPreview parse digits-only). */
function stubOcrLines(lines: { text: string; score: number }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines }) })
  );
}

function stubOcrUnreachable() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
}

async function refundRoomWithAttachment(claimedAmount: number) {
  const db = getBotDb();
  const a = await makeAgent();
  const b = await makeAgent();
  await makeFriends(a.id, b.id);
  const room = await findOrCreateDirectRoom(db, a.id, b.id);
  const saved = await saveAttachment(db, REAL_PNG_BUFFER, 'bien-lai.png', a.id);
  if (!saved.ok) throw new Error(`saveAttachment thất bại: ${saved.reason}`);
  return { db, a, room, attachmentId: saved.id, claimedAmount };
}

async function sendRefund(
  ctx: { db: ReturnType<typeof getBotDb>; a: { id: number }; room: { id: string }; attachmentId: string },
  metadataExtra: Record<string, unknown>
) {
  return sendMessage(ctx.db, {
    roomId: ctx.room.id,
    senderId: ctx.a.id,
    kind: 'IMAGE',
    attachmentId: ctx.attachmentId,
    metadataJson: JSON.stringify({ isRefundImage: true, ...metadataExtra })
  });
}

function parseMeta(metadataJson: string | null): {
  refundUnverified?: boolean;
  refundVerification?: { verified: boolean; outcome: string; ocrAmount: number | null; claimedAmount: number };
} {
  return metadataJson ? JSON.parse(metadataJson) : {};
}

describe('refund-verify — hàm thuần reconcileRefundAmount()', () => {
  it('OCR đọc đúng số client khai → verified', () => {
    expect(reconcileRefundAmount(1_000_000, 1_000_000).verified).toBe(true);
    expect(reconcileRefundAmount(1_000_000, 1_000_000).outcome).toBe('verified');
  });

  it('lệch trong ngưỡng (≤3.000đ) → vẫn verified', () => {
    expect(reconcileRefundAmount(1_000_000, 999_500).verified).toBe(true);
    expect(reconcileRefundAmount(1_000_000, 1_002_999).verified).toBe(true);
  });

  it('lệch VƯỢT ngưỡng → amount_mismatch, KHÔNG verified', () => {
    const r = reconcileRefundAmount(1_000_000, 5_000_000);
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe('amount_mismatch');
  });

  it('OCR không đọc ra số (null) → ocr_unreadable, KHÔNG verified', () => {
    const r = reconcileRefundAmount(1_000_000, null);
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe('ocr_unreadable');
  });
});

describe('sendMessage — server re-OCR đối chiếu refundAmount client khai (NỢ #2c)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ẢNH KHỚP số khai → refundVerification.verified=true, KHÔNG cờ refundUnverified', async () => {
    const ctx = await refundRoomWithAttachment(1_000_000);
    stubOcrLines([{ text: 'VND 1000.000', score: 0.96 }]);
    const msg = await sendRefund(ctx, { refundAmount: 1_000_000 });
    const meta = parseMeta(msg.metadataJson);
    expect(meta.refundUnverified).not.toBe(true);
    expect(meta.refundVerification?.verified).toBe(true);
    expect(meta.refundVerification?.ocrAmount).toBe(1_000_000);
  });

  it('client khai LỆCH HẲN số trên ảnh → cờ refundUnverified=true, outcome amount_mismatch (KHÔNG throw, tin VẪN gửi)', async () => {
    const ctx = await refundRoomWithAttachment(1_000_000);
    // Ảnh THẬT đọc ra 1.000.000 nhưng client khai 9.000.000 (bịa để "hoàn đủ" giả).
    stubOcrLines([{ text: 'VND 1000.000', score: 0.96 }]);
    const msg = await sendRefund(ctx, { refundAmount: 9_000_000 });
    expect(msg.id).toBeDefined(); // tin vẫn được ghi (cảnh báo, không chặn).
    const meta = parseMeta(msg.metadataJson);
    expect(meta.refundUnverified).toBe(true);
    expect(meta.refundVerification?.verified).toBe(false);
    expect(meta.refundVerification?.outcome).toBe('amount_mismatch');
    expect(meta.refundVerification?.ocrAmount).toBe(1_000_000);
    expect(meta.refundVerification?.claimedAmount).toBe(9_000_000);
  });

  it('OCR service CHẾT (unreachable) → cờ refundUnverified=true, outcome ocr_unavailable (KHÔNG chặn gửi)', async () => {
    const ctx = await refundRoomWithAttachment(1_000_000);
    stubOcrUnreachable();
    const msg = await sendRefund(ctx, { refundAmount: 1_000_000 });
    expect(msg.id).toBeDefined();
    const meta = parseMeta(msg.metadataJson);
    expect(meta.refundUnverified).toBe(true);
    expect(meta.refundVerification?.outcome).toBe('ocr_unavailable');
  });

  it('OCR đọc được ảnh nhưng KHÔNG có dòng số tiền → cờ refundUnverified=true, outcome ocr_unreadable', async () => {
    const ctx = await refundRoomWithAttachment(1_000_000);
    stubOcrLines([{ text: 'CHUYEN KHOAN THANH CONG', score: 0.9 }]); // không có "VND <số>".
    const msg = await sendRefund(ctx, { refundAmount: 1_000_000 });
    const meta = parseMeta(msg.metadataJson);
    expect(meta.refundUnverified).toBe(true);
    expect(meta.refundVerification?.outcome).toBe('ocr_unreadable');
  });

  it('tin hoàn tiền KHÔNG kèm ảnh (né kiểm chứng) → cờ refundUnverified=true, outcome no_attachment (không có ảnh KHÔNG thể tự "hoàn đủ")', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);
    const room = await findOrCreateDirectRoom(db, a.id, b.id);
    // KHÔNG stub fetch — nhánh no_attachment không gọi OCR.
    const msg = await sendMessage(db, {
      roomId: room.id,
      senderId: a.id,
      kind: 'IMAGE',
      metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 9_000_000 }) // KHÔNG attachmentId.
    });
    const meta = parseMeta(msg.metadataJson);
    expect(meta.refundUnverified).toBe(true);
    expect(meta.refundVerification?.outcome).toBe('no_attachment');
  });

  it('client TỰ NHÉT refundUnverified:false + refundVerification giả → server GHI ĐÈ theo OCR thật (không tin client)', async () => {
    const ctx = await refundRoomWithAttachment(1_000_000);
    stubOcrLines([{ text: 'VND 1000.000', score: 0.96 }]); // ảnh thật = 1 triệu.
    const msg = await sendRefund(ctx, {
      refundAmount: 9_000_000,
      refundUnverified: false, // client cố ý khai "đã kiểm chứng".
      refundVerification: { verified: true, outcome: 'verified', ocrAmount: 9_000_000, claimedAmount: 9_000_000 }
    });
    const meta = parseMeta(msg.metadataJson);
    expect(meta.refundUnverified).toBe(true); // server ghi đè: OCR thật (1tr) ≠ khai (9tr).
    expect(meta.refundVerification?.verified).toBe(false);
    expect(meta.refundVerification?.ocrAmount).toBe(1_000_000);
  });
});

describe('KPI + danh sách hoàn tiền — KHÔNG tính khoản refundUnverified là "hoàn đủ"', () => {
  async function seedBillWithRefund(refundMeta: Record<string, unknown>) {
    const { agent, tid } = await makeQuoteReadyTid({ phiBanMilli: 0 }); // phí 0% → required = billAmount.
    const db = getBotDb();
    const room = await db.chatRoom.create({ data: { type: 'GROUP', name: `phong-2c-${Math.random().toString(36).slice(2)}` } });
    // listRefundConfirmationsForMessage() gọi assertActiveMember → agent PHẢI là thành viên phòng.
    await db.chatRoomMember.create({ data: { roomId: room.id, agentId: agent.id, role: 'OWNER' } });
    await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: agent.id, createdAt: new Date('2020-01-01T00:00:00.000Z') } });
    const day = new Date(2026, 6, 15, 9, 0, 0);
    const bill = await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: agent.id,
        kind: 'IMAGE',
        metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800, billFields: { tid: { value: tid.tid, uncertain: false } } }),
        createdAt: day
      }
    });
    await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: agent.id,
        kind: 'IMAGE',
        replyToMessageId: bill.id,
        metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_000_000, ...refundMeta }),
        createdAt: new Date(day.getTime() + 60_000)
      }
    });
    return { db, agent, bill };
  }

  it('refund ĐÃ kiểm chứng (không cờ) → totalRefundedCount=1 (control)', async () => {
    const { db, agent } = await seedBillWithRefund({});
    const report = await buildRefundKpiReport(db, agent.id, new Date(2026, 6, 1), new Date(2026, 7, 1));
    expect(report.totalRefundedCount).toBe(1);
    expect(report.totalUnrefundedCount).toBe(0);
  });

  it('refund refundUnverified:true → KHÔNG tính là hoàn đủ (totalRefundedCount=0, bill vẫn "chưa hoàn")', async () => {
    const { db, agent } = await seedBillWithRefund({ refundUnverified: true });
    const report = await buildRefundKpiReport(db, agent.id, new Date(2026, 6, 1), new Date(2026, 7, 1));
    expect(report.totalRefundedCount).toBe(0);
    expect(report.totalUnrefundedCount).toBe(1);
    expect(report.totalRefundedAmount).toBe(0);
  });

  it('listRefundConfirmationsForMessage BỎ QUA khoản refundUnverified (không cộng dồn thành hoàn đủ)', async () => {
    const { db, agent, bill } = await seedBillWithRefund({ refundUnverified: true });
    const confirmations = await listRefundConfirmationsForMessage(db, agent.id, bill.id);
    expect(confirmations).toHaveLength(0);
  });
});
