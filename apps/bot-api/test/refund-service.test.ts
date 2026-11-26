// SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — regression cho refund-service.ts: đối chiếu Người nhận
// (matchRefundRecipient), trạng thái cộng dồn (computeRefundAggregate), liệt kê lần hoàn tiền đã xác nhận
// (listRefundConfirmationsForMessage). Gọi thẳng service (KHÔNG qua HTTP), CÙNG khuôn chat-message-service.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeBank, makeFriends, makeReceiveAccount, makeReceiveAccountSource, makeTid } from './fixtures.js';
import { findOrCreateDirectRoom, ChatServiceError } from '../src/services/chat-room-service.js';
import { sendMessage } from '../src/services/chat-message-service.js';
import { saveAttachment } from '../src/chat-attachment-service.js';
import { computeRefundAggregate, listRefundConfirmationsForMessage, matchRefundRecipient, REFUND_MATCH_TOLERANCE_VND } from '../src/refund-service.js';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

// NỢ #2c (3/8) — gửi tin "Hoàn tiền" nay kích hoạt server re-OCR ảnh (sendMessage → refund-verify.ts). OCR
// service Python KHÔNG chạy trong test → stub global.fetch trả "VND <amount>" KHỚP số khai để refund được
// verified (các test dưới kiểm ranh giới senderId/cumulative, KHÔNG kiểm lệch số — đã có refund-verify.test.ts).
function stubOcrMatching(amount: number) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: [{ text: `VND ${amount}`, score: 0.97 }] }) }));
}
afterEach(() => vi.unstubAllGlobals());

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ChatServiceError code=${code} nhưng KHÔNG throw.`);
  } catch (err) {
    expect(err).toBeInstanceOf(ChatServiceError);
    expect((err as ChatServiceError).code).toBe(code);
  }
}

describe('refund-service — matchRefundRecipient', () => {
  it('originalTid rỗng/thiếu → no_tid', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const r1 = await matchRefundRecipient(db, agent.id, undefined, 'AI DO', '123');
    expect(r1.status).toBe('no_tid');
    const r2 = await matchRefundRecipient(db, agent.id, '   ', 'AI DO', '123');
    expect(r2.status).toBe('no_tid');
  });

  it('TID không tồn tại/không thuộc đại lý đang gọi → not_configured', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const r = await matchRefundRecipient(db, agent.id, 'TID-KHONG-TON-TAI', 'AI DO', '123');
    expect(r.status).toBe('not_configured');
  });

  it('TID tồn tại NHƯNG chưa gán receiveAccountId → not_configured', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, 'AI DO', '123');
    expect(r.status).toBe('not_configured');
  });

  async function makeTidWithReceiveAccount(opts: { accountName: string; accountNumber: string }) {
    const db = getBotDb();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id });
    const bank = await makeBank();
    const source = await makeReceiveAccountSource();
    const account = await makeReceiveAccount({ sourceId: source.id, bankId: bank.id, accountName: opts.accountName, accountNumber: opts.accountNumber });
    await db.tid.update({ where: { id: tid.id }, data: { receiveAccountId: account.id } });
    return { db, agent, tid, account };
  }

  it('OCR KHÔNG đọc được cả tên lẫn STK người nhận → unread', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 44', accountNumber: '8791797777' });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, null, null);
    expect(r.status).toBe('unread');
    expect(r.configuredAccountName).toBe('KHACH HANG 44');
  });

  it('OCR CHỈ đọc được 1 trong 2 (tên HOẶC STK) → unread (KHÔNG kết luận khớp dù phần đọc được khớp)', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 44', accountNumber: '8791797777' });
    const r1 = await matchRefundRecipient(db, agent.id, tid.tid, 'KHACH HANG 44', null);
    expect(r1.status).toBe('unread');
    const r2 = await matchRefundRecipient(db, agent.id, tid.tid, null, '8791797777');
    expect(r2.status).toBe('unread');
  });

  it('Tên+STK người nhận KHỚP (bỏ dấu/hoa-thường/khoảng trắng dư) → matched', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 44', accountNumber: '8791797777' });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, '  phan  thanh dai ', '8791 797 777'); // OCR thường thêm khoảng trắng thừa
    expect(r.status).toBe('matched');
  });

  // #4 (3/8) — CHUẨN HOÁ DẤU tiếng Việt: cấu hình có DẤU + "Đ" ("PHAN THÀNH ĐẠI") vs OCR đọc MẤT dấu
  // ("phan thanh dai") PHẢI khớp (đ/Đ→d, bỏ mọi dấu tổ hợp, hoa/thường) — tránh báo lệch giả chỉ vì OCR rụng dấu.
  it('Tên cấu hình CÓ DẤU + "Đ" vs OCR MẤT dấu → matched (chuẩn hoá dấu VN + Đ→D)', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'PHAN THÀNH ĐẠI', accountNumber: '8791797777' });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, 'phan thanh dai', '8791797777');
    expect(r.status).toBe('matched');
  });

  it('Tên KHÔNG khớp (STK khớp) → mismatched', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 44', accountNumber: '8791797777' });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, 'KHACH HANG 32', '8791797777');
    expect(r.status).toBe('mismatched');
    expect(r.message).toMatch(/tên người nhận/i);
  });

  it('STK KHÔNG khớp (tên khớp) → mismatched', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 44', accountNumber: '8791797777' });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, 'KHACH HANG 44', '0000000000');
    expect(r.status).toBe('mismatched');
    expect(r.message).toMatch(/số tài khoản/i);
  });

  it('Cả tên LẪN STK KHÔNG khớp → mismatched, message liệt kê CẢ 2', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 44', accountNumber: '8791797777' });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, 'NGUOI LA', '0000000000');
    expect(r.status).toBe('mismatched');
    expect(r.message).toMatch(/tên người nhận/i);
    expect(r.message).toMatch(/số tài khoản/i);
  });

  it('TID thuộc đại lý KHÁC (không phải đại lý đang gọi) → not_configured (KHÔNG dò dữ liệu đại lý khác)', async () => {
    const { db, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 44', accountNumber: '8791797777' });
    const stranger = await makeAgent();
    const r = await matchRefundRecipient(db, stranger.id, tid.tid, 'KHACH HANG 44', '8791797777');
    expect(r.status).toBe('not_configured');
  });

  // #4 (3/8, LANE B Vòng 2) — ca VietQR: ô "tài khoản" trên biên lai là MÃ VietQR/napas (vd VQRQAASGJ6634),
  // KHÔNG phải dãy số TK thuần → recipientAccountNumber=null + recipientAccountIsVietQR=true. So SỐ sẽ LỆCH
  // giả (mã ≠ STK cấu hình) → PHẢI bỏ so số, CHỈ so TÊN. Tên khớp → matched (dù account null); tên KHÔNG khớp
  // → mismatched. Đây là điểm khác biệt then chốt so với "account null thường" (case đó = unread).
  it('#4 VietQR: account là MÃ (null + isVietQR) + TÊN khớp → matched (chỉ so tên, KHÔNG báo unread như account null thường)', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 38', accountNumber: '99988877766' });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, 'ngo tien dung', null, true);
    expect(r.status).toBe('matched');
  });

  it('#4 VietQR: account là MÃ + TÊN KHÔNG khớp → mismatched (chỉ báo lệch TÊN, KHÔNG đụng số)', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 38', accountNumber: '99988877766' });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, 'KHACH HANG 51', null, true);
    expect(r.status).toBe('mismatched');
    expect(r.message).toMatch(/tên người nhận/i);
  });

  it('#4 VietQR nhưng KHÔNG đọc được TÊN (name null) → unread (không đủ cả 2 → không kết luận)', async () => {
    const { db, agent, tid } = await makeTidWithReceiveAccount({ accountName: 'KHACH HANG 38', accountNumber: '99988877766' });
    const r = await matchRefundRecipient(db, agent.id, tid.tid, null, null, true);
    expect(r.status).toBe('unread');
  });
});

describe('refund-service — computeRefundAggregate', () => {
  it('totalConfirmed=0 → none', () => {
    const r = computeRefundAggregate(1_000_000, 0);
    expect(r.status).toBe('none');
  });

  it('trong ngưỡng ±3.000đ (kể cả đúng biên) → matched', () => {
    expect(computeRefundAggregate(1_000_000, 1_000_000).status).toBe('matched');
    expect(computeRefundAggregate(1_000_000, 1_000_000 + REFUND_MATCH_TOLERANCE_VND).status).toBe('matched');
    expect(computeRefundAggregate(1_000_000, 1_000_000 - REFUND_MATCH_TOLERANCE_VND).status).toBe('matched');
  });

  it('vượt ngưỡng theo chiều DƯƠNG (đã hoàn NHIỀU HƠN) → over, diff dương ĐÚNG số tiền thừa', () => {
    const r = computeRefundAggregate(1_000_000, 1_020_000);
    expect(r.status).toBe('over');
    expect(r.diff).toBe(20_000);
  });

  it('vượt ngưỡng theo chiều ÂM (đã hoàn ÍT HƠN, còn > 0) → partial, diff âm ĐÚNG số tiền còn thiếu', () => {
    const r = computeRefundAggregate(1_000_000, 500_000);
    expect(r.status).toBe('partial');
    expect(r.diff).toBe(-500_000);
  });

  it('ngay SÁT ngưỡng (3.001đ) vẫn tính là lệch, KHÔNG phải khớp — biên chính xác', () => {
    expect(computeRefundAggregate(1_000_000, 1_000_000 + REFUND_MATCH_TOLERANCE_VND + 1).status).toBe('over');
    expect(computeRefundAggregate(1_000_000, 1_000_000 - REFUND_MATCH_TOLERANCE_VND - 1).status).toBe('partial');
  });
});

describe('refund-service — listRefundConfirmationsForMessage', () => {
  async function makeDirectRoomWithBill() {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);
    const room = await findOrCreateDirectRoom(db, a.id, b.id);
    const uploaded = await saveAttachment(db, PNG_1PX, 'bill.png', a.id);
    if (!uploaded.ok) throw new Error('setup thất bại');
    const bill = await sendMessage(db, {
      roomId: room.id,
      senderId: a.id,
      kind: 'IMAGE',
      attachmentId: uploaded.id,
      body: 'bill goc',
      metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800, billFields: { tid: { value: '111', uncertain: false } } })
    });
    return { db, a, b, room, bill };
  }

  it('tin nhắn gốc không tồn tại → MESSAGE_NOT_FOUND', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await expectCode(listRefundConfirmationsForMessage(db, agent.id, 'khong-ton-tai'), 'MESSAGE_NOT_FOUND');
  });

  it('requester KHÔNG phải thành viên phòng chứa tin nhắn gốc → NOT_MEMBER', async () => {
    const { db, bill } = await makeDirectRoomWithBill();
    const stranger = await makeAgent();
    await expectCode(listRefundConfirmationsForMessage(db, stranger.id, bill.id), 'NOT_MEMBER');
  });

  it('CHƯA có lần hoàn tiền nào → mảng rỗng', async () => {
    const { db, a, bill } = await makeDirectRoomWithBill();
    const result = await listRefundConfirmationsForMessage(db, a.id, bill.id);
    expect(result).toEqual([]);
  });

  it('CÓ nhiều lần hoàn tiền (người GỬI BILL tự hoàn nhiều lần, cumulative B123) → liệt kê ĐỦ, đúng amount, SẮP theo createdAt tăng dần', async () => {
    const { db, a, room, bill } = await makeDirectRoomWithBill();
    const upload1 = await saveAttachment(db, PNG_1PX, 'hoan1.png', a.id);
    const upload2 = await saveAttachment(db, PNG_1PX, 'hoan2.png', a.id);
    if (!upload1.ok || !upload2.ok) throw new Error('setup thất bại');
    stubOcrMatching(400_000);
    const refund1 = await sendMessage(db, {
      roomId: room.id,
      senderId: a.id, // #2: người GỬI BILL gốc (người bán) tự thực hiện hoàn tiền — CÙNG senderId với bill.
      kind: 'IMAGE',
      attachmentId: upload1.id,
      body: 'hoan lan 1',
      replyToMessageId: bill.id,
      metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 400_000 })
    });
    stubOcrMatching(600_000);
    await sendMessage(db, {
      roomId: room.id,
      senderId: a.id,
      kind: 'IMAGE',
      attachmentId: upload2.id,
      body: 'hoan lan 2',
      replyToMessageId: bill.id,
      metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 600_000 })
    });

    const result = await listRefundConfirmationsForMessage(db, a.id, bill.id);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.amount)).toEqual([400_000, 600_000]);
    expect(result[0].messageId).toBe(refund1.id);
  });

  // #2 (3/8, LANE B Vòng 2 — bảo mật) — reply "hoàn tiền" do THÀNH VIÊN KHÁC (không phải người gửi bill gốc)
  // BỊA số → KHÔNG được liệt kê/đếm (chống khách/kẻ gian tự "xác nhận đã hoàn" cho người bán). Trước fix:
  // query KHÔNG lọc senderId nên reply của bất kỳ ai cũng bị tính.
  it('#2: reply hoàn tiền do THÀNH VIÊN KHÁC (b) post → KHÔNG được liệt kê (chỉ tính confirmation của người gửi bill gốc)', async () => {
    const { db, a, b, room, bill } = await makeDirectRoomWithBill();
    const uploadB = await saveAttachment(db, PNG_1PX, 'hoan-bia.png', b.id);
    const uploadA = await saveAttachment(db, PNG_1PX, 'hoan-that.png', a.id);
    if (!uploadB.ok || !uploadA.ok) throw new Error('setup thất bại');
    // b (khách/kẻ gian) bịa "đã hoàn đủ 1.000.000".
    stubOcrMatching(1_000_000);
    await sendMessage(db, {
      roomId: room.id,
      senderId: b.id,
      kind: 'IMAGE',
      attachmentId: uploadB.id,
      body: 'toi da hoan roi (bia)',
      replyToMessageId: bill.id,
      metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_000_000 })
    });
    // a (người bán thật) hoàn 300.000 thật.
    stubOcrMatching(300_000);
    await sendMessage(db, {
      roomId: room.id,
      senderId: a.id,
      kind: 'IMAGE',
      attachmentId: uploadA.id,
      body: 'hoan that',
      replyToMessageId: bill.id,
      metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 300_000 })
    });

    const result = await listRefundConfirmationsForMessage(db, a.id, bill.id);
    expect(result).toHaveLength(1); // CHỈ của a — số bịa của b bị loại.
    expect(result[0].amount).toBe(300_000);
    expect(result.map((r) => r.amount)).not.toContain(1_000_000);
  });

  it('tin nhắn KHÁC (reply cùng bill nhưng KHÔNG phải isRefundImage:true, vd trả lời bằng text thường) → KHÔNG tính vào danh sách', async () => {
    const { db, a, room, bill } = await makeDirectRoomWithBill();
    await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'ok da hoan roi', replyToMessageId: bill.id });
    const result = await listRefundConfirmationsForMessage(db, a.id, bill.id);
    expect(result).toEqual([]);
  });

  it('tin nhắn hoàn tiền ĐÃ bị xóa (thu hồi) → KHÔNG tính vào tổng', async () => {
    const { db, a, room, bill } = await makeDirectRoomWithBill();
    const upload = await saveAttachment(db, PNG_1PX, 'hoan.png', a.id);
    if (!upload.ok) throw new Error('setup thất bại');
    const refund = await sendMessage(db, {
      roomId: room.id,
      senderId: a.id,
      kind: 'IMAGE',
      attachmentId: upload.id,
      body: 'hoan',
      replyToMessageId: bill.id,
      metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 400_000 })
    });
    await db.chatMessage.update({ where: { id: refund.id }, data: { deletedAt: new Date() } });
    const result = await listRefundConfirmationsForMessage(db, a.id, bill.id);
    expect(result).toEqual([]);
  });
});
