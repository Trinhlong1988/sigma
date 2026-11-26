// Báo cáo TỔNG GỘP SIGMA — buildAlphaAggregate trên throwaway Postgres. Khẳng định: POS vs QR TÁCH cột (không lẫn);
// per-NĐT (receiveAccountId), per-đại-lý (POS qua customer→room, QR qua qr_dealer_room_id); totals khớp; hoàn gộp;
// biên NGÀY HCM (bill 23:30 HCM thuộc đúng ngày, không rơi ngày kế UTC).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { buildAlphaAggregate } from '../src/routes/alpha-aggregate.js';
import { createQrTransactionSystem } from '@sigma/services';
import { makeBank, makePartner, makeCardType, makeFeeType, makeCustomer, makeChatRoom, makeCustomerChatGroup, makeReceiveAccountSource, makeTid, makeAgent } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function makeInvestor(): Promise<{ id: number; name: string }> {
  const db = getBotDb();
  const iv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: uniq('NDT '), nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: 0 } });
  return { id: iv.id, name: iv.nickname };
}
async function makeReceiveAccountForInvestor(bankId: number, investorId: number): Promise<number> {
  const db = getBotDb();
  const src = await makeReceiveAccountSource();
  const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId, accountName: 'TK', accountNumber: uniq('AC').slice(0, 18), investorId } });
  return ra.id;
}
/** Set cột RAW của tid (kind / receive_account_id / customer_id). */
async function patchTidRaw(tidId: number, cols: { kind?: string; receiveAccountId?: number | null; customerId?: number | null }): Promise<void> {
  const db = getBotDb();
  const sets: string[] = []; const vals: unknown[] = [];
  if (cols.kind != null) { vals.push(cols.kind); sets.push(`kind = $${vals.length}`); }
  if (cols.receiveAccountId !== undefined) { vals.push(cols.receiveAccountId); sets.push(`receive_account_id = $${vals.length}`); }
  if (cols.customerId !== undefined) { vals.push(cols.customerId); sets.push(`customer_id = $${vals.length}`); }
  if (sets.length === 0) return;
  vals.push(tidId);
  await db.$executeRawUnsafe(`UPDATE tids SET ${sets.join(', ')} WHERE id = $${vals.length}`, ...vals);
}
/** Tạo 1 GD POS qua RAW SQL (txn_date bằng ISO ::timestamptz — KHỚP cách aggregate ĐỌC; tránh lệch TZ do Prisma
 *  driver-adapter serialize Date lúc create, đúng incident đã ghi ở investor-report.ts). aggregate chỉ Σ amount. */
async function makePosTxn(opts: { tidId: number; cardTypeId: number; feeTypeId: number; amount: number; txnDate: Date }): Promise<void> {
  const db = getBotDb();
  await db.$executeRawUnsafe(
    `INSERT INTO transactions (tid_id, card_type_id, fee_type_id, amount, txn_date, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, 'POSTED', now(), now())`,
    opts.tidId, opts.cardTypeId, opts.feeTypeId, BigInt(opts.amount), opts.txnDate.toISOString()
  );
}

describe('buildAlphaAggregate — tổng gộp POS/QR + hoàn, per NĐT/đại lý', () => {
  it('POS (ĐL A, NĐT X) + QR 10tr (ĐL B, NĐT Y): tách cột đúng, totals khớp, hoàn gộp, biên ngày HCM', async () => {
    const db = getBotDb();
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();

    // Kỳ: HCM 2027-03-10 [00:00 → 2027-03-11 00:00). HCM midnight 10 = 2027-03-09T17:00Z; 11 = 2027-03-10T17:00Z.
    // WINDOW ĐỘC NHẤT 2027-03 (throwaway DB DÙNG CHUNG giữa các file test — totals là Σ TOÀN CỤC → tránh nhiễm GD QR
    // của test khác rơi vào kỳ; per-entity rows đã cô lập theo investor/room riêng).
    // [9/9 — FIX test tự nhiễm] Ngày CỐ ĐỊNH làm totals CỘNG DỒN qua các lần chạy (DB throwaway dùng chung, không
    // dọn giữa các lần) → chạy lần 2 thấy QR 24tr thay vì 10tr. Nay mỗi lần chạy lấy MỘT NGÀY RIÊNG (tương lai xa
    // theo timestamp) ⇒ Σ toàn cục chỉ thấy dữ liệu của chính lần chạy này.
    const ngayRieng = new Date(Date.UTC(2100, 0, 1) + (Date.now() % 20000) * 86_400_000);
    const from = new Date(Date.UTC(ngayRieng.getUTCFullYear(), ngayRieng.getUTCMonth(), ngayRieng.getUTCDate(), 17, 0, 0));
    const to = new Date(from.getTime() + 24 * 3600_000);
    /** Mốc trong/ngoài kỳ tính THEO `from` (giữ nguyên ý nghĩa biên HCM của test gốc). */
    const moc = (gio: number): Date => new Date(from.getTime() + gio * 3600_000);
    /** Ngày HCM (YYYY-MM-DD) của kỳ — dùng cho billDate tin hoàn. */
    const ngayHCM = (d: Date): string => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

    // ── NĐT X + ĐL A (POS) ──
    const invX = await makeInvestor();
    const raX = await makeReceiveAccountForInvestor(bank.id, invX.id);
    const custA = await makeCustomer();
    const roomA = await makeChatRoom({ type: 'GROUP', name: 'ĐL A' });
    await makeCustomerChatGroup({ customerId: custA.id, roomId: roomA.id });
    const tidPos = await makeTid({ partnerId: partner.id, bankId: bank.id, hkdName: uniq('HKD POS ') });
    await patchTidRaw(tidPos.id, { kind: 'POS', receiveAccountId: raX, customerId: custA.id });
    // POS bill 5.000.000 lúc HCM 23:30 ngày 10 = UTC 2026-09-10T16:30Z (BIÊN: phải thuộc ngày 10).
    await makePosTxn({ tidId: tidPos.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amount: 5_000_000, txnDate: moc(23.5) });
    // BIÊN NGOÀI: HCM 00:30 ngày 11 = UTC 2026-09-10T17:30Z → PHẢI bị loại.
    await makePosTxn({ tidId: tidPos.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amount: 999, txnDate: moc(24.5) });

    // ── NĐT Y + ĐL B (QR) ──
    const invY = await makeInvestor();
    const raY = await makeReceiveAccountForInvestor(bank.id, invY.id);
    const roomB = await makeChatRoom({ type: 'GROUP', name: 'ĐL B' });
    const tidQr = await makeTid({ partnerId: partner.id, bankId: bank.id, hkdName: uniq('HKD QR ') });
    await patchTidRaw(tidQr.id, { kind: 'QR', receiveAccountId: raY });
    const rq = await createQrTransactionSystem(db, { tidId: tidQr.id, amount: 10_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: moc(12), dealerRoomId: roomB.id });
    expect(rq.ok).toBe(true);

    // ── HOÀN POS/CK cho ĐL A = 500.000 (tin isDealerRefundCk, billDate trong kỳ). QR hoàn ĐL B tính TỪ GD (dưới). ──
    const bot = await makeAgent();
    await db.chatMessage.create({ data: { roomId: roomA.id, senderId: bot.id, kind: 'IMAGE', body: 'hoàn CK', metadataJson: JSON.stringify({ isTransferRefund: true, isDealerRefundCk: true, refundAmount: 500_000, ckTxnKey: `ck|ref|${uniq('K')}`, billDate: ngayHCM(moc(1)) }) } });
    // Hoàn CK NGOÀI kỳ (billDate 2026-09-12) → phải bị loại.
    await db.chatMessage.create({ data: { roomId: roomA.id, senderId: bot.id, kind: 'IMAGE', body: 'hoàn ngoài kỳ', metadataJson: JSON.stringify({ isDealerRefundCk: true, refundAmount: 1_111, ckTxnKey: `ck|ref|${uniq('K')}`, billDate: ngayHCM(moc(49)) }) } });

    const rep = await buildAlphaAggregate(from, to);

    // ── byInvestor: X = POS 5tr / QR 0 / hoàn 0 (POS không trộn) ; Y = QR 10tr / hoàn NĐT = 10tr − revenuePartner(85k) = 9.915.000 ──
    const rowX = rep.byInvestor.find((r) => r.investorId === invX.id)!;
    const rowY = rep.byInvestor.find((r) => r.investorId === invY.id)!;
    expect(rowX.doanhSoPos).toBe(5_000_000); expect(rowX.doanhSoQr).toBe(0); expect(rowX.tong).toBe(5_000_000); expect(rowX.hoan).toBe(0);
    expect(rowY.doanhSoPos).toBe(0); expect(rowY.doanhSoQr).toBe(10_000_000); expect(rowY.tong).toBe(10_000_000);
    expect(rowY.hoan).toBe(9_915_000); // NĐT trả SigMa = số quẹt − giá mua (amount − revenue_partner)

    // ── byDealer: A = POS 5tr / hoàn CK 500k ; B = QR 10tr / hoàn = 10tr − revenueAmount(105k) = 9.895.000 (từ GD, không parse tin) ──
    const dA = rep.byDealer.find((r) => r.dealerId === roomA.id)!;
    const dB = rep.byDealer.find((r) => r.dealerId === roomB.id)!;
    expect(dA.doanhSoPos).toBe(5_000_000); expect(dA.doanhSoQr).toBe(0);
    expect(dA.hoan).toBe(500_000); // hoàn CK trong kỳ; ngoài kỳ (1.111) bị loại
    expect(dB.doanhSoPos).toBe(0); expect(dB.doanhSoQr).toBe(10_000_000);
    expect(dB.hoan).toBe(9_895_000); // SigMa hoàn đại lý QR = số quẹt − phí bán

    // ── totals: POS 5tr, QR 10tr, tổng 15tr; biên ngoài (999) bị loại; hoàn TÁCH đại lý/NĐT ──
    expect(rep.totals.doanhSoPos).toBe(5_000_000);
    expect(rep.totals.doanhSoQr).toBe(10_000_000);
    expect(rep.totals.tongDoanhSo).toBe(15_000_000);
    expect(rep.totals.tongHoanDaiLy).toBe(10_395_000); // 500k (A) + 9.895.000 (B)
    expect(rep.totals.tongHoanNDT).toBe(9_915_000);     // Y
  });
});
