// [Đợt 2 — QR bán hàng] BRIDGE DOANH SỐ QR (createQrTransactionSystem) + hoàn + NĐT về. Regression THẬT trên
// throwaway Postgres. Đường tiền Admin Demo 5/9 DUYỆT: phiCaiMay=0; partnerMargin=phiMua; sellMargin=phiBan−phiMua.
// Khẳng định 5 SỐ ví dụ Admin Demo (bill 10.000.000, phiMua 850, phiBan 1050):
//   revenuePartner=85.000 · revenueSell=20.000 · revenueAmount=105.000 · NĐT về=10.000.000 · đại lý hoàn=9.895.000.
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@sigma/shared';
import { getBotDb } from '../src/db.js';
import { createQrTransactionSystem, investorReportDetail } from '@sigma/services';
import { reviewQr } from '../src/ocr-send-service.js';
import { listRecordedQrBillsFromDb, upsertBaoCoRows, markBaoCoReconcile, runBaoCoPoll, type BaoCoPollDeps } from '../src/digistore-reconcile.js';
import type { BaoCoTxn } from '../src/digistore-adapter.js';
import { makePartner, makeTid, makeBank, makeReceiveAccountSource } from './fixtures.js';

/** BaoCoTxn builder tối thiểu cho test poll ghép ref. */
function baoco(over: Partial<BaoCoTxn>): BaoCoTxn {
  return {
    billId: over.billId ?? `BILL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    qrCode: over.qrCode ?? '99MPC001', hkdName: over.hkdName ?? 'HKD X', amount: over.amount ?? 1_000_000,
    payerName: over.payerName ?? null, externalRefNo: over.externalRefNo ?? null, description: over.description ?? null,
    atMs: over.atMs ?? Date.now(), status: over.status ?? 'success', sourceTidId: over.sourceTidId ?? null, raw: undefined
  };
}

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const authUser = (permissions: string[]): AuthUser => ({ id: 42, username: 'tester', fullName: 'Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions });

async function makeQrTid(opts: { hkdName: string; partnerId: number; bankId?: number | null; receiveAccountId?: number | null }): Promise<{ id: number; tid: string }> {
  const db = getBotDb();
  const t = await makeTid({ partnerId: opts.partnerId, bankId: opts.bankId ?? null, hkdName: opts.hkdName, status: 'ACTIVE' });
  await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR'${opts.receiveAccountId != null ? ', receive_account_id = ' + Number(opts.receiveAccountId) : ''} WHERE id = $1`, t.id);
  return { id: t.id, tid: t.tid };
}
async function seedQrPartnerFee(opts: { partnerId: number; phiMuaThuong: number; phiMuaCuoiTuan: number; phiBan: number }): Promise<void> {
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO qr_partner_fee (partner_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from) VALUES ($1,$2,$3,$4,$5)`,
    opts.partnerId, opts.phiMuaThuong, opts.phiMuaCuoiTuan, opts.phiBan, new Date('2020-01-01T00:00:00Z')
  );
}

describe('QR bridge doanh số — createQrTransactionSystem (đường tiền Admin Demo 5/9)', () => {
  it('(1) 5 SỐ ví dụ 10tr: revenuePartner 85k, revenueSell 20k, revenueAmount 105k, phiCaiMay 0, cardType/feeType NULL', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const qr = await makeQrTid({ hkdName: uniq('HKD QR '), partnerId: partner.id });
    const r = await createQrTransactionSystem(db, { tidId: qr.id, amount: 10_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: new Date('2026-09-10T05:00:00Z') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tx = await db.transaction.findUniqueOrThrow({ where: { id: r.id } });
    expect(Number(tx.amount)).toBe(10_000_000);
    expect(tx.partnerMarginMilli).toBe(850);       // = phiMua
    expect(tx.sellMarginMilli).toBe(200);          // = phiBan − phiMua (SPREAD, KHÁC POS)
    expect(tx.phiCaiMayMilli).toBe(0);             // QR không phí cài máy
    expect(Number(tx.revenuePartner)).toBe(85_000);
    expect(Number(tx.revenueSell)).toBe(20_000);
    expect(Number(tx.revenueAmount)).toBe(105_000);
    expect(tx.cardTypeId).toBeNull();
    expect(tx.feeTypeId).toBeNull();
    expect(tx.status).toBe('POSTED');
  });

  it('(3) đại lý hoàn = amount − phíBán = 9.895.000 (reviewQr sellFeeAmount/refundAmount)', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const name = uniq('HKD HOAN ');
    await makeQrTid({ hkdName: name, partnerId: partner.id });
    await seedQrPartnerFee({ partnerId: partner.id, phiMuaThuong: 850, phiMuaCuoiTuan: 900, phiBan: 1050 });
    const rows = await reviewQr(db, [{ hkdName: name, amount: 10_000_000, ref: uniq('REF'), date: '10/09/2026', time: '09:00' }], new Date(), []);
    expect(rows[0].sellFeeMilli).toBe(1050);
    expect(rows[0].sellFeeAmount).toBe(105_000);      // phí bán = amount×1050/100000
    expect(rows[0].refundAmount).toBe(9_895_000);     // hoàn đại lý = amount − phíBán
    expect(rows[0].partnerFeeMilli).toBe(850);
    // [8/9 sửa test cũ] Admin Demo chốt 6/9 (mục A): NCC/mã QR hoàn = số quẹt − %GIÁ MUA (KHÔNG còn trọn amount).
    // Code đã đổi từ 6/9 nhưng test giữ kỳ vọng cũ → đỏ suốt. 10.000.000 − 0.85% = 9.915.000.
    expect(rows[0].investorReceiveAmount).toBe(9_915_000);
    expect(rows[0].blocked).toBe(false);
  });

  it('(4) cuối tuần: phiMua đổi 850→900, phiBan GIỮ 1050; bridge dùng phiMua weekend', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const name = uniq('HKD WK ');
    const qr = await makeQrTid({ hkdName: name, partnerId: partner.id });
    await seedQrPartnerFee({ partnerId: partner.id, phiMuaThuong: 850, phiMuaCuoiTuan: 900, phiBan: 1050 });
    // 12/09/2026 = thứ 7.
    const rows = await reviewQr(db, [{ hkdName: name, amount: 10_000_000, ref: uniq('REF'), date: '12/09/2026', time: '10:00' }], new Date(), []);
    expect(rows[0].isWeekend).toBe(true);
    expect(rows[0].partnerFeeMilli).toBe(900); // phí MUA đổi cuối tuần
    expect(rows[0].sellFeeMilli).toBe(1050);   // phí BÁN giữ nguyên
    // bridge với phiMua weekend → partnerMargin 900, sellMargin 150.
    const r = await createQrTransactionSystem(db, { tidId: qr.id, amount: 10_000_000, phiMuaMilli: 900, phiBanMilli: 1050, txnDate: new Date('2026-09-12T05:00:00Z') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tx = await db.transaction.findUniqueOrThrow({ where: { id: r.id } });
    expect(tx.partnerMarginMilli).toBe(900);
    expect(tx.sellMarginMilli).toBe(150);
    expect(Number(tx.revenuePartner)).toBe(90_000);
    expect(Number(tx.revenueSell)).toBe(15_000);
  });

  it('(fail-closed) spread âm (phiBan < phiMua) → QR_FEE_INVALID, KHÔNG ghi doanh số', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const qr = await makeQrTid({ hkdName: uniq('HKD NEG '), partnerId: partner.id });
    const r = await createQrTransactionSystem(db, { tidId: qr.id, amount: 1_000_000, phiMuaMilli: 1200, phiBanMilli: 1000, txnDate: new Date('2026-09-10T05:00:00Z') });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('QR_FEE_INVALID');
  });

  it('(CRITICAL regression PHẢN BIỆN) actorUserId trỏ users.id KHÔNG tồn tại → THROW (FK audit_logs→users); null → OK', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const qr = await makeQrTid({ hkdName: uniq('HKD FK '), partnerId: partner.id });
    // req.agent.id (bảng AGENTS, 3 chủ = 270/381/399) KHÔNG có trong users → nếu route truyền vào actorUserId,
    // writeAuditStrict (trong $transaction, audit-fail→throw) ném FK → doanh số THROW + reserve kẹt. Khẳng định cơ chế
    // để chặn tái diễn: actorUserId lạ PHẢI ném; route BẮT BUỘC truyền null (đường đúng cover ở test (1)).
    await expect(
      createQrTransactionSystem(db, { tidId: qr.id, amount: 1_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: new Date('2026-09-10T05:00:00Z'), actorUserId: 2_000_000_000 })
    ).rejects.toThrow();
    const ok = await createQrTransactionSystem(db, { tidId: qr.id, amount: 1_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: new Date('2026-09-10T05:00:00Z'), actorUserId: null });
    expect(ok.ok).toBe(true);
  });

  it('(5) investor-report: QR txn ĐƯỢC tính, NĐT về = amount (phiCaiMay=0), doanh thu = amount', async () => {
    const db = getBotDb();
    // [FLAG cho LEAD] investorReportDetail SELECT t.install_fee_amount — cột additive KHÔNG do migration/ensure nào tạo
    // (chỉ tồn tại ở prod do thêm tay/đường khác). Throwaway DB (migrate deploy) THIẾU → mirror prod ở đây (idempotent).
    await db.$executeRawUnsafe('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS install_fee_amount bigint');
    const bank = await makeBank();
    const partner = await makePartner();
    const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT QR', nickname: uniq('nv').slice(0, 18), status: 'ACTIVE', investFeeMilli: 0 } });
    const src = await makeReceiveAccountSource();
    const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId: bank.id, accountName: 'TK QR', accountNumber: uniq('AC').slice(0, 18), investorId: inv.id } });
    const qr = await makeQrTid({ hkdName: uniq('HKD IV '), partnerId: partner.id, bankId: bank.id, receiveAccountId: ra.id });
    const r = await createQrTransactionSystem(db, { tidId: qr.id, amount: 10_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: new Date('2026-09-10T05:00:00Z') });
    expect(r.ok).toBe(true);
    const rep = await investorReportDetail({ db, user: authUser(['REVENUE_VIEW']) }, { investorId: inv.id, from: '2026-09-01', to: '2026-09-30' });
    expect(rep.ok).toBe(true);
    if (!rep.ok || !rep.data) return;
    expect(rep.data.bills.length).toBe(1);                 // QR txn ĐƯỢC tính (LEFT JOIN los — không rớt)
    expect(rep.data.totals.truoc).toBe(10_000_000);        // doanh thu gross = amount
    expect(rep.data.totals.tienVe).toBe(10_000_000);       // NĐT về = TRỌN amount (phí cài máy 0)
    expect(rep.data.totals.sau).toBe(10_000_000);
  });

  it('(6) createQrTransactionSystem LƯU qr_ref + qr_payer_name → listRecordedQrBillsFromDb trả ref/payerName', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const qr = await makeQrTid({ hkdName: uniq('HKD REF '), partnerId: partner.id });
    const ref = uniq('REF');
    const at = new Date('2026-09-15T05:00:00Z');
    const r = await createQrTransactionSystem(db, { tidId: qr.id, amount: 3_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: at, ref, payerName: 'KHACH HANG 40' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = (await db.$queryRawUnsafe(`SELECT qr_ref AS "ref", qr_payer_name AS "payer", code FROM transactions WHERE id = $1`, r.id)) as Array<{ ref: string | null; payer: string | null; code: string }>;
    expect(rows[0].ref).toBe(ref);              // qr_ref persisted (poll ghép EXACT)
    expect(rows[0].payer).toBe('KHACH HANG 40'); // qr_payer_name persisted (nhãn báo cáo)
    const bills = await listRecordedQrBillsFromDb(db, at.getTime() - 60_000, at.getTime() + 60_000);
    const mine = bills.find((b) => b.billKey === rows[0].code);
    expect(mine?.ref).toBe(ref);
    expect(mine?.payerName).toBe('KHACH HANG 40');
  });

  it('(7) POLL ghép EXACT theo qr_ref ↔ external_ref_no — MATCHED DÙ tiền/tên lệch', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const qr = await makeQrTid({ hkdName: uniq('HKD POLLREF '), partnerId: partner.id });
    const ref = uniq('EXREF');
    const at = Date.parse('2026-09-16T10:00:00+07:00');
    const rr = await createQrTransactionSystem(db, { tidId: qr.id, amount: 5_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: new Date(at), ref, payerName: 'A' });
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;
    const gd = await db.transaction.findUniqueOrThrow({ where: { id: rr.id } });
    const bcId = uniq('BC');
    const deps: BaoCoPollDeps = {
      // Báo-có: tiền + tên KHÁC HẲN, chỉ TRÙNG Số giao dịch (external_ref_no=ref) → phải MATCHED theo ref (ưu tiên tuyệt đối).
      fetchRecent: async () => ({ txns: [baoco({ billId: bcId, hkdName: 'ten khac han', amount: 9_999_999, atMs: at + 30_000, externalRefNo: ref })], errors: [], configuredCount: 1 }),
      upsertBaoCo: (t) => upsertBaoCoRows(db, t),
      listRecordedQrBills: (f, t) => listRecordedQrBillsFromDb(db, f, t),
      markReconcile: (id, s, k) => markBaoCoReconcile(db, id, s, k)
    };
    const res = await runBaoCoPoll(deps);
    expect(res.ok).toBe(true);
    const rows = (await db.$queryRawUnsafe(`SELECT reconcile_status AS "rs", matched_bill_key AS "mk" FROM digistore_baoco WHERE bill_id = $1`, bcId)) as Array<{ rs: string | null; mk: string | null }>;
    expect(rows[0].rs).toBe('MATCHED');
    expect(rows[0].mk).toBe(gd.code); // ghép đúng GD qua ref, KHÔNG phụ thuộc tiền/giờ/tên
  });
});
