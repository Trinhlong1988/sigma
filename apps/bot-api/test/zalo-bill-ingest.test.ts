// SIGMA — INGEST BILL TỪ ZALO (Admin Demo 25/8). Test tích hợp ĐỊNH TUYẾN + AN TOÀN TIỀN trên throwaway Postgres.
// OCR service mock qua fetch (trả lines cố định theo loại bill) — CÙNG cách chat-mention/me test mock OCR.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { ingestZaloBill, countBillLeSignals } from '../src/zalo-bill-ingest.js';
import { SUPPORT_SIGMA_CODE } from '../src/zalo-bill-support.js';
import { makeBank, makePartner, makeCardType, makeCustomer, makeChatRoom, makeCustomerChatGroup, makeTid, makeTidSellFee, makeFeeType } from './fixtures.js';

// PNG 1x1 thật (sharp xử lý được cho auto-xoay; OCR bị mock nên nội dung ảnh không quan trọng).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

/** Mock fetch OCR: MỌI lần gọi trả cùng `lines` (auto-xoay gọi nhiều lượt đều nhận như nhau → góc 0 thắng). */
function stubOcr(lines: { text: string; score: number }[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines }) }));
}

let tidSeq = 5990000;
let zaloSeq = 100000;
async function setupRoomWithTid(groupName: string) {
  const db = getBotDb();
  const bank = await makeBank();
  const partner = await makePartner();
  const cardType = await makeCardType(bank.id);
  const customer = await makeCustomer();
  const room = await makeChatRoom({ type: 'GROUP', name: groupName });
  const zaloGroupId = `g${++zaloSeq}`; // groupId Zalo dán tay (khớp chính xác, không theo tên)
  await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id, zaloGroupId });
  // TID toàn SỐ (bill thật in TID số; findTid cắt tại ký tự lạ như '_' của uniq()).
  const tid = await makeTid({ tid: String(++tidSeq), partnerId: partner.id, bankId: bank.id, customerId: customer.id });
  let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
  if (!feeType) feeType = await makeFeeType();
  await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1050 });
  await db.feeRate.create({ data: { partnerId: partner.id, cardTypeId: cardType.id, phiMua: 800, phiCaiMay: 500, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') } });
  return { db, room, tid, customer, cardType, zaloGroupId };
}

describe('countBillLeSignals', () => {
  it('1 bill lẻ → saleOccurrences 1', () => {
    const s = countBillLeSignals([{ text: 'SALE-THANH TOAN', score: 0.9 }, { text: 'TOTAL/TONG', score: 0.9 }, { text: '000412', score: 0.9 }]);
    expect(s.saleOccurrences).toBe(1);
  });
  it('nhiều bill → saleOccurrences >=2 + nhiều Số HĐ', () => {
    const s = countBillLeSignals([{ text: 'SALE-THANH TOAN', score: 0.9 }, { text: '000412', score: 0.9 }, { text: 'SALE THANH TOAN', score: 0.9 }, { text: '000413', score: 0.9 }]);
    expect(s.saleOccurrences).toBe(2);
    expect(s.distinctInvoiceNumbers).toBe(2);
  });
});

describe('ingestZaloBill — định tuyến + an toàn tiền', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('BILL_LE 1 bill khớp nhóm + TID có giá bán → RECORDED_SALE + tạo Lô + đăng bill Support SigMa', async () => {
    const { db, room, tid, zaloGroupId } = await setupRoomWithTid('DL Nguyen SG');
    stubOcr([
      { text: 'MB', score: 0.99 },
      { text: 'SALE-THANH TOAN', score: 0.98 },
      { text: `TID: ${tid.tid}`, score: 0.98 },
      { text: 'BATCH No/SO LO:', score: 0.9 }, { text: '000078', score: 0.95 },
      { text: 'TRACE No/SO HOA DON:', score: 0.9 }, { text: '000640', score: 0.95 },
      { text: 'TOTAL/TONG:', score: 0.9 }, { text: 'VND10.000.000', score: 0.97 }
    ]);
    const r = await ingestZaloBill(db, { imageBuffer: PNG, fileName: 'bill.png', zaloGroupId });
    expect(r.action).toBe('RECORDED_SALE');
    if (r.action !== 'RECORDED_SALE') return;
    expect(r.amount).toBe(10_000_000);
    // Lô tạo thật + gắn TID đúng.
    const lo = await db.lo.findUnique({ where: { id: r.loId } });
    expect(lo).not.toBeNull();
    // Support SigMa đã đăng 1 tin ảnh vào phòng.
    const bot = await db.agent.findUnique({ where: { code: SUPPORT_SIGMA_CODE }, select: { id: true } });
    const msgs = await db.chatMessage.findMany({ where: { roomId: room.id, senderId: bot!.id } });
    expect(msgs.length).toBe(1);
    expect(msgs[0].kind).toBe('IMAGE');
  });

  it('REFUND_TRANSFER (Ke Toan Demo) → REFUND_POSTED, KHÔNG tạo Lô (không tính doanh số)', async () => {
    const { db, room, tid, zaloGroupId } = await setupRoomWithTid('DL Bao SG');
    stubOcr([
      { text: 'ABBank', score: 0.9 },
      { text: 'Chuyen tien thanh cong', score: 0.9 },
      { text: '64.207.000VND', score: 0.95 },
      { text: 'KHACH HANG 01 chuyen tien', score: 0.95 }
    ]);
    const r = await ingestZaloBill(db, { imageBuffer: PNG, fileName: 'ck.png', zaloGroupId });
    expect(r.action).toBe('REFUND_POSTED');
    if (r.action === 'REFUND_POSTED') expect(r.amount).toBe(64_207_000);
    expect(await db.loRow.count({ where: { tidId: tid.id } })).toBe(0); // TUYỆT ĐỐI không ghi doanh số cho bill hoàn tiền
  });

  it('SETTLEMENT (kết toán) → SETTLEMENT_POSTED, KHÔNG tạo Lô (chống đếm đôi với bill lẻ)', async () => {
    const { db, tid, zaloGroupId } = await setupRoomWithTid('DL Tuan Dat');
    stubOcr([
      { text: 'MB', score: 0.9 },
      { text: 'SETTLEMENT', score: 0.9 }, { text: 'KET TOAN', score: 0.9 }, { text: 'TONG KET', score: 0.9 },
      { text: 'BATCH No/SO LO', score: 0.9 }, { text: '000053', score: 0.9 },
      { text: 'TONG:', score: 0.9 }, { text: '11', score: 0.9 }, { text: 'VND112.999.000', score: 0.9 }
    ]);
    const r = await ingestZaloBill(db, { imageBuffer: PNG, fileName: 's.png', zaloGroupId });
    expect(r.action).toBe('SETTLEMENT_POSTED');
    expect(await db.loRow.count({ where: { tidId: tid.id } })).toBe(0);
  });

  it('KHÔNG khớp nhóm → SKIPPED (không đoán liều, không đăng bừa)', async () => {
    const { db } = await setupRoomWithTid('DL Co That');
    stubOcr([{ text: 'SALE-THANH TOAN', score: 0.9 }, { text: 'VND1.000.000', score: 0.9 }]);
    const r = await ingestZaloBill(db, { imageBuffer: PNG, fileName: 'x.png', zaloGroupId: 'gKHONG_TON_TAI_9999999' });
    expect(r.action).toBe('SKIPPED');
    if (r.action === 'SKIPPED') expect(r.reason).toBe('NO_ROOM_MATCH');
  });

  it('LOGIC CHÉO: bill có TID KHÔNG thuộc khách của nhóm khớp → FLAGGED_MANUAL TID_NOT_IN_ROOM, KHÔNG ghi doanh số', async () => {
    const { db, zaloGroupId } = await setupRoomWithTid('DL Nhom A'); // nhóm A có TID riêng của A
    // TID lạ (của khách KHÁC, KHÔNG thuộc nhóm A) — dựng 1 TID rời không gắn khách nào của phòng A.
    const foreignTid = String(++tidSeq);
    await makeTid({ tid: foreignTid }); // TID tồn tại nhưng KHÔNG thuộc khách phòng A
    stubOcr([
      { text: 'MB', score: 0.9 }, { text: 'SALE-THANH TOAN', score: 0.9 }, { text: `TID: ${foreignTid}`, score: 0.95 },
      { text: 'TOTAL/TONG:', score: 0.9 }, { text: 'VND9.000.000', score: 0.95 }
    ]);
    const r = await ingestZaloBill(db, { imageBuffer: PNG, fileName: 'x.png', zaloGroupId });
    expect(r.action).toBe('FLAGGED_MANUAL');
    if (r.action === 'FLAGGED_MANUAL') expect(r.reason).toBe('TID_NOT_IN_ROOM');
    expect(await db.loRow.count({ where: { tidId: (await db.tid.findFirst({ where: { tid: foreignTid } }))!.id } })).toBe(0);
  });

  it('gửi lại CÙNG ảnh → lần 2 SKIPPED DEDUPE (không đăng/ghi trùng)', async () => {
    const { db, tid, zaloGroupId } = await setupRoomWithTid('DL Dedup');
    stubOcr([
      { text: 'MB', score: 0.9 }, { text: 'SALE-THANH TOAN', score: 0.9 }, { text: `TID: ${tid.tid}`, score: 0.9 },
      { text: 'TOTAL/TONG:', score: 0.9 }, { text: 'VND5.000.000', score: 0.95 }
    ]);
    const r1 = await ingestZaloBill(db, { imageBuffer: PNG, fileName: 'd.png', zaloGroupId });
    const r2 = await ingestZaloBill(db, { imageBuffer: PNG, fileName: 'd.png', zaloGroupId });
    expect(r1.action).toBe('RECORDED_SALE');
    expect(r2.action).toBe('SKIPPED');
    if (r2.action === 'SKIPPED') expect(r2.reason).toBe('DEDUPE');
  });
});
