// TOÀN VẸN + DEDUP SỔ HOÀN TIỀN QR (Admin Demo 5/9 — hoạch toán ĐỘC LẬP, tách khỏi hoàn/ứng CK đại lý).
// Regression THẬT trên throwaway Postgres (globalSetup). QR refund ghi qua sendQrRefundToDealer (ocr-send-service.ts):
//   metadata = { isTransferRefund:true, isQrRefundCk:true, refundAmount, qrRefundKey:"QR:"+ref+":"+amount, ... }
//   → isTransferRefund:true khiến nó LỌT qua prefilter DB `metadataJson contains "isTransferRefund"` của
//     listDealerRefundCks (dòng 1627) → RỦI RO: nếu bước phân loại (dòng 1637-1638) không loại nó, QR refund bị
//     đếm THÀNH hoàn-CK-đại-lý = ĐẾM ĐÔI = RÒ CRITICAL.
// Khẳng định:
//   (A) DEDUP: 2 lần gửi QR refund cùng (ref, amount) → chỉ 1 tin/1 lần tính; qrRefundKeyOf ổn định + KHÁC namespace
//       ckTxnKey ("QR:" vs "ck|") để KPI tách pool "hoàn QR" khỏi pool CK.
//   (B) KHÔNG RÒ: tin QR refund (isQrRefundCk, KHÔNG isDealerRefundCk/isDealerAdvanceCk) → listDealerRefundCks PHẢI
//       loại (trả []); đối chứng: 1 tin hoàn-CK-đại-lý THẬT cùng phòng VẪN được liệt kê (test không rỗng vô nghĩa).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { qrRefundKeyOf, sendQrRefundToDealer, listDealerRefundCks, buildCkTxnKey } from '../src/ocr-send-service.js';
import { makeChatRoom, makeAgent } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
// PNG 1x1 hợp lệ (saveAttachment sniff magic-bytes THẬT → cần ảnh thật).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Seed 1 tin hoàn-CK-đại-lý THẬT (đối chứng): metadata giống postDealerRefundCk (dòng 1301) — isDealerRefundCk:true. */
async function seedRealDealerRefundCk(roomId: string, refundAmount: number): Promise<string> {
  const db = getBotDb();
  const bot = await makeAgent();
  const msg = await db.chatMessage.create({
    data: {
      roomId, senderId: bot.id, kind: 'IMAGE', body: 'hoàn CK đại lý (đối chứng)',
      metadataJson: JSON.stringify({ isTransferRefund: true, isDealerRefundCk: true, isDealerAdvanceCk: false, refundAmount, ckTxnKey: `ck|ref|${uniq('CK')}`, billDate: '2026-09-05' })
    }
  });
  return String(msg.id);
}

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('qrRefundKeyOf — khoá hoàn QR RIÊNG namespace (không đụng ckTxnKey CK)', () => {
  it('ổn định theo (ref, amount) + prefix "QR:" + KHÁC mọi namespace "ck|"', () => {
    const ref = 'FT2609ABC';
    // Ổn định: cùng (ref, amount) → cùng khoá (nền tảng của dedup).
    expect(qrRefundKeyOf(ref, 5_000_000)).toBe(qrRefundKeyOf(ref, 5_000_000));
    expect(qrRefundKeyOf(ref, 5_000_000)).toBe(`QR:${ref}:5000000`);
    // Trim ref + làm tròn amount (đồng nhất dedup doanh số theo (ref, amount)).
    expect(qrRefundKeyOf(`  ${ref}  `, 5_000_000.4)).toBe(`QR:${ref}:5000000`);
    // KHÁC tiền = khoá KHÁC (2 bill cùng ref khác tiền = 2 bill thật, hoàn đủ 2).
    expect(qrRefundKeyOf(ref, 5_000_000)).not.toBe(qrRefundKeyOf(ref, 6_000_000));
    // KHÁC namespace ckTxnKey: khoá QR bắt đầu "QR:", khoá CK bắt đầu "ck|" → 2 pool KPI tách nhau, không dedup chéo.
    const ck = buildCkTxnKey({ ref, amount: 5_000_000, date: '05/09/2026', senderName: null, receiverName: null, senderAccount: null, receiverAccount: null, bank: null } as never, PNG);
    expect(qrRefundKeyOf(ref, 5_000_000).startsWith('QR:')).toBe(true);
    expect(ck.startsWith('ck|')).toBe(true);
    expect(qrRefundKeyOf(ref, 5_000_000)).not.toBe(ck);
  });
});

describe('DEDUP — 2 lần gửi QR refund cùng (ref, amount) → chỉ 1 tin/1 lần tính', () => {
  it('gọi sendQrRefundToDealer 2 lần → 1 tin duy nhất, lần 2 deduped=true', async () => {
    const db = getBotDb();
    const room = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL QR ') });
    const ref = uniq('QRREF');
    const args = { dealerRoomId: room.id, ref, amount: 8_000_000, refundAmount: 7_920_000, sellFeeMilli: 1000, billDate: '05/09/2026', hkdName: 'HKD QR TEST', imageBuffer: PNG, imageName: 'bill.png' };
    const r1 = await sendQrRefundToDealer(db, args);
    expect(r1.ok).toBe(true);
    expect(r1.messageId).toBeTruthy();
    expect(r1.deduped).not.toBe(true);
    // Lần 2 cùng (ref, amount) → marker qrRefundKey đã tồn tại → KHÔNG đăng tin thứ 2.
    const r2 = await sendQrRefundToDealer(db, args);
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBe(true);

    const key = qrRefundKeyOf(ref, args.amount);
    const marker = `"qrRefundKey":${JSON.stringify(key)}`;
    const msgs = await db.chatMessage.findMany({ where: { roomId: room.id, deletedAt: null, metadataJson: { contains: marker } }, select: { metadataJson: true } });
    expect(msgs).toHaveLength(1); // 1 tin dù gọi 2 lần
    const p = JSON.parse(msgs[0].metadataJson ?? '{}');
    expect(p.isQrRefundCk).toBe(true);
    expect(p.isDealerRefundCk).toBeUndefined(); // KHÔNG mang cờ CK đại lý
    expect(p.qrRefundKey).toBe(key);
  });
});

describe('KHÔNG RÒ sang sổ hoàn/ứng CK đại lý — listDealerRefundCks loại QR refund', () => {
  it('phòng chỉ có QR refund → listDealerRefundCks = [] (dù lọt prefilter isTransferRefund)', async () => {
    const db = getBotDb();
    const room = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL QR2 ') });
    const send = await sendQrRefundToDealer(db, { dealerRoomId: room.id, ref: uniq('QRREF'), amount: 9_000_000, refundAmount: 8_910_000, sellFeeMilli: 1000, billDate: '05/09/2026', hkdName: 'HKD QR2', imageBuffer: PNG, imageName: 'bill.png' });
    expect(send.ok).toBe(true);
    // Xác nhận tin QR refund THỰC SỰ lọt prefilter DB (contains "isTransferRefund") — nếu không, test rỗng vô nghĩa.
    const prefiltered = await db.chatMessage.findMany({ where: { roomId: room.id, kind: 'IMAGE', deletedAt: null, metadataJson: { contains: '"isTransferRefund"' } }, select: { id: true } });
    expect(prefiltered.length).toBe(1);
    // NHƯNG bước phân loại (isDealerRefundCk/isDealerAdvanceCk) loại nó → sổ CK đại lý RỖNG.
    const cks = await listDealerRefundCks(db, room.id);
    expect(cks).toEqual([]);
  });

  it('đối chứng: QR refund + hoàn-CK-đại-lý THẬT cùng phòng → chỉ liệt kê CK thật (QR bị loại)', async () => {
    const db = getBotDb();
    const room = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL MIX ') });
    // 1 tin QR refund (phải bị loại) + 1 tin hoàn-CK-đại-lý thật (phải được liệt kê).
    await sendQrRefundToDealer(db, { dealerRoomId: room.id, ref: uniq('QRREF'), amount: 5_000_000, refundAmount: 4_950_000, sellFeeMilli: 1000, billDate: '05/09/2026', hkdName: 'HKD MIX', imageBuffer: PNG, imageName: 'bill.png' });
    const realCkId = await seedRealDealerRefundCk(room.id, 500_000);
    const cks = await listDealerRefundCks(db, room.id);
    // ĐÚNG 1 (chỉ CK thật) — KHÔNG đếm QR refund.
    expect(cks).toHaveLength(1);
    expect(cks[0].messageId).toBe(realCkId);
    expect(cks[0].refundAmount).toBe(500_000);
    expect(cks[0].kind).toBe('REFUND');
    // Không có refundAmount nào của QR (4.950.000) lọt vào sổ CK.
    expect(cks.some((c) => c.refundAmount === 4_950_000)).toBe(false);
  });
});
