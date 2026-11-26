// [Admin Demo 26/9 "ghép sao kê này vào tra soát sao kê của alpha"] KHOÁ đọc sao kê TECHCOMBANK.
//
// File TCB ("SỔ PHỤ KIÊM PHIẾU HẠCH TOÁN") khác MB ở 3 điểm đã làm parser hụt:
//   1. Nhãn tiền là "Nợ TKTT/Debit" + "Có TKTT/Credit" (MB: "Phát sinh Nợ/Có") ⇒ KHÔNG dò ra dòng tiêu đề,
//      báo "không phải file sao kê" dù file hợp lệ.
//   2. Tiêu đề GỘP Ô nên nhãn "Đối tác/Remitter" lặp ở nhiều cột; cột lặp kế tiếp bị nhận nhầm thành cột NGÂN
//      HÀNG đối ứng ⇒ "ngân hàng" hoá ra là TÊN người (đo thật: đọc ra "KHACH HANG 22").
//   3. Dòng tổng "Cộng doanh số/Total volume" bị đọc thành 1 GD giả mang CẢ tiền ra LẪN tiền vào (đo thật:
//      ra 2.502.383.000 + vào 2.501.602.000) ⇒ báo cáo phồng gấp đôi, hiện "chưa khớp 2,5 tỷ" hoàn toàn ảo.
// Ngoài ra tên NH của chính TK in tiếng Việt "NGÂN HÀNG TMCP KỸ THƯƠNG VIỆT NAM" (không có chữ Techcombank).
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseMbStatement } from '../src/statement-recon.js';

/** Dựng 1 file .xlsx mô phỏng ĐÚNG khuôn TCB: tiêu đề gộp ô (nhãn lặp), 2 GD thật + dòng tổng cuối. */
async function fileTcb(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('AccountStatement_A4_Landscape');
  ws.getCell('D3').value = 'NGÂN HÀNG TMCP KỸ THƯƠNG VIỆT NAM';
  ws.getCell('E20').value = 'Tên khách hàng/ Customer name:';
  ws.getCell('P21').value = 'KHACH HANG 01';
  ws.getCell('E30').value = 'Số tài khoản/ Account number:';
  ws.getCell('P30').value = '1900668888';
  // Dòng tiêu đề 34 — nhãn LẶP đúng kiểu ô gộp của TCB
  const h = ws.getRow(34);
  for (const c of [2, 3, 4, 5, 6]) h.getCell(c).value = 'Ngày giao dịch (1)\nTransaction Date';
  for (const c of [7, 8, 9, 10, 11]) h.getCell(c).value = 'Đối tác\nRemitter';
  for (const c of [12, 13, 14, 15, 16, 17]) h.getCell(c).value = 'NH Đối tác\nRemitter Bank';
  for (const c of [18, 19, 20, 21]) h.getCell(c).value = 'Diễn giải\nDetails';
  for (const c of [22, 23]) h.getCell(c).value = 'Số bút toán\nTransaction No';
  for (const c of [32, 33, 34, 35, 36, 37]) h.getCell(c).value = 'Nợ TKTT\nDebit';
  for (const c of [38, 39, 40, 41, 42]) h.getCell(c).value = 'Có TKTT\nCredit';
  for (const c of [43, 44, 45]) h.getCell(c).value = 'Số dư (2)\nBalance';
  h.commit();
  ws.getCell('B35').value = 'Số dư đầu kỳ/ Opening balance';
  ws.getCell('AQ35').value = 2_934_000;
  // GD 1: tiền RA cho KHACH HANG 22 (ACB)
  ws.getCell('B36').value = '25/09/2026';
  ws.getCell('G36').value = 'KHACH HANG 22';
  ws.getCell('L36').value = 'NGAN HANG TMCP A CHAU (ACB)';
  ws.getCell('R36').value = 'KHACH HANG 01 chuyen tien';
  ws.getCell('V36').value = 'FT26268060310604';
  ws.getCell('AF36').value = 1_243_000;
  ws.getCell('AQ36').value = 1_691_000;
  // GD 2: tiền VÀO từ TPBank, KHÔNG có tên đối tác (đặc thù TCB)
  ws.getCell('B38').value = '25/09/2026';
  ws.getCell('L38').value = 'NGAN HANG TMCP TIEN PHONG (TPBANK)';
  ws.getCell('R38').value = 'CK107812';
  ws.getCell('V38').value = 'FT26268968126044';
  ws.getCell('AL38').value = 69_132_000;
  ws.getCell('AQ38').value = 70_823_000;
  // DÒNG TỔNG — PHẢI BỊ BỎ QUA
  ws.getCell('B40').value = 'Cộng doanh số/Total volume';
  ws.getCell('AF40').value = 1_243_000;
  ws.getCell('AL40').value = 69_132_000;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('sao kê Techcombank — đọc đúng, không nuốt, không đẻ GD giả', () => {
  it('đọc đúng 2 GD thật và BỎ dòng tổng "Cộng doanh số"', async () => {
    const r = await parseMbStatement(await fileTcb());
    // Cảnh báo DUY NHẤT được phép là "thiếu cột giờ" (file TCB vốn không có giờ — xem ca cuối). KHÔNG được có
    // cảnh báo kiểu đọc-hụt/không-nhận-dạng-được.
    expect((r.warnings ?? []).filter((w) => !/KHÔNG CÓ CỘT GIỜ/.test(w))).toEqual([]);
    expect(r.txns.length).toBe(2);                       // dòng tổng KHÔNG được thành GD
    expect(r.txns.some((t) => t.debit > 0 && t.credit > 0)).toBe(false); // GD giả mang cả 2 chiều
  });

  it('cột NGÂN HÀNG đối ứng không bị nhận nhầm thành TÊN (bẫy ô gộp)', async () => {
    const r = await parseMbStatement(await fileTcb());
    const ra = r.txns.find((t) => t.debit > 0)!;
    expect(ra.cpName).toBe('KHACH HANG 22');
    expect(ra.cpBank).toContain('A CHAU');
    expect(ra.cpBank).not.toBe(ra.cpName);
  });

  it('nhận đúng ngân hàng TCB từ tên tiếng Việt "TMCP KỸ THƯƠNG"', async () => {
    const r = await parseMbStatement(await fileTcb());
    expect(r.accountBank).toBe('TCB');
  });

  it('tiền ra/vào đúng số, GD vào không có tên đối tác vẫn đọc được', async () => {
    const r = await parseMbStatement(await fileTcb());
    expect(r.txns.reduce((s, t) => s + t.debit, 0)).toBe(1_243_000);
    expect(r.txns.reduce((s, t) => s + t.credit, 0)).toBe(69_132_000);
    const vao = r.txns.find((t) => t.credit > 0)!;
    expect(vao.cpName).toBeNull();
    expect(vao.cpBank).toContain('TIEN PHONG');
  });
  it('[Admin Demo 26/9] file KHÔNG có cột giờ → PHẢI cảnh báo, không im lặng để 00:00 trông như giờ thật', async () => {
    const r = await parseMbStatement(await fileTcb());
    expect(r.txns.every((t) => /T00:00/.test(String(t.dateTime)))).toBe(true);   // file TCB vốn không có giờ
    const w = (r.warnings ?? []).join(' | ');
    expect(w).toMatch(/KHÔNG CÓ CỘT GIỜ/);
    expect(w).toMatch(/không phải giao dịch lúc nửa đêm/i);
  });
});
