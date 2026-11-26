// [Admin Demo 14/10 "thêm xuất excel báo có của phần này"] Test hàm dựng .xlsx báo-có.
// Cách kiểm: dựng file từ dữ liệu mẫu rồi ĐỌC NGƯỢC bằng ExcelJS — "không ném lỗi" không phải bằng chứng,
// nội dung từng ô mới là. Chặn đúng mấy chỗ dễ sai âm thầm: lệch cột, mất dòng, dòng TỔNG cộng sai, giờ lệch
// múi (cột Ngày/Giờ phải là giờ Việt Nam), và viewer bị tước lợi nhuận thì file không được rò số đó.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildBaoCoXlsx, type BaoCoXuatRow } from '../src/baoco-export.js';

const HANG_HEAD = 5;

function dongMau(p: Partial<BaoCoXuatRow> & { stt: number }): BaoCoXuatRow {
  return {
    dateIso: '2026-10-14T10:38:43.000Z', // = 17:38:43 giờ VN
    hkdName: '001_HKD KHACH HANG 64',
    amount: 1_944_000,
    payerName: 'KHACH HANG 49',
    billId: '2026101400026425',
    externalRefNo: '2026101400026425',
    sauPhiBan: 1_920_000,
    sauPhiMua: 1_900_000,
    loiNhuanAlpha: 20_000,
    dealerName: 'ĐL - Lộc SG',
    reconcileStatus: null,
    nguon: 'SmartPay',
    ...p
  };
}

async function doc(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets[0]!;
}

const thongTin = { from: '2026-10-14T00:00:00+07:00', to: '2026-10-15T00:00:00+07:00', tongSo: 0, tongTien: 0, tongLoiNhuan: 0 };

describe('buildBaoCoXlsx — xuất Excel báo-có', () => {
  it('đủ cột + đúng số dòng + giữ nguyên tiền/HKD/mã hoá đơn', async () => {
    const rows = [dongMau({ stt: 1 }), dongMau({ stt: 2, amount: 9_998_900, billId: 'B2' }), dongMau({ stt: 3, amount: 5_998_000, billId: 'B3' })];
    const ws = await doc(await buildBaoCoXlsx(rows, { ...thongTin, tongSo: 3, tongTien: 17_940_900, tongLoiNhuan: 60_000 }));
    const head = (ws.getRow(HANG_HEAD).values as unknown[]).slice(1).map((x) => String(x ?? ''));
    for (const c of ['STT', 'Ngày', 'Giờ', 'HKD', 'Nguồn', 'Số tiền', 'Người quẹt', 'Mã hoá đơn', 'Số tham chiếu',
      'Sau phí bán', 'Sau phí mua', 'Lợi nhuận SigMa', 'Đại lý', 'Trạng thái']) {
      expect(head, `thiếu cột ${c}`).toContain(c);
    }
    // 3 dòng dữ liệu + 1 dòng TỔNG
    expect(ws.rowCount).toBe(HANG_HEAD + 3 + 1);
    const iTien = head.indexOf('Số tiền') + 1, iHd = head.indexOf('Mã hoá đơn') + 1, iHkd = head.indexOf('HKD') + 1;
    expect(Number(ws.getRow(HANG_HEAD + 2).getCell(iTien).value)).toBe(9_998_900);
    expect(String(ws.getRow(HANG_HEAD + 3).getCell(iHd).value)).toBe('B3');
    expect(String(ws.getRow(HANG_HEAD + 1).getCell(iHkd).value)).toBe('001_HKD KHACH HANG 64');
  });

  it('Ngày/Giờ hiện theo GIỜ VIỆT NAM (10:38 UTC → 17:38), không để lệch múi', async () => {
    const ws = await doc(await buildBaoCoXlsx([dongMau({ stt: 1 })], { ...thongTin, tongSo: 1, tongTien: 1_944_000, tongLoiNhuan: 20_000 }));
    const head = (ws.getRow(HANG_HEAD).values as unknown[]).slice(1).map((x) => String(x ?? ''));
    const r = ws.getRow(HANG_HEAD + 1);
    expect(String(r.getCell(head.indexOf('Ngày') + 1).value)).toBe('14/10/2026');
    expect(String(r.getCell(head.indexOf('Giờ') + 1).value)).toBe('17:38:43');
  });

  it('dòng TỔNG = cộng CHÍNH các dòng trong file (không nhận số rời bên ngoài)', async () => {
    const rows = [dongMau({ stt: 1, amount: 1_000_000, loiNhuanAlpha: 10_000 }), dongMau({ stt: 2, amount: 2_000_000, loiNhuanAlpha: 20_000, billId: 'B2' })];
    // Cố tình truyền tổng SAI ở info: dòng TỔNG vẫn phải ra 3.000.000 vì cộng từ dòng thật.
    const ws = await doc(await buildBaoCoXlsx(rows, { ...thongTin, tongSo: 2, tongTien: 999, tongLoiNhuan: 999 }));
    const head = (ws.getRow(HANG_HEAD).values as unknown[]).slice(1).map((x) => String(x ?? ''));
    const tot = ws.getRow(ws.rowCount);
    expect(Number(tot.getCell(head.indexOf('Số tiền') + 1).value)).toBe(3_000_000);
    expect(Number(tot.getCell(head.indexOf('Lợi nhuận SigMa') + 1).value)).toBe(30_000);
  });

  it('viewer bị tước lợi nhuận → file KHÔNG rò số đó (ô trống, không phải 0 giả)', async () => {
    const rows = [dongMau({ stt: 1, loiNhuanAlpha: null, sauPhiMua: null })];
    const ws = await doc(await buildBaoCoXlsx(rows, { ...thongTin, tongSo: 1, tongTien: 1_944_000, tongLoiNhuan: 0 }));
    const head = (ws.getRow(HANG_HEAD).values as unknown[]).slice(1).map((x) => String(x ?? ''));
    const r = ws.getRow(HANG_HEAD + 1);
    expect(r.getCell(head.indexOf('Lợi nhuận SigMa') + 1).value ?? null).toBeNull();
    expect(r.getCell(head.indexOf('Sau phí mua') + 1).value ?? null).toBeNull();
  });

  it('trạng thái đối soát dịch sang tiếng Việt, rỗng = "Chưa đối soát"', async () => {
    const rows = [dongMau({ stt: 1, reconcileStatus: 'MATCHED' }), dongMau({ stt: 2, reconcileStatus: null, billId: 'B2' }),
      dongMau({ stt: 3, reconcileStatus: 'DUPLICATE', billId: 'B3' })];
    const ws = await doc(await buildBaoCoXlsx(rows, { ...thongTin, tongSo: 3, tongTien: 0, tongLoiNhuan: 0 }));
    const head = (ws.getRow(HANG_HEAD).values as unknown[]).slice(1).map((x) => String(x ?? ''));
    const i = head.indexOf('Trạng thái') + 1;
    expect(String(ws.getRow(HANG_HEAD + 1).getCell(i).value)).toBe('Đã đối soát');
    expect(String(ws.getRow(HANG_HEAD + 2).getCell(i).value)).toBe('Chưa đối soát');
    expect(String(ws.getRow(HANG_HEAD + 3).getCell(i).value)).toBe('Trùng');
  });

  it('kỳ hiện trên file lùi 1 ngày ở mốc ĐẾN (to là nửa mở — không được hiện lố 1 ngày)', async () => {
    const ws = await doc(await buildBaoCoXlsx([dongMau({ stt: 1 })], { ...thongTin, tongSo: 1, tongTien: 0, tongLoiNhuan: 0 }));
    expect(String(ws.getCell('A2').value)).toContain('14/10/2026 → 14/10/2026');
  });
});
