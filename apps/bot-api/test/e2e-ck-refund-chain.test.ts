// E2E TIỀN LUỒNG CK HOÀN/ỨNG ĐẠI LÝ (Agent-2 tái hiện 11/9) — trọn chuỗi qua CHÍNH hàm production:
//   doanh số (createLoFromBillTid — cần hoàn) → phân loại CK (reviewTransfers/classifyTransfer) → gửi 4 hướng
//   (sendTransferByDirection) → dedup gửi lại CẬP NHẬT tin cũ (ngày/tiền/loại) → buildDealerRefundReconcile:
//   cần/đã hoàn/ứng treo/thừa-thiếu TỪNG ĐỒNG, kể cả WATERFALL QUA NGÀY (ứng hôm trước, đại lý trả hôm sau —
//   carry mới 11/9) → augmentTransferReviewWithSentKind khôi phục loại ỨNG khi re-OCR.
// Throwaway Postgres (global-setup.ts). Ảnh = PNG thật (saveAttachment sniff magic bytes).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { createLoFromBillTid, buildBillKey } from '../src/lo-service.js';
import { ensureSupportAlphaAgent } from '../src/zalo-bill-support.js';
import {
  reviewTransfers,
  sendTransferByDirection,
  buildDealerRefundReconcile,
  augmentTransferReviewWithSentKind,
  type TransferRaw
} from '../src/ocr-send-service.js';
import {
  makeBank, makeCardType, makeChatRoom, makeChatRoomMember, makeCustomer, makeCustomerChatGroup,
  makePartner, makeFeeSellQuote, makeTid, makeTidSellFee, makeAgent, defaultFeeTypeForQuote
} from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PNG_BASE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pngUniq = (tag: string): Buffer => Buffer.concat([PNG_BASE, Buffer.from(`::${tag}::${uniq('img')}`)]);

/** Thế giới CK: phòng đại lý tên ĐẶC THÙ (để classifyTransfer dealer-fuzzy khớp 100% token), TID + giá bán 2%. */
async function setupCkWorld() {
  const db = getBotDb();
  const bank = await makeBank();
  const partner = await makePartner();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const agent = await makeAgent(undefined, { name: 'Nhân sự CK' });
  const roomName = `DAILY CKX${Date.now()}${Math.floor(Math.random() * 1e4)}`; // token lạ → fuzzy match duy nhất
  const room = await makeChatRoom({ type: 'GROUP', name: roomName });
  await makeChatRoomMember(room.id, agent.id);
  const customer = await makeCustomer();
  await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id, feeTypeId: feeType.id });
  const tid = await makeTid({ tid: `96${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: customer.id, partnerId: partner.id, bankId: bank.id, hkdName: `HKD ${roomName}` });
  await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000, effectiveFrom: new Date('2020-01-01T00:00:00Z') });
  await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000 });
  await db.feeRate.create({ data: { partnerId: partner.id, cardTypeId: cardType.id, phiMua: 500, phiCaiMay: 1100, effectiveFrom: new Date('2020-01-01T00:00:00Z') } });
  return { db, bank, partner, cardType, feeType, agent, room, roomName, customer, tid };
}

/** Ghi doanh số 1 bill (đường production createLoFromBillTid — CÙNG hàm route /send gọi). */
async function seedRevenue(w: Awaited<ReturnType<typeof setupCkWorld>>, loNum: string, amount: number, txnDate: Date): Promise<number> {
  const db = w.db;
  const bot = await ensureSupportAlphaAgent(db);
  await db.chatRoomMember.upsert({
    where: { roomId_agentId: { roomId: w.room.id, agentId: bot.id } },
    update: { leftAt: null }, create: { roomId: w.room.id, agentId: bot.id, role: 'MEMBER' }
  });
  const billKey = buildBillKey({ tid: w.tid.tid, batchNumber: loNum, invoiceNumber: null, imageHash: null, billDate: txnDate });
  const r = await createLoFromBillTid(db, bot.id, { tidString: w.tid.tid, cardTypeId: w.cardType.id, amountBeforeFee: amount, billKey, txnDate });
  if (!r.ok) throw new Error(`seedRevenue thất bại: ${JSON.stringify(r)}`);
  return r.data.id;
}

const rawCk = (over: Partial<TransferRaw>): TransferRaw => ({
  receiverName: null, receiverAccount: null, receiverBank: 'MB', senderName: null, senderAccount: null,
  amount: 0, date: null, time: null, ref: null, content: null, ...over
});

describe('LUỒNG 2 — CK hoàn/ứng đại lý: gửi 4 hướng → dedup cập nhật → đối soát waterfall qua ngày', () => {
  it('cần/đã hoàn/ứng treo/thừa-thiếu khớp TỪNG ĐỒNG, carry ứng ngày 1 → đại lý trả ngày 2', async () => {
    const w = await setupCkWorld();
    const db = w.db;

    // ── DOANH SỐ (cần hoàn): 09/09 bill 10tr (net 9.8tr) + 10/09 bill 5tr (net 4.9tr) ──
    await seedRevenue(w, '21', 10_000_000, new Date(2026, 8, 9, 10, 0));
    await seedRevenue(w, '22', 5_000_000, new Date(2026, 8, 10, 9, 30));

    // ── CK 1 (09/09): SigMa HOÀN đại lý 6.8tr — phân loại qua reviewTransfers (production) ──
    const refA = uniq('FTA').toUpperCase();
    const revA = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w.roomName, amount: 6_800_000, date: '09/09/2026', time: '14:00:00', ref: refA })]);
    expect(revA[0].direction).toBe('SIGMA_TO_DEALER');
    expect(revA[0].matchedRoomId).toBe(w.room.id); // dealer-fuzzy khớp đúng phòng
    expect(revA[0].alreadySent).toBe(false);
    const imgA = pngUniq('ck-A');
    const sA = await sendTransferByDirection(db, revA[0], imgA, 'ckA.png', new Date());
    expect(sA.ok).toBe(true);
    expect(sA.roomId).toBe(w.room.id);
    expect(sA.deduped).not.toBe(true);

    // ── CK 2 (09/09): SigMa ỨNG TRƯỚC 3tr (người dùng toggle loại ỨNG — client production làm vậy) ──
    const refB = uniq('FTB').toUpperCase();
    const revB = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w.roomName, amount: 3_000_000, date: '09/09/2026', time: '15:30:00', ref: refB })]);
    expect(revB[0].matchedRoomId).toBe(w.room.id);
    revB[0].direction = 'SIGMA_TO_DEALER_ADVANCE'; // toggle "ứng trước" trên UI
    const imgB = pngUniq('ck-B');
    const sB = await sendTransferByDirection(db, revB[0], imgB, 'ckB.png', new Date());
    expect(sB.ok).toBe(true);

    // ── CK 3 (10/09): ĐẠI LÝ TRẢ VỀ SigMa 3tr (trả khoản ứng hôm trước — carry qua ngày) ──
    const refC = uniq('FTC').toUpperCase();
    const revC = await reviewTransfers(db, [rawCk({ senderName: w.roomName, receiverName: 'KHACH HANG 01', amount: 3_000_000, date: '10/09/2026', time: '08:00:00', ref: refC })]);
    expect(revC[0].direction).toBe('DEALER_TO_ALPHA');
    expect(revC[0].matchedRoomId).toBe(w.room.id);
    const sC = await sendTransferByDirection(db, revC[0], pngUniq('ck-C'), 'ckC.png', new Date());
    expect(sC.ok).toBe(true);

    // ── CK 4 (10/09): SigMa HOÀN 4.9tr ──
    const refD = uniq('FTD').toUpperCase();
    const revD = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w.roomName, amount: 4_900_000, date: '10/09/2026', time: '16:45:00', ref: refD })]);
    const imgD = pngUniq('ck-D');
    const sD = await sendTransferByDirection(db, revD[0], imgD, 'ckD.png', new Date());
    expect(sD.ok).toBe(true);

    // ── ĐỐI SOÁT [09/09, 11/09): waterfall qua ngày ──
    const from = new Date(2026, 8, 9), to = new Date(2026, 8, 11);
    const rep = await buildDealerRefundReconcile(db, w.room.id, from, to);
    const d1 = rep.days.find((d) => d.date === '2026-09-09');
    const d2 = rep.days.find((d) => d.date === '2026-09-10');
    // Ngày 1: cần 9.8tr; hoàn 6.8tr + ứng 3tr → đã trả 9.8tr → khớp 0đ.
    expect(d1).toEqual({ date: '2026-09-09', canHoan: 9_800_000, daHoan: 6_800_000, daUng: 3_000_000, thuaThieu: 0, status: 'match' });
    // Ngày 2: cần 4.9tr; đại lý trả 3tr → HẠ ỨNG TREO ngày 1 (carry: daUng = −3tr), hoàn 4.9tr →
    // đã trả ròng ngày 2 = 4.9 − 3 = 1.9tr → thiếu 3tr (số "giả" per-day; ròng kỳ mới là thật).
    expect(d2).toEqual({ date: '2026-09-10', canHoan: 4_900_000, daHoan: 4_900_000, daUng: -3_000_000, thuaThieu: -3_000_000, status: 'partial' });
    // Tổng kỳ: cần 14.7tr; hoàn 11.7tr; ứng treo cuối kỳ 0 (đã trả); ứng gốc 3tr; hoàn-ứng 3tr; thiếu ròng 3tr.
    expect(rep.totalCanHoan).toBe(14_700_000);
    expect(rep.totalDaHoan).toBe(11_700_000);
    expect(rep.totalDaUng).toBe(0);
    expect(rep.totalUngGoc).toBe(3_000_000);
    expect(rep.totalHoanUng).toBe(3_000_000);
    expect(rep.totalThuaThieu).toBe(-3_000_000);
    // Σ ngày = tổng (invariant waterfall — hết lệch 2 cách tính).
    expect(rep.days.reduce((s, d) => s + d.daHoan, 0)).toBe(rep.totalDaHoan);
    expect(rep.days.reduce((s, d) => s + d.daUng, 0)).toBe(rep.totalDaUng);
    // List bill trong kỳ: đủ 4 CK, đúng dấu tiền (trả về = âm).
    expect(rep.bills).toHaveLength(4);
    const amounts = rep.bills.map((b) => b.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([-3_000_000, 3_000_000, 4_900_000, 6_800_000]);

    // ── DEDUP GỬI LẠI + SỬA (ngày/tiền) trên tin cũ — KHÔNG đăng trùng ──
    // Người duyệt OCR lại CK D, sửa tiền 4.9tr → 5tr + ngày 10/09 → 09/09 rồi bấm gửi: dedup theo ref phải CẬP NHẬT
    // tin cũ (amountUpdated + dateUpdated), tuyệt đối không tạo tin thứ 2.
    const revD2 = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w.roomName, amount: 5_000_000, date: '09/09/2026', time: '16:45:00', ref: refD })]);
    expect(revD2[0].alreadySent).toBe(true); // review đã báo sớm "đã gửi" theo ckTxnKey
    const sD2 = await sendTransferByDirection(db, revD2[0], imgD, 'ckD.png', new Date());
    expect(sD2.ok).toBe(true);
    expect(sD2.deduped).toBe(true);
    const ckMsgs = await db.chatMessage.findMany({ where: { roomId: w.room.id, metadataJson: { contains: `"ckTxnKey":"ck|ref|${refD}"` }, deletedAt: null } });
    expect(ckMsgs).toHaveLength(1); // vẫn đúng 1 tin
    const mD = JSON.parse(ckMsgs[0].metadataJson ?? '{}');
    expect(mD.refundAmount).toBe(5_000_000); // tiền bản sửa
    expect(mD.billDate).toBe('2026-09-09'); // ngày bản sửa

    // Đối soát SAU SỬA: CK D dời về 09/09 với 5tr — số từng đồng thay đổi đúng theo bản sửa, không đếm đôi.
    const rep2 = await buildDealerRefundReconcile(db, w.room.id, from, to);
    const e1 = rep2.days.find((d) => d.date === '2026-09-09');
    const e2 = rep2.days.find((d) => d.date === '2026-09-10');
    expect(e1).toEqual({ date: '2026-09-09', canHoan: 9_800_000, daHoan: 11_800_000, daUng: 3_000_000, thuaThieu: 5_000_000, status: 'over' });
    expect(e2).toEqual({ date: '2026-09-10', canHoan: 4_900_000, daHoan: 0, daUng: -3_000_000, thuaThieu: -7_900_000, status: 'partial' });
    expect(rep2.totalDaHoan).toBe(11_800_000);
    expect(rep2.totalDaUng).toBe(0);
    expect(rep2.totalThuaThieu).toBe(-2_900_000);
    expect(rep2.bills).toHaveLength(4); // không sinh bill thứ 5

    // ── RE-OCR CK ỨNG (B): classify luôn đoán "hoàn" — augment phải KHÔI PHỤC loại ỨNG + alreadySent ──
    const revB2 = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w.roomName, amount: 3_000_000, date: '09/09/2026', time: '15:30:00', ref: refB })]);
    expect(revB2[0].direction).toBe('SIGMA_TO_DEALER'); // OCR/classify không biết "ứng"
    await augmentTransferReviewWithSentKind(db, revB2, imgB);
    expect(revB2[0].alreadySent).toBe(true);
    expect(revB2[0].direction).toBe('SIGMA_TO_DEALER_ADVANCE'); // khôi phục đúng loại đã gửi
  }, 120_000);

  it('ĐỐI KHÁNG: cùng 1 CK (cùng ref) đi lạc sang phòng đại lý KHÁC → CHẶN CK_SENT_OTHER_ROOM (1 CK không nằm 2 phòng)', async () => {
    const w1 = await setupCkWorld();
    const w2 = await setupCkWorld();
    const db = w1.db;
    const ref = uniq('FTX').toUpperCase();
    const img = pngUniq('ck-cross');
    const rv1 = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w1.roomName, amount: 2_000_000, date: '09/09/2026', ref })]);
    expect(rv1[0].matchedRoomId).toBe(w1.room.id);
    const s1 = await sendTransferByDirection(db, rv1[0], img, 'ck.png', new Date());
    expect(s1.ok).toBe(true);
    // OCR lần 2 đọc lệch tên → khớp phòng ĐẠI LÝ KHÁC (w2) — gửi phải bị CHẶN cứng, không đếm đôi hoàn.
    const rv2 = await reviewTransfers(db, [rawCk({ senderName: 'KHACH HANG 01', receiverName: w2.roomName, amount: 2_000_000, date: '09/09/2026', ref })]);
    expect(rv2[0].matchedRoomId).toBe(w2.room.id);
    const s2 = await sendTransferByDirection(db, rv2[0], img, 'ck.png', new Date());
    expect(s2.ok).toBe(false);
    expect(String(s2.error)).toContain('CK_SENT_OTHER_ROOM');
    // Phòng 2 KHÔNG có tin CK nào; đối soát phòng 2 đã-hoàn = 0.
    const msgs2 = await db.chatMessage.findMany({ where: { roomId: w2.room.id, metadataJson: { contains: '"isTransferRefund"' }, deletedAt: null } });
    expect(msgs2).toHaveLength(0);
    const rep2 = await buildDealerRefundReconcile(db, w2.room.id, new Date(2026, 8, 9), new Date(2026, 8, 11));
    expect(rep2.totalDaHoan).toBe(0);
  }, 120_000);
});
