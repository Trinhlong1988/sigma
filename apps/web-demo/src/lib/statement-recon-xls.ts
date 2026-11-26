// [Admin Demo 8/9] XUẤT EXCEL BÁO CÁO TRA SOÁT SAO KÊ — đúng mẫu brand (dùng lại XLS_STYLES/esc/sheetName/wrapXlsWorkbook
// của revenue-lot-xls, CẤM code trùng). 2 sheet:
//   • "Tổng hoàn đại lý": STT · Đại lý · Số GD · Tổng tiền hoàn — GỘP mọi tài khoản của 1 đại lý về 1 DÒNG (đại lý có
//     2/3/4 STK → 1 dòng tổng). Tiền hoàn RÒNG = Σ DEALER_REFUND(debit) − Σ DEALER_RETURN(credit).
//   • "Chi tiết GD gộp": STT · Ngày · Giờ · Loại · Số tiền(±) · Tên đối ứng · Đại lý/NĐT · Số TK · Ngân hàng · Sao kê —
//     chi tiết TẤT CẢ sao kê đã gộp (đúng bảng tab "Chi tiết GD gộp"), sắp bank→TK→giờ.
import { esc, sheetName, wrapXlsWorkbook } from './revenue-lot-xls';
import type { StmtReconTxn, StmtReconKind } from './ocr-send-api';

const KIND_LABEL: Record<StmtReconKind, string> = { DEALER_REFUND: 'Hoàn đại lý', DEALER_ADVANCE: 'Tạm ứng đại lý', DEALER_RETURN: 'Đại lý hoàn lại', INVESTOR_REPAY: 'Hoàn ứng NĐT', INVESTOR_ADVANCE: 'Tạm ứng NĐT', TRANSFER: 'Chuyển giữa TK', INTEREST: 'Chuyển lãi', CAPITAL: 'Dồn vốn', OTHER: 'Khác', UNKNOWN: 'Chưa khớp' };

function parseWc(s: string | null): { d: string; mo: string; y: string; h: string; mi: string } | null {
  const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s ?? '');
  return m ? { y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5] } : null;
}
const dmy = (s: string | null): string => { const p = parseWc(s); return p ? `${p.d}/${p.mo}/${p.y}` : ''; };
const hm = (s: string | null): string => { const p = parseWc(s); return p ? `${p.h}:${p.mi}` : ''; };
const srcLabel = (t: StmtReconTxn): string => t.srcAccount ? `${t.srcAccount}${t.srcBank ? ' · ' + t.srcBank : ''}` : '';

// Ô helper (StyleID theo kind + zebra).
const cS = (v: string, z: boolean) => `<Cell ss:StyleID="dC${z ? 'z' : ''}"><Data ss:Type="String">${esc(v || '—')}</Data></Cell>`;
const cL = (v: string, z: boolean) => `<Cell ss:StyleID="dL${z ? 'z' : ''}"><Data ss:Type="String">${esc(v || '—')}</Data></Cell>`;
const cM = (n: number, z: boolean) => `<Cell ss:StyleID="dM${z ? 'z' : ''}"><Data ss:Type="Number">${Math.round(n)}</Data></Cell>`;
const cIdx = (i: number, z: boolean) => `<Cell ss:StyleID="dC${z ? 'z' : ''}"><Data ss:Type="Number">${i + 1}</Data></Cell>`;

/** SHEET 1 — Tổng hoàn từng đại lý (GỘP mọi tài khoản → 1 dòng). */
function dealerSummarySheet(txns: StmtReconTxn[], subtitle: string): string {
  // Gộp theo ĐẠI LÝ: ưu tiên matchedCustomerId, fallback tên (bỏ dấu-hoa). Tiền hoàn RÒNG.
  const map = new Map<string, { name: string; net: number; count: number }>();
  for (const t of txns) {
    // [Admin Demo 8/9] Thực hoàn = Hoàn + Tạm-ứng-đại-lý − Đại-lý-hoàn-lại.
    if (t.kind !== 'DEALER_REFUND' && t.kind !== 'DEALER_ADVANCE' && t.kind !== 'DEALER_RETURN') continue;
    const key = t.matchedCustomerId != null ? `c${t.matchedCustomerId}` : `n${(t.matchedName ?? t.cpName ?? '?').trim().toUpperCase()}`;
    const e = map.get(key) ?? { name: t.matchedName ?? t.cpName ?? '?', net: 0, count: 0 };
    e.net += t.kind === 'DEALER_RETURN' ? -t.credit : t.debit; // REFUND + ADVANCE (ra) cộng; RETURN (vào) trừ
    e.count += 1;
    map.set(key, e);
  }
  const list = [...map.values()].sort((a, b) => b.net - a.net);
  const HEAD = ['STT', 'Đại lý', 'Số GD', 'Tổng tiền hoàn'];
  const nCol = HEAD.length;
  const cols = ['40', '220', '64', '130'].map((w) => `<Column ss:Width="${w}"/>`).join('');
  const titleRow = `<Row ss:Height="28"><Cell ss:StyleID="subtitle" ss:MergeAcross="${nCol - 1}"><Data ss:Type="String">${esc(('TỔNG HOÀN ĐẠI LÝ · ' + subtitle).toUpperCase())}</Data></Cell></Row>`;
  const hdr = '<Row>' + HEAD.map((h) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('') + '</Row>';
  const body = list.map((e, i) => {
    const z = i % 2 === 1;
    return '<Row>' + cIdx(i, z) + cL(e.name, z) + cS(String(e.count), z) + cM(e.net, z) + '</Row>';
  }).join('');
  const totNet = list.reduce((s, e) => s + e.net, 0), totCnt = list.reduce((s, e) => s + e.count, 0);
  const totRow = list.length ? `<Row><Cell ss:StyleID="totalLbl"><Data ss:Type="String">TỔNG (${list.length} đại lý)</Data></Cell><Cell ss:StyleID="totalLbl"/><Cell ss:StyleID="totalNum"><Data ss:Type="Number">${totCnt}</Data></Cell><Cell ss:StyleID="totalNum"><Data ss:Type="Number">${Math.round(totNet)}</Data></Cell></Row>` : '';
  const empty = list.length ? '' : `<Row><Cell ss:StyleID="dL" ss:MergeAcross="${nCol - 1}"><Data ss:Type="String">Không có khoản hoàn đại lý trong kỳ.</Data></Cell></Row>`;
  const rowCount = 1 + 1 + list.length + (totRow ? 1 : 0) + (empty ? 1 : 0);
  return `<Worksheet ss:Name="${esc(sheetName('Tổng hoàn đại lý'))}"><Table ss:ExpandedColumnCount="${nCol}" ss:ExpandedRowCount="${rowCount}" ss:DefaultRowHeight="16">` +
    cols + titleRow + hdr + body + totRow + empty + '</Table>' +
    '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><SplitHorizontal>2</SplitHorizontal><TopRowBottomPane>2</TopRowBottomPane></WorksheetOptions></Worksheet>';
}

/** SHEET 2 — Chi tiết GD gộp (tất cả sao kê). */
function detailSheet(txns: StmtReconTxn[], subtitle: string): string {
  const rows = txns; // [Admin Demo 8/9] GIỮ đúng thứ tự đã sắp ở màn (caller truyền rows đã sort theo lọc/sao kê→TK→giờ).
  const HEAD = ['STT', 'Ngày', 'Giờ', 'Loại', 'Số tiền', 'Tên đối ứng', 'Đại lý/NĐT', 'Số TK', 'Ngân hàng', 'Sao kê (nguồn)'];
  const nCol = HEAD.length;
  const cols = ['40', '84', '52', '96', '120', '170', '150', '110', '150', '150'].map((w) => `<Column ss:Width="${w}"/>`).join('');
  const titleRow = `<Row ss:Height="28"><Cell ss:StyleID="subtitle" ss:MergeAcross="${nCol - 1}"><Data ss:Type="String">${esc(('CHI TIẾT GIAO DỊCH GỘP · ' + subtitle).toUpperCase())}</Data></Cell></Row>`;
  const hdr = '<Row>' + HEAD.map((h) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('') + '</Row>';
  const body = rows.map((t, i) => {
    const z = i % 2 === 1;
    const amt = (t.direction === 'OUT' ? -1 : 1) * (t.debit || t.credit);
    return '<Row>' + cIdx(i, z) + cS(dmy(t.dateTime), z) + cS(hm(t.dateTime), z) + cS(KIND_LABEL[t.kind], z) +
      cM(amt, z) + cL(t.cpName || t.descName || '', z) + cL(t.matchedName || '', z) +
      cS(t.cpAccount || '', z) + cS(t.cpBank || '', z) + cS(srcLabel(t), z) + '</Row>';
  }).join('');
  const empty = rows.length ? '' : `<Row><Cell ss:StyleID="dL" ss:MergeAcross="${nCol - 1}"><Data ss:Type="String">Không có giao dịch trong kỳ.</Data></Cell></Row>`;
  const rowCount = 1 + 1 + rows.length + (empty ? 1 : 0);
  const filterRange = rows.length ? `R2C1:R${2 + rows.length}C${nCol}` : '';
  return `<Worksheet ss:Name="${esc(sheetName('Chi tiết GD gộp'))}"><Table ss:ExpandedColumnCount="${nCol}" ss:ExpandedRowCount="${rowCount}" ss:DefaultRowHeight="16">` +
    cols + titleRow + hdr + body + empty + '</Table>' +
    (filterRange ? `<AutoFilter x:Range="${filterRange}" xmlns:x="urn:schemas-microsoft-com:office:excel"/>` : '') +
    '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><SplitHorizontal>2</SplitHorizontal><TopRowBottomPane>2</TopRowBottomPane></WorksheetOptions></Worksheet>';
}

/** Dựng workbook .xls tra soát sao kê (2 sheet) từ danh sách GD đã lọc + nhãn chu kỳ. */
export function buildStatementReconXls(txns: StmtReconTxn[], periodLabel: string): Blob {
  return wrapXlsWorkbook(dealerSummarySheet(txns, periodLabel) + detailSheet(txns, periodLabel));
}
