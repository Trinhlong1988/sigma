// Test HÀNH VI HỌC "NGÂN HÀNG NGƯỜI GỬI" bill CK (Admin Demo 2/9) — hàm THUẦN (path tường minh), KHÔNG cần DB.
// Khẳng định: khớp ACCOUNT ưu tiên NAME; last-wins (khai lại đè cũ); chuẩn hoá (space/*/dấu/hoa-thường); miss→null.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordSenderBankAliasAt, lookupSenderBankAt, loadSenderBankAliases, normBank
} from '../src/sender-bank-alias.js';

let p: string;
beforeEach(() => { p = join(mkdtempSync(join(tmpdir(), 'sbank-')), 'sender-bank-alias.jsonl'); });

describe('sender-bank-alias — record/lookup hành vi', () => {
  it('file chưa có → lookup null, load rỗng', () => {
    expect(loadSenderBankAliases(p)).toHaveLength(0);
    expect(lookupSenderBankAt(p, { account: '0900000600', name: 'KHACH HANG 01' })).toBeNull();
  });

  it('học theo STK + tên → tra được cả 2 đường; bank chuẩn hoá UPPER', () => {
    const r = recordSenderBankAliasAt(p, { account: '0977 422 622', name: 'Nhân viên B', bank: 'mb' });
    expect(r.ok).toBe(true);
    expect(lookupSenderBankAt(p, { account: '0900000600' })).toBe('MB'); // space chuẩn hoá + UPPER
    expect(lookupSenderBankAt(p, { name: 'ke toan demo' })).toBe('MB'); // bỏ dấu + hoa-thường
  });

  it('ƯU TIÊN khớp ACCOUNT hơn NAME (khi 2 alias trỏ bank KHÁC nhau)', () => {
    recordSenderBankAliasAt(p, { account: '1234567', bank: 'VP' });     // acct → VP
    recordSenderBankAliasAt(p, { name: 'NGUYEN VAN A', bank: 'ACB' });  // name → ACB
    // có cả STK (khớp acct VP) lẫn tên (khớp name ACB) → ưu tiên ACCOUNT = VP.
    expect(lookupSenderBankAt(p, { account: '1234567', name: 'NGUYEN VAN A' })).toBe('VP');
    // chỉ có tên → rơi về NAME = ACB.
    expect(lookupSenderBankAt(p, { name: 'Nguyen Van A' })).toBe('ACB');
  });

  it('LAST-WINS: khai lại cùng người gửi → đè bank cũ', () => {
    recordSenderBankAliasAt(p, { account: '9990001', bank: 'MB' });
    recordSenderBankAliasAt(p, { account: '9990001', bank: 'VCB' }); // sửa
    expect(lookupSenderBankAt(p, { account: '9990001' })).toBe('VCB');
    // load gộp last-wins → chỉ 1 entry acct cho key này.
    expect(loadSenderBankAliases(p).filter((e) => e.kind === 'acct' && e.key === '9990001')).toHaveLength(1);
  });

  it('MISS: người gửi chưa học → null', () => {
    recordSenderBankAliasAt(p, { account: '111', bank: 'MB' });
    expect(lookupSenderBankAt(p, { account: '222', name: 'AI DO' })).toBeNull();
  });

  it('bank RỖNG → không ghi (ok=false); thiếu CẢ account+name → không ghi', () => {
    expect(recordSenderBankAliasAt(p, { account: '333', bank: '   ' }).ok).toBe(false);
    expect(recordSenderBankAliasAt(p, { account: null, name: null, bank: 'MB' }).ok).toBe(false);
    expect(loadSenderBankAliases(p)).toHaveLength(0);
  });

  it('STK che dấu * → chuẩn hoá bỏ * khi tra (khớp lúc học STK đầy đủ theo tên)', () => {
    recordSenderBankAliasAt(p, { name: 'LE THI B', bank: 'tcb' });
    // STK OCR che (*) không khớp acct nào → rơi về NAME.
    expect(lookupSenderBankAt(p, { account: '****1234', name: 'Lê Thị B' })).toBe('TCB');
  });

  it('normBank: trim + UPPER + gộp space', () => {
    expect(normBank('  vp  bank ')).toBe('VP BANK');
    expect(normBank(null)).toBe('');
  });
});
