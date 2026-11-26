import { describe, expect, it } from 'vitest';
import { VIETNAM_NAPAS_BINS, lookupBankByBin, isNapasBin } from '../src/vietnam-bank-bins.js';
import { ONUS_BINS_BY_BANK } from '../src/card-classify.js';

describe('vietnam-bank-bins — thư viện BIN Napas', () => {
  it('mọi BIN đều 6 số, thuộc dải 9704, KHÔNG trùng', () => {
    const seen = new Set<string>();
    for (const e of VIETNAM_NAPAS_BINS) {
      expect(e.bin).toMatch(/^9704\d{2}$/);
      expect(isNapasBin(e.bin)).toBe(true);
      expect(seen.has(e.bin), `BIN trùng: ${e.bin}`).toBe(false);
      seen.add(e.bin);
    }
  });
  it('tra được các bank chủ chốt đúng tên', () => {
    expect(lookupBankByBin('970422')?.short).toBe('MB');
    expect(lookupBankByBin('970436')?.short).toBe('VCB');   // Vietcombank
    expect(lookupBankByBin('970415')?.short).toBe('CTG');   // VietinBank
    expect(lookupBankByBin('970418')?.short).toBe('BIDV');
    expect(lookupBankByBin('970405')?.short).toBe('AGRIBANK');
    expect(lookupBankByBin('970403')?.short).toBe('STB');   // Sacombank
    expect(lookupBankByBin('970429')?.short).toBe('SCB');   // Saigon Commercial
  });
  it('BIN lạ → null nhưng vẫn nhận là Napas nếu 9704xx', () => {
    expect(lookupBankByBin('970499')).toBeNull();
    expect(isNapasBin('970499')).toBe(true);
    expect(isNapasBin('415370')).toBe(false); // Visa
    expect(lookupBankByBin('12')).toBeNull();
  });
  it('bao phủ ≥ 50 tổ chức (thư viện "thật kỹ")', () => {
    expect(VIETNAM_NAPAS_BINS.length).toBeGreaterThanOrEqual(50);
  });
});

describe('ONUS_BINS_BY_BANK — nhất quán với thư viện (chống gõ sai)', () => {
  it('mọi BIN on-us là Napas hợp lệ + tra được trong thư viện', () => {
    for (const [bankCode, bins] of Object.entries(ONUS_BINS_BY_BANK)) {
      for (const bin of bins) {
        expect(isNapasBin(bin), `${bankCode}:${bin} không phải BIN Napas`).toBe(true);
        expect(lookupBankByBin(bin), `${bankCode}:${bin} không có trong thư viện`).not.toBeNull();
      }
    }
  });
  it('MB on-us = 970422 (đã Admin Demo xác nhận thực tế)', () => {
    expect(ONUS_BINS_BY_BANK.MB).toContain('970422');
  });
});
