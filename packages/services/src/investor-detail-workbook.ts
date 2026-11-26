// BÁO CÁO CHI TIẾT NHÀ ĐẦU TƯ — Excel workbook DÙNG CHUNG (desktop main + bot-api SigMa). Tách từ
// apps/desktop/src/main/export-service.ts (Admin Demo 26/8) để KHÔNG code trùng: cả 2 nền dựng CÙNG 1 format.
// Số liệu vào (InvestorDetailData) LẤY TỪ investorReportDetail (nguồn tiền DUY NHẤT) — file này CHỈ trình bày.
// Khớp gen-investor-report.mts: 12 cột (Ngân hàng trước Tên HKD), Phí CM = phí cài máy, số lô cạnh giờ, bảng
// tổng-TID ô gộp rộng + header giữa, BẢNG ĐÃ ỨNG, thẻ kết toán viền KÉP, sheet tên theo NGÀY.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export interface InvestorDetailData {
  investorName: string; from: string; to: string;
  bills: { tid: string; bankName: string; hkdName: string; soLo: string; billLoNumber?: string; txnDateIso: string; amount: number; phiMilli: number; sauPhi: number; effMilli: number; lai: number; note?: string | null }[];
  tidSummary: { bank: string; tid: string; hkd: string; n: number; truoc: number; sau: number; lai: number }[];
  advances: { advanceDateIso: string; senderName: string; receiverName: string; amount: number; source: string }[];
  totals: { truoc: number; sau: number; lai: number; tienVe: number; daNhan: number; thuaThieu: number };
}

const FONT = 'Times New Roman';
const C_TITLE = 'FF2E75B6';
const C_SUMMARY = 'FFFFF2CC';
const C_HEADER = 'FFBDD7EE';
const C_ZEBRA = 'FFDEEBF7';
const C_TIDSUB = 'FFEAF1FB';
const C_SEC = 'FFDDEBF7';
const THIN = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

// Chặn "chấm vàng — Number stored as text" khi ô là chuỗi số (TID/số lô) trên MỌI sheet (nhiều-ngày = nhiều sheet).
// exceljs không expose ignoredErrors → chèn thẳng XML từng sheetN.xml. Range rộng A1:L1000 (đủ phủ mọi sheet báo cáo NĐT).
async function suppressAllSheets(buf: Buffer): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const sheetPaths = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
    for (const path of sheetPaths) {
      const file = zip.file(path); if (!file) continue;
      let xml = await file.async('string');
      if (!xml.includes('<ignoredErrors>')) {
        xml = xml.replace('</worksheet>', `<ignoredErrors><ignoredError sqref="A1:L1000" numberStoredAsText="1"/></ignoredErrors></worksheet>`);
        zip.file(path, xml);
      }
    }
    // BẢN WEB (6/11): file này được BUNDLE CHO TRÌNH DUYỆT (apps/desktop/src/web-shim dùng chung để bản web xuất
    // báo cáo NĐT đúng 1 định dạng với desktop + bot-api). Trình duyệt KHÔNG có `Buffer` của Node → JSZip chỉ xuất
    // được 'arraybuffer'. Điều kiện `typeof Buffer === 'undefined'` KHỚP phép thử khả-dụng của JSZip, nên trong
    // Node (desktop main + bot-api) vẫn là 'nodebuffer' y như cũ — KHÔNG đổi hành vi 2 nền đang chạy.
    const kieuZip = (typeof Buffer === 'undefined' ? 'arraybuffer' : 'nodebuffer') as 'nodebuffer';
    return (await zip.generateAsync({ type: kieuZip })) as Buffer;
  } catch {
    return buf;
  }
}

function drawSummaryCard(ws: ExcelJS.Worksheet, top: number, t: { daNhan: number; tienVe: number; thuaThieu: number; lai: number }): void {
  const DBL = { style: 'double' as const, color: { argb: 'FF1F4E79' } };
  let R = top;
  ws.mergeCells(`E${R}:K${R}`);
  const tt = ws.getCell(`E${R}`);
  tt.value = 'KẾT TOÁN NHÀ ĐẦU TƯ TRONG KỲ';
  tt.font = { name: FONT, size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
  tt.alignment = { horizontal: 'center', vertical: 'middle' };
  tt.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  ws.getRow(R).height = 28; R++;
  const rows: [string, number, 'plain' | 'signed' | 'total'][] = [
    ['Đã nhận (tạm ứng)', t.daNhan, 'plain'],
    ['Tiền về (sau phí cài máy)', t.tienVe, 'plain'],
    ['Thừa / Thiếu', t.thuaThieu, 'signed'],
    ['Lãi NĐT (0,1% đối ứng)', t.lai, 'plain'],
    ['TỔNG CỘNG (thừa/thiếu + lãi)', t.thuaThieu + t.lai, 'total']
  ];
  rows.forEach(([label, val, kind], i) => {
    ws.mergeCells(`E${R}:H${R}`);
    const l = ws.getCell(`E${R}`); l.value = label; l.font = { name: FONT, size: kind === 'total' ? 12 : 11, bold: true }; l.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.mergeCells(`I${R}:K${R}`);
    const v = ws.getCell(`I${R}`); v.value = val; v.numFmt = '#,##0'; v.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    const total = kind === 'total';
    v.font = { name: FONT, size: total ? 14 : 11.5, bold: true, color: total ? { argb: 'FF1F4E79' } : (kind === 'signed' && val < 0 ? { argb: 'FFC00000' } : { argb: 'FF203864' }) };
    const bg = total ? 'FFFFD966' : (i % 2 === 0 ? 'FFEAF1FB' : 'FFFFFFFF');
    l.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    v.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    ws.getRow(R).height = total ? 26 : 22; R++;
  });
  const bot = R - 1;
  for (let r = top; r <= bot; r++) {
    for (let col = 5; col <= 11; col++) {
      const b: Partial<ExcelJS.Borders> = {};
      if (r === top) b.top = DBL; if (r === bot) b.bottom = DBL;
      if (col === 5) b.left = DBL; if (col === 11) b.right = DBL;
      ws.getRow(r).getCell(col).border = b;
    }
    // FIX cạnh TRÁI (Admin Demo 27/8): viền-trái của merge E:H không render → vẽ viền-PHẢI cột D (trùng đường trái card).
    // [Admin Demo 12/9 "gạch bo viền bị thừa"] CHỈ vẽ đường DỌC — top/bottom trên D tạo Ô RỖNG bo viền thừa bên trái card.
    const d = ws.getRow(r).getCell(4);
    d.border = { ...(d.border ?? {}), right: DBL };
  }
}

/** Dựng workbook báo cáo chi tiết 1 NĐT. Nhận 1 ngày (InvestorDetailData) → 1 sheet, HOẶC MẢNG data-mỗi-ngày →
 *  nhiều sheet (mỗi phần tử = 1 ngày, gọi investorReportDetail theo TỪNG ngày ở caller để đúng biên SQL — KHÔNG
 *  cắt JS lệch múi giờ). Admin Demo 27/8: hôm nay 1 sheet, tuần nhiều sheet. */
export async function buildInvestorDetailWorkbook(input: InvestorDetailData | InvestorDetailData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const days = Array.isArray(input) ? input : [input];
  for (const d of days) renderDaySheet(wb, d);
  const buf = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  return suppressAllSheets(buf);
}

/** Render 1 sheet cho 1 ngày (tách từ hàm cũ để loop nhiều ngày). */
function renderDaySheet(wb: ExcelJS.Workbook, d: InvestorDetailData): void {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  // [B-L4 21/9] HCM (UTC+7) TƯỜNG MINH — trước dùng getter TZ tiến trình: chạy dưới process không phải
  // Asia/Ho_Chi_Minh (script thô/CI) thì ngày giờ trong Excel lệch −7h. Server prod đúng TZ nên chưa lộ, nhưng
  // display tiền phải độc lập môi trường (cùng lớp bẫy TZ 11/9).
  const hcm = (iso: string): Date => new Date(new Date(iso).getTime() + 7 * 3600_000);
  const fmtDate = (iso: string): string => { const x = hcm(iso); return `${p2(x.getUTCDate())}/${p2(x.getUTCMonth() + 1)}/${x.getUTCFullYear()}`; };
  const fmtTime = (iso: string): string => { const x = hcm(iso); return `${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}`; };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.from); const sheetName = m ? `${m[3]}.${m[2]}` : d.from;
  const ws = wb.addWorksheet(sheetName, { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } } });
  // [Admin Demo 21/9] + cột GHI CHÚ (pos_lot_recon.note — đồng nhất với bảng lô ĐL/NĐT/hoàn tiền trên màn hình).
  const HEAD = ['STT', 'Ngày TT', 'Thời gian', 'Số lô', 'Ngân hàng', 'Tên HKD', 'TID', 'Tiền trước phí', 'Phí CM (%)', 'Sau phí CM', '% Đối ứng', 'Thành tiền', 'Ghi chú'];
  ws.columns = [6, 12, 9, 9, 11, 24, 13, 16, 10, 16, 10, 14, 16].map((w) => ({ width: w }));
  const N = HEAD.length; // 12
  const isMoney = (ci: number): boolean => ci === 7 || ci === 9 || ci === 11;
  const isPct = (ci: number): boolean => ci === 8 || ci === 10;
  let R = 1;
  ws.mergeCells(`A${R}:M${R}`); const t = ws.getCell(`A${R}`);
  t.value = `BÁO CÁO NHÀ ĐẦU TƯ — ${d.investorName.toUpperCase()} — ${d.from}${d.to !== d.from ? ' → ' + d.to : ''}`;
  t.font = { name: FONT, size: 15, bold: true, color: { argb: 'FFFFFFFF' } }; t.alignment = { horizontal: 'center', vertical: 'middle' };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_TITLE } }; ws.getRow(R).height = 28; R++;
  const headerRowIdx = R;
  const hr = ws.getRow(R); HEAD.forEach((h, i) => { const c = hr.getCell(i + 1); c.value = h; c.font = { name: FONT, size: 11, bold: true }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } }; c.border = BORDER; }); hr.height = 30; R++;
  const putRow = (vals: (string | number)[], opts: { bold?: boolean; fill?: string; zebra?: boolean } = {}): void => {
    const row = ws.getRow(R);
    vals.forEach((v, ci) => {
      const c = row.getCell(ci + 1); c.value = v; c.font = { name: FONT, size: 10, bold: !!opts.bold };
      c.alignment = { horizontal: ci === 0 ? 'center' : (isMoney(ci) || isPct(ci) ? 'right' : ci === 12 ? 'left' : 'center'), vertical: 'middle', wrapText: ci === 5 || ci === 12 };
      if (isMoney(ci)) c.numFmt = '#,##0'; if (isPct(ci)) c.numFmt = '0.000'; c.border = BORDER;
      if (opts.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
      else if (opts.zebra) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ZEBRA } };
    });
    R++;
  };
  const order: string[] = []; const byTid: Record<string, InvestorDetailData['bills']> = {};
  for (const b of d.bills) { if (!byTid[b.tid]) { byTid[b.tid] = []; order.push(b.tid); } byTid[b.tid].push(b); }
  let stt = 1;
  for (const tid of order) {
    const bills = byTid[tid]; let sT = 0, sS = 0, sL = 0;
    // SỐ LÔ (Admin Demo 1/9 "excel trống số lô"): cột so_lo thường NULL với lô mới → fallback billLoNumber (parse từ
    // bill_key = số lô THẬT trên bill). Ưu tiên so_lo nếu có (legacy), else billLoNumber.
    bills.forEach((b, i) => { putRow([stt++, fmtDate(b.txnDateIso), fmtTime(b.txnDateIso), b.soLo || b.billLoNumber || '', b.bankName, b.hkdName, String(tid), b.amount, b.phiMilli / 1000, b.sauPhi, b.effMilli / 1000, b.lai, b.note ?? ''], { zebra: i % 2 === 1 }); sT += b.amount; sS += b.sauPhi; sL += b.lai; });
    putRow(['', '', '', '', '', `TỔNG (${bills.length})`, String(tid), sT, '', sS, '', sL, ''], { bold: true, fill: C_TIDSUB });
  }
  putRow(['', '', '', '', '', '', 'TỔNG CỘNG', d.totals.truoc, '', d.totals.sau, '', d.totals.lai, ''], { bold: true, fill: C_SUMMARY });
  const lastDetail = R - 1;
  ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: lastDetail, column: N } };
  // Bảng tổng từng TID — ô GỘP rộng (Tên HKD C:D, mỗi cột tiền gộp 2 ô)
  R++;
  ws.mergeCells(`A${R}:L${R}`); const s2 = ws.getCell(`A${R}`); s2.value = 'TỔNG DOANH SỐ TỪNG TID'; s2.font = { name: FONT, size: 11, bold: true }; s2.alignment = { horizontal: 'center', vertical: 'middle' }; s2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SEC } }; s2.border = BORDER; ws.getRow(R).height = 18; R++;
  // Admin Demo 27/8: thêm cột STT đầu bảng → STT | Ngân hàng | TID | Tên HKD | Số bill | Doanh số | Sau phí | Lãi (8 cột / 12 ô).
  const SPANS = [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'E'], ['F', 'F'], ['G', 'H'], ['I', 'J'], ['K', 'L']];
  const putSum = (vals: (string | number)[], o: { header?: boolean; total?: boolean } = {}): void => {
    vals.forEach((v, ci) => {
      const [a, b] = SPANS[ci]; if (a !== b) ws.mergeCells(`${a}${R}:${b}${R}`);
      const c = ws.getCell(`${a}${R}`); c.value = v; c.border = BORDER;
      const money = ci >= 5; // sau khi thêm STT: Doanh số(5) / Sau phí(6) / Lãi(7) là tiền
      c.font = { name: FONT, size: 10, bold: !!o.header || !!o.total };
      c.alignment = { horizontal: o.header ? 'center' : (money ? 'right' : 'center'), vertical: 'middle', wrapText: !!o.header };
      if (money && !o.header) c.numFmt = '#,##0';
      if (o.header) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } };
      else if (o.total) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SUMMARY } };
    });
    ws.getRow(R).height = o.header ? 26 : 19; R++;
  };
  putSum(['STT', 'Ngân hàng', 'TID', 'Tên HKD', 'Số bill', 'Doanh số (trước phí)', 'Sau phí', 'Lãi (0,1%)'], { header: true });
  let sttSum = 1;
  for (const s of d.tidSummary) putSum([sttSum++, s.bank, String(s.tid), s.hkd, s.n, s.truoc, s.sau, s.lai]);
  putSum(['', '', '', 'TỔNG', d.tidSummary.reduce((a, s) => a + s.n, 0), d.totals.truoc, d.totals.sau, d.totals.lai], { total: true });
  // ── BẢNG ĐÃ ỨNG (TẠM ỨNG) ──
  R += 2;
  ws.mergeCells(`A${R}:L${R}`); const a2 = ws.getCell(`A${R}`); a2.value = 'BẢNG ĐÃ ỨNG (TẠM ỨNG) TỪ NHÀ ĐẦU TƯ'; a2.font = { name: FONT, size: 11, bold: true }; a2.alignment = { horizontal: 'center', vertical: 'middle' }; a2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SEC } }; a2.border = BORDER; ws.getRow(R).height = 18; R++;
  const ASP = [['A', 'A'], ['B', 'C'], ['D', 'D'], ['E', 'G'], ['H', 'J'], ['K', 'L']];
  const putAdv = (vals: (string | number)[], o: { header?: boolean; total?: boolean } = {}): void => {
    vals.forEach((v, ci) => {
      const [a, b] = ASP[ci]; if (a !== b) ws.mergeCells(`${a}${R}:${b}${R}`);
      const c = ws.getCell(`${a}${R}`); c.value = v; c.border = BORDER;
      const money = ci === 5;
      c.font = { name: FONT, size: 10, bold: !!o.header || !!o.total };
      c.alignment = { horizontal: o.header ? 'center' : (money ? 'right' : (ci >= 3 ? 'left' : 'center')), vertical: 'middle' };
      if (money && !o.header) c.numFmt = '#,##0';
      if (o.header) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER } };
      else if (o.total) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SUMMARY } };
    });
    ws.getRow(R).height = 19; R++;
  };
  putAdv(['STT', 'Ngày', 'Giờ', 'Người gửi (NĐT)', 'Người nhận (SigMa)', 'Số tiền'], { header: true });
  d.advances.forEach((a, i) => { const x = new Date(a.advanceDateIso); const isM = a.source === 'MANUAL'; putAdv([i + 1, `${p2(x.getDate())}/${p2(x.getMonth() + 1)}/${x.getFullYear()}`, isM ? '(đối chứng)' : `${p2(x.getHours())}:${p2(x.getMinutes())}`, a.senderName || (isM ? '(tổng đối chứng file)' : ''), a.receiverName || '', a.amount]); });
  putAdv(['', '', '', '', 'TỔNG ĐÃ ỨNG', d.totals.daNhan], { total: true });
  // Thẻ kết toán viền kép
  drawSummaryCard(ws, R + 2, { daNhan: d.totals.daNhan, tienVe: d.totals.tienVe, thuaThieu: d.totals.thuaThieu, lai: d.totals.lai });
  R = R + 2 + 8;
}
