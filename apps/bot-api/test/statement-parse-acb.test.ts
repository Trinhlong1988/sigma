// [Admin Demo 8/9] PARSER sao kê ACB — dựng lại ĐÚNG bố cục file thật `42227_SAOKE_TK_20260908-20260908.xlsx`
// (dòng 1 "Chủ tài khoản:", dòng 4 "BẢNG SAO KÊ GIAO DỊCH - Số tài khoản (VND): 42227", dòng 6-7 tổng, dòng 8 tiêu đề
// "Ngày hiệu lực | Ngày giao dịch | Số GD | Nội dung giao dịch | Số tiền rút ra | Số tiền gửi vào | Số dư | …đối ứng").
// R198: test KHẲNG ĐỊNH parser CHẠY ĐƯỢC trên bố cục ACB, không phải "suite xanh nên chắc ổn".
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseMbStatement } from '../src/statement-recon.js';

async function acbXlsx(coCotDoiUng: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Statement');
  ws.addRow(['Chủ tài khoản: NGUYEN VAN A']);
  ws.addRow(['Địa chỉ: to 7 minh tien B p. cam binh Thanh pho Cam Pha']);
  ws.addRow([]);
  ws.addRow(['BẢNG SAO KÊ GIAO DỊCH - Số tài khoản (VND): 42227']);
  ws.addRow(['Từ ngày: 08/09/2026    Đến ngày: 08/09/2026']);
  ws.addRow(['', '', '', 'Số dư đầu', '(-) Tổng tiền rút ra', '(+) Tổng tiền gửi vào', 'Số dư cuối']);
  ws.addRow(['', '', '', 57, 16155000, 500000001, 483845058]);
  const head = ['Ngày hiệu lực', 'Ngày giao dịch', 'Số GD', 'Nội dung giao dịch', 'Số tiền rút ra', 'Số tiền gửi vào', 'Số dư'];
  ws.addRow(coCotDoiUng ? [...head, 'Tên tài khoản đối ứng', 'Tài khoản đối ứng', 'Ngân hàng đối ứng'] : head);
  ws.addRow(['08/09/2026', '08/09/2026 08:14:08', 3408, 'IB KHACH HANG 02 CHUYEN KHOAN', null, 500000001, 500000058,
    ...(coCotDoiUng ? ['KHACH HANG 02', '50704397', 'ACB - NH TMCP A CHAU'] : [])]);
  ws.addRow(['08/09/2026', '08/09/2026 08:15:23', 3409, 'NGUYEN VAN A CHUYEN KHOAN NHANH QUA ZALO-080926-08:15:22', 16155000, null, 483845058,
    ...(coCotDoiUng ? ['KHACH HANG 27', '00281128', 'SHB - NH TMCP Sai Gon Ha Noi'] : [])]);
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}

describe('parseMbStatement — bố cục ACB', () => {
  it('đọc được 2 GD, đúng CHIỀU (rút ra = nợ, gửi vào = có) + đúng giờ', async () => {
    const p = await parseMbStatement(await acbXlsx(true));
    expect(p.txns).toHaveLength(2);
    expect(p.txns[0]).toMatchObject({ debit: 0, credit: 500000001, dateTime: '2026-09-08T08:14:00' });
    expect(p.txns[1]).toMatchObject({ debit: 16155000, credit: 0, dateTime: '2026-09-08T08:15:00' });
  });

  it('nhận đúng chủ TK + số TK 5 CHỮ SỐ + ngân hàng ACB (file không in tên ngân hàng)', async () => {
    const p = await parseMbStatement(await acbXlsx(true));
    expect(p.accountHolder).toBe('NGUYEN VAN A');
    expect(p.accountNumber).toBe('42227');
    expect(p.accountBank).toBe('ACB');
  });

  it('"Số GD" ngắn được gắn tiền tố bank+TK+ngày → không thể ĐÈ giao dịch khác trong cache', async () => {
    const p = await parseMbStatement(await acbXlsx(true));
    expect(p.txns[0].ref).toBe('ACB-42227-2026-09-08-3408');
    expect(p.txns[1].ref).toBe('ACB-42227-2026-09-08-3409');
  });

  it('lấy đúng đối ứng (người NHẬN của lệnh chuyển ra), không lấy tên trong nội dung', async () => {
    const p = await parseMbStatement(await acbXlsx(true));
    expect(p.txns[1].cpName).toBe('KHACH HANG 27');
    expect(p.txns[1].cpAccount).toBe('00281128');
    expect(p.warnings).toEqual([]);
    expect(p.thieuCotDoiUng).toBe(false);
  });

  it('bản export THIẾU cột đối ứng → nêu rõ cảnh báo + cờ chặn + đếm số GD tiền ra', async () => {
    const p = await parseMbStatement(await acbXlsx(false));
    expect(p.thieuCotDoiUng).toBe(true);
    expect(p.soGdRa).toBe(1);
    expect(p.warnings?.join(' ')).toContain('Tên tài khoản đối ứng');
  });

  it('file không có dòng tiêu đề → nói rõ lý do, KHÔNG im lặng trả 0 GD', async () => {
    const wb = new ExcelJS.Workbook(); wb.addWorksheet('x').addRow(['linh tinh']);
    const p = await parseMbStatement(Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer));
    expect(p.txns).toHaveLength(0);
    expect(p.warnings?.join(' ')).toContain('DÒNG TIÊU ĐỀ');
  });
});

// KHOÁ KHÔNG LÀM HỎNG MB (thêm nhãn ACB không được đụng nhánh MB đang chạy production).
describe('parseMbStatement — bố cục MB vẫn nguyên', () => {
  async function mbXlsx(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('SAO KE TK');
    ws.addRow(['Ngân hàng TMCP Quân Đội (MB)']);
    ws.addRow(['Số tài khoản/Account No: DEMO-ACCT']);
    ws.addRow(['Tên tài khoản/Account Name: KHACH HANG 01']);
    ws.addRow(['Thời gian giao dịch', 'Mã tham chiếu', 'Phát sinh Nợ', 'Phát sinh Có', 'Nội dung', 'Tên TK đối ứng', 'TK đối ứng', 'NH đối ứng']);
    ws.addRow(['07/09/2026 09:04', 'FT26250001117226', null, 400000001, 'KHACH HANG 02 CHUYEN KHOAN', 'KHACH HANG 01', 'DEMO-ACCT', 'MB']);
    ws.addRow(['07/09/2026 10:00', 'FT26250001117227', 16155000, null, 'CHUYEN TIEN', 'KHACH HANG 27', '00281128', 'SHB']);
    return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  }

  it('vẫn đọc đúng MB: nhãn Nợ/Có, ref FT giữ NGUYÊN (không gắn tiền tố), bank MB, TK 12 số', async () => {
    const p = await parseMbStatement(await mbXlsx());
    expect(p.accountBank).toBe('MB');
    expect(p.accountNumber).toBe('DEMO-ACCT');
    expect(p.accountHolder).toBe('KHACH HANG 01');
    expect(p.txns).toHaveLength(2);
    expect(p.txns[0]).toMatchObject({ ref: 'FT26250001117226', credit: 400000001, debit: 0 });
    expect(p.txns[1]).toMatchObject({ ref: 'FT26250001117227', debit: 16155000, credit: 0 });
    expect(p.thieuCotDoiUng).toBe(false);
  });
});

