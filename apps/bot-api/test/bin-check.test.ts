// [Admin Demo 12/9] Thư viện BIN — kiểm chứng: detect hãng theo prefix (chuẩn công khai), lookup ưu tiên BIN dài,
// upsert bổ sung thư viện, seed idempotent, route SigMa-only (403 đại lý thường).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { detectBrand, normalizeBin, lookupBin, upsertBinEntry, seedBinLibrary } from '../src/bin-check.js';

const uniq6 = (): string => String(300000 + Math.floor(Math.random() * 99999)).slice(0, 6);

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); await seedBinLibrary(getBotDb()); });

describe('detectBrand — quy tắc prefix công khai', () => {
  it('nhận đúng hãng phổ biến', () => {
    expect(detectBrand('970422')).toContain('NAPAS');
    expect(detectBrand('423801')).toBe('Visa');
    expect(detectBrand('512345')).toBe('Mastercard');
    expect(detectBrand('222100')).toBe('Mastercard');
    expect(detectBrand('272099')).toBe('Mastercard');
    expect(detectBrand('352812')).toBe('JCB');
    expect(detectBrand('371234')).toBe('American Express');
    expect(detectBrand('621234')).toBe('UnionPay');
    expect(detectBrand('999999')).toBeNull();
  });
  it('normalizeBin: lọc rác, đòi ≥6 số, cắt 8', () => {
    expect(normalizeBin('9704 22')).toBe('970422');
    expect(normalizeBin('4238-0112-33')).toBe('42380112');
    expect(normalizeBin('12345')).toBeNull();
  });
});

describe('lookup + thư viện', () => {
  it('seed NAPAS tra ra đúng ngân hàng (970422 = MB Bank, 970441 = VIB)', async () => {
    const db = getBotDb();
    const mb = await lookupBin(db, '970422');
    expect(mb?.bankName).toBe('MB Bank');
    expect(mb?.source).toBe('LIBRARY');
    const vib = await lookupBin(db, '970441123');
    expect(vib?.bankName).toBe('VIB');
  });
  it('BIN chưa có thư viện → trả hãng theo RULE, bankName null; bổ sung xong → LIBRARY', async () => {
    const db = getBotDb();
    const bin = `4${uniq6().slice(1)}`; // Visa lạ
    const truoc = await lookupBin(db, bin);
    expect(truoc?.source).toBe('RULE');
    expect(truoc?.brand).toBe('Visa');
    expect(truoc?.bankName).toBeNull();
    const up = await upsertBinEntry(db, { bin, bankName: 'VIB', cardType: 'Tín dụng', note: 'test' });
    expect(up.ok).toBe(true);
    const sau = await lookupBin(db, bin);
    expect(sau?.bankName).toBe('VIB');
    expect(sau?.source).toBe('LIBRARY');
    await db.$executeRawUnsafe(`UPDATE bin_library SET deleted_at = now() WHERE bin = $1`, bin);
  });
  it('BIN 8 số cụ thể ĐÈ BIN 6 số gộp', async () => {
    const db = getBotDb();
    const b6 = `5${uniq6().slice(1)}`;
    const b8 = `${b6}12`;
    await upsertBinEntry(db, { bin: b6, bankName: 'BANK GỘP' });
    await upsertBinEntry(db, { bin: b8, bankName: 'BANK CỤ THỂ' });
    const r = await lookupBin(db, `${b8}3456`);
    expect(r?.bankName).toBe('BANK CỤ THỂ');
    await db.$executeRawUnsafe(`UPDATE bin_library SET deleted_at = now() WHERE bin IN ($1, $2)`, b6, b8);
  });
  it('seed idempotent: chạy lại = 0 thêm', async () => {
    expect(await seedBinLibrary(getBotDb())).toBe(0);
  });
});
