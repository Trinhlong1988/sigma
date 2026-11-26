// E2E TIỀN LUỒNG POS (Agent-2 tái hiện 11/9) — TRỌN CHUỖI qua CHÍNH route/hàm production, KHÔNG mock lõi tiền:
//   OCR review (reviewBills) → GỬI qua route THẬT POST /v1/ocr-send/send (ghi Lô + bridge Transaction + tin đại lý
//   + cc NĐT) → SỬA bill (mật khẩu 1111, POST /v1/ocr-send/edit-bill-params) → RE-OCR CÙNG ẢNH
//   (applyPosBillCorrectionByImage + augmentReviewWithImageHash) phải ra BẢN SỬA + alreadySent → GỬI LẠI route /send
//   → cập-nhật-tại-chỗ, KHÔNG lô/tin trùng → getRoomRevenueReport + buildRoomsRevenueKpi khớp TỪNG ĐỒNG.
// Throwaway Postgres (global-setup.ts). Ảnh pending ghi thẳng data/ocr-pending (đúng đường getPending đọc từ đĩa —
// không cần gọi OCR service thật; bill do client gửi lên /send là đường production sẵn có).
// GATE CHỦ SIGMA: fixture e2e dùng agent code ngẫu nhiên (không phải 6 chủ) — bật bypass CHỈ Ở FILE NÀY
// để test luồng nghiệp vụ; gate thật được test riêng ở alpha-owner.test.ts + owner-gate-routes.test.ts (KHÔNG bypass).
process.env.SIGMA_OWNER_TEST_ALL = '1';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import {
  reviewBills,
  applyPosBillCorrectionByImage,
  augmentReviewWithImageHash,
  ocrImageHashOf,
  type OcrBill
} from '../src/ocr-send-service.js';
import { getRoomRevenueReport } from '../src/services/chat-room-tid-service.js';
import { buildRoomsRevenueKpi } from '../src/services/rooms-revenue-kpi.js';
import {
  makeAgent, makeBank, makeCardType, makeChatRoom, makeChatRoomMember, makeCustomer, makeCustomerChatGroup,
  makePartner, makeFeeSellQuote, makeTid, makeTidSellFee, makeReceiveAccountSource, defaultFeeTypeForQuote
} from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
// PNG 1x1 hợp lệ (saveAttachment sniff magic bytes) + ĐUÔI riêng để mỗi test có hash ảnh KHÁC nhau (file-type chỉ
// đọc header nên PNG vẫn hợp lệ, sha256 thì đổi).
const PNG_BASE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pngUniq = (tag: string): Buffer => Buffer.concat([PNG_BASE, Buffer.from(`::${tag}::${uniq('img')}`)]);

/** Ghi ảnh pending THẲNG ra data/ocr-pending (đúng format putPending ghi, getPending đọc lại từ đĩa khi RAM không
 *  có) → route /send dùng được token mà KHÔNG cần gọi OCR service thật. */
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
  const rcUserId = `rc-e2epos-${Date.now()}-${uniqCounter}`;
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: `e2epos${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `tok-${uniqCounter}`, agentId });
  return { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}

/** Dựng TRỌN bộ POS: TID (số) + khách + phòng đại lý (có NGƯỜI THẬT) + giá bán THỰC TẾ 2% + FeeRate (phí cài
 *  1.1%, phí mua 0.5%) + NĐT uỷ (receiveAccount → investorChatGroup room). */
async function setupPosWorld() {
  const db = getBotDb();
  const bank = await makeBank();
  const partner = await makePartner();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const agent = await makeAgent(undefined, { name: 'Nhân sự phòng POS' });
  const room = await makeChatRoom({ type: 'GROUP', name: uniq('Phòng POS ') });
  await makeChatRoomMember(room.id, agent.id);
  const customer = await makeCustomer();
  await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id, feeTypeId: feeType.id });
  const hkdName = `HKD ${uniq('E2EPOS').toUpperCase()}`;
  const tid = await makeTid({ tid: `97${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: customer.id, partnerId: partner.id, bankId: bank.id, hkdName });
  await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000, effectiveFrom: new Date('2020-01-01T00:00:00Z') });
  await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000 });
  await db.feeRate.create({ data: { partnerId: partner.id, cardTypeId: cardType.id, phiMua: 500, phiCaiMay: 1100, effectiveFrom: new Date('2020-01-01T00:00:00Z') } });
  // NĐT uỷ TID này: receiveAccount(investorId) + nhóm NĐT đang gán.
  const src = await makeReceiveAccountSource();
  const investor = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT POS e2e', nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: 100 } });
  const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId: bank.id, accountName: 'TK NĐT POS', accountNumber: uniq('AC').slice(0, 18), investorId: investor.id } });
  await db.tid.update({ where: { id: tid.id }, data: { receiveAccountId: ra.id } });
  const invRoom = await makeChatRoom({ type: 'GROUP', name: uniq('Phòng NĐT ') });
  await db.investorChatGroup.create({ data: { investorId: investor.id, roomId: invRoom.id } });
  return { db, bank, partner, cardType, feeType, agent, room, customer, tid, hkdName, investor, invRoom };
}

const app = createApp();

beforeAll(async () => {
  // Mật khẩu sửa bill: đảm bảo còn MẶC ĐỊNH 1111 (file test khác có thể đã set trong DB dùng chung).
  await getBotDb().appSetting.deleteMany({ where: { key: 'bill.editPassword' } });
});
afterAll(async () => { /* resetBotDb ở setup-each-file */ });

describe('LUỒNG 1 — POS: review → gửi → sửa → re-OCR → gửi lại → doanh số phòng (từng đồng)', () => {
  it('trọn chuỗi: phí đúng, 1 Lô duy nhất, sửa 10tr→12tr lan sang mirror NĐT, re-OCR ra bản sửa, report khớp', async () => {
    const w = await setupPosWorld();
    const db = w.db;
    const headers = await sessionFor(w.agent.id);
    const img = pngUniq('pos-chain');
    const token = putPendingOnDisk(img);

    const ocrBill: OcrBill = {
      tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '12', type: 'SETTLEMENT',
      totalAmount: 10_000_000, dateTime: '09/09/2026 10:15', settlementCode: null
    };

    // ── BƯỚC 1: REVIEW (reviewBills — đúng hàm route /ocr gọi) ──
    const review = await reviewBills(db, [{ ...ocrBill }], new Date());
    expect(review).toHaveLength(1);
    const r0 = review[0];
    expect(r0.dealerRoomId).toBe(w.room.id);
    expect(r0.investorRoomId).toBe(w.invRoom.id);
    // Phí bán 2% của 10.000.000 = 200.000 (từng đồng); phí cài 1.1% = 110.000.
    expect(r0.sellFee?.resolved).toBe(true);
    expect(r0.sellFee?.milli).toBe(2000);
    expect(r0.sellFee?.amount).toBe(200_000);
    expect(r0.installFee?.resolved).toBe(true);
    expect(r0.installFee?.milli).toBe(1100);
    expect(r0.installFee?.amount).toBe(110_000);
    expect(r0.alreadySent).toBe(false);

    // ── BƯỚC 2: GỬI qua route THẬT /v1/ocr-send/send ──
    const sendRes = await request(app).post('/v1/ocr-send/send').set(headers).send({ token, bill: ocrBill });
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.revenue?.ok).toBe(true);
    const loId = Number(sendRes.body.revenue.loId);
    expect(Number.isInteger(loId)).toBe(true);
    const dealerMessageId = String(sendRes.body.dealerMessageId);
    const investorMessageId = String(sendRes.body.investorMessageId);
    expect(dealerMessageId).toBeTruthy();
    expect(investorMessageId).toBeTruthy();

    // Lô: 1 dòng, tiền + phí + net đúng từng đồng (2% giá bán thực tế).
    const rows1 = await db.loRow.findMany({ where: { loId } });
    expect(rows1).toHaveLength(1);
    expect(Number(rows1[0].amountBeforeFee)).toBe(10_000_000);
    expect(Number(rows1[0].feeApplied)).toBe(200_000);
    expect(Number(rows1[0].amountAfterFee)).toBe(9_800_000);
    const lo1 = await db.lo.findUnique({ where: { id: loId } });
    expect(lo1?.status).toBe('PENDING');
    expect(Number(lo1?.expectedTotalAmount)).toBe(9_800_000);
    expect(lo1?.billKey).toBe(`nat|${w.tid.tid}|12||2026-09-09`); // khóa kèm NGÀY (lô bank reset mỗi ngày)

    // Bridge GD SigMa: 1 Transaction TỔNG amount = gross, snapshot phí cài 1.1%.
    expect(lo1?.transactionId).not.toBeNull();
    const txn1 = await db.transaction.findUnique({ where: { id: lo1!.transactionId! } });
    expect(Number(txn1?.amount)).toBe(10_000_000);
    expect(txn1?.phiCaiMayMilli).toBe(1100);
    // Ngày bill THẬT trên lô (bill_txn_date) = 09/09/2026 10:15 local (đọc TRONG SQL — tránh bẫy đọc +7).
    const btd = await db.$queryRawUnsafe<{ d: string }[]>(
      `SELECT to_char(bill_txn_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') AS d FROM los WHERE id = $1`, loId);
    expect(btd[0]?.d).toBe('2026-09-09 10:15');

    // Tin đại lý: caption + meta phí bán / phải hoàn 9.800.000; tin NĐT: phí cài / tiền về 9.890.000, KHÔNG phí bán.
    const dMsg = await db.chatMessage.findUnique({ where: { id: dealerMessageId } });
    const dMeta = JSON.parse(dMsg?.metadataJson ?? '{}');
    expect(dMsg?.roomId).toBe(w.room.id);
    expect(dMeta.posBill.amount).toBe(10_000_000);
    expect(dMeta.posBill.feeLabel).toBe('Phí bán');
    expect(dMeta.posBill.netAmount).toBe(9_800_000);
    const iMsg = await db.chatMessage.findUnique({ where: { id: investorMessageId } });
    const iMeta = JSON.parse(iMsg?.metadataJson ?? '{}');
    expect(iMsg?.roomId).toBe(w.invRoom.id);
    expect(iMeta.posBill.feeLabel).toBe('Phí cài máy');
    expect(iMeta.posBill.netAmount).toBe(9_890_000);
    expect(iMeta.alphaCrossPostSourceId).toBe(dealerMessageId);
    expect(iMsg?.metadataJson ?? '').not.toContain('Phí bán'); // bất biến bảo mật: NĐT không thấy phí bán
    expect(iMsg?.body ?? '').not.toContain(w.hkdName.slice(4)); // caption NĐT không tên đại lý? (caption chỉ tid+tiền+lô)

    // ── BƯỚC 3: DOANH SỐ PHÒNG sau gửi ──
    const from = new Date(2026, 8, 9), to = new Date(2026, 8, 10);
    const rep1 = await getRoomRevenueReport(db, w.agent.id, w.room.id, { from, to });
    expect(rep1.totalGross).toBe(10_000_000);
    expect(rep1.totalFee).toBe(200_000);
    expect(rep1.totalNet).toBe(9_800_000);
    expect(rep1.loCount).toBe(1);
    expect(rep1.daily).toEqual([{ date: '2026-09-09', gross: 10_000_000, net: 9_800_000 }]);

    // ── BƯỚC 4: SỬA BILL (mật khẩu mặc định 1111) 10tr → 12tr qua route THẬT ──
    const badPw = await request(app).post('/v1/ocr-send/edit-bill-params').set(headers)
      .send({ messageId: dealerMessageId, editPassword: '9999', patch: { amount: 12_000_000 } });
    expect(badPw.status).toBe(403); // sai mật khẩu → chặn
    const edit = await request(app).post('/v1/ocr-send/edit-bill-params').set(headers)
      .send({ messageId: dealerMessageId, editPassword: '1111', patch: { amount: 12_000_000 } });
    expect(edit.status).toBe(200);
    expect(edit.body.ok).toBe(true);
    expect(edit.body.revenueUpdated).toBe(true);
    expect(edit.body.oldAmount).toBe(10_000_000);
    expect(edit.body.newAmount).toBe(12_000_000);

    // Lô CẬP NHẬT TẠI CHỖ (không lô mới): 12tr, phí 240k, net 11.76tr.
    const rows2 = await db.loRow.findMany({ where: { loId } });
    expect(rows2).toHaveLength(1);
    expect(Number(rows2[0].amountBeforeFee)).toBe(12_000_000);
    expect(Number(rows2[0].feeApplied)).toBe(240_000);
    expect(Number(rows2[0].amountAfterFee)).toBe(11_760_000);
    // [Admin Demo 17/9 đảo chính sách] GD ĐỒNG BỘ theo bill đã sửa (10tr → 12tr) — trước đây giữ 10tr nên doanh số
    // NĐT/SigMa (đọc bảng GIAO DỊCH) không đổi khi sửa bill, lệch câm. Note giữ DẤU VẾT sửa.
    const txn2 = await db.transaction.findUnique({ where: { id: lo1!.transactionId! } });
    expect(Number(txn2?.amount)).toBe(12_000_000);
    expect(txn2?.note ?? '').toContain('ĐÃ ĐỒNG BỘ');
    // Đồng bộ CHÉO: mirror NĐT cũng ra 12tr.
    const iMsg2 = await db.chatMessage.findUnique({ where: { id: investorMessageId } });
    const iMeta2 = JSON.parse(iMsg2?.metadataJson ?? '{}');
    expect(iMeta2.posBill.amount).toBe(12_000_000);
    expect(iMeta2.billEdited?.to?.amount).toBe(12_000_000);

    // ── BƯỚC 5: RE-OCR CÙNG ẢNH — OCR trả số CŨ (10tr) phải bị ĐÈ bằng BẢN SỬA (12tr) + nhận "đã gửi" ──
    const staleBills: OcrBill[] = [{ ...ocrBill }]; // cache OCR trả nguyên số cũ
    const corr = await applyPosBillCorrectionByImage(db, staleBills, img);
    expect(corr.applied).toBe(true);
    expect(staleBills[0].totalAmount).toBe(12_000_000); // card review ra BẢN SỬA, không phải số OCR cũ
    expect(corr.warnings.join(' ')).toContain('BẢN SỬA');
    const review2 = await reviewBills(db, staleBills, new Date());
    await augmentReviewWithImageHash(db, review2, img);
    expect(review2[0].alreadySent).toBe(true);
    expect(review2[0].sentMessageId).toBe(dealerMessageId);

    // ── BƯỚC 6: GỬI LẠI cùng ảnh (bill = bản sửa 12tr) → CẬP NHẬT tin cũ, KHÔNG lô/tin mới ──
    const send2 = await request(app).post('/v1/ocr-send/send').set(headers)
      .send({ token, bill: { ...ocrBill, totalAmount: 12_000_000 } });
    expect(send2.status).toBe(200);
    expect(send2.body.updated).toBe(true);
    expect(String(send2.body.dealerMessageId)).toBe(dealerMessageId);
    // KHÔNG lô trùng: vẫn đúng 1 Lô sống cho TID này; KHÔNG tin bill thứ 2 trong phòng đại lý.
    const liveLos = await db.lo.findMany({ where: { billKey: { startsWith: `nat|${w.tid.tid}|` }, status: { not: 'CANCELLED' } } });
    expect(liveLos).toHaveLength(1);
    expect(liveLos[0].id).toBe(loId);
    const dealerBillMsgs = await db.chatMessage.findMany({ where: { roomId: w.room.id, metadataJson: { contains: '"isBillImage":true' }, deletedAt: null } });
    expect(dealerBillMsgs).toHaveLength(1);

    // ── BƯỚC 7: DOANH SỐ CUỐI khớp bản sửa từng đồng ──
    const rep2 = await getRoomRevenueReport(db, w.agent.id, w.room.id, { from, to });
    expect(rep2.totalGross).toBe(12_000_000);
    expect(rep2.totalFee).toBe(240_000);
    expect(rep2.totalNet).toBe(11_760_000);
    expect(rep2.loCount).toBe(1);
    expect(rep2.daily).toEqual([{ date: '2026-09-09', gross: 12_000_000, net: 11_760_000 }]);
    // KPI nhóm (buildRoomsRevenueKpi) — kỳ bao ngày bill: số PHẢI khớp report phòng (cùng nguồn).
    const kpi = await buildRoomsRevenueKpi(db, w.agent.id, [w.room.id], new Date(), 1, { from, to });
    expect(kpi).toHaveLength(1);
    expect(kpi[0].error).toBeUndefined();
    expect(kpi[0].grossHomNay).toBe(12_000_000);
    expect(kpi[0].netHomNay).toBe(11_760_000);
    expect(kpi[0].soLoHomNay).toBe(1);
  }, 120_000);

  it('ĐỐI KHÁNG: gửi lại ảnh KHÁC nhưng cùng lô+tiền+ngày → 409 DUPLICATE; allowDuplicate vẫn CHẶN CỨNG post trùng (spec 1/9) nhưng doanh số idempotent không x2', async () => {
    const w = await setupPosWorld();
    const headers = await sessionFor(w.agent.id);
    const img1 = pngUniq('dup-a');
    const token1 = putPendingOnDisk(img1);
    const bill: OcrBill = { tid: w.tid.tid, agencyName: w.hkdName, batchNumber: '31', type: 'SETTLEMENT', totalAmount: 5_500_000, dateTime: '09/09/2026 11:00', settlementCode: null };
    const s1 = await request(app).post('/v1/ocr-send/send').set(headers).send({ token: token1, bill });
    expect(s1.status).toBe(200);
    const loId1 = Number(s1.body.revenue.loId);

    // Ảnh KHÁC (chụp lại) cùng lô+tiền+ngày → route hỏi 409 DUPLICATE (không tự gửi).
    const img2 = pngUniq('dup-b');
    const token2 = putPendingOnDisk(img2);
    const s2 = await request(app).post('/v1/ocr-send/send').set(headers).send({ token: token2, bill });
    expect(s2.status).toBe(409);
    expect(s2.body.error).toBe('DUPLICATE');

    // "Vẫn gửi" (allowDuplicate): doanh số UPSERT idempotent về CHÍNH Lô cũ, nhưng POST tin bị CHẶN CỨNG
    // (decideBillSendTargets — spec Admin Demo 1/9 "trùng bấm gửi VẪN KHÔNG gửi") → route trả 409 "Doanh số đã ghi".
    const s3 = await request(app).post('/v1/ocr-send/send').set(headers).send({ token: token2, bill, allowDuplicate: true });
    expect(s3.status).toBe(409);
    expect(s3.body.duplicate).toBe(true);
    expect(String(s3.body.message)).toContain('không nhân đôi');
    void loId1;
    const liveLos = await getBotDb().lo.findMany({ where: { billKey: { startsWith: `nat|${w.tid.tid}|31|` }, status: { not: 'CANCELLED' } } });
    expect(liveLos).toHaveLength(1);
    const rep = await getRoomRevenueReport(getBotDb(), w.agent.id, w.room.id, { from: new Date(2026, 8, 9), to: new Date(2026, 8, 10) });
    expect(rep.totalGross).toBe(5_500_000); // đúng 1 bill, không x2
  }, 120_000);
});
