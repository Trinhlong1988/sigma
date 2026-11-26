// [Agent-4 phản biện 11/9 — SỐ TIỀN DẠNG TEXT CÓ DẤU CHẤM NGĂN NGHÌN BỊ NUỐT CÂM] parseMbStatement dùng num():
// strip [^\d.-] rồi Number() → "1.234.567" (cell TEXT kiểu VN, gặp ở bản export/print-to-excel) GIỮ 2 dấu chấm
// → Number("1.234.567") = NaN → 0 → debit=credit=0 → DÒNG GD BỊ VỨT KHỎI DANH SÁCH KHÔNG MỘT CẢNH BÁO (mất tiền
// trong đối soát, lớp bug R198 nuốt câm). Test dựng xlsx thật bằng ExcelJS: cell tiền là CHUỖI "1.234.567".
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseMbStatement } from '../src/statement-recon.js';

async function buildXlsx(rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const HEADER = ['Thời gian giao dịch', 'Mã Tham Chiếu', 'Phát Sinh Nợ', 'Phát Sinh Có', 'Nội Dung', 'Tên Tài Khoản Đối Ứng', 'TK Đối Ứng', 'Ngân Hàng Đối Ứng'];

describe('parseMbStatement — số tiền cell TEXT kiểu VN (dấu chấm ngăn nghìn) không được nuốt câm', () => {
  it('debit "1.234.567" (text) → GD phải được nạp với debit=1234567 (trước fix: dòng biến mất)', async () => {
    const buf = await buildXlsx([
      ['Ngân hàng TMCP Quân Đội'],
      ['Số tài khoản: DEMO-ACCT'],
      HEADER,
      ['07/09/2026 10:15', 'FT26250TEST1', '1.234.567', null, 'HOAN TIEN DL', 'KHACH HANG 33', '112233', 'MB']
    ]);
    const p = await parseMbStatement(buf);
    const t = p.txns.find((x) => x.ref === 'FT26250TEST1');
    expect(t, 'GD bị vứt câm — num("1.234.567") phải ra 1234567, không phải 0').toBeDefined();
    expect(t!.debit).toBe(1_234_567);
    expect(t!.credit).toBe(0);
    // [Agent-4 11/9] nhãn viết tắt "TK Đối Ứng" (đúng mô tả định dạng MB đầu file statement-recon.ts) phải map
    // được cột STK đối ứng — thiếu là mất khớp theo STK (matchType 'account') mà không ai hay.
    expect(t!.cpAccount).toBe('112233');
  });

  it('credit "12.000.000" (text) + debit số thuần vẫn đúng (không phá hành vi cũ)', async () => {
    const buf = await buildXlsx([
      ['Ngân hàng TMCP Quân Đội'],
      ['Số tài khoản: DEMO-ACCT'],
      HEADER,
      ['07/09/2026 11:00', 'FT26250TEST2', null, '12.000.000', 'KHACH HANG 02 CHUYEN KHOAN', 'KHACH HANG 02', '99999999', 'MB'],
      ['07/09/2026 12:00', 'FT26250TEST3', 500000, null, 'HOAN', 'AI DO', '5555', 'MB']
    ]);
    const p = await parseMbStatement(buf);
    const t2 = p.txns.find((x) => x.ref === 'FT26250TEST2');
    const t3 = p.txns.find((x) => x.ref === 'FT26250TEST3');
    expect(t2?.credit).toBe(12_000_000);
    expect(t3?.debit).toBe(500_000);
  });

  it('kiểu Anh-Mỹ "1,234,567.89" và thập phân đơn "123.45" giữ ngữ nghĩa decimal (round)', async () => {
    const buf = await buildXlsx([
      ['Ngân hàng TMCP Quân Đội'],
      ['Số tài khoản: DEMO-ACCT'],
      HEADER,
      ['07/09/2026 13:00', 'FT26250TEST4', '1,234,567.89', null, 'X', 'A', '1', 'MB'],
      ['07/09/2026 14:00', 'FT26250TEST5', '123.45', null, 'Y', 'B', '2', 'MB']
    ]);
    const p = await parseMbStatement(buf);
    expect(p.txns.find((x) => x.ref === 'FT26250TEST4')?.debit).toBe(1_234_568);
    expect(p.txns.find((x) => x.ref === 'FT26250TEST5')?.debit).toBe(123); // "123.45" 2 số lẻ = decimal thật (hành vi cũ giữ nguyên)
  });
});
