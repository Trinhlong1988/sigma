// [Admin Demo 11/9 — 2 mã QR CÙNG TÊN (Trà My cũ/mới)] reviewQr PHÂN MÃ bằng BÁO-CÓ per-VA (cache digistore_baoco
// source_tid_id). 2 CHIỀU: khớp DUY NHẤT 1 mã → tự nhận + cờ ℹ; 0 khớp → kiểm tay; ≥2 khớp → kiểm tay.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { reviewQr } from '../src/ocr-send-service.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function make2SameName(): Promise<{ hkd: string; idA: number; idB: number }> {
  const db = getBotDb();
  const hkd = `HKD SONG SINH ${uniq('X').slice(0, 10)}`;
  const bank = await db.bank.create({ data: { name: uniq('BK'), code: uniq('B').slice(0, 18) } });
  const a = await db.tid.create({ data: { tid: uniq('QRA-').slice(0, 24), hkdName: hkd, bankId: bank.id } });
  const b = await db.tid.create({ data: { tid: uniq('QRB-').slice(0, 24), hkdName: hkd, bankId: bank.id } });
  await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = ANY($1::int[])`, [a.id, b.id]);
  return { hkd, idA: a.id, idB: b.id };
}
async function ghiBaoCo(tidId: number, amount: number, atMs: number): Promise<void> {
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO digistore_baoco (bill_id, qr_code, hkd_name, amount, payer_name, external_ref_no, description, at_ms, status, source_tid_id, fetched_at)
     VALUES ($1, 'QR', 'X', $2, 'NG QUET', $3, 'd', $4, 'success', $5, now())`,
    uniq('BILL'), amount, uniq('REF'), atMs, tidId);
}
const qrBill = (hkd: string, amount: number, d: Date): { hkdName: string; ref: string; amount: number; date: string; time: string } => ({
  hkdName: hkd, ref: uniq('R').slice(0, 14), amount,
  date: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`,
  time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`
});

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('reviewQr — phân mã 2-cùng-tên bằng báo-có', () => {
  it('CHIỀU ĐÚNG: báo-có (tiền+giờ ±10 phút) chỉ khớp mã B → tự nhận mã B + cờ ℹ, hết blocked vì mơ hồ', async () => {
    const db = getBotDb();
    const { hkd, idB } = await make2SameName();
    const at = new Date(Date.now() - 3600_000);
    await ghiBaoCo(idB, 2_345_000, at.getTime() + 2 * 60_000); // báo-có VA của mã B, lệch 2'
    const [it1] = await reviewQr(db, [qrBill(hkd, 2_345_000, at)] as never, new Date(), [], null);
    expect((it1 as { tidId: number | null }).tidId).toBe(idB);
    expect((it1 as { warnings: string[] }).warnings.some((w) => w.includes('theo BÁO-CÓ'))).toBe(true);
    expect((it1 as { warnings: string[] }).warnings.some((w) => w.includes('không xác định được mã'))).toBe(false);
  });
  it('CHIỀU SAI (0 khớp): không báo-có nào → giữ kiểm tay (tidId null)', async () => {
    const db = getBotDb();
    const { hkd } = await make2SameName();
    const [it1] = await reviewQr(db, [qrBill(hkd, 3_456_000, new Date(Date.now() - 3600_000))] as never, new Date(), [], null);
    expect((it1 as { tidId: number | null }).tidId).toBeNull();
    expect((it1 as { warnings: string[] }).warnings.some((w) => w.includes('không xác định được mã'))).toBe(true);
  });
  it('CHIỀU SAI (≥2 khớp): cả 2 VA cùng có món trùng tiền+giờ → kiểm tay, KHÔNG chọn bừa', async () => {
    const db = getBotDb();
    const { hkd, idA, idB } = await make2SameName();
    const at = new Date(Date.now() - 3600_000);
    await ghiBaoCo(idA, 4_567_000, at.getTime() + 60_000);
    await ghiBaoCo(idB, 4_567_000, at.getTime() - 60_000);
    const [it1] = await reviewQr(db, [qrBill(hkd, 4_567_000, at)] as never, new Date(), [], null);
    expect((it1 as { tidId: number | null }).tidId).toBeNull();
    expect((it1 as { warnings: string[] }).warnings.some((w) => w.includes('cùng khớp tiền+giờ') || w.includes('không xác định được mã'))).toBe(true);
  });
  it('CHIỀU SAI (ngoài cửa sổ ±10 phút): báo-có lệch 30 phút → không nhận', async () => {
    const db = getBotDb();
    const { hkd, idB } = await make2SameName();
    const at = new Date(Date.now() - 3600_000);
    await ghiBaoCo(idB, 5_678_000, at.getTime() + 30 * 60_000);
    const [it1] = await reviewQr(db, [qrBill(hkd, 5_678_000, at)] as never, new Date(), [], null);
    expect((it1 as { tidId: number | null }).tidId).toBeNull();
  });
});


describe('[Admin Demo 12/9 "quét QR lỗi hệ thống"] tên bill DƯ ĐỊA DANH + 2 mã cùng tên — cấm 500', () => {
  it('bill "X HA NOI" (fuzzy tiền tố) + 2 mã tên "X" + báo-có khớp 1 mã → NHẬN mã, KHÔNG TypeError', async () => {
    const db = getBotDb();
    const { hkd, idB } = await make2SameName();
    const at = new Date(Date.now() - 3600_000);
    await ghiBaoCo(idB, 4_444_000, at.getTime() + 60_000);
    // repro crash cũ: hkdName bill = tên mã + đuôi địa danh → exact miss → fuzzy khớp key "X" (2 mã) → phân mã
    // → dòng thông điệp cũ tra byHkd.get(key-gốc-dư-địa-danh)! → TypeError reading 'length' → 500 cả lượt quét.
    const [r] = await reviewQr(db, [qrBill(`${hkd} HA NOI CN2`, 4_444_000, at)] as never, new Date(), [], null);
    expect((r as { tidId: number | null }).tidId).toBe(idB);
    expect((r as { warnings: string[] }).warnings.some((w) => w.includes('đã NHẬN mã'))).toBe(true);
  });
});
