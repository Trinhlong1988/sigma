// [Admin Demo 14/10 "thêm xuất excel báo có của phần này"] XUẤT .xlsx BÁO CÁO ĐỐI SOÁT BÁO-CÓ.
//
// Nguồn dữ liệu là CHÍNH `buildBaoCoReport` — cái bảng người dùng đang nhìn trên màn Báo cáo Báo-có. Cố tình
// KHÔNG truy vấn lại DB theo kiểu riêng: hai đường tính ra hai con số lệch nhau là lớp lỗi đã vấp nhiều lần
// (bản sao công thức trôi khỏi nhau). File xuất phải khớp từng dòng với bảng trên màn hình, cùng bộ lọc.
//
// Brand theo khuôn báo cáo SigMa đang dùng ở `saoke-export.ts` (tiêu đề nền FF1877D6, header đậm, zebra nhạt,
// freeze + autofilter ở dòng header) để mọi file xuất của hệ nhìn như một bộ.
import ExcelJS from 'exceljs';

const FONT = 'Calibri';
const BRAND = 'FF1877D6';
const BRAND_DEEP = 'FF0F5FB0';
const VIEN = { style: 'hair' as const, color: { argb: 'FFDFE7F1' } };

/** Một dòng báo-có như `buildBaoCoReport` trả về (chỉ khai các trường file Excel dùng). */
export interface BaoCoXuatRow {
  stt: number;
  dateIso: string | null;
  hkdName: string | null;
  amount: number;
  payerName: string | null;
  billId: string;
  externalRefNo: string | null;
  sauPhiBan: number | null;
  sauPhiMua: number | null;
  loiNhuanAlpha: number | null;
  dealerName: string | null;
  reconcileStatus: string | null;
  nguon: string | null;
}

export interface BaoCoXuatInfo {
  from: string;   // ISO
  to: string;     // ISO (nửa mở)
  loc?: string | null;        // mô tả bộ lọc đang áp (hiện nguyên văn lên file)
  tongSo: number;
  tongTien: number;
  tongLoiNhuan: number;
}

/** 'YYYY-MM-DDTHH:MM:SS…' → ['dd/MM/yyyy', 'HH:MM:SS'] theo giờ Việt Nam. */
function tachNgayGio(iso: string | null): [string, string] {
  if (!iso) return ['', ''];
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return [iso, ''];
  const vn = new Date(d.getTime() + 7 * 3600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return [`${p(vn.getUTCDate())}/${p(vn.getUTCMonth() + 1)}/${vn.getUTCFullYear()}`,
    `${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())}:${p(vn.getUTCSeconds())}`];
}

function nhanTrangThai(s: string | null): string {
  const v = String(s ?? '').toUpperCase();
  if (v === 'MATCHED') return 'Đã đối soát';
  if (v === 'DUPLICATE') return 'Trùng';
  if (!v) return 'Chưa đối soát';
  return s ?? '';
}

export async function buildBaoCoXlsx(rows: BaoCoXuatRow[], info: BaoCoXuatInfo): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SigMa';
  const ws = wb.addWorksheet('BAO CO QR');
  ws.columns = [
    { width: 6 }, { width: 12 }, { width: 10 }, { width: 30 }, { width: 12 }, { width: 16 },
    { width: 24 }, { width: 26 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 22 }, { width: 16 }
  ];
  const SO_COT = 13;

  const dmy = (iso: string): string => {
    const [d] = tachNgayGio(iso);
    return d || iso;
  };
  // `to` là mốc NỬA MỞ (hôm sau) — hiện ra phải lùi 1 ngày kẻo người đọc tưởng lố 1 ngày.
  const denHienThi = (() => {
    const d = new Date(info.to);
    if (Number.isNaN(d.getTime())) return info.to;
    return dmy(new Date(d.getTime() - 86_400_000).toISOString());
  })();

  ws.mergeCells(1, 1, 1, SO_COT);
  const t = ws.getCell('A1');
  t.value = 'BÁO CÁO ĐỐI SOÁT BÁO-CÓ QR';
  t.font = { name: FONT, size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  ws.getRow(1).height = 34;

  ws.mergeCells(2, 1, 2, SO_COT);
  const sub = ws.getCell('A2');
  sub.value = `Kỳ: ${dmy(info.from)} → ${denHienThi}${info.loc ? ` · Lọc: ${info.loc}` : ''}`;
  sub.font = { name: FONT, size: 11, bold: true, color: { argb: BRAND_DEEP } };
  sub.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 22;

  ws.mergeCells(3, 1, 3, SO_COT);
  const tong = ws.getCell('A3');
  tong.value = `${info.tongSo} giao dịch · Doanh số ${info.tongTien.toLocaleString('vi-VN')}đ · Lợi nhuận SigMa ${info.tongLoiNhuan.toLocaleString('vi-VN')}đ`;
  tong.font = { name: FONT, size: 10, color: { argb: 'FF64748B' } };
  tong.alignment = { horizontal: 'center' };
  ws.addRow([]);

  const head = ws.addRow(['STT', 'Ngày', 'Giờ', 'HKD', 'Nguồn', 'Số tiền', 'Người quẹt', 'Mã hoá đơn',
    'Số tham chiếu', 'Sau phí bán', 'Sau phí mua', 'Lợi nhuận SigMa', 'Đại lý', 'Trạng thái'].slice(0, SO_COT + 1));
  head.height = 26;
  head.eachCell((c) => {
    c.font = { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { top: VIEN, bottom: VIEN, left: VIEN, right: VIEN };
  });
  const HANG_HEAD = head.number;

  rows.forEach((x, i) => {
    const [ngay, gio] = tachNgayGio(x.dateIso);
    const r = ws.addRow([
      x.stt, ngay, gio, x.hkdName ?? '', x.nguon ?? '', x.amount, x.payerName ?? '', x.billId,
      x.externalRefNo ?? '', x.sauPhiBan, x.sauPhiMua, x.loiNhuanAlpha, x.dealerName ?? '', nhanTrangThai(x.reconcileStatus)
    ]);
    r.height = 19;
    for (const col of [6, 10, 11, 12]) {
      const c = r.getCell(col);
      c.numFmt = '#,##0';
      c.alignment = { horizontal: 'right' };
    }
    r.getCell(6).font = { name: FONT, size: 11, bold: true, color: { argb: 'FF177245' } };
    for (const col of [1, 2, 3, 5]) r.getCell(col).alignment = { horizontal: 'center' };
    r.eachCell({ includeEmpty: true }, (c) => {
      c.border = { top: VIEN, bottom: VIEN, left: VIEN, right: VIEN };
      if (i % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2FC' } };
    });
  });

  // Dòng TỔNG: cộng từ CHÍNH các dòng vừa ghi (không nhận số rời từ nơi khác — lệch là thấy ngay).
  const cong = (lay: (x: BaoCoXuatRow) => number | null): number => rows.reduce((s, x) => s + (lay(x) ?? 0), 0);
  const tot = ws.addRow(['', 'TỔNG', '', `${rows.length} giao dịch`, '', cong((x) => x.amount), '', '', '',
    cong((x) => x.sauPhiBan), cong((x) => x.sauPhiMua), cong((x) => x.loiNhuanAlpha), '', '']);
  tot.height = 24;
  tot.eachCell({ includeEmpty: true }, (c) => {
    c.font = { name: FONT, size: 12, bold: true, color: { argb: BRAND_DEEP } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F5' } };
  });
  for (const col of [6, 10, 11, 12]) { tot.getCell(col).numFmt = '#,##0'; tot.getCell(col).alignment = { horizontal: 'right' }; }

  ws.autoFilter = { from: { row: HANG_HEAD, column: 1 }, to: { row: HANG_HEAD, column: SO_COT + 1 } };
  ws.views = [{ state: 'frozen', ySplit: HANG_HEAD }];
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}
