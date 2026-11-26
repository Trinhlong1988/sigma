// [Admin Demo 13/9 "thêm nút tải sao kê — đúng định dạng" + 14/9 "bỏ ghi nợ, bỏ TK/NH đối ứng, dãn lại + brand SigMa"]
// XUẤT .xlsx BÁO CÁO SAO KÊ BÁO CÓ theo brand báo cáo SigMa (tiêu đề FF1877D6, header đậm, dòng dãn thoáng):
//   · CHỈ dòng BÁO CÓ (credit > 0) — bỏ ghi nợ.
//   · Cột: Thời gian giao dịch | Mã tham chiếu | Phát sinh Nợ (giữ TRỐNG để file vẫn nạp ngược được — parser cần
//     cột nợ nhận header) | Phát sinh Có | Số dư | Nội dung | Tên tài khoản đối ứng. BỎ TK/NH đối ứng + Mã GD (14/9).
// ĐÚNG-ĐỊNH-DẠNG kiểm bằng máy: file xuất PHẢI parse ngược được bởi CHÍNH parseMbStatement (round-trip test).
import ExcelJS from 'exceljs';

export interface SaoKeXuatTxn {
  dateTime: string | null;   // 'YYYY-MM-DDTHH:MM:SS' wall-clock
  ref: string | null;
  debit: number;
  credit: number;
  balance?: number | null;
  desc: string | null;
  cpName: string | null;
  cpAccount: string | null;
  cpBank: string | null;
}

const FONT = 'Calibri';
const BRAND = 'FF1877D6';
const BRAND_DEEP = 'FF0F5FB0';

function dmyHms(s: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6] ?? '00'}` : (s ?? '');
}

export async function buildSaoKeXlsx(
  txns: SaoKeXuatTxn[],
  info: { accountNumber: string; accountHolder: string | null; bank: string | null; from: string; to: string }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SigMa';
  const ws = wb.addWorksheet('SAO KE BAO CO');
  ws.columns = [{ width: 21 }, { width: 8 }, { width: 18 }, { width: 18 }, { width: 60 }, { width: 26 }];

  // ── TIÊU ĐỀ BRAND SIGMA ──
  ws.mergeCells('A1:F1');
  const t = ws.getCell('A1');
  t.value = 'BÁO CÁO SAO KÊ BÁO CÓ';
  t.font = { name: FONT, size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  ws.getRow(1).height = 34;
  ws.mergeCells('A2:F2');
  const sub = ws.getCell('A2');
  sub.value = `Số tài khoản/Account No: ${info.accountNumber} · Ngân hàng ${info.bank ?? 'MB'} · Từ ngày ${info.from.split('-').reverse().join('/')} đến ngày ${info.to.split('-').reverse().join('/')}`;
  sub.font = { name: FONT, size: 11, bold: true, color: { argb: BRAND_DEEP } };
  sub.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 22;
  if (info.accountHolder) {
    ws.mergeCells('A3:F3');
    const h = ws.getCell('A3');
    h.value = `Tên tài khoản/Account Name: ${info.accountHolder}`;
    h.font = { name: FONT, size: 10, color: { argb: 'FF64748B' } };
    h.alignment = { horizontal: 'center' };
  }
  ws.addRow([]);

  // ── HEADER BẢNG (nhãn chuẩn để parseMbStatement map cột; cột Nợ giữ TRỐNG cho round-trip) ──
  const head = ws.addRow(['Thời gian giao dịch', 'Phát sinh Nợ', 'Phát sinh Có', 'Số dư', 'Nội dung', 'Tên tài khoản đối ứng']);
  head.height = 24;
  head.eachCell((c) => {
    c.font = { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { top: { style: 'thin', color: { argb: 'FFC7D0DB' } }, bottom: { style: 'thin', color: { argb: 'FFC7D0DB' } }, left: { style: 'thin', color: { argb: 'FFC7D0DB' } }, right: { style: 'thin', color: { argb: 'FFC7D0DB' } } };
  });

  // ── CHỈ BÁO CÓ (bỏ ghi nợ) ──
  const sorted = txns.filter((x) => x.credit > 0).sort((a, b) => (a.dateTime ?? '').localeCompare(b.dateTime ?? ''));
  sorted.forEach((x, i) => {
    const r = ws.addRow([dmyHms(x.dateTime), null, x.credit, x.balance ?? null, x.desc ?? '', x.cpName ?? '']);
    r.height = 20;
    r.getCell(3).numFmt = '#,##0'; r.getCell(4).numFmt = '#,##0';
    r.getCell(3).font = { name: FONT, size: 11, bold: true, color: { argb: 'FF177245' } };
    r.getCell(3).alignment = { horizontal: 'right' }; r.getCell(4).alignment = { horizontal: 'right' };
    r.getCell(1).alignment = { horizontal: 'center' };
    r.eachCell({ includeEmpty: true }, (c, col) => {
      if (col <= 6) {
        c.border = { top: { style: 'hair', color: { argb: 'FFDFE7F1' } }, bottom: { style: 'hair', color: { argb: 'FFDFE7F1' } }, left: { style: 'hair', color: { argb: 'FFDFE7F1' } }, right: { style: 'hair', color: { argb: 'FFDFE7F1' } } };
        if (i % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2FC' } };
      }
    });
  });

  // ── TỔNG (nhãn 'Phát sinh trong kỳ' — parser skip đúng luật, không thành GD) ──
  const tongCo = sorted.reduce((s, x) => s + x.credit, 0);
  const tot = ws.addRow(['Phát sinh trong kỳ', null, tongCo, null, `${sorted.length} giao dịch báo có`]);
  tot.height = 24;
  tot.eachCell((c) => { c.font = { name: FONT, size: 12, bold: true, color: { argb: BRAND_DEEP } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F5' } }; });
  tot.getCell(3).numFmt = '#,##0';
  const cuoi = sorted.length > 0 ? sorted[sorted.length - 1].balance : null;
  if (cuoi != null) {
    const rB = ws.addRow([`Số dư cuối kỳ/Closing balance: ${Math.round(cuoi).toLocaleString('vi-VN')}`]);
    rB.getCell(1).font = { name: FONT, size: 11, bold: true, color: { argb: BRAND_DEEP } };
    rB.height = 20;
  }
  // [Admin Demo 14/9 'thêm lọc filter dòng số 5'] AutoFilter trên dòng header bảng.
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: 6 } };
  ws.views = [{ state: 'frozen', ySplit: 5 }];
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}
