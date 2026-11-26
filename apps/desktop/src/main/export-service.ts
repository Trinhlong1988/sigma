// XUẤT EXCEL CHUẨN NHÀ sigma (R38/R39 Admin Demo 11/7) — .xlsx THẬT bằng exceljs (KHÔNG còn .xls-HTML giả
// gây cảnh báo Yes/No khi mở). Tông màu khớp renmap/quản-lý-tài-khoản: tiêu đề xanh #2E75B6 chữ trắng, hàng
// tổng hợp vàng kem, tên cột IN HOA nền xanh nhạt + LỌC (autofilter) + đóng băng, kẻ ô mảnh, dòng lẻ xám nhạt,
// Times New Roman 11pt. Trang A4 DỌC, fit-to-width 1 trang. Dùng cho cả bảng dữ liệu lẫn MẪU nhập (headers-only).
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

type Align = 'left' | 'center' | 'right';
// Chuỗi trông như TIỀN: TOÀN BỘ là số + phân tách + (tùy chọn) ký hiệu tiền ở cuối, VÀ có phân tách nghìn
// hoặc ký hiệu tiền. CẨN THẬN: "đ" là CHỮ CÁI tiếng Việt phổ biến ("Đang hoạt động", "đối tác") → KHÔNG
// được coi mọi chuỗi chứa "đ" là tiền; phải neo ký hiệu tiền ở CUỐI sau chuỗi số. Cũng loại SĐT/mã số thuần.
function isMoneyString(v: Cell): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!/\d/.test(s)) return false;
  if (!/^[\d.,\s]+(\s?(₫|đ|VND))?$/i.test(s)) return false; // toàn số/phân tách, tiền chỉ ở cuối
  return /\d[.,]\d{3}(\D|$)/.test(s) || /(₫|đ|VND)\s*$/i.test(s); // có phân tách nghìn hoặc ký hiệu tiền
}
// Căn cột THEO KIỂU dữ liệu (R44 + "số tiền căn phải", Admin Demo):
//   • TIỀN/số lớn (number ≥1000, số lẻ, hoặc chuỗi tiền có phân tách) → PHẢI;
//   • STT/đếm nhỏ (số nguyên <1000) → GIỮA;
//   • mã/SĐT/trạng thái/ngày (chuỗi ngắn ≤16) → GIỮA;  • tên/địa chỉ (dài >16) → TRÁI.
function colAligns(rows: Cell[][], N: number): Align[] {
  const aligns: Align[] = [];
  for (let ci = 0; ci < N; ci++) {
    let has = false, maxLen = 0, allRightable = true, allSmallInt = true;
    for (const r of rows) {
      const v = r[ci];
      if (v == null || v === '') continue;
      has = true;
      maxLen = Math.max(maxLen, String(v).length);
      const isNum = typeof v === 'number';
      const money = isMoneyString(v);
      if (!isNum && !money) allRightable = false;
      if (money) allSmallInt = false;
      else if (isNum) { if (!Number.isInteger(v) || Math.abs(v) >= 1000) allSmallInt = false; }
      else allSmallInt = false;
    }
    if (!has) aligns.push('center');
    else if (allRightable && !allSmallInt) aligns.push('right'); // TIỀN / số lớn
    else if (allRightable && allSmallInt) aligns.push('center'); // STT / đếm nhỏ
    else if (maxLen > 16) aligns.push('left'); // tên/địa chỉ dài
    else aligns.push('center'); // mã/SĐT/trạng thái/ngày
  }
  return aligns;
}

// R43: chặn "chấm vàng/tam giác — Number stored as text" khi ô là chuỗi số (SĐT/mã/MST giữ nguyên text).
// exceljs không expose ignoredErrors → chèn thẳng vào sheet XML (đúng vị trí schema: trước </worksheet>).
async function suppressNumberAsTextWarning(buf: Buffer, sqref: string): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const path = 'xl/worksheets/sheet1.xml';
    const file = zip.file(path);
    if (!file) return buf;
    let xml = await file.async('string');
    if (!xml.includes('<ignoredErrors>')) {
      const tag = `<ignoredErrors><ignoredError sqref="${sqref}" numberStoredAsText="1"/></ignoredErrors>`;
      xml = xml.replace('</worksheet>', tag + '</worksheet>');
      zip.file(path, xml);
    }
    // BẢN WEB (6/11): file này được BUNDLE CHO TRÌNH DUYỆT (web-shim/api.ts dùng chung để giữ ĐÚNG định dạng
    // Excel chuẩn nhà). Trình duyệt KHÔNG có `Buffer` của Node → JSZip chỉ xuất được 'arraybuffer'. Điều kiện
    // `typeof Buffer === 'undefined'` KHỚP CHÍNH XÁC phép thử khả-dụng của JSZip (support.nodebuffer), nên trong
    // Electron/Node vẫn là 'nodebuffer' y như cũ (KHÔNG đổi hành vi desktop).
    const kieuZip = (typeof Buffer === 'undefined' ? 'arraybuffer' : 'nodebuffer') as 'nodebuffer';
    return (await zip.generateAsync({ type: kieuZip })) as Buffer;
  } catch {
    return buf; // an toàn: lỗi hậu xử lý không làm hỏng file
  }
}

// [B232 22/11 — Admin Demo "chỉn lại brand báo cáo từng NĐT phải đẹp, rõ ràng"] Lấy ĐÚNG màu brand SigMa
// trong `apps/desktop/src/renderer/src/brand.css`: brand #1877d6 · brand-deep #1763a5 · tint #eaf4fb.
// Font đổi Times New Roman → Calibri: Times là font sách, nhìn cũ; Calibri có sẵn trong mọi bản Office.
const FONT = 'Calibri';
const C_TITLE = 'FF1877D6'; // brand SigMa
const C_SUMMARY = 'FFEAF4FB'; // brand-tint (thay vàng kem cũ)
const C_HEADER = 'FFD2E7F7'; // brand nhạt cho hàng tên cột
const C_ZEBRA = 'FFF4FAFE'; // sọc rất nhạt — đọc số tiền không bị chói // Admin Demo 13/7 "mỗi hàng 1 màu xanh và trắng" — xanh nhạt rõ (trước là xám gần trắng)
const THIN = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

export type Cell = string | number | null | undefined;
export interface ReportInput {
  title: string; // tiêu đề (sẽ IN HOA)
  headers: string[]; // nhãn cột (sẽ IN HOA)
  rows: Cell[][];
  summary?: string; // dòng tổng hợp; nếu bỏ trống tự sinh "Tổng: N dòng • Ngày xuất: dd/mm/yyyy"
  /** [B228 22/11 — Admin Demo] KHỐI PHỤ xếp DƯỚI CÙNG bảng chính (vd tổng doanh số từng TID theo ca / theo ngày). */
  khoiPhu?: { tieuDe: string; headers: string[]; rows: Cell[][]; coHangTong?: boolean }[];
  /** Tên tab của sheet (khi xuất nhiều sheet). Mặc định "Dữ liệu". */
  sheetName?: string;
  /** [B232] Tên cột chứa TIỀN → định dạng `#,##0` (có dấu chấm ngăn nghìn) + nới bề ngang 30%. */
  cotTien?: string[];
  /** [B232] Tên cột cần nới thêm 30% bề ngang (vd HKD — tên dài hay bị cắt). */
  cotRong?: string[];
  /** [B232] Tên cột CĂN GIỮA (vd các cột %). */
  cotGiua?: string[];
}
export interface TemplateInput {
  title: string;
  headers: string[];
  hints?: { header: string; required?: boolean; hint?: string }[]; // để dựng sheet "Hướng dẫn"
  /**
   * [Admin Demo 15/11] Cột nào có DANH MỤC SẴN thì cho CHỌN thay vì gõ tay: {tên cột → danh sách giá trị}.
   * Gõ tay ngành nghề/ngân hàng/đối tác là nguồn lỗi nhập liệu số 1 (sai 1 chữ là cả dòng đỏ khi nhập lại).
   */
  chon?: Record<string, string[]>;
}

function fmtVNDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function pageSetup(): ExcelJS.Worksheet['pageSetup'] {
  return { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
}
function colWidths(headers: string[], rows: Cell[][]): number[] {
  return headers.map((h, i) => {
    let max = h.length;
    for (const r of rows) {
      const v = r[i];
      const len = v == null ? 0 : String(v).length;
      if (len > max) max = len;
    }
    // Trần 42: cột chữ dài hơn thì WRAP xuống dòng và hàng tự cao lên (B32). Nâng trần lên 50 thì tên
    // 44 ký tự nằm gọn 1 dòng ⇒ mất hành vi wrap đã chốt từ trước — đã làm đỏ bài kiểm B32 ngày 22/11.
    return Math.min(42, Math.max(6, max + 2));
  });
}
// Số dòng 1 ô văn bản CHIẾM khi wrap ở độ rộng cột `width` (ước theo ký tự — đủ để KHÔNG che chữ).
function wrapLines(text: string, width: number): number {
  const w = Math.max(4, Math.floor(width) - 1);
  let lines = 0;
  for (const seg of String(text).split('\n')) lines += Math.max(1, Math.ceil(seg.length / w));
  return lines;
}
// Chiều cao hàng đủ chứa ô wrap NHIỀU DÒNG NHẤT (11pt ≈ 15pt/dòng). base = tối thiểu.
function rowHeightFor(values: (Cell | string)[], widths: number[], base: number): number {
  let maxLines = 1;
  values.forEach((v, i) => {
    if (v == null || v === '') return;
    const lines = wrapLines(String(v), widths[i] ?? 12);
    if (lines > maxLines) maxLines = lines;
  });
  return Math.max(base, maxLines * 18 + 6); // 13pt ≈ 18pt/dòng
}

/** [B298 24/11 — agent Excel] Tên tab hợp lệ DÙNG CHUNG: exceljs NÉM khi tên chứa : \ / ? * [ ]
 *  (bộ lọc cũ ở multi-sheet SÓT dấu \, còn đường 1-sheet KHÔNG lọc gì — tên NĐT "Cty A/B" là mất cả
 *  lần xuất). Kèm NFC để 2 dạng Unicode tiếng Việt không sinh tên lệch. */
function tenSheetHopLe(raw: string | undefined, fallback: string): string {
  return (raw || fallback).normalize('NFC').replace(/[:\/?*[\]]/g, '-').slice(0, 28).trim() || fallback;
}

/** Dựng bảng dữ liệu chuẩn nhà → Buffer .xlsx. */
export async function buildReportWorkbook(input: ReportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // [B298-fix 24/11] CHỈ lọc tên khi THỰC SỰ có sheetName — không có thì để veSheet dùng default 'Dữ
  // liệu' (title là TIÊU ĐỀ bảng in trong sheet, KHÔNG phải tên tab). Trước đây fallback về title làm
  // tab đổi tên, vỡ 11 test layout.
  const vung = veSheet(wb, input.sheetName ? { ...input, sheetName: tenSheetHopLe(input.sheetName, 'Dữ liệu') } : input);
  const buf = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  return vung ? suppressNumberAsTextWarning(buf, vung) : buf;
}

/**
 * [B228 22/11 — Admin Demo "nút tích tách từng sheet, mỗi sheet 1 NĐT"] Dựng NHIỀU SHEET trong một file.
 * Mỗi phần tử = một tab, dùng ĐÚNG khuôn vẽ của bảng 1 sheet (cùng màu, cùng cỡ chữ, cùng khối phụ).
 */
export async function buildMultiSheetWorkbook(sheets: ReportInput[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const dsVung: string[] = [];
  const daDung = new Set<string>();
  for (const sh of sheets) {
    // Tên tab Excel: tối đa 31 ký tự, CẤM : \ / ? * [ ] và không được trùng nhau.
    let ten = tenSheetHopLe(sh.sheetName || sh.title, 'Dữ liệu'); // [B298] dùng chung bộ lọc (bản cũ sót dấu \)
    let i = 2;
    while (daDung.has(ten.toLowerCase())) ten = ten.slice(0, 25) + ' (' + i++ + ')';
    daDung.add(ten.toLowerCase());
    const vung = veSheet(wb, { ...sh, sheetName: ten });
    if (vung) dsVung.push(vung);
  }
  const buf = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  // Bỏ cảnh báo "số lưu dạng text" cho sheet ĐẦU (hàm vá XML hiện chỉ vá 1 sheet) — không ảnh hưởng số liệu.
  return dsVung.length ? suppressNumberAsTextWarning(buf, dsVung[0]) : buf;
}

/** Vẽ MỘT sheet theo khuôn chuẩn nhà. Trả vùng dữ liệu (để bỏ cảnh báo số-dạng-text), null nếu rỗng. */
function veSheet(wb: ExcelJS.Workbook, input: ReportInput): string | null {
  const headers = input.headers.map((h) => h.toUpperCase());
  const N = Math.max(1, headers.length);
  const lastCol = numToCol(N);
  const ws = wb.addWorksheet(input.sheetName || 'Dữ liệu', { views: [{ state: 'frozen', ySplit: 3 }], pageSetup: pageSetup() });
  // [B232] Nới bề ngang theo yêu cầu Admin Demo: cột TIỀN +30% (số dài, có dấu chấm ngăn nghìn),
  // cột khai trong `cotRong` +30% (HKD — tên dài hay bị cắt mất đuôi).
  // [B298] NFC: header NFC mà cotTien NFD (mắt nhìn y hệt) từng làm Math.min(tập rỗng)=Infinity ⇒ nổ
  // "16385 is out of bounds" ngay lúc dựng file (lớp B248).
  const hoaTen = (x: string): string => x.normalize('NFC').trim().toUpperCase();
  const laTien = new Set((input.cotTien ?? []).map(hoaTen));
  const laRong = new Set((input.cotRong ?? []).map(hoaTen));
  const laGiua = new Set((input.cotGiua ?? []).map(hoaTen));
  const widths = colWidths(input.headers, input.rows).map((w, i) => {
    const ten = hoaTen(input.headers[i] ?? '');
    let r = laTien.has(ten) || laRong.has(ten) ? Math.round(w * 1.3) : w;
    // [B232 22/11 — Admin Demo "hàng tiêu đề bị tràn cao, dãn cao rộng cho đủ"] Tên cột viết IN HOA + IN ĐẬM
    // cỡ 13 nên RỘNG HƠN ~30% so với đơn vị bề ngang (tính theo chữ thường cỡ 11). Không cộng bù thì tên
    // cột xuống dòng ⇒ hàng tiêu đề cao vống. Bảo đảm cột đủ chứa tên cột trên MỘT dòng.
    // +3 là chỗ cho NÚT LỌC (mũi tên AutoFilter) nằm đè mép phải ô tiêu đề. Không chừa thì tên cột bị
    // nút che mất chữ cuối — nhìn ảnh 22/11 thấy "NGÀY"→"NGÀ", "% MUA"→"% MU", "ĐÃ HOÀN" cụt đuôi.
    const canChoTen = Math.ceil((input.headers[i] ?? '').length * 1.3) + 2 + 3;
    if (r < canChoTen) r = canChoTen;
    r = Math.min(60, r);
    // BẪY exceljs (đo 22/11, thử 3 cách gán đều y hệt): bề rộng ĐÚNG BẰNG 9 bị coi là "mặc định" nên
    // KHÔNG ghi thẻ <col> vào file ⇒ Excel lấy 8,43, cột hẹp hơn ý mình. Né đúng con số đó.
    return r === 9 ? 9.5 : r;
  });
  // Đặt bề ngang TỪNG CỘT MỘT. Gán cả mảng `ws.columns` thì exceljs có lúc BỎ SÓT một cột (đo thật trên
  // file xuất 22/11: cột "ĐÃ HOÀN" KHÔNG có thẻ <col> trong XML ⇒ Excel lấy mặc định 8,43 ⇒ số 9 chữ số
  // hiện ra `#######`). Gán từng cột thì không sót.
  for (let i = 0; i < widths.length; i++) ws.getColumn(i + 1).width = widths[i];

  // Hàng 1 — TIÊU ĐỀ
  ws.mergeCells(`A1:${lastCol}1`);
  const t = ws.getCell('A1');
  t.value = input.title.toUpperCase();
  t.font = { name: FONT, size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  t.alignment = { vertical: 'middle', horizontal: 'center' };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_TITLE } };
  ws.getRow(1).height = 30;

  // Hàng 2 — TỔNG HỢP
  ws.mergeCells(`A2:${lastCol}2`);
  const s = ws.getCell('A2');
  s.value = input.summary ?? `Tổng: ${input.rows.length} dòng   •   Ngày xuất: ${fmtVNDate(new Date())}`;
  s.font = { name: FONT, size: 13, bold: true, color: { argb: 'FF7F6000' } };
  s.alignment = { vertical: 'middle', horizontal: 'center' };
  s.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SUMMARY } };
  ws.getRow(2).height = 24;

  // Hàng 3 — TÊN CỘT (IN HOA)
  const hr = ws.getRow(3);
  headers.forEach((h, i) => {
    const c = hr.getCell(i + 1);
    c.value = h;
    c.font = { name: FONT, size: 13, bold: true };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } };
    c.border = BORDER;
  });
  // [B232 22/11 — Admin Demo "hàng tiêu đề bị tràn cao"] CHỐT chiều cao hàng tên cột ở 2 dòng chữ.
  // Trước đây tính tự động theo ô wrap dài nhất ⇒ một tên cột dài làm cả hàng cao vống lên, nhìn vỡ.
  hr.height = Math.min(30, rowHeightFor(headers, widths, 22));

  // Dữ liệu (dòng lẻ nền xám nhạt) — căn theo cột (R44), CHIỀU CAO TỰ TÍNH theo cột wrap (trái) → KHÔNG che chữ.
  const aligns = colAligns(input.rows, N);
  input.rows.forEach((r, ri) => {
    const row = ws.getRow(4 + ri);
    // Chỉ cột căn trái (tên/địa chỉ dài) mới wrap → tính chiều cao theo các cột đó.
    const wrapVals: (Cell)[] = [];
    for (let ci = 0; ci < N; ci++) {
      const c = row.getCell(ci + 1);
      const v = r[ci] ?? '';
      const tenCot = hoaTen(input.headers[ci] ?? '');
      const wrap = aligns[ci] === 'left';
      c.value = v;
      c.font = { name: FONT, size: 13 };
      // [B232] Tiền hiện có dấu chấm ngăn nghìn (`#,##0`) — trước đây là số trần `117166000`, đọc rất mệt.
      // Số ÂM vẫn giữ dấu trừ để thấy ngay "còn phải hoàn".
      if (laTien.has(tenCot) && typeof v === 'number') c.numFmt = '#,##0';
      // Tiền LUÔN căn phải để các hàng đơn vị thẳng cột — đo 22/11 thấy "ĐÃ HOÀN" bị căn giữa vì cột
      // toàn số 0, hàng nghìn so le nhìn rất khó đối chiếu.
      const can = laTien.has(tenCot) ? ('right' as const) : laGiua.has(tenCot) ? ('center' as const) : aligns[ci];
      c.alignment = { vertical: 'middle', horizontal: can, wrapText: wrap && can === 'left' };
      c.border = BORDER;
      if (ri % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } };
      wrapVals.push(wrap ? v : '');
    }
    row.height = rowHeightFor(wrapVals, widths, 20);
  });

  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + input.rows.length, column: N } };

  // [B245 22/11 — Admin Demo "tất cả cột tiền trên danh sách bill và excel phải có tổng dưới đáy"]
  // HÀNG TỔNG ngay dưới bảng chính, cộng ĐÚNG những cột đã khai là cột TIỀN (`cotTien`) — không đoán
  // "ô là số thì cộng", vì cột % cũng là số (cộng % lại thành vô nghĩa) và cột TID/Số HĐ cũng vậy.
  // Nằm NGOÀI vùng autoFilter ở trên nên lọc/sắp xếp không kéo hàng tổng vào giữa bảng.
  let dongTong = 0;
  if (laTien.size && input.rows.length) {
    dongTong = 4 + input.rows.length;
    const rt = ws.getRow(dongTong);
    const tongCot = new Map<number, number>();
    for (let ci = 0; ci < N; ci++) {
      if (!laTien.has(hoaTen(input.headers[ci] ?? ''))) continue;
      let t = 0;
      for (const r of input.rows) if (typeof r[ci] === 'number') t += r[ci] as number;
      tongCot.set(ci, t);
    }
    // Nhãn "TỔNG n dòng" trải từ cột A tới ngay TRƯỚC cột tiền đầu tiên (nếu cột tiền là cột đầu
    // thì không gộp) — để nhãn không đè lên số.
    // [B298] tập rỗng ⇒ Infinity ⇒ mergeCells nổ — bỏ gộp nhãn khi không có cột tiền nào khớp.
    const cotTienDau = tongCot.size > 0 ? Math.min(...[...tongCot.keys()]) : 0;
    if (cotTienDau > 0 && Number.isFinite(cotTienDau)) ws.mergeCells(dongTong, 1, dongTong, cotTienDau);
    for (let ci = 0; ci < N; ci++) {
      const c = rt.getCell(ci + 1);
      if (ci === 0) c.value = 'TỔNG ' + input.rows.length + ' dòng';
      else if (tongCot.has(ci)) { c.value = tongCot.get(ci); c.numFmt = '#,##0'; }
      c.font = { name: FONT, size: 13, bold: true };
      c.alignment = { vertical: 'middle', horizontal: ci === 0 ? 'left' : tongCot.has(ci) ? 'right' : 'center' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SUMMARY } };
      c.border = { ...BORDER, top: { style: 'medium' as const, color: { argb: C_TITLE } } };
    }
    rt.height = 22;
  }

  // [B228/B232] KHỐI PHỤ xếp DƯỚI CÙNG bảng chính.
  // Bài học 22/11 (Admin Demo "blog bên dưới bị tràn xấu"): khối phụ ĐỔ THẲNG vào cột A,B,C… của bảng chính
  // mà bề ngang các cột đó đã đóng theo bảng chính (A=NGÀY 7, B=GIỜ 7, C=CA 6…) ⇒ "TID" 8 ký tự vào cột
  // rộng 7 là CẮT, tên HKD vào cột rộng 7 là cắt nặng ⇒ nhìn vỡ trận.
  // Cách sửa: mỗi cột của khối được GỘP đủ số cột chính để chứa hết nội dung, rồi mới ghi.
  let dong = (dongTong || 3 + input.rows.length) + 2; // chừa 1 dòng trắng ngăn cách (dưới cả hàng TỔNG)
  for (const k of input.khoiPhu ?? []) {
    const canRong = k.headers.map((h, i) => {
      let max = h.length;
      for (const r of k.rows) {
        const v = r[i];
        const d = v == null ? 0 : (typeof v === 'number' ? v.toLocaleString('vi-VN').length : String(v).length);
        if (d > max) max = d;
      }
      return max + 3;
    });
    // Gộp cột chính cho tới khi đủ rộng; cột cuối lấy nốt phần còn lại để mép phải thẳng với bảng chính.
    const nhom: Array<[number, number]> = [];
    let cot = 1;
    for (let i = 0; i < canRong.length; i++) {
      const dau = cot;
      let rong = 0;
      while (cot <= N && (rong < canRong[i] || cot === dau)) { rong += widths[cot - 1] ?? 8; cot++; }
      // KHÔNG kéo cột cuối ra hết bề ngang bảng chính: khối chỉ có 5 cột mà trải 22 cột thì ô
      // "doanh số" dài loằng ngoằng sang tận mép phải — đúng cảnh Admin Demo gọi là "tràn xấu" (ảnh 22/11).
      nhom.push([dau, Math.min(cot - 1, N)]);
    }
    const cuoi = nhom[nhom.length - 1][1];

    // Dòng TIÊU ĐỀ khối — nền brand, chữ trắng, trải đúng bề ngang khối.
    ws.mergeCells(dong, 1, dong, cuoi);
    const o = ws.getCell(dong, 1);
    o.value = k.tieuDe.toUpperCase();
    o.font = { name: FONT, size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
    o.alignment = { vertical: 'middle', horizontal: 'center' };
    o.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_TITLE } };
    ws.getRow(dong).height = 24;
    dong++;

    // Dòng TÊN CỘT
    const hr2 = ws.getRow(dong);
    nhom.forEach(([a, b2], i) => {
      if (b2 > a) ws.mergeCells(dong, a, dong, b2);
      for (let c2 = a; c2 <= b2; c2++) {
        const c = hr2.getCell(c2);
        if (c2 === a) c.value = k.headers[i].toUpperCase();
        c.font = { name: FONT, size: 12, bold: true };
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } };
        c.border = BORDER;
      }
    });
    hr2.height = 20;
    dong++;

    // Dữ liệu khối — số căn phải + dấu chấm ngăn nghìn, chữ căn trái, sọc nhạt.
    k.rows.forEach((r, ri) => {
      const row = ws.getRow(dong + ri);
      // [B248 22/11 — Admin Demo "tổng đấy cho in đậm với brand alpha"] Hàng TỔNG của khối: chữ ĐẬM,
      // nền brand-tint, viền trên dày màu brand — nhìn là tách ngay khỏi các dòng dữ liệu.
      // Nhận hàng TỔNG bằng CỜ của nơi gọi, KHÔNG dò chữ "TỔNG": hai file có thể viết chữ Việt ở
      // hai dạng Unicode khác nhau (dựng sẵn vs tổ hợp dấu) ⇒ so chuỗi trượt mà chẳng ai thấy.
      const laTong = k.coHangTong === true && ri === k.rows.length - 1;
      nhom.forEach(([a, b2], i) => {
        if (b2 > a) ws.mergeCells(dong + ri, a, dong + ri, b2);
        const v = r[i] ?? '';
        // [B248 — Admin Demo "0,98 / 1,26 căn phải"] Ô là CHỮ nhưng nội dung toàn số (vd "1,22 / 1,35"
        // khi 1 TID có nhiều mức % mua NĐT) thì vẫn phải CĂN PHẢI cho thẳng cột với các ô số thật.
        const soDangChu = typeof v === 'string' && /^[0-9][0-9.,\s/]*$/.test(v.trim());
        for (let c2 = a; c2 <= b2; c2++) {
          const c = row.getCell(c2);
          if (c2 === a) {
            c.value = v;
            if (typeof v === 'number' && Math.abs(v) >= 1000) c.numFmt = '#,##0';
          }
          c.font = { name: FONT, size: 12, bold: laTong };
          c.alignment = {
            vertical: 'middle',
            horizontal: typeof v === 'number' || soDangChu ? 'right' : 'left'
          };
          c.border = laTong ? { ...BORDER, top: { style: 'medium' as const, color: { argb: C_TITLE } } } : BORDER;
          if (laTong) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SUMMARY } };
          else if (ri % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } };
        }
      });
      row.height = laTong ? 21 : 18;
    });
    dong += k.rows.length + 2;
  }

  // R43: bỏ cảnh báo "số lưu dạng text" cho toàn vùng dữ liệu (SĐT/mã/MST là text có chủ đích).
  return input.rows.length > 0 ? `A4:${lastCol}${3 + input.rows.length}` : null;
}

/** Dựng MẪU nhập → Buffer .xlsx. Sheet 1 "Mẫu nhập" CHỈ có 1 dòng header (row 1) để parse round-trip;
 *  sheet 2 "Hướng dẫn" liệt kê cột + bắt buộc + gợi ý. */
export async function buildTemplateWorkbook(input: TemplateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mẫu nhập', { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: pageSetup() });
  const twidths = input.headers.map((h) => Math.min(40, Math.max(14, h.length + 4)));
  ws.columns = twidths.map((w) => ({ width: w }));
  const hr = ws.getRow(1);
  input.headers.forEach((h, i) => {
    const c = hr.getCell(i + 1);
    c.value = h; // GIỮ NGUYÊN nhãn (không IN HOA) để khớp header khi nhập lại
    c.font = { name: FONT, size: 13, bold: true };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } };
    c.border = BORDER;
  });
  hr.height = rowHeightFor(input.headers, twidths, 26);

  // DANH MỤC CHỌN SẴN → data-validation kiểu "list" cho 500 dòng đầu của đúng cột đó.
  // Vì sao phải có sheet "Danh mục" riêng: Excel giới hạn danh sách VIẾT THẲNG trong ô validation ở 255 ký tự —
  // danh sách ngân hàng/ngành nghề vượt xa ngưỡng đó ⇒ file mở ra Excel báo hỏng. Trỏ vào DẢI Ô thì không giới hạn.
  const chon = input.chon ?? {};
  const tenCot = Object.keys(chon).filter((k) => input.headers.includes(k) && (chon[k]?.length ?? 0) > 0);
  if (tenCot.length > 0) {
    const dm = wb.addWorksheet('Danh mục');
    dm.state = 'veryHidden'; // ẩn hẳn — người dùng không sửa nhầm, nhưng công thức vẫn trỏ được
    tenCot.forEach((ten, ci) => {
      const ds = chon[ten] ?? [];
      dm.getColumn(ci + 1).width = 30;
      dm.getCell(1, ci + 1).value = ten;
      ds.forEach((v, ri) => { dm.getCell(2 + ri, ci + 1).value = v; });
      const cot = numToCol(ci + 1);
      const dai = `'Danh mục'!$${cot}$2:$${cot}$${1 + ds.length}`;
      const cotMau = numToCol(input.headers.indexOf(ten) + 1);
      // Khai BẰNG DẢI, KHÔNG gán từng ô: gán từng ô làm ExcelJS đẻ ra 2 vùng sqref CHỒNG NHAU
      // (đo thật trên XML: E2:E501 và E10:E501) — Excel coi đó là bản ghi hỏng và bật hộp "repaired records".
      // `dataValidations` CÓ THẬT lúc chạy (đã đọc lại XML + mở bằng Excel để kiểm) nhưng THIẾU trong file
      // .d.ts của exceljs ⇒ ép kiểu hẹp đúng 1 hàm `add`, không `any` cả đối tượng.
      const dv = ws as unknown as { dataValidations: { add: (range: string, v: unknown) => void } };
      dv.dataValidations.add(`${cotMau}2:${cotMau}501`, {
        type: 'list', allowBlank: true, formulae: [dai],
        showErrorMessage: true, errorStyle: 'stop',
        errorTitle: 'Giá trị không có trong danh mục',
        error: `Chọn một giá trị trong danh sách "${ten}" của phần mềm (bấm mũi tên ở ô).`
      });
    });
  }

  if (input.hints && input.hints.length) {
    const gd = wb.addWorksheet('Hướng dẫn');
    gd.columns = [{ width: 28 }, { width: 12 }, { width: 60 }];
    const h0 = gd.getRow(1);
    ['CỘT', 'BẮT BUỘC', 'GỢI Ý'].forEach((h, i) => {
      const c = h0.getCell(i + 1);
      c.value = h;
      c.font = { name: FONT, size: 13, bold: true };
      c.alignment = { vertical: 'middle', horizontal: 'center' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } };
      c.border = BORDER;
    });
    input.hints.forEach((hint, ri) => {
      const row = gd.getRow(2 + ri);
      [hint.header, hint.required ? 'Có' : '', hint.hint ?? ''].forEach((v, ci) => {
        const c = row.getCell(ci + 1);
        c.value = v;
        c.font = { name: FONT, size: 13 };
        c.alignment = { vertical: 'middle', horizontal: ci === 1 ? 'center' : 'left', wrapText: true };
        c.border = BORDER;
      });
    });
  }
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

function numToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
