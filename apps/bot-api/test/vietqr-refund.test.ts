// [Admin Demo 16/9 — VietQR hoàn đại lý] Test đường thật DB: (1) làm tròn XUỐNG nghìn ("999đ tròn dưới, không tròn
// trên"); (2) markRefundDone fail-closed — bill CHƯA đối soát tay không được đánh ĐÃ HOÀN (xanh phải đủ 2 bước);
// (3) đánh hoàn đúng → cờ refund_done + sổ đợt qr_refund_batch.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { lamTronNghinXuong, markRefundDone } from '../src/routes/digistore.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('lamTronNghinXuong — đơn vị', () => {
  it('999đ lẻ → bỏ (tròn XUỐNG), không tròn lên', () => {
    expect(lamTronNghinXuong(20_689_020)).toBe(20_689_000);
    expect(lamTronNghinXuong(20_689_999)).toBe(20_689_000);
    expect(lamTronNghinXuong(1_999)).toBe(1_000);
    expect(lamTronNghinXuong(999)).toBe(0);
    expect(lamTronNghinXuong(0)).toBe(0);
    expect(lamTronNghinXuong(-5)).toBe(0);
  });
});

describe('markRefundDone — đường thật DB', () => {
  it('[FAIL-CLOSED] có 1 bill CHƯA đối soát trong đợt → CHẶN cả đợt, không ghi gì', async () => {
    const db = getBotDb();
    const b1 = uniq('vqr-ds-'), b2 = uniq('vqr-chua-');
    await db.$executeRawUnsafe(`INSERT INTO qr_baoco_recon (bill_id, dealer, ds) VALUES ($1, 'Test ĐL', true)`, b1);
    await db.$executeRawUnsafe(`INSERT INTO qr_baoco_recon (bill_id, dealer, ds) VALUES ($1, 'Test ĐL', false)`, b2); // chưa đối soát
    const r = await markRefundDone(db, [b1, b2], 'Test ĐL', 1_000_000, null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe('NOT_RECONCILED');
    const rows = await db.$queryRawUnsafe<Array<{ refund_done: boolean }>>(`SELECT refund_done FROM qr_baoco_recon WHERE bill_id = $1`, b1);
    expect(rows[0].refund_done).toBe(false); // bill hợp lệ cũng KHÔNG được đánh khi đợt fail
  });
  it('đợt toàn bill đã đối soát → refund_done=true + refunded_at + sổ đợt ghi đúng tiền/danh sách', async () => {
    const db = getBotDb();
    const b1 = uniq('vqr-ok1-'), b2 = uniq('vqr-ok2-');
    await db.$executeRawUnsafe(`INSERT INTO qr_baoco_recon (bill_id, dealer, ds) VALUES ($1, 'Test ĐL', true)`, b1);
    await db.$executeRawUnsafe(`INSERT INTO qr_baoco_recon (bill_id, dealer, ds) VALUES ($1, 'Test ĐL', true)`, b2);
    const dealer = uniq('ĐL-VQR-');
    const r = await markRefundDone(db, [b1, b2], dealer, 67_000_000, 22);
    expect(r.ok).toBe(true);
    const rows = await db.$queryRawUnsafe<Array<{ refund_done: boolean; refunded_at: Date | null }>>(
      `SELECT refund_done, refunded_at FROM qr_baoco_recon WHERE bill_id = ANY($1) ORDER BY bill_id`, [b1, b2]);
    expect(rows.every((x) => x.refund_done && x.refunded_at != null)).toBe(true);
    const batch = await db.$queryRawUnsafe<Array<{ amount: bigint; bill_ids: unknown; by_agent: number | null }>>(
      `SELECT amount, bill_ids, by_agent FROM qr_refund_batch WHERE dealer = $1`, dealer);
    expect(batch.length).toBe(1);
    expect(Number(batch[0].amount)).toBe(67_000_000);
    expect(batch[0].by_agent).toBe(22);
    expect(JSON.stringify(batch[0].bill_ids)).toContain(b1);
  });
});

describe('markLotRefundDone — lô POS (đường thật DB)', () => {
  it('[FAIL-CLOSED] lô chưa đối soát trong đợt → chặn cả đợt; đủ đối soát → cờ + sổ đợt lot:*', async () => {
    const db = getBotDb();
    const { markLotRefundDone } = await import('../src/routes/digistore.js');
    const l1 = Math.floor(Math.random() * 1e9) + 1e9, l2 = l1 + 1;
    await db.$executeRawUnsafe(`INSERT INTO pos_lot_recon (lot_id, ds) VALUES ($1, true)`, l1);
    await db.$executeRawUnsafe(`INSERT INTO pos_lot_recon (lot_id, ds) VALUES ($1, false)`, l2);
    const r1 = await markLotRefundDone(db, [l1, l2], 'Test ĐL Lô', 5_000_000, null);
    expect(r1.ok).toBe(false);
    const r2 = await markLotRefundDone(db, [l1], 'Test ĐL Lô', 5_000_000, 22);
    expect(r2.ok).toBe(true);
    const chk: any[] = await db.$queryRawUnsafe(`SELECT refund_done FROM pos_lot_recon WHERE lot_id = $1`, l1);
    expect(chk[0].refund_done).toBe(true);
    const batch: any[] = await db.$queryRawUnsafe(`SELECT bill_ids FROM qr_refund_batch WHERE dealer = 'Test ĐL Lô' ORDER BY id DESC LIMIT 1`);
    expect(JSON.stringify(batch[0].bill_ids)).toContain('lot:' + l1);
  });
});
