// E2E TIỀN LUỒNG QR BÁN HÀNG (Agent-2 tái hiện 11/9) — trọn chuỗi qua CHÍNH route production POST /v1/ocr-send/send-qr:
//   reviewQr (match HKD → mã QR, phí bán/mua) → gửi: GHI DOANH SỐ (createQrTransactionSystem, phí cài=0) + HOÀN đại
//   lý (amount − phíBán) + CC NĐT (không lộ phí) → dedup ref+tiền (409) → SỬA ref/tiền rồi gửi lại CÙNG ẢNH → khoá
//   theo IMAGE_HASH (reserveQrSend + augmentQrReviewWithSent) → KHÔNG có transaction thứ 2. Assert TỪNG ĐỒNG.
// Throwaway Postgres. Gate báo-có server: không có creds DigiStore → CANNOT_CHECK (fail-open, đúng production khi
// chưa cấu hình creds cho mã).
// GATE CHỦ SIGMA: fixture e2e dùng agent code ngẫu nhiên (không phải 6 chủ) — bật bypass CHỈ Ở FILE NÀY
// để test luồng nghiệp vụ; gate thật được test riêng ở alpha-owner.test.ts + owner-gate-routes.test.ts (KHÔNG bypass).
process.env.SIGMA_OWNER_TEST_ALL = '1';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { reviewQr, augmentQrReviewWithSent, qrRefAlreadySent } from '../src/ocr-send-service.js';
import {
  makeAgent, makeBank, makeChatRoom, makeChatRoomMember, makeCustomer, makeCustomerChatGroup,
  makePartner, makeTid, makeReceiveAccountSource
} from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PNG_BASE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pngUniq = (tag: string): Buffer => Buffer.concat([PNG_BASE, Buffer.from(`::${tag}::${uniq('img')}`)]);

function putPendingOnDisk(buffer: Buffer): string {
  const token = randomUUID();
  const dir = path.join(process.cwd(), 'data', 'ocr-pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${token}.bin`), buffer);
  fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify({ imageName: 'qr.png', expiresAt: Date.now() + 60 * 60 * 1000 }), 'utf8');
  return token;
}

let uniqCounter = 0;
async function sessionFor(agentId: number): Promise<{ Cookie: string; [k: string]: string }> {
  uniqCounter += 1;
  const db = getBotDb();
  const rcUserId = `rc-e2eqr-${Date.now()}-${uniqCounter}`;
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: `e2eqr${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `tokqr-${uniqCounter}`, agentId });
  return { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}

/** Thế giới QR: mã QR (tids.kind='QR', tên HKD unique) + giá qr_partner_fee (bán 2%, mua 1%) + phòng đại lý
 *  (dropdown) + NĐT uỷ (receiveAccount → investorChatGroup). */
async function setupQrWorld() {
  const db = getBotDb();
  const bank = await makeBank();
  const partner = await makePartner();
  const agent = await makeAgent(undefined, { name: 'Nhân sự QR' });
  const dealerRoom = await makeChatRoom({ type: 'GROUP', name: uniq('Đại lý QRZ ') });
  await makeChatRoomMember(dealerRoom.id, agent.id);
  const customer = await makeCustomer();
  await makeCustomerChatGroup({ customerId: customer.id, roomId: dealerRoom.id });
  const hkdName = `HKD QRSHOP ${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`;
  const qrTid = await makeTid({ partnerId: partner.id, hkdName, status: 'ACTIVE' });
  await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, qrTid.id);
  await db.$executeRawUnsafe(
    `INSERT INTO qr_partner_fee (partner_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from) VALUES ($1, $2, $3, $4, $5)`,
    partner.id, 1000, 1200, 2000, new Date('2020-01-01T00:00:00Z')
  );
  // NĐT uỷ mã QR: TK nhận gắn investor + nhóm NĐT.
  const src = await makeReceiveAccountSource();
  const investor = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT QR e2e', nickname: uniq('nq').slice(0, 18), status: 'ACTIVE', investFeeMilli: 100 } });
  const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId: bank.id, accountName: 'TK NĐT QR', accountNumber: uniq('AC').slice(0, 18), investorId: investor.id } });
  await db.tid.update({ where: { id: qrTid.id }, data: { receiveAccountId: ra.id } });
  const invRoom = await makeChatRoom({ type: 'GROUP', name: uniq('NĐT QR ') });
  await db.investorChatGroup.create({ data: { investorId: investor.id, roomId: invRoom.id } });
  return { db, partner, agent, dealerRoom, customer, hkdName, qrTid, investor, invRoom };
}

const app = createApp();

describe('LUỒNG 3 — QR: review → gửi (doanh số + hoàn + cc NĐT) → dedup ref → sửa ref/tiền + cùng ảnh → khoá image_hash', () => {
  it('trọn chuỗi: phí đúng từng đồng, 1 GD duy nhất, hoàn 9.8tr, NĐT không lộ phí, re-gửi bị chặn mọi tầng', async () => {
    const w = await setupQrWorld();
    const db = w.db;
    const headers = await sessionFor(w.agent.id);
    const img = pngUniq('qr-chain');
    const token = putPendingOnDisk(img);
    const ref = uniq('QRREF').toUpperCase();
    const amount = 10_000_000;

    // ── BƯỚC 1: reviewQr (đúng hàm route /ocr nhánh QR gọi) ──
    const dealers = [{ roomId: w.dealerRoom.id, name: 'Đại lý QR test' }];
    const review = await reviewQr(db, [{ hkdName: w.hkdName, amount, ref, date: '09/09/2026', time: '14:30' }], new Date(), dealers, null, w.dealerRoom.id);
    expect(review).toHaveLength(1);
    expect(review[0].tidId).toBe(w.qrTid.id);
    expect(review[0].sellFeeMilli).toBe(2000);
    expect(review[0].sellFeeAmount).toBe(200_000);
    expect(review[0].partnerFeeMilli).toBe(1000);
    expect(review[0].refundAmount).toBe(9_800_000);
    expect(review[0].investorReceiveAmount).toBe(9_900_000); // NCC hoàn = amount − giá mua 1%
    expect(review[0].isWeekend).toBe(false); // 09/09/2026 = thứ Tư
    expect(review[0].blocked).toBe(false);

    // ── BƯỚC 2: GỬI qua route THẬT /send-qr ──
    const s1 = await request(app).post('/v1/ocr-send/send-qr').set(headers)
      .send({ token, qr: { hkdName: w.hkdName, ref, amount, dateTime: '09/09/2026 14:30' }, dealerId: w.dealerRoom.id });
    expect(s1.status).toBe(200);
    expect(s1.body.ok).toBe(true);
    expect(s1.body.revenue).toMatchObject({ ok: true, amount, sellFeeMilli: 2000, sellFeeAmount: 200_000, partnerFeeMilli: 1000, refundAmount: 9_800_000, investorReceiveAmount: 9_900_000 });
    const txnId = Number(s1.body.transactionId);

    // GD doanh số QR: amount đúng, KHÔNG loại thẻ, phí cài=0, spread bán = 1% (2%−1%), doanh thu từng đồng.
    const txn = await db.transaction.findUnique({ where: { id: txnId } });
    expect(Number(txn?.amount)).toBe(10_000_000);
    expect(txn?.cardTypeId).toBeNull();
    expect(txn?.phiCaiMayMilli).toBe(0);
    expect(txn?.partnerMarginMilli).toBe(1000);
    expect(txn?.sellMarginMilli).toBe(1000);
    expect(Number(txn?.revenuePartner)).toBe(100_000); // 10tr × 1% giá mua
    expect(Number(txn?.revenueSell)).toBe(100_000);    // 10tr × (2%−1%) spread
    expect(Number(txn?.revenueAmount)).toBe(200_000);
    const rawTxn = await db.$queryRawUnsafe<{ qr_ref: string | null; qr_dealer_room_id: string | null }[]>(
      `SELECT qr_ref, qr_dealer_room_id FROM transactions WHERE id = $1`, txnId);
    expect(rawTxn[0]?.qr_ref).toBe(ref);
    expect(rawTxn[0]?.qr_dealer_room_id).toBe(w.dealerRoom.id);

    // HOÀN đại lý: tin trong phòng đại lý với refundAmount 9.8tr + khoá "QR:ref:amount".
    expect(s1.body.refund?.ok).toBe(true);
    const refundMsgs = await db.chatMessage.findMany({ where: { roomId: w.dealerRoom.id, metadataJson: { contains: '"isQrRefundCk":true' }, deletedAt: null } });
    expect(refundMsgs).toHaveLength(1);
    const rMeta = JSON.parse(refundMsgs[0].metadataJson ?? '{}');
    expect(rMeta.refundAmount).toBe(9_800_000);
    expect(rMeta.qrRefundKey).toBe(`QR:${ref}:${amount}`);
    expect(rMeta.billDate).toBe('2026-09-09'); // ISO cho đối soát
    expect(rMeta.posBill.netAmount).toBe(9_800_000);

    // CC NĐT: đúng phòng NĐT, KHÔNG lộ phí bán/hoàn/đại lý.
    expect(s1.body.investor?.ok).toBe(true);
    expect(s1.body.investor?.roomId).toBe(w.invRoom.id);
    const invMsgs = await db.chatMessage.findMany({ where: { roomId: w.invRoom.id, metadataJson: { contains: '"isQrInvestorCc":true' }, deletedAt: null } });
    expect(invMsgs).toHaveLength(1);
    expect(invMsgs[0].body ?? '').toContain('10.000.000');
    expect((invMsgs[0].body ?? '').toLowerCase()).not.toMatch(/phí|hoàn/);
    expect(invMsgs[0].metadataJson ?? '').not.toMatch(/sellFee|refundAmount/);

    // ── BƯỚC 3: DEDUP ref+tiền — gửi lại y hệt → 409, KHÔNG GD thứ 2 ──
    expect(await qrRefAlreadySent(db, ref, amount)).toBe(true);
    const s2 = await request(app).post('/v1/ocr-send/send-qr').set(headers)
      .send({ token, qr: { hkdName: w.hkdName, ref, amount, dateTime: '09/09/2026 14:30' }, dealerId: w.dealerRoom.id });
    expect(s2.status).toBe(409);
    expect(s2.body.error).toBe('ALREADY_SENT');

    // reviewQr lại cùng ref → alreadySent + blocked (card khoá nút gửi).
    const review2 = await reviewQr(db, [{ hkdName: w.hkdName, amount, ref, date: '09/09/2026', time: '14:30' }], new Date(), dealers, null, w.dealerRoom.id);
    expect(review2[0].alreadySent).toBe(true);
    expect(review2[0].blocked).toBe(true);

    // ── BƯỚC 4: SỬA ref/tiền rồi gửi lại CÙNG ẢNH — mọi tầng phải khoá theo IMAGE_HASH ──
    const refSua = uniq('QRREF2').toUpperCase();
    const amountSua = 10_500_000;
    // (a) Review theo ảnh: OCR trả ref/tiền KHÁC bản đã gửi → augmentQrReviewWithSent nhận "đã gửi" theo hash,
    //     blocked + ghi chú bản-gửi để đối chiếu (CẤM OCR lại ra thông số cũ/mới mà tưởng chưa gửi).
    const review3 = await reviewQr(db, [{ hkdName: w.hkdName, amount: amountSua, ref: refSua, date: '09/09/2026', time: '14:30' }], new Date(), dealers, null, w.dealerRoom.id);
    expect(review3[0].alreadySent).toBe(false); // ref mới → tầng ref không thấy...
    await augmentQrReviewWithSent(db, review3, img);
    expect(review3[0].alreadySent).toBe(true); // ...nhưng tầng ẢNH thấy
    expect(review3[0].blocked).toBe(true);
    expect(review3[0].warnings.join(' ')).toContain(ref); // ghi chú nêu bản gửi gần nhất (ref cũ)
    // (b) Cứ cố gửi (client bỏ qua cờ) → reserveQrSend lớp image_hash chặn → 409, KHÔNG GD thứ 2.
    const s3 = await request(app).post('/v1/ocr-send/send-qr').set(headers)
      .send({ token, qr: { hkdName: w.hkdName, ref: refSua, amount: amountSua, dateTime: '09/09/2026 14:30' }, dealerId: w.dealerRoom.id });
    expect(s3.status).toBe(409);
    expect(s3.body.error).toBe('ALREADY_SENT');

    // Bất biến cuối: đúng 1 GD doanh số cho mã QR này, đúng 1 tin hoàn, đúng 1 tin cc NĐT.
    const txns = await db.transaction.findMany({ where: { tidId: w.qrTid.id, deletedAt: null } });
    expect(txns).toHaveLength(1);
    expect((await db.chatMessage.findMany({ where: { roomId: w.dealerRoom.id, metadataJson: { contains: '"isQrRefundCk":true' }, deletedAt: null } }))).toHaveLength(1);
    expect((await db.chatMessage.findMany({ where: { roomId: w.invRoom.id, metadataJson: { contains: '"isQrInvestorCc":true' }, deletedAt: null } }))).toHaveLength(1);
  }, 120_000);

  it('ĐỐI KHÁNG: thiếu ref → 400 (fail-closed, cấm ghi không dedup); dealerId không phải phòng đại lý → 400 BAD_DEALER', async () => {
    const w = await setupQrWorld();
    const headers = await sessionFor(w.agent.id);
    const token = putPendingOnDisk(pngUniq('qr-adv'));
    // Thiếu ref → không dedup được → chặn.
    const noRef = await request(app).post('/v1/ocr-send/send-qr').set(headers)
      .send({ token, qr: { hkdName: w.hkdName, ref: '', amount: 5_000_000, dateTime: '09/09/2026 10:00' }, dealerId: w.dealerRoom.id });
    expect(noRef.status).toBe(400);
    expect(noRef.body.error).toBe('NO_REF');
    // dealerId là phòng KHÔNG gán khách (phòng NĐT) → BAD_DEALER (chống bơm tin hoàn vào phòng bất kỳ).
    const bad = await request(app).post('/v1/ocr-send/send-qr').set(headers)
      .send({ token, qr: { hkdName: w.hkdName, ref: uniq('R').toUpperCase(), amount: 5_000_000, dateTime: '09/09/2026 10:00' }, dealerId: w.invRoom.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('BAD_DEALER');
    // Không GD nào bị ghi.
    expect(await getBotDb().transaction.findMany({ where: { tidId: w.qrTid.id, deletedAt: null } })).toHaveLength(0);
  }, 120_000);
});
