// [Admin Demo 7/9] TRA SOÁT SAO KÊ — đọc file sao kê ngân hàng (MB/MBV export xlsx), chuẩn hoá về danh sách giao dịch,
// phân loại NỢ (tiền RA = hoàn đại lý / hoàn ứng NĐT) vs CÓ (tiền VÀO = tạm ứng NĐT), khớp đối ứng (STK/tên) với ĐẠI LÝ
// (từ bill hoàn OCR đã có) hoặc NĐT (theo tên/alias), thêm cột tên đại lý/NĐT. Báo cáo chi tiết + tổng từng đại lý/TK.
//
// ĐỊNH DẠNG MB (file thật Nhân viên B 07-08/9): header ~row15, cột: Thời Gian GD | Mã Tham Chiếu | Phát Sinh Nợ
// (Debit=tiền RA) | Phát Sinh Có (Credit=tiền VÀO) | Nội Dung | Tên TK Đối Ứng | TK Đối Ứng | Ngân Hàng Đối Ứng.
import ExcelJS from 'exceljs';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface StatementTxn {
  rowIndex: number;
  dateTime: string | null;   // ISO (từ cell Date) hoặc chuỗi thô
  ref: string | null;        // mã tham chiếu (FT...)
  debit: number;             // Phát Sinh Nợ (tiền RA) — 0 nếu không
  credit: number;            // Phát Sinh Có (tiền VÀO) — 0 nếu không
  desc: string | null;       // nội dung
  cpName: string | null;     // tên tài khoản đối ứng (báo CÓ MB thường trống/tên NH → lấy tên người chuyển ở NỘI DUNG)
  cpAccount: string | null;  // số tài khoản đối ứng
  cpBank: string | null;     // ngân hàng đối ứng
  descName: string | null;   // TÊN NGƯỜI CHUYỂN trích từ nội dung (Admin Demo 7/9: báo có MB tên nằm ở đây)
  balance?: number | null;   // [Admin Demo 12/9] SỐ DƯ sau GD (cột "Số dư" sao kê) — tính số dư cuối ngày từng TK; file không có cột → null
}

/** [Admin Demo 7/9] Trích TÊN NGƯỜI CHUYỂN từ nội dung sao kê (báo có MB): "KHACH HANG 02 KHACH HANG 02 CHUYEN KHOAN 0709..."
 *  → "KHACH HANG 02". Cắt trước "CHUYEN KHOAN"/"CK"/số dài; gộp tên lặp đôi. Null nếu không ra tên ≥4 ký tự chữ. */
export function extractDescName(desc: string | null | undefined): string | null {
  if (!desc) return null;
  let s = String(desc).replace(/\s+/g, ' ').trim();
  // [Admin Demo 8/9 — ACB] ACB gắn TIỀN TỐ KÊNH trước tên ("IB KHACH HANG 02 CHUYEN KHOAN") → không bỏ thì khớp tên hụt
  // ("IBMAIANHNAM" ≠ "MAIANHNAM" ⇒ tạm ứng NĐT Thông bị bỏ sót câm). Chỉ cắt token kênh ĐỨNG ĐẦU, không đụng tên.
  s = s.replace(/^(IB|IBFT|NAPAS)\s+/i, '');
  // [Admin Demo 26/9 "sửa đúng khớp ngày 25"] MB chèn MÃ KÊNH vào GIỮA nội dung: "KHACH HANG 01 Qaiuif APPMB
  // TRAN A" · "KHACH HANG 22 Qaiuif APPMB NGUYEN DINH" · "KHACH HANG 52 Qaiuif APPMB NPS" · "... VQRQ...".
  // Không cắt thì tên trích ra dính đuôi rác ⇒ khớp CHÍNH XÁC trượt sạch ⇒ 30 GD báo có ngày 25/9
  // (3.651.816.000đ) đứng ngoài sổ, kể cả tiền KT Demo tự chuyển (đáng lẽ là "chuyển giữa TK").
  // [Admin Demo 26/9] MA KENH CO THE DINH SO: "Qaiuif6322", "APPMB1" => ranh gioi tu sau F/B KHONG
  // thanh lap (F<->6, B<->1 deu la ky tu tu) => luat cat TRUOT => ten trich ra la ca chuoi rac =>
  // 5 GD KeToan tu chuyen (950.214.000d ngay 25/9) khong nhan ra "chuyen giua TK". Cho phep ma dinh so.
  const m = /\bQAIUIF|\bAPPMB|\bVQRQ|\bCHUYEN\s*KHOAN\b|\bCHUYEN\b|\bCK\b|\bTHANH\s*TOAN\b|\bIBFT\b|\bFT\d|\d{5,}/i.exec(s);
  if (m && m.index > 0) s = s.slice(0, m.index).trim();
  s = s.replace(/[^A-Za-zÀ-ỹ\s]/g, '').replace(/\s+/g, ' ').trim();
  const w = s.split(' ').filter(Boolean);
  const h = Math.floor(w.length / 2); // gộp tên lặp đôi "X Y Z X Y Z" → "X Y Z"
  if (h > 0 && w.slice(0, h).join(' ').toUpperCase() === w.slice(h, h * 2).join(' ').toUpperCase()) s = w.slice(0, h).join(' ');
  return s.replace(/[A-Za-z]/g, 'x').replace(/[^x]/g, '').length >= 4 ? s : null;
}

/** [Admin Demo 17/9 — file SAO_KE_00060792_MAI_ANH_NAM] Bản sao kê MBV rút gọn KHÔNG có cột "Tên/Số TK đối ứng",
 *  nhưng thông tin đó NẰM TRONG NỘI DUNG theo mẫu cố định của kênh chi hộ:
 *    "8000122219 CHI HO TU TK DEMO-ACCT. TU: HKD DEMO 6"  → TK DEMO-ACCT · HKD DEMO 6
 *    "8000122219 CHI HO VE TK 00060792. TU: HO KINH DOANH KHACH HANG 23 9100" → TK 00060792 là TK CHÍNH MÌNH ⇒ BỎ,
 *                                                                              chỉ lấy tên người chuyển.
 *  Bóc ra để màn Tra soát khớp được ĐÚNG đại lý/NĐT thay vì mò theo cả câu.
 *  KHÔNG bịa: "CUSTOMER KHACH HANG 02 chuyen tien" (lệnh chuyển ĐI) không ghi người nhận → trả null, để trống. */
export function bocDoiUngTuNoiDung(desc: string | null | undefined, soTkSaoKe: string | null | undefined): { cpName: string | null; cpAccount: string | null } {
  const s = (desc ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { cpName: null, cpAccount: null };
  // Tên: phần sau "TU:" (người CHUYỂN trong lệnh chi hộ) tới hết chuỗi.
  const mTen = /\bTU\s*:\s*(.+)$/i.exec(s);
  const ten = mTen ? mTen[1].replace(/[.,;]+$/, '').trim() : null;
  // Số TK trong nội dung: "TU TK <so>" / "VE TK <so>" / "VE <so>" — chỉ nhận khi KHÁC số TK của chính sao kê.
  const mTk = /\b(?:TU|VE)\s+(?:TK\s+)?(\d{6,20})\b/i.exec(s);
  const tk = mTk ? mTk[1] : null;
  const tkMinh = (soTkSaoKe ?? '').replace(/\D/g, '');
  const tkDoiUng = tk && tk.replace(/\D/g, '') !== tkMinh ? tk : null;
  return { cpName: ten && ten.replace(/[^A-Za-z]/g, '').length >= 4 ? ten : null, cpAccount: tkDoiUng };
}

export interface ParsedStatement {
  accountHolder: string | null;
  accountNumber: string | null;
  accountBank: string | null;   // [Admin Demo 7/9] ngân hàng của TÀI KHOẢN SAO KÊ (MB/MBV/ABB/ACB…) — từ header file
  /** [Admin Demo 13/9 "tra soát chưa có số dư cuối kì"] SỐ DƯ CUỐI KỲ từ DÒNG TỔNG của file ("Số dư cuối kỳ/Closing
   *  balance/Số dư cuối") — nguồn số dư khi file KHÔNG có cột Số dư per-GD. null = file không ghi. */
  closingBalance?: number | null;
  txns: StatementTxn[];
  /** [Admin Demo 8/9 — R198] Lý do đọc HỤT/THIẾU (không nuốt câm): không thấy dòng tiêu đề, thiếu cột đối ứng,
   *  không nhận ra ngân hàng… Hiện thẳng lên màn tra soát để người duyệt biết mà xử, không đoán. */
  warnings?: string[];
  /** File KHÔNG có cột "Tên tài khoản đối ứng" → KHÔNG biết người NHẬN của lệnh chuyển ra (xem gate ở route). */
  thieuCotDoiUng?: boolean;
  /** Số giao dịch TIỀN RA trong file (để gate: thiếu cột đối ứng + có tiền ra = CHẶN, tránh gán nhầm nội bộ). */
  soGdRa?: number;
}

/** [Admin Demo 8/9 — BILL AN BÌNH] Chuyển OCR ảnh chụp lịch sử giao dịch (bank không xuất sao kê: ABB…) → ParsedStatement
 *  để đưa vào CÙNG luồng reconcile/cache như sao kê xlsx. Ảnh KHÔNG có Mã Tham Chiếu → sinh ref TỰ NHIÊN xác định
 *  (ABB:tk:ngày-giờ:tiền:tên) để dedup + cache như nhau (re-OCR ảnh trùng → cùng ref → upsert, không nhân đôi). */
export function bankHistoryToParsedStatement(
  ocr: { account: string | null; txns: { date: string | null; time: string | null; amount: number; cpName: string | null; cpBank: string | null }[] },
  opts: { srcAccount?: string | null; srcBank?: string | null; holder?: string | null } = {}
): ParsedStatement {
  const account = (opts.srcAccount ?? ocr.account ?? '').replace(/\s/g, '') || null;
  const bank = shortBank(opts.srcBank ?? 'ABB') ?? 'ABB';
  const txns: StatementTxn[] = ocr.txns.map((t, i) => {
    const md = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((t.date ?? '').trim());
    const hm = /^(\d{1,2}):(\d{2})$/.exec((t.time ?? '').trim());
    const dateTime = md ? `${md[3]}-${md[2].padStart(2, '0')}-${md[1].padStart(2, '0')}T${hm ? `${hm[1].padStart(2, '0')}:${hm[2]}` : '12:00'}:00` : null;
    const amt = Math.round(Number(t.amount) || 0);
    const debit = amt < 0 ? -amt : 0, credit = amt > 0 ? amt : 0;
    const cpName = t.cpName ? String(t.cpName).trim() : null;
    // Ref tự nhiên xác định (không có FT gốc) — dedup/cache ổn định qua các lần OCR lại cùng ảnh/khoản.
    const ref = `ABB-${account ?? '?'}-${(dateTime ?? `r${i}`).replace(/[^\dT:-]/g, '')}-${amt}-${normKey(cpName).slice(0, 12) || 'x'}`;
    return { rowIndex: i + 1, dateTime, ref, debit, credit, desc: null, cpName, cpAccount: null, cpBank: t.cpBank ? String(t.cpBank).trim() : null, descName: null };
  }).filter((t) => t.debit > 0 || t.credit > 0);
  return { accountHolder: opts.holder ?? null, accountNumber: account, accountBank: bank, txns };
}

/** Rút gọn tên ngân hàng dài → mã ngắn quen (MB/MBV/ABB/VCB…). Không khớp → giữ nguyên (cắt gọn). */
function shortBank(s: string | null): string | null {
  if (!s) return null;
  const u = normKey(s);
  if (u.includes('MBV') || u.includes('MBVIET')) return 'MBV';
  if (u.includes('ACHAU') || /(^|[^A-Z])ACB([^A-Z]|$)/.test(u)) return 'ACB'; // [Admin Demo 8/9] "ACB - NH TMCP A CHAU"
  if (u.includes('ANBINH') || u.includes('ABBANK') || u.includes('ABB')) return 'ABB';
  if (u.includes('QUANDOI') || u.includes('MBBANK') || /(^|[^A-Z])MB([^A-Z]|$)/.test(u) || u.includes('VIETNAMHIENDAI')) return 'MB';
  if (u.includes('VIETCOMBANK') || u.includes('VCB')) return 'VCB';
  // [Admin Demo 26/9] sao kê TCB in TÊN TIẾNG VIỆT 'NGÂN HÀNG TMCP KỸ THƯƠNG VIỆT NAM' (không có chữ Techcombank)
  // ⇒ trước rơi vào nhánh mặc định, cắt cụt thành 'TMCP KỸ TH'.
  if (u.includes('TECHCOMBANK') || u.includes('TCB') || u.includes('KYTHUONG')) return 'TCB';
  if (u.includes('SACOMBANK') || u.includes('STB')) return 'STB';
  if (u.includes('BIDV')) return 'BIDV';
  if (u.includes('VIETINBANK') || u.includes('CTG')) return 'CTG';
  if (u.includes('AGRIBANK')) return 'AGRI';
  return s.replace(/Ngân hàng.*?(TNHH|TMCP)?\s*/i, '').trim().slice(0, 10) || null;
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; text?: string; result?: unknown };
    if (o.richText) return o.richText.map((x) => x.text).join('');
    if (o.text != null) return String(o.text);
    if (o.result != null) return String(o.result);
    return '';
  }
  return String(v);
}
function num(v: unknown): number {
  // [Agent-4 11/9 — FIX NUỐT CÂM SỐ TIỀN TEXT] Trước đây strip [^\d.-] rồi Number(): cell TEXT kiểu VN
  // "1.234.567" giữ 2 dấu chấm → Number()=NaN → 0 → debit=credit=0 → DÒNG GD BỊ VỨT khỏi tra soát không cảnh
  // báo (mất tiền trong đối soát — R198). Nay luận ngăn-nghìn/thập-phân: VN "1.234.567"(,89) + Anh-Mỹ
  // "1,234,567.89" + thập phân đơn "123.45" đều đúng; cell numeric giữ nguyên hành vi cũ.
  const s0 = cellText(v).replace(/[^\d.,-]/g, '');
  if (!s0) return 0;
  let s = s0;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastDot > lastComma) s = s.replace(/,/g, ''); // "1,234,567.89" → phẩy = ngăn nghìn
    else s = s.replace(/\./g, '').replace(/,/g, '.'); // "1.234.567,89" → chấm = ngăn nghìn, phẩy = thập phân
  } else if (lastDot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "1.234.567" ngăn nghìn VN (trước đây NaN→0 nuốt câm)
  } else if (lastComma >= 0) {
    s = s.replace(/,/g, ''); // giữ hành vi cũ: strip mọi phẩy ("1,234,567" → 1234567)
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** [Admin Demo 30/9] TÊN NGƯỜI NHÀ SIGMA (đã chuẩn hoá) — vừa dùng cho gate "chuyển giữa TK", vừa để CẤM những tên này
 *  trở thành khoá đại lý trong map học-từ-bill (MB báo có điền chính chủ TK vào ô đối ứng ⇒ học nhầm). */
export const TEN_NGUOI_NHA_ALPHA = new Set(['KETOANDEMO', 'NGUOIDUNGDEMO', 'NGUOIDUNGDEMO', 'KHACHDEMOB', 'KHACHDEMOC']);

/** Chuẩn hoá tên/TK để so khớp: bỏ dấu, UPPER, bỏ ký tự không chữ-số. */
export function normKey(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function normAcct(s: string | null | undefined): string {
  return (s ?? '').replace(/[^0-9A-Za-z]/g, '');
}

/** Đọc file sao kê MB (xlsx buffer) → tài khoản chủ + danh sách giao dịch chuẩn hoá. Dò header động (dòng chứa
 *  "Phát Sinh Nợ"/"Debit") — không phụ thuộc số dòng cứng (khác kỳ/bản export có thể lệch dòng). */
const parsed_bank_log = (b: string | null): string => `[${b ?? 'BANK'}]`;
export async function parseMbStatement(buffer: Buffer): Promise<ParsedStatement> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { accountHolder: null, accountNumber: null, accountBank: null, txns: [] };

  // Dò dòng header + map cột theo NHÃN (không cứng vị trí) — robust nếu MB đổi thứ tự cột.
  // [Admin Demo 7/9 FIX] Dò header PER-ROW (không tích luỹ chéo dòng — chống 1 cell lạc ở dòng trên chiếm cột debit rồi
  // guard chặn cột thật ở dòng header). Header = dòng có ĐỦ debit + date (cùng dòng). Map cột từ CHÍNH dòng đó.
  let headerRow = -1;
  let sigNgayHieuLuc = false, sigSoGd = false; // chữ ký định dạng ACB (xem chỗ gán bên dưới)
  const col: Record<string, number> = {};
  for (let r = 1; r <= Math.min(ws.rowCount, 40); r++) {
    const row = ws.getRow(r);
    const local: Record<string, number> = {};
    for (let c = 1; c <= ws.columnCount; c++) {
      const t = normKey(cellText(row.getCell(c).value));
      // Hỗ trợ 2 định dạng MB: "SAO KE TK" (Tên TK Đối Ứng / TK Đối Ứng / NH Đối Ứng) + "SỔ PHỤ CHI TIẾT" (Số bút toán /
      // Đơn vị thụ hưởng-chuyển / Tài khoản Account / Ngân hàng đối tác). Nhãn gộp ô lặp → lấy cột ĐẦU (local==null guard).
      // [Admin Demo 8/9 — ACB] sao kê ACB dùng nhãn KHÁC HẲN MB: "Số tiền rút ra"/"Số tiền gửi vào"/"Số GD"/"Ngày giao dịch".
      // KHÔNG khớp nhãn ⇒ trước đây headerRow=-1 ⇒ 0 GD ⇒ báo "kiểm tra đúng file sao kê MB/MBV" (đúng lỗi anh gặp).
      // Lưu ý dòng TỔNG phía trên ("(-) Tổng tiền rút ra") KHÔNG dính vì chuỗi chuẩn hoá là TONGTIENRUTRA ≠ SOTIENRUTRA.
      // [Admin Demo 26/9 — TECHCOMBANK] sao kê TCB ("SỔ PHỤ KIÊM PHIẾU HẠCH TOÁN") dùng nhãn riêng: "Nợ TKTT/Debit",
      // "Có TKTT/Credit", "Đối tác/Remitter", "NH Đối tác/Remitter Bank". Thiếu 2 nhãn tiền ⇒ KHÔNG dò ra dòng tiêu
      // đề ⇒ báo "không phải file sao kê" dù file hợp lệ. Thêm nhãn, KHÔNG đụng nhánh MB/ACB đang chạy.
      if ((t.includes('PHATSINHNO') || t === 'DEBITAMOUNT' || t.includes('DEBITAMO') || t.includes('SOTIENRUTRA') || t.includes('NOTKTT')) && local.debit == null) local.debit = c;
      else if ((t.includes('PHATSINHCO') || t === 'CREDITAMOUNT' || t.includes('CREDITAM') || t.includes('SOTIENGUIVAO') || t.includes('COTKTT')) && local.credit == null) local.credit = c;
      else if ((t === 'SODU' || t === 'BALANCE' || t.includes('SODUCUOI') === false && t.startsWith('SODU')) && local.balance == null) local.balance = c; // [Admin Demo 12/9] cột Số dư (running balance)
      else if ((t.includes('THOIGIANGIAODICH') || t.includes('TRANSACTIONDATE') || t.includes('NGAYGIAODICH')) && local.date == null) local.date = c;
      else if ((t.includes('MATHAMCHIEU') || t.includes('REFERENCE') || t.includes('SOBUTTOAN') || t === 'SOGD' || t.includes('SOGIAODICH')) && local.ref == null) local.ref = c;
      else if ((t.includes('NOIDUNG') || t.includes('DESCRIPTION') || t.includes('DETAILS')) && local.desc == null) local.desc = c;
      // TCB: "Đối tác/Remitter" = TÊN đối ứng. Phải LOẠI "NH Đối tác/Remitter Bank" (có NH/NGANHANG) kẻo cột ngân
      // hàng bị nhận nhầm thành tên — khớp đại lý sẽ so tên với "NGAN HANG TMCP…" và trượt sạch.
      else if ((t.includes('TENTAIKHOANDOIUNG') || t.includes('BENENAME') || t.includes('THUHUONG') || t.includes('DONVICHUYEN') || (t.includes('TEN') && t.includes('DOIUNG'))
                || ((t.includes('DOITAC') || t.includes('REMITTER')) && !t.includes('NH') && !t.includes('NGANHANG') && !t.includes('BANK'))) && local.cpName == null) local.cpName = c;
      // [Agent-4 11/9] thêm nhãn viết tắt "TK Đối Ứng" (TKDOIUNG) — mô tả định dạng MB đầu file ghi đúng nhãn này;
      // thiếu thì cột STK đối ứng KHÔNG được map → mất khớp theo STK (matchType 'account'), chỉ còn khớp tên.
      // An toàn: "Tên TK Đối Ứng" (TENTKDOIUNG) đã bị nhánh cpName phía trên nhận trước (chuỗi có TEN+DOIUNG).
      else if ((t.includes('TAIKHOANDOIUNG') || t.includes('TKDOIUNG') || t.includes('BENEACC') || t.includes('TAIKHOANACCOUNT')) && local.cpAccount == null) local.cpAccount = c;
      // [Admin Demo 26/9 — BẪY Ô GỘP TCB] Tiêu đề TCB gộp ô nên nhãn "Đối tác/Remitter" LẶP ở cột 7..11. Cột 7 vào
      // cpName, nhưng cột 8 (cùng nhãn) rơi xuống nhánh này và chiếm cpBank ⇒ "ngân hàng đối ứng" hoá ra là TÊN
      // đối ứng (đọc ra "KHACH HANG 22"). Nhãn có REMITTER chỉ được tính là NGÂN HÀNG khi kèm NH/BANK.
      else if ((t.includes('NGANHANGDOIUNG') || t.includes('BENEBANK') || t.includes('NGANHANGDOITAC')
                || (t.includes('REMITTER') && (t.includes('NH') || t.includes('BANK')))) && local.cpBank == null) local.cpBank = c;
    }
    if (local.debit != null && local.date != null) {
      headerRow = r; Object.assign(col, local);
      // CHỮ KÝ ĐỊNH DẠNG ACB (file KHÔNG in tên ngân hàng ở header): dòng header có "Ngày hiệu lực" + "Số GD".
      for (let c = 1; c <= ws.columnCount; c++) {
        const t = normKey(cellText(row.getCell(c).value));
        if (t.includes('NGAYHIEULUC')) sigNgayHieuLuc = true;
        if (t === 'SOGD') sigSoGd = true;
      }
      break;
    }
  }
  if (headerRow < 0) {
    return {
      accountHolder: null, accountNumber: null, accountBank: null, txns: [] as StatementTxn[],
      warnings: ['Không tìm thấy DÒNG TIÊU ĐỀ của bảng giao dịch (cần 1 dòng có cột tiền ra — "Phát sinh Nợ"/"Debit"/"Số tiền rút ra" — VÀ cột ngày giao dịch). File này có thể là bản in/PDF-xuất-Excel hoặc định dạng ngân hàng chưa hỗ trợ.']
    };
  }

  // Chủ TK + số TK + ngân hàng (quét vùng trên header). STK/tên có thể ĐỨNG RIÊNG ô HOẶC nhúng trong ô nhãn
  // ("Số tài khoản/Account No: DEMO-ACCT" — SỔ PHỤ). Bank từ dòng "Ngân hàng ...".
  let accountHolder: string | null = null, accountNumber: string | null = null, accountBank: string | null = null;
  for (let r = 1; r < headerRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) {
      const t = cellText(row.getCell(c).value).trim();
      if (!t) continue;
      // [Admin Demo 8/9 — ACB] số TK ACB CHỈ 5 chữ số ("Số tài khoản (VND): 42227") → nới {4,20} khi ĐI KÈM NHÃN
      // (ô đứng riêng vẫn giữ ≥6 để không nhặt bừa số lẻ trong header).
      if (!accountNumber) { if (/^\d{6,20}$/.test(t)) accountNumber = t; else { const m = /(?:Account\s*No|Số\s*tài\s*khoản)\D*(\d{4,20})/i.exec(t); if (m) accountNumber = m[1]; } }
      if (!accountHolder) { if (/^[A-Z][A-Z\s]{5,}$/.test(t) && !/NGAN HANG|OPENING|BALANCE|ACCOUNT|STATEMENT/i.test(t)) accountHolder = t; else { const m = /(?:Account\s*Name|Tên\s*tài\s*khoản|Chủ\s*tài\s*khoản)\s*[:：]?\s*([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ\s]{4,})/i.exec(t); if (m) accountHolder = m[1].trim(); } }
      if (!accountBank && /Ngân hàng|Bank/i.test(t) && t.length > 8) accountBank = shortBank(t);
    }
  }
  // [Admin Demo 8/9 — ACB] Sao kê ACB KHÔNG ghi tên ngân hàng ở phần đầu file (chỉ "BẢNG SAO KÊ GIAO DỊCH - Số tài
  // khoản (VND): …"), nên nhận bằng CHỮ KÝ ĐỊNH DẠNG (header có "Ngày hiệu lực" + "Số GD" — riêng ACB). Không khớp
  // chữ ký và header không ghi ngân hàng ⇒ để NULL (màn tra soát hiện "—" để người duyệt thấy mà kiểm, không tự bịa).
  if (!accountBank && sigNgayHieuLuc && sigSoGd) accountBank = 'ACB';

  const txns: StatementTxn[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const debit = col.debit ? num(row.getCell(col.debit).value) : 0;
    const credit = col.credit ? num(row.getCell(col.credit).value) : 0;
    if (debit === 0 && credit === 0) continue; // dòng trống / tổng / số dư
    const dateRaw = col.date ? row.getCell(col.date).value : null;
    // BỎ DÒNG TỔNG/SỐ DƯ (vd "Phát sinh trong kỳ", "Số dư cuối kỳ") — ô ngày là NHÃN, không phải ngày. Chống parse nhầm
    // dòng tổng thành 1 GD khổng lồ (đã bắt: dòng 2.180 tỷ). Dòng GD thật có ô ngày = Date HOẶC chuỗi ngày/giờ.
    if (!(dateRaw instanceof Date)) {
      const dk = normKey(cellText(dateRaw));
      // [Admin Demo 26/9 — TCB] Bổ sung nhãn dòng TỔNG của Techcombank: "Cộng doanh số / Total volume". Thiếu nhãn này
      // thì dòng tổng bị đọc thành 1 GD giả mang CẢ tiền ra LẪN tiền vào (đo thật: ra 2.502.383.000 + vào
      // 2.501.602.000) ⇒ báo cáo phồng gấp đôi và hiện thành "chưa khớp 2,5 tỷ" hoàn toàn ảo.
      if (dk.includes('PHATSINH') || dk.includes('SODU') || dk.includes('TONG') || dk.includes('OPENING') || dk.includes('CLOSING') || dk.includes('BALANCE')
          || dk.includes('CONGDOANHSO') || dk.includes('TOTALVOLUME') || dk.includes('CONG') || dk === '') continue;
    }
    // [Admin Demo 7/9] GIỜ WALL-CLOCK TRỰC TIẾP (độc lập TZ máy chủ — tránh lớp bug −7h): exceljs đọc serial Excel thành
    // Date theo giờ LOCAL (getHours = ĐÚNG giờ in trên sao kê, vd 08/09 02:15). Xuất "YYYY-MM-DDTHH:MM:00" từ getter
    // LOCAL → frontend hiện Y NGUYÊN (không +/− TZ). KHÔNG dùng toISOString (dịch UTC → phụ thuộc TZ 2 đầu → lệch giờ).
    // Date cell → wall-clock; HOẶC chuỗi "DD/MM/YYYY HH:MM" (SỔ PHỤ MBV, Admin Demo 7/9 "tách giờ từ cột ngày") → ISO
    // wall-clock. Cả 2 ra "YYYY-MM-DDTHH:MM:00" độc lập TZ.
    let dateTime: string | null;
    if (dateRaw instanceof Date) {
      // [Admin Demo 7/9 FIX] exceljs đọc serial Excel thành Date với UTC = giá trị IN TRÊN SAO KÊ (serial không có TZ →
      // exceljs coi là UTC). Phải dùng getUTC* (KHÔNG getHours local — local +7 sẽ CỘNG 7h → 7/9 17:53 hóa 8/9 00:53).
      dateTime = `${dateRaw.getUTCFullYear()}-${String(dateRaw.getUTCMonth() + 1).padStart(2, '0')}-${String(dateRaw.getUTCDate()).padStart(2, '0')}T${String(dateRaw.getUTCHours()).padStart(2, '0')}:${String(dateRaw.getUTCMinutes()).padStart(2, '0')}:00`;
    } else {
      const s = cellText(dateRaw);
      const dm = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2}))?/.exec(s);
      dateTime = dm
        ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}T${(dm[4] ?? '00').padStart(2, '0')}:${dm[5] ?? '00'}:00`
        : (s || null);
    }
    const desc = col.desc ? (cellText(row.getCell(col.desc).value) || null) : null;
    // [Admin Demo 8/9 — ACB] "Số GD" chỉ là số đếm NGẮN của ACB (3408, 3409…) — dùng thẳng làm `ref` là NGUY HIỂM vì ref
    // là KHOÁ CHÍNH của cache statement_txn + bảng override: 2 tài khoản/2 ngày khác nhau trùng số ⇒ GD này ĐÈ GD kia
    // (mất tiền trong đối soát). Nên số ngắn (≤8 chữ số) được GẮN TIỀN TỐ ngân hàng + số TK + ngày ⇒ duy nhất toàn hệ,
    // vẫn ổn định khi tải lại đúng file đó (idempotent). Ref dài dạng FT… của MB/MBV giữ NGUYÊN.
    const refRaw = col.ref ? (cellText(row.getCell(col.ref).value).trim() || null) : null;
    const refKey = refRaw && /^\d{1,8}$/.test(refRaw)
      ? `${accountBank ?? 'BANK'}-${accountNumber ?? '?'}-${(dateTime ?? '').slice(0, 10) || 'x'}-${refRaw}`
      : refRaw;
    txns.push({
      rowIndex: r,
      dateTime,
      ref: refKey,
      debit, credit,
      desc,
      // File có cột đối ứng → lấy thẳng. THIẾU cột (bản MBV rút gọn) → bóc từ NỘI DUNG theo mẫu chi hộ (17/9).
      cpName: (col.cpName ? (cellText(row.getCell(col.cpName).value) || null) : null) ?? bocDoiUngTuNoiDung(desc, accountNumber).cpName,
      cpAccount: (col.cpAccount ? (cellText(row.getCell(col.cpAccount).value) || null) : null) ?? bocDoiUngTuNoiDung(desc, accountNumber).cpAccount,
      cpBank: col.cpBank ? (cellText(row.getCell(col.cpBank).value) || null) : null,
      descName: extractDescName(desc),
      balance: col.balance ? (Number.isFinite(num(row.getCell(col.balance).value)) ? Math.round(num(row.getCell(col.balance).value)) : null) : null
    });
  }
  // [Admin Demo 13/9] SỐ DƯ CUỐI KỲ từ dòng tổng: nhãn "Số dư cuối kỳ"/"Closing balance"/"Số dư cuối" — giá trị
  // (a) cùng ô sau dấu ':', (b) ô số đầu tiên bên phải cùng dòng, (c) ô NGAY DƯỚI cùng cột (bố cục ACB: dòng nhãn
  // rồi dòng số). Chỉ nhận số > 0 (không bịa). Nhãn "Số dư đầu" KHÔNG dính (SODUCUOI ≠ SODUDAU).
  let closingBalance: number | null = null;
  ngoai: for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) {
      const t = normKey(cellText(row.getCell(c).value));
      if (!(t.includes('SODUCUOI') || t.includes('CLOSINGBAL') || t.includes('ENDINGBAL'))) continue;
      const raw = cellText(row.getCell(c).value).trim();
      const m = /[:：]\s*([\d.,]{4,})\s*$/.exec(raw);
      if (m) { const v = num(m[1]); if (v > 0) { closingBalance = Math.round(v); break ngoai; } }
      for (let c2 = c + 1; c2 <= ws.columnCount; c2++) {
        const v = num(row.getCell(c2).value);
        if (v > 0) { closingBalance = Math.round(v); break ngoai; }
      }
      const vDuoi = num(ws.getRow(r + 1).getCell(c).value);
      if (vDuoi > 0) { closingBalance = Math.round(vDuoi); break ngoai; }
    }
  }
  const warnings: string[] = [];
  // [Admin Demo 8/9] CỜ MÁY ĐỌC ĐƯỢC để tầng route CHẶN (fail-closed) — không chỉ cảnh báo chữ.
  // [Admin Demo 26/9 "sao thời gian các bill CK của KT Demo lại toàn 00:00 vậy — xác thực ngay"] CẢNH BÁO THIẾU GIỜ.
  // Sao kê TECHCOMBANK chỉ có cột "Ngày giao dịch", KHÔNG có cột giờ (đã mở file đếm: đúng 8 cột tiêu đề, không
  // cột nào là giờ) ⇒ mọi GD lưu 00:00. MB/MBV/ACB thì có giờ đủ (đo trên kho: MB 1.492 dòng, MBV 425, ACB 380 —
  // KHÔNG dòng nào 00:00; TCB 41/41 dòng đều 00:00).
  // 00:00 KHÔNG phải giờ thật mà là "không biết giờ" — để im là người đọc tưởng GD lúc nửa đêm, và MỌI đối soát
  // theo GIỜ (lưới ±2 phút khớp bill hoàn) sẽ sai câm. Phải nói thẳng ra màn (R198).
  {
    const coGio = txns.some((t) => t.dateTime != null && !/T00:00(:00)?/.test(t.dateTime) && !/ 00:00/.test(t.dateTime));
    if (txns.length > 0 && !coGio) {
      warnings.push(`Sao kê này KHÔNG CÓ CỘT GIỜ (${txns.length} giao dịch đều hiện 00:00) — đây là "không biết giờ", KHÔNG phải giao dịch lúc nửa đêm. Đối soát theo GIỜ (khớp bill hoàn ±2 phút) sẽ không dùng được với file này; hãy khớp theo NGÀY + SỐ TIỀN + tên đối ứng. Sao kê MB/MBV/ACB có giờ đầy đủ.`);
      console.error(`[statement-recon] ${parsed_bank_log(accountBank)} ${txns.length} GD KHÔNG có giờ (file thiếu cột giờ) — đã gắn cảnh báo lên màn tra soát.`);
    }
  }
  const thieuCotDoiUng = col.cpName == null;
  if (thieuCotDoiUng) warnings.push('Sao kê THIẾU cột "Tên tài khoản đối ứng" → chỉ khớp được theo NỘI DUNG giao dịch (kém chính xác hơn). Nên tải lại bản sao kê CÓ cột đối ứng.');
  if (!accountBank) warnings.push('Không nhận ra NGÂN HÀNG của tài khoản sao kê (file không ghi) — cột nguồn sẽ để trống, kiểm lại trước khi kết luận.');
  if (!accountNumber) warnings.push('Không đọc được SỐ TÀI KHOẢN trong phần đầu file — các giao dịch vẫn nạp nhưng nhóm theo nguồn sẽ thiếu.');
  return { accountHolder, accountNumber, accountBank, closingBalance, txns, warnings, thieuCotDoiUng, soGdRa: txns.filter((t) => t.debit > 0).length };
}

// DEALER_REFUND = SigMa hoàn ĐL (nợ→đại lý) · DEALER_RETURN = đại lý HOÀN LẠI SigMa (có←đại lý, Admin Demo 7/9) ·
// INVESTOR_REPAY = SigMa hoàn ứng NĐT (nợ→NĐT) · INVESTOR_ADVANCE = NĐT tạm ứng (có←NĐT). Admin Demo 7/9 thêm loại
// chọn tay khi sửa: TRANSFER (chuyển giữa TK), INTEREST (chuyển lãi), CAPITAL (dồn vốn), OTHER (khác).
// [Admin Demo 8/9] DEALER_ADVANCE = SigMa TẠM ỨNG cho đại lý (tiền RA, cộng vào "thực hoàn" của đại lý). Chỉ set qua SỬA.
export type ReconKind = 'DEALER_REFUND' | 'DEALER_ADVANCE' | 'DEALER_RETURN' | 'INVESTOR_REPAY' | 'INVESTOR_ADVANCE' | 'TRANSFER' | 'INTEREST' | 'CAPITAL' | 'OTHER' | 'UNKNOWN';

/** [Admin Demo 7/9] LƯU SỬA TAY 1 giao dịch sao kê (nhớ cache theo ref) — upsert override. Rỗng field → giữ NULL (bỏ đè).
 *  Trả ok. Bảng chưa migrate → tự tạo (ensureAlphaExtraSchema chạy boot; guard best-effort). */
export async function saveStatementOverride(
  db: Db, input: { ref: string; kind?: string | null; targetName?: string | null; effectiveDate?: string | null; note?: string | null }
): Promise<{ ok: boolean; error?: string }> {
  const ref = (input.ref ?? '').trim();
  if (!ref) return { ok: false, error: 'NO_REF' };
  // [B282/F1 24/11 — agent dòng tiền] LOẠI phải nằm trong danh sách hợp lệ. Mã lạ (client cũ, gõ nhầm,
  // đổi tên hằng) trước đây được lưu thẳng ⇒ GD rơi ra NGOÀI mọi ô tổng — kể cả ô "Chưa khớp" — tiền
  // biến mất khỏi bảng đối soát trong im lặng (tái hiện: 500tr thành 0 ở cả 6 ô, API vẫn ok:true).
  const KIND_HOP_LE = new Set(['DEALER_REFUND', 'DEALER_ADVANCE', 'DEALER_RETURN', 'INVESTOR_REPAY', 'INVESTOR_ADVANCE', 'TRANSFER', 'INTEREST', 'CAPITAL', 'OTHER', 'UNKNOWN']);
  if (input.kind != null && input.kind !== '' && !KIND_HOP_LE.has(input.kind)) {
    return { ok: false, error: 'Loại giao dịch "' + input.kind + '" không hợp lệ. Hợp lệ: ' + [...KIND_HOP_LE].join(', ') + '.' };
  }
  // [B282/F7] Ngày hiệu lực sai định dạng trước đây bị NUỐT IM thành NULL mà vẫn ok:true — người sửa
  // tưởng đã đổi ngày. Nay nói thẳng.
  if (input.effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate)) {
    return { ok: false, error: 'Ngày hiệu lực "' + input.effectiveDate + '" sai định dạng — phải là YYYY-MM-DD (vd 2026-11-20).' };
  }
  const ed = input.effectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate) ? input.effectiveDate : null;
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO statement_txn_override (ref, kind, target_name, effective_date, note, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (ref) DO UPDATE SET kind=$2, target_name=$3, effective_date=$4, note=$5, updated_at=now()`,
      ref, input.kind ?? null, input.targetName ?? null, ed, input.note ?? null
    );
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error)?.message ?? 'DB_ERROR' }; }
}

/** [Admin Demo 7/9] CACHE bền toàn bộ giao dịch sao kê đã nạp (khoá ref, upsert). Chỉ GD có ref. Best-effort (bảng chưa
 *  migrate → bỏ qua). Lưu kèm TK/bank/chủ NGUỒN + ngày (cho load-lại theo ngày). */
export async function cacheStatementTxns(db: Db, parsed: ParsedStatement): Promise<void> {
  for (const t of parsed.txns) {
    if (!t.ref || !t.ref.trim()) continue;
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(t.dateTime ?? '')?.[1] ?? null;
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO statement_txn (ref,date_time,debit,credit,cp_name,cp_account,cp_bank,desc_name,descr,src_account,src_bank,src_holder,day,balance,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
         ON CONFLICT (ref) DO UPDATE SET date_time=$2,debit=$3,credit=$4,cp_name=$5,cp_account=$6,cp_bank=$7,desc_name=$8,descr=COALESCE($9, statement_txn.descr),src_account=$10,src_bank=$11,src_holder=$12,day=$13,balance=COALESCE($14, statement_txn.balance),updated_at=now()`,
        t.ref.trim(), t.dateTime, t.debit, t.credit, t.cpName, t.cpAccount, t.cpBank, t.descName, t.desc ?? null, parsed.accountNumber, parsed.accountBank, parsed.accountHolder, day, t.balance ?? null
      );
    } catch { /* bảng chưa migrate / lỗi phụ — bỏ qua, không chặn upload */ }
  }
}

/** [Admin Demo 13/9] LƯU SỐ DƯ CUỐI KỲ mức TÀI KHOẢN (từ dòng tổng file) — nguồn cho đối chiếu số dư khi file
 *  không có cột Số dư per-GD. as_of_day = ngày GD MUỘN NHẤT trong file (số dư cuối kỳ ứng hết ngày đó). Upsert
 *  chỉ khi ngày mới ≥ ngày đã lưu (file cũ nạp lại không đè lùi số mới). Best-effort. */
export async function cacheClosingBalance(db: Db, parsed: ParsedStatement): Promise<void> {
  if (parsed.closingBalance == null || !parsed.accountNumber) return;
  const days = parsed.txns.map((t) => /^(\d{4}-\d{2}-\d{2})/.exec(t.dateTime ?? '')?.[1]).filter((x): x is string => !!x).sort();
  const asOf = days[days.length - 1];
  if (!asOf) return;
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO statement_account_balance (account, bank, holder, closing, as_of_day, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (account) DO UPDATE SET bank=COALESCE($2, statement_account_balance.bank),
         holder=COALESCE($3, statement_account_balance.holder), closing=$4, as_of_day=$5, updated_at=now()
       WHERE statement_account_balance.as_of_day <= $5`,
      parsed.accountNumber, parsed.accountBank, parsed.accountHolder, parsed.closingBalance, asOf);
  } catch (e) { console.error('[statement-recon] lưu số dư cuối kỳ lỗi (không chặn upload):', e instanceof Error ? e.message : e); }
}

/** [Admin Demo 8/9 — ABB REVIEW] Cache các GD ĐÃ REVIEW/SỬA (từ OCR ảnh) vào statement_txn (raw, khoá ref) + lưu OVERRIDE
 *  cho GD bị sửa loại/đối-tượng (để loadCachedReconciled tái hiện đúng bản đã duyệt). Chỉ nạp khi user "Xác nhận". */
export async function cacheReconciledTxns(
  db: Db,
  txns: { ref: string; dateTime: string | null; debit: number; credit: number; cpName: string | null; cpAccount: string | null; cpBank: string | null; descName: string | null; srcAccount: string | null; srcBank: string | null; srcHolder?: string | null; edited?: boolean; kind?: string; matchedName?: string | null; effectiveDate?: string | null; note?: string | null }[]
): Promise<void> {
  for (const t of txns) {
    if (!t.ref || !t.ref.trim()) continue;
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(t.dateTime ?? '')?.[1] ?? null;
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO statement_txn (ref,date_time,debit,credit,cp_name,cp_account,cp_bank,desc_name,src_account,src_bank,src_holder,day,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
         ON CONFLICT (ref) DO UPDATE SET date_time=$2,debit=$3,credit=$4,cp_name=$5,cp_account=$6,cp_bank=$7,desc_name=$8,src_account=$9,src_bank=$10,src_holder=$11,day=$12,updated_at=now()`,
        t.ref.trim(), t.dateTime, Math.round(t.debit) || 0, Math.round(t.credit) || 0, t.cpName, t.cpAccount, t.cpBank, t.descName, t.srcAccount, t.srcBank, t.srcHolder ?? null, day
      );
    } catch { /* bảng chưa migrate — bỏ qua */ }
    // GD bị SỬA (loại/đối tượng/ngày) → lưu override để re-load áp đúng bản duyệt (kind derive lại từ raw không giữ được).
    if (t.edited && t.kind) {
      await saveStatementOverride(db, { ref: t.ref.trim(), kind: t.kind, targetName: t.matchedName ?? null, effectiveDate: t.effectiveDate ?? null, note: t.note ?? null });
    }
  }
}

/** [Admin Demo 7/9] LOAD lại toàn bộ GD sao kê đã cache (mở màn không cần upload lại). Nhóm theo TK NGUỒN → reconcile TỪNG
 *  nguồn (giữ self-transfer gate theo chủ TK) → gộp. Trả txns đã phân loại + áp override. Rỗng nếu chưa cache. */
export async function loadCachedReconciled(db: Db): Promise<{ txns: ReconTxn[] }> {
  let rows: { ref: string; date_time: string | null; debit: bigint | number; credit: bigint | number; cp_name: string | null; cp_account: string | null; cp_bank: string | null; desc_name: string | null; src_account: string | null; src_bank: string | null; src_holder: string | null }[] = [];
  try { rows = (await db.$queryRawUnsafe(`SELECT ref,date_time,debit,credit,cp_name,cp_account,cp_bank,desc_name,descr,src_account,src_bank,src_holder FROM statement_txn`)) as typeof rows; } catch { return { txns: [] }; }
  if (!rows.length) return { txns: [] };
  // [Admin Demo 26/9 "sửa đúng khớp ngày 25"] TÍNH LẠI tên-từ-nội-dung MỖI LẦN ĐỌC, không tin cột đã lưu.
  // desc_name được chốt LÚC NẠP file; sửa luật bóc tên (vd cắt mã kênh MB "Qaiuif APPMB") sẽ KHÔNG tới được dữ
  // liệu cũ ⇒ phải nạp lại toàn bộ sao kê mới thấy tác dụng. Tính lại lúc đọc = mọi cải tiến TỰ LÀNH cho cả dữ
  // liệu cũ. Nội dung gốc (descr) mới là nguồn sự thật; desc_name chỉ là bản rút gọn suy ra từ nó.
  for (const r of rows) {
    const goc = (r as { descr?: string | null }).descr;
    if (goc) { const lai = extractDescName(goc); if (lai) r.desc_name = lai; continue; }
    // Dòng nạp TRƯỚC khi có cột `descr` (1.071/2.599 dòng) không còn nội dung gốc ⇒ làm sạch NGAY TRÊN desc_name
    // đã lưu (nó vẫn chứa nguyên chuỗi dính mã kênh, vd "KHACH HANG 01 Qaiuif APPMB TRAN A").
    if (r.desc_name) { const lai = extractDescName(r.desc_name); if (lai) r.desc_name = lai; }
  }
  // [Admin Demo 8/9] DEDUP THA JITTER cho GD ABB (ref synthetic, OCR lại dễ lệch phút/mất bank → 2 ref → dup như 36/37).
  // Gộp theo TK+ngày+tiền+tên (bỏ giờ/bank), GIỮ dòng GIÀU thông tin hơn (có cp_bank). MB (ref FT thật) KHÔNG đụng.
  const natOf = (r: typeof rows[number]): string => {
    const day = (r.date_time ?? '').slice(0, 10); const amt = Number(r.debit) || Number(r.credit);
    const nm = normKey(r.cp_name ?? r.desc_name).slice(0, 12);
    return `${normAcct(r.src_account)}|${day}|${amt}|${nm}`;
  };
  const abbSeen = new Map<string, number>(); // natKey → index trong deduped
  const deduped: typeof rows = [];
  for (const r of rows) {
    if (!r.ref?.startsWith('ABB')) { deduped.push(r); continue; }
    const k = natOf(r); const at = abbSeen.get(k);
    if (at === undefined) { abbSeen.set(k, deduped.length); deduped.push(r); }
    else if (!deduped[at].cp_bank && r.cp_bank) deduped[at] = r; // giữ dòng có ngân hàng (giàu hơn)
  }
  rows = deduped;
  const groups = new Map<string, ParsedStatement>();
  for (const r of rows) {
    const key = r.src_account ?? '?';
    let g = groups.get(key);
    if (!g) { g = { accountHolder: r.src_holder, accountNumber: r.src_account, accountBank: r.src_bank, txns: [] }; groups.set(key, g); }
    g.txns.push({ rowIndex: 0, dateTime: r.date_time, ref: r.ref, debit: Number(r.debit), credit: Number(r.credit), desc: null, cpName: r.cp_name, cpAccount: r.cp_account, cpBank: r.cp_bank, descName: r.desc_name });
  }
  const all: ReconTxn[] = [];
  for (const g of groups.values()) { const rec = await reconcileStatement(db, g); all.push(...rec.txns); }
  return { txns: all };
}
export interface MissingBillRow {
  dateTime: string | null; amount: number; receiverName: string | null; receiverAccount: string | null;
  bank: string | null; dealerName: string | null; customerId: number | null; day: string;
}
/** [Admin Demo 8/9 — BÁO CÁO BILL THIẾU ẢNH OCR] Đối chiếu CHÉO: GD HOÀN trên sao kê (DEALER_REFUND/ADVANCE) vs bill hoàn
 *  OCR (isDealerRefundCk, thủ công/tự động). GD sao kê KHÔNG có bill OCR khớp (theo đại lý + ngày + số tiền ±3k) = THIẾU
 *  bill ảnh. DUNG SAI: 1 đại lý hoàn DƯ ≤10.000đ/ngày thì BỎ QUA (không flag). Trả danh sách GD thiếu (đích danh đại lý). */
export async function findMissingOcrBills(db: Db, fromDay: string, toDay: string): Promise<{ rows: MissingBillRow[] }> {
  const { txns } = await loadCachedReconciled(db);
  const dk = (iso: string | null): string => (iso ?? '').slice(0, 10);
  const inRange = (t: ReconTxn): boolean => { const d = dk(t.dateTime); return !!d && d >= fromDay && d <= toDay; };
  const refunds = txns.filter((t) => (t.kind === 'DEALER_REFUND' || t.kind === 'DEALER_ADVANCE') && t.matchedCustomerId != null && inRange(t));
  if (refunds.length === 0) return { rows: [] };

  // Bill hoàn OCR → nhóm theo customerId(phòng chat) + ngày → mảng số tiền.
  const msgs = await db.chatMessage.findMany({ where: { kind: 'IMAGE', deletedAt: null, metadataJson: { contains: '"isDealerRefundCk":true' } }, select: { roomId: true, metadataJson: true } });
  const roomIds = [...new Set(msgs.map((m) => m.roomId))];
  // [Agent-4 11/9] CHỈ link ACTIVE (unassignedAt null) — thiếu lọc thì phòng đã ĐỔI CHỦ dính dòng stale, Map
  // last-wins gán bill vào KHÁCH CŨ (cùng họ bug "đổi chủ máy kéo doanh số"). Đồng bộ reconcileStatement.
  const ccgs = roomIds.length ? await db.customerChatGroup.findMany({ where: { roomId: { in: roomIds }, unassignedAt: null }, select: { roomId: true, customerId: true } }) : [];
  const roomCust = new Map(ccgs.map((g) => [g.roomId, g.customerId]));
  const billsByCD = new Map<string, number[]>();
  for (const m of msgs) {
    if (!m.metadataJson || !m.roomId) continue;
    let p: { refundAmount?: number; billDate?: string | null };
    try { p = JSON.parse(m.metadataJson); } catch { continue; }
    const cid = roomCust.get(m.roomId); if (cid == null) continue;
    const day = (p.billDate ?? '').slice(0, 10); if (!day) continue;
    const amt = Math.abs(Number(p.refundAmount) || 0); if (!amt) continue;
    const k = `${cid}|${day}`; const arr = billsByCD.get(k) ?? []; arr.push(amt); billsByCD.set(k, arr);
  }

  // Nhóm GD sao kê theo customerId + ngày; khớp tham lam với bill (±3k); GD không khớp = ứng viên thiếu.
  const stmtByCD = new Map<string, ReconTxn[]>();
  for (const t of refunds) { const k = `${t.matchedCustomerId}|${dk(t.dateTime)}`; const arr = stmtByCD.get(k) ?? []; arr.push(t); stmtByCD.set(k, arr); }
  const rows: MissingBillRow[] = [];
  for (const [k, list] of stmtByCD) {
    const bills = [...(billsByCD.get(k) ?? [])];
    const unmatched: ReconTxn[] = [];
    for (const t of list.sort((a, b) => b.debit - a.debit)) {
      const j = bills.findIndex((b) => Math.abs(b - t.debit) <= 3000);
      if (j >= 0) bills.splice(j, 1); else unmatched.push(t);
    }
    const sumUn = unmatched.reduce((s, t) => s + t.debit, 0);
    if (sumUn <= 10000) continue; // DUNG SAI hoàn dư ≤10k/ngày → không flag
    for (const t of unmatched) rows.push({ dateTime: t.dateTime, amount: t.debit, receiverName: t.cpName, receiverAccount: t.cpAccount, bank: t.cpBank, dealerName: t.matchedName, customerId: t.matchedCustomerId, day: k.split('|')[1] });
  }
  rows.sort((a, b) => (a.dealerName ?? '').localeCompare(b.dealerName ?? '') || (a.dateTime ?? '').localeCompare(b.dateTime ?? ''));
  return { rows };
}
export interface ReconTxn extends StatementTxn {
  direction: 'OUT' | 'IN';                 // OUT = Phát Sinh Nợ (tiền ra) · IN = Phát Sinh Có (tiền vào)
  kind: ReconKind;
  matchedName: string | null;              // tên ĐẠI LÝ / NĐT đã khớp (hiện cột thêm)
  matchedCustomerId: number | null;        // đại lý (customer) khớp — cho báo cáo tổng từng đại lý
  matchedInvestorId: number | null;        // NĐT khớp
  matchType: 'account' | 'name' | null;    // khớp theo STK hay theo tên
  edited: boolean;                         // [Admin Demo 7/9] đã SỬA TAY (override theo ref, nhớ cache) — kind/target/note đè
  note: string | null;                     // ghi chú người sửa
  effectiveDate: string | null;            // ngày hiệu lực người sửa đặt (YYYY-MM-DD) — đè ngày sao kê nếu có
  srcAccount: string | null;               // TK sao kê nguồn (KT Demo) — cho lọc theo sao kê + cache
  srcBank: string | null;                  // ngân hàng TK sao kê nguồn (MB/MBV/ABB)
  srcHolder: string | null;                // [Admin Demo 8/9] chủ TK sao kê nguồn — prefill "chuyển giữa TK" khi sửa
}
export interface ReconResult {
  accountHolder: string | null;
  accountNumber: string | null;
  accountBank: string | null;
  txns: ReconTxn[];
  // Tổng theo NGÀY (theo ngày TRÊN SAO KÊ) — hoàn đại lý / đại lý hoàn lại / hoàn ứng NĐT / tạm ứng NĐT.
  byDay: { date: string; hoanDaiLy: number; hoanLaiDaiLy: number; hoanUngNDT: number; tamUngNDT: number }[];
  // Tổng theo ĐẠI LÝ (mỗi đại lý + STK) — total = hoàn RÒNG (SigMa hoàn − đại lý hoàn lại).
  byDealer: { name: string; customerId: number | null; account: string | null; bank: string | null; total: number; count: number }[];
  totals: { hoanDaiLy: number; hoanLaiDaiLy: number; hoanUngNDT: number; tamUngNDT: number; unmatchedOut: number; unmatchedIn: number };
}

/** Khớp sao kê với ĐẠI LÝ (từ bill hoàn OCR: receiverAcct/receiverName → phòng → khách) + NĐT (tên/nickname/STK nhận).
 *  Phân loại: NỢ(ra) khớp đại lý→hoàn đại lý; khớp NĐT→hoàn ứng NĐT; CÓ(vào) khớp NĐT→tạm ứng NĐT. */
export async function reconcileStatement(db: Db, parsed: ParsedStatement): Promise<ReconResult> {
  // 1) MAP ĐẠI LÝ từ bill hoàn CK đã OCR: receiverAcct/receiverName → {customerId, dealerName}. Nguồn tên đại lý THẬT.
  const refundMsgs = await db.chatMessage.findMany({
    where: { kind: 'IMAGE', deletedAt: null, metadataJson: { contains: '"isDealerRefundCk":true' } },
    select: { roomId: true, metadataJson: true }
  });
  const roomIds = [...new Set(refundMsgs.map((m) => m.roomId))];
  // [Agent-4 11/9 — STALE LINK] CHỈ lấy link ACTIVE (unassignedAt null) như MỌI chỗ live khác (agentScopeCustomerIds /
  // investorReportDetail / alpha-aggregate). Không lọc → phòng đã ĐỔI CHỦ: Map roomId→customerId last-wins có thể
  // dính dòng stale → hoàn/tổng-đại-lý gán KHÁCH CŨ (cùng họ bug "đổi chủ máy kéo doanh số sang đại lý mới").
  const ccgs = roomIds.length ? await db.customerChatGroup.findMany({ where: { roomId: { in: roomIds }, unassignedAt: null }, select: { roomId: true, customerId: true } }) : [];
  const roomCust = new Map(ccgs.map((g) => [g.roomId, g.customerId]));
  const custIds = [...new Set(ccgs.map((g) => g.customerId))];
  const custs = custIds.length ? await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, fullName: true, nickname: true } }) : [];
  // [Admin Demo 8/9] TÊN ĐẠI LÝ = TÊN NHÓM CHAT ("ĐL- Mr Nguyễn SG") — thống nhất mọi nơi; thiếu nhóm → nickname.
  const rooms = roomIds.length ? await db.chatRoom.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } }) : [];
  const roomName = new Map<string, string>();
  for (const r of rooms) if (r.name) roomName.set(r.id, r.name);
  const custToRoomName = new Map<number, string>();
  for (const g of ccgs) { const rn = g.roomId ? roomName.get(g.roomId) : undefined; if (rn && !custToRoomName.has(g.customerId)) custToRoomName.set(g.customerId, rn); }
  const custName = new Map<number, string>();
  for (const c of custs) custName.set(c.id, custToRoomName.get(c.id) || c.nickname || c.fullName || `KH ${c.id}`);
  const acctToDealer = new Map<string, { customerId: number | null; name: string }>();
  const nameToDealer = new Map<string, { customerId: number | null; name: string }>();
  // [Admin Demo 30/9 "bill Tuấn Anh chuyển KT Demo là ĐL TA hoàn ứng sao lại ghi nhận Nhà Nguyễn"] — GỐC của bug đó:
  // map học-từ-bill ghi kiểu BILL SAU ĐÈ BILL TRƯỚC. Mã QR "VQRQAIUIF6322" (MB nhét vào ô "TK đối ứng" của báo có)
  // nằm trong bill hoàn của 4 PHÒNG khác nhau ⇒ tiền của đại lý này chạy vào sổ đại lý kia, và tên gán ra còn NHẢY
  // theo bill mới nhất (máy Admin Demo hiện "Mr Nguyễn SG", chạy lại ra "Bình SG" — cùng một giao dịch).
  // LUẬT MỚI (khớp nguyên tắc "thà thiếu còn hơn sai"):
  //   1. GOM trước, CAM KẾT sau: khoá chỉ được dùng khi MỌI bill mang nó đều trỏ CÙNG MỘT nhà. Dính ≥2 nhà ⇒ BỎ
  //      (không đoán, không last-wins) — muốn dùng thì KHAI TAY ở statement_dealer_alias, người khai chịu trách nhiệm.
  //   2. CẤM TUYỆT ĐỐI khoá là DANH TÍNH CỦA CHÍNH SIGMA: tên người nhà (KT Demo/ND Demo/KH Demo…) và số TK mà SigMa đang
  //      nạp sao kê — đối ứng là chính mình thì không thể là đại lý (ca thật 16/9: khớp bằng TK MBV DEMO-ACCT của
  //      SigMa ⇒ 68.144.000đ bị ghi thành "đại lý hoàn lại" cho QUỐC HUY SG).
  const tkCuaAlpha = new Set<string>([normAcct(parsed.accountNumber)].filter(Boolean));
  try {
    const tkDaNap = await db.$queryRawUnsafe<Array<{ src_account: string | null }>>('SELECT DISTINCT src_account FROM statement_txn');
    for (const r of tkDaNap) { const a = normAcct(r.src_account); if (a) tkCuaAlpha.add(a); }
  } catch (e) {
    // R198 — CẤM nuốt lỗi: không đọc được thì nói thẳng, chỉ còn chặn được TK của chính file đang xét.
    console.error(`[statement-recon] KHÔNG đọc được danh sách TK của SigMa (${(e as Error)?.message ?? e}) — chỉ loại được TK của file sao kê này`);
  }
  // "nhas" CHỈ đếm nhà CÓ THẬT (customerId khác null). Bill nằm ở phòng chưa liên kết khách (cid null) KHÔNG phải
  // "nhà thứ hai" — nó chỉ là chưa biết; coi nó là mâu thuẫn sẽ giết oan khoá đúng (bắt được nhờ test ACB 30/9).
  // Ưu tiên giữ entry CÓ nhà; chỉ khi không có entry nào có nhà mới dùng entry không-nhà (tên lấy từ bill).
  type UngVien = { nhas: Set<number>; entry: { customerId: number | null; name: string } };
  const ungVienTk = new Map<string, UngVien>(); const ungVienTen = new Map<string, UngVien>();
  const gom = (bang: Map<string, UngVien>, khoa: string, entry: { customerId: number | null; name: string }): void => {
    const cur = bang.get(khoa) ?? { nhas: new Set<number>(), entry };
    if (entry.customerId != null) { cur.nhas.add(entry.customerId); cur.entry = entry; }
    else if (cur.entry.customerId == null) cur.entry = entry;
    bang.set(khoa, cur);
  };
  for (const m of refundMsgs) {
    if (!m.metadataJson) continue;
    let p: { receiverAcct?: string | null; receiverName?: string | null };
    try { p = JSON.parse(m.metadataJson); } catch { continue; }
    const cid = roomCust.get(m.roomId) ?? null;
    const nm = (cid != null ? custName.get(cid) : null) ?? p.receiverName ?? null;
    if (!nm) continue;
    const entry = { customerId: cid, name: nm };
    const a = normAcct(p.receiverAcct); if (a) gom(ungVienTk, a, entry);
    const n = normKey(p.receiverName); if (n) gom(ungVienTen, n, entry);
    const rn = normKey(nm); if (rn) gom(ungVienTen, rn, entry); // [Admin Demo 8/9] tên NHÓM cũng resolve (override chọn tên nhóm)
  }
  const loai = { moHoTk: 0, moHoTen: 0, alphaTk: 0, alphaTen: 0, racTk: 0 };   // ĐẾM ĐỘNG, cấm hard-code
  // 3. KHOÁ RÁC: "số tài khoản" không phải chuỗi số (mã QR MB "VQRQ…", chuỗi OCR đứt kiểu "617", "sh350iii").
  //    Mã QR đổi theo từng lệnh chuyển, không định danh ai — dùng làm khoá là mời tiền chạy nhầm nhà. Bỏ khoá này
  //    KHÔNG mất khớp: các GD đó vẫn về đúng nhà bằng TÊN đối ứng (đo thật 30/9: 37 GD giữ nguyên nhà sau khi bỏ).
  const laSoTaiKhoan = (a: string): boolean => /^[0-9]{4,}$/.test(a);
  for (const [k, v] of ungVienTk) {
    if (tkCuaAlpha.has(k)) { loai.alphaTk++; continue; }
    if (!laSoTaiKhoan(k)) { loai.racTk++; continue; }
    if (v.nhas.size > 1) { loai.moHoTk++; continue; }
    acctToDealer.set(k, v.entry);
  }
  for (const [k, v] of ungVienTen) {
    if (TEN_NGUOI_NHA_ALPHA.has(k)) { loai.alphaTen++; continue; }
    if (v.nhas.size > 1) { loai.moHoTen++; continue; }
    nameToDealer.set(k, v.entry);
  }
  if (loai.moHoTk + loai.moHoTen + loai.alphaTk + loai.alphaTen + loai.racTk > 0) {
    console.error(`[statement-recon] LOẠI khoá học-từ-bill: mơ hồ ${loai.moHoTk} TK + ${loai.moHoTen} tên · danh tính SigMa ${loai.alphaTk} TK + ${loai.alphaTen} tên · rác ${loai.racTk} TK (khai tay ở statement_dealer_alias nếu cần dùng)`);
  }
  // Thêm key nickname khách → entry (dropdown/override chọn nickname vẫn resolve về đúng đại lý).
  for (const cu of custs) { const cid2 = cu.id; const e = [...acctToDealer.values(), ...nameToDealer.values()].find((x) => x.customerId === cid2); if (e) { const nk = normKey(cu.nickname ?? ''); if (nk && !nameToDealer.has(nk)) nameToDealer.set(nk, e); } }
  // 2) MAP NĐT: theo tên/nickname (fullName+nickname) + theo STK nhận (receive_accounts.account_number).
  const investors = await db.investor.findMany({ where: { deletedAt: null }, select: { id: true, fullName: true, nickname: true } });
  const invByName = new Map<string, { id: number; name: string }>();
  for (const iv of investors) {
    const nm = iv.nickname || iv.fullName || `NĐT ${iv.id}`;
    for (const k of [normKey(iv.fullName), normKey(iv.nickname)]) if (k) invByName.set(k, { id: iv.id, name: nm });
  }
  const recvAccts = await db.receiveAccount.findMany({ where: { deletedAt: null, investorId: { not: null } }, select: { accountNumber: true, accountName: true, investorId: true } });
  const acctToInv = new Map<string, number>();
  const invName = new Map(investors.map((iv) => [iv.id, iv.nickname || iv.fullName || `NĐT ${iv.id}`]));
  for (const ra of recvAccts) {
    if (ra.investorId == null) continue;
    const a = normAcct(ra.accountNumber); if (a) acctToInv.set(a, ra.investorId);
    // [Admin Demo 7/9] TÊN CHỦ TK NHẬN = nguồn khớp NĐT theo TÊN (vd "KHACH HANG 02"→Thông, "KHACH HANG 21"→Trung) — sao kê
    // ghi tên đối ứng này, KHÔNG ghi nickname NĐT. Đây là alias THẬT (từ TK uỷ), không cần bảng alias tay.
    const n = normKey(ra.accountName); if (n && !invByName.has(n)) invByName.set(n, { id: ra.investorId, name: invName.get(ra.investorId) ?? `NĐT ${ra.investorId}` });
  }

  // [Admin Demo 26/9 "làm bảng ánh xạ"] ÁNH XẠ TAY đối ứng → đại lý (statement_dealer_alias). Nguồn SỰ THẬT mạnh hơn
  // suy đoán từ bill OCR: gõ 1 lần, mọi GD cũ/mới của người đó tự về đúng đại lý (màn tra soát khớp lại mỗi lần mở).
  // kind_out = loại GD khi TIỀN RA (DEALER_ADVANCE = tạm ứng cho đại lý); tiền VÀO luôn DEALER_RETURN (trả/thu hồi ứng).
  const aliasOut = new Map<number, string>();          // customerId → kind_out
  /** TK SIGMA NHẬN (đã chuẩn hoá) → NĐT, CHỈ dùng khi ô đối ứng KHÔNG CÓ TÊN (sao kê TCB). */
  const srcAcctNoNameToInv = new Map<string, { id: number; name: string }>();
  const aliasNameKeys = new Set<string>();             // TÊN do người khai ánh xạ
  const aliasAcctKeys = new Set<string>();             // SỐ TK do người khai ánh xạ
  try {
    const als = await db.$queryRawUnsafe<Array<{ key: string; key_kind: string; customer_id: number | null; investor_id: number | null; kind_out: string | null }>>(
      `SELECT key, key_kind, customer_id, investor_id, kind_out FROM statement_dealer_alias`);
    const tenKh = new Map((await db.customer.findMany({ where: { deletedAt: null }, select: { id: true, nickname: true, fullName: true } }))
      .map((c) => [c.id, c.nickname || c.fullName || `KH ${c.id}`]));
    for (const a of als) {
      // [Admin Demo 26/9 "cua anh Huy lam C het di"] TK SIGMA NHAN → NHA DAU TU, ap khi doi ung KHONG CO TEN.
      // Sao ke Techcombank khong ghi ten nguoi gui cho tien vao ⇒ khong con khoa nao khac de bam.
      if (a.key_kind === 'src_acct_noname') {
        if (a.investor_id == null) { console.error(`[statement-recon] ánh xạ src_acct_noname key=${a.key} THIẾU investor_id — BỎ QUA (không đoán)`); continue; }
        srcAcctNoNameToInv.set(normAcct(a.key), { id: a.investor_id, name: invName.get(a.investor_id) ?? `NĐT ${a.investor_id}` });
        continue;
      }
      if (a.customer_id == null) { console.error(`[statement-recon] ánh xạ key=${a.key} kind=${a.key_kind} THIẾU customer_id — BỎ QUA`); continue; }
      const nhan = tenKh.get(a.customer_id) ?? `KH ${a.customer_id}`;
      if (a.key_kind === 'acct') { acctToDealer.set(normAcct(a.key), { customerId: a.customer_id, name: nhan }); aliasAcctKeys.add(normAcct(a.key)); }
      else { const k = normKey(a.key); nameToDealer.set(k, { customerId: a.customer_id, name: nhan }); aliasNameKeys.add(k); }
      if (a.kind_out) aliasOut.set(a.customer_id, a.kind_out);
    }
    if (als.length) console.error(`[statement-recon] nạp ${als.length} ánh xạ đối ứng→đại lý (bảng statement_dealer_alias)`);
  } catch { /* bảng chưa migrate → bỏ qua, giữ hành vi cũ */ }

  // Khớp theo STK trước → tên đối ứng (cpName) → TÊN NGƯỜI CHUYỂN trích từ nội dung (descName — báo có MB).
  // [Admin Demo 8/9 - ACB, "tranh nham nguoi gui/nguoi nhan"] Sao ke ACB ghi o NOI DUNG ten NGUOI KHOI TAO lenh, tuc
  // CHINH CHU TK khi tien DI RA ("NGUYEN VAN A CHUYEN KHOAN NHANH..."), KHAC han MB (noi dung = nguoi CHUYEN VAO). Vi vay
  // descName KHONG duoc dung lam "doi ung" khi no chinh la ten SigMa - neu khong se khop nham nguoi.
  const tenDoiUng = (t: StatementTxn): (string | null)[] => {
    const ds = normKey(t.descName);
    return [t.cpName, ds && !SIGMA_NAMES.has(ds) ? t.descName : null];
  };
  const matchDealer = (t: StatementTxn): { customerId: number | null; name: string; how: 'account' | 'name' } | null => {
    // [Admin Demo 26/9 "đưa đúng các khoản hoàn đại lý Đại lý C"] THỨ TỰ ƯU TIÊN khi cùng 1 đối ứng khớp nhiều nguồn:
    //   1) ÁNH XẠ TAY (người khai)  2) là NHÀ ĐẦU TƯ  3) map HỌC TỪ BILL OCR (yếu nhất — bill có thể gửi nhầm phòng).
    // CA THẬT: ĐÚNG 1 bill hoàn 100.000.000đ người nhận KHACH HANG 02/50704397 bị gửi nhầm vào phòng "ĐL- Đại lý C"
    // ⇒ map học "50704397 = Đại lý C" ⇒ kéo theo 79 GD chuyển cho Khach Demo A (20.785.209.478đ) vào sổ Đại lý C, trong
    // khi KHACH HANG 02 là NĐT NĐT 2. Một bill lạc bẻ cong hơn 20 tỷ — phải chặn ở lớp khớp, không chỉ dọn dữ liệu.
    const laAnhXaTay = (a: string, n: string): boolean => aliasAcctKeys.has(a) || [...aliasNameKeys].some((k) => k.length >= 8 && n.includes(k));
    const aAcc = normAcct(t.cpAccount);
    const nTen = normKey(t.cpName);
    if (!laAnhXaTay(aAcc, nTen)) {
      // Đối ứng là NĐT (theo STK hoặc TÊN) → KHÔNG phải đại lý, dù map học-từ-bill có nói gì.
      if (aAcc && acctToInv.has(aAcc)) return null;
      for (const nm of tenDoiUng(t)) { const n = normKey(nm); if (n && invByName.has(n)) return null; }
    }
    const a = normAcct(t.cpAccount); if (a && acctToDealer.has(a)) return { ...acctToDealer.get(a)!, how: 'account' };
    for (const nm of tenDoiUng(t)) { const n = normKey(nm); if (n && nameToDealer.has(n)) return { ...nameToDealer.get(n)!, how: 'name' }; }
    // [Admin Demo 26/9] ÁNH XẠ TAY khớp cả khi tên NẰM LẪN trong chuỗi ("KHACH HANG 22 Qaiuif APPMB …" của MB
    // báo có). NHƯNG CHỈ TRÊN Ô ĐỐI ỨNG (cpName) — TUYỆT ĐỐI KHÔNG dùng descName.
    // [SỬA 26/9 — Admin Demo "sao tự ý phá quy tắc"] Lần đầu em quét cả descName ⇒ lệnh KT Demo chuyển cho KHACH HANG 02
    // (nội dung ghi người BẤM LỆNH là Nhân viên E) bị kéo về Đại lý C. QUY TẮC GỐC của file này: descName là
    // NGƯỜI KHỞI TẠO phía SigMa khi tiền ĐI RA, KHÔNG phải đối ứng. Ánh xạ tay không được phá quy tắc đó.
    const cpn = normKey(t.cpName);
    if (cpn) for (const k of aliasNameKeys) if (k.length >= 8 && cpn.includes(k)) return { ...nameToDealer.get(k)!, how: 'name' };
    // Báo CÓ của MB để trống ô đối ứng, tên người CHUYỂN VÀO nằm ở nội dung ⇒ với TIỀN VÀO mới được xét descName.
    if (!cpn && t.credit > 0) {
      const dn = normKey(t.descName);
      if (dn) for (const k of aliasNameKeys) if (k.length >= 8 && dn.includes(k)) return { ...nameToDealer.get(k)!, how: 'name' };
    }
    return null;
  };
  const matchInvestor = (t: StatementTxn): { id: number; name: string; how: 'account' | 'name' } | null => {
    const a = normAcct(t.cpAccount); if (a && acctToInv.has(a)) { const id = acctToInv.get(a)!; return { id, name: invName.get(id) ?? `NĐT ${id}`, how: 'account' }; }
    for (const nm of tenDoiUng(t)) { const n = normKey(nm); if (n && invByName.has(n)) return { ...invByName.get(n)!, how: 'name' }; }
    return null;
  };

  // [Admin Demo 7/9 GATE self-transfer] Đối ứng = CHÍNH CHỦ TK sao kê (KT Demo) hoặc TK/tên SigMa nội bộ → CHUYỂN GIỮA TK,
  // KHÔNG khớp đại lý/NĐT (chống "KHACH HANG 01" khớp nhầm sang đại lý do bill hoàn cũ). Tên SigMa: KT Demo/ND Demo/KH Demo.
  const selfName = normKey(parsed.accountHolder);
  const selfAcct = normAcct(parsed.accountNumber);
  const SIGMA_NAMES = new Set([selfName, ...TEN_NGUOI_NHA_ALPHA].filter(Boolean));
  // [Admin Demo 26/9] Nhân viên E VỪA là người nhà SigMa (hay đứng tên BẤM LỆNH) VỪA là ĐẠI LÝ Đại lý C khi anh ấy
  // là NGƯỜI NHẬN/NGƯỜI CHUYỂN thật. Vì vậy GIỮ NGUYÊN anh ấy trong SIGMA_NAMES (để lọc khỏi ô nội dung), chỉ
  // tắt gate self khi CHÍNH Ô ĐỐI ỨNG là người đã được ánh xạ thành đại lý — xem laDoiUngDaAnhXa() dưới.
  // [Admin Demo 8/9 — SỬA GỐC "Nhân viên B gửi là sai, đúng là Khach Demo A"] Sao kê MB BÁO CÓ điền CHÍNH CHỦ TK vào cột
  // "Tên/TK đối ứng" (cpName=KHACH HANG 01, cpAccount=CHÍNH TK nguồn) — người CHUYỂN THẬT nằm ở NỘI DUNG (descName=
  // "KHACH HANG 02"=NĐT Thông). Gate self CŨ bắn nhầm (cpAccount==selfAcct / cpName∈SIGMA) → "Chuyển giữa TK", NUỐT mất
  // tạm ứng NĐT. GUARD: nếu descName khớp NĐT/đại lý THẬT (không phải SigMa) → KHÔNG phải self, để nhánh thường khớp.
  // CHỈ dựa NỘI DUNG (descName): MB báo có ghi người CHUYỂN THẬT ở nội dung (cpName/cpAccount bị điền chính chủ TK).
  // CẤM dùng cpAccount ở đây — cpAccount của báo có nội bộ là CHÍNH TK riêng của KT Demo, nếu trùng 1 receiverAcct đại lý
  // (bill hoàn cũ) sẽ bắn nhầm self→DEALER (bug "Đại lý hoàn lại 265.600" = KT Demo tự chuyển DEMO-ACCT→DEMO-ACCT).
  const descIsRealExternalParty = (t: StatementTxn): boolean => {
    const n = normKey(t.descName);
    if (!n || SIGMA_NAMES.has(n)) return false;
    return invByName.has(n) || nameToDealer.has(n);
  };
  /** [Admin Demo 26/9] Ô ĐỐI ỨNG chính là người đã được KHAI ánh xạ thành đại lý (vd Nhân viên E = ĐL Đại lý C)?
   *  CHỈ xét cpName/cpAccount — descName là người BẤM LỆNH phía SigMa, không phải đối ứng. */
  const laDoiUngDaAnhXa = (t: StatementTxn): boolean => {
    const a = normAcct(t.cpAccount);
    if (a && acctToDealer.has(a) && aliasAcctKeys.has(a)) return true;
    const cpn = normKey(t.cpName);
    if (!cpn) return false;
    for (const k of aliasNameKeys) if (k.length >= 8 && cpn.includes(k)) return true;
    return false;
  };
  /** Ô ĐỐI ỨNG hoàn toàn KHÔNG CÓ TÊN? (sao kê TCB để trống tên người gửi cho tiền vào — nội dung chỉ là mã
   *  kiểu "CK107948"). Chỉ khi KHÔNG có tên mới được dùng khoá "tài khoản nhận" — có tên thì tên thắng, để
   *  không kéo nhầm người khác về NĐT đã khai (bài học 79 GD Khach Demo A / 20,7 tỷ). */
  const doiUngKhongTen = (t: StatementTxn): boolean => {
    if (normKey(t.cpName)) return false;
    if (normAcct(t.cpAccount)) return false;
    const dn = normKey(t.descName);
    return !dn || SIGMA_NAMES.has(dn);   // nội dung rỗng, hoặc chỉ là tên chính chủ SigMa
  };
  /** NĐT suy ra từ TK SIGMA NHẬN — chỉ áp cho GD KHÔNG CÓ TÊN đối ứng. */
  const nhaDauTuTheoTkNhan = (t: StatementTxn): { id: number; name: string } | null => {
    if (!doiUngKhongTen(t)) return null;
    const a = normAcct(parsed.accountNumber);
    return (a && srcAcctNoNameToInv.get(a)) || null;
  };

  const isSelf = (t: StatementTxn): boolean => {
    // Đối ứng là ĐẠI LÝ đã khai → KHÔNG phải chuyển nội bộ, dù tên người đó cũng nằm trong danh sách người nhà SigMa.
    if (laDoiUngDaAnhXa(t)) return false;
    if (descIsRealExternalParty(t)) return false; // người chuyển thật (Khach Demo A…) ở nội dung → không phải chuyển nội bộ
    const a = normAcct(t.cpAccount); if (a && selfAcct && a === selfAcct) return true;
    // [Admin Demo 8/9 - ACB] CO cot "Ten tai khoan doi ung" => CHI doi ung quyet dinh noi bo hay khong. TRUOC DAY con xet
    // descName: sao ke ACB de ten CHINH CHU ("NGUYEN VAN A") o noi dung MOI lenh chuyen DI => moi khoan hoan dai ly cua
    // ACB bi gan "Chuyen giua TK" va BIEN MAT khoi tong hoan. Khong co cot doi ung thi moi quay ve noi dung (MB).
    const cn = normKey(t.cpName);
    if (cn) return SIGMA_NAMES.has(cn);
    const dn = normKey(t.descName);
    return !!dn && SIGMA_NAMES.has(dn);
  };

  const txns: ReconTxn[] = parsed.txns.map((t) => {
    const direction: 'OUT' | 'IN' = t.debit > 0 ? 'OUT' : 'IN';
    let kind: ReconKind = 'UNKNOWN', matchedName: string | null = null, matchedCustomerId: number | null = null, matchedInvestorId: number | null = null, matchType: 'account' | 'name' | null = null;
    if (isSelf(t)) {
      kind = 'TRANSFER'; matchedName = 'Chuyển giữa TK (SigMa)'; // chuyển nội bộ giữa các TK KT Demo/SigMa
    } else if (direction === 'OUT') {
      // Tiền RA: đại lý → hoàn đại lý; NĐT → hoàn ứng NĐT.
      const d = matchDealer(t);
      if (d) {
        // Ánh xạ có khai kind_out (vd Đại lý C = tạm ứng) thì theo khai báo, không thì vẫn là HOÀN như cũ.
        kind = (d.customerId != null ? aliasOut.get(d.customerId) : null) as ReconKind ?? 'DEALER_REFUND';
        matchedName = d.name; matchedCustomerId = d.customerId; matchType = d.how;
      }
      else {
        const iv = matchInvestor(t);
        if (iv) { kind = 'INVESTOR_REPAY'; matchedName = iv.name; matchedInvestorId = iv.id; matchType = iv.how; }
        else { const ivTk = nhaDauTuTheoTkNhan(t); if (ivTk) { kind = 'INVESTOR_REPAY'; matchedName = ivTk.name; matchedInvestorId = ivTk.id; matchType = 'account'; } }
      }
    } else {
      // Tiền VÀO: NĐT → tạm ứng NĐT; ĐẠI LÝ chuyển vào → ĐẠI LÝ HOÀN LẠI (Admin Demo 7/9).
      const iv = matchInvestor(t);
      if (iv) { kind = 'INVESTOR_ADVANCE'; matchedName = iv.name; matchedInvestorId = iv.id; matchType = iv.how; }
      else {
        const d = matchDealer(t);
        if (d) { kind = 'DEALER_RETURN'; matchedName = d.name; matchedCustomerId = d.customerId; matchType = d.how; }
        else {
          // CUỐI CÙNG mới tới khoá "tài khoản nhận" (yếu nhất): chỉ khi đối ứng KHÔNG CÓ TÊN.
          const ivTk = nhaDauTuTheoTkNhan(t);
          if (ivTk) { kind = 'INVESTOR_ADVANCE'; matchedName = ivTk.name; matchedInvestorId = ivTk.id; matchType = 'account'; }
        }
      }
    }
    return { ...t, direction, kind, matchedName, matchedCustomerId, matchedInvestorId, matchType, edited: false, note: null as string | null, effectiveDate: null as string | null, srcAccount: parsed.accountNumber, srcBank: parsed.accountBank, srcHolder: parsed.accountHolder };
  });

  // [Admin Demo 7/9] ÁP OVERRIDE SỬA TAY (nhớ cache theo ref) — re-upload sao kê vẫn giữ lần sửa gần nhất. Đè kind + tên
  // (hoàn cho ai) + ngày hiệu lực + note. kind ngoài nhóm hoàn/ứng (chuyển/lãi/dồn vốn/khác) → KHÔNG vào tổng hoàn.
  const refs = txns.map((t) => t.ref).filter((x): x is string => !!x);
  if (refs.length) {
    let ovs: { ref: string; kind: string | null; target_name: string | null; effective_date: string | null; note: string | null }[] = [];
    try { ovs = (await db.$queryRawUnsafe(`SELECT ref, kind, target_name, effective_date, note FROM statement_txn_override WHERE ref = ANY($1::text[])`, refs)) as typeof ovs; } catch { /* bảng chưa migrate — bỏ qua */ }
    const ovMap = new Map(ovs.map((o) => [o.ref, o]));
    for (const t of txns) {
      const o = t.ref ? ovMap.get(t.ref) : undefined;
      if (!o) continue;
      t.edited = true;
      if (o.kind) t.kind = o.kind as ReconKind;
      // [Admin Demo 30/9] ĐỔI LOẠI mà KHÔNG chọn tên ⇒ tên/ID khớp TỰ ĐỘNG cũ KHÔNG còn hiệu lực, phải XOÁ.
      // Ca thật: GD 29/9 18:26 (+100tr của ĐL TA) được sửa thành "Chuyển giữa TK" nhưng cột đại lý VẪN treo tên nhà
      // khác do máy đoán trước đó ⇒ nhìn bảng thành "tiền nhà TA ghi nhận cho nhà kia". Loại trung tính thì không
      // gắn ai; đổi sang nhóm đại lý/NĐT thì bỏ ID của nhóm kia (không để lẫn ID chéo nhóm).
      if (o.kind && !o.target_name) {
        const k = t.kind;
        if (k === 'DEALER_REFUND' || k === 'DEALER_ADVANCE' || k === 'DEALER_RETURN') t.matchedInvestorId = null;
        else if (k === 'INVESTOR_REPAY' || k === 'INVESTOR_ADVANCE') t.matchedCustomerId = null;
        else {
          t.matchedCustomerId = null; t.matchedInvestorId = null; t.matchType = null;
          t.matchedName = k === 'TRANSFER' ? 'Chuyển giữa TK (SigMa)' : null;   // giữ NHÃN chuẩn như dòng tự phân loại
        }
      }
      if (o.target_name) {
        t.matchedName = o.target_name;
        // [Admin Demo 8/9 — FIX "sửa bill sinh ra Nguyễn SG tiếp"] Resolve LẠI id theo TÊN+LOẠI đã sửa → aggregate gộp CHUNG
        // 1 nhóm (trước: chỉ đổi tên, giữ customerId cũ/null → tách 2 nhóm cùng tên). Tên khớp đại lý/NĐT thật → gán id.
        const nk = normKey(o.target_name);
        const okind = t.kind;
        if (okind === 'DEALER_REFUND' || okind === 'DEALER_ADVANCE' || okind === 'DEALER_RETURN') {
          const d = nameToDealer.get(nk); t.matchedCustomerId = d ? d.customerId : null; t.matchedInvestorId = null;
          if (d) t.matchedName = d.name; // [Admin Demo 8/9] TÊN CHUẨN của đại lý (không giữ chuỗi gõ tay) → gộp "2 Nguyễn" làm 1
        } else if (okind === 'INVESTOR_REPAY' || okind === 'INVESTOR_ADVANCE') {
          const iv = invByName.get(nk); t.matchedInvestorId = iv ? iv.id : null; t.matchedCustomerId = null;
          if (iv) t.matchedName = iv.name; // TÊN CHUẨN NĐT
        } else { t.matchedCustomerId = null; t.matchedInvestorId = null; } // chuyển/lãi/dồn vốn/khác — không gắn đại lý/NĐT
      }
      if (o.effective_date) { t.effectiveDate = o.effective_date; t.dateTime = `${o.effective_date}T${(t.dateTime ?? '').slice(11, 16) || '12:00'}:00`; }
      t.note = o.note ?? null;
    }
  }

  // [Admin Demo 27/9 "lại con 2 Đại lý C và ĐL Đại lý C"] CHUẨN HOÁ TÊN HIỂN THỊ — đã có id thì LUÔN dùng tên chuẩn
  // trong DB, bất kể khớp bằng nguồn nào. Ca thật: CÙNG khách #223 nhưng 53 GD ghi "Đại lý C" (tên lấy từ ánh xạ
  // tay = customers.nickname) còn 11 GD ghi "ĐL- Đại lý C" (tên lấy từ map học-từ-bill = tên PHÒNG CHAT) ⇒ bảng
  // tra soát tách làm 2 dòng cho cùng một đại lý, cộng sổ ra 2 nơi. Cùng lớp lỗi "2 Nguyễn" đã sửa 8/9 —
  // chỗ đó chỉ vá nhánh override, nay chặn ở LỚP CUỐI để mọi nguồn khớp đều ra một tên.
  {
    const idsKh = [...new Set(txns.map((t) => t.matchedCustomerId).filter((x): x is number => x != null))];
    const idsNdt = [...new Set(txns.map((t) => t.matchedInvestorId).filter((x): x is number => x != null))];
    if (idsKh.length) {
      const ten = new Map((await db.customer.findMany({ where: { id: { in: idsKh } }, select: { id: true, nickname: true, fullName: true } }))
        .map((c) => [c.id, c.nickname || c.fullName || `KH ${c.id}`]));
      for (const t of txns) if (t.matchedCustomerId != null) t.matchedName = ten.get(t.matchedCustomerId) ?? t.matchedName;
    }
    if (idsNdt.length) {
      const ten = new Map((await db.investor.findMany({ where: { id: { in: idsNdt } }, select: { id: true, nickname: true, fullName: true } }))
        .map((c) => [c.id, c.nickname || c.fullName || `NĐT ${c.id}`]));
      for (const t of txns) if (t.matchedInvestorId != null) t.matchedName = ten.get(t.matchedInvestorId) ?? t.matchedName;
    }
  }

  // Tổng theo ngày (NGÀY TRÊN SAO KÊ, wall-clock) + theo đại lý. dayKey = 10 ký tự đầu "YYYY-MM-DD" (không ±TZ).
  const dayKey = (iso: string | null): string => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? ''); return m ? m[1] : '?'; };
  const dayMap = new Map<string, { hoanDaiLy: number; hoanLaiDaiLy: number; hoanUngNDT: number; tamUngNDT: number }>();
  const dealerMap = new Map<string, { name: string; customerId: number | null; account: string | null; bank: string | null; total: number; count: number }>();
  const totals = { hoanDaiLy: 0, hoanLaiDaiLy: 0, hoanUngNDT: 0, tamUngNDT: 0, unmatchedOut: 0, unmatchedIn: 0 };
  const dealerEntry = (t: ReconTxn) => {
    const key = `${t.matchedCustomerId ?? 'x'}|${normAcct(t.cpAccount)}`;
    const de = dealerMap.get(key) ?? { name: t.matchedName ?? (t.cpName ?? '?'), customerId: t.matchedCustomerId, account: t.cpAccount, bank: t.cpBank, total: 0, count: 0 };
    dealerMap.set(key, de); return de;
  };
  for (const t of txns) {
    const dk = dayKey(t.dateTime);
    const db_ = dayMap.get(dk) ?? { hoanDaiLy: 0, hoanLaiDaiLy: 0, hoanUngNDT: 0, tamUngNDT: 0 }; dayMap.set(dk, db_);
    if (t.kind === 'DEALER_REFUND') { totals.hoanDaiLy += t.debit; db_.hoanDaiLy += t.debit; const de = dealerEntry(t); de.total += t.debit; de.count++; }
    else if (t.kind === 'DEALER_ADVANCE') { totals.hoanDaiLy += t.debit; db_.hoanDaiLy += t.debit; const de = dealerEntry(t); de.total += t.debit; de.count++; } // [Admin Demo 8/9] SigMa tạm ứng ĐL (ra) → cộng vào thực hoàn ĐL
    else if (t.kind === 'DEALER_RETURN') { totals.hoanLaiDaiLy += t.credit; db_.hoanLaiDaiLy += t.credit; const de = dealerEntry(t); de.total -= t.credit; de.count++; } // hoàn RÒNG trừ đi phần đại lý trả lại
    else if (t.kind === 'INVESTOR_REPAY') { totals.hoanUngNDT += t.debit; db_.hoanUngNDT += t.debit; }
    else if (t.kind === 'INVESTOR_ADVANCE') { totals.tamUngNDT += t.credit; db_.tamUngNDT += t.credit; }
    // [Admin Demo 8/9] "Chưa khớp" CHỈ đếm UNKNOWN. TRANSFER/INTEREST/CAPITAL/OTHER = ĐÃ phân loại → KHÔNG tính chưa-khớp.
    else if (t.kind === 'UNKNOWN') { if (t.direction === 'OUT') totals.unmatchedOut += t.debit; else totals.unmatchedIn += t.credit; }
    else if (t.kind === 'TRANSFER' || t.kind === 'INTEREST' || t.kind === 'CAPITAL' || t.kind === 'OTHER') { /* đã phân loại trung tính — không vào ô nào theo lệnh 8/9 */ }
    else {
      // [B282/F1 24/11] NHÁNH CHẶN CUỐI — CẤM GD rơi ra ngoài mọi ô tổng (R198). Mã lạ còn lọt tới đây
      // (dữ liệu cũ ghi trước khi có whitelist) thì tính như CHƯA KHỚP + kêu to, không im lặng.
      console.error('[statement-recon B282] GD ref=' + (t.ref ?? '?') + ' mang loại lạ "' + String(t.kind) + '" — tính vào CHƯA KHỚP.');
      if (t.direction === 'OUT') totals.unmatchedOut += t.debit; else totals.unmatchedIn += t.credit;
    }
  }
  const byDay = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
  const byDealer = [...dealerMap.values()].sort((a, b) => b.total - a.total);
  return { accountHolder: parsed.accountHolder, accountNumber: parsed.accountNumber, accountBank: parsed.accountBank, txns, byDay, byDealer, totals };
}

