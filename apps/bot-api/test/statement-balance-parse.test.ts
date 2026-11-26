// [Admin Demo 12/9 — "tra soát phải có tổng số dư cuối ngày"] Parser PHẢI đọc cột "Số dư" (running balance) của sao kê
// → nguồn tính số dư cuối ngày từng TK SigMa ở khối đối chiếu tìm tiền. R198: khẳng định chạy được trên từng bố cục.
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseMbStatement } from '../src/statement-recon.js';

async function xlsxCoSoDu(coCotSoDu: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SaoKe');
  ws.addRow(['SAO KE TK']);
  ws.addRow(['Số tài khoản/Account No: DEMO-ACCT']);
  ws.addRow(['Tên tài khoản/Account Name: KHACH HANG 01']);
  ws.addRow(['Ngân hàng TMCP Quân Đội']);
  const head = ['Thời gian giao dịch', 'Mã tham chiếu', 'Phát sinh Nợ', 'Phát sinh Có', 'Nội dung', 'Tên tài khoản đối ứng', 'TK Đối Ứng', 'NH Đối Ứng'];
  ws.addRow(coCotSoDu ? [...head.slice(0, 4), 'Số dư', ...head.slice(4)] : head);
  const r1 = ['08/09/2026 08:14:08', 'FT26251000001', null, 500000000, 'KHACH HANG 02 CHUYEN KHOAN', 'KHACH HANG 02', '50704397', 'ACB'];
  const r2 = ['08/09/2026 09:15:23', 'FT26251000002', 16155000, null, 'HOAN DAI LY', 'KHACH HANG 27', '00281128', 'SHB'];
  ws.addRow(coCotSoDu ? [...r1.slice(0, 4), 512345678, ...r1.slice(4)] : r1);
  ws.addRow(coCotSoDu ? [...r2.slice(0, 4), 496190678, ...r2.slice(4)] : r2);
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}

describe('parser cột "Số dư" (12/9)', () => {
  it('MB có cột Số dư → balance từng GD đọc đúng', async () => {
    const p = await parseMbStatement(await xlsxCoSoDu(true));
    expect(p.txns).toHaveLength(2);
    expect(p.txns[0].balance).toBe(512345678);
    expect(p.txns[1].balance).toBe(496190678);
  });

  it('file KHÔNG có cột Số dư → balance null (không bịa), GD vẫn đọc đủ', async () => {
    const p = await parseMbStatement(await xlsxCoSoDu(false));
    expect(p.txns).toHaveLength(2);
    expect(p.txns[0].balance ?? null).toBeNull();
    expect(p.txns[1].balance ?? null).toBeNull();
  });

  it('bố cục ACB (cột "Số dư" giữa bảng) → balance đọc đúng, các cột khác không lệch', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Chủ tài khoản: NGUYEN VAN A']);
    ws.addRow(['BẢNG SAO KÊ GIAO DỊCH - Số tài khoản (VND): 42227']);
    ws.addRow(['Ngày hiệu lực', 'Ngày giao dịch', 'Số GD', 'Nội dung giao dịch', 'Số tiền rút ra', 'Số tiền gửi vào', 'Số dư', 'Tên tài khoản đối ứng', 'Tài khoản đối ứng', 'Ngân hàng đối ứng']);
    ws.addRow(['08/09/2026', '08/09/2026 08:14:08', 3408, 'IB KHACH HANG 02 CHUYEN KHOAN', null, 500000001, 500000058, 'KHACH HANG 02', '50704397', 'ACB']);
    const p = await parseMbStatement(Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer));
    expect(p.txns).toHaveLength(1);
    expect(p.txns[0].balance).toBe(500000058);
    expect(p.txns[0].credit).toBe(500000001);
    expect(p.txns[0].cpName).toBe('KHACH HANG 02');
  });
});

// [Admin Demo 13/9 "tra soát chưa có số dư cuối kì"] File KHÔNG có cột Số dư per-GD → đọc DÒNG TỔNG "Số dư cuối kỳ".
describe('parser DÒNG TỔNG "Số dư cuối kỳ" (13/9)', () => {
  it('MB: nhãn + số CÙNG Ô sau dấu ":" → closingBalance đúng', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('SaoKe');
    ws.addRow(['Số tài khoản/Account No: DEMO-ACCT']);
    ws.addRow(['Số dư đầu kỳ/Opening balance: 100.000.000']);
    ws.addRow(['Số dư cuối kỳ/Closing balance: 483.845.058']);
    ws.addRow(['Thời gian giao dịch', 'Mã tham chiếu', 'Phát sinh Nợ', 'Phát sinh Có', 'Nội dung', 'Tên tài khoản đối ứng']);
    ws.addRow(['08/09/2026 08:14:08', 'FT1', null, 500000000, 'CK', 'KHACH HANG 02']);
    const p = await parseMbStatement(Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer));
    expect(p.closingBalance).toBe(483845058);
    expect(p.txns).toHaveLength(1);
  });

  it('ACB: nhãn "Số dư cuối" ở dòng trên, GIÁ TRỊ ở ô NGAY DƯỚI cùng cột', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['BẢNG SAO KÊ GIAO DỊCH - Số tài khoản (VND): 42227']);
    ws.addRow(['', '', '', 'Số dư đầu', '(-) Tổng tiền rút ra', '(+) Tổng tiền gửi vào', 'Số dư cuối']);
    ws.addRow(['', '', '', 57, 16155000, 500000001, 483845058]);
    ws.addRow(['Ngày hiệu lực', 'Ngày giao dịch', 'Số GD', 'Nội dung giao dịch', 'Số tiền rút ra', 'Số tiền gửi vào', 'Số dư', 'Tên tài khoản đối ứng']);
    ws.addRow(['08/09/2026', '08/09/2026 08:14:08', 3408, 'IB CK', null, 500000001, 500000058, 'KHACH HANG 02']);
    const p = await parseMbStatement(Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer));
    expect(p.closingBalance).toBe(483845058);
  });

  it('file không ghi số dư cuối kỳ → null (không bịa)', async () => {
    const p = await parseMbStatement(await xlsxCoSoDu(false));
    expect(p.closingBalance ?? null).toBeNull();
  });
});
