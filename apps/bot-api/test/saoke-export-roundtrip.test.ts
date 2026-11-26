// [Admin Demo 13/9 "dạng file sao kê đúng định dạng"] ROUND-TRIP: file buildSaoKeXlsx xuất ra PHẢI được CHÍNH
// parseMbStatement đọc lại đủ GD, đúng chiều nợ/có, đúng số dư, đúng số TK — "đúng định dạng" kiểm bằng máy,
// không phải nhìn bằng mắt.
import { describe, it, expect } from 'vitest';
import { buildSaoKeXlsx } from '../src/saoke-export.js';
import { parseMbStatement } from '../src/statement-recon.js';

describe('sao kê xuất — round-trip qua parser MB', () => {
  it('xuất 3 GD (2 có + 1 nợ, có số dư) → parser đọc lại đủ, đúng từng cột', async () => {
    const buf = await buildSaoKeXlsx([
      { dateTime: '2026-09-12T10:10:00', ref: 'FT26255001', debit: 0, credit: 9_385_341, balance: 512_345_678, desc: 'CUSTOMER KET CHUYEN SO DU', cpName: 'MB BANK', cpAccount: null, cpBank: 'MB' },
      { dateTime: '2026-09-12T18:10:00', ref: 'FT26255002', debit: 0, credit: 476_543_701, balance: 988_889_379, desc: 'CUSTOMER KET CHUYEN SO DU', cpName: 'MB BANK', cpAccount: null, cpBank: 'MB' },
      { dateTime: '2026-09-12T19:00:00', ref: 'FT26255003', debit: 400_000_000, credit: 0, balance: 588_889_379, desc: 'KHACH HANG 02 CHUYEN TIEN', cpName: 'KHACH HANG 01', cpAccount: 'DEMO-ACCT', cpBank: 'MB' }
    ], { accountNumber: '8788688686', accountHolder: 'KHACH HANG 02', bank: 'MB', from: '2026-09-12', to: '2026-09-12' });

    const p = await parseMbStatement(buf);
    expect(p.accountNumber).toBe('8788688686');
    // [Admin Demo 14/9 "bỏ ghi nợ"] file CHỈ BÁO CÓ → dòng nợ KHÔNG xuất; tổng/số dư cuối không thành GD.
    expect(p.txns).toHaveLength(2);
    expect(p.txns[0]).toMatchObject({ credit: 9_385_341, debit: 0, balance: 512_345_678, dateTime: '2026-09-12T10:10:00' });
    expect(p.txns[1]).toMatchObject({ credit: 476_543_701, debit: 0 });
    expect(p.txns.every((t) => t.debit === 0)).toBe(true);
    expect(p.txns.every((t) => t.ref == null || t.ref === '')).toBe(true); // [14/9] BỎ cột Mã GD
    expect(p.closingBalance).toBe(988_889_379); // số dư của GD báo có cuối
  });

  it('kỳ rỗng → file vẫn hợp lệ, parser trả 0 GD (không ném)', async () => {
    const buf = await buildSaoKeXlsx([], { accountNumber: '8788688686', accountHolder: null, bank: 'MB', from: '2026-09-12', to: '2026-09-12' });
    const p = await parseMbStatement(buf);
    expect(p.txns).toHaveLength(0);
  });
});
