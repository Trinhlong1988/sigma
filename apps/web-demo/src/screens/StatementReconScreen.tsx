// [Admin Demo 7/9] TRA SOÁT SAO KÊ — chọn NHIỀU file / cả FOLDER sao kê ngân hàng (xlsx), chạy lần lượt → GỘP + DEDUP theo
// Mã Tham Chiếu (chống trùng file/GD) → nhận diện GD, khớp tài khoản chuyển ra với ĐẠI LÝ (từ bill hoàn OCR) + NĐT.
// Lưới file đã nạp + đủ bộ lọc (báo có/ghi nợ · đại lý-NĐT · số TK · ngân hàng · tên TK đối ứng). Báo cáo theo ngày +
// tổng từng đại lý mỗi tài khoản. Tổng/biểu đồ phản ánh theo bộ lọc đang chọn.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { FileSpreadsheet, Upload, FolderOpen, Loader2, Building2, PiggyBank, AlertTriangle, X, Pencil, Download, Landmark, Zap, Banknote } from 'lucide-react';
import { fetchAutoStatement, uploadStatement, uploadStatementImage, commitOcrImageTxns, saveStatementOverride, fetchCachedStatements, fetchClassifyOptions, exportStatementXlsx, fetchMissingBills, fetchBalanceCheck, type BalanceCheckData, type StmtReconTxn, type StmtReconKind, type MissingBillRow } from '../lib/ocr-send-api';
import { downloadBlob } from '../lib/attachment-blob';
import { bankColor as bankColorChuan } from '../lib/bank-visual'; // CHUẨN màu ngân hàng dùng chung mọi màn
import { isAlphaOwnerCode } from '../lib/alpha-aggregate-client'; // allowlist mã chủ SigMa (mirror server)
import { getCachedAuthenticatedAgent } from '../lib/bot-api-client';
import { useDownloadDialog } from '../components/DownloadDoneDialog';

/** Nhãn tài khoản SAO KÊ nguồn "STK · Bank" (cho lọc + lưới). */
function srcLabel(t: StmtReconTxn): string { return t.srcAccount ? `${t.srcAccount}${t.srcBank ? ' · ' + t.srcBank : ''}` : '(không rõ)'; }
/** "2026-09-09" cho hiển thị gọn trong log tự động. */
function ymdShort(d: Date): string { return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; }
/** Số TK mặc định cho "Lấy sao kê tự động": nhớ lần trước; chưa có thì dùng TK MB Nhân viên B đang chạy tiền. */
const TK_MAC_DINH_KEY = 'stmt.autoAccount';
const TK_MB_DEMO = 'DEMO-ACCT';
function tkMacDinh(): string {
  try { return window.localStorage.getItem(TK_MAC_DINH_KEY) || TK_MB_DEMO; } catch { return TK_MB_DEMO; }
}
function ymdToday(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
/** Khoảng ngày [from,to] (YYYY-MM-DD, bao gồm cả 2 đầu) theo chu kỳ — lọc GD theo ngày trên sao kê. */
function periodRange(p: string, from: string, to: string): { lo: string; hi: string } | null {
  const t = new Date(); const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (p === 'all') return null;
  if (p === 'today') return { lo: ymd(t), hi: ymd(t) };
  if (p === 'yesterday') { const y = new Date(t.getTime() - 86400000); return { lo: ymd(y), hi: ymd(y) }; }
  if (p === 'week') { const w = new Date(t.getTime() - 6 * 86400000); return { lo: ymd(w), hi: ymd(t) }; }
  if (p === 'month') return { lo: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`, hi: ymd(t) };
  return { lo: from, hi: to };
}

function fmtVnd(n: number): string { return Math.round(n).toLocaleString('vi-VN'); }
// [Admin Demo 7/9] Giờ từ backend là WALL-CLOCK "YYYY-MM-DDTHH:MM:00" (giờ in trên sao kê) — parse THẲNG thành phần, KHÔNG
// new Date()/±TZ (độc lập múi giờ máy, tránh lệch giờ). Cell không phải Date → chuỗi thô → hiện phần đầu.
function parseWc(s: string | null): { y: string; mo: string; d: string; h: string; mi: string } | null {
  const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s ?? '');
  return m ? { y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5] } : null;
}
function dmy(s: string | null): string { const p = parseWc(s); return p ? `${p.d}/${p.mo}/${p.y}` : (s ? s.slice(0, 10) : '—'); }
function hm(s: string | null): string { const p = parseWc(s); return p ? `${p.h}:${p.mi}` : '—'; }
function dayKey(s: string | null): string { const p = parseWc(s); return p ? `${p.y}-${p.mo}-${p.d}` : '?'; }
// [Admin Demo 8/9] KHOÁ TỰ NHIÊN THA JITTER (chống dup OCR lại lệch phút/mất bank): TK nguồn + NGÀY + số tiền + tên đối
// ứng (bỏ dấu-hoa, 12 ký tự đầu). KHÔNG gồm GIỜ/BANK → 18:46↔18:47, BIDV↔null vẫn khớp = 1 giao dịch.
// [Admin Demo 8/9] Tên ĐỐI ỨNG hiển thị: MB báo có điền CHÍNH CHỦ TK sao kê vào cpName (người chuyển thật ở descName) →
// nếu cpName == chủ TK sao kê (srcHolder) mà có descName → hiện descName (đúng người gửi, vd Khach Demo A).
function normU(s: string | null | undefined): string { return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase(); }
function cpDisplay(t: StmtReconTxn): string {
  if (t.cpName && t.srcHolder && normU(t.cpName) === normU(t.srcHolder) && t.descName) return t.descName;
  return t.cpName || t.descName || '—';
}
// [Admin Demo 8/9] PHÂN TÁCH đúng người gửi / người nhận theo CHIỀU:
//  • GHI NỢ (OUT, tiền RA): người GỬI = chủ TK sao kê (KT Demo); người NHẬN = đối ứng (cpDisplay).
//  • BÁO CÓ (IN, tiền VÀO): người GỬI = đối ứng (cpDisplay, đã xử pollution); người NHẬN = chủ TK sao kê.
function senderOf(t: StmtReconTxn): string { return t.direction === 'IN' ? cpDisplay(t) : (t.srcHolder || '—'); }
function receiverOf(t: StmtReconTxn): string { return t.direction === 'IN' ? (t.srcHolder || '—') : cpDisplay(t); }
function natKeyOf(t: StmtReconTxn): string {
  const amt = t.debit || t.credit;
  const nm = (t.cpName ?? t.descName ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
  return `${(t.srcAccount ?? '').replace(/\W/g, '')}|${dayKey(t.dateTime)}|${amt}|${nm}`;
}

const KIND_LABEL: Record<StmtReconKind, string> = { DEALER_REFUND: 'Hoàn đại lý', DEALER_ADVANCE: 'Tạm ứng đại lý', DEALER_RETURN: 'Đại lý hoàn lại', INVESTOR_REPAY: 'Hoàn ứng NĐT', INVESTOR_ADVANCE: 'Tạm ứng NĐT', TRANSFER: 'Chuyển giữa TK', INTEREST: 'Chuyển lãi', CAPITAL: 'Dồn vốn', OTHER: 'Khác', UNKNOWN: 'Chưa khớp' };
const KIND_CLS: Record<StmtReconKind, string> = { DEALER_REFUND: 'bg-success/10 text-success', DEALER_ADVANCE: 'bg-orange-100 text-orange-700', DEALER_RETURN: 'bg-teal-100 text-teal-700', INVESTOR_REPAY: 'bg-amber-100 text-amber-700', INVESTOR_ADVANCE: 'bg-brand/10 text-brand', TRANSFER: 'bg-indigo-100 text-indigo-700', INTEREST: 'bg-pink-100 text-pink-700', CAPITAL: 'bg-purple-100 text-purple-700', OTHER: 'bg-slate-200 text-slate-600', UNKNOWN: 'bg-slate-100 text-slate-500' };
// Loại chọn khi SỬA (Admin Demo 8/9): hoàn/tạm-ứng-ĐL/hoàn-lại + ứng-NĐT + chuyển giữa TK / lãi / dồn vốn / khác.
const KIND_OPTIONS: StmtReconKind[] = ['DEALER_REFUND', 'DEALER_ADVANCE', 'DEALER_RETURN', 'INVESTOR_REPAY', 'INVESTOR_ADVANCE', 'TRANSFER', 'INTEREST', 'CAPITAL', 'OTHER'];
const isDealerKind = (k: StmtReconKind): boolean => k === 'DEALER_REFUND' || k === 'DEALER_ADVANCE' || k === 'DEALER_RETURN';
const isInvestorKind = (k: StmtReconKind): boolean => k === 'INVESTOR_REPAY' || k === 'INVESTOR_ADVANCE';
// [Admin Demo 8/9] Tách 2 cột Người gửi / Người nhận (11 cột): STT·Ngày·Giờ·Loại·Số tiền·Người gửi·Người nhận·Đại lý/NĐT·Số TK·Ngân hàng·Sửa
const STMT_GRID = '40px 88px 50px 104px minmax(120px,1fr) minmax(140px,1.1fr) minmax(140px,1.1fr) minmax(130px,1fr) 120px minmax(120px,0.9fr) 46px';

// [Admin Demo 9/9] "log hiện danh sách sao kê, TK ở tra soát, STK đó theo CHU KỲ NGÀY sao kê" → mỗi dòng log nhớ thêm
// KỲ NGÀY của chính file đó (ngày GD nhỏ nhất → lớn nhất trong file), để nhìn log biết ngay TK nào đã nạp tới đâu.
interface LoadedFile { name: string; total: number; added: number; dup: number; holder: string | null; account: string | null; bank?: string | null; tuNgay?: string | null; denNgay?: string | null; }
/** Kỳ ngày của 1 file sao kê: min/max phần ngày (YYYY-MM-DD) trong danh sách GD. */
function kyNgayCuaFile(txns: { dateTime: string | null }[]): { tuNgay: string | null; denNgay: string | null } {
  const ds = txns.map((t) => (t.dateTime ?? '').slice(0, 10)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
  return { tuNgay: ds[0] ?? null, denNgay: ds[ds.length - 1] ?? null };
}
/** "2026-09-08" → "08/09" (kỳ ngày hiển thị gọn trong log). */
function ngayGon(s: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  return m ? `${m[3]}/${m[2]}` : '—';
}
// [Admin Demo 8/9] Màu thương hiệu ngân hàng (badge lưới file). Không khớp → xám.
// [Admin Demo 8/9] MÀU NGÂN HÀNG lấy từ CHUẨN DÙNG CHUNG `lib/bank-visual` (MB xanh #1650a3 · MBV ĐỎ #d32f2f ·
// ABBank COBAN #0a3d91) — trước đây màn này tự chế bảng màu riêng (MBV thành XANH LÁ) nên lệch các màn khác.
// Bank lạ (VCB/TCB/ACB…) chưa có trong chuẩn → xám slate, KHÔNG tự bịa màu ở đây nữa (muốn thêm thì thêm vào chuẩn).
function bankColor(b: string | null | undefined): string {
  return bankColorChuan(b) ?? '#64748b';
}

type MergedTxn = StmtReconTxn; // nguồn lấy từ t.srcAccount/srcBank (backend set)

/** Gộp: dedup theo Mã Tham Chiếu (ref) — GD cùng ref = cùng giao dịch (trùng file/kỳ chồng). GD không ref: dedup theo
 *  ngày+tiền+tên đối ứng (an toàn). Trả txns mới thêm. */
function mergeTxns(existing: StmtReconTxn[], seen: Set<string>, incoming: StmtReconTxn[]): { merged: StmtReconTxn[]; added: number; dup: number } {
  let added = 0, dup = 0;
  const out = [...existing];
  for (const t of incoming) {
    const key = t.ref && t.ref.trim() ? `ref:${t.ref.trim()}` : `nat:${dayKey(t.dateTime)}|${t.debit}|${t.credit}|${(t.cpName ?? '').trim().toUpperCase()}|${(t.cpAccount ?? '').replace(/\W/g, '')}`;
    if (seen.has(key)) { dup++; continue; }
    seen.add(key); out.push(t); added++;
  }
  return { merged: out, added, dup };
}

function aggregate(txns: StmtReconTxn[]) {
  const totals = { hoanDaiLy: 0, hoanLaiDaiLy: 0, hoanUngNDT: 0, tamUngNDT: 0, unmatchedOut: 0, unmatchedIn: 0 };
  const dayMap = new Map<string, { hoanDaiLy: number; hoanLaiDaiLy: number; hoanUngNDT: number; tamUngNDT: number }>();
  // [Admin Demo 8/9] GỘP theo ĐẠI LÝ (mọi tài khoản CỘNG làm 1 dòng). Hoàn · Ứng ĐL · Hoàn lại · THỰC hoàn=hoàn+ứng−hoàn lại.
  const dealerMap = new Map<string, { name: string; refund: number; advance: number; returned: number; count: number }>();
  const de = (t: StmtReconTxn) => { const key = t.matchedCustomerId != null ? `c${t.matchedCustomerId}` : `n${(t.matchedName ?? t.cpName ?? '?').trim().toUpperCase()}`; const e = dealerMap.get(key) ?? { name: t.matchedName ?? t.cpName ?? '?', refund: 0, advance: 0, returned: 0, count: 0 }; dealerMap.set(key, e); return e; };
  // [Admin Demo 8/9] GỘP theo NĐT: tạm ứng (vào) · hoàn ứng (ra) · THỰC ứng = tạm ứng − hoàn ứng.
  const invMap = new Map<string, { name: string; advance: number; repay: number; count: number }>();
  const ie = (t: StmtReconTxn) => { const key = t.matchedInvestorId != null ? `i${t.matchedInvestorId}` : `n${(t.matchedName ?? '?').trim().toUpperCase()}`; const e = invMap.get(key) ?? { name: t.matchedName ?? '?', advance: 0, repay: 0, count: 0 }; invMap.set(key, e); return e; };
  // [Admin Demo 8/9] ĐỐI SOÁT SỐ DƯ CUỐI NGÀY mỗi TK sao kê (đầu kỳ = 0): cuối = Σ báo có − Σ ghi nợ (transfer nội bộ tính bình thường trong từng TK). Khớp bank = không sót GD.
  const acctMap = new Map<string, { account: string; bank: string | null; credit: number; debit: number; count: number }>();
  for (const t of txns) {
    const dk = dayKey(t.dateTime);
    const db = dayMap.get(dk) ?? { hoanDaiLy: 0, hoanLaiDaiLy: 0, hoanUngNDT: 0, tamUngNDT: 0 }; dayMap.set(dk, db);
    // Số dư từng TK sao kê: MỌI GD (kể cả transfer) tính vào +báo có / −ghi nợ.
    if (t.srcAccount) { const ak = t.srcAccount; const ae = acctMap.get(ak) ?? { account: ak, bank: t.srcBank, credit: 0, debit: 0, count: 0 }; ae.credit += t.credit; ae.debit += t.debit; ae.count++; acctMap.set(ak, ae); }
    if (t.kind === 'DEALER_REFUND') { totals.hoanDaiLy += t.debit; db.hoanDaiLy += t.debit; const e = de(t); e.refund += t.debit; e.count++; }
    else if (t.kind === 'DEALER_ADVANCE') { totals.hoanDaiLy += t.debit; db.hoanDaiLy += t.debit; const e = de(t); e.advance += t.debit; e.count++; } // SigMa tạm ứng ĐL (ra) → cộng thực hoàn
    else if (t.kind === 'DEALER_RETURN') { totals.hoanLaiDaiLy += t.credit; db.hoanLaiDaiLy += t.credit; const e = de(t); e.returned += t.credit; e.count++; }
    else if (t.kind === 'INVESTOR_REPAY') { totals.hoanUngNDT += t.debit; db.hoanUngNDT += t.debit; const e = ie(t); e.repay += t.debit; e.count++; }
    else if (t.kind === 'INVESTOR_ADVANCE') { totals.tamUngNDT += t.credit; db.tamUngNDT += t.credit; const e = ie(t); e.advance += t.credit; e.count++; }
    // [Admin Demo 8/9] "Chưa khớp" CHỈ đếm UNKNOWN. TRANSFER/INTEREST/CAPITAL/OTHER = ĐÃ phân loại (sửa tay) → KHÔNG tính.
    else if (t.kind === 'UNKNOWN') { if (t.direction === 'OUT') totals.unmatchedOut += t.debit; else totals.unmatchedIn += t.credit; }
  }
  return {
    totals,
    byDay: [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    byInvestor: [...invMap.values()].map((e) => ({ ...e, net: e.advance - e.repay })).sort((a, b) => b.net - a.net),
    byAccount: [...acctMap.values()].map((e) => ({ ...e, closing: e.credit - e.debit })).sort((a, b) => a.account.localeCompare(b.account)),
    byDealer: [...dealerMap.values()].map((e) => ({ ...e, total: e.refund + e.advance - e.returned })).sort((a, b) => b.total - a.total)
  };
}

/** BẢN NHỚ TRONG PHIÊN của màn tra soát (Admin Demo 11/9): vào lại màn có số ngay, không màn trắng + không dựng lại
 *  từ đầu. Chỉ sống trong 1 phiên tab; luôn có lượt tải mới đè lên nên không sợ số cũ. */
let boNhoSaoKe: { at: number; txns: StmtReconTxn[]; files: LoadedFile[] } | null = null;

export function StatementReconScreen(): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null); // [Admin Demo 8/9] ảnh chụp GD (ABB) — chọn nhiều file
  const imgFolderRef = useRef<HTMLInputElement>(null); // [Admin Demo 8/9] chọn cả FOLDER ảnh (tự nhận mọi ảnh)
  const [review, setReview] = useState<StmtReconTxn[]>([]); // [Admin Demo 8/9] GD OCR ảnh chờ REVIEW/sửa trước khi nạp
  const [reviewSaving, setReviewSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // tên file đang xử lý
  const [err, setErr] = useState<string | null>(null);
  // [Admin Demo 8/9 — ACB] CẢNH BÁO khi đọc file (thiếu cột đối ứng, không rõ ngân hàng…): hiện rõ, không nuốt câm.
  const [canhBaoFile, setCanhBaoFile] = useState<{ file: string; msg: string }[]>([]);
  // [Admin Demo 9/9 — BUG "bấm sao kê tự động không hiện ra gì"] TRƯỚC dùng window.prompt: chạy trên WEB nhưng ELECTRON
  // (app SigMa PC) KHÔNG hỗ trợ prompt → bấm xong im lặng. NAY dùng hộp thoại trong app + nhớ số TK dùng lần trước.
  const [hopTuDong, setHopTuDong] = useState<string | null>(null);
  // [Admin Demo 9/9] Khung "File đã nạp" dạng LOG CUỘN: mở/thu + tự cuộn tới file mới nhất mỗi khi nạp thêm.
  const [moFile, setMoFile] = useState(true);
  const khungFileRef = useRef<HTMLDivElement | null>(null);
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [txns, setTxns] = useState<MergedTxn[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const [dir, setDir] = useState<'ALL' | 'OUT' | 'IN'>('ALL');
  const [fDealer, setFDealer] = useState('');   // lọc ĐẠI LÝ (dropdown riêng)
  const [fInvestor, setFInvestor] = useState(''); // lọc NĐT (dropdown riêng)
  const [fKind, setFKind] = useState('');   // [Admin Demo 8/9] LỌC PHÂN LOẠI (thay dropdown Ngân hàng)
  const [fSrc, setFSrc] = useState('');     // tài khoản SAO KÊ nguồn (file nào)
  // [Admin Demo 7/9] CHU KỲ NGÀY (mặc định HÔM NAY) như báo cáo lô/hoàn tiền — lọc GD theo ngày trên sao kê.
  const [period, setPeriod] = useState<'today' | 'yesterday' | 'week' | 'month' | 'range' | 'all'>('today');
  const [rangeFrom, setRangeFrom] = useState(ymdToday());
  const [rangeTo, setRangeTo] = useState(ymdToday());
  const [loadingCache, setLoadingCache] = useState(true);
  const [tab, setTab] = useState<'detail' | 'report'>('detail'); // [Admin Demo 8/9] TAB: Chi tiết GD gộp | Báo cáo tra soát
  const [xlsx, setXlsx] = useState<'idle' | 'ok' | 'err'>('idle');
  const [missing, setMissing] = useState<{ rows: MissingBillRow[]; loading: boolean; done: boolean }>({ rows: [], loading: false, done: false });
  const [mDealer, setMDealer] = useState(''); // lọc đại lý ở bill thiếu
  const [mAmount, setMAmount] = useState(''); // tìm theo số tiền ở bill thiếu
  const { showDownloadDone, downloadDialog } = useDownloadDialog();
  // [Admin Demo 8/9] Dropdown "Hoàn cho ai" theo loại: list đại lý / NĐT có sẵn (từ classifyOptions).
  const [pickOpts, setPickOpts] = useState<{ dealers: string[]; investors: string[] }>({ dealers: [], investors: [] });
  // [Admin Demo 8/9] map TÊN→id (resolve customerId/investorId khi sửa → aggregate gộp 1 nhóm, hết "sinh Nguyễn SG tiếp").
  const nameToDealerId = useRef<Map<string, number>>(new Map());
  const nameToInvId = useRef<Map<string, number>>(new Map());
  useEffect(() => { void fetchClassifyOptions().then((r) => {
    if (!r.ok) return;
    setPickOpts({ dealers: [...new Set(r.data.dealers.map((d) => d.name))].sort((a, b) => a.localeCompare(b)), investors: [...new Set(r.data.investors.map((i) => i.name))].sort((a, b) => a.localeCompare(b)) });
    nameToDealerId.current = new Map(r.data.dealers.filter((d) => d.customerId != null).map((d) => [d.name, d.customerId as number]));
    nameToInvId.current = new Map(r.data.investors.map((i) => [i.name, i.id]));
  }); }, []);

  // Mở màn → LOAD lại toàn bộ sao kê đã cache (như báo cáo doanh số — không cần upload lại).
  // [Admin Demo 11/9 — "load cũng bị giật, cảm giác không cache"] ĐO THẬT: server trả 1089 GD trong 0,1-0,4s (không
  // phải lỗi mạng) — giật là do CLIENT dựng lại toàn bộ danh sách mỗi lần vào màn. Nay giữ BẢN NHỚ TRONG PHIÊN:
  // vào lại màn là có ngay số cũ (không màn trắng), rồi mới lặng lẽ tải bản mới thay vào.
  useEffect(() => {
    const nho = boNhoSaoKe;
    if (nho && Date.now() - nho.at < 5 * 60_000) {
      seenRef.current = new Set(nho.txns.map((t) => t.ref ? `ref:${t.ref}` : `nat:${t.rowIndex}`));
      setTxns(nho.txns);
      setFiles(nho.files);
      setLoadingCache(false);
    }
    fetchCachedStatements().then((r) => {
      setLoadingCache(false);
      if (r.ok && r.data.txns.length) {
        seenRef.current = new Set(r.data.txns.map((t) => t.ref ? `ref:${t.ref}` : `nat:${t.rowIndex}`));
        setTxns(r.data.txns);
        // [Admin Demo 8/9] Mặc định HÔM NAY (như báo cáo lô) — NHƯNG nếu hôm nay CHƯA có GD nào mà cache có data cũ, tự nhảy
        // "Tất cả" để chi tiết gộp hiện NGAY (tránh bảng trống → tưởng mất cache). Có data hôm nay thì vẫn ưu tiên hôm nay.
        const today = ymdToday();
        if (!r.data.txns.some((t) => dayKey(t.dateTime) === today)) setPeriod('all');
        const bySrc = new Map<string, { n: number; holder: string | null; acct: string | null; bank: string | null }>();
        for (const t of r.data.txns) { const k = t.srcAccount ?? '?'; const e = bySrc.get(k) ?? { n: 0, holder: t.srcHolder ?? null, acct: t.srcAccount, bank: t.srcBank }; e.n++; if (!e.holder && t.srcHolder) e.holder = t.srcHolder; bySrc.set(k, e); }
        const dsFile = [...bySrc.entries()].map(([, v]) => ({ name: 'Cache', total: v.n, added: v.n, dup: 0, holder: v.holder, account: v.acct, bank: v.bank }));
        setFiles(dsFile);
        boNhoSaoKe = { at: Date.now(), txns: r.data.txns, files: dsFile }; // nhớ cho lần mở màn sau
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onFiles(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return;
    setErr(null);
    const xlsx = [...list].filter((f) => /\.xlsx?$/i.test(f.name));
    if (xlsx.length === 0) { setErr('Không có file .xlsx nào trong lựa chọn.'); return; }
    let curTxns = txns; const curFiles = [...files];
    for (const f of xlsx) {
      if (curFiles.some((x) => x.name === f.name)) continue; // đã nạp file trùng TÊN → bỏ (gate file)
      setBusy(f.name);
      const r = await uploadStatement(f);
      if (!r.ok) { curFiles.push({ name: f.name, total: 0, added: 0, dup: 0, holder: null, account: null }); setErr(`${f.name}: ${r.message ?? 'lỗi đọc'}`); continue; }
      const { merged, added, dup } = mergeTxns(curTxns, seenRef.current, r.data.txns);
      curTxns = merged;
      curFiles.push({ name: f.name, total: r.data.txns.length, added, dup, holder: r.data.accountHolder, account: r.data.accountNumber, bank: r.data.accountBank, ...kyNgayCuaFile(r.data.txns) });
      if (r.data.warnings?.length) setCanhBaoFile((L) => [...L, ...r.data.warnings!.map((m) => ({ file: f.name, msg: m }))]);
      setTxns(curTxns); setFiles([...curFiles]);
    }
    setBusy(null);
  }
  /**
   * [Admin Demo 9/9] LẤY SAO KÊ TỰ ĐỘNG: hỏi số TK (gợi ý các TK đã từng nạp) → gọi server kéo giao dịch của KỲ ĐANG
   * CHỌN → gộp vào lưới y như nạp file (cùng bộ chống trùng theo `ref`). Không có kỳ (đang xem "Tất cả") → lấy 7
   * ngày gần nhất cho khỏi kéo nặng.
   */
  async function layTuDong(acctIn: string): Promise<void> {
    const acct = acctIn.trim();
    if (!acct) return;
    try { window.localStorage.setItem(TK_MAC_DINH_KEY, acct); } catch { /* quota */ }
    setHopTuDong(null);
    const hom = new Date();
    const lo = pr ? new Date(`${pr.lo}T00:00:00`) : new Date(hom.getTime() - 6 * 86400000);
    const hi = pr ? new Date(`${pr.hi}T23:59:59`) : hom;
    setErr(null); setBusy(`tự động ${acct}`);
    const r = await fetchAutoStatement(acct, lo, hi);
    setBusy(null);
    if (!r.ok) { setErr(`Lấy sao kê tự động: ${r.message ?? 'lỗi'}`); return; }
    const { merged, added, dup } = mergeTxns(txns, seenRef.current, r.data.txns);
    setTxns(merged);
    setFiles((L) => [...L, {
      name: `⚡ tự động · ${ymdShort(lo)}→${ymdShort(hi)}`, total: r.data.txns.length, added, dup,
      holder: r.data.accountHolder, account: r.data.accountNumber ?? acct, bank: r.data.accountBank,
      ...kyNgayCuaFile(r.data.txns)
    }]);
    if (r.data.warnings?.length) setCanhBaoFile((L) => [...L, ...r.data.warnings!.map((m) => ({ file: 'tự động', msg: m }))]);
  }

  // [Admin Demo 8/9 — ABB REVIEW] Clone OCR tự động: upload ảnh → OCR → gom vào REVIEW (sửa được), "Xác nhận" mới nạp 2 tab.
  async function onImages(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return;
    setErr(null);
    const imgs = [...list].filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(f.name));
    if (imgs.length === 0) { setErr('Không có ảnh nào trong lựa chọn.'); return; }
    // [Admin Demo 8/9] DEDUP re-OCR THA JITTER: khoá tự nhiên (TK+ngày+tiền+tên, bỏ giờ/bank) so với review + txns đã nạp
    // (cả khác phiên vì txns nạp từ cache) → OCR lại lệch phút/mất bank (vụ 36/37) vẫn nhận ra là TRÙNG, không dupe.
    const have = new Set<string>([...review.map(natKeyOf), ...txns.map(natKeyOf)]);
    const collected: StmtReconTxn[] = [];
    let dup = 0;
    for (const f of imgs) {
      setBusy(f.name);
      const r = await uploadStatementImage(f);
      if (!r.ok) { setErr(`${f.name}: ${r.message ?? 'lỗi OCR'}`); continue; }
      for (const t of r.data.txns) {
        const nk = natKeyOf(t);
        if (have.has(nk)) { dup++; continue; } // đã có (tha jitter) → bỏ (không dupe)
        have.add(nk);
        collected.push({ ...t, edited: false });
      }
    }
    setBusy(null);
    if (collected.length) setReview((prev) => [...prev, ...collected]);
    if (dup > 0) setErr(`Đã bỏ ${dup} giao dịch TRÙNG (đã OCR/nạp trước) — chống dupe.`);
    else if (!collected.length && !err) setErr('OCR không đọc được giao dịch nào (hoặc tất cả đã nạp trước).');
  }
  // Xác nhận nạp các GD đã review (đã sửa nếu có) → cache + gộp vào 2 tab.
  async function confirmReview(): Promise<void> {
    if (review.length === 0) return;
    setReviewSaving(true);
    const r = await commitOcrImageTxns(review);
    setReviewSaving(false);
    if (!r.ok) { setErr(r.message ?? 'Không nạp được giao dịch.'); return; }
    const { merged } = mergeTxns(txns, seenRef.current, review);
    setTxns(merged);
    setFiles((prev) => [...prev, { name: `OCR ảnh ABB (${review.length} GD)`, total: review.length, added: review.length, dup: 0, holder: 'ABB (ảnh)', account: review[0]?.srcAccount ?? null, bank: review[0]?.srcBank ?? 'ABB' }]);
    setReview([]);
  }
  function reset(): void { setFiles([]); setTxns([]); seenRef.current = new Set(); setErr(null); setDir('ALL'); setFDealer(''); setFInvestor(''); setFKind(''); setFSrc(''); }

  const opts = useMemo(() => ({
    dealers: [...new Set(txns.filter((t) => isDealerKind(t.kind)).map((t) => t.matchedName).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)),
    investors: [...new Set(txns.filter((t) => isInvestorKind(t.kind)).map((t) => t.matchedName).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)),
    kinds: [...new Set(txns.map((t) => t.kind))].sort((a, b) => KIND_LABEL[a].localeCompare(KIND_LABEL[b])),
    srcs: [...new Set(txns.map((t) => srcLabel(t)))].sort()
  }), [txns]);
  // [Admin Demo 8/9] TRANSFER KHỚP CẶP: chuyển RA TK này + chuyển VÀO TK kia (khác TK nguồn) cùng SỐ TIỀN + cùng NGÀY →
  // net 0 (luân chuyển vốn nội bộ). Đánh dấu ref cả 2 để hiện badge "↔ khớp cặp" — GIỮ lại để đối soát, không xóa.
  const netPairedRefs = useMemo(() => {
    const paired = new Set<string>();
    const byKey = new Map<string, { out: StmtReconTxn[]; in: StmtReconTxn[] }>();
    for (const t of txns) {
      if (t.kind !== 'TRANSFER' || !t.ref) continue;
      const amt = t.debit || t.credit;
      const k = `${dayKey(t.dateTime)}|${amt}`;
      const g = byKey.get(k) ?? { out: [], in: [] }; byKey.set(k, g);
      (t.direction === 'OUT' ? g.out : g.in).push(t);
    }
    for (const g of byKey.values()) {
      const used = new Set<number>();
      for (const o of g.out) {
        const j = g.in.findIndex((i, idx) => !used.has(idx) && i.srcAccount !== o.srcAccount); // ra TK này / vào TK KHÁC
        if (j >= 0) { used.add(j); paired.add(o.ref!); paired.add(g.in[j].ref!); }
      }
    }
    return paired;
  }, [txns]);
  const pr = useMemo(() => periodRange(period, rangeFrom, rangeTo), [period, rangeFrom, rangeTo]);
  const rows = useMemo(() => txns.filter((t) =>
    (!pr || (dayKey(t.dateTime) >= pr.lo && dayKey(t.dateTime) <= pr.hi)) &&
    (dir === 'ALL' || t.direction === dir) &&
    (!fDealer || t.matchedName === fDealer) &&
    (!fInvestor || t.matchedName === fInvestor) &&
    (!fKind || t.kind === fKind) &&
    (!fSrc || srcLabel(t) === fSrc))
    // [Admin Demo 8/9] Sắp: CÓ LỌC (đại lý/NĐT/sao kê-TK/bank/loại/hướng) → ưu tiên THỜI GIAN. "Tất cả" → sao kê bank →
    // tài khoản → thời gian (lần lượt từng TK của 1 bank rồi mới sang bank khác).
    .sort((a, b) => {
      const narrowed = dir !== 'ALL' || !!fDealer || !!fInvestor || !!fKind || !!fSrc;
      const byTime = (a.dateTime ?? '').localeCompare(b.dateTime ?? '');
      if (narrowed) return byTime;
      return (a.srcBank ?? '').localeCompare(b.srcBank ?? '') || (a.srcAccount ?? '').localeCompare(b.srcAccount ?? '') || byTime;
    }),
    [txns, pr, dir, fDealer, fInvestor, fKind, fSrc]);
  const agg = useMemo(() => aggregate(rows), [rows]);
  // Số dòng đang hiện của bảng chi tiết (hiện dần) — đổi bộ lọc/kỳ thì về lại 150 dòng đầu.
  const [soHien, setSoHien] = useState(150);
  useEffect(() => { setSoHien(150); }, [period, rangeFrom, rangeTo, rows.length]);
  const hasFilter = dir !== 'ALL' || !!fDealer || !!fInvestor || !!fKind || !!fSrc;
  // [Admin Demo 8/9] Bill thiếu: lọc theo đại lý + tìm theo số tiền (khớp chuỗi chữ số).
  const mDealerOpts = useMemo(() => [...new Set(missing.rows.map((m) => m.dealerName).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)), [missing.rows]);
  const mRows = useMemo(() => { const q = mAmount.replace(/\D/g, ''); return missing.rows.filter((m) => (!mDealer || m.dealerName === mDealer) && (!q || String(Math.round(m.amount)).includes(q))); }, [missing.rows, mDealer, mAmount]);
  const totalAdded = files.reduce((s, f) => s + f.added, 0), totalDup = files.reduce((s, f) => s + f.dup, 0);
  // Nạp thêm sao kê → tự cuộn khung log xuống cuối để luôn thấy bản MỚI NHẤT (khỏi kéo tay).
  useEffect(() => {
    const id = window.setTimeout(() => { const el = khungFileRef.current; if (el) el.scrollTop = el.scrollHeight; }, 0);
    return () => window.clearTimeout(id);
  }, [files.length, moFile]);
  // [Admin Demo 9/9] LOG THEO TÀI KHOẢN: gom các bản sao kê đã nạp theo STK; trong mỗi TK xếp theo KỲ NGÀY tăng dần.
  const nhomTheoTk = useMemo(() => {
    const map = new Map<string, { key: string; account: string | null; bank: string | null; holder: string | null; ds: LoadedFile[]; added: number; dup: number; soFile: number }>();
    for (const f of files) {
      const key = `${f.account ?? '?'}|${f.bank ?? ''}`;
      const g = map.get(key) ?? { key, account: f.account, bank: f.bank ?? null, holder: f.holder, ds: [], added: 0, dup: 0, soFile: 0 };
      g.ds.push(f); g.added += f.added; g.dup += f.dup; g.soFile += 1;
      if (!g.holder && f.holder) g.holder = f.holder;
      map.set(key, g);
    }
    for (const g of map.values()) g.ds.sort((a, b) => (a.tuNgay ?? '').localeCompare(b.tuNgay ?? ''));
    return [...map.values()];
  }, [files]);

  // [Admin Demo 8/9] XUẤT EXCEL brand (2 sheet: Tổng hoàn đại lý gộp-tài-khoản + Chi tiết GD gộp) — theo GD ĐANG LỌC/CHU KỲ.
  const periodLabel = period === 'today' ? 'Hôm nay' : period === 'yesterday' ? 'Hôm qua' : period === 'week' ? '7 ngày' : period === 'month' ? 'Tháng này' : period === 'range' ? `${rangeFrom.split('-').reverse().join('/')}–${rangeTo.split('-').reverse().join('/')}` : 'Tất cả';
  async function doExport(): Promise<void> {
    // [Admin Demo 8/9] Xuất .xlsx THẬT qua backend (exceljs) — hết cảnh báo "format/extension" của .xls SpreadsheetML.
    setXlsx('idle');
    const r = await exportStatementXlsx(rows, periodLabel);
    if (!r.ok) { setXlsx('err'); setErr(r.message ?? 'Không xuất được Excel.'); setTimeout(() => setXlsx('idle'), 4000); return; }
    const fileName = `TraSoatSaoKe_${periodLabel.replace(/[^\p{L}\d]+/gu, '') || 'TatCa'}_${ymdToday().replace(/-/g, '')}.xlsx`;
    const result = await downloadBlob(r.data, fileName);
    setXlsx('ok'); setTimeout(() => setXlsx('idle'), 2500);
    showDownloadDone(result, fileName);
  }
  // [Admin Demo 8/9] Đối chiếu BILL THIẾU ẢNH OCR cho chu kỳ đang chọn (dung sai hoàn dư 10k/ngày/đại lý).
  async function doCheckMissing(): Promise<void> {
    setMissing((m) => ({ ...m, loading: true }));
    const from = pr ? pr.lo : '2000-01-01', to = pr ? pr.hi : ymdToday();
    const r = await fetchMissingBills(from, to);
    if (!r.ok) { setMissing({ rows: [], loading: false, done: true }); setErr(r.message ?? 'Không đối chiếu được bill thiếu.'); return; }
    setMissing({ rows: r.data.rows, loading: false, done: true });
  }

  // [Admin Demo 7/9] SỬA TAY 1 giao dịch (loại/hoàn cho ai/ngày hiệu lực/ghi chú) — lưu cache theo ref + cập nhật LOCAL để
  // tab tra soát (thẻ tổng/báo cáo) tính lại ngay (aggregate là useMemo trên rows).
  const [edit, setEdit] = useState<{ ref: string; rowKey: number; kind: StmtReconKind; targetName: string; effectiveDate: string; note: string; srcHolder: string; saving: boolean; msg?: string } | null>(null);
  function openEdit(t: MergedTxn): void {
    if (!t.ref) { setErr('Giao dịch không có Mã Tham Chiếu — không lưu sửa được (bản ghi cũ).'); return; }
    const k: StmtReconKind = t.kind === 'UNKNOWN' ? (t.direction === 'IN' ? 'INVESTOR_ADVANCE' : 'DEALER_REFUND') : t.kind;
    const holder = t.srcHolder ?? '';
    // TRANSFER → "cùng tên chủ TK sao kê" (Admin Demo 8/9); nhóm hoàn/ứng giữ tên đã khớp để chọn lại.
    setEdit({ ref: t.ref, rowKey: t.rowIndex, kind: k, targetName: k === 'TRANSFER' ? holder : (t.matchedName ?? ''), effectiveDate: t.effectiveDate ?? (t.dateTime ?? '').slice(0, 10), note: t.note ?? '', srcHolder: holder, saving: false });
  }
  // Khi đổi LOẠI trong modal: TRANSFER → auto tên chủ TK; đổi sang nhóm khác → xóa để chọn lại từ dropdown.
  function onEditKind(k: StmtReconKind): void {
    setEdit((c) => c ? { ...c, kind: k, targetName: k === 'TRANSFER' ? c.srcHolder : (isDealerKind(k) === isDealerKind(c.kind) && isInvestorKind(k) === isInvestorKind(c.kind) ? c.targetName : '') } : c);
  }
  function submitEdit(): void {
    const e = edit; if (!e) return;
    setEdit((c) => (c ? { ...c, saving: true, msg: undefined } : c));
    saveStatementOverride({ ref: e.ref, kind: e.kind, targetName: e.targetName.trim() || null, effectiveDate: e.effectiveDate || null, note: e.note.trim() || null }).then((r) => {
      if (!r.ok) { setEdit((c) => (c ? { ...c, saving: false, msg: r.message ?? 'Không lưu được.' } : c)); return; }
      // Cập nhật LOCAL txn theo override → aggregate + báo cáo tự tính lại. Resolve id theo tên+loại → gộp 1 nhóm.
      const nm = e.targetName.trim();
      const dealerId = (e.kind === 'DEALER_REFUND' || e.kind === 'DEALER_ADVANCE' || e.kind === 'DEALER_RETURN') ? (nameToDealerId.current.get(nm) ?? null) : null;
      const invId = (e.kind === 'INVESTOR_REPAY' || e.kind === 'INVESTOR_ADVANCE') ? (nameToInvId.current.get(nm) ?? null) : null;
      setTxns((prev) => prev.map((t) => t.ref === e.ref ? { ...t, edited: true, kind: e.kind, matchedName: nm || t.matchedName, matchedCustomerId: dealerId, matchedInvestorId: invId, note: e.note.trim() || null, effectiveDate: e.effectiveDate || null, dateTime: e.effectiveDate ? `${e.effectiveDate}T${(t.dateTime ?? '').slice(11, 16) || '12:00'}:00` : t.dateTime } : t));
      setEdit(null);
    });
  }

  // [Admin Demo 9/9] KHOÁ TÍNH NĂNG: Tra soát sao kê (và nút lấy sao kê MB tự động bên trong) CHỈ CHỦ SIGMA xem.
  // Lớp UI này chỉ để không bày ra; SERVER vẫn là chốt chặn thật (mọi route /v1/statement-recon/* đã requireAlphaOwner)
  // — vào thẳng URL cũng không lấy được dữ liệu.
  if (!isAlphaOwnerCode(getCachedAuthenticatedAgent()?.code)) {
    return (
      <div className="flex h-full w-full flex-col gap-3 overflow-y-auto px-[1.5cm] py-4">
        <div className="flex items-center gap-2 text-base font-bold text-slate-700"><FileSpreadsheet className="h-5 w-5 text-brand" /> Tra soát sao kê</div>
        <div className="glass-panel shadow-soft flex flex-col items-center gap-3 rounded-2xl border border-danger/30 p-8 text-center" data-testid="stmt-forbidden">
          <AlertTriangle className="h-8 w-8 text-danger" />
          <div className="text-sm font-semibold text-slate-600">Chỉ chủ SigMa mới xem được Tra soát sao kê.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-y-auto px-[1.5cm] py-4 text-[15px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-base font-bold text-slate-700"><FileSpreadsheet className="h-5 w-5 text-brand" /> Tra soát sao kê</div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple className="hidden" onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
          <input ref={folderRef} type="file" {...{ webkitdirectory: '', directory: '' }} className="hidden" onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
          <input ref={imgRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void onImages(e.target.files); e.target.value = ''; }} />
          <input ref={imgFolderRef} type="file" {...{ webkitdirectory: '', directory: '' }} className="hidden" onChange={(e) => { void onImages(e.target.files); e.target.value = ''; }} />
          {txns.length > 0 && <button type="button" onClick={() => void doExport()} className={'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold ' + (xlsx === 'ok' ? 'border-success/40 bg-success/10 text-success' : xlsx === 'err' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-success/40 bg-success/5 text-success hover:bg-success/10')}><Download className="h-3.5 w-3.5" /> {xlsx === 'ok' ? 'Đã tải' : xlsx === 'err' ? 'Lỗi tải' : 'Xuất Excel'}</button>}
          {txns.length > 0 && <button type="button" onClick={reset} className="rounded-full border border-line bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-500 hover:bg-slate-100">Làm mới</button>}
          {/* [Admin Demo 8/9 — BILL AN BÌNH] OCR ảnh chụp GD → chọn cả FOLDER (tự nhận mọi ảnh) hoặc ảnh lẻ. Cạnh Làm mới. */}
          <button type="button" disabled={!!busy} onClick={() => imgFolderRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/50 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50"><FolderOpen className="h-3.5 w-3.5" /> OCR folder ảnh (ABB)</button>
          <button type="button" disabled={!!busy} onClick={() => imgRef.current?.click()} className="inline-flex items-center gap-1 rounded-full border border-amber-300/50 bg-amber-50/50 px-2.5 py-1.5 text-[11px] font-bold text-amber-600 hover:bg-amber-100 disabled:opacity-50" title="Chọn ảnh lẻ (nhiều)"><FileSpreadsheet className="h-3 w-3" /> ảnh lẻ</button>
          {/* [Admin Demo 9/9] LẤY SAO KÊ TỰ ĐỘNG (MB qua GPM Pay) — khỏi tải file rồi nạp tay; kỳ ngày lấy theo bộ lọc đang chọn. */}
          <button type="button" disabled={!!busy} onClick={() => setHopTuDong(tkMacDinh())} className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/60 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50" title="Kéo sao kê MB trực tiếp về cho kỳ đang chọn">
            <Zap className="h-3.5 w-3.5" /> Lấy sao kê tự động
          </button>
          <button type="button" disabled={!!busy} onClick={() => folderRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand/5 px-3 py-1.5 text-xs font-bold text-brand hover:bg-brand/10 disabled:opacity-50"><FolderOpen className="h-3.5 w-3.5" /> Chọn folder</button>
          <button type="button" disabled={!!busy} onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-xs font-bold text-white hover:bg-brand-deep disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} {busy ? 'Đang đọc…' : 'Chọn file (nhiều)'}
          </button>
        </div>
      </div>

      {/* HỘP THOẠI "Lấy sao kê tự động" — thay hộp nhập của trình duyệt, thứ Electron KHÔNG hỗ trợ. Có sẵn số TK dùng lần trước +
          các TK đã từng nạp để bấm 1 phát, và nói rõ đang lấy KỲ NÀO để khỏi kéo nhầm. */}
      {hopTuDong !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setHopTuDong(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="hop-lay-tu-dong">
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-700"><Zap className="h-4 w-4 text-emerald-600" /> Lấy sao kê tự động (MB)</div>
            <p className="mb-2 text-[11px] text-slate-500">Kỳ đang chọn: <b className="text-slate-700">{pr ? `${pr.lo} → ${pr.hi}` : '7 ngày gần nhất'}</b></p>
            <label className="mb-1 block text-[11px] font-semibold text-slate-500">Số tài khoản</label>
            <input autoFocus value={hopTuDong} onChange={(e) => setHopTuDong(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void layTuDong(hopTuDong); }}
              className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-brand" placeholder="DEMO-ACCT" />
            {[...new Set([TK_MB_DEMO, ...txns.map((t) => t.srcAccount).filter((x): x is string => !!x)])].slice(0, 4).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {[...new Set([TK_MB_DEMO, ...txns.map((t) => t.srcAccount).filter((x): x is string => !!x)])].slice(0, 4).map((a) => (
                  <button key={a} type="button" onClick={() => setHopTuDong(a)} className="rounded-full border border-line bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-brand hover:text-brand">{a}</button>
                ))}
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setHopTuDong(null)} className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50">Hủy</button>
              <button type="button" onClick={() => void layTuDong(hopTuDong)} disabled={!hopTuDong.trim() || !!busy}
                className="rounded-full bg-emerald-600 px-5 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">Lấy về</button>
            </div>
          </div>
        </div>
      )}
      {busy && <div className="flex items-center gap-1.5 text-[11px] text-slate-400"><Loader2 className="h-3 w-3 animate-spin" /> Đang đọc {busy}…</div>}
      {err && <div className="flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs font-medium text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {err}</div>}
      {canhBaoFile.length > 0 && (
        <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800" data-testid="stmt-warnings">
          {canhBaoFile.map((w, i) => (<div key={i} className="flex items-start gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0" /><span><b>{w.file}</b>: {w.msg}</span></div>))}
        </div>
      )}

      {/* [Admin Demo 9/9 "log tải file sao kê bị dồn nhiều, cho gọn kiểu log cuộn khi có file mới"]
          LƯỚI FILE ĐÃ NẠP = KHUNG CUỘN gọn (mỗi file 1 DÒNG), tự cuộn xuống file mới nhất; nạp nhiều file không
          còn đẩy dài trang. Bấm tiêu đề để thu/mở. Giữ nguyên thông tin: STK · ngân hàng · chủ TK · tên file · thêm/trùng. */}
      {files.length > 0 && (
        <div className="rounded-2xl border border-line bg-white p-2.5" data-testid="stmt-files">
          <button type="button" onClick={() => setMoFile((v) => !v)}
            className="mb-1.5 flex w-full items-center justify-between text-[11px] font-bold uppercase tracking-wide text-slate-400 hover:text-brand">
            <span>File đã nạp ({files.length}) · gộp {totalAdded} GD{totalDup > 0 ? ` · bỏ trùng ${totalDup}` : ''}</span>
            <span className="text-[10px] normal-case">{moFile ? '▾ thu gọn' : '▸ mở'}</span>
          </button>
          {moFile && (
            <div ref={khungFileRef} className="flex max-h-[188px] flex-col gap-1.5 overflow-y-auto pr-1">
              {/* GOM THEO TÀI KHOẢN (STK): 1 khối = 1 TK; trong khối liệt kê từng BẢN SAO KÊ theo KỲ NGÀY tăng dần. */}
              {nhomTheoTk.map((g) => (
                <div key={g.key} className="rounded-lg border border-line/60 border-l-4 bg-white" style={{ borderLeftColor: bankColor(g.bank) }}>
                  <div className="flex items-center gap-2 px-2 py-1 text-[12px]">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-white" style={{ backgroundColor: bankColor(g.bank) }}>
                      <Landmark className="h-3 w-3" />
                    </span>
                    <span className="shrink-0 font-bold tabular-nums text-slate-800">{g.account ?? '—'}</span>
                    <span className="shrink-0 font-bold" style={{ color: bankColor(g.bank) }}>{g.bank ?? '—'}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">{g.holder ?? '—'}</span>
                    <span className="shrink-0 text-[11px] text-slate-500">{g.soFile} sao kê · {g.added} GD{g.dup > 0 ? <span className="text-amber-600"> · {g.dup} trùng</span> : null}</span>
                  </div>
                  <div className="border-t border-line/50 px-2 py-0.5">
                    {g.ds.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 py-0.5 text-[11px] leading-tight" title={f.name}>
                        <span className="w-[86px] shrink-0 font-bold tabular-nums text-brand-deep">{ngayGon(f.tuNgay)}{f.denNgay && f.denNgay !== f.tuNgay ? ` → ${ngayGon(f.denNgay)}` : ''}</span>
                        <span className="min-w-0 flex-1 truncate text-slate-400">{f.name}</span>
                        <span className="shrink-0 text-slate-500">{f.total > 0 ? <>{f.added} thêm{f.dup > 0 ? <span className="text-amber-600"> · {f.dup} trùng</span> : null}</> : <span className="font-bold text-danger">lỗi đọc</span>}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {txns.length === 0 && !busy && (
        <div className="rounded-2xl border border-dashed border-line bg-white/50 p-8 text-center text-sm text-slate-400">
          Chọn NHIỀU file hoặc cả FOLDER sao kê (xlsx). Hệ thống chạy lần lượt, GỘP + tự bỏ giao dịch trùng (theo Mã Tham Chiếu), khớp đại lý (từ bill hoàn OCR) + NĐT, rồi lên báo cáo.
        </div>
      )}

      {txns.length > 0 && (
        <>
          {/* CHU KỲ NGÀY (mặc định HÔM NAY) — như báo cáo lô/hoàn tiền. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {([['today', 'Hôm nay'], ['yesterday', 'Hôm qua'], ['week', '7 ngày'], ['month', 'Tháng này'], ['range', 'Chọn kỳ'], ['all', 'Tất cả']] as const).map(([p, lb]) => (
              <button key={p} type="button" onClick={() => setPeriod(p)} className={'rounded-full px-4 py-2 text-[13px] font-bold transition-all active:translate-y-0 ' + (period === p ? 'btn-primary text-white shadow-lg -translate-y-0.5' : 'border border-line bg-white text-slate-600 shadow-md hover:-translate-y-0.5 hover:bg-slate-50')}>{lb}</button>
            ))}
            {period === 'range' && (
              <span className="inline-flex items-center gap-1 text-[12px] text-slate-500">
                <input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} className="rounded-lg border border-line bg-white px-2 py-1 text-[12px] outline-none focus:border-brand/50" /> →
                <input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} className="rounded-lg border border-line bg-white px-2 py-1 text-[12px] outline-none focus:border-brand/50" />
              </span>
            )}
          </div>

          {/* THẺ TỔNG (theo bộ lọc + chu kỳ). [Admin Demo 8/9] THÊM "Thực hoàn ĐL" = Hoàn(+ứng) − Đại lý hoàn lại (nổi bật). */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
            <SumCard label="Hoàn đại lý (+ứng)" value={agg.totals.hoanDaiLy} cls="text-slate-600" />
            <SumCard label="Đại lý hoàn lại" value={agg.totals.hoanLaiDaiLy} cls="text-teal-600" />
            <div className="rounded-xl border-2 border-success/40 bg-success/5 px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-success">Thực hoàn đại lý</div>
              <div className="text-lg font-bold tabular-nums text-success">{fmtVnd(agg.totals.hoanDaiLy - agg.totals.hoanLaiDaiLy)}</div>
            </div>
            <SumCard label="Hoàn ứng NĐT" value={agg.totals.hoanUngNDT} cls="text-amber-600" />
            <SumCard label="Tạm ứng NĐT (vào)" value={agg.totals.tamUngNDT} cls="text-brand" />
            <SumCard label="Chưa khớp" value={agg.totals.unmatchedOut + agg.totals.unmatchedIn} cls="text-slate-500" />
          </div>

          {/* [Admin Demo 8/9] THANH TAB: Chi tiết GD gộp | Báo cáo tra soát */}
          <div className="flex items-center gap-1 border-b border-line">
            {([['detail', 'Chi tiết GD gộp'], ['report', 'Báo cáo tra soát']] as const).map(([tk, lb]) => (
              <button key={tk} type="button" onClick={() => setTab(tk)} className={'-mb-px border-b-2 px-4 py-2 text-[13px] font-bold ' + (tab === tk ? 'border-brand text-brand' : 'border-transparent text-slate-400 hover:text-slate-600')}>{lb}</button>
            ))}
          </div>

          {tab === 'detail' && <>
          {/* BỘ LỌC — Admin Demo 7/9: dropdown NĐT + Đại lý RIÊNG + lọc theo TÀI KHOẢN SAO KÊ nguồn. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(['ALL', 'OUT', 'IN'] as const).map((d) => (
              /* [Admin Demo 8/9] 3 nút hướng tiền TO + NỔI 3D, có màu nghĩa: ghi nợ (tiền ra) đỏ · báo có (tiền vào) xanh. */
              <button key={d} type="button" onClick={() => setDir(d)}
                className={'rounded-full px-4 py-2 text-[13px] font-bold transition-all active:translate-y-0 ' + (dir === d
                  ? (d === 'OUT' ? 'bg-gradient-to-b from-rose-400 to-rose-600 text-white shadow-lg shadow-rose-500/30 -translate-y-0.5'
                    : d === 'IN' ? 'bg-gradient-to-b from-emerald-400 to-emerald-600 text-white shadow-lg shadow-emerald-500/30 -translate-y-0.5'
                    : 'btn-primary text-white shadow-lg -translate-y-0.5')
                  : 'border border-line bg-white text-slate-600 shadow-md hover:-translate-y-0.5 hover:bg-slate-50')}>
                {d === 'ALL' ? 'Tất cả' : d === 'OUT' ? 'Ghi nợ (ra)' : 'Báo có (vào)'}
              </button>
            ))}
            {opts.srcs.length > 1 && <FilterSel value={fSrc} onChange={setFSrc} label="Sao kê (TK)" opts={opts.srcs} />}
            <FilterSel value={fDealer} onChange={setFDealer} label="Đại lý" opts={opts.dealers} />
            <FilterSel value={fInvestor} onChange={setFInvestor} label="NĐT" opts={opts.investors} />
            {/* [Admin Demo 8/9 chiều] BỎ 2 bộ lọc "Tên TK đối ứng" + "Số TK" — ít dùng, làm rối hàng nút. Cột dữ liệu
                vẫn hiện đủ; muốn tìm theo số TK thì dùng ô tìm số tiền / lọc Đại lý-NĐT. */}
            {/* [Admin Demo 8/9] LỌC PHÂN LOẠI (thay Ngân hàng) — hiện nhãn tiếng Việt (Chưa khớp/Hoàn đại lý/…) */}
            <select value={fKind} onChange={(e) => setFKind(e.target.value)}
              className={'max-w-[210px] rounded-full px-4 py-2 text-[13px] font-bold shadow-md outline-none transition-all hover:-translate-y-0.5 ' + (fKind
                ? 'border-2 border-brand bg-brand-tint text-brand-deep'
                : 'border border-line bg-white text-slate-600 focus:border-brand/50')}>
              <option value="">Phân loại: tất cả</option>
              {opts.kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            {hasFilter && <button type="button" onClick={() => { setDir('ALL'); setFDealer(''); setFInvestor(''); setFKind(''); setFSrc(''); }} className="rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-100"><X className="mr-0.5 inline h-3 w-3" />Bỏ lọc</button>}
          </div>

          {/* BẢNG GIAO DỊCH — CHI TIẾT GỘP TẤT CẢ SAO KÊ. Box cuộn riêng + tiêu đề STICKY (không trôi khi lăn chuột). */}
          <div className="flex items-center gap-1.5 pt-1 text-sm font-bold text-slate-700">
            <FileSpreadsheet className="h-4 w-4 text-brand" /> Chi tiết giao dịch gộp (tất cả sao kê) · <span className="tabular-nums text-brand">{rows.length}</span> GD
          </div>
          {/* [Admin Demo 8/9] BỎ khung cuộn riêng (max-h-65vh + overflow-auto): chuột nằm trong bảng thì chỉ cuộn
              BẢNG, không kéo được cả trang xuống. Nay bảng dài tự nhiên → CẢ MÀN cuộn. Cuộn ngang + tiêu đề dính
              (sticky) do vùng cuộn CHA của màn lo, nên vẫn giữ nguyên 2 tính năng đó. */}
          <div className="rounded-lg-mac border border-line bg-white">
            <div className="min-w-[1320px]">
              <div className="sticky top-0 z-20 grid items-center gap-x-2 border-b border-line bg-[#e6f0fb] px-2.5 py-2.5 text-[13px] font-bold uppercase tracking-wide text-brand-deep shadow-sm" style={{ gridTemplateColumns: STMT_GRID }}>
                {['STT', 'Ngày', 'Giờ', 'Loại', 'Số tiền', 'Người gửi', 'Người nhận', 'Đại lý/NĐT', 'Số TK', 'Ngân hàng', 'Sửa'].map((h, i) => <div key={h} className={i === 4 ? 'text-right' : (i <= 3 || i === 5 || i === 6 || i === 7 || i === 10) ? 'text-center' : ''}>{h}</div>)}
              </div>
              {rows.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-400">Không có giao dịch khớp bộ lọc.</div>}
              {/* [Admin Demo 11/9] HIỆN DẦN: 1089 GD dựng 1 lúc = trình duyệt khựng vài giây mỗi lần vào màn/đổi lọc.
                  Hiện 150 dòng đầu (mắt chỉ đọc được chừng đó), bấm nút để xem thêm. Tổng số vẫn ghi ở tiêu đề. */}
              {rows.slice(0, soHien).map((t, i) => <StmtRow key={`${t.ref ?? ''}-${t.rowIndex}-${i}`} t={t} i={i} paired={t.ref ? netPairedRefs.has(t.ref) : false} onEdit={() => openEdit(t)} />)}
              {rows.length > soHien && (
                <button type="button" onClick={() => setSoHien((n) => n + 300)}
                  className="w-full border-t border-line bg-brand/5 px-3 py-2.5 text-[13px] font-bold text-brand hover:bg-brand/10">
                  ▼ Xem thêm 300 giao dịch (đang hiện {soHien}/{rows.length})
                </button>
              )}
            </div>
          </div>

          </>}

          {tab === 'report' && <>
          {/* [Admin Demo 8/9 chiều] BỎ bảng "Tổng theo ngày" — trùng với dãy THẺ TỔNG ở trên (Hoàn ĐL · Đại lý hoàn
              lại · Thực hoàn · Hoàn ứng NĐT · Tạm ứng NĐT), đã theo đúng chu kỳ đang chọn. `agg.byDay` vẫn tính
              (Excel + biểu đồ dùng), chỉ bỏ phần HIỂN THỊ trùng. */}
          {/* [Admin Demo 12/9] SỐ DƯ CUỐI NGÀY + ĐỐI CHIẾU: tổng số dư TK SigMa PHẢI = Σ phải hoàn NĐT + lãi công ty. */}
          <BalanceCheckSection />

          {/* [Admin Demo 8/9] TỔNG HOÀN TỪNG ĐẠI LÝ — FULL rộng, chữ TO, hover nổi brand. */}
          <div className="rounded-2xl border border-line bg-white p-4">
            <div className="mb-2 flex items-center gap-1.5 text-base font-bold text-slate-700"><Building2 className="h-5 w-5 text-brand" /> Tổng hoàn từng đại lý</div>
            <div className="mb-1 grid items-center gap-3 px-3 text-[11px] uppercase tracking-wide text-slate-400" style={{ gridTemplateColumns: 'minmax(0,1fr) 160px 150px 170px' }}>
              <span>Đại lý</span><span className="text-right">Hoàn (+ứng)</span><span className="text-right">Đại lý hoàn lại</span><span className="text-right">Thực hoàn</span>
            </div>
            <div className="flex flex-col gap-1">
              {agg.byDealer.length === 0 && <p className="py-3 text-center text-sm text-slate-400">Chưa khớp đại lý nào.</p>}
              {agg.byDealer.map((d, i) => (
                <div key={i} className="grid items-center gap-3 rounded-lg border border-line/70 px-3 py-2 text-[16px] transition-colors hover:bg-brand/15 hover:font-semibold hover:shadow-sm" style={{ gridTemplateColumns: 'minmax(0,1fr) 160px 150px 170px' }}>
                  <div className="min-w-0 truncate"><b className="text-slate-800">{d.name}</b> <span className="text-[11px] font-normal text-slate-400">({d.count}){d.advance ? ' · ứng ' + fmtVnd(d.advance) : ''}</span></div>
                  <span className="text-right tabular-nums text-slate-600">{fmtVnd(d.refund + d.advance)}</span>
                  <span className="text-right tabular-nums text-teal-600">{d.returned ? '−' + fmtVnd(d.returned) : '—'}</span>
                  <span className="text-right text-[17px] font-bold tabular-nums text-success">{fmtVnd(d.total)}</span>
                </div>
              ))}
              {agg.byDealer.length > 0 && (
                <div className="grid items-center gap-3 rounded-lg border-2 border-success/40 bg-success/5 px-3 py-2 text-[16px] font-bold" style={{ gridTemplateColumns: 'minmax(0,1fr) 160px 150px 170px' }}>
                  <div className="text-slate-800">TỔNG ({agg.byDealer.length} đại lý)</div>
                  <span className="text-right tabular-nums text-slate-700">{fmtVnd(agg.byDealer.reduce((s, d) => s + d.refund + d.advance, 0))}</span>
                  <span className="text-right tabular-nums text-teal-700">−{fmtVnd(agg.byDealer.reduce((s, d) => s + d.returned, 0))}</span>
                  <span className="text-right text-[18px] tabular-nums text-success">{fmtVnd(agg.byDealer.reduce((s, d) => s + d.total, 0))}</span>
                </div>
              )}
            </div>
          </div>

          {/* [Admin Demo 8/9] TẠM ỨNG TỪNG NĐT — FULL rộng, chữ TO. */}
          {agg.byInvestor.length > 0 && (
          <div className="rounded-2xl border border-line bg-white p-4">
            <div className="mb-2 flex items-center gap-1.5 text-base font-bold text-slate-700"><PiggyBank className="h-5 w-5 text-brand" /> Tạm ứng từng NĐT</div>
            <div className="mb-1 grid items-center gap-3 px-3 text-[11px] uppercase tracking-wide text-slate-400" style={{ gridTemplateColumns: 'minmax(0,1fr) 160px 150px 170px' }}>
              <span>NĐT</span><span className="text-right">Tạm ứng</span><span className="text-right">Hoàn ứng</span><span className="text-right">Thực ứng</span>
            </div>
            <div className="flex flex-col gap-1">
              {agg.byInvestor.map((v, i) => (
                <div key={i} className="grid items-center gap-3 rounded-lg border border-line/70 px-3 py-2 text-[16px] transition-colors hover:bg-brand/15 hover:font-semibold hover:shadow-sm" style={{ gridTemplateColumns: 'minmax(0,1fr) 160px 150px 170px' }}>
                  <div className="min-w-0 truncate"><b className="text-slate-800">{v.name}</b> <span className="text-[11px] font-normal text-slate-400">({v.count})</span></div>
                  <span className="text-right tabular-nums text-brand">{fmtVnd(v.advance)}</span>
                  <span className="text-right tabular-nums text-amber-600">{v.repay ? '−' + fmtVnd(v.repay) : '—'}</span>
                  <span className="text-right text-[17px] font-bold tabular-nums text-success">{fmtVnd(v.net)}</span>
                </div>
              ))}
              <div className="grid items-center gap-3 rounded-lg border-2 border-success/40 bg-success/5 px-3 py-2 text-[16px] font-bold" style={{ gridTemplateColumns: 'minmax(0,1fr) 160px 150px 170px' }}>
                <div className="text-slate-800">TỔNG ({agg.byInvestor.length} NĐT)</div>
                <span className="text-right tabular-nums text-brand">{fmtVnd(agg.byInvestor.reduce((s, v) => s + v.advance, 0))}</span>
                <span className="text-right tabular-nums text-amber-700">−{fmtVnd(agg.byInvestor.reduce((s, v) => s + v.repay, 0))}</span>
                <span className="text-right text-[18px] tabular-nums text-success">{fmtVnd(agg.byInvestor.reduce((s, v) => s + v.net, 0))}</span>
              </div>
            </div>
          </div>
          )}

          {/* [Admin Demo 8/9] ĐỐI SOÁT SỐ DƯ CUỐI NGÀY mỗi tài khoản sao kê (đầu kỳ = 0). Cuối = Σ báo có − Σ ghi nợ. Khớp bank = không sót GD. */}
          {agg.byAccount.length > 0 && (
            <div className="rounded-2xl border border-line bg-white p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-slate-700"><Building2 className="h-4 w-4 text-brand" /> Đối soát số dư cuối kỳ theo tài khoản <span className="text-[10px] font-normal text-slate-400">(đầu kỳ = 0 · so với số dư bank để phát hiện sót GD)</span></div>
              <div className="mb-1 grid items-center gap-1 px-1.5 text-[9px] uppercase text-slate-400" style={{ gridTemplateColumns: 'minmax(0,1.4fr) 70px 130px 130px 130px' }}>
                <span>Tài khoản sao kê</span><span className="text-right">GD</span><span className="text-right">Tiền vào (+)</span><span className="text-right">Tiền ra (−)</span><span className="text-right">Số dư cuối</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {agg.byAccount.map((a, i) => (
                  <div key={i} className="grid items-center gap-1 rounded-md border border-line/70 px-1.5 py-1 text-[12px] transition-colors hover:bg-brand/10 hover:font-semibold" style={{ gridTemplateColumns: 'minmax(0,1.4fr) 70px 130px 130px 130px' }}>
                    <div className="min-w-0 truncate"><b className="text-slate-700">{a.account}</b> <span className="text-[10px] text-slate-400">{a.bank ?? ''}</span></div>
                    <span className="text-right tabular-nums text-slate-400">{a.count}</span>
                    <span className="text-right tabular-nums text-success">{fmtVnd(a.credit)}</span>
                    <span className="text-right tabular-nums text-danger">{fmtVnd(a.debit)}</span>
                    <span className={'text-right font-bold tabular-nums ' + (a.closing >= 0 ? 'text-brand-deep' : 'text-danger')}>{fmtVnd(a.closing)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* [Admin Demo 8/9] BÁO CÁO BILL THIẾU ẢNH OCR — GD hoàn sao kê không có bill OCR khớp (dung sai hoàn dư 10k/ngày/đại lý). */}
          <div className="rounded-2xl border border-danger/30 bg-danger/[0.03] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm font-bold text-slate-700"><AlertTriangle className="h-4 w-4 text-danger" /> Bill thiếu ảnh OCR <span className="text-[10px] font-normal text-slate-400">(GD hoàn trên sao kê chưa có bill OCR khớp · dung sai hoàn dư 10k/ngày)</span></div>
              <button type="button" onClick={() => void doCheckMissing()} disabled={missing.loading} className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/5 px-3 py-1.5 text-xs font-bold text-danger hover:bg-danger/10 disabled:opacity-50">{missing.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />} Đối chiếu bill thiếu (kỳ này)</button>
            </div>
            {missing.done && missing.rows.length === 0 && <p className="py-2 text-center text-[13px] font-semibold text-success">✓ Không thiếu bill nào (mọi khoản hoàn sao kê đều có bill OCR trong dung sai).</p>}
            {missing.rows.length > 0 && (<>
              {/* [Admin Demo 8/9] Lọc đại lý + tìm số tiền */}
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <select value={mDealer} onChange={(e) => setMDealer(e.target.value)} className="max-w-[220px] rounded-full border border-line bg-white px-3 py-1 text-[12px] text-slate-700 outline-none focus:border-brand/50">
                  <option value="">Tất cả đại lý ({mDealerOpts.length})</option>
                  {mDealerOpts.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <input type="text" inputMode="numeric" value={mAmount} onChange={(e) => setMAmount(e.target.value)} placeholder="Tìm số tiền…" className="w-[150px] rounded-full border border-line bg-white px-3 py-1 text-[12px] text-slate-700 outline-none focus:border-brand/50" />
                {(mDealer || mAmount) && <button type="button" onClick={() => { setMDealer(''); setMAmount(''); }} className="rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-100"><X className="mr-0.5 inline h-3 w-3" />Bỏ lọc</button>}
              </div>
              <div className="overflow-x-auto rounded-lg border border-line bg-white">
                <div className="min-w-[760px]">
                  <div className="grid items-center gap-2 border-b border-line bg-danger/10 px-2.5 py-2 text-[11px] font-bold uppercase text-danger" style={{ gridTemplateColumns: '40px 92px 50px minmax(140px,1.2fr) minmax(150px,1.3fr) 140px 120px' }}>
                    <span className="text-center">STT</span><span className="text-center">Ngày</span><span className="text-center">Giờ</span><span>Đại lý</span><span>Người nhận</span><span className="text-right">Số tiền</span><span>Ngân hàng</span>
                  </div>
                  {mRows.length === 0 && <div className="px-3 py-4 text-center text-xs text-slate-400">Không có bill thiếu khớp lọc.</div>}
                  {mRows.map((m, i) => (
                    <div key={i} className="grid items-center gap-2 border-b border-line/70 px-2.5 py-2 text-[14px] last:border-b-0 hover:bg-danger/5" style={{ gridTemplateColumns: '40px 92px 50px minmax(140px,1.2fr) minmax(150px,1.3fr) 140px 120px' }}>
                      <span className="text-center tabular-nums text-slate-400">{i + 1}</span>
                      <span className="text-center tabular-nums text-slate-600">{dmy(m.dateTime)}</span>
                      <span className="text-center tabular-nums text-slate-500">{hm(m.dateTime)}</span>
                      <span className="truncate font-semibold text-slate-800" title={m.dealerName ?? ''}>{m.dealerName ?? '—'}</span>
                      <span className="truncate text-slate-600" title={m.receiverName ?? ''}>{m.receiverName ?? '—'}</span>
                      <span className="text-right font-bold tabular-nums text-danger">{fmtVnd(m.amount)}</span>
                      <span className="truncate text-slate-500" title={m.bank ?? ''}>{(m.bank ?? '').slice(0, 16)}</span>
                    </div>
                  ))}
                  <div className="grid items-center gap-2 border-t-2 border-danger/30 bg-danger/10 px-2.5 py-2 text-[14px] font-bold" style={{ gridTemplateColumns: '40px 92px 50px minmax(140px,1.2fr) minmax(150px,1.3fr) 140px 120px' }}>
                    <span className="col-span-5 text-slate-800">TỔNG THIẾU ({mRows.length}{mRows.length !== missing.rows.length ? `/${missing.rows.length}` : ''} bill)</span>
                    <span className="text-right tabular-nums text-danger">{fmtVnd(mRows.reduce((s, m) => s + m.amount, 0))}</span><span />
                  </div>
                </div>
              </div>
            </>)}
          </div>
          </>}
        </>
      )}

      {/* [Admin Demo 7/9] MODAL SỬA giao dịch sao kê — loại / hoàn cho ai / ngày hiệu lực / ghi chú. Nhớ cache theo ref. */}
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !edit.saving && setEdit(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-appbg p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-700"><Pencil className="h-4 w-4 text-brand" /> Sửa giao dịch sao kê</div>
            <p className="mb-2 text-[11px] text-slate-400">Ghi chú như review — sửa loại + hoàn cho ai + ngày hiệu lực. Nhớ cache: lần sau nạp lại sao kê vẫn giữ bản sửa này.</p>
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-0.5"><span className="text-[11px] font-semibold text-slate-500">Loại giao dịch</span>
                <select value={edit.kind} onChange={(e) => onEditKind(e.target.value as StmtReconKind)} className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-brand/50">
                  {KIND_OPTIONS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
              </label>
              {/* [Admin Demo 8/9] Hoàn cho ai: đại lý→dropdown đại lý · NĐT→dropdown NĐT · chuyển giữa TK→tên chủ TK sao kê · còn lại→tự điền. */}
              <label className="flex flex-col gap-0.5"><span className="text-[11px] font-semibold text-slate-500">Hoàn cho ai / đối tượng</span>
                {isDealerKind(edit.kind) ? (
                  <select value={edit.targetName} onChange={(e) => setEdit((c) => (c ? { ...c, targetName: e.target.value } : c))} className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-brand/50">
                    <option value="">— Chọn đại lý —</option>
                    {[...new Set([edit.targetName, ...pickOpts.dealers].filter(Boolean))].map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                ) : isInvestorKind(edit.kind) ? (
                  <select value={edit.targetName} onChange={(e) => setEdit((c) => (c ? { ...c, targetName: e.target.value } : c))} className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-brand/50">
                    <option value="">— Chọn NĐT —</option>
                    {[...new Set([edit.targetName, ...pickOpts.investors].filter(Boolean))].map((iv) => <option key={iv} value={iv}>{iv}</option>)}
                  </select>
                ) : edit.kind === 'TRANSFER' ? (
                  <input type="text" readOnly value={edit.targetName || edit.srcHolder} title="Chuyển giữa TK — cùng tên chủ TK sao kê" className="rounded-lg border border-line bg-slate-50 px-2 py-1 text-sm text-slate-500 outline-none" />
                ) : (
                  <input type="text" placeholder="TK lãi / dồn vốn / khác…" value={edit.targetName} onChange={(e) => setEdit((c) => (c ? { ...c, targetName: e.target.value } : c))} className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-brand/50" />
                )}
              </label>
              <label className="flex flex-col gap-0.5"><span className="text-[11px] font-semibold text-slate-500">Ngày hiệu lực</span>
                <input type="date" value={edit.effectiveDate} onChange={(e) => setEdit((c) => (c ? { ...c, effectiveDate: e.target.value } : c))} className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-brand/50" />
              </label>
              <label className="flex flex-col gap-0.5"><span className="text-[11px] font-semibold text-slate-500">Ghi chú</span>
                <input type="text" placeholder="Lý do sửa (vd bank sai giờ)…" value={edit.note} onChange={(e) => setEdit((c) => (c ? { ...c, note: e.target.value } : c))} className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-brand/50" />
              </label>
              {edit.msg && <p className="rounded-lg bg-danger/10 px-2 py-1 text-xs font-medium text-danger">{edit.msg}</p>}
              <div className="mt-1 flex justify-end gap-2">
                <button type="button" onClick={() => setEdit(null)} disabled={edit.saving} className="rounded-full border border-line px-4 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-50">Hủy</button>
                <button type="button" onClick={submitEdit} disabled={edit.saving} className="rounded-full bg-brand px-5 py-1.5 text-xs font-bold text-white hover:bg-brand-deep disabled:opacity-50">{edit.saving ? 'Đang lưu…' : 'Xác nhận cập nhật'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* [Admin Demo 8/9 — ABB REVIEW] Card review từng GD OCR ảnh (sửa loại/đối tượng/tiền) → "Xác nhận nạp" mới vào 2 tab. */}
      {review.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 p-3 sm:p-6">
          <div className="flex h-full w-full max-w-[95vw] flex-col rounded-2xl bg-appbg p-4 shadow-xl">
            <div className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-700"><FileSpreadsheet className="h-4 w-4 text-amber-600" /> Review OCR ảnh giao dịch (ABB) · {review.length} GD{busy ? ` · đang đọc ${busy}…` : ''}</div>
            <p className="mb-2 text-[11px] text-slate-400">Kiểm/sửa từng giao dịch (loại · hoàn cho ai · số tiền) nếu OCR sai. Bấm <b>Xác nhận nạp</b> mới đưa vào 2 tab tra soát. Bỏ dòng sai bằng nút ✕.</p>
            <div className="flex-1 overflow-auto rounded-lg border border-line bg-white">
              <div className="min-w-[900px]">
                <div className="sticky top-0 z-10 grid items-center gap-x-2 border-b border-line bg-[#e6f0fb] px-2.5 py-2 text-[12px] font-bold uppercase tracking-wide text-brand-deep" style={{ gridTemplateColumns: '34px 92px 50px minmax(160px,1.4fr) 150px 150px minmax(150px,1.2fr) 34px' }}>
                  {['STT', 'Ngày', 'Giờ', 'Tên đối ứng', 'Số tiền', 'Loại', 'Hoàn cho ai', ''].map((h, k) => <div key={k} className={k === 4 ? 'text-right' : k <= 2 ? 'text-center' : ''}>{h}</div>)}
                </div>
                {review.map((t, i) => {
                  const up = (patch: Partial<StmtReconTxn>) => setReview((prev) => prev.map((x, j) => j === i ? { ...x, ...patch, edited: true } : x));
                  const signed = (t.direction === 'OUT' ? -1 : 1) * (t.debit || t.credit);
                  return (
                    <div key={i} className={'grid items-center gap-x-2 border-b border-line/60 px-2.5 py-1.5 text-[14px] ' + (i % 2 ? 'bg-slate-50/60' : 'bg-white')} style={{ gridTemplateColumns: '34px 92px 50px minmax(160px,1.4fr) 150px 150px minmax(150px,1.2fr) 34px' }}>
                      <span className="text-center text-[11px] tabular-nums text-slate-400">{i + 1}</span>
                      <span className="tabular-nums text-slate-600">{dmy(t.dateTime)}</span>
                      <span className="tabular-nums text-slate-500">{hm(t.dateTime)}</span>
                      <input type="text" value={t.cpName ?? ''} onChange={(e) => up({ cpName: e.target.value })} className="w-full rounded border border-line bg-white px-1.5 py-1 text-[14px]" title="Tên đối ứng" />
                      <input inputMode="numeric" value={`${signed < 0 ? '−' : signed > 0 ? '+' : ''}${fmtVnd(Math.abs(signed))}`} onChange={(e) => { const neg = /^[-−]/.test(e.target.value.trim()); const v = (neg ? -1 : 1) * (parseInt(e.target.value.replace(/[^\d]/g, ''), 10) || 0); up({ debit: v < 0 ? -v : 0, credit: v > 0 ? v : 0, direction: v < 0 ? 'OUT' : 'IN' }); }} className={'w-full rounded border border-line px-1.5 py-1 text-right text-[14px] font-bold tabular-nums ' + (t.direction === 'OUT' ? 'text-danger' : 'text-success')} title="Số tiền (đầu dấu − = tiền ra)" />
                      <select value={t.kind} onChange={(e) => up({ kind: e.target.value as StmtReconKind })} className="w-full rounded border border-line bg-white px-1 py-1 text-[12px]">
                        {KIND_OPTIONS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                      </select>
                      <input type="text" value={t.matchedName ?? ''} onChange={(e) => up({ matchedName: e.target.value })} placeholder="đối tượng" className="w-full rounded border border-line bg-white px-1.5 py-1 text-[14px]" title="Hoàn cho ai / đối tượng" />
                      <button type="button" onClick={() => setReview((prev) => prev.filter((_, j) => j !== i))} className="flex justify-center text-slate-300 hover:text-danger" title="Bỏ dòng này"><X className="h-4 w-4" /></button>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11px] text-slate-400">{review.filter((t) => t.edited).length} GD đã sửa · thêm ảnh nữa bằng nút “OCR ảnh GD (ABB)”</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setReview([])} disabled={reviewSaving} className="rounded-full border border-line px-4 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-50">Hủy</button>
                <button type="button" onClick={() => void confirmReview()} disabled={reviewSaving || !!busy} className="rounded-full bg-brand px-5 py-1.5 text-xs font-bold text-white hover:bg-brand-deep disabled:opacity-50">{reviewSaving ? 'Đang nạp…' : `Xác nhận nạp ${review.length} GD`}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {downloadDialog}
    </div>
  );
}

function FilterSel({ value, onChange, label, opts }: { value: string; onChange: (v: string) => void; label: string; opts: string[] }): JSX.Element {
  return (
    /* [Admin Demo 8/9 "quá nhỏ, chìm"] TO hơn + NỔI (shadow) + đang lọc thì tô brand để nhìn phát biết đang lọc gì. */
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className={'max-w-[210px] rounded-full px-4 py-2 text-[13px] font-bold shadow-md outline-none transition-all hover:-translate-y-0.5 ' + (value
        ? 'border-2 border-brand bg-brand-tint text-brand-deep'
        : 'border border-line bg-white text-slate-600 focus:border-brand/50')}>
      <option value="">{label}: tất cả</option>
      {opts.map((o) => <option key={o} value={o}>{o.length > 26 ? o.slice(0, 26) + '…' : o}</option>)}
    </select>
  );
}
function SumCard({ label, value, cls }: { label: string; value: number; cls: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-white px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={'text-lg font-bold tabular-nums ' + cls}>{fmtVnd(value)}</div>
    </div>
  );
}
function StmtRow({ t, i, paired, onEdit }: { t: StmtReconTxn; i: number; paired?: boolean; onEdit: () => void }): JSX.Element {
  const amt = t.debit || t.credit;
  return (
    <div className={'grid items-center gap-x-2 border-b border-line/70 px-2.5 py-2.5 text-[15px] transition-colors last:border-b-0 hover:bg-brand/15 hover:font-semibold ' + (paired ? 'bg-indigo-50/40 opacity-70' : t.edited ? 'bg-brand/[0.06]' : i % 2 ? 'bg-slate-50/60' : 'bg-white')} style={{ gridTemplateColumns: STMT_GRID }}>
      <div className="text-center tabular-nums text-slate-400">{i + 1}</div>
      <div className="text-center tabular-nums text-slate-600">{dmy(t.dateTime)}</div>
      <div className="text-center tabular-nums text-slate-500">{hm(t.dateTime)}</div>
      <div className="flex flex-col items-center justify-center gap-0.5"><span className={'rounded px-1.5 py-0.5 text-[9px] font-bold ' + KIND_CLS[t.kind]}>{KIND_LABEL[t.kind]}</span>{paired && <span className="rounded bg-indigo-100 px-1 text-[8px] font-bold text-indigo-600" title="Chuyển vốn nội bộ đã khớp cặp ra/vào — net 0">↔ khớp cặp</span>}</div>
      <div className={'text-right font-bold tabular-nums ' + (t.direction === 'OUT' ? 'text-danger' : 'text-success')}>{t.direction === 'OUT' ? '−' : '+'}{fmtVnd(amt)}</div>
      {/* [Admin Demo 8/9] PHÂN TÁCH người gửi / người nhận theo chiều tiền. Căn giữa. */}
      <div className="truncate text-center text-slate-600" title={senderOf(t)}>{senderOf(t)}</div>
      {/* [Admin Demo 8/9 chiều] DỮ LIỆU cột "Người nhận" + "Đại lý/NĐT" CĂN TRÁI (tên dài, căn giữa đọc rối);
          TIÊU ĐỀ 2 cột này vẫn CĂN GIỮA. */}
      <div className="truncate text-left text-slate-600" title={receiverOf(t)}>{receiverOf(t)}</div>
      <div className="min-w-0 text-left">
        <div className="truncate font-semibold text-slate-800" title={t.matchedName ?? ''}>{t.matchedInvestorId != null && <span className="mr-1 rounded bg-brand/10 px-1 text-[9px] font-bold text-brand">NĐT</span>}{t.matchedName ?? '—'}</div>
        {t.note && <div className="truncate text-[9px] text-brand" title={t.note}>✎ {t.note}</div>}
      </div>
      <div className="truncate tabular-nums text-slate-500" title={t.cpAccount ?? ''}>{t.cpAccount ?? '—'}</div>
      <div className="truncate text-slate-500" title={t.cpBank ?? ''}>{t.cpBank ?? '—'}</div>
      <div className="flex justify-center">
        <button type="button" onClick={onEdit} title="Sửa loại/hoàn cho ai/ngày/ghi chú (nhớ cache)" className={'rounded-full border px-1.5 py-0.5 ' + (t.edited ? 'border-brand/40 bg-brand/10 text-brand' : 'border-line bg-white text-slate-400 hover:text-brand')}><Pencil className="h-2.5 w-2.5" /></button>
      </div>
    </div>
  );
}


// ─── [Admin Demo 12/9] KHỐI SỐ DƯ CUỐI NGÀY + ĐỐI CHIẾU TÌM TIỀN ────────────────────────────────────────────────
// "tổng số dư cuối ngày, số dư từng tài khoản của alpha, số tổng phải khớp = phải hoàn NĐT (lãi + tiền sau phí
// cài máy) của tất cả NĐT + lãi công ty; thừa/thiếu phải có ô báo số chi tiết để tìm tiền."
function BalanceCheckSection(): JSX.Element {
  const [day, setDay] = useState(ymdToday());
  const [data, setData] = useState<BalanceCheckData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [moNdt, setMoNdt] = useState(false);
  const load = (d: string): void => {
    setLoading(true); setErr(null);
    void fetchBalanceCheck(d).then((r) => {
      setLoading(false);
      if (r.ok) setData(r.data); else setErr(r.message ?? r.error);
    });
  };
  useEffect(() => { load(day); }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  const lech = data?.lech ?? 0;
  const khop = data != null && Math.abs(lech) < 1000; // dung sai làm tròn <1k
  return (
    <div className="rounded-2xl border border-line bg-white p-4" data-testid="balance-check">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-base font-bold text-slate-700"><Banknote className="h-5 w-5 text-brand" /> Số dư cuối ngày · đối chiếu tìm tiền</div>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="rounded-lg border border-line px-2 py-1 text-sm" />
        <button type="button" onClick={() => load(day)} className="rounded-lg border border-line px-2.5 py-1 text-sm font-semibold text-brand hover:bg-brand/10">Tải lại</button>
        {loading && <span className="text-xs text-slate-400">đang tính…</span>}
      </div>
      {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</p>}
      {data && (
        <>
          {!data.coSoDu && (
            <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
              Chưa có SỐ DƯ nào — NẠP LẠI file sao kê (bản có cột "Số dư" hoặc có dòng "Số dư cuối kỳ" đều được, hệ thống tự đọc từ 13/9).
            </p>
          )}
          {data.accounts.length > 0 && (
            <div className="mb-3 flex flex-col gap-1">
              {data.accounts.map((a) => (
                <div key={a.account} className="grid items-center gap-2 rounded-lg border border-line/70 px-3 py-1.5 text-[14px]" style={{ gridTemplateColumns: 'minmax(0,1fr) 170px' }}>
                  <div className="min-w-0 truncate">
                    <b className="tabular-nums text-slate-800">{a.account}</b>
                    <span className="ml-1 text-[12px] text-slate-400">{a.bank ?? '—'}{a.holder ? ' · ' + a.holder : ''}</span>
                    {a.stale && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700" title={`GD cuối có số dư: ${a.asOf ?? '?'}`}>số dư cũ {a.asOf?.slice(0, 10) ?? ''}</span>}
                  </div>
                  <div className="text-right font-bold tabular-nums text-slate-800">{fmtVnd(a.balance)}</div>
                </div>
              ))}
              <div className="grid items-center gap-2 rounded-lg bg-brand/10 px-3 py-2 text-[15px] font-extrabold" style={{ gridTemplateColumns: 'minmax(0,1fr) 170px' }}>
                <div>TỔNG SỐ DƯ CUỐI NGÀY</div>
                <div className="text-right tabular-nums text-brand-deep" data-testid="tong-so-du">{fmtVnd(data.tongSoDu)}</div>
              </div>
            </div>
          )}
          <div className="mb-2 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-line bg-appbg/40 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-400">Phải hoàn NĐT (ứng − tiền về + lãi)</div>
              <div className="text-lg font-extrabold tabular-nums text-slate-800">{fmtVnd(data.tongPhaiHoanNdt)}</div>
              <button type="button" onClick={() => setMoNdt((v) => !v)} className="text-[12px] font-semibold text-brand">{moNdt ? 'thu gọn' : `chi tiết ${data.investors.length} NĐT ▾`}</button>
            </div>
            <div className="rounded-xl border border-line bg-appbg/40 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-400">Lãi công ty (chênh phí)</div>
              <div className="text-lg font-extrabold tabular-nums text-emerald-700">{fmtVnd(data.laiCongTy)}</div>
            </div>
            <div className="rounded-xl border border-line bg-appbg/40 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-400">PHẢI CÓ (Σ hoàn NĐT + lãi)</div>
              <div className="text-lg font-extrabold tabular-nums text-brand-deep" data-testid="phai-co">{fmtVnd(data.phaiCo)}</div>
            </div>
          </div>
          {moNdt && (
            <div className="mb-2 flex flex-col gap-1">
              <div className="grid gap-2 px-3 text-[10px] uppercase tracking-wide text-slate-400" style={{ gridTemplateColumns: 'minmax(0,1fr) 130px 130px 100px 140px' }}>
                <span>NĐT</span><span className="text-right">Đã ứng</span><span className="text-right">Tiền về (−)</span><span className="text-right">Lãi (+)</span><span className="text-right">Phải hoàn</span>
              </div>
              {data.investors.map((v) => (
                <div key={v.investorId} className="grid items-center gap-2 rounded-lg border border-line/60 px-3 py-1.5 text-[13px]" style={{ gridTemplateColumns: 'minmax(0,1fr) 130px 130px 100px 140px' }}>
                  <div className="min-w-0 truncate font-semibold text-slate-700">{v.name}</div>
                  <div className="text-right tabular-nums text-slate-600">{fmtVnd(v.tamUng)}</div>
                  <div className="text-right tabular-nums text-slate-500">−{fmtVnd(v.tienVe)}</div>
                  <div className="text-right tabular-nums text-slate-500">+{fmtVnd(v.laiNdt)}</div>
                  <div className={`text-right font-bold tabular-nums ${v.phaiHoan < 0 ? 'text-danger' : 'text-slate-800'}`}>{v.phaiHoan < 0 ? '−' : ''}{fmtVnd(Math.abs(v.phaiHoan))}</div>
                </div>
              ))}
            </div>
          )}
          {/* [Admin Demo 13/9 "tách riêng QR"] NĐT QR trả về SigMa theo phí mua (không tạm ứng) — khối riêng, không cộng vào PHẢI CÓ. */}
          {(data.investorsQr?.length ?? 0) > 0 && (
            <div className="mb-2 rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-violet-700">NĐT mã QR trả về SigMa (theo phí mua — không tạm ứng)</div>
              {(data.investorsQr ?? []).map((v) => (
                <div key={v.investorId} className="grid items-center gap-2 px-1 py-1 text-[13px]" style={{ gridTemplateColumns: 'minmax(0,1fr) 130px 130px 140px' }}>
                  <div className="min-w-0 truncate font-semibold text-slate-700">{v.name} <span className="text-[10px] font-normal text-slate-400">({v.soBill} GD)</span></div>
                  <div className="text-right tabular-nums text-slate-500">quẹt {fmtVnd(v.gross)}</div>
                  <div className="text-right tabular-nums text-slate-500">giữ {fmtVnd(v.phiMuaGiu)}</div>
                  <div className="text-right font-bold tabular-nums text-violet-700">trả {fmtVnd(v.traAlpha)}</div>
                </div>
              ))}
            </div>
          )}
          {data.coSoDu && (
            <div className={`rounded-xl px-4 py-3 text-center ${khop ? 'bg-emerald-50' : lech > 0 ? 'bg-amber-50' : 'bg-rose-50'}`} data-testid="o-lech">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{khop ? 'KHỚP' : lech > 0 ? 'THỪA tiền so với phải có' : 'THIẾU tiền so với phải có'}</div>
              <div className={`text-2xl font-extrabold tabular-nums ${khop ? 'text-emerald-700' : lech > 0 ? 'text-amber-700' : 'text-rose-700'}`}>
                {khop ? '✓ ' : lech > 0 ? '+' : '−'}{fmtVnd(Math.abs(lech))}
              </div>
              <div className="mt-0.5 text-[12px] text-slate-500">Tổng số dư {fmtVnd(data.tongSoDu)} − phải có {fmtVnd(data.phaiCo)} · lệch dò theo từng TK + từng NĐT ở trên để tìm tiền</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
