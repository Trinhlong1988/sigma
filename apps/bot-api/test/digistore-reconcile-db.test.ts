// ĐỐI SOÁT "BÁO CÓ" DIGISTORE — test ĐƯỜNG PROD trên throwaway Postgres (R198: khẳng định TỪNG câu raw SQL chạy
// được trên engine THẬT — CREATE TABLE/UPSERT ON CONFLICT/UPDATE/queryRaw ANY/to_timestamp — không câu nào lệch
// cú pháp bị nuốt). Khẳng định:
//  (a) ensureAlphaExtraSchema tạo digistore_baoco (idempotent — gọi lại no-op);
//  (b) upsertBaoCoRows UPSERT theo bill_id (poll lại KHÔNG nhân đôi + cập nhật amount);
//  (c) UPSERT GIỮ reconcile_status/matched_bill_key cũ (không ghi đè khi poll lại raw);
//  (d) listRecordedQrBillsFromDb đọc đúng bill QR (transactions kind='QR') trong cửa sổ giờ;
//  (e) runBaoCoPoll end-to-end với adapter DB THẬT (mock fetch) → ghi reconcile MATCHED + matched_bill_key = mã GD.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import {
  upsertBaoCoRows,
  markBaoCoReconcile,
  readBaoCoReconcileStatuses,
  listRecordedQrBillsFromDb,
  runBaoCoPoll,
  type BaoCoPollDeps
} from '../src/digistore-reconcile.js';
import type { BaoCoTxn } from '../src/digistore-adapter.js';
import { makePartner, makeTid } from './fixtures.js';

const AT = Date.parse('2026-09-05T14:30:00+07:00');
const uniqId = (): string => 'BILL-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

function baoco(over: Partial<BaoCoTxn> = {}): BaoCoTxn {
  return {
    billId: over.billId ?? uniqId(),
    qrCode: over.qrCode ?? '99MPC001',
    hkdName: over.hkdName ?? 'HKD DEMO 40',
    amount: over.amount ?? 9_198_000,
    payerName: over.payerName ?? 'KHACH HANG 08',
    externalRefNo: over.externalRefNo ?? null,
    description: over.description ?? 'KHACH HANG 08 thanh toan QR',
    atMs: over.atMs ?? AT,
    status: over.status ?? 'Đã báo có',
    sourceTidId: over.sourceTidId ?? null,
    raw: undefined
  };
}

beforeAll(async () => {
  await ensureAlphaExtraSchema(getBotDb());
  await ensureAlphaExtraSchema(getBotDb()); // (a) idempotent — gọi lại không lỗi.
});

describe('digistore_baoco — cache adapter (raw SQL trên Postgres thật)', () => {
  it('(b)(c) UPSERT theo bill_id: không nhân đôi, cập nhật amount, GIỮ reconcile cũ', async () => {
    const db = getBotDb();
    const id = uniqId();
    await upsertBaoCoRows(db, [baoco({ billId: id, amount: 1_000_000 })]);
    await markBaoCoReconcile(db, id, 'MATCHED', 'GD00099'); // gán reconcile trước

    // poll lại cùng bill_id, amount đổi → UPSERT cập nhật amount, GIỮ reconcile_status cũ.
    await upsertBaoCoRows(db, [baoco({ billId: id, amount: 2_000_000 })]);

    const rows = (await db.$queryRawUnsafe(
      `SELECT amount, reconcile_status AS "rs", matched_bill_key AS "mk" FROM digistore_baoco WHERE bill_id = $1`,
      id
    )) as Array<{ amount: bigint; rs: string | null; mk: string | null }>;
    expect(rows).toHaveLength(1); // không nhân đôi
    expect(Number(rows[0].amount)).toBe(2_000_000); // amount cập nhật
    expect(rows[0].rs).toBe('MATCHED'); // reconcile GIỮ nguyên
    expect(rows[0].mk).toBe('GD00099');
  });

  it('readBaoCoReconcileStatuses đọc đúng theo ANY($1)', async () => {
    const db = getBotDb();
    const id = uniqId();
    await upsertBaoCoRows(db, [baoco({ billId: id })]);
    await markBaoCoReconcile(db, id, 'UNRECONCILED', null);
    const m = await readBaoCoReconcileStatuses(db, [id, 'khong-ton-tai']);
    expect(m.get(id)).toBe('UNRECONCILED');
    expect(m.has('khong-ton-tai')).toBe(false);
  });

  it('(d) listRecordedQrBillsFromDb: chỉ bill QR (kind=QR) trong cửa sổ giờ', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const qrTid = await makeTid({ partnerId: partner.id, hkdName: 'HKD DEMO 40' });
    await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, qrTid.id);
    const posTid = await makeTid({ partnerId: partner.id, hkdName: 'HKD POS KHAC' }); // kind mặc định POS

    const gd = await db.transaction.create({ data: { code: 'GD' + uniqId().slice(-8), tidId: qrTid.id, amount: 9_198_000n, txnDate: new Date(AT) } });
    await db.$executeRawUnsafe(`UPDATE transactions SET txn_date = $1::timestamptz WHERE id = $2`, new Date(AT).toISOString(), gd.id); // [GÓI TZ] như đường thật
    // POS txn cùng giờ — KHÔNG được lọt (kind != QR).
    const gdPos = await db.transaction.create({ data: { code: 'GD' + uniqId().slice(-8), tidId: posTid.id, amount: 9_198_000n, txnDate: new Date(AT) } });
    await db.$executeRawUnsafe(`UPDATE transactions SET txn_date = $1::timestamptz WHERE id = $2`, new Date(AT).toISOString(), gdPos.id);

    const bills = await listRecordedQrBillsFromDb(db, AT - 60_000, AT + 60_000);
    const mine = bills.filter((b) => b.billKey === gd.code);
    expect(mine).toHaveLength(1);
    expect(mine[0].hkdName).toBe('HKD DEMO 40');
    expect(mine[0].amount).toBe(9_198_000);
    expect(Math.abs((mine[0].atMs ?? 0) - AT)).toBeLessThan(2000);
    // POS tid KHÔNG xuất hiện.
    expect(bills.some((b) => b.hkdName === 'HKD POS KHAC')).toBe(false);
  });

  it('(e) runBaoCoPoll end-to-end (adapter DB thật + mock fetch) → reconcile MATCHED = mã GD', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const qrTid = await makeTid({ partnerId: partner.id, hkdName: 'HKD DEMO 16' });
    await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, qrTid.id);
    const at = Date.parse('2026-09-06T10:15:00+07:00');
    const gd = await db.transaction.create({ data: { code: 'GD' + uniqId().slice(-8), tidId: qrTid.id, amount: 5_555_000n, txnDate: new Date(at) } });
    await db.$executeRawUnsafe(`UPDATE transactions SET txn_date = $1::timestamptz WHERE id = $2`, new Date(at).toISOString(), gd.id); // [GÓI TZ] như đường thật

    const bcId = uniqId();
    const deps: BaoCoPollDeps = {
      fetchRecent: async () => ({
        txns: [baoco({ billId: bcId, hkdName: 'le quang dung', amount: 5_555_000, atMs: at + 20_000, sourceTidId: qrTid.id })],
        errors: [],
        configuredCount: 1
      }),
      upsertBaoCo: (txns) => upsertBaoCoRows(db, txns),
      listRecordedQrBills: (f, t) => listRecordedQrBillsFromDb(db, f, t),
      markReconcile: (id, status, key) => markBaoCoReconcile(db, id, status, key)
    };
    const r = await runBaoCoPoll(deps);
    expect(r.ok).toBe(true);
    expect(r.matched).toBeGreaterThanOrEqual(1);

    const rows = (await db.$queryRawUnsafe(
      `SELECT reconcile_status AS "rs", matched_bill_key AS "mk", source_tid_id AS "src", external_ref_no AS "ref" FROM digistore_baoco WHERE bill_id = $1`,
      bcId
    )) as Array<{ rs: string | null; mk: string | null; src: number | null; ref: string | null }>;
    expect(rows[0].rs).toBe('MATCHED');
    expect(rows[0].mk).toBe(gd.code);
    expect(Number(rows[0].src)).toBe(qrTid.id); // source_tid_id persisted
  });

  it('(g) UPSERT BACKFILL: poll lại cập nhật external_ref_no/source_tid_id/payer_name/status (dòng cũ null), GIỮ reconcile', async () => {
    const db = getBotDb();
    const id = uniqId();
    // Lần 1 — bill poll TRƯỚC khi bank trả đủ trường: external_ref_no/source/payer null, status cũ.
    await upsertBaoCoRows(db, [baoco({ billId: id, externalRefNo: null, sourceTidId: null, payerName: null, status: 'success' })]);
    await markBaoCoReconcile(db, id, 'MATCHED', 'GD00123'); // reconcile đã gán từ lượt trước
    // Lần 2 — poll lại, bank NAY trả đủ: 4 cột raw PHẢI backfill; reconcile_status/matched_bill_key GIỮ nguyên.
    await upsertBaoCoRows(db, [baoco({ billId: id, externalRefNo: '6248VNIB999', sourceTidId: 555, payerName: 'NGUYEN VAN B', status: 'Đã báo có' })]);
    const rows = (await db.$queryRawUnsafe(
      `SELECT external_ref_no AS "ref", source_tid_id AS "src", payer_name AS "payer", status AS "st",
              reconcile_status AS "rs", matched_bill_key AS "mk" FROM digistore_baoco WHERE bill_id = $1`,
      id
    )) as Array<{ ref: string | null; src: number | null; payer: string | null; st: string | null; rs: string | null; mk: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].ref).toBe('6248VNIB999');       // backfilled
    expect(Number(rows[0].src)).toBe(555);          // backfilled
    expect(rows[0].payer).toBe('NGUYEN VAN B');     // backfilled
    expect(rows[0].st).toBe('Đã báo có');           // backfilled
    expect(rows[0].rs).toBe('MATCHED');             // reconcile GIỮ nguyên
    expect(rows[0].mk).toBe('GD00123');
  });

  it('(f) upsertBaoCoRows lưu source_tid_id + external_ref_no', async () => {
    const db = getBotDb();
    const id = uniqId();
    await upsertBaoCoRows(db, [baoco({ billId: id, externalRefNo: '6248VNIB024EN', sourceTidId: 777 })]);
    const rows = (await db.$queryRawUnsafe(
      `SELECT source_tid_id AS "src", external_ref_no AS "ref" FROM digistore_baoco WHERE bill_id = $1`,
      id
    )) as Array<{ src: number | null; ref: string | null }>;
    expect(Number(rows[0].src)).toBe(777);
    expect(rows[0].ref).toBe('6248VNIB024EN');
  });
});
