// [Admin Demo 8/9] XUẤT EXCEL .xlsx THẬT (OOXML, exceljs) cho Tra soát sao kê — thay SpreadsheetML .xls (Excel cảnh báo
// "format and extension don't match"). 2 sheet: Tổng hoàn đại lý (thực hoàn + TỔNG) + Chi tiết GD gộp (phân tách
// Người gửi / Người nhận theo chiều tiền, khớp bill OCR). Nhận txns đã LỌC từ client + nhãn chu kỳ.
import ExcelJS from 'exceljs';

export interface XlsxTxn {
  dateTime: string | null; debit: number; credit: number; direction: 'OUT' | 'IN'; kind: string;
  cpName: string | null; descName: string | null; cpAccount: string | null; cpBank: string | null;
  srcAccount: string | null; srcBank: string | null; srcHolder: string | null;
  matchedName: string | null; matchedCustomerId: number | null; matchedInvestorId: number | null;
}

const KIND_LABEL: Record<string, string> = { DEALER_REFUND: 'Hoàn đại lý', DEALER_ADVANCE: 'Tạm ứng đại lý', DEALER_RETURN: 'Đại lý hoàn lại', INVESTOR_REPAY: 'Hoàn ứng NĐT', INVESTOR_ADVANCE: 'Tạm ứng NĐT', TRANSFER: 'Chuyển giữa TK', INTEREST: 'Chuyển lãi', CAPITAL: 'Dồn vốn', OTHER: 'Khác', UNKNOWN: 'Chưa khớp' };
const MONEY = '#,##0';
const BRAND = 'FF1877D6';
const parseWc = (s: string | null): { d: string; mo: string; y: string; h: string; mi: string } | null => { const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s ?? ''); return m ? { y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5] } : null; };
const dmy = (s: string | null): string => { const p = parseWc(s); return p ? `${p.d}/${p.mo}/${p.y}` : ''; };
const hm = (s: string | null): string => { const p = parseWc(s); return p ? `${p.h}:${p.mi}` : ''; };
const normU = (s: string | null): string => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
const cpDisplay = (t: XlsxTxn): string => (t.cpName && t.srcHolder && normU(t.cpName) === normU(t.srcHolder) && t.descName) ? t.descName : (t.cpName || t.descName || '');
const senderOf = (t: XlsxTxn): string => t.direction === 'IN' ? cpDisplay(t) : (t.srcHolder || '');
const receiverOf = (t: XlsxTxn): string => t.direction === 'IN' ? (t.srcHolder || '') : cpDisplay(t);

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((c) => { c.font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = { top: { style: 'thin', color: { argb: 'FFC7D0DB' } }, bottom: { style: 'thin', color: { argb: 'FFC7D0DB' } }, left: { style: 'thin', color: { argb: 'FFC7D0DB' } }, right: { style: 'thin', color: { argb: 'FFC7D0DB' } } }; });
}

export async function buildStatementReconXlsx(txns: XlsxTxn[], periodLabel: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SigMa'; wb.created = new Date();

  // ─── SHEET 1: Tổng hoàn đại lý (gộp mọi TK 1 dòng) ───────────────────────────
  const s1 = wb.addWorksheet('Tổng hoàn đại lý');
  s1.columns = [{ width: 34 }, { width: 8 }, { width: 20 }, { width: 18 }, { width: 20 }];
  const t1 = s1.addRow([`TỔNG HOÀN ĐẠI LÝ · ${periodLabel}`.toUpperCase()]);
  t1.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0F5FB0' } }; s1.mergeCells(1, 1, 1, 5);
  const h1 = s1.addRow(['Đại lý', 'Số GD', 'Hoàn (+ứng)', 'Đại lý hoàn lại', 'Thực hoàn']); styleHeader(h1);
  const dmap = new Map<string, { name: string; refund: number; ret: number; count: number }>();
  for (const t of txns) {
    if (t.kind !== 'DEALER_REFUND' && t.kind !== 'DEALER_ADVANCE' && t.kind !== 'DEALER_RETURN') continue;
    const key = t.matchedCustomerId != null ? `c${t.matchedCustomerId}` : `n${(t.matchedName ?? t.cpName ?? '?').trim().toUpperCase()}`;
    const e = dmap.get(key) ?? { name: t.matchedName ?? t.cpName ?? '?', refund: 0, ret: 0, count: 0 };
    if (t.kind === 'DEALER_RETURN') e.ret += t.credit; else e.refund += t.debit;
    e.count++; dmap.set(key, e);
  }
  const dlist = [...dmap.values()].map((e) => ({ ...e, net: e.refund - e.ret })).sort((a, b) => b.net - a.net);
  for (const e of dlist) {
    const r = s1.addRow([e.name, e.count, Math.round(e.refund), Math.round(e.ret), Math.round(e.net)]);
    r.getCell(3).numFmt = MONEY; r.getCell(4).numFmt = MONEY; r.getCell(5).numFmt = MONEY;
    r.getCell(5).font = { bold: true, color: { argb: 'FF177245' } };
  }
  const tot = s1.addRow(['TỔNG', dlist.reduce((s, e) => s + e.count, 0), Math.round(dlist.reduce((s, e) => s + e.refund, 0)), Math.round(dlist.reduce((s, e) => s + e.ret, 0)), Math.round(dlist.reduce((s, e) => s + e.net, 0))]);
  tot.eachCell((c) => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F5' } }; }); tot.getCell(3).numFmt = MONEY; tot.getCell(4).numFmt = MONEY; tot.getCell(5).numFmt = MONEY;
  s1.views = [{ state: 'frozen', ySplit: 2 }];

  // ─── SHEET 2: Chi tiết GD gộp (Người gửi / Người nhận) ────────────────────────
  const s2 = wb.addWorksheet('Chi tiết GD gộp');
  s2.columns = [{ width: 5 }, { width: 11 }, { width: 7 }, { width: 15 }, { width: 16 }, { width: 22 }, { width: 22 }, { width: 20 }, { width: 16 }, { width: 18 }, { width: 18 }];
  const t2 = s2.addRow([`CHI TIẾT GIAO DỊCH GỘP · ${periodLabel}`.toUpperCase()]);
  t2.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0F5FB0' } }; s2.mergeCells(1, 1, 1, 11);
  const h2 = s2.addRow(['STT', 'Ngày', 'Giờ', 'Loại', 'Số tiền', 'Người gửi', 'Người nhận', 'Đại lý/NĐT', 'Số TK', 'Ngân hàng', 'Sao kê (nguồn)']); styleHeader(h2);
  const rows = [...txns].sort((a, b) => (a.srcBank ?? '').localeCompare(b.srcBank ?? '') || (a.srcAccount ?? '').localeCompare(b.srcAccount ?? '') || (a.dateTime ?? '').localeCompare(b.dateTime ?? ''));
  rows.forEach((t, i) => {
    const amt = (t.direction === 'OUT' ? -1 : 1) * (t.debit || t.credit);
    const dealer = t.matchedName ? (t.matchedInvestorId != null ? `NĐT ${t.matchedName}` : t.matchedName) : '';
    const src = t.srcAccount ? `${t.srcAccount}${t.srcBank ? ' · ' + t.srcBank : ''}` : '';
    const r = s2.addRow([i + 1, dmy(t.dateTime), hm(t.dateTime), KIND_LABEL[t.kind] ?? t.kind, Math.round(amt), senderOf(t), receiverOf(t), dealer, t.cpAccount ?? '', t.cpBank ?? '', src]);
    r.getCell(5).numFmt = MONEY; r.getCell(5).font = { bold: true, color: { argb: t.direction === 'OUT' ? 'FFC0392B' : 'FF177245' } };
    r.getCell(1).alignment = { horizontal: 'center' }; r.getCell(2).alignment = { horizontal: 'center' }; r.getCell(3).alignment = { horizontal: 'center' };
    r.getCell(6).alignment = { horizontal: 'center' }; r.getCell(7).alignment = { horizontal: 'center' }; r.getCell(8).alignment = { horizontal: 'center' };
    if (i % 2 === 1) r.eachCell((c) => { if (!c.fill || (c.fill as ExcelJS.FillPattern).fgColor === undefined) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2FC' } }; });
  });
  s2.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: 11 } };
  s2.views = [{ state: 'frozen', ySplit: 2 }];

  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}
