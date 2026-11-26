// [Admin Demo 11/9 "up ảnh Thủ công bị báo không khớp mã"] reviewQr CỨU mã khi OCR đọc TÊN HKD CẮT/MỜ (prod:
// "KHACH HANG 25" thay vì "NGUYỄN TRÀ MY"): exact + fuzzy trượt → tra BÁO-CÓ theo SỐ GIAO DỊCH (exact) hoặc
// tiền+giờ ±10' khớp DUY NHẤT 1 mã → tự nhận + cờ ℹ. 0 khớp → giữ cảnh báo kiểm tay (không đoán).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { reviewQr } from '../src/ocr-send-service.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function makeQrTid(hkd: string): Promise<number> {
  const db = getBotDb();
  const bank = await db.bank.create({ data: { name: uniq('BK'), code: uniq('B').slice(0, 18) } });
  const t = await db.tid.create({ data: { tid: uniq('QRC-').slice(0, 24), hkdName: hkd, bankId: bank.id } });
  await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, t.id);
  return t.id;
}
async function ghiBaoCo(tidId: number, amount: number, atMs: number, ref: string): Promise<void> {
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO digistore_baoco (bill_id, qr_code, hkd_name, amount, payer_name, external_ref_no, description, at_ms, status, source_tid_id, fetched_at)
     VALUES ($1, 'QR', 'X', $2, 'NG QUET', $3, 'd', $4, 'success', $5, now())`,
    uniq('BILL'), amount, ref, atMs, tidId);
}
const bill = (hkdCut: string, ref: string, amount: number, d: Date): unknown => ({
  hkdName: hkdCut, ref, amount,
  date: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`,
  time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`
});

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('reviewQr — cứu mã khi tên HKD đọc cắt/mờ (báo-có)', () => {
  it('SỐ GIAO DỊCH khớp exact báo-có → nhận đúng mã + cờ ℹ (tên cắt không giống tên mã)', async () => {
    const db = getBotDb();
    const id = await makeQrTid(`HKD DAY DU ${uniq('X')}`);
    const at = new Date(Date.now() - 3600_000);
    const ref = uniq('REFCUT').slice(0, 18);
    await ghiBaoCo(id, 4_997_000, at.getTime() + 60_000, ref);
    const [r] = await reviewQr(db, [bill('HO KINH DOANH - TEN CAT XYZQ', ref, 4_997_000, at)] as never, new Date(), [], null);
    expect((r as { tidId: number | null }).tidId).toBe(id);
    expect((r as { warnings: string[] }).warnings.some((w) => w.includes('đọc cắt/mờ'))).toBe(true);
  });
  it('không ref khớp nhưng tiền+giờ ±10 phút khớp DUY NHẤT 1 mã → nhận mã đó', async () => {
    const db = getBotDb();
    const id = await makeQrTid(`HKD DAY DU ${uniq('Y')}`);
    const at = new Date(Date.now() - 3600_000);
    await ghiBaoCo(id, 5_998_000, at.getTime() + 3 * 60_000, uniq('REFK').slice(0, 18));
    const [r] = await reviewQr(db, [bill('HO KINH DOANH - TEN CAT ABCW', uniq('NOREF').slice(0, 14), 5_998_000, at)] as never, new Date(), [], null);
    expect((r as { tidId: number | null }).tidId).toBe(id);
    expect((r as { warnings: string[] }).warnings.some((w) => w.includes('đọc cắt/mờ'))).toBe(true);
  });
  it('0 khớp báo-có → giữ kiểm tay (tidId null + cảnh báo không tìm thấy mã)', async () => {
    const db = getBotDb();
    await makeQrTid(`HKD DAY DU ${uniq('Z')}`);
    const [r] = await reviewQr(db, [bill('HO KINH DOANH - TEN CAT KHONG AI', uniq('NOHIT').slice(0, 14), 6_999_123, new Date(Date.now() - 3600_000))] as never, new Date(), [], null);
    expect((r as { tidId: number | null }).tidId).toBeNull();
    expect((r as { warnings: string[] }).warnings.some((w) => w.includes('Không tìm thấy MÃ QR'))).toBe(true);
  });
});
