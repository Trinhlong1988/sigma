// SIGMA LANE B Vòng 2 (#5, 3/8) — test chống hoàn TRÙNG. Tái hiện ĐỦ tình huống SAI Admin Demo liệt kê:
// OCR đọc sai 1 field, 2 bill khác nhau tình cờ trùng số tiền+giờ nhưng khác mã, mã bị OCR nhiễu hoa/thường,
// THIẾU mã, lệch múi giờ khi tính "cách đây X".
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent } from './fixtures.js';
import {
  checkDuplicateRefund,
  checkRefundDuplicateForAgent,
  collectAgentRefundDedupHistory,
  formatRefundAgo,
  type RefundDedupRecord
} from '../src/refund-dedup.js';

function rec(over: Partial<RefundDedupRecord>): RefundDedupRecord {
  return {
    messageId: 'm-prev',
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    transferCode: '6214BIDVE2DY1464',
    amount: 102_707_000,
    recipientAccount: '8791797777',
    dateTime: '02/08/2026 15:52:57',
    ...over
  };
}

describe('#5 formatRefundAgo — độc lập múi giờ (hiệu 2 timestamp tuyệt đối)', () => {
  it('dưới 1 phút / phút / giờ / ngày; âm (lệch đồng hồ) kẹp về "dưới 1 phút"', () => {
    expect(formatRefundAgo(30_000)).toBe('dưới 1 phút');
    expect(formatRefundAgo(5 * 60_000)).toBe('5 phút');
    expect(formatRefundAgo(3 * 3_600_000)).toBe('3 giờ');
    expect(formatRefundAgo(2 * 86_400_000 + 3_600_000)).toBe('2 ngày');
    expect(formatRefundAgo(-999)).toBe('dưới 1 phút');
  });
});

describe('#5 checkDuplicateRefund — hàm THUẦN', () => {
  const now = new Date('2026-08-03T10:00:00.000Z');

  it('CÓ mã + trùng mã 1 bản ghi cũ → duplicate, "cách đây" tính từ timestamp tuyệt đối (2 ngày)', () => {
    const history = [rec({ createdAt: new Date('2026-08-01T10:00:00.000Z') })];
    const r = checkDuplicateRefund(
      { transferCode: '6214BIDVE2DY1464', amount: 102_707_000, recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' },
      history,
      now
    );
    expect(r.status).toBe('duplicate');
    expect(r.matchedMessageId).toBe('m-prev');
    expect(r.message).toContain('2 ngày');
    expect(r.message).toContain('TRÙNG');
  });

  it('OCR đọc SAI 1 field (số tiền + STK lệch) NHƯNG mã TRÙNG (in thường) → vẫn duplicate (mã = khóa mạnh, bền nhiễu)', () => {
    const history = [rec({ amount: 102_707_000 })];
    const r = checkDuplicateRefund(
      { transferCode: '6214bidve2dy1464', amount: 999_999, recipientAccount: null, dateTime: null },
      history,
      now
    );
    expect(r.status).toBe('duplicate');
  });

  it('2 BILL KHÁC NHAU tình cờ TRÙNG số tiền + ngày giờ nhưng KHÁC mã → ok (khác giao dịch)', () => {
    const history = [rec({ transferCode: '6214AAAAA0000001', amount: 5_000_000, dateTime: '02/08/2026 15:52:57' })];
    const r = checkDuplicateRefund(
      { transferCode: '6214BBBBB0000002', amount: 5_000_000, recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' },
      history,
      now
    );
    expect(r.status).toBe('ok');
  });

  it('hoàn NHIỀU LẦN hợp lệ (cumulative B123): cùng bill, mã KHÁC nhau → ok, KHÔNG cảnh báo trùng', () => {
    const history = [rec({ transferCode: '6214LANMOT00000001', amount: 400_000 })];
    const r = checkDuplicateRefund(
      { transferCode: '6214LANHAI00000002', amount: 600_000, recipientAccount: '8791797777', dateTime: '02/08/2026 16:00:00' },
      history,
      now
    );
    expect(r.status).toBe('ok');
  });

  it('THIẾU mã (OCR không đọc được) + số tiền/STK/giờ TRÙNG bản ghi cũ → insufficient_data (NGHI TRÙNG, kiểm tay)', () => {
    const history = [rec({ transferCode: '6214BIDVE2DY1464', amount: 102_707_000, recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' })];
    const r = checkDuplicateRefund(
      { transferCode: null, amount: 102_707_000, recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' },
      history,
      now
    );
    expect(r.status).toBe('insufficient_data');
    expect(r.matchedMessageId).toBe('m-prev');
    expect(r.message).toContain('KIỂM TRA TAY');
  });

  it('THIẾU mã + KHÔNG field nào trùng → insufficient_data (chỉ nhắc kiểm tay, không nghi trùng cụ thể)', () => {
    const history = [rec({ transferCode: '6214BIDVE2DY1464', amount: 1, recipientAccount: '1', dateTime: 'x' })];
    const r = checkDuplicateRefund({ transferCode: null, amount: 102_707_000, recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' }, history, now);
    expect(r.status).toBe('insufficient_data');
    expect(r.matchedMessageId).toBeNull();
  });

  it('CÓ mã + lịch sử RỖNG → ok', () => {
    const r = checkDuplicateRefund({ transferCode: '6214BIDVE2DY1464', amount: 1, recipientAccount: null, dateTime: null }, [], now);
    expect(r.status).toBe('ok');
  });

  it('THIẾU mã + số tiền trùng nhưng KHÁC ngày giờ → KHÔNG nghi trùng (insufficient_data, matched null)', () => {
    const history = [rec({ transferCode: null, amount: 5_000_000, recipientAccount: '8791797777', dateTime: '01/08/2026 09:00:00' })];
    const r = checkDuplicateRefund({ transferCode: null, amount: 5_000_000, recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' }, history, now);
    expect(r.status).toBe('insufficient_data');
    expect(r.matchedMessageId).toBeNull();
  });
});

describe('#5 collectAgentRefundDedupHistory + checkRefundDuplicateForAgent (DB thật)', () => {
  it('quét metadata.refundDedup của MỌI tin hoàn tiền của đại lý → phát hiện trùng mã; bill gốc KHÔNG lẫn vào', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-dedup' } });
    await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: agent.id,
        kind: 'IMAGE',
        metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 102_707_000, refundDedup: { transferCode: '6214BIDVE2DY1464', recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' } }),
        createdAt: new Date('2026-08-01T10:00:00.000Z')
      }
    });
    // bill gốc (isBillImage) — KHÔNG được lẫn vào lịch sử dedup.
    await db.chatMessage.create({
      data: { roomId: room.id, senderId: agent.id, kind: 'IMAGE', metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1 }), createdAt: new Date('2026-08-01T09:00:00.000Z') }
    });

    const history = await collectAgentRefundDedupHistory(db, agent.id);
    expect(history).toHaveLength(1);
    expect(history[0].transferCode).toBe('6214BIDVE2DY1464');

    const dup = await checkRefundDuplicateForAgent(
      db,
      agent.id,
      { transferCode: '6214BIDVE2DY1464', amount: 102_707_000, recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' },
      new Date('2026-08-03T10:00:00.000Z')
    );
    expect(dup.status).toBe('duplicate');
    expect(dup.message).toContain('2 ngày');
  });

  it('CÁCH LY: KHÔNG lẫn lịch sử đại lý KHÁC (senderId khác) — như #2', async () => {
    const db = getBotDb();
    const agentA = await makeAgent();
    const agentB = await makeAgent();
    const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-dedup-2' } });
    await db.chatMessage.create({
      data: { roomId: room.id, senderId: agentB.id, kind: 'IMAGE', metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1, refundDedup: { transferCode: 'CODEOFB0000001', recipientAccount: '1', dateTime: 'x' } }), createdAt: new Date() }
    });
    const dup = await checkRefundDuplicateForAgent(db, agentA.id, { transferCode: 'CODEOFB0000001', amount: 1, recipientAccount: '1', dateTime: 'x' }, new Date());
    expect(dup.status).toBe('ok'); // mã của B KHÔNG nằm trong lịch sử của A.
  });

  it('SỬA 1 lần hoàn tiền (excludeMessageId) → KHÔNG tự khớp chính nó', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-dedup-3' } });
    const msg = await db.chatMessage.create({
      data: { roomId: room.id, senderId: agent.id, kind: 'IMAGE', metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1, refundDedup: { transferCode: 'SELFCODE0000001', recipientAccount: '1', dateTime: 'x' } }), createdAt: new Date() }
    });
    const dup = await checkRefundDuplicateForAgent(db, agent.id, { transferCode: 'SELFCODE0000001', amount: 1, recipientAccount: '1', dateTime: 'x' }, new Date(), { excludeMessageId: msg.id });
    expect(dup.status).toBe('ok'); // loại chính nó → không báo trùng với chính mình khi sửa.
  });
});
