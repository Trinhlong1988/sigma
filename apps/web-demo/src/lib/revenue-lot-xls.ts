// BÁO CÁO DOANH SỐ CHI TIẾT THEO LÔ — kiểu bảng Excel (Admin Demo 2/9 "bảng chia cột rõ như file Excel + nút tải
// Excel cho đại lý + nhiều sheet theo từng chu kỳ tab, mỗi sheet sắp theo ngày").
//
// Ở đây định nghĩa (a) SHAPE 1 hàng lô dùng CHUNG cho bảng trên màn hình (RevenueLotTable) và cho file Excel;
// (b) CẤU HÌNH CỘT (Admin Demo 2/9): báo cáo NĐT và ĐẠI LÝ dùng BỘ CỘT KHÁC NHAU — NĐT giữ STT·NĐT·Đại lý·…; ĐẠI LÝ
// (phòng chat đại lý) KHÔNG có cột NĐT/Đại lý mà là Tên HKD·Ngân hàng·TID·Số lô·Ngày·Giờ·Trước phí·% phí·Sau phí;
// (c) hàm dựng WORKBOOK NHIỀU SHEET (SpreadsheetML 2003, .xls) THUẦN CHUỖI — KHÔNG thêm dependency nặng (web-demo
// chưa có xlsx/exceljs; exceljs chỉ có ở bot-api server).
//
// GIỜ (Giờ): format "HH:MM" theo TZ VN từ mốc timestamptz có giờ thật (isoToLocalParts). NĐT dùng txn_date; ĐẠI LÝ
// dùng effDateIso = COALESCE(bill_txn_date, created_at). Nguồn không có mốc giờ → time='' → render '—' (KHÔNG bịa).
//
// [Admin Demo 2/9 — VIỆC 4 "tải Excel ra file rỗng"] NGUYÊN NHÂN THẬT (đã tái hiện, KHÔNG đoán): file .xls SpreadsheetML
// bị prepend **BOM UTF-8 (EF BB BF) TRƯỚC `<?xml?>`**. Excel KHÔNG nhận `<?mso-application progid="Excel.Sheet"?>`
// khi có BOM đứng trước prolog → mở file .xls ra TRẮNG (SheetJS/parser khoan dung BOM vẫn đọc đủ 5 hàng → chứng tỏ
// DATA còn nguyên, chỉ Excel từ chối). FIX: BỎ BOM — encoding="UTF-8" trong prolog đủ cho tiếng Việt có dấu. Thêm
// ss:ExpandedColumnCount/ExpandedRowCount + ss:Index tường minh cho ô sau ô gộp (phòng thủ đa phiên bản Excel).

export interface RevenueLotRow {
  ndt: string; // NĐT — '' nếu nguồn không có (render '—')
  daiLy: string; // Đại lý — '' nếu nguồn không có (render '—')
  date: string; // 'YYYY-MM-DD' (LOCAL) — dùng để SẮP theo ngày + hiển thị dd/mm/yyyy
  time: string; // 'HH:MM' — '' nếu nguồn không có giờ (KHÔNG bịa)
  tid: string;
  lo: string;
  /** [Admin Demo 17/9] MÃ YÊU CẦU HOÀN gộp nhiều lô (YC001) — hiện thành CỘT RIÊNG cạnh tiền hoàn sau phí.
   *  null/'' = lô chưa gộp vào yêu cầu nào. */
  maYc?: string | null;
  truoc: number; // Tiền TRƯỚC phí (= gross)
  sau: number; // Tiền SAU phí (= net)
  bankName?: string; // tô màu trên màn hình + cột "Ngân hàng" của báo cáo ĐẠI LÝ
  hkdName?: string; // Tên HKD — cột báo cáo ĐẠI LÝ ('' → '—')
  fee?: number; // phí đã trừ (= gross − net) — để tính cột "% phí" (fee/gross×100). Thiếu → suy từ truoc−sau.
  lai?: number; // [Admin Demo 4/9] LỢI NHUẬN NĐT (số tiền) — để tính cột "% lợi nhuận" (lai/gross×100). Chỉ báo cáo NĐT.
  borrowed?: boolean; // [Admin Demo 7/9] lô MƯỢN TID (đại lý này quẹt nhờ TID đại lý khác) — hiện nhãn "Mượn TID của <chủ>"
  tidOwnerName?: string | null; // tên chủ TID được mượn (đi kèm borrowed)
  /** [Admin Demo 21/9] GHI CHÚ per-lô (pos_lot_recon.note) — ĐỒNG NHẤT bảng lô ĐL / báo cáo NĐT / danh sách hoàn
   *  tiền: một nguồn, sửa ở đâu các bảng kia thấy ngay. loId để lưu ghi chú về đúng lô. */
  loId?: number | null;
  note?: string | null;
}

export interface RevenueSheetInput {
  name: string; // tên sheet (chu kỳ: Hôm nay / Hôm qua / Tuần này...) — tối đa 31 ký tự, không [ ] : * ? / \
  subtitle?: string; // dòng phụ (vd khoảng ngày) hiện ở đầu sheet
  rows: RevenueLotRow[];
}

// ─── CẤU HÌNH CỘT (dùng CHUNG cho bảng màn hình + Excel để 1 nguồn thứ tự/nhãn) ──────────────────────────────
export type RevenueLotColumnKey = 'stt' | 'ndt' | 'daiLy' | 'hkd' | 'bank' | 'tid' | 'lo' | 'date' | 'time' | 'truoc' | 'pct' | 'sau' | 'loiNhuan' | 'laiTien' | 'maYc' | 'ghiChu';

/** Bộ cột báo cáo NHÀ ĐẦU TƯ (CŨ — giữ cho tương thích XLS cũ nếu còn dùng). */
export const INVESTOR_COLUMNS: RevenueLotColumnKey[] = ['stt', 'ndt', 'daiLy', 'date', 'time', 'tid', 'lo', 'truoc', 'sau'];
/** Bộ cột báo cáo ĐẠI LÝ (Admin Demo 2/9 — KHÔNG có NĐT/Đại lý): Tên HKD · Ngân hàng · TID · Số lô · Ngày · Giờ ·
 *  Tiền trước phí · % phí · Sau phí (phải hoàn). */
export const AGENT_COLUMNS: RevenueLotColumnKey[] = ['hkd', 'bank', 'tid', 'lo', 'date', 'time', 'truoc', 'pct', 'sau', 'maYc', 'ghiChu']; // [21/9] + Ghi chú (đồng nhất ĐL/NĐT/hoàn tiền)
/** [Admin Demo 7/9] Bộ cột EXCEL đại lý = AGENT_COLUMNS + STT đầu (chỉ file Excel; bảng MÀN HÌNH giữ không-STT để không lệch cột). */
export const AGENT_XLS_COLUMNS: RevenueLotColumnKey[] = ['stt', 'hkd', 'bank', 'tid', 'lo', 'date', 'time', 'truoc', 'pct', 'sau', 'maYc', 'ghiChu']; // [21/9] + Mã YC + Ghi chú (khớp bảng màn hình — Admin Demo "ghi chú phải hiện trong file excel")
/** [Admin Demo 4/9] Bộ cột CHI TIẾT NĐT — GIỐNG đại lý (HKD·Bank·TID·Lô·Ngày·Giờ·Trước phí·% phí cài·Tiền về) + thêm
 *  cột % LỢI NHUẬN NĐT. BỎ cột "NĐT" (đã mặc định NĐT) + "Đại lý". */
export const INVESTOR_DETAIL_COLUMNS: RevenueLotColumnKey[] = ['hkd', 'bank', 'tid', 'lo', 'date', 'time', 'truoc', 'pct', 'sau', 'laiTien', 'loiNhuan', 'ghiChu']; // [21/9] + Ghi chú (đồng nhất)

export type ColKind = 'index' | 'string' | 'money' | 'pct';
export interface ColMeta {
  header: string; // nhãn tiêu đề mặc định
  align: 'left' | 'right' | 'center';
  kind: ColKind;
  xlsWidth: number; // độ rộng cột Excel (points)
  grid: string; // track chiều rộng cho CSS grid màn hình
}
export const COLUMN_META: Record<RevenueLotColumnKey, ColMeta> = {
  stt: { header: 'STT', align: 'center', kind: 'index', xlsWidth: 40, grid: '44px' },
  ndt: { header: 'NĐT', align: 'left', kind: 'string', xlsWidth: 150, grid: 'minmax(90px,1.2fr)' },
  daiLy: { header: 'Đại lý', align: 'left', kind: 'string', xlsWidth: 150, grid: 'minmax(90px,1.2fr)' },
  // [Admin Demo 16/9 tối "cột ngân hàng lùi sang trái gần tên HKD để dãn rộng"] HKD bớt co giãn + NGÂN HÀNG canh
  // TRÁI hẹp lại → sát tên HKD, nhường chỗ cho cột TIỀN (trước đây số bị nút/chip cột thao tác đè cắt mất).
  hkd: { header: 'Tên HKD', align: 'left', kind: 'string', xlsWidth: 170, grid: 'minmax(88px,1.1fr)' },
  bank: { header: 'Ngân hàng', align: 'left', kind: 'string', xlsWidth: 110, grid: 'minmax(64px,0.62fr)' },
  tid: { header: 'TID', align: 'center', kind: 'string', xlsWidth: 100, grid: 'minmax(84px,1fr)' },
  lo: { header: 'Số lô', align: 'center', kind: 'string', xlsWidth: 64, grid: 'minmax(66px,0.8fr)' },
  date: { header: 'Ngày', align: 'center', kind: 'string', xlsWidth: 84, grid: '82px' },
  time: { header: 'Giờ', align: 'center', kind: 'string', xlsWidth: 52, grid: '54px' },
  truoc: { header: 'Tiền trước phí', align: 'right', kind: 'money', xlsWidth: 112, grid: 'minmax(92px,1.05fr)' },
  pct: { header: '% phí', align: 'right', kind: 'pct', xlsWidth: 64, grid: '66px' },
  sau: { header: 'Sau phí', align: 'right', kind: 'money', xlsWidth: 112, grid: 'minmax(100px,1.1fr)' },
  laiTien: { header: 'Thành tiền lãi', align: 'right', kind: 'money', xlsWidth: 112, grid: 'minmax(92px,1fr)' },
  loiNhuan: { header: '% lợi nhuận', align: 'right', kind: 'pct', xlsWidth: 84, grid: '88px' },
  // [Admin Demo 17/9] "thêm 1 trường mã YC bên cạnh số tiền hoàn sau phí" — CỘT RIÊNG (không nhét vào cột thao tác,
  // nhét vào đó thì chip ĐÈ LÊN SỐ TIỀN ở màn hẹp — đã thấy ở 1366px).
  maYc: { header: 'Mã YC', align: 'center', kind: 'string', xlsWidth: 80, grid: 'minmax(74px,0.7fr)' },
  ghiChu: { header: 'Ghi chú', align: 'left', kind: 'string', xlsWidth: 140, grid: 'minmax(96px,1.1fr)' }
};

/** Phí đã trừ của 1 hàng — ưu tiên fee, thiếu thì suy truoc−sau (không âm). */
export function rowFee(r: RevenueLotRow): number {
  return r.fee != null ? r.fee : Math.max(0, r.truoc - r.sau);
}
/** Nhãn "% phí" = fee/gross×100. [Admin Demo 7/9 FIX] TRƯỚC toFixed(1) → 1.25% BỊ LÀM TRÒN thành "1.3%" (round-half-up)
 *  dù phí THẬT đúng 1.2500%. Nay 2 chữ số + BỎ số 0 thừa: 1.25→"1.25", 1.40→"1.4", 1.50→"1.5". gross=0 → '—'. */
export function pctLabel(r: RevenueLotRow): string {
  if (!r.truoc || r.truoc <= 0) return '—';
  const pct = ((rowFee(r) / r.truoc) * 100).toFixed(2).replace(/\.?0+$/, '');
  return `${pct}%`;
}
/** [Admin Demo 4/9] Nhãn "% lợi nhuận" NĐT = lai/gross×100 (2 chữ số — lãi ~0,1% cần độ chính xác). Thiếu lai/gross=0 → '—'. */
export function loiNhuanLabel(r: RevenueLotRow): string {
  if (!r.truoc || r.truoc <= 0 || r.lai == null) return '—';
  return `${((r.lai / r.truoc) * 100).toFixed(2)}%`;
}
/** Giá trị 1 ô THEO cột (string) cho render/Excel không phải money. */
function dashStr(s: string | undefined): string {
  return s && s.trim() !== '' ? s : '—';
}
export function cellText(key: RevenueLotColumnKey, r: RevenueLotRow, index: number): string {
  switch (key) {
    case 'stt': return String(index + 1);
    case 'ndt': return dashStr(r.ndt);
    case 'daiLy': return dashStr(r.daiLy);
    // [Admin Demo 7/9] Excel: lô MƯỢN TID → kèm "(Mượn của <chủ>)" ngay cột HKD để đối soát thấy trạng thái mượn.
    case 'hkd': return r.borrowed ? `${dashStr(r.hkdName)} (Mượn của ${r.tidOwnerName ?? '?'})` : dashStr(r.hkdName);
    case 'bank': return dashStr(r.bankName);
    case 'tid': return dashStr(r.tid);
    case 'lo': return dashStr(r.lo);
    case 'maYc': return dashStr(r.maYc ?? '');
    case 'ghiChu': return dashStr(r.note ?? '');
    case 'date': return ymdToDmy(r.date);
    case 'time': return dashStr(r.time);
    case 'pct': return pctLabel(r);
    case 'truoc': return String(Math.round(r.truoc));
    case 'sau': return String(Math.round(r.sau));
    case 'laiTien': return String(Math.round(r.lai ?? 0));
    case 'loiNhuan': return loiNhuanLabel(r);
  }
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' (VN). Chuỗi khác → trả nguyên. */
export function ymdToDmy(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

/** ISO (UTC) → { date:'YYYY-MM-DD', time:'HH:MM' } theo giờ VIỆT NAM (Asia/Ho_Chi_Minh) — KHÔNG dùng slice(0,10)
 *  của chuỗi UTC (bill lúc nửa đêm sẽ lệch NGÀY). Nguồn không parse được → date/time = ''. */
export function isoToLocalParts(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  let hh = get('hour');
  if (hh === '24') hh = '00'; // en-CA đôi khi trả '24' cho nửa đêm
  return { date, time: `${hh}:${get('minute')}` };
}

const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
// [Admin Demo 8/9] EXPORT esc/sheetName/style/wrapper để BÁO CÁO SAO KÊ dùng CHUNG bộ style brand (cấm code trùng).
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESC[c]);
}
/** Tên sheet hợp lệ SpreadsheetML: bỏ ký tự cấm, cắt 31 ký tự. */
export function sheetName(name: string): string {
  return (name.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31);
}

// [Admin Demo 7/9] Viền ĐỦ 4 cạnh mọi ô (lưới rõ). Dùng chung mọi báo cáo Excel brand.
export const XLS_BORDERS = '<Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C7D0DB"/><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C7D0DB"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C7D0DB"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C7D0DB"/></Borders>';
const XLS_ZEBRA = '#EAF2FC'; // xanh nhạt brand (#1877D6)
/** Bộ STYLE brand DÙNG CHUNG (hdr xanh, zebra, tổng, section, bảng phụ). */
export const XLS_STYLES =
  '<Styles>' +
  '<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="11"/></Style>' +
  '<Style ss:ID="hdr"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1877D6" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>' + XLS_BORDERS + '</Style>' +
  '<Style ss:ID="subtitle"><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#0F5FB0"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Interior ss:Color="#F1F6FC" ss:Pattern="Solid"/>' + XLS_BORDERS + '</Style>' +
  '<Style ss:ID="dL"><NumberFormat ss:Format="@"/>' + XLS_BORDERS + '<Alignment ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="dLz"><NumberFormat ss:Format="@"/><Interior ss:Color="' + XLS_ZEBRA + '" ss:Pattern="Solid"/>' + XLS_BORDERS + '<Alignment ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="dC"><NumberFormat ss:Format="@"/>' + XLS_BORDERS + '<Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="dCz"><NumberFormat ss:Format="@"/><Interior ss:Color="' + XLS_ZEBRA + '" ss:Pattern="Solid"/>' + XLS_BORDERS + '<Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="dR"><NumberFormat ss:Format="@"/>' + XLS_BORDERS + '<Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="dRz"><NumberFormat ss:Format="@"/><Interior ss:Color="' + XLS_ZEBRA + '" ss:Pattern="Solid"/>' + XLS_BORDERS + '<Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="dM"><NumberFormat ss:Format="#,##0"/>' + XLS_BORDERS + '<Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="dMz"><NumberFormat ss:Format="#,##0"/><Interior ss:Color="' + XLS_ZEBRA + '" ss:Pattern="Solid"/>' + XLS_BORDERS + '<Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="totalLbl"><Font ss:Bold="1" ss:Color="#1F2937"/><Interior ss:Color="#DCE6F5" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/>' + XLS_BORDERS + '</Style>' +
  '<Style ss:ID="totalNum"><NumberFormat ss:Format="#,##0"/><Font ss:Bold="1"/><Interior ss:Color="#DCE6F5" ss:Pattern="Solid"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/>' + XLS_BORDERS + '</Style>' +
  '<Style ss:ID="secTitle"><Font ss:Bold="1" ss:Color="#1F2937"/><Interior ss:Color="#DCE6F5" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>' + XLS_BORDERS + '</Style>' +
  '<Style ss:ID="sHdr"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1877D6" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>' + XLS_BORDERS + '</Style>' +
  '<Style ss:ID="sC"><NumberFormat ss:Format="@"/>' + XLS_BORDERS + '<Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="sL"><NumberFormat ss:Format="@"/>' + XLS_BORDERS + '<Alignment ss:Vertical="Center"/></Style>' +
  '<Style ss:ID="sM"><NumberFormat ss:Format="#,##0"/>' + XLS_BORDERS + '<Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style>' +
  '</Styles>';
/** Bọc WORKBOOK SpreadsheetML từ chuỗi các <Worksheet> + style brand chung → Blob .xls. KHÔNG BOM (Excel mở trắng). */
export function wrapXlsWorkbook(worksheetsXml: string): Blob {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office"' +
    ' xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"' +
    ' xmlns:html="http://www.w3.org/TR/REC-html40">' + XLS_STYLES + worksheetsXml + '</Workbook>';
  return new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
}
/** 1 ô dữ liệu theo KIND + ZEBRA (parity dòng). money → Number (cộng được); index → Number; còn lại → String. */
function dataCell(key: RevenueLotColumnKey, r: RevenueLotRow, index: number, zebra: boolean): string {
  const meta = COLUMN_META[key];
  const z = zebra ? 'z' : '';
  if (meta.kind === 'money') return `<Cell ss:StyleID="dM${z}"><Data ss:Type="Number">${Math.round(key === 'truoc' ? r.truoc : r.sau)}</Data></Cell>`;
  if (meta.kind === 'index') return `<Cell ss:StyleID="dC${z}"><Data ss:Type="Number">${index + 1}</Data></Cell>`;
  const styleBase = meta.align === 'right' ? 'dR' : meta.align === 'center' ? 'dC' : 'dL';
  return `<Cell ss:StyleID="${styleBase}${z}"><Data ss:Type="String">${esc(cellText(key, r, index))}</Data></Cell>`;
}

function sheetXml(input: RevenueSheetInput, columns: RevenueLotColumnKey[]): string {
  const rows = [...input.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const nCol = columns.length;
  const cols = columns.map((k) => `<Column ss:Width="${COLUMN_META[k].xlsWidth}"/>`).join('');

  // [Admin Demo 7/9] Tiêu đề HOA + căn giữa + hàng CAO (Height 28).
  const titleRow = input.subtitle
    ? `<Row ss:Height="28"><Cell ss:StyleID="subtitle" ss:MergeAcross="${nCol - 1}"><Data ss:Type="String">${esc(input.subtitle.toUpperCase())}</Data></Cell></Row>`
    : '';

  // [Admin Demo 7/9] BẢNG TỔNG THEO TID (như NĐT): mỗi TID 1 dòng (Tên HKD·NH·TID·Số lô·Tổng trước phí·Sau phí) + TỔNG.
  const byTid = new Map<string, { tid: string; hkd: string; bank: string; cnt: number; gross: number; net: number }>();
  for (const r of rows) {
    const e = byTid.get(r.tid) ?? { tid: r.tid, hkd: r.hkdName ?? '', bank: r.bankName ?? '', cnt: 0, gross: 0, net: 0 };
    e.cnt += 1; e.gross += r.truoc; e.net += r.sau;
    if (!e.hkd && r.hkdName) e.hkd = r.hkdName; if (!e.bank && r.bankName) e.bank = r.bankName;
    byTid.set(r.tid, e);
  }
  const sumList = [...byTid.values()].sort((a, b) => (a.bank === b.bank ? a.tid.localeCompare(b.tid) : a.bank.localeCompare(b.bank)));
  const SUM_HEAD = ['Tên HKD', 'Ngân hàng', 'TID', 'Số lô', 'Tổng trước phí', 'Sau phí'];
  let summaryBlock = '';
  if (sumList.length > 0) {
    const sHdr = `<Row><Cell ss:StyleID="secTitle" ss:MergeAcross="${nCol - 1}"><Data ss:Type="String">TỔNG DOANH SỐ THEO TID (${sumList.length} máy)</Data></Cell></Row>`;
    const sCols = `<Row>${SUM_HEAD.map((h) => `<Cell ss:StyleID="sHdr"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('')}</Row>`;
    const sRows = sumList.map((e) =>
      `<Row><Cell ss:StyleID="sL"><Data ss:Type="String">${esc(e.hkd || '—')}</Data></Cell>` +
      `<Cell ss:StyleID="sC"><Data ss:Type="String">${esc(e.bank || '—')}</Data></Cell>` +
      `<Cell ss:StyleID="sC"><Data ss:Type="String">${esc(e.tid)}</Data></Cell>` +
      `<Cell ss:StyleID="sC"><Data ss:Type="Number">${e.cnt}</Data></Cell>` +
      `<Cell ss:StyleID="sM"><Data ss:Type="Number">${Math.round(e.gross)}</Data></Cell>` +
      `<Cell ss:StyleID="sM"><Data ss:Type="Number">${Math.round(e.net)}</Data></Cell></Row>`
    ).join('');
    const sTotGross = sumList.reduce((s, e) => s + e.gross, 0), sTotNet = sumList.reduce((s, e) => s + e.net, 0);
    const sTot = `<Row><Cell ss:StyleID="totalLbl"><Data ss:Type="String">TỔNG</Data></Cell><Cell ss:StyleID="totalLbl"/><Cell ss:StyleID="totalLbl"/><Cell ss:StyleID="totalNum"><Data ss:Type="Number">${rows.length}</Data></Cell><Cell ss:StyleID="totalNum"><Data ss:Type="Number">${Math.round(sTotGross)}</Data></Cell><Cell ss:StyleID="totalNum"><Data ss:Type="Number">${Math.round(sTotNet)}</Data></Cell></Row>`;
    summaryBlock = sHdr + sCols + sRows + sTot + '<Row/>'; // + hàng trắng phân cách
  }

  // CHI TIẾT THEO LÔ — header + data ZEBRA + tổng.
  const detailTitle = rows.length > 0 ? `<Row><Cell ss:StyleID="secTitle" ss:MergeAcross="${nCol - 1}"><Data ss:Type="String">CHI TIẾT THEO LÔ (${rows.length})</Data></Cell></Row>` : '';
  const headerRow = '<Row>' + columns.map((k) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${esc(COLUMN_META[k].header)}</Data></Cell>`).join('') + '</Row>';
  const body = rows.map((r, i) => '<Row>' + columns.map((k) => dataCell(k, r, i, i % 2 === 1)).join('') + '</Row>').join('');
  const totalTruoc = rows.reduce((s, r) => s + r.truoc, 0), totalSau = rows.reduce((s, r) => s + r.sau, 0);
  const totalRow = rows.length > 0
    ? '<Row>' + columns.map((k, i) => COLUMN_META[k].kind === 'money'
      ? `<Cell ss:StyleID="totalNum"><Data ss:Type="Number">${Math.round(k === 'truoc' ? totalTruoc : totalSau)}</Data></Cell>`
      : i === 0 ? `<Cell ss:StyleID="totalLbl"><Data ss:Type="String">TỔNG (${rows.length} lô)</Data></Cell>` : '<Cell ss:StyleID="totalLbl"/>'
    ).join('') + '</Row>'
    : '';
  const emptyRow = rows.length === 0 ? `<Row><Cell ss:StyleID="dL" ss:MergeAcross="${nCol - 1}"><Data ss:Type="String">Không có lô nào trong kỳ.</Data></Cell></Row>` : '';

  // summaryBlock = sHdr(1)+sCols(1)+sRows(N)+sTot(1)+blank(1) = N+4 dòng.
  const preRows = (titleRow ? 1 : 0) + (summaryBlock ? sumList.length + 4 : 0) + (detailTitle ? 1 : 0);
  const rowCount = preRows + 1 /*header*/ + rows.length + (totalRow ? 1 : 0) + (emptyRow ? 1 : 0);
  // [Admin Demo 7/9] AUTOFILTER trên hàng header chi tiết (lọc sẵn). Header ở dòng preRows+1 (1-based). Range → hết data.
  const hdrRowIdx = preRows + 1;
  const lastDataRow = hdrRowIdx + rows.length;
  const filterRange = rows.length > 0 ? `R${hdrRowIdx}C1:R${lastDataRow}C${nCol}` : '';
  return (
    `<Worksheet ss:Name="${esc(sheetName(input.name))}">` +
    `<Table ss:ExpandedColumnCount="${nCol}" ss:ExpandedRowCount="${rowCount}" ss:DefaultRowHeight="16">` +
    cols + titleRow + summaryBlock + detailTitle + headerRow + body + totalRow + emptyRow +
    '</Table>' +
    (filterRange ? `<AutoFilter x:Range="${filterRange}" xmlns:x="urn:schemas-microsoft-com:office:excel"/>` : '') +
    '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane></WorksheetOptions>' +
    '</Worksheet>'
  );
}

/** Dựng WORKBOOK NHIỀU SHEET (SpreadsheetML 2003) → Blob .xls. Mỗi phần tử `sheets` = 1 chu kỳ tab.
 *  `columns`: bộ cột (mặc định NĐT). Báo cáo ĐẠI LÝ truyền AGENT_COLUMNS. */
export function buildRevenueWorkbookXls(sheets: RevenueSheetInput[], columns: RevenueLotColumnKey[] = INVESTOR_COLUMNS): Blob {
  // [Admin Demo 8/9] Style brand + wrapper CHUNG (XLS_STYLES/wrapXlsWorkbook) — báo cáo sao kê dùng lại cùng bộ (cấm code trùng).
  return wrapXlsWorkbook(sheets.map((s) => sheetXml(s, columns)).join(''));
}
