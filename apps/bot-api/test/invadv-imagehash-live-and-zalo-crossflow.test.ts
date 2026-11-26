// [KIỂM CHỨNG ĐỘC LẬP 11/9 — Agent 5 soi lại fix của 4 agent] 2 LỖ THẬT tìm thấy khi đối chiếu claim ↔ code:
//   (F1) INVADV-IMAGEHASH-NULL vá NỬA LỚP: sendTransferByDirection đã có hash ảnh thật (fix CAO-5) nhưng nhánh
//        TẠM ỨNG (INVESTOR_TO_ALPHA → recordInvestorAdvanceFromTransfer) vẫn rút hash TỪ CHUỖI KHOÁ → khoá
//        ref-tier ghi image_hash NULL → đúng ca "82/127 dòng" trong claim VẪN mất lưới chống ghi ứng 2 LẦN
//        (chỉ nhánh HOÀN THỪA được vá). Fix: caller truyền ocrImageHashOf(imageBuffer) xuống ingest.
//   (F2) IMAGE_SENT_OTHER_FLOW (Agent-2) chỉ nhìn marker ocrImageHash/ocrSendKey/isQr* — bill do watcher ZALO
//        ingest (Support SigMa, zalo-bill-ingest.ts) ĐÃ GHI DOANH SỐ nhưng metadata chỉ mang `zaloBillHash`
//        → lưới trượt → cùng ảnh đó vẫn ghi được thành CK hoàn/ứng MA. Fix: findImageSentOtherFlowForCk tra
//        thêm zaloBillHash (chỉ tin đã-ghi-tiền: isBillImage + billAmount, KHÔNG needsManual).
// Test 2 CHIỀU trên throwaway Postgres, đi qua CHÍNH hàm production (không mock lớp tiền).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import {
  sendTransferByDirection, findImageSentOtherFlowForCk,
  ocrImageHashOf, type TransferReview
} from '../src/ocr-send-service.js';
import { makeChatRoom, makeAgent, makeChatRoomDaGanKhach } from './fixtures.js';
// [14/10] Nhóm phải ĐÃ GÁN KHÁCH: service nay chặn gửi CK vào nhóm trống (ROOM_NO_CUSTOMER — nhóm không
// gắn khách thì tiền hoàn không vào đối soát). Chốt đó thêm sau loạt test này nên chúng đỏ hàng loạt.

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
// PNG 1x1 hợp lệ (saveAttachment sniff magic bytes) + đuôi khác nhau để mỗi ca có HASH ẢNH riêng.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const anh = (tag: string): Buffer => Buffer.concat([PNG, Buffer.from(tag)]);

/** Review tạm ứng NĐT→SigMa (đường sendTransferByDirection thật dùng). */
const trInv = (over: Partial<TransferReview>): TransferReview => ({
  senderName: 'KHACH HANG 02', senderIsAlpha: false, senderAccount: '0011223344',
  receiverName: 'KHACH HANG 01', receiverAccount: '9988776655', content: 'ung tien',
  amount: 3_456_000, bank: 'MB', senderBank: null, date: '10/09/2026', time: '09:30:00',
  ref: null, matchedRoomId: null, matchedRoomName: null,
  direction: 'INVESTOR_TO_ALPHA', entityType: 'INVESTOR', entityId: null, needsManualPick: false, warnings: [], ...over
});

/** Review CK hoàn/hoàn-thừa đại lý (khuôn dealer-ck-cross-room.guard.test.ts). */
const trCk = (over: Partial<TransferReview>): TransferReview => ({
  senderName: 'NGUYEN VAN A', senderIsAlpha: false, senderAccount: null,
  receiverName: 'KHACH HANG 01', receiverAccount: null, content: null,
  amount: 5_000_000, bank: 'MB', senderBank: null, date: '10/09/2026', time: '10:00:00',
  ref: uniq('FTZC').slice(0, 16), // ref DÀI có chữ → ckTxnKey ref-tier
  matchedRoomId: null, matchedRoomName: null,
  direction: 'DEALER_TO_ALPHA', entityType: 'DEALER', entityId: null, needsManualPick: false, warnings: [], ...over
});

async function makeInvestor() {
  const db = getBotDb();
  return db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT imagehash', nickname: uniq('ih').slice(0, 18), status: 'ACTIVE', investFeeMilli: 100 } });
}

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

/** NĐT + phòng NĐT đã gán (sendTransferByDirection cần resolveInvestorRoomById). */
async function makeInvestorWithRoom() {
  const db = getBotDb();
  const inv = await makeInvestor();
  const room = await makeChatRoomDaGanKhach({ name: uniq('NĐT ') });
  await db.investorChatGroup.create({ data: { investorId: inv.id, roomId: room.id } });
  return { inv, room };
}
/** Ref NGẮN toàn số (số biên lai 4 số) → buildCkTxnKey ra khoá ref-tier `ck|ref|NNNN` (không mang hash). */
const refNgan = (): string => String(Math.floor(Math.random() * 10000)).padStart(4, '0');

describe('F1 — đường LIVE sendTransferByDirection (INVESTOR_TO_ALPHA) PHẢI ghi image_hash ảnh THẬT khi khoá ref-tier', () => {
  it('CHIỀU ĐÚNG: tạm ứng ref-tier qua sendTransferByDirection → investor_advances.image_hash = sha256 ảnh (trước fix: NULL)', async () => {
    const db = getBotDb();
    const { inv } = await makeInvestorWithRoom();
    const buf = anh(uniq('advA'));
    const hash = ocrImageHashOf(buf);
    const r1 = await sendTransferByDirection(db, trInv({ entityId: inv.id, ref: refNgan() }), buf, 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    expect(r1.recorded).toBe(true);
    const rows = await db.$queryRawUnsafe<{ image_hash: string | null }[]>(
      `SELECT image_hash FROM investor_advances WHERE investor_id = $1 AND deleted_at IS NULL`, inv.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].image_hash).toBe(hash); // TRƯỚC FIX: null (caller không truyền, hàm rút từ chuỗi khoá ref-tier)
  });
  it('LƯỚI SỐNG (đường live): OCR đọc LỆCH ref (khoá KHÁC) nhưng CÙNG ảnh → duplicate, KHÔNG ghi ứng 2 LẦN', async () => {
    const db = getBotDb();
    const { inv } = await makeInvestorWithRoom();
    const buf = anh(uniq('advB'));
    const r1 = await sendTransferByDirection(db, trInv({ entityId: inv.id, amount: 7_777_000, ref: '1' + refNgan().slice(1) }), buf, 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    // Lần 2: cùng ẢNH, ref đọc lệch (khoá CHẮC CHẮN khác — đầu 2 vs đầu 1) — trước fix image_hash NULL nên tầng
    // hash TRƯỢT → ghi ứng lần 2.
    const r2 = await sendTransferByDirection(db, trInv({ entityId: inv.id, amount: 7_777_000, ref: '2' + refNgan().slice(1) }), buf, 'ck.png', new Date());
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBe(true);
    const n = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM investor_advances WHERE investor_id = $1 AND deleted_at IS NULL`, inv.id);
    expect(Number(n[0].n)).toBe(1); // đúng 1 khoản ứng — không x2
  });
  it('CHIỀU SAI (không chặn oan): ảnh KHÁC + ref khác + tiền khác → ghi bình thường (không duplicate giả)', async () => {
    const db = getBotDb();
    const { inv } = await makeInvestorWithRoom();
    const r1 = await sendTransferByDirection(db, trInv({ entityId: inv.id, amount: 1_100_000, ref: refNgan() }), anh(uniq('c1')), 'ck.png', new Date());
    const r2 = await sendTransferByDirection(db, trInv({ entityId: inv.id, amount: 2_200_000, ref: refNgan() }), anh(uniq('c2')), 'ck.png', new Date());
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBeUndefined();
    const n = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM investor_advances WHERE investor_id = $1 AND deleted_at IS NULL`, inv.id);
    expect(Number(n[0].n)).toBe(2);
  });
});

describe('F2 — ảnh bill ZALO-ingest ĐÃ GHI DOANH SỐ không được đi lại thành CK hoàn/ứng (vá lỗ marker zaloBillHash)', () => {
  it('CHIỀU CHẶN: tin Zalo RECORDED_SALE (isBillImage + billAmount) → findImageSentOtherFlowForCk=POS + postDealerRefundCk fail-closed', async () => {
    const db = getBotDb();
    const roomZalo = await makeChatRoomDaGanKhach({ name: uniq('ĐL Zalo ') });
    const roomCk = await makeChatRoomDaGanKhach({ name: uniq('ĐL CK ') });
    const sender = await makeAgent();
    const buf = anh(uniq('zbill'));
    const zHash = ocrImageHashOf(buf); // zalo-bill-ingest cũng sha256 hex cùng buffer
    await db.chatMessage.create({
      data: {
        roomId: roomZalo.id, senderId: sender.id, kind: 'IMAGE', body: '📋 Bill TID 12345678',
        metadataJson: JSON.stringify({ isBillImage: true, billAmount: 5_000_000, billFields: { tid: { value: '12345678' } }, zaloBillHash: zHash, source: 'ZALO' })
      }
    });
    const hit = await findImageSentOtherFlowForCk(db, zHash);
    expect(hit?.flow).toBe('POS'); // TRƯỚC FIX: null (chỉ tra marker ocrImageHash)
    // Đường LIVE: gửi chính ảnh đó thành CK hoàn-thừa đại lý → phải CHẶN (không hoàn/ứng ma).
    const r = await sendTransferByDirection(db, trCk({ matchedRoomId: roomCk.id }), buf, 'ck.png', new Date());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('IMAGE_SENT_OTHER_FLOW:POS');
  });
  it('CHIỀU KHÔNG CHẶN OAN: tin Zalo needsManual (watcher KHÔNG ghi tiền — có thể chính là ảnh CK bị đoán nhầm) → đường CK vẫn chạy', async () => {
    const db = getBotDb();
    const roomZalo = await makeChatRoomDaGanKhach({ name: uniq('ĐL Zalo M ') });
    const roomCk = await makeChatRoomDaGanKhach({ name: uniq('ĐL CK M ') });
    const sender = await makeAgent();
    const buf = anh(uniq('zmanual'));
    const zHash = ocrImageHashOf(buf);
    await db.chatMessage.create({
      data: {
        roomId: roomZalo.id, senderId: sender.id, kind: 'IMAGE', body: '⚠ cần kiểm tay',
        metadataJson: JSON.stringify({ isBillImage: true, needsManual: true, zaloBillHash: zHash, source: 'ZALO' })
      }
    });
    expect(await findImageSentOtherFlowForCk(db, zHash)).toBeNull();
    const r = await sendTransferByDirection(db, trCk({ matchedRoomId: roomCk.id }), buf, 'ck.png', new Date());
    expect(r.ok).toBe(true); // nghiệp vụ hợp lệ không bị chặn oan
  });
});
