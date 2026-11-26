// E2E ĐỐI KHÁNG CHÉO LUỒNG (Agent-2 tái hiện 11/9) — cùng 1 ảnh đi LẠC luồng tiền + mượn TID + 2 phiên song song:
//   (A) ảnh bill POS đã gửi → bị đưa vào đường CK (hoàn đại lý / tạm ứng NĐT) → PHẢI chặn (hoàn/ứng MA);
//   (B) ảnh CK đã gửi → bị đưa vào đường POS /send → NOT_POS_BILL 422, KHÔNG ghi doanh số;
//   (C) ảnh bill QR đã hoàn → đường CK → chặn (flow QR);
//   (D) ảnh 2 bill CÙNG lô (settlement + sale) → gộp 1 card (không 2 nút gửi = không đếm đôi);
//   (E) MƯỢN TID: gửi có borrowedByRoomId → doanh số về phòng MƯỢN; gửi lại không mượn → dời về phòng CHỦ, gỡ mượn;
//   (F) 2 phiên song song cùng gửi 1 bill → đúng 1 Lô + 1 tin đại lý + 1 tin NĐT.
// Throwaway Postgres, route/hàm production thật, assert từng đồng.
// GATE CHỦ SIGMA: fixture e2e dùng agent code ngẫu nhiên (không phải 6 chủ) — bật bypass CHỈ Ở FILE NÀY
// để test luồng nghiệp vụ; gate thật được test riêng ở alpha-owner.test.ts + owner-gate-routes.test.ts (KHÔNG bypass).
process.env.SIGMA_OWNER_TEST_ALL = '1';
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import {
  reviewBills, reviewTransfers, sendTransferByDirection, sendQrRefundToDealer,
  buildDealerRefundReconcile, type OcrBill, type TransferRaw
} from '../src/ocr-send-service.js';
import { getRoomRevenueReport } from '../src/services/chat-room-tid-service.js';
import {
  makeAgent, makeBank, makeCardType, makeChatRoom, makeChatRoomMember, makeCustomer, makeCustomerChatGroup,
  makePartner, makeFeeSellQuote, makeTid, makeTidSellFee, defaultFeeTypeForQuote
} from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PNG_BASE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pngUniq = (tag: string): Buffer => Buffer.concat([PNG_BASE, Buffer.from(`::${tag}::${uniq('img')}`)]);

function putPendingOnDisk(buffer: Buffer): string {
  const token = randomUUID();
  const dir = path.join(process.cwd(), 'data', 'ocr-pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${token}.bin`), buffer);
  fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify({ imageName: 'bill.png', expiresAt: Date.now() + 60 * 60 * 1000 }), 'utf8');
  return token;
}

let uniqCounter = 0;
async function sessionFor(agentId: number): Promise<{ Cookie: string; [k: string]: string }> {
  uniqCounter += 1;
  const db = getBotDb();
  const rcUserId = `rc-e2ex-${Date.now()}-${uniqCounter}`;
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: `e2ex${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `tokx-${uniqCounter}`, agentId });
  return { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}

/** Thế giới POS tối thiểu (không NĐT — các test chéo không cần cc): TID + phòng đại lý tên đặc thù + giá bán 2% + FeeRate. */
async function setupWorld(tagPhong: string) {
  const db = getBotDb();
  const bank = await makeBank();
  const partner = await makePartner();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const agent = await makeAgent(undefined, { name: `Nhân sự ${tagPhong}` });
  const roomName = `${tagPhong} ${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const room = await makeChatRoom({ type: 'GROUP', name: roomName });
  await makeChatRoomMember(room.id, agent.id);
  const customer = await makeCustomer();
  await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id, feeTypeId: feeType.id });
  const hkdName = `HKD ${roomName}`;
  const tid = await makeTid({ tid: `94${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: customer.id, partnerId: partner.id, bankId: bank.id, hkdName });
  await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000, effectiveFrom: new Date('2020-01-01T00:00:00Z') });
  await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000 });
  await db.feeRate.create({ data: { partnerId: partner.id, cardTypeId: cardType.id, phiMua: 500, phiCaiMay: 1100, effectiveFrom: new Date('2020-01-01T00:00:00Z') } });
  return { db, bank, partner, cardType, feeType, agent, room, roomName, customer, tid, hkdName };
}

const app = createApp();
const rawCk = (over: Partial<TransferRaw>): TransferRaw => ({
  receiverName: null, receiverAccount: null, receiverBank: 'MB', senderName: null, senderAccount: null,
  amount: 0, date: null, time: null, ref: null, content: null, ...over
});

beforeAll(async () => {
  await getBotDb().appSetting.deleteMany({ where: { key: 'bill.editPassword' } });
});

describe('LUỒNG 5 — đối kháng chéo luồng / mượn TID / song song', () => {
  it('(A) ảnh bill POS đã gửi → đường CK hoàn đại lý + tạm ứng NĐT đều bị CHẶN (không hoàn/ứng ma)', async () => {
    const w = await setupWorld('XFLOWA');
    const db = w.db;
    const headers = await sessionFor(w.agent.id);
    const img = pngUniq('xflow-pos');
    const token = putPendingOnDisk(img);
    const bill: OcrBill = { tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '41', type: 'SETTLEMENT', totalAmount: 8_000_000, dateTime: '09/09/2026 09:00', settlementCode: null };
    const s1 = await request(app).post('/v1/ocr-send/send').set(headers).send({ token, bill });
    expect(s1.status).toBe(200);

    // OCR lần 2 phân loại NHẦM ảnh này thành CK "hoàn đại lý 8tr" → PHẢI chặn (trước fix: ghi hoàn MA 8tr).
    const rv = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w.roomName, amount: 8_000_000, date: '09/09/2026' })]);
    expect(rv[0].matchedRoomId).toBe(w.room.id);
    const ck = await sendTransferByDirection(db, rv[0], img, 'lac.png', new Date());
    expect(ck.ok).toBe(false);
    expect(String(ck.error)).toContain('IMAGE_SENT_OTHER_FLOW:POS');
    // Đối soát phòng: đã-hoàn vẫn 0 (không có CK ma).
    const rep = await buildDealerRefundReconcile(db, w.room.id, new Date(2026, 8, 9), new Date(2026, 8, 10));
    expect(rep.totalDaHoan).toBe(0);
    expect(rep.totalDaUng).toBe(0);

    // Cũng ảnh đó đi hướng TẠM ỨNG NĐT (chọn tay NĐT) → chặn, KHÔNG ghi investor_advances.
    const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT lạc luồng', nickname: uniq('nx').slice(0, 18), status: 'ACTIVE', investFeeMilli: 100 } });
    const invRoom = await makeChatRoom({ type: 'GROUP', name: uniq('NĐT X ') });
    await db.investorChatGroup.create({ data: { investorId: inv.id, roomId: invRoom.id } });
    const rvInv = rv[0];
    rvInv.direction = 'INVESTOR_TO_ALPHA';
    rvInv.entityType = 'INVESTOR';
    rvInv.entityId = inv.id;
    const adv = await sendTransferByDirection(db, rvInv, img, 'lac.png', new Date());
    expect(adv.ok).toBe(false);
    expect(String(adv.error)).toContain('IMAGE_SENT_OTHER_FLOW:POS');
    const advRows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*)::bigint AS n FROM investor_advances WHERE investor_id = $1`, inv.id);
    expect(Number(advRows[0].n)).toBe(0);
  }, 120_000);

  it('(B) ảnh CK đã gửi → đường POS /send → 422 NOT_POS_BILL, KHÔNG ghi Lô; (C) ảnh QR đã hoàn → đường CK → chặn flow QR', async () => {
    const w = await setupWorld('XFLOWB');
    const db = w.db;
    const headers = await sessionFor(w.agent.id);

    // (B) 1 CK hoàn thật vào phòng.
    const imgCk = pngUniq('xflow-ck');
    const refCk = uniq('FTB').toUpperCase();
    const rv = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w.roomName, amount: 2_500_000, date: '09/09/2026', ref: refCk })]);
    const sCk = await sendTransferByDirection(db, rv[0], imgCk, 'ck.png', new Date());
    expect(sCk.ok).toBe(true);
    // Ảnh CK đó bị OCR nhầm thành bill POS → /send phải 422 (không sửa được tin CK thành bill POS), KHÔNG Lô.
    const tokenCk = putPendingOnDisk(imgCk);
    const sPos = await request(app).post('/v1/ocr-send/send').set(headers)
      .send({ token: tokenCk, bill: { tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '55', type: 'SETTLEMENT', totalAmount: 2_500_000, dateTime: '09/09/2026 10:00' } });
    expect(sPos.status).toBe(422);
    expect(sPos.body.error).toBe('NOT_POS_BILL');
    const los = await db.lo.findMany({ where: { billKey: { startsWith: `nat|${w.tid.tid}|` }, status: { not: 'CANCELLED' } } });
    expect(los).toHaveLength(0); // KHÔNG doanh số từ ảnh CK

    // (C) 1 bill QR đã HOÀN vào phòng (sendQrRefundToDealer production) → ảnh đó đi đường CK → chặn flow QR.
    const imgQr = pngUniq('xflow-qr');
    const refQr = uniq('QRX').toUpperCase();
    const qrRefund = await sendQrRefundToDealer(db, {
      dealerRoomId: w.room.id, ref: refQr, amount: 3_000_000, refundAmount: 2_940_000, sellFeeMilli: 2000,
      billDate: '2026-09-09', hkdName: 'HKD QR X', imageBuffer: imgQr, imageName: 'qr.png'
    });
    expect(qrRefund.ok).toBe(true);
    const rv2 = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w.roomName, amount: 2_940_000, date: '09/09/2026' })]);
    const sCk2 = await sendTransferByDirection(db, rv2[0], imgQr, 'qr-lac.png', new Date());
    expect(sCk2.ok).toBe(false);
    expect(String(sCk2.error)).toContain('IMAGE_SENT_OTHER_FLOW:QR');
  }, 120_000);

  it('(D) ảnh 2+ bill CÙNG lô → GỘP 1 card, KHÔNG đếm đôi (settlement+lẻ khớp → settlement; lệch → tổng lẻ OCR-03b)', async () => {
    const w = await setupWorld('XFLOWD');
    // Ảnh chứa settlement 9.5tr + 2 bill lẻ 2tr + 7.5tr (KHỚP tổng) → 1 card 9.5tr (KHÔNG cộng 19tr = đếm đôi).
    const bills: OcrBill[] = [
      { tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '77', type: 'SETTLEMENT', totalAmount: 9_500_000, dateTime: '09/09/2026 20:00', settlementCode: null },
      { tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '77', type: 'SALE', totalAmount: 2_000_000, dateTime: '09/09/2026 19:40', settlementCode: null },
      { tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '77', type: 'SALE', totalAmount: 7_500_000, dateTime: '09/09/2026 19:50', settlementCode: null }
    ];
    const review = await reviewBills(w.db, bills, new Date());
    expect(review).toHaveLength(1); // GỘP LÔ — 1 card duy nhất, không 2-3 nút gửi
    expect(review[0].bill.type).toBe('SETTLEMENT');
    expect(review[0].bill.totalAmount).toBe(9_500_000); // = settlement = Σ lẻ (KHÔNG 19tr)
    expect(review[0].sellFee?.amount).toBe(190_000); // 2% của 9.5tr
    // Settlement LỆCH tổng lẻ cùng-lô (chỉ chụp được 1 bill lẻ 2tr) → OCR-03b: tin TỔNG BILL LẺ (2tr) — hành vi
    // CÓ CHỦ ĐÍCH đã ghi tại lot-revenue.ts (same-batch mismatch → realSaleSum + needsRecheck, người soát kiểm tay).
    const reviewMismatch = await reviewBills(w.db, [
      { tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '78', type: 'SETTLEMENT', totalAmount: 9_500_000, dateTime: '09/09/2026 21:00', settlementCode: null },
      { tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '78', type: 'SALE', totalAmount: 2_000_000, dateTime: '09/09/2026 20:40', settlementCode: null }
    ], new Date());
    expect(reviewMismatch).toHaveLength(1);
    expect(reviewMismatch[0].bill.totalAmount).toBe(2_000_000); // OCR-03b (spec): lệch → tổng lẻ, không nuốt câm số tổng
  }, 120_000);

  it('(E) MƯỢN TID: doanh số về phòng mượn rồi dời về phòng chủ khi gỡ mượn — không nhân đôi, không kẹt phòng cũ', async () => {
    const owner = await setupWorld('XFLOWE1'); // chủ TID
    const borrower = await setupWorld('XFLOWE2'); // đại lý mượn (phòng + khách riêng)
    const db = owner.db;
    const headers = await sessionFor(owner.agent.id);
    const img = pngUniq('xflow-borrow');
    const token = putPendingOnDisk(img);
    const bill: OcrBill = { tid: owner.tid.tid, agencyName: owner.hkdName, batchNumber: '61', type: 'SETTLEMENT', totalAmount: 6_000_000, dateTime: '09/09/2026 13:00', settlementCode: null };

    // GỬI 1: khai MƯỢN (borrowedByRoomId = phòng borrower) → tin + doanh số về phòng MƯỢN.
    const s1 = await request(app).post('/v1/ocr-send/send').set(headers).send({ token, bill, borrowedByRoomId: borrower.room.id });
    expect(s1.status).toBe(200);
    const loId = Number(s1.body.revenue.loId);
    const borrowedBy1 = await db.$queryRawUnsafe<{ b: number | null }[]>(`SELECT borrowed_by_customer_id AS b FROM los WHERE id = $1`, loId);
    expect(Number(borrowedBy1[0].b)).toBe(borrower.customer.id);
    const from = new Date(2026, 8, 9), to = new Date(2026, 8, 10);
    const repBorrow1 = await getRoomRevenueReport(db, borrower.agent.id, borrower.room.id, { from, to });
    expect(repBorrow1.totalGross).toBe(6_000_000); // doanh số về phòng MƯỢN
    expect(repBorrow1.rows[0]?.borrowed).toBe(true);
    const repOwner1 = await getRoomRevenueReport(db, owner.agent.id, owner.room.id, { from, to });
    expect(repOwner1.totalGross).toBe(0); // phòng chủ KHÔNG ôm lô mượn-ra

    // GỬI 2 (cùng ảnh, KHÔNG khai mượn) → DỜI bill về phòng CHỦ + GỠ mượn (borrowed_by null) — không lô mới.
    const s2 = await request(app).post('/v1/ocr-send/send').set(headers).send({ token, bill });
    expect(s2.status).toBe(200);
    expect(s2.body.moved).toBe(true);
    const borrowedBy2 = await db.$queryRawUnsafe<{ b: number | null }[]>(`SELECT borrowed_by_customer_id AS b FROM los WHERE id = $1`, loId);
    expect(borrowedBy2[0].b).toBeNull();
    const liveLos = await db.lo.findMany({ where: { billKey: { startsWith: `nat|${owner.tid.tid}|` }, status: { not: 'CANCELLED' } } });
    expect(liveLos).toHaveLength(1); // vẫn đúng 1 Lô
    const repOwner2 = await getRoomRevenueReport(db, owner.agent.id, owner.room.id, { from, to });
    expect(repOwner2.totalGross).toBe(6_000_000); // doanh số VỀ phòng chủ
    const repBorrow2 = await getRoomRevenueReport(db, borrower.agent.id, borrower.room.id, { from, to });
    expect(repBorrow2.totalGross).toBe(0); // phòng mượn trả lại sạch
  }, 120_000);

  it('(F) 2 phiên song song cùng gửi 1 bill → đúng 1 Lô sống + 1 tin bill đại lý (race không x2 doanh số)', async () => {
    const w = await setupWorld('XFLOWF');
    const db = w.db;
    const agent2 = await makeAgent(undefined, { name: 'Phiên 2' });
    await makeChatRoomMember(w.room.id, agent2.id);
    const h1 = await sessionFor(w.agent.id);
    const h2 = await sessionFor(agent2.id);
    const img = pngUniq('xflow-race');
    const token = putPendingOnDisk(img);
    const bill: OcrBill = { tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '88', type: 'SETTLEMENT', totalAmount: 4_400_000, dateTime: '09/09/2026 17:20', settlementCode: null };

    const [r1, r2] = await Promise.all([
      request(app).post('/v1/ocr-send/send').set(h1).send({ token, bill }),
      request(app).post('/v1/ocr-send/send').set(h2).send({ token, bill })
    ]);
    // Ít nhất 1 phiên thành công; phiên kia hoặc 200 (partial-hoàn-tất) hoặc 409 duplicate — nhưng DB PHẢI bất biến.
    expect([r1.status, r2.status]).toContain(200);
    const liveLos = await db.lo.findMany({ where: { billKey: { startsWith: `nat|${w.tid.tid}|88|` }, status: { not: 'CANCELLED' } } });
    expect(liveLos).toHaveLength(1);
    const dealerMsgs = await db.chatMessage.findMany({ where: { roomId: w.room.id, metadataJson: { contains: '"isBillImage":true' }, deletedAt: null } });
    expect(dealerMsgs).toHaveLength(1);
    const rep = await getRoomRevenueReport(db, w.agent.id, w.room.id, { from: new Date(2026, 8, 9), to: new Date(2026, 8, 10) });
    expect(rep.totalGross).toBe(4_400_000); // KHÔNG x2
  }, 120_000);
});
