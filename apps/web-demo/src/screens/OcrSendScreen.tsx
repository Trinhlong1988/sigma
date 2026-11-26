// SIGMA "Quét bill gửi" (Admin Demo 30/8) — menu OCR bill → gửi nhóm đại lý + cc NĐT. 2 chế độ THỦ CÔNG (chọn/chụp
// ảnh) + TỰ ĐỘNG (quét folder). MỖI bill REVIEW trước khi gửi. AUTO = THỦ CÔNG dùng CHUNG BillReviewCard + pipeline.
// PHÍ theo THẺ (Admin Demo test 53550081): chọn thẻ (mặc định on-us) → gọi /fee → phí bán(đại lý)+phí cài(NĐT) đúng,
// KHÔNG đoán. Tách thẻ: thẻ chính = tổng − Σ thẻ khác (mặc định 0), phí = Σ phí từng thẻ. Tiền grouped (114.394.000).
// Ngày/giờ TÁCH 2 ô. Sửa ô nào → phí cập nhật ngay. Hiện Bank + tên HKD.
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, RotateCw, ScanLine, Upload, FolderOpen, Send, CreditCard, AlertTriangle, CheckCircle2, X, Plus, SkipForward, Loader2, Save, Pencil, RefreshCw, ShieldCheck, Search, QrCode } from 'lucide-react';
import { Button } from '../components/Button';
import { FieldIcon } from '../lib/brand-icons';
import { posBillFileName, ckBillFileName, qrBillFileName, failBillFileName, danhSoCkTheoGio, tenNgan, type CkBillDaDoc } from '../lib/bill-file-name';
import { docSoBill, docTidLo, laCanhBao } from '../lib/log-shortcut';
import { fetchFolderReport, type BillTrongFolder, type BaoCaoFolder } from '../lib/ocr-send-api';
import { RevenueLotTable } from '../components/RevenueLotTable';
import { AGENT_COLUMNS, type RevenueLotRow } from '../lib/revenue-lot-xls';
import {
  ocrUpload, ocrFile, scanFolder, sendBill, tienGhiNhanBill, updateSentBill, sendTransfer, ocrImageUrl, feePreview, rerouteBill,
  fetchClassifyOptions, classifyAlias, saveSenderBankAlias, saveTransferCorrection, sendQr, qrReviewForDealer, renameProcessed,
  type ReviewItem, type OcrBill, type FeeLine, type ScanFile, type FeeSplitPart, type TransferReview, type ClassifyOptions, type OcrResult, type CardTypeOpt, type RerouteResult, type QrReviewItem
} from '../lib/ocr-send-api';
import { ImageZoom } from '../components/ImageZoomCompare';
import { KINDS_CK } from '../lib/ck-classify-kinds';
import { OcrPrefetchPool } from '../lib/ocr-prefetch-pool';
import { detectLotGaps, parseLotNumber, detectLotDateBackward, parseBillDateMs } from '../lib/lot-gap';
import { stampEdits, nowHHMM } from '../lib/edit-stamp';
import { fetchAttachmentObjectUrl } from '../lib/attachment-blob';
import { useGroupedMoneyField, parseGroupedMoneyValue } from '../lib/grouped-money-input';
import { composeBillImage } from '../lib/bill-table-image';
import type { BillFieldDisplayRow } from '../lib/ocr-bill-fields-display';
import { checkBaoCo, suggestHkd, type CheckBaoCoResult, type HkdSuggestion } from '../lib/digistore-client';
import { Sos95Stamp } from '../components/Sos95Stamp';

// % gọn từ milli (1050→"1.050%"); blended nếu chỉ có amount (tách thẻ).
function pctText(fee: FeeLine | undefined, base: number): string {
  if (!fee?.resolved) return '—';
  const milli = fee.milli ?? (fee.amount != null && base > 0 ? (fee.amount / base) * 100000 : null);
  return milli != null ? `${(milli / 1000).toFixed(3)}%` : '—';
}
async function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onloadend = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(b); });
}

const LS_FOLDER = 'ocrSend.lastFolder';
// [Admin Demo 6/9] RESUME OCR dở: lưu con trỏ bill (idx) theo folder vào localStorage (SỐNG qua văng/đóng app — khác
// sessionStorage mất khi crash). Mở lại folder → nhảy đúng bill đang dở, KHỎI bấm "bỏ qua" từ đầu.
const LS_RESUME = 'ocrSend.resume';
/** Định danh folder ổn định để khớp lần sau: EXE = đường dẫn; WEB = tên thư mục gốc (webkitRelativePath) + số ảnh. */
function folderKeyOf(srcKey: string, count: number): string { return `${srcKey}|${count}`; }
/** Đọc idx đã lưu cho folder này (nếu khớp key + hợp lệ trong [1,total-1]); không có/không khớp → 0. */
function readResumeIdx(key: string, total: number): number {
  try {
    const s = JSON.parse(localStorage.getItem(LS_RESUME) || 'null') as { key?: string; idx?: number } | null;
    if (s && s.key === key && typeof s.idx === 'number' && s.idx > 0 && s.idx < total) return s.idx;
  } catch { /* ignore */ }
  return 0;
}
// PREFETCH OCR SONG SONG (Admin Demo 1/9): OCR trước vài bill kế NGẦM trong lúc user review/gửi bill hiện tại → tới
// bill kế đã sẵn (0 chờ). GỬI VẪN TUẦN TỰ 1 bill/lần (chỉ khâu OCR chạy trước). OCR_CONCURRENCY = số request OCR
// chạy đồng thời (GATE cứng); OCR_PREFETCH_WINDOW = chỉ prefetch tối đa ngần này bill quanh idx (chống OCR cả folder
// → đốt quota). Logic pool tách ra lib/ocr-prefetch-pool.ts để test được ĐÚNG code chạy thật (không re-implement).
// Admin Demo 1/9 "tăng tốc OCR ~30% ở CA TỰ ĐỘNG mà KHÔNG chồng chéo/sót": server OCR (8796) KHÔNG gate song song —
// mỗi request spawn `claude -p` độc lập, Node xử lý đồng thời, máy Xeon 2×/64GB thừa CPU. Nút thắt = subscription
// chịu bao nhiêu `claude -p` song song (ở 4 chạy ổn). Bump 4→6 (+50% lý thuyết, ~30% thực). AN TOÀN CẤU TRÚC:
// pool chống CHỒNG CHÉO (keyOf dedup in-flight + cache per-idx: 1 ảnh chỉ OCR đúng 1 lần) + chống SÓT (pump giữ
// window đầy quanh idx, display TUẦN TỰ đi qua TỪNG idx — không nhảy cóc). WINDOW phải ≥ CONCURRENCY mới lấp đủ 6
// luồng (window<conc → thừa luồng ngồi không); ca tự động chạy hết folder nên prefetch xa 7 bill KHÔNG phí quota.
// [Admin Demo 3/9] HẠ 6→4: concurrency 6 làm claude -p QUÁ TẢI → rate-limit/timeout → ~28% bill "Lỗi OCR" (lô 54).
// [Admin Demo 5/9] HẠ 4→3: sau vụ treo hàng loạt lúc cày 87 bill (46× claude -p TIMEOUT 150s, tự hồi sau ~3h) —
// đã tái hiện LOẠI TRỪ concurrency-OCR (3&6 đồng thời đều OK ~10s) + máy quá tải (12 hog vẫn OK); nguyên nhân còn
// lại phía API Anthropic (rate-window/service nghẽn tạm). 3 luồng = giảm tốc độ đốt quota + tải chung → ít chạm hơn,
// đi kèm cooldown ở pool + timeout ngắn để KHÔNG kẹt 150s×3 khi API treo.
const OCR_CONCURRENCY = 3;
// [Admin Demo 3/9] Bill OCR hụt (lỗi/không-ra-bill) → TỰ đọc lại tới tổng 3 lần trước khi kết luận; hết 3 lần → MỞ card
// kiểm tay (KHÔNG nhảy cóc). = số LẦN đọc tối đa cho 1 ảnh trong ca tự động.
const MAX_OCR_ATTEMPTS = 3;
// Admin Demo 2/9 "load folder → OCR ĐA LUỒNG chạy NGẦM tới HẾT folder, cache toàn bộ, đừng khựng từng đợt": bỏ trần
// window nhỏ (7) → prefetch CẢ folder ngay từ đầu. Pool vẫn giữ GATE concurrency=6 (+ adaptive giảm khi rate-limit)
// nên chỉ 6 request bay cùng lúc, KHÔNG bung vô hạn; nhưng nó cày HẾT folder nền → review/gửi bill nào cũng sẵn (0 chờ),
// không phải chờ prefetch đuổi kịp. Đánh đổi: đốt quota OCR cho CẢ folder ngay (chấp nhận — cache append-only, re-OCR
// miễn phí; user chủ động chọn cả folder để gửi). WINDOW lớn = min(total, idx+WINDOW) = total → cày [idx..hết].
const OCR_PREFETCH_WINDOW = 1_000_000;
// Admin Demo 3/9 — GIÃN CÁCH khởi động luồng OCR: cả folder cày ngầm tới hết (gate 6 luồng), nhưng mỗi luồng THẬT
// (cache-miss, gọi API) khởi động cách luồng trước ≥4s → KHÔNG bắn 6 request cùng mili-giây (giảm nhiễu/chồng chéo
// phía service), vẫn chạy chồng lấn nên tốc độ tổng gần như giữ nguyên. Job dedup (ảnh đã có) không tính stagger.
const OCR_LAUNCH_STAGGER_MS = 4_000;
const INPUT = 'w-full rounded-xl border border-line bg-white px-3 py-2 text-slate-800 shadow-soft focus:outline-none focus:ring-2 focus:ring-brand/40';
const LABEL = 'text-[11px] font-medium uppercase tracking-wide text-slate-400';
// Lưới bảng phí 5 cột (Admin Demo 30/8): Thẻ | Tiền trước phí | Tiền HOÀN sau phí bán (phải trả khách) | Bán% | Cài%.
// 2 cột tiền rộng (số dài không tràn), 2 cột % gọn.
const FEE_GRID = 'grid min-w-[364px] grid-cols-[minmax(44px,0.5fr)_minmax(96px,1fr)_minmax(96px,1fr)_minmax(64px,0.62fr)_minmax(64px,0.62fr)]';
// INPUTC = ô nhập GỌN (thấp hơn INPUT) — để TOÀN BỘ review vừa 1 màn, KHÔNG cuộn (Admin Demo 30/8).
const INPUTC = 'w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-slate-800 shadow-soft focus:outline-none focus:ring-2 focus:ring-brand/40';
const LABELC = 'text-[10px] font-medium uppercase tracking-wide text-slate-400';
// Tone màu theo THƯƠNG HIỆU ngân hàng (Admin Demo) — key chuẩn hoá (bỏ dấu/khoảng trắng, viết hoa).
const BANK_COLORS: Record<string, string> = {
  MB: '#1650a3',      // MB — xanh
  MBV: '#d32f2f',     // MBV — đỏ
  ANBINH: '#0a3d91',  // An Bình (ABBank) — xanh coban đậm
  ABBANK: '#0a3d91',
  VP: '#12923f',      // VPBank — xanh lá
  VPBANK: '#12923f',
  VPB: '#12923f'
};

function fmtVnd(n: number): string { return Math.round(n || 0).toLocaleString('en-US').replace(/,/g, '.'); }
function feeText(fee: FeeLine | null, loading: boolean): JSX.Element {
  if (loading) return <span className="text-slate-400">đang tính…</span>;
  if (!fee) return <span className="text-slate-400">—</span>;
  if (!fee.resolved) return <span className="text-amber-600">⚠ {fee.note}</span>;
  if (fee.breakdown?.length) return <b className="text-slate-800">{fmtVnd(fee.amount!)}đ</b>; // chi tiết ở bảng tách thẻ dưới
  return <span className="text-slate-700">{(fee.milli! / 1000).toFixed(3)}% = <b>{fmtVnd(fee.amount!)}đ</b></span>;
}

// [Admin Demo 24/9 — BUG "sửa trong review xong bên ngoài không đồng bộ"] GỐC: bảng Báo cáo folder dựng từ
// `folderBillsRef` = bản OCR LÚC QUÉT; sửa TID/lô/tiền trong thẻ review rồi gửi thì ref vẫn giữ SỐ CŨ ⇒ server dò
// lô theo khoá tid|lô CŨ ⇒ không thấy lô vừa ghi ⇒ bảng hiện "Chưa gửi"/số cũ. NAY: gửi xong trả kèm GIÁ TRỊ
// THẬT ĐÃ GỬI (billSent) để cập nhật ref → bảng luôn khớp bản sửa.
export interface SentInfo {
  dealer: string | null; investor: string | null; warned?: string[];
  /** Giá trị BILL THẬT lúc bấm Gửi (sau mọi lần sửa tay) — dùng đồng bộ bảng báo cáo folder. */
  billSent?: { tid: string | null; lo: string | null; dateTime: string | null; amount: number };
}

export interface FeeRow { cardName: string; amount: number; sell: number | null; sellMilli: number | null; install: number | null; installMilli: number | null; }
/** Gộp breakdown phí bán + phí cài theo THẺ → mỗi thẻ 1 dòng. */
function mergeBreakdown(fees: { sell: FeeLine; install: FeeLine } | null): FeeRow[] {
  const sellBd = fees?.sell.breakdown ?? [];
  const instBd = fees?.install.breakdown ?? [];
  const base = instBd.length ? instBd : sellBd;
  return base.map((b) => {
    const s = sellBd.find((x) => x.cardTypeId === b.cardTypeId);
    const it = instBd.find((x) => x.cardTypeId === b.cardTypeId);
    return { cardName: b.cardName ?? 'thẻ', amount: b.amount, sell: s?.fee ?? null, sellMilli: s?.milli ?? null, install: it?.fee ?? null, installMilli: it?.milli ?? null };
  });
}
/** 1 ô phí trong bảng — CHỈ %, KHÔNG thành tiền (Admin Demo 30/8). */
function feeCell(_amount: number | null, milli: number | null): JSX.Element {
  if (milli == null) return <span className="text-amber-600">⚠</span>;
  return <span className="font-semibold">{(milli / 1000).toFixed(3)}%</span>;
}

/** Ngày hôm nay dd/mm/yyyy — mặc định khi OCR không đọc được ngày (Admin Demo 1/9). */
function todayDmy(): string { const d = new Date(); const p = (n: number): string => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`; }
/** Log nhỏ "✓ đã sửa lúc HH:mm" hiện ngay dưới 1 trường (null nếu chưa sửa). */
function EditedNote({ at }: { at?: string }): JSX.Element | null {
  return at ? <div className="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-success"><span>✓ đã sửa lúc {at}</span></div> : null;
}
/** dd/mm/yyyy → yyyy-mm-dd cho <input type="date">. Không hợp lệ → ''. */
function dmyToIso(s: string): string { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; }
/** yyyy-mm-dd → dd/mm/yyyy. */
function isoToDmy(s: string): string { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s || '').trim()); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }

/** Góc xoay ảnh dùng GẦN NHẤT trong phiên (Admin Demo 10/9) — bill kế tiếp mở ra đã đúng chiều, khỏi xoay lại từng cái. */
const XOAY_KEY = 'ocrSend.xoayGanNhat';
function gocXoayGanNhat(): number {
  try { const v = Number(sessionStorage.getItem(XOAY_KEY) ?? '0'); return [0, 90, 180, 270].includes(v) ? v : 0; } catch { return 0; }
}
function nhoGocXoay(d: number): void {
  try { sessionStorage.setItem(XOAY_KEY, String(d)); } catch { /* quota */ }
}


// [Admin Demo 5/9 "fix triệt để cấm tái diễn văng dash"] ErrorBoundary CỤC BỘ quanh 1 card review. Lỗi RENDER bill (data
// OCR lạ) trước đây văng lên ChunkErrorBoundary toàn app → 'fatal'/reload → MẤT folder+tiến độ (File objects không
// restore). Bản cục bộ BẮT tại chỗ, KHÔNG reload → state cha (webFiles/idx/auto) NGUYÊN VẸN; nút Bỏ qua/Quét lại (nằm
// NGOÀI boundary) vẫn bấm được để qua bill khác. key=idx → đổi bill tự remount = tự clear lỗi. R198: log, không nuốt.
class CardErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error): { err: Error } { return { err }; }
  componentDidCatch(err: unknown): void { console.error('[OcrSend] lỗi hiển thị 1 bill (KHÔNG reload, giữ folder/tiến độ):', err); }
  render(): ReactNode {
    if (this.state.err) return (
      <div className="rounded-xl border-2 border-danger bg-danger/10 p-4 text-sm text-danger">
        <div className="flex items-center gap-1.5 font-bold"><AlertTriangle className="h-4 w-4 shrink-0" /> Lỗi hiển thị bill này — KHÔNG mất folder/tiến độ.</div>
        <div className="mt-1 text-xs">Bấm <b>"Bỏ qua bill này"</b> hoặc <b>"Quét lại ảnh này"</b> ở trên để qua bill khác, hoặc <b>Thử lại</b>.</div>
        <button type="button" onClick={() => this.setState({ err: null })} className="mt-2 rounded-lg bg-danger px-3 py-1 text-xs font-bold text-white transition hover:opacity-90">Thử lại</button>
        <div className="mt-1 text-[10px] opacity-70">{String(this.state.err.message)}</div>
      </div>
    );
    return this.props.children;
  }
}

// [Admin Demo 7/9] EXPORT để RoomRevenueScreen tái dùng ĐÚNG card review này cho luồng SỬA (1 render gốc). KHÔNG di
// chuyển code (helper module-level resolve trong file này) — chống vỡ luồng OCR. Luồng sửa: prepare-edit trả {token,item}
// → render card này → "Gửi" → bug #1 tự cập nhật tin cũ (không tạo mới).
export function BillReviewCard({ token, item, onSent, onPickAnother, pickBusy, onRescan, onRescanOpus, rescanBusy, billIndex = 0, stacked = false, snapBase, flagWarn, folderName }: { token: string; item: ReviewItem; onSent: (info: SentInfo) => void; onPickAnother?: () => void; pickBusy?: boolean; onRescan?: () => void; onRescanOpus?: () => void; rescanBusy?: boolean; billIndex?: number; stacked?: boolean; snapBase?: string; flagWarn?: { reason: string; suggestDate?: string }; folderName?: string }): JSX.Element {
  // LƯU STATE qua sessionStorage theo ẢNH (snapBase = định danh ảnh ổn định) + CHỈ SỐ bill (Admin Demo 30/8 "qua tab/menu
  // là mất"). PHẢI có billIndex: 1 ảnh nhiều bill → nhiều card; thiếu index → chung khoá → LẪN tiền/TID (bug HIGH 30/8).
  // Admin Demo 2/9 "OCR LẠI làm mất phần đã sửa (ngày/TID/HKD) → lọt quy trình": TRƯỚC dùng `token` — re-OCR đổi token →
  // snap edit rơi → về mặc định. Nay khóa theo ẢNH (snapBase, ổn định qua re-OCR) → edit người dùng GIỮ NGUYÊN.
  const SNAP_KEY = `ocrSend.card.${snapBase ?? token}.${billIndex}`;
  const snap = useMemo<Record<string, unknown> | null>(() => { try { return JSON.parse(sessionStorage.getItem(SNAP_KEY) ?? 'null'); } catch { return null; } }, [SNAP_KEY]);
  const [tid, setTid] = useState((snap?.tid as string) ?? item.bill.tid ?? '');
  const [lo, setLo] = useState((snap?.lo as string) ?? item.bill.batchNumber ?? '');
  const dtM = /^(\d{2}\/\d{2}\/\d{4})(?:\s+([\d:]+))?/.exec((item.bill.dateTime ?? '').trim());
  // Admin Demo 1/9: OCR KHÔNG đọc được ngày → MẶC ĐỊNH ngày hôm nay (để không gửi rỗng/sai), người review CHỌN lại đúng
  // trước khi gửi (nút date-picker). `ocrHadDate` để hiện cờ "ngày đang là mặc định hôm nay — kiểm tra".
  const ocrHadDate = !!dtM?.[1];
  const [date, setDate] = useState((snap?.date as string) ?? dtM?.[1] ?? todayDmy());
  const [time, setTime] = useState((snap?.time as string) ?? dtM?.[2] ?? '');
  // [Admin Demo 6/9 — CHẶN gửi khi OCR MÙ NGÀY] OCR không đọc được ngày → date đang là MẶC ĐỊNH hôm nay (dễ lọt SAI ngày
  // ghi doanh số, vd lô 46 mắt thấy 05/9 mà OCR bỏ sót → default 06/9). Bắt user XÁC NHẬN ngày (sửa ô ngày hoặc tick)
  // trước khi gửi. Nếu OCR đã đọc được ngày (ocrHadDate) → coi như đã xác nhận (vẫn sửa được). Khôi phục từ snapshot.
  const [dateConfirmed, setDateConfirmed] = useState<boolean>((snap?.dateConfirmed as boolean) ?? ocrHadDate);
  const amt = useGroupedMoneyField((snap?.amt as string) ?? (item.bill.totalAmount ? String(item.bill.totalAmount) : ''));
  const amount = parseGroupedMoneyValue(amt.value) ?? 0;
  // [Admin Demo 17/9] TIỀN HỦY SỬA ĐƯỢC TẠI CHỖ: OCR đọc hụt dòng "HỦY" (ảnh mờ/lệch cột) thì phải nhập tay, không
  // thì doanh số ghi THỪA đúng phần đã hủy. Khởi tạo từ số OCR đọc; người dùng sửa → tiền ghi nhận đổi LIVE.
  const huy = useGroupedMoneyField((snap?.huy as string) ?? (item.bill.voidAmount ? String(item.bill.voidAmount) : ''));
  const tienHuy = Math.max(0, parseGroupedMoneyValue(huy.value) ?? 0);
  const [soGdHuy, setSoGdHuy] = useState<number>((snap?.soGdHuy as number) ?? item.bill.voidCount ?? 0);
  // TIỀN GHI NHẬN = tổng quẹt (ô số tiền) − tiền HỦY. Hủy > tổng (nhập nhầm) → giữ nguyên tổng, có cảnh báo riêng.
  const tienGhi = tienGhiNhanBill({ totalAmount: amount, voidAmount: tienHuy });
  // [Admin Demo 2/9 "log nhỏ trạng thái đã sửa ngay dưới thông số sửa"] Theo dõi GIỜ SỬA từng trường vs GIÁ TRỊ OCR-GỐC.
  const origVals = useRef<Record<string, string>>({ tid: item.bill.tid ?? '', lo: item.bill.batchNumber ?? '', date: dtM?.[1] ?? '', time: dtM?.[2] ?? '', amt: item.bill.totalAmount ? String(item.bill.totalAmount) : '', card: '', tach: '[]' });
  const [edits, setEdits] = useState<Record<string, string>>((snap?.edits as Record<string, string>) ?? {});
  const prevVals = useRef<Record<string, string>>({ tid, lo, date, time, amt: amt.value, card: '', tach: '[]' });
  const cardOrigRef = useRef(false); // đã chốt giá trị GỐC của thẻ/tách thẻ chưa (xem effect stampEdits)
  // [Admin Demo 7/9 — MƯỢN TID] tích khai "quẹt nhờ TID đại lý khác" + chọn đại lý MƯỢN → doanh số + TIN BILL về phòng đại
  // lý mượn (KHÔNG về chủ TID). Dealers lazy-fetch khi tích. Persist qua snapshot (giữ khi qua tab/menu).
  const [borrowChecked, setBorrowChecked] = useState<boolean>((snap?.borrowChecked as boolean) ?? false);
  const [borrowRoomId, setBorrowRoomId] = useState<string>((snap?.borrowRoomId as string) ?? '');
  const [borrowDealers, setBorrowDealers] = useState<{ roomId: string; name: string }[]>([]);
  useEffect(() => {
    // [Admin Demo 7/9] Dropdown MƯỢN chỉ phòng CÓ khách gán (customerId) — tránh chọn nhầm phòng trùng tên chưa gán → borrow 422.
    if (borrowChecked && borrowDealers.length === 0) fetchClassifyOptions().then((r) => { if (r.ok) setBorrowDealers(r.data.dealers.filter((d) => d.customerId != null)); });
  }, [borrowChecked, borrowDealers.length]);
  // [Admin Demo 5/9 — RE-ROUTE theo TID] Người review đổi TID sang máy khác (dropdown gợi ý / gõ tay) → hỏi lại server
  // (rerouteBill) lấy phòng đại lý/NĐT + loại thẻ + HKD/bank của TID MỚI. `reroute` giữ kết quả kèm forTid (TID nó ứng
  // với) — chỉ áp khi forTid === TID đang gõ (đổi TID lần nữa → chờ reroute mới). item = định tuyến TID OCR gốc (fallback).
  const [reroute, setReroute] = useState<(RerouteResult & { forTid: string }) | null>(null);
  const [rerouteLoading, setRerouteLoading] = useState(false);
  const routedTid = (item.bill.tid ?? '').trim(); // TID mà `item` đã được server resolve cho.
  const rr = reroute && reroute.forTid === tid.trim() ? reroute : null;
  // Giá trị định tuyến/hiển thị HIỆU LỰC: reroute thắng cho TID nó ứng với, else item gốc. Nút Gửi + preview dùng các
  // biến này (KHÔNG dùng item.* trực tiếp cho những trường thay đổi theo TID) để đổi TID là mở khoá gửi được.
  const dealerRoomId = rr ? rr.dealerRoomId : item.dealerRoomId;
  const dealerRoomName = rr ? rr.dealerRoomName : item.dealerRoomName;
  const investorRoomName = rr ? rr.investorRoomName : item.investorRoomName;
  const hkdName = rr ? rr.hkdName : item.hkdName;
  const bankName = rr ? rr.bankName : item.bankName;
  const cards: CardTypeOpt[] = rr ? rr.availableCardTypes : item.availableCardTypes;
  // [Admin Demo 8/9] Mở bill ĐÃ GHI để sửa → thẻ khởi tạo = THẺ ĐANG GHI TRÊN LÔ (currentCardTypeId), không phải thẻ mặc
  // định — nếu không, chỉ sửa giờ cũng có thể vô tình đổi phí sang thẻ khác.
  const theDangGhi = item.currentCardTypeId ?? (item.currentSplits && item.currentSplits.length > 0 ? item.currentSplits[0].cardTypeId : null);
  const [cardId, setCardId] = useState<number | null>((snap?.cardId as number) ?? theDangGhi ?? cards.find((c) => c.isPrimary)?.id ?? cards[0]?.id ?? null);
  // GIỮ HIỆN TRẠNG (Admin Demo 10/9 "đã xoay dọc ra thì phải giữ nguyên"): góc xoay lưu cùng snapshot của ẢNH này
  // (khoá theo snapBase + chỉ số bill) → qua tab/menu, tính lại phí, quay lại bill cũ hay re-OCR đều GIỮ góc đã xoay.
  // Bill CHƯA từng xoay → lấy GÓC DÙNG GẦN NHẤT trong phiên: cả folder chụp ngang thì khỏi phải xoay từng cái;
  // bill nào không cần thì xoay lại 0 (chip góc luôn hiện nên không sợ xoay nhầm mà không biết).
  const [xoay, setXoay] = useState<number>((snap?.xoay as number) ?? gocXoayGanNhat());
  const [settle95Ack, setSettle95Ack] = useState(false); // tick xác nhận rủi ro ĐÓNG LÔ 95 trước khi gửi (Admin Demo).
  const [mismatchAck, setMismatchAck] = useState(false); // [Audit 3/9 #9] tick xác nhận LỆCH TID↔HKD (tiền vào sai máy) trước khi gửi.
  const [warnAck, setWarnAck] = useState(false); // [Admin Demo 6/9] LỚP XÁC NHẬN CHUNG: bill CÓ CẢNH BÁO (sai ngày/lô/OCR mù/bug...) → phải tick xác nhận (hoặc Bỏ qua) trước gửi — chống nhân viên gửi vội.
  const primaryCard = cards.find((c) => c.id === cardId) ?? null;
  const tachDangGhi = (item.currentSplits ?? []).slice(1);
  const [others, setOthers] = useState<{ cardTypeId: number; amount: number }[]>((snap?.others as { cardTypeId: number; amount: number }[]) ?? tachDangGhi);
  const [splitOn, setSplitOn] = useState((snap?.splitOn as boolean) ?? tachDangGhi.length > 0);
  const [splitConfirmed, setSplitConfirmed] = useState((snap?.splitConfirmed as boolean) ?? false);
  useEffect(() => {
    // [Admin Demo 8/9 "sửa bill mà không cho sửa phí à? không sửa được thẻ"] LOẠI THẺ + TÁCH THẺ nay cũng tính là SỬA →
    // bill đã gửi hiện nút "Cập nhật" (trước đây chỉ theo dõi tid/lô/ngày/giờ/tiền nên đổi thẻ = không có nút nào).
    const cur = { tid, lo, date, time, amt: amt.value, card: String(cardId ?? ''), tach: JSON.stringify(splitOn ? others : []) };
    // Lần chạy ĐẦU: chốt GIÁ TRỊ GỐC của thẻ/tách thẻ (thẻ đang ghi trên lô) — nếu không, thẻ khởi tạo sẽ bị coi là
    // "đã sửa" ngay khi mở card (nút Cập nhật sáng oan, log ghi sai là người dùng đổi thẻ).
    if (!cardOrigRef.current) {
      cardOrigRef.current = true;
      origVals.current.card = cur.card; origVals.current.tach = cur.tach;
      prevVals.current = cur;
      return;
    }
    const { next, changed } = stampEdits(cur, prevVals.current, origVals.current, edits);
    prevVals.current = cur;
    if (changed) setEdits(next);
    // eslint-disable-next-line
  }, [tid, lo, date, time, amt.value, cardId, splitOn, JSON.stringify(others)]);
  // Bỏ qua lần chạy ĐẦU (mount) để KHÔNG reset splitConfirmed vừa khôi phục từ snapshot.
  const mountedRef = useRef(false);
  // Mọi thay đổi tách thẻ → HUỶ xác nhận cũ (bắt bấm "Xác nhận tách" lại) — chống gửi sai số. (Trừ lần mount.)
  useEffect(() => { if (!mountedRef.current) return; setSplitConfirmed(false); }, [splitOn, JSON.stringify(others), amount, cardId]);
  // Lưu snapshot mỗi khi state đổi (sau mount).
  useEffect(() => {
    mountedRef.current = true;
    try { sessionStorage.setItem(SNAP_KEY, JSON.stringify({ tid, lo, date, time, amt: amt.value, huy: huy.value, soGdHuy, cardId, others, splitOn, splitConfirmed, edits, dateConfirmed, borrowChecked, borrowRoomId, xoay })); } catch { /* quota */ }
  }, [SNAP_KEY, tid, lo, date, time, amt.value, huy.value, soGdHuy, cardId, others, splitOn, splitConfirmed, edits, dateConfirmed, borrowChecked, borrowRoomId, xoay]);
  const othersSum = others.reduce((s, o) => s + (Number(o.amount) || 0), 0);
  // [Admin Demo 18/9 "hủy GD khác với ghi nhận tách thẻ trong 1 lô"] Tách thẻ khai theo SỐ IN TRÊN BILL (tổng quẹt);
  // phần hủy do SERVER trừ (chuanHoaSplitsTruHuy) — người review không phải tính tay.
  const primaryAmount = amount - othersSum;
  const otherCards = cards.filter((c) => c.id !== cardId);
  const splitInvalid = splitOn && (primaryAmount < 0 || others.some((o) => !o.cardTypeId || !(o.amount > 0)));

  function buildSplits(): FeeSplitPart[] | undefined {
    if (!cardId) return undefined;
    const parts: FeeSplitPart[] = [{ cardTypeId: cardId, amount: primaryAmount }];
    if (splitOn) for (const o of others) if (o.cardTypeId && o.amount > 0) parts.push({ cardTypeId: o.cardTypeId, amount: Number(o.amount) });
    return parts;
  }

  const [fees, setFees] = useState<{ sell: FeeLine; install: FeeLine } | null>(item.sellFee && item.installFee ? { sell: item.sellFee, install: item.installFee } : null);
  const [feeLoading, setFeeLoading] = useState(false);
  useEffect(() => {
    if (!tid.trim() || !(amount > 0) || !cardId || splitInvalid) { setFees(null); return; }
    let alive = true; setFeeLoading(true);
    const h = window.setTimeout(async () => {
      // [Admin Demo 17/9] PHÍ tính trên TIỀN GHI NHẬN (tổng quẹt − hủy) — tính trên tổng quẹt là thu phí cả phần
      // đã hủy, lệch với doanh số server ghi (server dùng tienGhiNhan).
      const r = await feePreview(tid.trim(), amount, buildSplits(), tienHuy);
      if (!alive) return; setFeeLoading(false);
      setFees(r.ok ? r.data : null);
    }, 350);
    return () => { alive = false; window.clearTimeout(h); };
    // eslint-disable-next-line
  }, [tid, amount, tienHuy, cardId, splitOn, JSON.stringify(others)]);

  // [Admin Demo 5/9 — RE-ROUTE khi ĐỔI TID] Chọn TID gợi ý / gõ TID khác → hỏi lại server định tuyến + loại thẻ cho TID
  // MỚI. Chỉ chạy khi TID hiện KHÁC TID gốc item + trông hợp lệ (≥4 chữ số) + chưa có reroute đúng TID đó. Debounce
  // 400ms. Thành công → lưu reroute + đặt thẻ mặc định TID mới → fee preview (effect trên) chạy lại → nút Gửi mở khoá.
  // Thất bại mạng KHÔNG nuốt câm (R198): giữ nút khoá + lý do cũ; server /send vẫn là chốt cuối định tuyến/phí.
  useEffect(() => {
    const t = tid.trim();
    if (!t) return;
    // [Admin Demo 5/9] Chạy reroute khi: (a) TID đổi khỏi gốc, HOẶC (b) TID hợp lệ NHƯNG CHƯA có loại thẻ. Case (b) = OCR
    // KHÔNG đọc được TID → SUY từ tên HKD (tid = tid gốc của bill nhưng review trả availableCardTypes RỖNG) → selector
    // loại thẻ ẩn (cards.length>0 mới hiện) → user kẹt "chưa chọn loại thẻ" mà KHÔNG có nút chọn. Reroute nạp routing+thẻ.
    if (t === routedTid && cards.length > 0) return;
    if (!/^\d{4,}$/.test(t)) return;               // TID trông chưa hợp lệ → chưa hỏi server
    if (reroute && reroute.forTid === t) return;   // đã reroute cho đúng TID này rồi
    let alive = true; setRerouteLoading(true);
    const h = window.setTimeout(async () => {
      const r = await rerouteBill(t);
      if (!alive) return; setRerouteLoading(false);
      if (r.ok) {
        setReroute({ ...r.data, forTid: t });
        const nc = r.data.availableCardTypes;
        setCardId(r.data.primaryCardTypeId ?? nc.find((c) => c.isPrimary)?.id ?? nc[0]?.id ?? null);
      }
    }, 400);
    return () => { alive = false; window.clearTimeout(h); };
    // eslint-disable-next-line
  }, [tid, routedTid, reroute]);

  const [imgUrl, setImgUrl] = useState<string | null>(null);
  // [Admin Demo 3/9] Trạng thái LỖI ảnh: token pending mất (bot-api restart / TTL 15') → 404. TRƯỚC ĐÂY .catch nuốt câm
  // → imgUrl mãi null → SPINNER XOAY VÔ TẬN (user tưởng đang tải). Nay set cờ lỗi → hiện "ảnh hết hạn, quét lại".
  const [imgErr, setImgErr] = useState(false);
  useEffect(() => { let a = true; setImgErr(false); setImgUrl(null); fetchAttachmentObjectUrl(ocrImageUrl(token)).then((u) => { if (a) setImgUrl(u); }).catch(() => { if (a) setImgErr(true); }); return () => { a = false; }; }, [token]);

  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'warn' | 'err' | 'dupe'; msg?: string }>({ kind: 'idle' });
  const [zoomed, setZoomed] = useState(false);
  // [Admin Demo 10/9] BILL CHỤP NGANG: xoay 90° trái/phải để đọc — chỉ xoay HIỂN THỊ, KHÔNG đụng ảnh gốc/OCR/hash.

  // Render 2 ẢNH BẢNG (bill + bảng) client-side (Admin Demo 31/8 "ocr là bảng, card mà" — gửi ẢNH CARD, không text).
  // ĐẠI LÝ: bill + Ngân hàng/HKD/TID/Ngày/Giờ/Lô + Số tiền + HOÀN khách + Phí bán% (KHÔNG phí cài, KHÔNG tên NĐT).
  // NĐT: bill + Ngân hàng/HKD(tên máy POS)/TID/Ngày/Giờ/Lô + Số tiền + Phí cài máy% (KHÔNG hoàn, KHÔNG phí bán,
  // KHÔNG tên ĐẠI LÝ). Admin Demo 31/8 "NĐT cũng phải có tên HKD như đại lý" — HKD = tên máy POS NĐT đầu tư nên
  // ĐƯỢC xem; chỉ ẩn tên đại lý + phí bán/hoàn. Lỗi render → {} (server
  // fallback ảnh bill thô). bot-api chạy SYSTEM không có sharp nên PHẢI render ở client.
  async function renderComposites(): Promise<{ dealerImage?: string; investorImage?: string }> {
    try {
      if (!imgUrl) return {};
      const billBlob = await fetch(imgUrl).then((x) => x.blob());
      // [Admin Demo 8/9] Thứ tự: HKD (hero xanh) → TID · Ngày · Giờ · Số lô → Số tiền → Thẻ → Phí bán.
      // BỎ dòng "Ngân hàng" vì dòng THẺ đã nói rõ ngân hàng + loại thẻ (vd "MB", "Ngoài MB-Visa-Master").
      const baseRows: BillFieldDisplayRow[] = [
        { key: 'hkdName', label: 'HKD', text: hkdName ?? item.bill.agencyName ?? '—', muted: false },
        { key: 'tid', label: 'TID', text: tid.trim() || '—', muted: false },
        { key: 'date', label: 'Ngày', text: date.trim() || '—', muted: false },
        { key: 'time', label: 'Giờ', text: time.trim() || '—', muted: false },
        { key: 'batchNumber', label: 'Số lô', text: lo.trim() || '—', muted: false }
      ];
      // Dòng THẺ: tên loại thẻ đang áp + ghi rõ đang dùng mặc định hay người duyệt đã chọn lại.
      const theDangDung = cards.find((c) => c.id === cardId);
      const theText = theDangDung
        ? `${theDangDung.name}${theDangDung.isPrimary ? ' (mặc định)' : ' (đã chọn)'}`
        : (bankName ?? '—');
      const amountText = `${fmtVnd(amount)}đ`;
      const refund = fees?.sell.resolved && fees.sell.amount != null ? `${fmtVnd(amount - fees.sell.amount)}đ` : undefined;
      const dealer = await composeBillImage(billBlob, baseRows, amountText, refund, undefined, [{ label: 'Thẻ', value: theText }, { label: 'Phí bán', value: pctText(fees?.sell, amount) }]);
      // NĐT GIỮ tên HKD (máy POS) nhưng CHỈ lấy hkdName THẬT từ DB — KHÔNG mượn agencyName OCR (tránh lộ tên đại lý).
      const invRows = baseRows.map((r) => (r.key === 'hkdName' ? { ...r, text: hkdName ?? '—' } : r));
      const investor = await composeBillImage(billBlob, invRows, amountText, undefined, undefined, [{ label: 'Thẻ', value: theText }, { label: 'Phí cài máy', value: pctText(fees?.install, amount) }]);
      return { dealerImage: await blobToBase64(dealer.blob), investorImage: await blobToBase64(investor.blob) };
    } catch { return {}; }
  }

  async function doSend(allowDuplicate = false): Promise<void> {
    setSending(true); setStatus({ kind: 'idle' });
    // [Admin Demo 5/9 "gửi lại văng về dash — fix triệt để, cấm tái diễn"] MỌI lỗi bất ngờ (renderComposites canvas /
    // sendBill mạng / serialize) PHẢI thành status lỗi TẠI CHỖ, TUYỆT ĐỐI KHÔNG ném ra ngoài → không crash màn (mất
    // review + văng dashboard). Bọc try/catch/finally (R198: không nuốt câm — hiện lỗi rõ + giữ nguyên review để thử lại).
    try {
    const dateTime = [date.trim(), time.trim()].filter(Boolean).join(' ') || null;
    // [Phản biện 11/9] settlementCode PHẢI đi kèm lên /send — rơi field này là cảnh báo ĐÓNG LÔ 95 (rủi ro hoàn/hủy
    // GD) không bao giờ ghim lên tin gửi cho đại lý/NĐT (server bill95CaptionPrefix nhận undefined → rỗng).
    // [Admin Demo 17/9] PHẢI gửi kèm voidCount/voidAmount — rơi field là server mất phần TRỪ HỦY, doanh số ghi thừa.
    const bill: OcrBill = { tid: tid.trim() || null, agencyName: item.bill.agencyName, batchNumber: lo.trim() || null, type: item.bill.type, totalAmount: amount, dateTime, settlementCode: item.bill.settlementCode ?? null, voidCount: soGdHuy, voidAmount: tienHuy };
    const composites = await renderComposites();
    // bankName gửi kèm để card POS phòng đại lý/NĐT hiện Ô "Ngân hàng" (server gắn vào posBill meta). Dùng bankName
    // HIỆU LỰC (đã reroute nếu người sửa TID sang máy khác) — server vẫn re-resolve định tuyến/phí theo bill.tid.
    const r = await sendBill({ token, bill, bankName: bankName ?? null, splits: buildSplits(), allowDuplicate, borrowedByRoomId: borrowChecked && borrowRoomId ? borrowRoomId : undefined, ...composites });
    if (r.ok) {
      const investor = r.data.investorMessageId ? investorRoomName : null;
      const skip = (r.data as { investorSkippedReason?: string }).investorSkippedReason;
      const completed = (r.data as { completedPartial?: boolean }).completedPartial === true;
      // PHÂN BIỆT RÕ (Admin Demo 1/9 "rớt mạng chưa gửi 1 trong 2"): completedPartial = gửi lại hoàn tất cc NĐT (đại lý đã
      // gửi trước, không trùng). NĐT fail (ATT_FAIL) = đã gửi đại lý NHƯNG NĐT CHƯA → CẢNH BÁO bấm Gửi lại hoàn tất.
      // NO_INVESTOR_ROOM = chưa uỷ (bình thường). Có investorMessageId = gửi đủ.
      const base = completed
        ? `✓ Đã HOÀN TẤT cc NĐT "${investorRoomName ?? '—'}" (đại lý đã gửi trước — không gửi trùng).`
        : investor
          ? `Đã gửi nhóm đại lý "${dealerRoomName}" + cc NĐT "${investor}" ✓`
          : skip && skip.startsWith('ATT_FAIL')
            ? `⚠ Đã gửi nhóm đại lý "${dealerRoomName}" NHƯNG NĐT CHƯA nhận (lỗi ảnh) — bấm GỬI LẠI để hoàn tất cc NĐT (không gửi trùng đại lý).`
            : `Đã gửi nhóm đại lý "${dealerRoomName}" ✓ (không cc NĐT: chưa uỷ)`;
      // Kết quả GHI DOANH SỐ (Admin Demo 30/8): rõ ràng đã ghi Lô nào, hay chưa ghi được vì sao (vd TID chưa có).
      const rev = r.data.revenue;
      const revMsg = rev?.ok ? ` · 💰 Đã ghi doanh số (Lô #${rev.loId})` : rev ? ` · ⚠ CHƯA ghi doanh số: ${rev.message ?? 'lỗi'}` : '';
      setStatus({ kind: (rev && !rev.ok) || (skip && skip.startsWith('ATT_FAIL')) ? 'warn' : 'ok', msg: base + revMsg });
      onSent({ dealer: dealerRoomName, investor, warned: needsWarnAck ? warnReasons : undefined, billSent: { tid: bill.tid, lo: bill.batchNumber, dateTime: bill.dateTime ?? null, amount: bill.totalAmount } });
      return;
    }
    if (r.error === 'DUPLICATE' || r.error === 'DUP_SUSPECT') { setStatus({ kind: 'dupe', msg: r.message }); return; } // DUP_SUSPECT: nghi trùng doanh số (cùng máy+tiền+lô) → cho xác nhận gửi lại (ghi thêm)
    setStatus({ kind: 'err', msg: r.message });
    } catch (e) {
      setStatus({ kind: 'err', msg: 'Lỗi khi gửi (giữ nguyên review, thử lại): ' + (e instanceof Error ? e.message : String(e)) });
    } finally {
      setSending(false);
    }
  }

  // [Admin Demo 2/9] bill ĐÃ GỬI + có SỬA → CẬP NHẬT TẠI CHỖ trên tin cũ (không gửi trùng). Note thay đổi ghi vào bill.
  const EDIT_LABELS: Record<string, string> = { tid: 'TID', lo: 'Số lô', date: 'Ngày', time: 'Giờ', amt: 'Số tiền', card: 'Loại thẻ (đổi phí)', tach: 'Tách thẻ' };
  const hasEdits = Object.keys(edits).length > 0;
  async function doUpdateSent(): Promise<void> {
    if (!item.sentMessageId) return;
    setSending(true); setStatus({ kind: 'idle' });
    try {
      const dateTime = [date.trim(), time.trim()].filter(Boolean).join(' ') || null;
      // [Admin Demo 8/9] gửi kèm LOẠI THẺ (và tách thẻ nếu bật) → server tính lại phí bán/phí cài theo thẻ mới.
      const parts = buildSplits();
      const nhieuThe = splitOn && (parts?.length ?? 0) > 1;
      const r = await updateSentBill(item.sentMessageId, {
        tid: tid.trim() || null, batchNumber: lo.trim() || null, totalAmount: amount, dateTime,
        // [Admin Demo 25/9] TIỀN HỦY phải đi kèm khi sửa bill đã gửi — rơi trường này thì lô ghi lại theo TỔNG QUẸT,
        // doanh số phồng đúng bằng tiền hủy (ca thật lô 115: dư 10.863đ). Đúng cặp với ô nhập hủy trên màn review.
        voidAmount: soGdHuy > 0 || tienHuy > 0 ? tienHuy : 0, voidCount: soGdHuy,
        ...(nhieuThe ? { splits: parts } : cardId != null ? { cardTypeId: cardId } : {})
      });
      if (r.ok) {
        const changed = Object.keys(edits).map((k) => EDIT_LABELS[k] ?? k).join(', ');
        setStatus({ kind: 'ok', msg: `✓ Đã CẬP NHẬT bill đã gửi tại chỗ (${changed || 'thông số'})${r.data.revenueUpdated ? ' · 💰 tính lại doanh số' : ''} — KHÔNG gửi trùng.` });
        onSent({ dealer: dealerRoomName, investor: null, billSent: { tid: tid.trim() || null, lo: lo.trim() || null, dateTime, amount } }); // [24/9] trả GIÁ TRỊ VỪA SỬA để bảng ngoài đồng bộ
        return;
      }
      setStatus({ kind: 'err', msg: r.message });
    } catch (e) {
      setStatus({ kind: 'err', msg: 'Lỗi khi cập nhật (giữ nguyên review, thử lại): ' + (e instanceof Error ? e.message : String(e)) });
    } finally {
      setSending(false);
    }
  }

  // CẢNH BÁO ĐÓNG LÔ 95 (Admin Demo, money): mã ĐÓNG(95) = rủi ro hoàn tiền/hủy GD sau → BUỘC tick xác nhận trước Gửi.
  const is95 = item.bill.settlementCode === '95';
  // [Admin Demo 17/9 "đóng lô 95 MB không chặn gửi" + "MBV cũng thế, xác nhận gửi được"] MB và MBV KHÔNG chặn: vẫn
  // hiện con dấu SOS để người gửi BIẾT, nhưng không bắt tick — chặn ở 2 nhà này chỉ gây kẹt việc, không giảm rủi ro.
  // Ngân hàng khác GIỮ NGUYÊN gate tick (rủi ro khách hoàn/hủy GD sau khi SigMa đã chuyển tiền).
  const bankMien95 = ((): boolean => {
    const b = String(bankName ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '').toUpperCase();
    return b === 'MB' || b === 'MBBANK' || b === 'MBV' || b === 'MBVIET' || b === 'MBVIETNAM';
  })();
  const chan95 = is95 && !bankMien95;
  // [Audit 3/9 #9] Cờ LỆCH TID↔HKD (OCR/route vào SAI máy) — trước đây chỉ hiện đỏ, KHÔNG chặn Gửi → tiền vào sai máy
  // vẫn gửi được. Nay gate Gửi = phải TICK xác nhận đúng máy (như lô 95). Người sửa TID đúng → warning mất → không cần tick.
  const hasTidHkdMismatch = item.warnings.some((w) => /LỆCH TID/i.test(w));
  // [Admin Demo 6/9] MỌI cảnh báo OCR/logic (ngày lệch thứ tự flagWarn + cảnh báo khác, TRỪ LỆCH-TID [đã có mismatchAck] và
  // ĐÃ-GỬI [khóa gửi riêng]) → PHẢI tick xác nhận thêm 1 lần. Gom lý do để hiện + log.
  // [Admin Demo 10/9] Dòng mở đầu bằng "ℹ" = THÔNG TIN (vd TID không in rõ nhưng tên HKD khớp duy nhất 1 máy) → vẫn
  // HIỆN cho người xem, nhưng KHÔNG bắt tick xác nhận (trước đây mọi cảnh báo đều bắt tick ⇒ bill bình thường cũng
  // phải tick, thành thói quen tick bừa — nguy hiểm hơn là bớt tick đúng chỗ).
  const otherWarns = item.warnings.filter((w) => !/LỆCH TID/i.test(w) && !/ĐÃ GỬI/i.test(w) && !w.trim().startsWith('ℹ'));
  const warnReasons: string[] = [...(flagWarn ? [flagWarn.reason] : []), ...otherWarns];
  const needsWarnAck = warnReasons.length > 0;
  const canSend = !!tid.trim() && amount > 0 && !!dealerRoomId && !!cardId && !splitInvalid && (!splitOn || splitConfirmed) && !sending && fees?.sell.resolved === true && (!chan95 || settle95Ack) && (!hasTidHkdMismatch || mismatchAck) && (ocrHadDate || dateConfirmed) && (!needsWarnAck || warnAck);
  // [Admin Demo 5/9 — CA A "Gửi xám câm + đổi TID vẫn câm", R198 cấm chặn câm] canSend=false PHẢI nói RÕ LÝ DO + đường sửa
  // ngay cạnh nút Gửi. Phổ biến nhất: phí bán KHÔNG resolve (TID nghi đọc nhầm 0↔6 / TID chưa cấu hình giá bán / ngoài
  // scope đại lý) → trước đây nút chỉ xám, user KẸT không biết vì sao. Lý do 95/tách/lệch-TID đã có ở chữ trên nút nên
  // để null (khỏi lặp). fees.sell.note = thông điệp thật từ /fee (NO_ACTUAL_SELL_FEE...). Cập nhật LIVE khi đổi TID.
  const feeUnresolved = !feeLoading && !!tid.trim() && amount > 0 && !!cardId && !splitInvalid && (fees == null || fees.sell.resolved !== true);
  const sendBlockReason: string | null = sending ? null
    : !tid.trim() ? 'Chưa gửi được: THIẾU TID — nhập hoặc chọn TID đúng máy ở ô trên.'
    : !(amount > 0) ? 'Chưa gửi được: THIẾU số tiền bill.'
    : rerouteLoading ? `Đang tra lại nhóm đại lý + loại thẻ cho TID ${tid.trim()}…`
    : !dealerRoomId ? `Chưa gửi được: TID ${tid.trim()} KHÔNG thuộc nhóm đại lý nào — nghi đọc nhầm TID, hoặc TID chưa được gán đại lý. ${(item.tidSuggestions?.length ?? 0) > 0 ? 'Chọn TID đúng ở "Gợi ý TID theo HKD" phía trên' : 'Sửa TID đúng máy'}, hoặc "Quét lại ảnh này".`
    : !cardId ? 'Chưa gửi được: chưa chọn loại thẻ.'
    : splitInvalid ? 'Chưa gửi được: tách thẻ chưa hợp lệ — chọn thẻ + nhập số tiền, tổng không vượt số bill.'
    : (splitOn && !splitConfirmed) ? null // chữ trên nút đã nhắc "Xác nhận tách tiền trước khi gửi"
    : feeUnresolved ? `Chưa gửi được: TID ${tid.trim()} CHƯA có GIÁ BÁN (phí bán)${fees?.sell.note ? ` — ${fees.sell.note}` : ' — nghi OCR đọc nhầm TID hoặc TID chưa cấu hình giá bán thực tế'}. ${(item.tidSuggestions?.length ?? 0) > 0 ? 'Chọn TID đúng ở "Gợi ý TID theo HKD" phía trên' : 'Sửa TID đúng máy (ô TID)'}, hoặc "Quét lại ảnh này". Không có giá bán thì không tính được tiền để gửi.`
    : (!ocrHadDate && !dateConfirmed) ? `Chưa gửi được: OCR KHÔNG đọc được NGÀY (đang mặc định hôm nay ${date}). Kiểm ảnh, nhập/chọn đúng ngày (hoặc bấm "Đúng ngày này ✓") rồi gửi — tránh ghi doanh số sai ngày.`
    : (needsWarnAck && !warnAck) ? `Chưa gửi được: bill CÓ CẢNH BÁO (${warnReasons[0]}${warnReasons.length > 1 ? ` +${warnReasons.length - 1} cảnh báo nữa` : ''}) — kiểm lại ảnh/thông số rồi TICK xác nhận gửi, hoặc Bỏ qua để kiểm.`
    : null; // 95 / lệch-TID: chữ trên nút Gửi đã nêu, khỏi lặp.
  // Màu theo TONE NGÂN HÀNG (Admin Demo) — tô MỌI ô data theo bank. Chuẩn hoá bỏ dấu + hoa để khớp.
  const bankU = (bankName ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const bankColor = BANK_COLORS[bankU];
  const RO = 'rounded-xl border border-line bg-appbg px-2 py-2 text-sm font-semibold truncate'; // ô read-only HKD/Bank
  // Phí LUÔN dạng bảng ô (Admin Demo "chia ô như tid hkd"): tách thẻ → nhiều dòng; 1 thẻ → 1 dòng từ thẻ đang chọn.
  const feeRows: FeeRow[] = fees?.sell.breakdown?.length || fees?.install.breakdown?.length
    ? mergeBreakdown(fees)
    : fees ? [{ cardName: primaryCard?.name ?? 'thẻ', amount, sell: fees.sell.resolved ? fees.sell.amount ?? 0 : null, sellMilli: fees.sell.milli ?? null, install: fees.install.resolved ? fees.install.amount ?? 0 : null, installMilli: fees.install.milli ?? null }]
    : [];

  // [Admin Demo 5/9 — CẢNH BÁO BÊN PHẢI ẢNH BILL] Ở chế độ STACKED (tab TỰ ĐỘNG) ảnh bill cao-hẹp chừa TRỐNG bên phải →
  // đưa KHỐI CẢNH BÁO (folder + cần-kiểm-tay + "ĐÃ GỬI trước" + warnings) vào chỗ trống đó, ngay dưới nhãn "🔍 phóng to".
  // Tách imageColumn + warningsBlock ra biến để bố cục được ở 2 nơi: stacked = [ảnh | cảnh báo], thường = cảnh báo trên
  // cột thông số như cũ. Thông số (tiền/phí…) LUÔN full-width phía dưới. hasWarn: có gì để đặt bên phải không.
  const hasWarn = !!folderName || !!flagWarn || item.alreadySent || item.warnings.length > 0;
  const besideWarn = stacked && hasWarn; // bố cục ảnh-trái | cảnh-báo-phải (chỉ khi stacked + có cảnh báo)
  const imageColumn = (
    // [Admin Demo 6/9 — ĐỒNG NHẤT QrBillReviewCard] CỘT ẢNH TRÁI cố định lg:w-[40%]; mọi màn còn lại full-width.
    <div className="flex flex-col gap-2 self-start w-full lg:w-[40%] lg:shrink-0">
      <button type="button" onClick={() => imgUrl && setZoomed(true)} className="group relative block w-full overflow-hidden rounded-xl border border-line bg-appbg" title="Bấm để phóng to toàn màn hình">
        {imgUrl
          ? (
            <span className={`flex w-full items-center justify-center overflow-hidden ${stacked ? 'h-[34vh]' : 'h-[58vh]'}`}>
              <img src={imgUrl} alt="bill" className="object-contain"
                style={{ transform: `rotate(${xoay}deg)`, maxHeight: xoay % 180 === 0 ? '100%' : '100vw', maxWidth: xoay % 180 === 0 ? '100%' : (stacked ? '34vh' : '58vh') }} />
            </span>
          )
          : imgErr
            ? <div className="flex h-64 flex-col items-center justify-center gap-2 px-4 text-center"><AlertTriangle className="h-7 w-7 text-amber-400" /><span className="text-xs text-slate-500">Ảnh hết hạn (máy chủ vừa khởi động lại). Bấm <b>"Quét lại ảnh này"</b> bên dưới để tải lại.</span></div>
            : <div className="flex h-64 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-slate-300" /></div>}
        {/* [Admin Demo 25/9 "dán thẳng dấu đóng 95 vào ảnh bill để cảnh báo"] Con dấu SOS LÔ 95 ĐÈ GIỮA ẢNH BILL.
            Trước đây dấu chỉ nằm ở thẻ cảnh báo bên cạnh — người duyệt nhìn ảnh để đối chiếu số thì không thấy.
            Dán lên ảnh ⇒ không thể bỏ sót. pointer-events-none để bấm vào vẫn mở phóng to như cũ. */}
        {imgUrl && is95 && (
          <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" data-testid="sos95-tren-anh">
            <Sos95Stamp size={stacked ? 150 : 210} note={false} />
          </span>
        )}
        {imgUrl && <span className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white opacity-80 group-hover:opacity-100">🔍 phóng to</span>}
        {/* XOAY 90° (Admin Demo 10/9) — bill chụp ngang. Nằm ĐÈ trên ảnh; chặn sự kiện để không mở phóng to khi bấm. */}
        {imgUrl && (
          <span className="absolute bottom-2 left-2 flex gap-1" onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}>
            <span role="button" tabIndex={0} title="Xoay trái 90°" data-testid="xoay-trai"
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); setXoay((d) => { const m = (d + 270) % 360; nhoGocXoay(m); return m; }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') setXoay((d) => { const m = (d + 270) % 360; nhoGocXoay(m); return m; }); }}
              className="cursor-pointer rounded-full bg-black/55 p-1.5 text-white hover:bg-black/75"><RotateCcw className="h-4 w-4" /></span>
            <span role="button" tabIndex={0} title="Xoay phải 90°" data-testid="xoay-phai"
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); setXoay((d) => { const m = (d + 90) % 360; nhoGocXoay(m); return m; }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') setXoay((d) => { const m = (d + 90) % 360; nhoGocXoay(m); return m; }); }}
              className="cursor-pointer rounded-full bg-black/55 p-1.5 text-white hover:bg-black/75"><RotateCw className="h-4 w-4" /></span>
            {xoay !== 0 && <span className="rounded-full bg-black/55 px-2 py-1 text-[10px] font-bold text-white">{xoay}°</span>}
          </span>
        )}
      </button>
      {onPickAnother && <Button variant="soft" size="sm" icon={<Upload className="h-3.5 w-3.5" />} onClick={onPickAnother} disabled={pickBusy} className="w-full">Chọn ảnh khác</Button>}
      {/* QUÉT LẠI (Admin Demo 1/9 "ảnh hết hạn mà không có nút tải lại"): token pending TTL 15' / mất khi bot-api
          restart → EXPIRED. Nút này OCR LẠI đúng ảnh này → token MỚI, không phải quét lại cả folder. */}
      {onRescan && <Button variant="soft" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRescan} disabled={rescanBusy} className="w-full">Quét lại ảnh này</Button>}
      {/* [Admin Demo 4/9] Đọc lại bằng OPUS (model mạnh) — cho bill nghi đọc sai (ngày lùi / số mờ). Chậm hơn, dùng khi cần. */}
      {onRescanOpus && <Button variant="soft" size="sm" icon={<ScanLine className="h-3.5 w-3.5" />} onClick={onRescanOpus} disabled={rescanBusy} className="w-full" title="Đọc lại bằng model Opus (mạnh hơn) cho bill nghi đọc sai ngày/số">Đọc lại (Opus)</Button>}
    </div>
  );
  const warningsBlock = hasWarn ? (
    <>
      {/* [Admin Demo 5/9] TÊN FOLDER đang chọn — hiện ngay đầu card review cạnh bill để biết bill này thuộc folder nào. */}
      {folderName && (
        <div className="flex items-center gap-1.5 rounded-lg border border-line bg-appbg px-2 py-1 text-[11px] text-slate-500">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-brand" /> Folder: <b className="text-slate-700">{folderName}</b>
        </div>
      )}
      {/* [Admin Demo 4/9] BILL CẦN KIỂM TAY (ngày lùi / không đọc được / lỗi OCR) — banner ĐỎ ĐẬM đầu cột, bắt sửa. */}
      {flagWarn && (
        <div className="rounded-lg border-2 border-danger bg-danger/10 p-2 text-xs font-bold text-danger">
          <div className="flex items-start gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0 mt-px" /> <span>{flagWarn.reason}</span></div>
          {flagWarn.suggestDate && <div className="mt-1 pl-5 text-[11px] font-semibold text-danger/90">→ Sửa ô "Ngày" bên dưới thành <b>{flagWarn.suggestDate}</b> rồi bấm gửi lại.</div>}
        </div>
      )}
      {/* [Admin Demo 4-5/9] MỌI CẢNH BÁO đưa lên ĐẦU cột phải — NGAY CẠNH ẢNH bill, RÕ RÀNG. "Đã gửi" = khối NỔI BẬT
          riêng (không còn lạc ở footer). LỆCH TID↔HKD = đỏ nổi; còn lại amber. Chỉ hiện khi có cảnh báo. */}
      {item.alreadySent && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-100 p-2 text-xs font-bold text-amber-800">
          <div className="flex items-start gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0 mt-px" /> ✓ Bill này ĐÃ GỬI trước đó — KHÔNG gửi lại (chống nhân đôi doanh số).</div>
          <div className="mt-1 pl-5 text-[11px] font-medium text-amber-700/90">Đổi thông số: SỬA ô bên dưới rồi bấm <b>Cập nhật</b>; không thì <b>Bỏ qua</b>.</div>
        </div>
      )}
      {item.warnings.length > 0 && (
        <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50/60 p-2">
          {item.warnings.map((w, i) => /LỆCH TID/i.test(w)
            ? <div key={i} className="flex items-start gap-1.5 rounded-lg border-2 border-danger bg-danger/10 px-2 py-1.5 text-xs font-semibold text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {w}</div>
            : <div key={i} className="flex items-start gap-1.5 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" /> {w}</div>)}
        </div>
      )}
    </>
  ) : null;
  // [Admin Demo 7/9 — MƯỢN TID] KHỐI khai "quẹt nhờ TID đại lý khác" — đặt CỘT PHẢI cạnh bill (Admin Demo: dropdown cùng khối
  // phải để chống cắt đáy). Tích + chọn đại lý MƯỢN → doanh số + TIN BILL về phòng mượn (KHÔNG chủ TID). Luôn hiện.
  const borrowBlock = (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
      <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
        <input type="checkbox" checked={borrowChecked} onChange={(e) => { setBorrowChecked(e.target.checked); if (!e.target.checked) setBorrowRoomId(''); }} className="h-3.5 w-3.5 accent-amber-600" />
        🔗 Mượn TID (đại lý khác quẹt nhờ máy này)
      </label>
      {borrowChecked && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <span className="text-[10.5px] text-amber-700 dark:text-amber-300/80">Chọn ĐẠI LÝ MƯỢN — doanh số + tin bill về phòng này (KHÔNG về chủ TID):</span>
          {/* [Admin Demo 25/9 "dropdown mượn TID khó nhìn danh sách đại lý, cho NỔI 3D đại lý chọn và HIỆN TO RÕ"]
              Ô chọn trước đây text-xs, chọn xong tên đại lý nằm lọt thỏm trong ô — gửi nhầm nhà là sai tiền.
              Nay: chữ TO trong ô chọn (Chrome lấy font-size của <select> cho cả danh sách xổ ra), và khi đã chọn
              thì đóng thêm 1 THẺ NỔI bên dưới hiện TÊN ĐẠI LÝ cỡ lớn — nhìn phát biết ngay tiền về nhà nào. */}
          <select value={borrowRoomId} onChange={(e) => setBorrowRoomId(e.target.value)} data-testid="chon-dai-ly-muon"
            className="w-full rounded-xl border-2 border-amber-400 bg-white px-3 py-2.5 text-base font-bold text-slate-800 shadow-[0_2px_0_0_rgb(217_119_6/0.45)] outline-none transition focus:border-amber-500 focus:shadow-[0_3px_0_0_rgb(217_119_6/0.6)] dark:bg-slate-800 dark:text-slate-100">
            <option value="">— Chọn đại lý mượn —</option>
            {borrowDealers.map((d) => <option key={d.roomId} value={d.roomId} className="text-base font-bold">{d.name}</option>)}
          </select>
          {borrowRoomId && (
            <div data-testid="the-dai-ly-muon"
              className="flex items-center gap-2.5 rounded-xl border-2 border-amber-500 bg-gradient-to-b from-amber-100 to-amber-200 px-3 py-2.5 shadow-[0_4px_0_0_rgb(180_83_9/0.55),0_6px_12px_-4px_rgb(180_83_9/0.5)] dark:from-amber-500/25 dark:to-amber-600/25">
              <span className="text-xl leading-none">🔗</span>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-extrabold uppercase tracking-wider text-amber-700 dark:text-amber-300">Doanh số + bill về nhà</div>
                <div className="truncate text-lg font-black leading-tight text-amber-900 drop-shadow-[0_1px_0_rgb(255_255_255/0.85)] dark:text-amber-100 dark:drop-shadow-none">
                  {borrowDealers.find((d) => d.roomId === borrowRoomId)?.name ?? '—'}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    // [Admin Demo 2/9 — VIỆC 2 "nút gửi vẫn bị tràn dưới, cho CAO LÊN"] BOUND chiều cao card + NỘI DUNG cuộn TRONG,
    // FOOTER nút Gửi PIN đáy (shrink-0) — GIỐNG card CK (TransferReviewCard). Trước đây card KHÔNG bound + footer
    // `sticky bottom-0` mà AppShell overflow-hidden (không có ancestor cuộn) → card cao đẩy nút Gửi khuất/cắt đáy.
    <div className="flex flex-col rounded-2xl border border-line bg-white shadow-soft">
      <div className="flex-1">
      {/* BỐ CỤC 2 CỘT (Admin Demo 6/9 — ĐỒNG NHẤT QrBillReviewCard): ẢNH bill CỘT TRÁI lg:w-[40%]; CỘT PHẢI =
          cảnh báo (trên) → tham số → điều khiển. KHÔNG cuộn nội bộ (bỏ max-h/overflow) — chỉ log ngoài cuộn.
          Footer nút Gửi vẫn PIN đáy card (hàng riêng shrink-0). */}
      <div className="flex flex-col gap-3 p-3 lg:flex-row lg:items-start">
        {/* CỘT TRÁI — bill to (click phóng to) + nút "Chọn ảnh khác" NGAY DƯỚI MÉP ẢNH. */}
        {imageColumn}

        {/* CỘT PHẢI — cảnh báo (trên) → tham số → điều khiển (đồng nhất Qr/CK). */}
        <div className="min-w-0 flex-1 space-y-2.5">
          {warningsBlock}
          {borrowBlock}
          {/* [Admin Demo 8/9] BỐ CỤC: HKD lên TRÊN CÙNG (chữ xanh, to như số tiền) → TID · Ngày · Giờ · Số lô →
              SỐ TIỀN → Loại thẻ → Phí bán. Giống hệt khối đối chiếu in trên ảnh bill gửi đi. */}
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={LABELC}>HKD {(hkdName ?? item.bill.agencyName) ? '' : '⚠ OCR không đọc được tên'}</span>
            <div className={`${RO} !py-1 truncate text-xl font-bold`} style={{ color: bankColor ?? 'var(--color-brand)' }} title={hkdName ?? ''}>
              {hkdName ?? item.bill.agencyName ?? '—'}
              {bankName ? <span className="ml-2 align-middle text-xs font-semibold opacity-70">· {bankName}</span> : null}
            </div>
            {/* [Admin Demo 18/9 "không ra tên hkd hoặc không ra số tid thì TID và TÊN HKD đều được gợi ý dropdown"]
                Trước chỉ có dropdown ở Ô TID — người quen nhìn TÊN máy không có chỗ chọn. Cùng danh sách
                tidSuggestions (server trả, mù thì fallback toàn bộ máy): chọn TÊN → set TID tương ứng → đi trọn
                luồng sẵn có (reroute lấy phòng/thẻ/phí từ server + edit-stamp "đã sửa"). 2 tab dùng chung thẻ này. */}
            {(item.tidSuggestions?.length ?? 0) > 0 && (
              <select
                data-testid="chon-ten-hkd"
                className={`${INPUTC} mt-0.5 text-[11px]`}
                value={item.tidSuggestions!.some((sg) => sg.tid === tid.trim()) ? tid.trim() : ''}
                onChange={(e) => { if (e.target.value) setTid(e.target.value); }}
                title="Chọn TÊN HKD (máy) — tự điền TID tương ứng; vẫn sửa tay ở ô TID"
              >
                <option value="">🔎 Chọn tên HKD ({item.tidSuggestions!.length} máy)…</option>
                {item.tidSuggestions!.map((sg) => <option key={sg.tid} value={sg.tid}>{sg.hkdName}</option>)}
              </select>
            )}
          </div>
          {/* [Admin Demo 8/9] Hàng: TID (màu theo ngân hàng) */}
          <div className="grid grid-cols-1 gap-2">
            <label className="flex min-w-0 flex-col gap-0.5">
              <span className={LABELC}>TID {tid.trim() ? '' : '⚠'}</span>
              <input data-testid="o-tid" className={`${INPUTC} font-semibold`} style={{ color: bankColor }} value={tid} onChange={(e) => setTid(e.target.value.replace(/\s/g, ''))} />
              {/* [Admin Demo 2/9] TID nghi ngờ → DROPDOWN gợi ý các TID CÙNG HỌ HKD (1/2/3...) để chọn đúng máy; vẫn sửa
                  tay ở ô trên. Chọn xong set thẳng tid (đi qua edit-stamp → xác nhận "đã sửa"). */}
              {(item.tidSuggestions?.length ?? 0) > 0 && (
                <select
                  className={`${INPUTC} mt-0.5 text-[11px]`}
                  value={item.tidSuggestions!.some((s) => s.tid === tid.trim()) ? tid.trim() : ''}
                  onChange={(e) => { if (e.target.value) setTid(e.target.value); }}
                  title="Gợi ý TID đúng theo tên HKD (chọn đúng máy 1/2/3...) — vẫn sửa tay ở ô trên"
                >
                  <option value="">🔎 Gợi ý TID theo HKD ({item.tidSuggestions!.length} máy)…</option>
                  {item.tidSuggestions!.map((s) => <option key={s.tid} value={s.tid}>{s.hkdName} · TID {s.tid}</option>)}
                </select>
              )}
              {/* Sửa TID → xác nhận "đã sửa" + ÁP DỤNG NGAY khi gửi (Admin Demo 2/9 "sửa xong phải xác nhận, áp ngay như
                  ngày bill CK"). So với TID review ban đầu (item.bill.tid, có thể đã suy từ HKD). */}
              {tid.trim() !== (item.bill.tid ?? '').trim() && (
                <span className="mt-0.5 flex items-center gap-0.5 text-[10px] font-semibold text-success"><CheckCircle2 className="h-3 w-3" /> Đã sửa TID → {tid.trim() || '—'} (OCR: {item.bill.tid ?? '—'}){edits.tid ? ` · lúc ${edits.tid}` : ''}</span>
              )}
            </label>
          </div>

          {/* [Admin Demo 8/9] Thứ tự: NGÀY · GIỜ · SỐ LÔ (khớp khối đối chiếu in trên ảnh bill).
              Ngày chiếm 2 cột vì có ô nhập dd/mm/yyyy + nút chọn lịch — chia đều 3 sẽ bóp mất chữ. */}
          {/* Cột review hẹp (ảnh bill chiếm 40%) → chia 4 là bóp mất chữ trong ô. Hẹp: Ngày full 1 hàng, Giờ+Số lô
              hàng dưới. Rộng (xl): cả 3 trên 1 hàng. */}
          {/* [17/9] `xl:` là breakpoint theo CỬA SỔ, không theo BỀ RỘNG CỘT: ở tab TỰ ĐỘNG (stacked) cửa sổ vẫn
              ≥1280px nên xl bật → chia 4 → ô Ngày bóp còn "16/09/" (mất năm). Ngày sai là doanh số ghi sai ngày,
              nên cột hẹp phải giữ 2 cột. */}
          <div className={`grid grid-cols-2 gap-2 ${stacked ? '' : 'xl:grid-cols-4'}`}>
            <label className="col-span-2 flex min-w-0 flex-col gap-0.5">
              <span className={LABELC}>Ngày {!ocrHadDate && (dateConfirmed
                ? <span className="font-semibold text-emerald-600">✓ đã xác nhận ngày (OCR mù ngày — bạn đã kiểm)</span>
                : <span className="font-semibold text-danger">🔴 OCR KHÔNG đọc được ngày — nhập/chọn đúng ngày (hoặc bấm "Đúng ngày này") rồi mới gửi được. CẤM gửi ngày mặc định (sai ngày ghi doanh số).</span>)}
                {!ocrHadDate && !dateConfirmed && <button type="button" onClick={() => setDateConfirmed(true)} className="ml-1 rounded border border-emerald-400 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 hover:bg-emerald-100">Đúng ngày này ✓</button>}</span>
              {/* Text dd/mm/yyyy (giữ giá trị OCR) + date-picker native (Admin Demo 1/9 "nút sửa ngày chọn ngày đúng"). */}
              <div className="flex items-center gap-1">
                <input className={INPUTC + ' flex-1'} placeholder="dd/mm/yyyy" value={date} onChange={(e) => { setDate(e.target.value); setDateConfirmed(true); }} />
                <input type="date" aria-label="Chọn ngày" title="Chọn ngày đúng" className="date-vn-icon h-8 w-8 shrink-0 cursor-pointer rounded-lg border border-line bg-white p-0.5 text-transparent" value={dmyToIso(date)} onChange={(e) => { setDate(isoToDmy(e.target.value) || date); setDateConfirmed(true); }} />
              </div>
              <EditedNote at={edits.date} />
            </label>
            <label className="flex min-w-0 flex-col gap-0.5">
              <span className={LABELC}>Giờ</span>
              <input className={INPUTC} placeholder="HH:mm:ss" value={time} onChange={(e) => setTime(e.target.value)} />
              <EditedNote at={edits.time} />
            </label>
            <label className="flex min-w-0 flex-col gap-0.5">
              <span className={LABELC}>Số lô</span>
              <input className={INPUTC} value={lo} onChange={(e) => setLo(e.target.value.trim())} />
              <EditedNote at={edits.lo} />
            </label>
          </div>

          {/* Số tiền — 2 Ô 1 HÀNG (Admin Demo 30/8): TRƯỚC PHÍ (nhập) | SAU PHÍ = HOÀN KHÁCH (= trước phí − phí bán,
              tiền đại lý trả lại KHÁCH HÀNG). Ô hoàn read-only màu xanh, cập nhật live theo phí. */}
          <div className={`grid gap-2 ${stacked ? 'grid-cols-1' : 'grid-cols-2'}`}>
            <label className="flex min-w-0 flex-col gap-0.5">
              <span className={LABELC}>Số tiền (trước phí)</span>
              <input ref={amt.inputRef} data-testid="o-so-tien" inputMode="numeric" className={`${INPUTC} !py-1 font-bold tabular-nums ${stacked ? 'text-lg' : 'text-xl'}`} style={{ color: bankColor ?? 'var(--color-brand)' }} value={amt.value} onChange={amt.onChange} />
              <EditedNote at={edits.amt} />
            </label>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className={LABELC}>Sau phí — hoàn khách</span>
              <div className={`${INPUTC} !py-1 flex items-center justify-end truncate font-bold tabular-nums text-success ${stacked ? 'text-lg' : 'text-xl'}`} title="Tiền đại lý trả lại khách = số tiền − phí bán">
                {fees?.sell.resolved && fees.sell.amount != null ? fmtVnd(tienGhi - fees.sell.amount) : '—'}
              </div>
            </div>
          </div>

          {/* [Admin Demo 17/9 "tất cả các màn đều có biểu số tiền hủy giao dịch"] Bill TỔNG KẾT có dòng HỦY → hiện
              RÕ 3 số: tổng quẹt · hủy · GHI NHẬN (= quẹt − hủy). Trước đây chỉ lấy dòng "Thanh toán" nên doanh số
              ghi THỪA đúng bằng phần đã hủy (ca thật ABB lô 75: thừa 11.000đ). Không có hủy → không hiện, bảng sạch. */}
          {/* [Admin Demo 17/9] LUÔN hiện khối HỦY (cả 2 tab — dùng chung thẻ này) với Ô NHẬP sửa được: OCR đọc hụt
              dòng "HỦY" là doanh số ghi THỪA đúng phần đã hủy, phải có chỗ nhập tay. */}
          <div className={`rounded-lg border-2 p-2 ${tienHuy > 0 ? 'border-amber-400 bg-amber-50' : 'border-line bg-slate-50/60'}`} data-testid="khoi-huy-gd">
            <div className="mb-1 flex items-center justify-between">
              <span className={`text-[11px] font-extrabold uppercase tracking-wide ${tienHuy > 0 ? 'text-amber-700' : 'text-slate-500'}`}>Giao dịch HỦY trên bill tổng kết</span>
              {(item.bill.voidAmount ?? 0) > 0 && <span className="text-[10.5px] font-semibold text-slate-500">OCR đọc: {fmtVnd(item.bill.voidAmount ?? 0)}đ · {item.bill.voidCount ?? 0} GD</span>}
            </div>
            <div className={`grid gap-2 ${stacked ? 'grid-cols-2' : 'grid-cols-3'}`}>
              <label className="flex min-w-0 flex-col gap-0.5">
                <span className={LABELC}>Tiền hủy</span>
                <input ref={huy.inputRef} inputMode="numeric" data-testid="o-tien-huy"
                  className={`${INPUTC} !py-1 text-right font-bold tabular-nums ${stacked ? 'text-sm' : 'text-base'} ${tienHuy > 0 ? 'text-danger' : 'text-slate-500'}`}
                  value={huy.value} onChange={huy.onChange} />
              </label>
              <label className="flex min-w-0 flex-col gap-0.5">
                <span className={LABELC}>Số GD hủy</span>
                <input inputMode="numeric" data-testid="o-so-gd-huy"
                  className={`${INPUTC} !py-1 text-center font-bold tabular-nums text-slate-600 ${stacked ? 'text-sm' : 'text-base'}`}
                  value={String(soGdHuy)} onChange={(e) => setSoGdHuy(Math.max(0, Number(e.target.value.replace(/[^\d]/g, '')) || 0))} />
              </label>
              <div className={`flex min-w-0 flex-col gap-0.5 ${stacked ? 'col-span-2' : ''}`}>
                <span className={LABELC}>Ghi nhận doanh số</span>
                <div className={`flex items-center justify-end rounded-lg-mac border border-line bg-white px-2 py-1 font-extrabold tabular-nums text-emerald-700 ${stacked ? 'text-sm' : 'text-base'}`} data-testid="tien-ghi-nhan">
                  {fmtVnd(tienGhi)}đ
                </div>
              </div>
            </div>
            <div className="mt-1 text-[10.5px] font-semibold text-slate-500">
              Ô “Số tiền (trước phí)” là TỔNG QUẸT trên bill; doanh số ghi = tổng quẹt − tiền hủy.
              {tienHuy > amount && <span className="ml-1 font-bold text-danger">Tiền hủy đang LỚN HƠN tổng quẹt — kiểm lại, hệ tạm giữ nguyên tổng.</span>}
            </div>
          </div>

          {/* Chọn loại thẻ (mặc định chuẩn SigMa) → phí đúng */}
          {cards.length > 0 && (
            <label className="flex flex-col gap-0.5">
              <span className={LABELC}>Loại thẻ</span>
              <div className="relative">
                <CreditCard className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <select className={`${INPUTC} pl-8`} value={cardId ?? ''} onChange={(e) => setCardId(Number(e.target.value))}>
                  {cards.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isPrimary ? ' (mặc định)' : ''}</option>)}
                </select>
              </div>
            </label>
          )}

          {/* Phí — dạng bảng ô CHỈ %: Thẻ | Số tiền (trước phí) | Phí bán % | Phí cài %. Routing ở đầu. */}
          <div className="rounded-lg border border-brand/15 bg-brand/5 p-2 space-y-1.5">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md bg-white/70 px-2 py-1"><div className="text-[9px] uppercase text-slate-400">Nhóm đại lý (phí bán)</div><b className="text-slate-800">{dealerRoomName ?? '⚠ không xác định'}</b></div>
              <div className="rounded-md bg-white/70 px-2 py-1"><div className="text-[9px] uppercase text-slate-400">CC NĐT (phí cài)</div>{investorRoomName ? <b className="text-slate-800">{investorRoomName}</b> : <span className="text-amber-600">chưa uỷ</span>}</div>
            </div>
            {/* CHỐNG GIẬT (Admin Demo 30/8): khi tính lại phí (debounce), GIỮ nguyên bảng — chỉ LÀM MỜ, KHÔNG đổi
                chiều cao (trước đây đổi "đang tính…"↔bảng gây reflow nhảy nút). Chưa có phí lần đầu → ô chừa sẵn. */}
            {feeRows.length > 0 ? (
              <div className={`overflow-x-auto rounded-md border border-line bg-white text-xs transition-opacity ${feeLoading ? 'opacity-50' : ''}`}>
                <div className={`${FEE_GRID} divide-x divide-line bg-slate-100 text-[9px] font-semibold uppercase text-slate-500`}>
                  <div className="px-1.5 py-1">Thẻ</div><div className="px-1.5 py-1 text-right">Tiền trước phí</div><div className="px-1.5 py-1 text-right text-success">Hoàn sau phí bán</div><div className="px-1.5 py-1 text-right">Bán %</div><div className="px-1.5 py-1 text-right">Cài %</div>
                </div>
                {feeRows.map((r, i) => (
                  <div key={i} className={`${FEE_GRID} divide-x divide-line border-t border-line`}>
                    <div className="truncate px-1.5 py-1 font-medium text-slate-700">{r.cardName}</div>
                    <div className="px-1.5 py-1 text-right tabular-nums text-slate-600">{fmtVnd(r.amount)}</div>
                    <div className="px-1.5 py-1 text-right tabular-nums font-bold text-success">{r.sell != null ? fmtVnd(r.amount - r.sell) : '—'}</div>
                    <div className="px-1.5 py-1 text-right tabular-nums text-emerald-600 font-bold">{feeCell(r.sell, r.sellMilli)}</div>
                    <div className="px-1.5 py-1 text-right tabular-nums text-slate-800">{feeCell(r.install, r.installMilli)}</div>
                  </div>
                ))}
                {feeRows.length > 1 && (
                  // Hàng TỔNG: chỉ TỔNG TIỀN + TỔNG HOÀN. KHÔNG hiển thị "tổng %" (cộng/bình quân % vô nghĩa,
                  // gây hiểu nhầm — Admin Demo 30/8). 2 ô % để trống.
                  <div className={`${FEE_GRID} divide-x divide-line border-t-2 border-line bg-slate-50 font-bold text-slate-800`}>
                    <div className="px-1.5 py-1">Tổng</div><div className="px-1.5 py-1 text-right tabular-nums text-slate-600">{fmtVnd(amount)}</div><div className="px-1.5 py-1 text-right tabular-nums text-success">{fees?.sell.resolved && fees.sell.amount != null ? fmtVnd(amount - fees.sell.amount) : '—'}</div><div className="px-1.5 py-1 text-right text-slate-300">·</div><div className="px-1.5 py-1 text-right text-slate-300">·</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex h-[3.25rem] items-center justify-center text-xs text-slate-400">{feeLoading ? 'đang tính phí…' : '—'}</div>
            )}
          </div>

          {/* Tách thẻ — thẻ chính = tổng − Σ thẻ khác (mặc định 0), chỉ điền khi lô lẫn thẻ khác */}
          {cards.length > 1 && (
            <div className="rounded-lg border border-line p-2 text-sm space-y-1.5">
              <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={splitOn} onChange={(e) => { setSplitOn(e.target.checked); if (!e.target.checked) setOthers([]); }} /> <CreditCard className="h-4 w-4 text-slate-400" /> <span>Lô có lẫn thẻ khác? <span className="text-slate-400">(tách số tiền theo thẻ)</span></span></label>
              {splitOn && (
                <div className="space-y-1.5">
                  {/* Sau khi "Xác nhận tách" → khoá field (nhìn rõ đã chốt); bấm "Sửa" để mở lại chỉnh (Admin Demo 30/8). */}
                  {others.map((o, i) => {
                    // Chỉ hiện thẻ CHƯA dùng: trừ thẻ chính (cardId) + thẻ đã chọn ở DÒNG KHÁC; giữ lựa chọn của
                    // chính dòng này (Admin Demo 30/8 "thêm thẻ khác chỉ còn danh sách thẻ còn lại").
                    const usedElsewhere = new Set(others.filter((_, j) => j !== i).map((x) => x.cardTypeId).filter(Boolean));
                    const avail = otherCards.filter((c) => !usedElsewhere.has(c.id));
                    return (
                    <div key={i} className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-center gap-2">
                      <select disabled={splitConfirmed} className={`${INPUTC} disabled:opacity-60`} value={o.cardTypeId || ''} onChange={(e) => { const v = [...others]; v[i] = { ...v[i], cardTypeId: Number(e.target.value) }; setOthers(v); }}>
                        <option value="">— thẻ khác —</option>
                        {avail.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      <input disabled={splitConfirmed} inputMode="numeric" placeholder="số tiền" className={`${INPUTC} text-right disabled:opacity-60`} value={o.amount ? fmtVnd(o.amount) : ''} onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '')) || 0; const v = [...others]; v[i] = { ...v[i], amount: n }; setOthers(v); }} />
                      <button disabled={splitConfirmed} className="rounded-lg p-1 text-danger hover:bg-danger/10 disabled:opacity-40" onClick={() => setOthers(others.filter((_, j) => j !== i))}><X className="h-4 w-4" /></button>
                    </div>
                    ); })}
                  {/* Ẩn "Thêm thẻ khác" khi đã dùng HẾT thẻ còn lại hoặc đã xác nhận (Admin Demo 30/8). */}
                  {!splitConfirmed && others.length < otherCards.length && <Button variant="soft" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOthers([...others, { cardTypeId: 0, amount: 0 }])}>Thêm thẻ khác</Button>}
                  {/* XÁC NHẬN số tiền tách — bảng thẻ chính + thẻ khác + tổng (đối chiếu = số bill) */}
                  <div className="rounded-md bg-appbg p-1.5 text-xs">
                    <div className="flex items-center justify-between py-0.5"><span className="text-slate-500">Thẻ chính · <b className="text-slate-700">{primaryCard?.name}</b></span><b className={primaryAmount < 0 ? 'text-danger' : 'text-slate-800'}>{fmtVnd(primaryAmount)}đ</b></div>
                    {others.filter((o) => o.cardTypeId).map((o, i) => <div key={i} className="flex items-center justify-between py-0.5"><span className="text-slate-500">{cards.find((c) => c.id === o.cardTypeId)?.name}</span><b className="text-slate-800">{fmtVnd(o.amount)}đ</b></div>)}
                    <div className="mt-0.5 flex items-center justify-between border-t border-line pt-1"><span className="text-slate-500">Tổng</span><b className={primaryAmount < 0 ? 'text-danger' : 'text-success'}>{fmtVnd(amount)}đ {primaryAmount < 0 ? '· vượt số bill!' : '✓ khớp bill'}{tienHuy > 0 ? ` · ghi nhận ${fmtVnd(tienGhi)}đ sau khi trừ hủy` : ''}</b></div>
                  </div>
                  {/* Nút XÁC NHẬN TÁCH (Admin Demo 30/8): bắt buộc bấm mới cho gửi; báo "Tách tiền thành công" */}
                  {splitConfirmed
                    ? <div className="flex items-center gap-2 rounded-md bg-success/10 px-2 py-1 text-xs font-semibold text-success"><CheckCircle2 className="h-4 w-4 shrink-0" /> <span className="min-w-0 flex-1">Tách tiền thành công · {others.filter((o) => o.cardTypeId).length + 1} thẻ, tổng khớp {fmtVnd(amount)}đ</span><Button variant="edit" size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setSplitConfirmed(false)}>Sửa</Button></div>
                    : <Button variant="confirm" size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} disabled={splitInvalid} onClick={() => setSplitConfirmed(true)} className="w-full">Xác nhận tách tiền</Button>}
                  {splitInvalid && <div className="text-xs text-danger">⚠ Chọn thẻ + nhập số tiền hợp lệ; tổng không được vượt số bill.</div>}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
      </div>

      {/* FOOTER nút GỬI — PIN đáy card (shrink-0), nội dung dài cuộn TRONG khung trên → nút Gửi LUÔN thấy đủ,
          không bị cắt đáy (Admin Demo 2/9). py-3 cho vùng bấm cao, thoáng. */}
      <div className="shrink-0 space-y-1.5 rounded-b-2xl border-t border-line bg-white/95 px-2.5 py-3 backdrop-blur-sm">
        {status.kind === 'ok' && <div className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="h-4 w-4" /> {status.msg}</div>}
        {status.kind === 'warn' && <div className="flex items-start gap-1.5 text-sm text-amber-600"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> {status.msg}</div>}
        {status.kind === 'err' && <div className="text-sm text-danger">Lỗi: {status.msg}</div>}
        {status.kind === 'dupe' && (
          // CẢNH BÁO GỬI TRÙNG NỔI BẬT (Admin Demo 1/9 "làm rõ cảnh báo chống rác"): bill ĐÃ GỬI → gửi lại = TRÙNG/rác
          // nhóm → banner đỏ-cam + nút xác nhận RÕ RÀNG (không phải nút mờ 1 dòng như cũ).
          <div className="rounded-lg border-2 border-amber-500 bg-amber-50 p-2 space-y-1.5">
            <div className="flex items-start gap-1.5 text-sm font-bold text-amber-700"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> ⚠ BILL NÀY ĐÃ GỬI TRƯỚC ĐÓ — gửi lại sẽ TRÙNG (rác nhóm + đếm đôi doanh số). {status.msg}</div>
            <Button variant="edit" size="sm" onClick={() => doSend(true)} className="w-full">Tôi hiểu, vẫn muốn GỬI LẠI (đánh dấu trùng)</Button>
          </div>
        )}
        {/* [Admin Demo 16/9 khuya] ĐÓNG LÔ 95 = rủi ro MẤT TIỀN THẬT (khách hoàn/hủy GD sau khi SigMa đã chuyển).
            Cảnh báo cũ 1 dòng chữ quá nhẹ → nay ĐÓNG DẤU TRÒN ĐỎ "SOS" cỡ lớn + ✕ gạch chéo vào thẻ review. */}
        {is95 && (
          <div className="flex items-center gap-3 rounded-xl border-2 border-danger bg-danger/10 p-3" data-testid="canh-bao-95">
            <Sos95Stamp size={128} note={false} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="text-base font-extrabold leading-tight text-danger">BILL ĐÓNG LÔ 95 — {chan95 ? 'DỪNG, KIỂM KỸ TRƯỚC KHI GỬI!' : 'KIỂM KỸ TRƯỚC KHI GỬI'}</div>
              <div className="text-xs font-semibold text-danger/90">Khách có thể HOÀN TIỀN / HỦY GIAO DỊCH sau khi SigMa đã chuyển tiền — gửi ẩu là mất tiền thật.</div>
              {/* [Admin Demo 17/9] MB/MBV: vẫn ĐÓNG DẤU cảnh báo cho người gửi thấy, nhưng KHÔNG bắt tick, gửi được ngay. */}
              {!chan95 && <div className="mt-1 rounded-lg border border-danger/30 bg-white/70 px-2 py-1.5 text-xs font-bold text-slate-600">{bankName || 'Ngân hàng này'} — <span className="text-success">không chặn gửi</span>, bấm Gửi bình thường sau khi đã kiểm.</div>}
              {chan95 && <label className="mt-1 flex items-center gap-2 rounded-lg border border-danger/40 bg-white/70 px-2 py-1.5 text-xs font-bold text-danger cursor-pointer">
                <input type="checkbox" checked={settle95Ack} onChange={(e) => setSettle95Ack(e.target.checked)} className="h-5 w-5 accent-danger" data-testid="ack-95" />
                Tôi đã kiểm tra rủi ro đóng lô 95 và xác nhận gửi.
              </label>}
            </div>
          </div>
        )}
        {/* [Audit 3/9 #9] LỆCH TID↔HKD → BẮT tick xác nhận đúng máy trước khi gửi (tiền định tuyến theo TID; sai máy = sai tiền). */}
        {hasTidHkdMismatch && (
          <div className="rounded-lg border-2 border-danger bg-danger/10 p-2 space-y-1">
            <div className="flex items-start gap-1.5 text-sm font-bold text-danger"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> LỆCH TID↔HKD — nghi tiền vào SAI MÁY. Sửa TID đúng máy (dropdown) HOẶC xác nhận đúng trước khi gửi!</div>
            <label className="flex items-center gap-2 text-xs font-semibold text-danger cursor-pointer">
              <input type="checkbox" checked={mismatchAck} onChange={(e) => setMismatchAck(e.target.checked)} className="h-4 w-4 accent-danger" />
              Tôi đã kiểm tra TID đúng máy và xác nhận gửi.
            </label>
          </div>
        )}
        {/* [Admin Demo 6/9] LỚP XÁC NHẬN CHUNG — MỌI cảnh báo OCR/logic (ngày lệch thứ tự, số lô, OCR mù, bug...) → phải
            TICK xác nhận (hoặc Bỏ qua kiểm lại) trước gửi. Chống nhân viên gửi vội. Không trùng 95/lệch-TID (đã có ack riêng). */}
        {needsWarnAck && !item.alreadySent && (
          <div className="rounded-lg border-2 border-danger bg-danger/10 p-2 space-y-1">
            <div className="flex items-start gap-1.5 text-sm font-bold text-danger"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> BILL CÓ CẢNH BÁO — kiểm lại kỹ ảnh + thông số trước khi gửi (dễ sai doanh số):</div>
            <ul className="pl-6 space-y-0.5">{warnReasons.map((w, i) => <li key={i} className="list-disc text-xs font-medium text-danger">{w}</li>)}</ul>
            <label className="flex items-center gap-2 text-xs font-semibold text-danger cursor-pointer">
              <input type="checkbox" checked={warnAck} onChange={(e) => setWarnAck(e.target.checked)} className="h-4 w-4 accent-danger" />
              Tôi đã kiểm lại và XÁC NHẬN gửi dù có cảnh báo (hoặc bấm "Bỏ qua" để kiểm sau).
            </label>
          </div>
        )}
        {status.kind !== 'ok' && status.kind !== 'warn' && (
          item.alreadySent ? (
            // [Admin Demo 2/9] Bill ĐÃ GỬI → KHÓA gửi (chống nhân đôi). Chưa sửa → chỉ nhắc "đã gửi, sửa nếu cần rồi Cập nhật
            //  hoặc Bỏ qua". CÓ SỬA → nút CẬP NHẬT (sửa tin cũ tại chỗ + note, KHÔNG post trùng).
            // [Admin Demo 7/9 — MƯỢN TID] Tích Mượn KHÔNG tính là edit ô → PHẢI cho nút CẬP NHẬT hiện khi borrowChecked.
            // Khi có MƯỢN → dùng doSend (đường /send có logic DI CHUYỂN phòng + borrowed_by); chỉ sửa ô → doUpdateSent cũ.
            (hasEdits || borrowChecked) && item.sentMessageId ? (
              <Button variant="confirm" icon={<RefreshCw className="h-4 w-4" />}
                disabled={sending || !tid.trim() || !(amount > 0) || (borrowChecked && !borrowRoomId)}
                onClick={() => (borrowChecked ? void doSend(false) : void doUpdateSent())} className="w-full">
                {sending ? 'Đang cập nhật…' : (borrowChecked && !borrowRoomId) ? 'Chọn đại lý MƯỢN trước khi cập nhật' : borrowChecked ? 'Cập nhật + CHUYỂN sang phòng đại lý MƯỢN' : 'Cập nhật bill đã gửi (không gửi lại)'}
              </Button>
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-700">
                Bill đã gửi (xem cảnh báo ở trên) — sửa ô hoặc tích <b>Mượn TID</b> rồi bấm <b>Cập nhật</b>, hoặc <b>Bỏ qua</b>.
              </div>
            )
          ) : (
            <>
              {/* [Admin Demo 5/9 — CA A] Nút Gửi xám PHẢI kèm LÝ DO + đường sửa (R198 cấm chặn câm). Hiện ngay TRÊN nút. */}
              {!canSend && sendBlockReason && (
                <div className="flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> <span>{sendBlockReason}</span>
                </div>
              )}
              <Button variant="confirm" icon={<Send className="h-4 w-4" />} disabled={!canSend || (borrowChecked && !borrowRoomId)} onClick={() => doSend(false)} className="w-full">
                {sending ? 'Đang gửi…' : (borrowChecked && !borrowRoomId) ? 'Chọn đại lý MƯỢN trước khi gửi' : splitOn && !splitConfirmed ? 'Xác nhận tách tiền trước khi gửi' : chan95 && !settle95Ack ? 'Tick xác nhận rủi ro đóng lô 95 trước khi gửi' : hasTidHkdMismatch && !mismatchAck ? 'Tick xác nhận đúng máy (lệch TID↔HKD) trước khi gửi' : (needsWarnAck && !warnAck) ? 'Tick xác nhận gửi dù có cảnh báo (hoặc Bỏ qua)' : borrowChecked ? 'Gửi vào phòng đại lý MƯỢN (+ cc NĐT chủ TID)' : 'Gửi vào nhóm đại lý + cc NĐT'}
              </Button>
            </>
          )
        )}
      </div>

      {/* [Admin Demo 11/9 — "màn đối chiếu cho phép sửa các trường luôn"] Ô có ✏ sửa TẠI CHỖ: cùng setter với form
          bên dưới (setTid/setDate/setTime/setLo/amt) — không có nguồn giá trị thứ hai, đóng phóng-to là form đã
          mang giá trị mới. HKD/Thẻ/Phí bán suy từ TID + engine → giữ chỉ-đọc. */}
      {zoomed && imgUrl && <ImageZoom src={imgUrl} xoayBanDau={xoay} dauDe={is95 ? <Sos95Stamp size={320} note={false} /> : null} onClose={() => setZoomed(false)} compare={{
        chinh: { label: 'HKD', value: hkdName ?? item.bill.agencyName ?? '' },
        phu: [{ label: 'TID', value: tid, sua: setTid }],
        hang: [
          { label: 'Ngày', value: date, sua: setDate },
          { label: 'Giờ', value: time, sua: setTime },
          { label: 'Số lô', value: lo, sua: setLo }
        ],
        tien: { label: 'Số tiền', value: amt.value, kieu: 'tien', sua: (v) => amt.setValue(v) },
        duoi: [
          // [Admin Demo 11/9] THẺ sửa được ngay trong khối (Visa/JCB/…): cùng setter setCardId → phí bán tính lại
          // y như đổi ở form ngoài. + Dòng ĐẠI LÝ để biết bill về nhà nào.
          {
            label: 'Thẻ', value: '',
            chon: cards.length > 0 ? {
              value: String(cardId ?? ''),
              options: cards.map((c) => ({ id: String(c.id), label: `${c.name}${c.isPrimary ? ' (mặc định)' : ''}` })),
              sua: (id) => setCardId(Number(id))
            } : undefined
          },
          { label: 'Phí bán', value: pctText(fees?.sell, amount) },
          { label: 'Đại lý', value: item.dealerRoomName ?? '—' },
          { label: 'NĐT (cc)', value: item.investorRoomName ?? '—' }
        ]
      }} />}
    </div>
  );
}

/** CARD REVIEW BILL CHUYỂN KHOẢN HOÀN TIỀN ĐẠI LÝ (Admin Demo 31/8) — hiện người gửi (SigMa)/người nhận/nội dung/số
 *  tiền + NHÓM ĐẠI LÝ KHỚP. Gửi CHỈ nhóm đại lý (KHÔNG NĐT). Chưa khớp chắc → cấm gửi, buộc chọn tay. */
// BILL QR BÁN HÀNG (Đợt 2, Admin Demo 5/9) — "Thanh toán thành công": HKD + Số tiền + Số giao dịch (ref). Tiền vào TK HKD
// = DOANH SỐ (như POS). Gửi → ghi doanh số (Transaction, phí cài máy=0 → NĐT về trọn amount) + HOÀN đại lý (amount −
// phí bán) vào NHÓM CHỌN từ dropdown. Layout CHUẨN 0.6.55: ảnh trái + khối cảnh báo/folder BÊN PHẢI ảnh + thông số
// full-width dưới. Server re-review + dedup theo ref (chống doanh số x2). Nút Gửi chặn CÂM phải BÁO RÕ LÝ DO (R198).
function QrBillReviewCard({ token, item, onSent, onPickAnother, onRescan, onRescanClaude, onRescanOpus, rescanBusy, stacked = false, folderName }: { token: string; item: QrReviewItem; onSent: (info: SentInfo) => void; onPickAnother?: () => void; onRescan?: () => void; onRescanClaude?: () => void; onRescanOpus?: () => void; rescanBusy?: boolean; stacked?: boolean; folderName?: string }): JSX.Element {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [dealers, setDealers] = useState<{ roomId: string; name: string }[]>([]);
  const [dealerId, setDealerId] = useState<string>(item.dealerRoomId ?? '');
  // [Admin Demo 5/9 phí bán tùy khách] `live` = item ĐÃ tính lại theo đại lý ĐANG chọn (server canonical). ĐỔI dropdown →
  // recompute phí bán/hoàn (KHÔNG để client bịa). Khởi tạo = item (đã tính cho folder-default lúc OCR).
  const [live, setLive] = useState<QrReviewItem>(item);
  const [recomputing, setRecomputing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [deduped, setDeduped] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // ĐỐI SOÁT "BÁO CÓ" DIGISTORE (BVBank) — BỔ TRỢ, KHÔNG chặn Gửi. Bấm "Check báo có" → so bill với báo-có ngân hàng.
  const [baoCo, setBaoCo] = useState<CheckBaoCoResult | null>(null);
  const [baoCoLoading, setBaoCoLoading] = useState(false);
  const [baoCoErr, setBaoCoErr] = useState<string | null>(null);
  // [Admin Demo 5/9] Tên người quẹt — auto-fill khi check báo-có KHỚP (unique); TRÙNG (ambiguous) → gõ tay/bấm ứng viên.
  // [Admin Demo 10/9] Ảnh THÔNG BÁO GIAO DỊCH THẺ có sẵn TÊN CHỦ THẺ → điền trước (vẫn sửa được), đỡ gõ tay + dùng
  // luôn làm khoá thu hẹp gợi ý báo-có.
  const [payerName, setPayerName] = useState(item.qr.payerName ?? '');
  // [Admin Demo 11/9] Bậc giá bán QR: false = TIỀN CHỜ (mặc định) · true = TIỀN NHANH. Chỉ hiện dropdown khi mã có bậc nhanh.
  const [qrGiaNhanh, setQrGiaNhanh] = useState(false);
  // [Admin Demo 6/9] TÊN KHÁCH HÀNG — chỉ HIỂN THỊ/ghi chú, KHÔNG wire backend/money (không đưa vào payload sendQr).
  const [sendAck, setSendAck] = useState(false); // xác nhận trước khi ghi doanh số (money-gate).
  // [Admin Demo 6/9 — GATE ĐỐI SOÁT BÁO CÓ] Chỉ cho gửi khi ĐỦ 4 ô XANH (ngày·giờ·số tiền·tên người quẹt khớp báo-có).
  // NGÀY/SỐ-TIỀN/TÊN phải đúng tuyệt đối. GIỜ: lệch ≤60s (drift thường) → cho SỬA giờ = giờ báo-có + XÁC NHẬN LẦN 2
  // (timeFixAck) mới tính xanh; lệch >60s = sai thật → CẤM gửi. timeEdit = giờ người dùng sửa cho khớp (null = chưa sửa).
  const [timeEdit, setTimeEdit] = useState<string | null>(null);
  const [timeFixAck, setTimeFixAck] = useState(false);
  // [Admin Demo 8/9] OCR KHÔNG đọc được TÊN HKD (app ngân hàng cắt cụt / ảnh mờ) → không khớp được mã QR → kẹt.
  // Cách gỡ: tra BÁO CÓ theo số GD (exact) hoặc SỐ TIỀN + NGÀY + GIỜ → gợi ý mã/HKD để NGƯỜI bấm chọn (không tự gán).
  // Chọn xong → tên này ĐÈ tên OCR ở mọi lời gọi (review lại phí, check báo có, gửi).
  const [hkdOverride, setHkdOverride] = useState<string | null>(null);
  // [Phản biện #3] Tính-lại-phí theo đại lý/HKD lỗi → cờ này CHẶN gửi (fail-closed), render đỏ trên thẻ.
  const [liveErr, setLiveErr] = useState<string | null>(null);
  // [Admin Demo 10/9 — ảnh THÔNG BÁO GIAO DỊCH THẺ] Ảnh KHÔNG in Số giao dịch → lấy `external_ref_no` của ĐÚNG dòng
  // báo-có đã khớp (ngân hàng là nguồn sự thật) làm ref: vừa mở được cổng gửi, vừa giữ nguyên khoá dedup (ref,tiền)
  // và giúp đối soát sau này ghép EXACT. CHỈ nhận khi người duyệt XÁC NHẬN (tuDienAck) — không tự gán câm.
  const [refOverride, setRefOverride] = useState<string | null>(null);
  const [sug, setSug] = useState<{ exact: boolean; weak: boolean; warning?: string; candidates: HkdSuggestion[] } | null>(null);
  const [sugLoading, setSugLoading] = useState(false);
  const [sugErr, setSugErr] = useState<string | null>(null);
  // [Admin Demo 8/9] Bill KHÔNG có tên HKD → TỰ ĐIỀN theo báo-có khớp (số tiền + ngày + giờ) rồi BẮT XÁC NHẬN mới
  // cho gửi — không im lặng dùng dữ liệu máy tự suy ra cho một giao dịch TIỀN.
  const [tuDien, setTuDien] = useState<{ hkd: string; payer: string | null; exact: boolean } | null>(null);
  const [tuDienAck, setTuDienAck] = useState(false);
  const daTuTra = useRef(false);
  /** Bill QR gửi lên server ở MỌI lời gọi — tên HKD lấy bản người duyệt đã chọn (nếu có), else bản OCR. */
  // [10/9 — phản biện] Gửi kèm ĐỦ trường của bill thông báo thẻ: server tính lại theo đại lý sẽ TRẢ NGUYÊN các
  // trường này, không làm rụng badge/tên chủ thẻ/ô "Từ (thẻ khách)" sau mỗi lần đổi đại lý hay chọn HKD.
  const qrIn = {
    hkdName: hkdOverride ?? item.qr.hkdName, ref: refOverride ?? item.qr.ref, amount: item.qr.amount, dateTime: item.qr.dateTime,
    fromCard: item.qr.fromCard, payerName: item.qr.payerName ?? null, noticeMerchant: item.qr.noticeMerchant ?? null, noticeOnly: item.noticeOnly === true,
    // Số GD này LẤY TỪ dòng báo-có (không đọc được trên ảnh) → server phải đòi thêm bằng chứng (tên người quẹt + giờ)
    // thay vì coi "ref khớp" là đã đối soát xong (nếu bấm nhầm dòng thì khớp-ref chỉ là tự xác nhận).
    refTuBaoCo: refOverride != null
  };
  /** Ảnh THÔNG BÁO GIAO DỊCH THẺ (không có tên HKD/số GD trên ảnh) → mọi lời nhắc/gate nói theo hướng "khớp báo-có". */
  const laThongBaoThe = item.noticeOnly === true;
  useEffect(() => { let a = true; setImgErr(false); setImgUrl(null); fetchAttachmentObjectUrl(ocrImageUrl(token)).then((u) => { if (a) setImgUrl(u); }).catch(() => { if (a) setImgErr(true); }); return () => { a = false; }; }, [token]);
  // [Admin Demo 7/9] danh sách đại lý PHẢI cập nhật nhóm khách MỚI tạo — trước đây fetch 1 lần lúc mount → nhóm tạo sau
  // không hiện. Nay: refetch khi MỞ dropdown (onMouseDown) + nút 🔄 → luôn thấy nhóm mới, không cần vào lại màn.
  const [dealersReloading, setDealersReloading] = useState(false);
  const reloadDealers = (): Promise<void> => { setDealersReloading(true); return fetchClassifyOptions().then((r) => { if (r.ok) setDealers(r.data.dealers); }).finally(() => setDealersReloading(false)); };
  useEffect(() => { void reloadDealers(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // ĐỔI đại lý → server tính lại phí bán/hoàn theo giá bán của đại lý đó. dealerId == item.dealerRoomId (khởi tạo) → giữ item.
  useEffect(() => {
    if (sent) return;
    // Chưa đổi gì so với lúc OCR (đại lý mặc định + tên HKD gốc) → dùng lại item, khỏi gọi server.
    if (!hkdOverride && !refOverride && (!dealerId || dealerId === item.dealerRoomId)) { setLive(item); return; }
    let a = true; setRecomputing(true);
    // dealerId rỗng vẫn gọi được (server nhận null) — cần thiết khi mới CHỌN TÊN HKD mà chưa chọn đại lý:
    // server resolve lại MÃ QR theo tên → gỡ chặn "Không khớp MÃ QR theo tên HKD".
    // [Admin Demo 11/9] token ảnh đi kèm → server giữ cờ "ĐÃ GỬI theo ẢNH" (setLive thay cả item, không token là rơi cờ).
    setLiveErr(null);
    qrReviewForDealer({ qr: qrIn, dealerId, token })
      .then((r) => {
        if (!a) return;
        if (r.ok && r.data.item) { setLive(r.data.item); return; }
        // [Phản biện #3 — R198] Tính lại phí LỖI mà im lặng → người duyệt xác nhận SỐ CŨ của đại lý cũ (đo lệch
        // 152.250đ). Nay: báo đỏ + CHẶN gửi tới khi tính lại thành công.
        setLiveErr(!r.ok ? r.message : 'Server không trả kết quả tính lại.');
        setSendAck(false);
      })
      .catch((e) => { if (a) { setLiveErr('Lỗi tính lại phí: ' + (e instanceof Error ? e.message : String(e))); setSendAck(false); } })
      .finally(() => { if (a) setRecomputing(false); });
    return () => { a = false; };
    // eslint-disable-next-line
  }, [dealerId, hkdOverride, refOverride]);
  const money = (n: number | null | undefined): string => (n != null ? n.toLocaleString('vi-VN') + 'đ' : '—');
  const pct = (m: number | null): string => (m != null ? (m / 1000).toFixed(3).replace(/\.?0+$/, '') + '%' : '—');
  // Lý do CHẶN gửi (R198 — không câm): ưu tiên hiển thị nguyên nhân cụ thể để người dùng biết cách xử.
  // [Admin Demo 7/9] KHÔNG lặp "đã gửi" ở đây — đã hiện 1 lần (đỏ) qua live.warnings. blockReason chỉ còn lý do KHÁC.
  // Cảnh báo "HAI LẦN ĐỌC LỆCH NHAU" do tầng OCR đẩy lên (qrWarningsVi) → bật lối đọc lại bằng Opus.
  const coLechDoc = (live.warnings ?? []).some((w) => w.includes('HAI LẦN ĐỌC LỆCH'));
  const blockReason = !live.qr.ref ? (laThongBaoThe
      ? '⚠ Chưa có Số giao dịch — bấm "Tìm mã QR từ báo có" rồi chọn đúng dòng (ảnh thông báo thẻ không in số này).'
      : '⚠ OCR không đọc được Số giao dịch (ref) — không dedup được, không gửi. Kiểm tay/đọc lại.')
    : live.tidId == null ? '⚠ Không khớp MÃ QR theo tên HKD — kiểm tay (tạo mã QR / sửa tên).'
    : live.sellFeeMilli == null ? '⚠ Chưa cấu hình phí QR cho mã này (đối tác/mã chưa có giá bán) — đặt giá QR trước khi gửi.'
    : !dealerId ? '⚠ Chọn ĐẠI LÝ (dropdown) để hoàn tiền.'
    : null;
  // [Admin Demo 5/9] Cảnh báo TÊN người quẹt: chưa điền HOẶC khác báo-có (khi đã check khớp) → "xem lại" (cảnh báo, không cứng chặn).
  // [Admin Demo 7/9] So tên KHÔNG phân biệt hoa/thường + CÓ/KHÔNG dấu — GƯƠNG y hệt normalizePayerName server (digistore-
  // reconcile.ts) để tick client KHỚP đúng cổng server (khỏi xanh-đây-chặn-kia): đ→d, bỏ dấu (NFD + xoá dấu kết hợp),
  // hoa hoá, ký tự lạ→space, gộp space. "KT Demo"="KETOAN"="tuyet".
  const norm = (s: string): string => s
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const matchName = baoCo?.status === 'MATCHED' ? ((baoCo.candidates ?? [])[0]?.payerName ?? null) : null;
  const nameWarn = !payerName.trim()
    ? '⚠ Chưa điền TÊN người quẹt — xem lại (tự điền khi Check báo có khớp, hoặc gõ tay).'
    : (matchName && norm(payerName) !== norm(matchName))
    ? `⚠ Tên nhập KHÁC báo-có ngân hàng (BC: "${matchName}") — xem lại.`
    : null;
  // ── ĐỐI SOÁT TỪNG Ô vs BÁO CÓ (Admin Demo 6/9) ─────────────────────────────────────────────────────────────
  // Tách ngày/giờ bill từ dateTime OCR. Bản ghi báo-có so sánh: MATCHED→match; AMBIGUOUS→ứng viên ĐANG CHỌN (theo tên).
  const dtQ = /(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+([\d:]+))?/.exec(live.qr.dateTime ?? '');
  const billDate = dtQ?.[1] ? dtQ[1].split('/').map((x, i) => (i < 2 ? x.padStart(2, '0') : x)).join('/') : '';
  const billTimeRaw = dtQ?.[2] ?? '';
  const hmsToSec = (t: string): number | null => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((t || '').trim()); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (m[3] ? +m[3] : 0) : null; };
  const atToDmyHms = (ms: number): { date: string; time: string } => { const d = new Date(ms + 7 * 3600_000); const p = (n: number): string => String(n).padStart(2, '0'); return { date: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` }; };
  // [Admin Demo 6/9 — FIX GỐC] Server /check-baoco trả bản ghi khớp trong `candidates` (KHÔNG có field `match`) → MATCHED
  // PHẢI lấy candidates[0] (trước đọc baoCo.match = undefined → không ô nào xanh → kẹt). CHỈ trạng thái MATCHED ("Đã báo
  // có — khớp") mới HỢP LỆ gửi; trạng thái khác (không thấy / mơ hồ / trùng / không check được) = KHÔNG gửi (baoCoBlock hiện đúng trạng thái).
  const cands = baoCo?.candidates ?? [];
  const matched = baoCo?.status === 'MATCHED';
  const bcRec = matched ? (cands[0] ?? null) : (baoCo?.status === 'AMBIGUOUS' ? (cands.find((c) => !!c.payerName && norm(payerName) === norm(c.payerName)) ?? null) : null);
  const bcHas = !!bcRec;
  const bank = bcRec ? atToDmyHms(bcRec.atMs) : null;
  const bankTimeSec = bank ? hmsToSec(bank.time) : null;
  const effTime = timeEdit ?? billTimeRaw;                 // giờ hiệu lực = giờ đã sửa (nếu có) else giờ OCR
  const effTimeSec = hmsToSec(effTime);
  const timeDiffSec = bcHas && effTimeSec != null && bankTimeSec != null ? Math.abs(effTimeSec - bankTimeSec) : null;
  const timeExact = timeDiffSec === 0;
  const TIME_TOL_SEC = 120;
  const timeWithinTol = timeDiffSec != null && timeDiffSec > 0 && timeDiffSec <= TIME_TOL_SEC;
  const timeOverTol = timeDiffSec != null && timeDiffSec > TIME_TOL_SEC;
  // Tick: TIỀN + TÊN = GATE (đúng tuyệt đối). NGÀY/GIỜ = thông tin (quẹt vs quyết-toán lệch là bình thường → 'warn' vàng, KHÔNG chặn khi ngân hàng đã khớp).
  const amountChk: 'ok' | 'bad' | null = !bcHas ? null : (live.qr.amount === bcRec!.amount ? 'ok' : 'bad');
  const nameChk: 'ok' | 'bad' | null = !bcHas ? null : (!!payerName.trim() && !!bcRec!.payerName && norm(payerName) === norm(bcRec!.payerName) ? 'ok' : 'bad');
  const dateChk: 'ok' | 'warn' | null = !bcHas ? null : (bank && billDate === bank.date ? 'ok' : 'warn');
  const timeChk: 'ok' | 'warn' | null = !bcHas ? null : (timeExact || timeWithinTol ? 'ok' : 'warn');
  const amountOk = amountChk === 'ok', nameOk = nameChk === 'ok';
  // HỢP LỆ GỬI = MATCHED + tiền khớp + tên khớp. Ngày/giờ chỉ cảnh báo (ngân hàng đã xác nhận đúng GD).
  const allGreen = matched && amountOk && nameOk;
  // LỖI CỤ THỂ từng ô (CẤM chung chung — Admin Demo 6/9): mỗi ô lệch → 1 dòng nêu rõ bill vs báo-có.
  const fieldErrors: string[] = [];
  if (bcHas) {
    if (amountChk === 'bad') fieldErrors.push(`🔴 SỐ TIỀN LỆCH: bill ${money(live.qr.amount)} ≠ báo có ${money(bcRec!.amount)} — KHÔNG gửi.`);
    if (nameChk === 'bad') fieldErrors.push(`🔴 TÊN NGƯỜI QUẸT chưa khớp báo có ("${bcRec!.payerName ?? '—'}") — chọn/điền đúng tên (chip gợi ý).`);
    if (dateChk === 'warn') fieldErrors.push(`🟡 Ngày bill ${billDate || '—'} khác ngày báo-có ${bank?.date ?? '—'} (quẹt vs quyết toán) — chỉ cảnh báo, KHÔNG chặn.`);
    if (timeChk === 'warn') fieldErrors.push(`🟡 Giờ bill ${effTime || '—'} lệch giờ báo-có ${bank?.time ?? '—'}${timeDiffSec != null ? ` (${timeDiffSec}s)` : ''} — chỉ cảnh báo, KHÔNG chặn.`);
  }
  const nameMissing = !payerName.trim();
  // GATE GỬI (Admin Demo 6/9): PHẢI đủ 4 ô XANH (số tiền·ngày·giờ·tên) + tick xác nhận cuối. Chưa Check báo có (bcHas=false)
  // → chưa có ô xanh → CẤM gửi. NGÀY/TIỀN/TÊN đúng tuyệt đối; GIỜ lệch ≤60s cho sửa+xác-nhận-lần-2, >60s cấm.
  const sendable = !live.blocked && !!dealerId && !sent && !recomputing && !liveErr && allGreen && sendAck && (!tuDien || tuDienAck);
  async function doSend(): Promise<void> {
    if (!dealerId) { setErr('Chọn đại lý để hoàn tiền.'); return; }
    setSending(true); setErr(null);
    try {
      const r = await sendQr({ token, qr: qrIn, dealerId, payerName: payerName.trim() || null, giaNhanh: qrGiaNhanh });
      if (!r.ok) { setErr(r.message); return; }
      if (r.data.refund && r.data.refund.deduped) setDeduped(true);
      setSent(true);
      onSent({ dealer: dealers.find((d) => d.roomId === dealerId)?.name ?? null, investor: null });
    } catch (e) {
      setErr('Lỗi khi gửi (giữ review, thử lại): ' + (e instanceof Error ? e.message : String(e)));
    } finally { setSending(false); }
  }
  // [Admin Demo 8/9] TRA GỢI Ý mã QR/HKD từ BÁO CÓ khi OCR không ra tên: khớp theo Số GD (chắc) hoặc số tiền + ngày +
  // giờ. Trả nhiều = mơ hồ → người duyệt bấm chọn. R198: lỗi/không có dữ liệu mới → nói rõ, không im.
  async function doSuggestHkd(): Promise<void> {
    setSugLoading(true); setSugErr(null); setSug(null);
    try {
      const r = await suggestHkd({ amount: item.qr.amount, dateTime: item.qr.dateTime, ref: item.qr.ref, payerName: item.qr.payerName ?? payerName ?? null });
      if (!r.ok) { setSugErr(r.message); return; }
      setSug(r.data);
      if (r.data.candidates.length === 0) setSugErr('Không tìm thấy giao dịch báo-có nào khớp số tiền + ngày giờ này. Thử "Tải lại giao dịch" ở màn Báo cáo QR rồi tra lại, hoặc điền tên HKD tay.');
    } catch (e) {
      setSugErr('Lỗi khi tra gợi ý: ' + (e instanceof Error ? e.message : String(e)));
    } finally { setSugLoading(false); }
  }

  // TỰ TRA + TỰ ĐIỀN (1 lần/thẻ): thiếu tên HKD hoặc chưa khớp mã → hỏi báo-có ngay, khớp DUY NHẤT thì điền sẵn
  // tên HKD + tên người quẹt, gắn cờ chờ XÁC NHẬN (không tự gửi).
  useEffect(() => {
    if (sent || daTuTra.current) return;
    if (live.qr.hkdName && live.tidId != null) return; // đủ dữ liệu rồi, không cần tra
    daTuTra.current = true;
    void (async () => {
      setSugLoading(true);
      try {
        const r = await suggestHkd({ amount: item.qr.amount, dateTime: item.qr.dateTime, ref: item.qr.ref, payerName: item.qr.payerName ?? null });
        if (!r.ok) { setSugErr(r.message); return; }
        setSug(r.data);
        const dsCoTen = r.data.candidates.filter((c) => !!c.hkdName);
        if (dsCoTen.length === 1) {
          const c = dsCoTen[0];
          setHkdOverride(c.hkdName!);
          if (c.payerName) setPayerName(c.payerName);
          // [Phản biện #3 — ref DÍNH] Ứng viên mới KHÔNG có số GD thì phải XOÁ ref của ứng viên cũ (trước đây giữ
          // nguyên → gửi sai Số GD của dòng đã bỏ chọn, gate server còn tự xác nhận theo ref sai đó).
          if (!item.qr.ref) setRefOverride(c.externalRefNo ?? null);
          setTuDien({ hkd: c.hkdName!, payer: c.payerName ?? null, exact: r.data.exact });
          setTuDienAck(false); setSendAck(false);
        }
      } catch { /* im lặng: người duyệt vẫn có nút tra tay */ } finally { setSugLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.tidId, live.qr.hkdName, sent]);

  // CHECK BÁO CÓ (Digistore BVBank) — gửi hkdName/amount/dateTime/payerName của bill QR đang review, nhận trạng thái
  // đối soát. R198: lỗi KHÔNG nuốt câm — hiện lý do; check là BỔ TRỢ nên KHÔNG đụng nút Gửi.
  async function doCheckBaoCo(): Promise<void> {
    setBaoCoLoading(true); setBaoCoErr(null); setBaoCo(null);
    try {
      // [10/9 — phản biện] TRƯỚC ĐÂY gửi `live.qr.fromCard` = MÔ TẢ THẺ ("VIB ••••9742") vào ô tên người quẹt →
      // server so tên luôn trượt → trả AMBIGUOUS → cổng 4-ô-xanh không bao giờ đủ → KHÔNG GỬI ĐƯỢC bill. Phải gửi
      // ĐÚNG tên người quẹt đang hiển thị (ô người duyệt sửa được), fallback tên chủ thẻ đọc từ ảnh thông báo thẻ.
      const tenQuet = payerName.trim() || live.qr.payerName || null;
      const r = await checkBaoCo({ hkdName: live.hkdNameMatched ?? qrIn.hkdName, amount: live.qr.amount, dateTime: live.qr.dateTime, payerName: tenQuet });
      if (!r.ok) { setBaoCoErr(r.message); return; }
      setBaoCo(r.data);
      // Khớp unique (ngày+giờ+số tiền) → TỰ ĐIỀN tên người quẹt; ambiguous để người xem gõ/bấm ứng viên.
      // [FIX 6/9] MATCHED → bản ghi khớp ở candidates[0] (server KHÔNG trả field match) → tự điền tên người quẹt.
      if (r.data.status === 'MATCHED' && r.data.candidates?.[0]?.payerName) setPayerName(r.data.candidates[0].payerName);
      setSendAck(false); setTimeEdit(null); setTimeFixAck(false); // check lại → xác nhận lại + reset sửa-giờ.
    } catch (e) {
      setBaoCoErr('Lỗi khi check báo có: ' + (e instanceof Error ? e.message : String(e)));
    } finally { setBaoCoLoading(false); }
  }
  // Giờ:phút ngày/tháng (HCM) của 1 epoch ms — hiển thị GD báo-có (khớp / ứng viên).
  const fmtAt = (ms: number): string => { const d = new Date(ms + 7 * 3600_000); const p = (n: number): string => String(n).padStart(2, '0'); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`; };
  // ── [Admin Demo 8/9] KHỐI GỢI Ý MÃ QR/HKD khi OCR không đọc được tên ──────────────────────────────────────
  // Hiện khi: OCR không ra tên HKD, HOẶC có tên nhưng server KHÔNG khớp được mã QR (tidId null) → nếu không có lối
  // này thì bill đứng chết. Gợi ý lấy từ BÁO CÓ ngân hàng (đúng số tiền + ngày + giờ) nên đối chiếu được ngay.
  const canSuggestHkd = !sent && (!live.qr.hkdName || live.tidId == null);
  // BĂNG "ĐÃ TỰ ĐIỀN — CẦN XÁC NHẬN": nêu rõ điền cái gì, căn cứ nào; chưa bấm xác nhận thì nút Gửi khoá.
  const tuDienBlock = tuDien && !sent ? (
    <div data-testid="qr-tudien" className={`rounded-lg border px-2.5 py-2 text-xs ${tuDienAck ? 'border-emerald-300 bg-emerald-50' : 'border-amber-400 bg-amber-50'}`}>
      <div className={`flex items-start gap-1.5 font-bold ${tuDienAck ? 'text-emerald-700' : 'text-amber-800'}`}>
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {tuDienAck ? 'Đã xác nhận thông tin tự điền' : 'ĐÃ TỰ ĐIỀN theo báo-có — kiểm rồi XÁC NHẬN mới gửi được'}
      </div>
      <div className="mt-1 pl-5 space-y-0.5 text-slate-700">
        <div>Căn cứ: {tuDien.exact ? <b>số giao dịch khớp</b> : <>số tiền <b>{money(live.qr.amount)}</b> + ngày <b>{billDate || '—'}</b> + giờ khớp báo-có</>}</div>
        <div>HKD: <b>{tuDien.hkd}</b>{tuDien.payer ? <> · người quẹt: <b>{tuDien.payer}</b></> : null}</div>
        {refOverride && <div>Số giao dịch lấy từ báo-có: <b className="tabular-nums">{refOverride}</b> <span className="text-slate-500">(ảnh không in số này)</span></div>}
      </div>
      {!tuDienAck && (
        <div className="mt-1.5 flex flex-wrap gap-2 pl-5">
          <Button variant="confirm" size="sm" data-testid="qr-tudien-ack" onClick={() => setTuDienAck(true)}>Xác nhận đúng</Button>
          <Button variant="soft" size="sm" onClick={() => { setTuDien(null); setHkdOverride(null); setRefOverride(null); setPayerName(''); setBaoCo(null); setSendAck(false); }}>Bỏ, tự chọn lại</Button>
        </div>
      )}
    </div>
  ) : null;

  const hkdSuggestBlock = canSuggestHkd ? (
    <div data-testid="qr-hkd-suggest" className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs">
      <div className="flex items-start gap-1.5 font-semibold text-amber-800">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {laThongBaoThe ? 'THÔNG BÁO GIAO DỊCH THẺ — ảnh không in tên HKD/Số giao dịch' : !live.qr.hkdName ? 'OCR không đọc được TÊN HKD trên bill' : 'Tên HKD đọc được chưa khớp mã QR nào'} — tra theo BÁO CÓ (số tiền + ngày + giờ{laThongBaoThe ? ' + tên chủ thẻ' : ''}):
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button type="button" data-testid="qr-suggest-btn" onClick={() => void doSuggestHkd()} disabled={sugLoading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 bg-white px-2.5 py-1 font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60">
          {sugLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Tìm mã QR từ báo có
        </button>
        {hkdOverride && (
          <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1 font-semibold text-emerald-700">
            ✓ Đã chọn: {hkdOverride}
            <button type="button" onClick={() => { setHkdOverride(null); setRefOverride(null); setTuDien(null); setTuDienAck(false); setBaoCo(null); setSendAck(false); }} className="ml-1 text-emerald-600 hover:text-danger" title="Bỏ chọn">✕</button>
          </span>
        )}
      </div>
      {sugErr && <div className="mt-1.5 text-[11px] font-medium text-danger">{sugErr}</div>}
      {sug?.warning && <div className="mt-1.5 text-[11px] font-medium text-amber-700">⚠ {sug.warning}</div>}
      {sug && sug.candidates.length > 0 && (
        <div className="mt-1.5 space-y-1">
          <div className="text-[11px] font-medium text-amber-700">
            {sug.exact ? '🟢 Khớp theo SỐ GIAO DỊCH (chắc chắn)' : sug.weak ? '🟡 Bill thiếu giờ → chỉ khớp số tiền trong 24h — soi kỹ' : '🟡 Khớp theo số tiền + ngày giờ — chọn đúng dòng'}
          </div>
          {sug.candidates.map((c) => {
            const picked = !!c.hkdName && hkdOverride === c.hkdName;
            return (
              <button key={c.billId} type="button" data-testid="qr-suggest-item" disabled={!c.hkdName}
                onClick={() => {
                  if (!c.hkdName) return;
                  setHkdOverride(c.hkdName);
                  if (c.payerName) setPayerName(c.payerName);
                  // [10/9 + phản biện #3] Ảnh thông báo thẻ không in Số GD → nhận số GD của ĐÚNG dòng vừa chọn;
                  // dòng mới KHÔNG có số GD thì XOÁ ref cũ (không mang ref của dòng đã bỏ). Đổi ứng viên = mọi xác
                  // nhận cũ vô hiệu (tuDienAck cũng hạ — trước đây băng xanh "đã xác nhận" của ứng viên CŨ còn nguyên).
                  if (!item.qr.ref) setRefOverride(c.externalRefNo ?? null);
                  setTuDienAck(false);
                  setBaoCo(null); setSendAck(false);
                }}
                className={`flex w-full flex-col gap-0.5 rounded border px-2 py-1 text-left transition ${picked ? 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-300' : 'border-amber-200 bg-white/70 hover:bg-amber-100'} disabled:opacity-50`}>
                {/* Cột review hẹp → xếp DỌC: tên HKD 1 dòng (không ngắt giữa chữ), số liệu xuống dòng dưới. */}
                <span className="w-full truncate font-semibold text-slate-700">{picked ? '✓ ' : ''}{c.hkdName || '(báo-có không ghi tên HKD)'}</span>
                <span className="w-full tabular-nums text-slate-500">
                  {money(c.amount)}{c.atMs != null ? ` · ${fmtAt(c.atMs)}` : ''}{c.payerName ? ` · quẹt: ${c.payerName}` : ''}
                </span>
              </button>
            );
          })}
          <div className="pt-0.5 text-[11px] text-amber-700">Bấm chọn → hệ thống khớp lại mã QR + phí theo tên này, rồi bấm "Check báo có".</div>
        </div>
      )}
    </div>
  ) : null;

  // KHỐI KẾT QUẢ báo-có — đặt BÊN PHẢI ẢNH (trong warnBlock) như cảnh báo bill. 5 trạng thái + AMBIGUOUS liệt kê hết
  // ứng viên (tên người quẹt + giờ + mã hóa đơn) để người xem đối chiếu chọn. CANNOT_CHECK = xám TRUNG THỰC (không đỏ/xanh).
  const baoCoBlock = (baoCoLoading || baoCoErr || baoCo) ? (
    <div data-testid="qr-baoco-result">
      {baoCoLoading && <div className="flex items-center gap-1.5 rounded-lg border border-line bg-white/60 px-2.5 py-1.5 text-xs font-medium text-slate-500"><Loader2 className="h-4 w-4 shrink-0 animate-spin" /> Đang check báo có ngân hàng…</div>}
      {baoCoErr && <div className="flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs font-medium text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {baoCoErr}</div>}
      {baoCo?.status === 'MATCHED' && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-xs">
          <div className="flex items-start gap-1.5 font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4 shrink-0" /> 🟢 Đã báo có — khớp ngân hàng</div>
          {baoCo.candidates?.[0]?.payerName && <div className="mt-1 pl-5 text-emerald-800">Người quẹt: <b>{baoCo.candidates[0].payerName}</b>{baoCo.candidates[0].atMs ? <span className="text-emerald-600"> · {fmtAt(baoCo.candidates[0].atMs)}</span> : null}</div>}
        </div>
      )}
      {baoCo?.status === 'NOT_FOUND' && (
        <div className="flex items-start gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs font-semibold text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> 🔴 KHÔNG tìm thấy trong báo có ngân hàng — kiểm tay.</div>
      )}
      {baoCo?.status === 'DUPLICATE' && (
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-700"><AlertTriangle className="h-4 w-4 shrink-0" /> 🟡 Giao dịch này đã đối soát trước đó.</div>
      )}
      {baoCo?.status === 'AMBIGUOUS' && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs">
          <div className="flex items-start gap-1.5 font-semibold text-amber-800"><AlertTriangle className="h-4 w-4 shrink-0" /> ⚠ Nhiều giao dịch trùng số tiền + giờ, tên lệch — chọn đúng:</div>
          <div className="mt-1.5 space-y-1">
            {(baoCo.candidates ?? []).map((c, i) => {
              const picked = !!c.payerName && payerName.trim().toUpperCase() === c.payerName.trim().toUpperCase();
              return (
                <button key={i} type="button" onClick={() => { setPayerName(c.payerName ?? ''); setSendAck(false); }}
                  className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left transition ${picked ? 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-300' : 'border-amber-200 bg-white/70 hover:bg-amber-100'}`}>
                  <span className="font-medium text-slate-700 break-words">{picked ? '✓ ' : ''}{c.payerName || '(không tên)'}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">{fmtAt(c.atMs)} · <span className="font-mono">{c.billId}</span></span>
                </button>
              );
            })}
            <div className="pt-0.5 text-[11px] text-amber-700">Bấm chọn tên đúng (hoặc gõ tay ở ô "Tên người quẹt" dưới).</div>
          </div>
        </div>
      )}
      {baoCo?.status === 'CANNOT_CHECK' && (
        <div className="flex items-start gap-1.5 rounded-lg border border-line bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-500"><AlertTriangle className="h-4 w-4 shrink-0" /> ⚠ Không check được báo có: {baoCo.message ?? 'không rõ lý do'}</div>
      )}
    </div>
  ) : null;
  const Field = ({ label, value, strong, green, check }: { label: string; value: string; strong?: boolean; green?: boolean; check?: 'ok' | 'bad' | 'warn' | null }): JSX.Element => (
    <div className={`rounded-lg border px-2.5 py-1.5 ${check === 'ok' ? 'border-emerald-400 bg-emerald-50' : check === 'bad' ? 'border-danger bg-danger/10' : check === 'warn' ? 'border-amber-400 bg-amber-50' : 'border-line bg-white/60'}`}>
      <div className="flex items-center justify-between gap-1"><span className="text-[10px] uppercase tracking-wide text-slate-400">{label}</span>{check === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : check === 'bad' ? <X className="h-3.5 w-3.5 shrink-0 text-danger" /> : check === 'warn' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" /> : null}</div>
      <div className={`text-sm break-words ${check === 'ok' ? 'text-emerald-700 font-bold' : check === 'bad' ? 'text-danger font-bold' : green ? 'text-emerald-600 font-bold' : strong ? 'font-bold text-brand-deep' : 'font-semibold text-slate-700'}`}>{value}</div>
    </div>
  );
  // Khối cảnh báo BÊN PHẢI ảnh (chuẩn 0.6.55): folder default + warnings + badge "đã gửi". besideQr chỉ khi stacked.
  const warnBlock = (
    <div className="space-y-1.5">
      {folderName && <div className="rounded-lg border border-brand/30 bg-brand-tint px-2.5 py-1.5 text-[11px] text-slate-500">📁 Folder: <span className="font-semibold text-brand-deep">{folderName}</span>{item.dealerRoomName ? <> · mặc định ĐL <span className="font-semibold">{item.dealerRoomName}</span></> : ''}</div>}
      {/* [Admin Demo 7/9] "đã gửi" CHỈ hiện 1 LẦN (đỏ thô) qua warnings.map dưới — server đẩy 1 warning duy nhất. BỎ badge
          amber trùng + BỎ blockReason alreadySent (xem dưới) → hết lặp 3 lần. */}
      {live.warnings.map((w, i) => <div key={i} className="flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs font-medium text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {w}</div>)}
      {live.isWeekend && <div className="rounded-lg border border-line bg-white/60 px-2.5 py-1 text-[11px] text-slate-500">🗓️ Cuối tuần — giá MUA áp cuối tuần (phí bán không đổi).</div>}
    </div>
  );
  // [Admin Demo 6/9] KHỐI ĐỐI SOÁT — đặt NGAY DƯỚI nút "Check báo có" (khỏi lăn màn): lỗi CỤ THỂ từng ô, tiền lệch đỏ nặng,
  // giờ lệch ≤60s cho "Sửa giờ = báo có" + xác nhận lần 2; đủ 4 ô xanh → cho gửi.
  const reconBlock = bcHas ? (
    <div className="space-y-1.5">
      {allGreen ? (
        <div className="flex items-start gap-1.5 rounded-lg border-2 border-emerald-400 bg-emerald-50 px-2.5 py-1.5 text-xs font-bold text-emerald-700"><CheckCircle2 className="h-4 w-4 shrink-0" /> ✅ Đã báo có — KHỚP ngân hàng + số tiền + tên người quẹt khớp → ĐƯỢC GỬI. (ngày/giờ chỉ tham chiếu)</div>
      ) : (
        <div className={`rounded-lg border-2 px-2.5 py-1.5 text-xs ${(amountChk === 'bad' || !matched) ? 'border-danger bg-danger/15' : 'border-amber-400 bg-amber-50'}`}>
          <div className={`flex items-start gap-1.5 font-bold ${(amountChk === 'bad' || !matched) ? 'text-danger' : 'text-amber-800'}`}><AlertTriangle className="h-4 w-4 shrink-0" /> {!matched ? '⛔ Báo-có MƠ HỒ / chưa khớp DUY NHẤT — CHƯA hợp lệ gửi. Chỉ khi ra "Đã báo có — khớp" mới gửi được.' : amountChk === 'bad' ? '⛔ SỐ TIỀN KHÔNG KHỚP BÁO CÓ — KHÔNG ĐƯỢC GỬI' : 'Đã báo có khớp — cần khớp nốt TÊN người quẹt để gửi:'}</div>
          {fieldErrors.length > 0 && <ul className="mt-1 space-y-0.5 pl-5">{fieldErrors.map((e, i) => <li key={i} className="list-disc font-semibold text-slate-700">{e}</li>)}</ul>}
        </div>
      )}
      {/* [Admin Demo 6/9] TRÙNG SỐ TIỀN nhưng SAI GIỜ (chỉ khi CHƯA MATCHED = mơ hồ nhiều GD) → cảnh báo NẶNG + buộc chọn đúng tên. */}
      {!matched && amountOk && timeChk !== 'ok' && (
        <div className="rounded-lg border-2 border-danger bg-danger/15 px-2.5 py-1.5 text-xs font-bold text-danger">
          <div className="flex items-start gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0" /> ⛔ TRÙNG SỐ TIỀN nhưng SAI/CHƯA khớp GIỜ — coi chừng NHẦM giao dịch của người khác cùng số tiền.</div>
          <div className="mt-0.5 pl-5 font-semibold">Phải CHỌN ĐÚNG tên đúng người (chip gợi ý báo-có ở ô Tên người quẹt).</div>
        </div>
      )}
      {timeWithinTol && bank && (
        <div className="rounded-lg border border-amber-400 bg-amber-50 px-2.5 py-1.5 text-xs">
          <div className="font-semibold text-amber-800">Giờ bill <b>{effTime}</b> lệch <b>{timeDiffSec}s</b> so báo có <b>{bank.time}</b> (≤{TIME_TOL_SEC}s — drift cho phép).</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setTimeEdit(bank.time)} className="rounded border border-brand/40 bg-white px-2 py-1 text-[11px] font-semibold text-brand-deep hover:bg-brand/10">Sửa giờ = báo có ({bank.time})</button>
            {timeEdit === bank.time && (
              <label className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700"><input type="checkbox" checked={timeFixAck} onChange={(e) => setTimeFixAck(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-600" /> Xác nhận giờ đúng (lần 2)</label>
            )}
          </div>
        </div>
      )}
    </div>
  ) : null;
  const imageBtn = imgUrl ? (
    <button type="button" onClick={() => setZoomed(true)} className="block overflow-hidden rounded-xl border border-line bg-appbg w-full"><img src={imgUrl} alt="bill QR" className="w-full object-contain max-h-[62vh]" /></button>
  ) : imgErr ? (
    <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-line text-xs text-slate-400">Ảnh hết hạn — quét lại</div>
  ) : (
    <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-line text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
  );
  return (
    // [Admin Demo 6/9] 2 CỘT: ẢNH bill TRÁI · cảnh báo + tham số + dropdown PHẢI → màn review KHÔNG phải cuộn (chỉ log cuộn).
    <div className="glass-panel shadow-soft rounded-2xl border border-brand/30 flex flex-col">
      {/* [Admin Demo 10/9] Bill QR TRƯỚC ĐÂY không có khối đối chiếu — soi ảnh phóng to phải nhớ số rồi tắt đi xem lại.
          Nay dùng CHUNG khối với bill POS: HKD → mã QR → ngày/giờ → SỐ TIỀN → thẻ khách/phí bán. */}
      {/* [11/9] "Người quẹt" sửa được TẠI CHỖ (cùng state ô tên bên dưới, sửa là hạ tick xác nhận). HKD/mã QR/số GD
          do báo-có + engine quyết — giữ chỉ-đọc; tiền của bill QR là khoá dedup nên cũng không sửa tay ở đây. */}
      {zoomed && imgUrl && <ImageZoom src={imgUrl} onClose={() => setZoomed(false)} compare={{
        chinh: { label: 'HKD', value: live.hkdNameMatched ?? qrIn.hkdName ?? '' },
        phu: [
          { label: 'Mã QR', value: live.tidCode ?? '' },
          { label: 'Số giao dịch', value: live.qr.ref ?? '' },
          { label: 'Người quẹt', value: payerName, sua: (v) => { setPayerName(v); setSendAck(false); } }
        ],
        hang: [{ label: 'Ngày', value: billDate || '' }, { label: 'Giờ', value: effTime || '' }],
        tien: { label: 'Số tiền', value: money(live.qr.amount) },
        duoi: [
          { label: 'Thẻ khách', value: live.qr.fromCard ?? '' },
          { label: 'Phí bán', value: pct(live.sellFeeMilli) }
        ]
      }} />}
      <div className="flex-1 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold text-brand-deep">
          <CreditCard className="h-4 w-4" /> Bill QR bán hàng {item.qr.ref ? <span className="text-xs font-medium text-slate-400">· GD {item.qr.ref}</span> : null}
          {/* [Admin Demo 10/9] Ảnh là THÔNG BÁO GIAO DỊCH THẺ (phía chủ thẻ) — GHIM nhãn suốt phiên duyệt để người
              duyệt luôn biết HKD/Số GD KHÔNG đọc từ ảnh mà lấy từ báo-có ngân hàng. */}
          {laThongBaoThe && (
            <span data-testid="qr-card-notice-badge" className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-800">
              📩 THÔNG BÁO GIAO DỊCH THẺ{item.qr.noticeMerchant ? ` · ${item.qr.noticeMerchant}` : ''} — HKD/Số GD lấy từ báo-có
            </span>
          )}
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          {/* CỘT TRÁI — ẢNH bill */}
          <div className="lg:w-[40%] lg:shrink-0">
            {imageBtn}
            {imgUrl && <div className="mt-1 text-center text-[11px] text-slate-400">🔍 bấm ảnh để phóng to</div>}
          </div>
          {/* CỘT PHẢI — cảnh báo (trên) + tham số + đại lý + người quẹt + khách hàng */}
          <div className="min-w-0 flex-1 space-y-2.5">
            {liveErr && (
              <div className="flex items-start gap-1.5 rounded-lg border border-danger/50 bg-danger/10 px-2.5 py-1.5 text-xs font-bold text-danger">
                ⛔ Không tính lại được phí theo đại lý đang chọn: {liveErr} — CHẶN GỬI tới khi tính lại thành công (bấm chọn lại đại lý).
              </div>
            )}
            {warnBlock}
            {tuDienBlock}
            {hkdSuggestBlock}
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
              <Field label="HKD (khớp)" value={live.hkdNameMatched ?? qrIn.hkdName ?? '—'} />
              <Field label="Số giao dịch" value={live.qr.ref ?? '—'} />
              <Field label="Số tiền" value={money(live.qr.amount)} strong check={amountChk} />
              <Field label="Ngày thanh toán" value={billDate || '—'} check={dateChk} />
              <Field label="Giờ" value={effTime || '—'} check={timeChk} />
              {/* [Admin Demo 6/9] "để GIÁ BÁN chứ không để số tiền": label "Giá bán", VALUE = tỷ lệ % (giá mã/giá đại lý), chữ xanh lá. */}
              {/* [Admin Demo 11/9] hiển thị theo BẬC đang chọn (nhanh/chờ). Mã không có bậc nhanh → luôn chờ. */}
              <Field label="Giá bán" green value={`${pct(qrGiaNhanh && live.sellFeeMilliNhanh != null ? live.sellFeeMilliNhanh : live.sellFeeMilli)}${qrGiaNhanh && live.sellFeeMilliNhanh != null ? ' (tiền nhanh)' : live.sellFeeSource === 'DEALER' ? ' (giá đại lý)' : live.sellFeeSource === 'DEFAULT' ? ' (giá mã)' : ''}${recomputing ? ' …' : ''}`} />
              <Field label="Hoàn tiền đại lý" value={money(qrGiaNhanh && live.refundAmountNhanh != null ? live.refundAmountNhanh : live.refundAmount)} strong />
              <Field label="NCC mã QR hoàn tiền" value={money(live.investorReceiveAmount)} strong />
              <Field label="Từ (thẻ khách)" value={live.qr.fromCard ?? '—'} />
            </div>
            {/* [Admin Demo 11/9] BẬC GIÁ BÁN (tiền chờ/nhanh) — chỉ khi mã cấu hình giá nhanh; mặc định CHỜ (dropdown như thẻ). */}
            {live.sellFeeMilliNhanh != null && (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">Bậc giá bán (nhận tiền)</div>
                <select value={qrGiaNhanh ? 'nhanh' : 'cho'} disabled={sent} onChange={(e) => { setQrGiaNhanh(e.target.value === 'nhanh'); setSendAck(false); }} className="w-full rounded-lg border border-line bg-white px-2.5 py-2 text-sm font-medium text-slate-700">
                  <option value="cho">Tiền chờ · {pct(live.sellFeeMilli)}</option>
                  <option value="nhanh">Tiền nhanh · {pct(live.sellFeeMilliNhanh)}</option>
                </select>
              </div>
            )}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {/* DROPDOWN đại lý — liệt kê HẾT (default = folder). Bắt buộc chọn để hoàn. onMouseDown refetch → nhóm mới hiện. */}
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400">
                  Đại lý nhận hoàn tiền
                  <button type="button" onClick={() => void reloadDealers()} disabled={sent || dealersReloading} title="Làm mới danh sách (thấy nhóm khách mới tạo)"
                    className="inline-flex items-center rounded px-1 py-0.5 text-slate-400 hover:text-brand-deep hover:bg-brand-tint disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${dealersReloading ? 'animate-spin' : ''}`} /></button>
                </div>
                <select value={dealerId} onMouseDown={() => { if (!sent) void reloadDealers(); }} onChange={(e) => { setDealerId(e.target.value); setSendAck(false); /* [phản biện #3] đổi người NHẬN tiền → ký lại */ }} disabled={sent} className="w-full rounded-lg border border-line bg-white px-2.5 py-2 text-sm font-medium text-slate-700">
                  <option value="">— Chọn đại lý —</option>
                  {dealers.map((d) => <option key={d.roomId} value={d.roomId}>{d.name}</option>)}
                </select>
              </div>
              {/* TÊN NGƯỜI QUẸT — tự điền khi Check báo có khớp; khớp báo-có = XANH ĐẬM NỔI, lệch = ĐỎ (Admin Demo 6/9). */}
              <div>
                <div className={`mb-1 text-[10px] uppercase tracking-wide ${nameChk === 'ok' ? 'font-bold text-emerald-600' : nameChk === 'bad' ? 'font-bold text-danger' : nameMissing ? 'font-bold text-amber-600' : 'text-slate-400'}`}>Tên người quẹt (thanh toán){nameChk === 'ok' ? ' ✓ khớp báo có' : nameChk === 'bad' ? ' ✗ lệch báo có' : nameMissing ? ' • CẦN ĐIỀN' : ''}</div>
                <input type="text" value={payerName} disabled={sent} onChange={(e) => { setPayerName(e.target.value); setSendAck(false); }} placeholder="Tự điền khi Check báo có khớp, hoặc gõ tay" className={`w-full rounded-lg bg-white px-2.5 py-2 text-sm font-bold ${nameChk === 'ok' ? 'border-2 border-emerald-400 text-emerald-700 ring-2 ring-emerald-200' : nameChk === 'bad' ? 'border-2 border-danger text-danger ring-2 ring-danger/20' : nameMissing ? 'border-2 border-amber-400 text-slate-700 ring-2 ring-amber-200' : 'border border-line text-slate-700'}`} />
                {/* [Admin Demo 6/9] GỢI Ý TÊN từ báo-có — bấm chip là điền vào ô + xanh (khỏi gõ tay). Hiện khi Check báo có ra tên. */}
                {!sent && (() => {
                  const names = baoCo?.status === 'MATCHED' && baoCo.candidates?.[0]?.payerName ? [baoCo.candidates[0].payerName]
                    : baoCo?.status === 'AMBIGUOUS' ? [...new Set((baoCo.candidates ?? []).map((c) => c.payerName).filter((n): n is string => !!n))]
                    : [];
                  return names.length ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-[10px] text-slate-400">Gợi ý báo-có:</span>
                      {names.map((n, i) => {
                        const picked = norm(payerName) === norm(n);
                        return <button key={i} type="button" onClick={() => { setPayerName(n); setSendAck(false); }} className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold transition ${picked ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-line bg-white text-slate-600 hover:bg-emerald-50'}`}>{picked ? '✓ ' : ''}{n}</button>;
                      })}
                    </div>
                  ) : null;
                })()}
              </div>
            </div>
            {/* [Admin Demo 6/9] KẾT QUẢ ĐỐI SOÁT ngay DƯỚI dropdown đại lý: recon (lỗi/đủ-xanh) → báo-có (trạng thái + chọn tên). Nút Check báo có + Gửi ở ĐÁY. */}
            {reconBlock}
            {baoCoBlock}
            {err && <div className="flex items-center gap-2 rounded-lg bg-danger/10 border border-danger/20 p-2 text-xs text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {err}</div>}
            {/* hint "đủ 4 ô xanh" khi chưa đủ */}
            {!sent && !blockReason && !allGreen && <div className="flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> Chỉ gửi được khi <b className="mx-1">"Đã báo có — KHỚP"</b> + số tiền + tên người quẹt khớp. Bấm "Check báo có" ở đáy.</div>}
            {/* XÁC NHẬN GỬI — chỉ hiện khi ĐỦ 4 ô XANH + đã chọn đại lý. */}
            {!sent && allGreen && !!dealerId && (
              <label className="flex items-start gap-2 rounded-lg border border-brand/20 bg-brand-tint/40 px-2.5 py-1.5 text-xs text-slate-700">
                <input type="checkbox" checked={sendAck} onChange={(e) => setSendAck(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" />
                <span>Xác nhận gửi: người quẹt <b className="text-emerald-700">{payerName.trim() || '(chưa điền)'}</b> · {money(live.qr.amount)} · {qrGiaNhanh && live.sellFeeMilliNhanh != null ? 'tiền NHANH' : 'tiền chờ'} → hoàn ĐL {money(qrGiaNhanh && live.refundAmountNhanh != null ? live.refundAmountNhanh : live.refundAmount)}</span>
              </label>
            )}
          </div>
        </div>
      </div>
      {/* Footer — nút Gửi. Check báo có + kết quả + xác nhận GỬI đã đưa LÊN cột phải (Admin Demo 6/9, khỏi lăn màn). */}
      <div className="shrink-0 border-t border-line p-3 space-y-2">
        {sent ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-success"><CheckCircle2 className="h-4 w-4" /> Đã ghi doanh số + gửi hoàn đại lý.{deduped ? ' (bill đã gửi trước — không trùng)' : ''}</div>
            {onPickAnother && <Button variant="confirm" size="sm" icon={<Upload className="h-3.5 w-3.5" />} onClick={onPickAnother} className="w-full">Chọn ảnh khác (quét bill kế) →</Button>}
          </div>
        ) : (
          <>
            {blockReason && <div className="flex items-start gap-1.5 text-xs font-medium text-amber-700"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {blockReason}</div>}
            {/* [Admin Demo 6/9] Check báo có ở ĐÁY, ngay TRÊN nút Gửi. */}
            <Button variant="soft" size="sm" icon={baoCoLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} onClick={() => void doCheckBaoCo()} disabled={baoCoLoading || sent} data-testid="qr-check-baoco" className="w-full">{baoCoLoading ? 'Đang check báo có…' : 'Check báo có (đối soát ngân hàng)'}</Button>
            <div className="flex items-center gap-2">
              <Button variant="confirm" icon={sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} onClick={doSend} disabled={!sendable || sending}>{sending ? 'Đang gửi…' : tuDien && !tuDienAck ? 'Xác nhận thông tin TỰ ĐIỀN ở trên' : !allGreen ? 'Cần "Đã báo có — khớp" + tiền + tên' : !sendAck ? 'Tick xác nhận gửi ở trên' : 'Ghi doanh số + hoàn đại lý'}</Button>
              {onPickAnother && <Button variant="soft" size="sm" onClick={onPickAnother}>Ảnh khác</Button>}
            </div>
            {/* [Admin Demo 16/9 "bỏ hết UI liên quan OCR máy"] OCR máy đã KHOÁ CỨNG server-side — mọi bill đi thẳng
                API (Gemini → Claude). Nút "Đọc lại bằng Claude" (nghĩa cũ = bỏ lượt OCR máy) thành thừa → gỡ;
                còn "Quét lại" (bỏ cache đọc lại) + "Đọc lại bằng Opus" (bill khó). */}
            {(onRescan || onRescanOpus) && (
              <>
                {/* [Admin Demo 8/9] Cờ đỏ "2 lần đọc lệch" thì phải có lối ĐỌC LẠI BẰNG MODEL MẠNH NHẤT ngay tại chỗ,
                    không bắt người duyệt tự đoán bên nào đúng. Có lệch → nút Opus nổi đỏ + 1 dòng chỉ việc. */}
                {coLechDoc && <div className="text-[11px] font-semibold text-danger">→ Hai lần đọc lệch nhau: bấm <b>“Đọc lại bằng Opus”</b> để model mạnh nhất phân xử, rồi đối chiếu ảnh.</div>}
                <div className="flex items-center gap-2">
                  {onRescan && <Button variant="soft" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRescan} disabled={rescanBusy} className="flex-1">Quét lại</Button>}
                  {onRescanOpus && <Button variant={coLechDoc ? 'danger' : 'soft'} size="sm" icon={rescanBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} onClick={onRescanOpus} disabled={rescanBusy} className="flex-1" title="Đọc lại bằng Opus — model mạnh nhất, chậm nhất; dùng khi 2 lần đọc lệch hoặc nghi sai số">Đọc lại bằng Opus</Button>}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// [Tab QUÉT QR] Bill quét ra KHÔNG phải QR (kind POS/TRANSFER) → thông báo NHẸ, hướng người dùng sang tab Thủ công/Tự
// động. KHÔNG xử lý POS/CK trong tab QR (tránh trùng chức năng). onPick = chọn ảnh khác (upload); onSkip = bỏ qua (folder).
// [Admin Demo 6/9 — tab đúng loại] title/desc tuỳ biến (QR-tab gặp POS/CK, HOẶC POS/CK-tab gặp QR). onGoTab = nút chuyển
// sang tab xử lý đúng loại (goLabel = nhãn). Mỗi tab CHỈ nhận đúng loại của nó → hết chéo.
function NotQrNotice({ onPick, onSkip, onGoTab, goLabel, title, desc }: { onPick?: () => void; onSkip?: () => void; onGoTab?: () => void; goLabel?: string; title?: string; desc?: ReactNode }): JSX.Element {
  return (
    <div className="glass-panel shadow-soft rounded-2xl border border-amber-300 bg-amber-50 p-5 flex flex-col items-center gap-3 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-500" />
      <div className="text-sm font-bold text-amber-800">{title ?? 'Bill này KHÔNG phải QR bán hàng'}</div>
      <div className="max-w-md text-xs text-amber-700">{desc ?? <>Dùng tab <b>Thủ công</b> hoặc <b>Tự động</b> để gửi bill <b>POS / chuyển khoản</b>. Tab "Quét QR" chỉ xử lý bill <b>"Thanh toán thành công"</b> (QR bán hàng).</>}</div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onGoTab && <Button variant="confirm" size="sm" icon={<ScanLine className="h-3.5 w-3.5" />} onClick={onGoTab}>{goLabel ?? 'Sang tab đúng →'}</Button>}
        {onPick && <Button variant="soft" size="sm" icon={<Upload className="h-3.5 w-3.5" />} onClick={onPick}>Chọn ảnh khác</Button>}
        {onSkip && <Button variant="soft" size="sm" icon={<SkipForward className="h-3.5 w-3.5" />} onClick={onSkip}>Bỏ qua bill này →</Button>}
      </div>
    </div>
  );
}

export function TransferReviewCard({ token, transfer, onSent, onPickAnother, snapBase, stacked = false }: { token: string; transfer: TransferReview; onSent: (info: SentInfo) => void; onPickAnother?: () => void; snapBase?: string; stacked?: boolean }): JSX.Element {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [deduped, setDeduped] = useState(false); // bill CK đã gửi trước (dedup ckTxnKey) — báo rõ, không rác.
  const [err, setErr] = useState<string | null>(null);
  // [Admin Demo 2/9 "sửa loại hoàn + ngày xong re-OCR lại về OCR gốc — lọt quy trình"] PARITY với POS card: giữ CHỈNH SỬA
  // (ngày + LOẠI hoàn đã phân) qua re-OCR bằng sessionStorage khóa theo ẢNH (snapBase ổn định). Trước đây CK KHÔNG snap
  // → remount lấy lại giá trị OCR gốc → mất công sửa. Nay khôi phục date/dateTouched/cls từ snapshot.
  const CK_SNAP_KEY = `ocrSend.ck.${snapBase ?? token}`;
  const ckSnap = useMemo<Record<string, unknown> | null>(() => { try { return JSON.parse(sessionStorage.getItem(CK_SNAP_KEY) ?? 'null'); } catch { return null; } }, [CK_SNAP_KEY]);
  // NGÀY BILL CK — PARITY POS (Admin Demo 1/9 "2 tab thủ công/tự động phải như nhau"): OCR mù ngày → MẶC ĐỊNH hôm nay +
  // nút sửa (date-picker) + note "đã cập nhật". Ngày sửa PHẢI tới server (payload.date override) → parseTransferDay ghi
  // billDate (hoàn đại lý) + vnDateToIso ghi advance_date (tạm ứng NĐT) ĐÚNG (LIVE path, không chỉ hiển thị).
  const tdM = /(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+([\d:]+))?/.exec(transfer.date ?? '');
  const ocrHadDate = !!tdM?.[1];
  const ckTimePart = tdM?.[2] ?? '';
  const padDmy = (s: string): string => { const p = s.split('/'); return p.length === 3 ? `${p[0].padStart(2, '0')}/${p[1].padStart(2, '0')}/${p[2]}` : s; };
  const [date, setDate] = useState((ckSnap?.date as string) ?? (ocrHadDate ? padDmy(tdM![1]) : todayDmy()));
  const [dateTouched, setDateTouched] = useState((ckSnap?.dateTouched as boolean) ?? false); // user đã sửa ngày → note "✓ đã cập nhật".
  // [Admin Demo 2/9] giờ-sửa từng trường CK (ngày + loại hoàn) — log nhỏ dưới trường. cls (loại) stamp trong confirmClassify.
  const [ckEdits, setCkEdits] = useState<Record<string, string>>((ckSnap?.edits as Record<string, string>) ?? {});
  const ckOrig = useRef<Record<string, string>>({ date: ocrHadDate ? padDmy(tdM![1]) : '' });
  const ckPrev = useRef<Record<string, string>>({ date });
  useEffect(() => {
    const cur = { date };
    const { next, changed } = stampEdits(cur, ckPrev.current, ckOrig.current, ckEdits);
    ckPrev.current = cur;
    if (changed) setCkEdits(next);
    // eslint-disable-next-line
  }, [date]);
  const dateForSend = `${date}${ckTimePart ? ` ${ckTimePart}` : ''}`; // giữ giờ OCR nếu có (billDateTimeRaw sắp theo giờ).
  // NGÂN HÀNG NGƯỜI GỬI (Admin Demo 2/9) — OCR chỉ đọc bank bên NHẬN; bank người gửi học/khai báo. Init: snapshot →
  // OCR-học (transfer.senderBank) → ''. bankSaved = đã có sẵn (đã học/khai) → hiện xác nhận + cho sửa.
  const [senderBank, setSenderBank] = useState<string>((ckSnap?.senderBank as string) ?? transfer.senderBank ?? '');
  const [bankSaved, setBankSaved] = useState<boolean>(!!((ckSnap?.senderBank as string) ?? transfer.senderBank));
  const [bankSaving, setBankSaving] = useState(false);
  // ẢNH bill (Admin Demo 31/8 "bản chất review phải như bill POS") — thumbnail như BillReviewCard.
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState(false); // [Admin Demo 3/9] parity BillReviewCard: token hết hạn → cờ lỗi thay spinner câm.
  useEffect(() => { let a = true; setImgErr(false); setImgUrl(null); fetchAttachmentObjectUrl(ocrImageUrl(token)).then((u) => { if (a) setImgUrl(u); }).catch(() => { if (a) setImgErr(true); }); return () => { a = false; }; }, [token]);
  const money = (n: number): string => n.toLocaleString('vi-VN') + 'đ';
  // HỌC NH người gửi: khai báo bank + STK/tên người gửi → cache (last-wins) → lần sau tự nhận. Chỉ nhãn — KHÔNG đụng
  // tiền/dedup/định tuyến. Thất bại (thiếu STK+tên) báo lỗi, KHÔNG chặn gửi bill.
  async function saveBank(): Promise<void> {
    const bank = senderBank.trim().toUpperCase();
    if (!bank) { setErr('Nhập tên ngân hàng người gửi.'); return; }
    setBankSaving(true); setErr(null);
    const r = await saveSenderBankAlias({ account: transfer.senderAccount ?? null, name: transfer.senderName ?? null, bank });
    setBankSaving(false);
    if (!r.ok) { setErr(r.message); return; }
    setSenderBank(bank); setBankSaved(true);
  }
  async function doSend(): Promise<void> {
    setSending(true); setErr(null);
    // [Admin Demo 5/9 fix triệt để "gửi lại văng dash"] bọc try/catch: sendTransfer ném (mạng) KHÔNG được văng ra crash màn.
    try {
      // Gửi theo HƯỚNG (4 loại). BẢO MẬT 2 CHIỀU: INVESTOR → gửi entityId (server resolve nhóm NĐT), matchedRoomId=null
      // (KHÔNG để lọt nhóm đại lý); DEALER → matchedRoomId nhóm đại lý đã chọn, entityId=null.
      // date: dateForSend (ngày đã review/sửa, mặc định hôm nay nếu OCR mù) — OVERRIDE transfer.date để server ghi ĐÚNG
      // billDate/advance_date theo ngày người xác nhận, KHÔNG phụ thuộc OCR đọc được hay không (LIVE, R201).
      const payload: TransferReview = isInvestor
        ? { ...transfer, date: dateForSend, direction: effDirection, entityType: 'INVESTOR', entityId: effEntityId, matchedRoomId: null, matchedRoomName: null, needsManualPick: false }
        : { ...transfer, date: dateForSend, direction: effDirection, entityType: 'DEALER', entityId: null, matchedRoomId: effRoomId, matchedRoomName: effRoomName, needsManualPick: false };
      const r = await sendTransfer({ token, transfer: payload });
      if (!r.ok) { setErr(r.message); return; }
      // ĐỒNG NHẤT với POS (Admin Demo 1/9 "bao gồm cả bill CK"): CK dedup theo ckTxnKey (idempotent) → gửi lại KHÔNG đăng
      // trùng, server trả deduped=true. Báo RÕ cho user biết bill này ĐÃ GỬI TRƯỚC (không rác nhóm).
      if ((r.data as { deduped?: boolean })?.deduped === true) setDeduped(true);
      setSent(true);
      onSent(isInvestor ? { dealer: null, investor: investorName } : { dealer: effRoomName, investor: null });
    } catch (e) {
      setErr('Lỗi khi gửi (giữ nguyên review, thử lại): ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSending(false);
    }
  }
  const Field = ({ label, value, bank }: { label: string; value: string; bank?: string | null }): JSX.Element => (
    <div className="rounded-lg border border-line bg-white/60 px-2.5 py-1.5"><div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-400"><FieldIcon label={label} bank={bank} className="h-3 w-3" />{label}</div><div className="text-sm font-semibold text-slate-700 break-words">{value}</div></div>
  );
  // ── PHÂN-LOẠI-TAY (Admin Demo 31/8): bill CK chưa phân loại → CỜ CẢNH BÁO + DROPDOWN bắt buộc, CHẶN gửi; chọn xong
  //    → học alias (last-wins, SỬA ĐƯỢC). 4 loại → hướng + phía đối tác (sender/receiver) để học đúng tên. ──
  const KINDS = KINDS_CK; // danh sách + luật ở lib/ck-classify-kinds.ts (test khoá: hướng gửi server phải hợp lệ)
  const [cls, setCls] = useState<{ direction: string; uiKey?: string; entityType: 'DEALER' | 'INVESTOR'; entityId: number | null; roomId: string | null; roomName: string | null } | null>((ckSnap?.cls as { direction: string; uiKey?: string; entityType: 'DEALER' | 'INVESTOR'; entityId: number | null; roomId: string | null; roomName: string | null }) ?? null);
  // picking: nếu snapshot ĐÃ có cls (đã phân loại) thì KHÔNG bắt chọn lại; else theo cờ OCR.
  const [picking, setPicking] = useState<boolean>(ckSnap?.cls ? false : transfer.needsManualPick);
  const [zoomed, setZoomed] = useState(false); // xem ảnh bill CK phóng to (ảnh cap 34vh chống tràn, bấm mở đủ).
  const [opts, setOpts] = useState<ClassifyOptions | null>(null);
  const [selKind, setSelKind] = useState<string>('');
  const [selEntity, setSelEntity] = useState<string>('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (picking && !opts) fetchClassifyOptions().then((r) => { if (r.ok) setOpts(r.data); }); }, [picking, opts]);
  const kind = KINDS.find((k) => k.key === selKind);
  async function confirmClassify(): Promise<void> {
    if (!kind || !selEntity) { setErr('Chọn loại + đại lý/NĐT.'); return; }
    setSaving(true); setErr(null);
    const partyName = kind.party === 'sender' ? transfer.senderName : transfer.receiverName;
    const partyAccount = kind.party === 'sender' ? (transfer.senderAccount ?? null) : (transfer.receiverAccount ?? null);
    const isDealer = kind.entityType === 'DEALER';
    const roomName = isDealer ? (nhomDaiLyCoKhach.find((d) => d.roomId === selEntity)?.name ?? null) : null;
    // HỌC ALIAS = BONUS (để lần sau tự nhận): thất bại (vd bill hoàn-ứng OCR không đọc được tên/STK người gửi → route
    // báo "Thiếu tên/STK để học") KHÔNG được CHẶN phân loại tay bill NÀY (Admin Demo 1/9 "lỗi khi chọn đại lý hoàn ứng").
    // Vẫn set cls để gửi; chỉ không học được alias (lần sau vẫn chọn tay). Lỗi được nuốt CÓ CHỦ Ý (bonus, không critical).
    await classifyAlias({ name: partyName, account: partyAccount, entityType: kind.entityType, entityId: isDealer ? null : Number(selEntity), roomId: isDealer ? selEntity : null, label: roomName ?? '' }).catch(() => {});
    // [Admin Demo 4/9] LƯU BẢN SỬA THEO ẢNH (server) → re-OCR ảnh này trả ĐÚNG hướng+đối-tác đã sửa, mọi phiên/máy (khác
    // alias: correction nhớ CẢ HƯỚNG ứng/hoàn). Bonus như alias — lỗi KHÔNG chặn phân loại tay bill này.
    await saveTransferCorrection({ token, direction: kind.direction, entityType: kind.entityType, entityId: isDealer ? null : Number(selEntity), roomId: isDealer ? selEntity : null, roomName }).catch(() => {});
    setSaving(false);
    setCls({ direction: kind.direction, uiKey: kind.key, entityType: kind.entityType, entityId: isDealer ? null : Number(selEntity), roomId: isDealer ? selEntity : null, roomName });
    setCkEdits((e) => ({ ...e, loai: nowHHMM() })); // dấu mốc giờ đã phân/sửa LOẠI hoàn → log dưới ô loại.
    setPicking(false);
  }
  // [Admin Demo 26/9] DANH SÁCH NHÓM ĐẠI LÝ cho bill CK: CHỈ nhóm ĐÃ GÁN KHÁCH (nhóm doanh số thật). Trước đây liệt
  // kê MỌI nhóm chat nên chọn nhầm nhóm "QR - …" (chưa gán khách) là tiền hoàn rơi khỏi đối soát, câm.
  const nhomDaiLyCoKhach = (opts?.dealers ?? []).filter((d) => d.customerId != null);
  const effRoomId = cls?.roomId ?? transfer.matchedRoomId;
  const effRoomName = cls?.roomName ?? transfer.matchedRoomName;
  const effEntityType = cls?.entityType ?? transfer.entityType ?? null;
  const effEntityId = cls?.entityId ?? transfer.entityId ?? null;
  const effDirection = (cls?.direction ?? transfer.direction ?? 'SIGMA_TO_DEALER') as NonNullable<TransferReview['direction']>;
  const classified = cls != null || (!transfer.needsManualPick);
  const isInvestor = effEntityType === 'INVESTOR';
  const investorName = opts?.investors?.find((i) => i.id === effEntityId)?.name ?? (effEntityId != null ? `NĐT ${effEntityId}` : null);
  // [Admin Demo 3/9 "vá gốc: CK mù ngày → cấm mặc định hôm nay"] OCR không đọc được ngày + user CHƯA chọn → CHẶN gửi
  // (không chỉ cảnh báo). Gốc lỗi +200tr: bill "hoàn thừa về SigMa" mù ngày → mặc định HÔM NAY → rơi sai kỳ → thừa giả.
  const needDateCheck = !ocrHadDate && !dateTouched;
  const dealerSendable = classified && !isInvestor && !!effRoomId && !needDateCheck;
  const investorSendable = classified && isInvestor && effEntityId != null && !needDateCheck;
  // Lưu snapshot CK mỗi khi ngày / loại-hoàn đổi → re-OCR giữ nguyên (parity POS). Khóa theo ẢNH (snapBase).
  useEffect(() => {
    try { sessionStorage.setItem(CK_SNAP_KEY, JSON.stringify({ date, dateTouched, cls, edits: ckEdits, senderBank: bankSaved ? senderBank : undefined })); } catch { /* quota */ }
  }, [CK_SNAP_KEY, date, dateTouched, cls, ckEdits, senderBank, bankSaved]);
  // [Admin Demo 5/9 — CẢNH BÁO BÊN PHẢI ẢNH CK] parity với BillReviewCard: ở tab TỰ ĐỘNG (stacked) đưa cảnh báo "ĐÃ GỬI
  // trước" vào chỗ trống bên phải ảnh CK cao-hẹp. `ckWarn` = badge "đã gửi rồi" (chống rác/đăng trùng). besideCk = chỉ
  // đặt beside khi stacked + có cảnh báo; else giữ inline trong luồng như cũ (tab thủ công).
  const ckWarn = transfer.alreadySent ? (
    <div className="flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-700">
      <AlertTriangle className="h-4 w-4 shrink-0" /> Bill CK này ĐÃ GỬI vào nhóm rồi — bấm gửi sẽ KHÔNG đăng trùng.
    </div>
  ) : null;
  const ckImageBtn = imgUrl ? (
    <button type="button" onClick={() => setZoomed(true)} className="block w-full overflow-hidden rounded-xl border border-line bg-appbg"><img src={imgUrl} alt="bill chuyển khoản" className="w-full object-contain max-h-[62vh]" /></button>
  ) : null;
  return (
    <div className="glass-panel shadow-soft rounded-2xl border border-brand/30 flex flex-col">
      {/* [Admin Demo 10/9] Bill CHUYỂN KHOẢN cũng phải có khối đối chiếu như POS/QR: người nhận (dòng lớn) → người gửi
          → NH nhận → ngày/giờ → SỐ TIỀN → nội dung/STK nhận. Ngày lấy bản ĐANG REVIEW (đã sửa) để soi đúng cái sẽ ghi. */}
      {zoomed && imgUrl && <ImageZoom src={imgUrl} onClose={() => setZoomed(false)} compare={{
        tieuDe: '📋 Đối chiếu bill CK',
        chinh: { label: 'Người nhận', value: transfer.receiverName ?? '' },
        phu: [
          { label: 'Người gửi', value: `${transfer.senderName ?? ''}${transfer.senderIsAlpha ? ' (SigMa ✓)' : ''}`.trim() },
          { label: 'NH nhận', value: transfer.bank ?? '' }
        ],
        hang: [{ label: 'Ngày', value: date, sua: (v) => { setDate(v); setDateTouched(true); } }, { label: 'Giờ', value: transfer.time ?? ckTimePart }],
        tien: { label: 'Số tiền', value: money(transfer.amount) },
        duoi: [
          { label: 'STK nhận', value: transfer.receiverAccount ?? '' },
          { label: 'Nội dung', value: transfer.content ?? '' }
        ]
      }} />}
      {/* [Admin Demo 6/9 — ĐỒNG NHẤT QrBillReviewCard] 2 CỘT: ẢNH bill TRÁI lg:w-[40%] · PHẢI cảnh báo→tham số→điều khiển.
          KHÔNG cuộn nội bộ (bỏ max-h/overflow) — chỉ log ngoài cuộn. Footer nút Gửi PIN đáy card (shrink-0). */}
      <div className="flex-1 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-bold text-brand"><Send className="h-4 w-4" /> Bill chuyển khoản</div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        {/* CỘT TRÁI — ẢNH bill (bấm mở lightbox xem đủ). */}
        <div className="lg:w-[40%] lg:shrink-0">
          {ckImageBtn}
          {!imgUrl && imgErr && <div className="mt-2 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"><AlertTriangle className="h-4 w-4 shrink-0" />Ảnh hết hạn (máy chủ vừa khởi động lại) — quét lại folder để tải lại ảnh.</div>}
        </div>
        {/* CỘT PHẢI — cảnh báo (trên) → tham số → điều khiển (đồng nhất Qr/POS). */}
        <div className="min-w-0 flex-1 space-y-2.5">
          {ckWarn}
          <div className="grid grid-cols-2 gap-2">
        <Field label="Người gửi" value={`${transfer.senderName || '—'}${transfer.senderIsAlpha ? ' (SigMa ✓)' : ''}`} />
        <Field label="Người nhận" value={transfer.receiverName || '—'} />
        <Field label="Số tiền" value={money(transfer.amount)} />
        <Field label="NH nhận" value={transfer.bank || '—'} bank={transfer.bank} />
      </div>
      {/* NGÂN HÀNG NGƯỜI GỬI (Admin Demo 2/9) — OCR chỉ đọc bank bên NHẬN. ĐÃ học/khai → hiện + cho SỬA; CHƯA → input +
          nút "Lưu ghi nhớ" (khai 1 lần → lần sau tự nhận theo STK/tên người gửi). Chỉ nhãn attribution — KHÔNG đụng tiền. */}
      <div className={'rounded-lg border px-2.5 py-1.5 ' + (bankSaved && senderBank.trim() ? 'border-line bg-white/60' : 'border-amber-400 bg-amber-50')}>
        <div className="text-[10px] uppercase tracking-wide text-slate-400">NH người gửi</div>
        {!(bankSaved && senderBank.trim()) && <div className="mt-0.5 flex items-start gap-1 text-[11px] font-semibold text-amber-700"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" /> OCR không đọc được NH người gửi — khai báo 1 lần, lần sau TỰ NHẬN theo người gửi.</div>}
        <div className="mt-1 flex items-center gap-1">
          <input list="sender-bank-suggest" className="flex-1 rounded-lg border border-line bg-white px-2 py-1 text-sm font-semibold uppercase text-slate-700" placeholder="VD: MB, VP, ACB, VCB…" value={senderBank} onChange={(e) => { setSenderBank(e.target.value.toUpperCase()); setBankSaved(false); }} disabled={sent || bankSaving} />
          <datalist id="sender-bank-suggest"><option value="MB" /><option value="VP" /><option value="ACB" /><option value="VCB" /><option value="TCB" /><option value="BIDV" /><option value="ABB" /><option value="VIB" /><option value="MSB" /><option value="SACOMBANK" /></datalist>
          <Button variant="soft" size="sm" icon={<Save className="h-3.5 w-3.5" />} onClick={saveBank} disabled={bankSaving || sent || !senderBank.trim()}>{bankSaving ? 'Đang lưu…' : 'Lưu ghi nhớ'}</Button>
        </div>
        {bankSaved && senderBank.trim() && <div className="mt-1 flex items-center gap-1 text-xs font-semibold text-success"><CheckCircle2 className="h-3.5 w-3.5" /> Đã ghi nhớ NH người gửi: {senderBank} (sửa được).</div>}
      </div>
      {/* NGÀY BILL — sửa được, PARITY POS (Admin Demo 1/9). OCR mù ngày → mặc định HÔM NAY + CỜ ĐỎ "kiểm tra ngày CK"
          (Admin Demo 1/9: clear 30/8 gửi hôm nay bị ghi nhận 01/09 SAI — ngày CK quyết định doanh số/hoàn tiền rơi NGÀY
          NÀO). User sửa → note xanh. Ngày này gửi kèm payload → server ghi billDate/advance_date theo NGÀY ĐIỀU CHỈNH. */}
      {(() => { const needCheck = needDateCheck; return (
      <div className={'rounded-lg border px-2.5 py-1.5 ' + (needCheck ? 'border-2 border-danger bg-danger/5' : 'border-line bg-white/60')}>
        <div className="text-[10px] uppercase tracking-wide text-slate-400">Ngày chuyển khoản</div>
        {needCheck && <div className="mt-0.5 flex items-start gap-1 text-[11px] font-bold text-danger"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" /> OCR KHÔNG đọc được ngày — BẮT BUỘC chọn ĐÚNG ngày CK trước khi gửi (CẤM mặc định hôm nay → ghi SAI kỳ hoàn/doanh số). Nút Gửi khoá tới khi chọn ngày.</div>}
        <div className="mt-1 flex items-center gap-1">
          <input className="flex-1 rounded-lg border border-line bg-white px-2 py-1 text-sm font-semibold text-slate-700" placeholder="dd/mm/yyyy" value={date} onChange={(e) => { setDate(e.target.value); setDateTouched(true); }} disabled={sent} />
          <input type="date" aria-label="Chọn ngày" title="Chọn ngày đúng" className="date-vn-icon h-8 w-8 shrink-0 cursor-pointer rounded-lg border border-line bg-white p-0.5 text-transparent" value={dmyToIso(date)} onChange={(e) => { setDate(isoToDmy(e.target.value) || date); setDateTouched(true); }} disabled={sent} />
        </div>
        {dateTouched && <div className="mt-1 flex items-center gap-1 text-xs font-semibold text-success"><CheckCircle2 className="h-3.5 w-3.5" /> Đã cập nhật ngày: {date}{ckEdits.date ? ` · lúc ${ckEdits.date}` : ''}</div>}
      </div>
      ); })()}
      <Field label="Nội dung (memo)" value={transfer.content || '—'} />

      {picking ? (
        <div className="rounded-xl border-2 border-danger/50 bg-danger/5 p-2.5 space-y-2">
          <div className="flex items-center gap-1.5 text-sm font-bold text-danger"><AlertTriangle className="h-4 w-4" /> Chưa phân loại được — CHỌN TAY (bắt buộc trước khi gửi)</div>
          {/* Admin Demo 1/9 "dropdown khó nhìn, mỗi dòng 1 màu (xanh nhẹ/trắng), dãn rộng": DÃN RỘNG full-width mỗi dòng
              (bỏ 2 cột) + select TO (py-2.5 text-[15px]) + option ZEBRA (xanh nhẹ #eff6ff / trắng) tránh lẫn dòng. */}
          <div className="space-y-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Loại bill</div>
              {/* Đã chọn → ô select NỔI 3D (viền brand + ring + shadow + chữ đậm). Option đang chọn tô xanh ĐẬM + bold. */}
              <select value={selKind} onChange={(e) => { setSelKind(e.target.value); setSelEntity(''); }} className={'w-full rounded-lg px-3 py-2.5 text-[15px] transition ' + (selKind ? 'border-2 border-brand bg-white font-bold text-brand-deep shadow-[0_3px_10px_-2px_rgba(5,121,204,0.35)] ring-2 ring-brand/25' : 'border border-line bg-white font-medium text-slate-700')}>
                <option value="" style={{ backgroundColor: '#fff' }}>— chọn loại —</option>
                {KINDS.map((k, i) => <option key={k.key} value={k.key} style={{ backgroundColor: k.key === selKind ? '#bfdbfe' : (i % 2 ? '#eff6ff' : '#ffffff'), fontWeight: k.key === selKind ? 700 : 400 }}>{k.label}</option>)}
              </select>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">{kind?.entityType === 'INVESTOR' ? 'Nhà đầu tư' : 'Đại lý'}</div>
              <select value={selEntity} onChange={(e) => setSelEntity(e.target.value)} disabled={!kind} className={'w-full rounded-lg px-3 py-2.5 text-[15px] transition disabled:opacity-50 ' + (selEntity ? 'border-2 border-brand bg-white font-bold text-brand-deep shadow-[0_3px_10px_-2px_rgba(5,121,204,0.35)] ring-2 ring-brand/25' : 'border border-line bg-white font-medium text-slate-700')}>
                <option value="" style={{ backgroundColor: '#fff' }}>{kind ? '— chọn —' : 'chọn loại trước'}</option>
                {kind?.entityType === 'INVESTOR'
                  ? opts?.investors?.map((i, ix) => <option key={i.id} value={String(i.id)} style={{ backgroundColor: String(i.id) === selEntity ? '#bfdbfe' : (ix % 2 ? '#eff6ff' : '#ffffff'), fontWeight: String(i.id) === selEntity ? 700 : 400 }}>{i.name}</option>)
                  : nhomDaiLyCoKhach.map((d, ix) => <option key={d.roomId} value={d.roomId} style={{ backgroundColor: d.roomId === selEntity ? '#bfdbfe' : (ix % 2 ? '#eff6ff' : '#ffffff'), fontWeight: d.roomId === selEntity ? 700 : 400 }}>{d.name}</option>)}
              </select>
            </div>
          </div>
          <Button variant="confirm" size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={confirmClassify} disabled={saving || !kind || !selEntity}>{saving ? 'Đang lưu…' : 'Xác nhận phân loại'}</Button>
        </div>
      ) : (
        <div className="rounded-lg border border-success/40 bg-success/5 px-2.5 py-1.5 flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Phân loại</div>
            <div className="text-sm font-bold text-slate-700">
              {cls ? `${KINDS.find((k) => k.key === (cls.uiKey ?? cls.direction))?.label ?? cls.direction} · ${cls.entityType === 'DEALER' ? (cls.roomName ?? 'đại lý') : (opts?.investors?.find((i) => i.id === cls.entityId)?.name ?? `NĐT ${cls.entityId}`)}`
                : `${KINDS.find((k) => k.key === effDirection)?.label ?? 'Hoàn tiền đại lý'} · ${effRoomName ?? '—'}`}
            </div>
            <EditedNote at={ckEdits.loai} />
          </div>
          <Button variant="soft" size="sm" onClick={() => { setPicking(true); if (cls) { setSelKind(cls.uiKey ?? cls.direction); setSelEntity(cls.entityType === 'DEALER' ? (cls.roomId ?? '') : String(cls.entityId ?? '')); } }} disabled={sending}>Sửa phân loại</Button>
        </div>
      )}

      {/* Warning phân-loại ("Chưa khớp được đối tác…", transfer-classify.ts) chỉ có ý nghĩa TRƯỚC khi người chọn tay.
          Sau khi confirmClassify (cls set) → ẨN, nếu không "chọn đại lý rồi VẪN báo chưa khớp" (bug 1/9 Admin Demo). */}
      {!cls && transfer.warnings.map((w, i) => <div key={i} className="flex items-center gap-1.5 text-xs text-amber-600"><AlertTriangle className="h-3.5 w-3.5" /> {w}</div>)}
      {err && <div className="flex items-center gap-1.5 text-xs text-danger"><AlertTriangle className="h-3.5 w-3.5" /> {err}</div>}
        </div>{/* /CỘT PHẢI */}
      </div>{/* /2 CỘT */}
      </div>{/* /thân card */}
      {/* FOOTER PIN đáy — nút Gửi LUÔN thấy dù ảnh cao/nội dung dài (chống tràn mất nút, Admin Demo 1/9). Khi đang
          "chọn tay" thì nút Xác nhận phân loại nằm trong vùng cuộn phía trên (card đã bound chiều cao → cuộn tới được). */}
      <div className="shrink-0 rounded-b-2xl border-t border-line bg-white/95 p-2.5 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-2">
          {sent
            ? deduped
              ? <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-600"><AlertTriangle className="h-4 w-4" /> ⚠ Bill CK này ĐÃ GỬI TRƯỚC ĐÓ — hệ thống KHÔNG đăng trùng (chống rác).</div>
              : <div className="flex items-center gap-1.5 text-sm font-semibold text-success"><CheckCircle2 className="h-4 w-4" /> {isInvestor ? `Đã gửi nhóm NĐT "${investorName ?? '—'}" (không gửi đại lý)` : `Đã gửi nhóm đại lý "${effRoomName ?? '—'}" (không gửi NĐT)`} · ngày {date}.</div>
            : transfer.alreadySent
              // [Admin Demo 5/9] Bill CK ĐÃ GỬI trước (server dedup) → KHÔNG hiện nút Gửi xanh chính (dễ nhầm bấm lại).
              // Hiện rõ "đã gửi" + chỉ nút "vẫn gửi lại" MỜ (edit) cho trường hợp thật sự cần (server vẫn chặn trùng).
              ? <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-600"><AlertTriangle className="h-4 w-4" /> ✓ Bill CK này ĐÃ GỬI vào nhóm trước đó — không cần gửi lại.</div>
                  <Button variant="edit" size="sm" onClick={doSend} disabled={sending || (isInvestor ? !investorSendable : !dealerSendable)}>{sending ? 'Đang gửi…' : 'Vẫn gửi lại (hệ thống chặn đăng trùng)'}</Button>
                </div>
              : picking
              ? <div className="flex items-center gap-1.5 text-xs font-medium text-danger"><AlertTriangle className="h-4 w-4" /> Chọn loại + đối tác ở trên rồi bấm "Xác nhận phân loại" trước khi gửi.</div>
              : <Button variant="confirm" icon={<Send className="h-4 w-4" />} onClick={doSend} disabled={sending || (isInvestor ? !investorSendable : !dealerSendable)}>{sending ? 'Đang gửi…' : (isInvestor ? 'Gửi nhóm NĐT' : 'Gửi nhóm đại lý')}</Button>}
          {onPickAnother && <Button variant="soft" size="sm" icon={<Upload className="h-3.5 w-3.5" />} onClick={onPickAnother} disabled={sending}>Chọn ảnh khác</Button>}
        </div>
      </div>
    </div>
  );
}

/** [Admin Demo 3/9] Item TRỐNG để MỞ card kiểm tay khi OCR hụt hết retry — hiện ẢNH (từ token) + form trống cho nhập
 *  tay (TID/lô/tiền) + nút "Quét lại ảnh này". Gửi tay cần đại lý resolve từ TID (bước 2) — hiện tại đủ để XEM + OCR lại. */
function blankReviewItem(): ReviewItem {
  return {
    bill: { tid: null, agencyName: null, batchNumber: null, type: 'SALE', totalAmount: 0, dateTime: null },
    dealerRoomId: null, dealerRoomName: null, investorRoomId: null, investorRoomName: null,
    sellFee: null, installFee: null, alreadySent: false, sentMessageId: null, tidSuggestions: [],
    warnings: ['🔴 OCR KHÔNG đọc được sau 3 lần — nhìn ảnh, bấm "Quét lại ảnh này" để OCR lại, hoặc nhập tay TID/lô/tiền.'],
    dealerSummary: null, investorSummary: null, availableCardTypes: [], hkdName: null, bankName: null,
  };
}

/** [Admin Demo 4/9] Phân loại file khi TẢI LẠI folder — THUẦN (test được) để khoá chặt "đã OCR vs chưa OCR":
 *  · đãOcr   (alreadyOcr=true)                     → BỎ QUA (không quét lại, không đếm đôi)
 *  · đangChờ (chưa OCR + đã có trong danh sách)     → giữ nguyên (không thêm trùng)
 *  · added   (chưa OCR + CHƯA trong danh sách)      → bill MỚI tải về sau → thêm vào cuối. */
export function categorizeReloadFiles<T extends { path: string; alreadyOcr: boolean }>(files: T[], existingPaths: Set<string>): { added: T[]; daOcr: number; dangCho: number } {
  const daOcr = files.filter((f) => f.alreadyOcr).length;
  const dangCho = files.filter((f) => !f.alreadyOcr && existingPaths.has(f.path)).length;
  const added = files.filter((f) => !f.alreadyOcr && !existingPaths.has(f.path));
  return { added, daOcr, dangCho };
}

/** Parse 1 dòng log tự do → các TRƯỜNG (số bill · trạng thái · đại lý · NĐT) để hiện BẢNG chia cột. */
export function parseLogRow(l: string): { warn: boolean; ok: boolean; num: string; status: string; dealer: string; ndt: string; plain: string | null } {
  const warn = l.startsWith('⚠️') || l.startsWith('🔴'), ok = l.startsWith('✓'); // [Admin Demo 3/9] 🔴 = cảnh báo ĐỎ (hết retry).
  const body = l.replace(/^(✓|⚠️|🔴)\s*/, '');
  const bm = /^Bill\s+(\d+)\/(\d+)/.exec(body);
  if (!bm) return { warn, ok, num: '', status: '', dealer: '', ndt: '', plain: body }; // dòng khởi tạo/tổng kết → full-width
  const dealer = /nhóm đại lý\s+"([^"]+)"/.exec(body)?.[1] ?? '';
  const ndt = /cc NĐT\s+"([^"]+)"/.exec(body)?.[1] ?? (/không cc NĐT/.test(body) ? '—' : '');
  let status = '';
  if (/ĐÃ GỬI trước/.test(body)) status = 'Trùng — bỏ qua';
  else if (ok || /đã gửi nhóm/.test(body)) status = 'Đã gửi';
  // [Admin Demo 3/9 — GỐC "loạn Lỗi OCR"] "KHÔNG đọc được / CHƯA ra bill" là UNREAD (ảnh đọc XONG, không thấy bill POS/CK),
  // KHÔNG phải lỗi OCR. PHẢI kiểm TRƯỚC nhánh warn — nếu không, ⚠️ prefix (warn=true) nuốt hết → dán nhầm "Lỗi OCR"
  // cho cả 20 ảnh unread (user thấy toàn "Lỗi OCR" trong khi tổng kết ghi "OCR lỗi: 0 · không đọc được: 20").
  else if (/tự đọc lại|đọc lại lần/.test(body)) status = 'Đang đọc lại…'; // [Admin Demo 3/9] auto-retry OCR (chưa kết luận).
  else if (/MỞ để kiểm tay|sau \d+ lần/.test(body)) status = '🔴 Không đọc được — MỞ kiểm tay'; // hết retry → mở card, không skip.
  else if (/KHÔNG đọc được|CHƯA ra bill/.test(body)) status = 'Không đọc được — kiểm tay';
  // Chỉ nhánh này là LỖI OCR THẬT (timeout/nghẽn/rate). KHÔNG dùng `warn` trơ (mọi ⚠️) — chỉ dòng có "LỖI OCR"/timeout.
  else if (/LỖI OCR|timeout|quá hạn|nghẽn/i.test(body)) {
    // hiện NGUYÊN VĂN lý do. Dòng log: `... LỖI OCR — <lý do> — bấm "Quét lại"`. rỗng/generic mới suy category.
    const rawReason = (/LỖI OCR\s+—\s+(.+?)\s+—\s+bấm/.exec(body)?.[1] ?? /LỖI OCR\s+—\s+(.+)$/.exec(body)?.[1] ?? '').trim();
    const isGeneric = !rawReason || /^CHƯA quét được$/i.test(rawReason);
    const rz = !isGeneric
      ? (rawReason.length > 60 ? rawReason.slice(0, 60) + '…' : rawReason)
      : /quá hạn|timeout|không phản hồi/i.test(rawReason) ? 'quá hạn/nghẽn'
      : /giới hạn|rate|limit/i.test(rawReason) ? 'bị giới hạn (tải cao)'
      : /mạng|network/i.test(rawReason) ? 'lỗi mạng — kiểm kết nối'
      : '';
    status = rz ? `Lỗi OCR: ${rz}` : 'Lỗi OCR';
  }
  else if (/đã quét trước/.test(body)) status = 'Dùng cache';
  else if (/CHUYỂN KHOẢN|xem để gửi/.test(body)) status = 'Đang xem';
  else if (warn) status = 'Cảnh báo'; // ⚠️ khác (lệch TID-HKD, đọc 2 lần lệch…) → KHÔNG gọi là "Lỗi OCR".
  else status = '…';
  return { warn, ok, num: `${bm[1]}/${bm[2]}`, status, dealer, ndt, plain: null };
}

/** NHẬT KÝ QUÉT dạng BẢNG (Admin Demo 2/9 "chia cột, hàng từng trường rõ rệt, hết lộn xộn"): mới nhất LÊN ĐẦU +
 *  4 cột # · Trạng thái · Đại lý · NĐT. Dùng CHUNG cả 2 tab. */
/**
 * BẢNG BÁO CÁO FOLDER (Admin Demo 8/9) — hiện NGAY sau khi quét xong folder.
 * CLONE nguyên bảng của Báo cáo lô: dùng CHÍNH `RevenueLotTable` + bộ cột đại lý (HKD · Bank · TID · Lô · Ngày ·
 * Giờ · Trước phí · %phí · Sau phí), thêm cột cuối "Lỗi / Sửa".
 * Sắp xếp để review: lô CÓ LỖI lên đầu (server sắp), nhìn là thấy ngay việc phải làm.
 * Nút "Sửa" mở LẠI đúng thẻ review OCR của bill đó — KHÔNG hỏi mật khẩu (bill vẫn trong phiên quét, chưa rời màn).
 */
function BangBaoCaoFolder({ bc, dangTai, onSua, onLamMoi }: {
  bc: BaoCaoFolder; dangTai: boolean; onSua: (idx: number) => void; onLamMoi: () => void;
}): JSX.Element {
  const rows: RevenueLotRow[] = bc.rows.map((r) => ({
    ndt: '', daiLy: '', date: r.date, time: r.time, tid: r.tid, lo: r.lo,
    truoc: r.truoc, sau: r.sau, fee: r.fee, bankName: r.bankName, hkdName: r.hkdName
  }));
  const nhan = (t: string): string => (t === 'DA_GHI' ? 'Đã ghi' : t === 'CHUA_GUI' ? 'Chưa gửi' : 'Đọc hụt');
  const mau = (t: string): string => (t === 'DA_GHI' ? 'bg-emerald-100 text-emerald-700' : t === 'CHUA_GUI' ? 'bg-amber-100 text-amber-700' : 'bg-danger/10 text-danger');
  return (
    <div className="glass-panel shadow-soft rounded-2xl border border-brand/30 p-3" data-testid="folder-report">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-base font-bold text-brand-deep">📊 Báo cáo folder vừa quét</span>
        <span className="text-xs text-slate-500">{bc.tong.soBill} bill · đã ghi {bc.tong.daGhi} · chưa gửi {bc.tong.chuaGui} · đọc hụt {bc.tong.docHut}</span>
        {bc.tong.soLoi > 0
          ? <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger">🔴 {bc.tong.soLoi} lô CẦN XỬ</span>
          : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">✓ không có lô lỗi</span>}
        <button type="button" onClick={onLamMoi} disabled={dangTai}
          className="ml-auto rounded-full border border-line bg-white px-3 py-1 text-xs font-bold text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-60">
          {dangTai ? 'Đang tải…' : '↻ Làm mới'}
        </button>
      </div>
      <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-line bg-white px-3 py-2"><div className="text-[10px] uppercase text-slate-400">Tổng trước phí</div><div className="text-lg font-bold tabular-nums text-brand-deep">{fmtVnd(bc.tong.tongTruoc)}</div></div>
        <div className="rounded-xl border border-line bg-white px-3 py-2"><div className="text-[10px] uppercase text-slate-400">Tổng sau phí</div><div className="text-lg font-bold tabular-nums text-success">{fmtVnd(bc.tong.tongSau)}</div></div>
        <div className="rounded-xl border border-line bg-white px-3 py-2"><div className="text-[10px] uppercase text-slate-400">Bill đã ghi doanh số</div><div className="text-lg font-bold tabular-nums text-slate-700">{bc.tong.daGhi}/{bc.tong.soBill}</div></div>
        <div className="rounded-xl border border-line bg-white px-3 py-2"><div className="text-[10px] uppercase text-slate-400">Lô cần xử</div><div className={'text-lg font-bold tabular-nums ' + (bc.tong.soLoi ? 'text-danger' : 'text-success')}>{bc.tong.soLoi}</div></div>
      </div>
      <RevenueLotTable
        rows={rows}
        columns={AGENT_COLUMNS}
        labelTruoc="Trước phí"
        labelSau="Phải hoàn (sau phí)"
        actionWidth="132px"
        renderAction={(_r, i) => {
          const g = bc.rows[i];
          if (!g) return null;
          return (
            <div className="flex min-w-0 flex-col items-center gap-1">
              <span className={'rounded px-1.5 py-0.5 text-[10px] font-bold ' + mau(g.trangThai)}>{nhan(g.trangThai)}</span>
              {g.idx != null && (
                <button type="button" onClick={() => onSua(g.idx as number)} title="Mở lại đúng bill này để sửa (không cần mật khẩu)"
                  className="whitespace-nowrap rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-[11px] font-bold text-brand-deep hover:bg-brand/20">✎ Sửa bill {(g.idx as number) + 1}</button>
              )}
            </div>
          );
        }}
        renderRowNote={(_r, i) => {
          // LỖI của lô: 1 dải TRẢI HẾT chiều ngang dưới hàng (đọc được cả câu) — không nhét vào cột hẹp.
          const g = bc.rows[i];
          if (!g || g.loi.length === 0) return null;
          return (
            <span className="block rounded-lg border border-danger/25 bg-danger/[0.06] px-2 py-1 text-[12px] font-semibold leading-snug text-danger">
              {g.loi.map((l, k) => <span key={k} className="block">{l}</span>)}
            </span>
          );
        }}
      />
    </div>
  );
}

// [Admin Demo 8/9] LỐI TẮT TỪ LOG: dòng cảnh báo (sai giờ/sai ngày/lô nhảy cóc/sót lô…) bấm được để NHẢY THẲNG
// tới bill đó mà sửa, hoặc mở màn Báo cáo lô đúng chỗ — khỏi phải dò tay giữa hàng trăm dòng.
// Số bill lấy từ chính chuỗi log có sẵn ("Bill 7/32"), TID+lô lấy từ dòng sót lô ("(TID 53550071): THIẾU lô 66").
function LogList({ log, fill = false, onMoBill, onMoBaoCaoLo }: { log: string[]; fill?: boolean; onMoBill?: (idx: number) => void; onMoBaoCaoLo?: (tid: string, lo?: string) => void }): JSX.Element {
  const rows = [...log].reverse();
  const stColor = (s: string): string => /Đã gửi|cache/.test(s) ? 'text-emerald-700' : /Lỗi|Chưa/.test(s) ? 'text-amber-700' : /Trùng/.test(s) ? 'text-slate-400' : 'text-brand-deep';
  return (
    <div className={'glass-panel shadow-soft rounded-xl border border-line overflow-hidden ' + (fill ? 'flex flex-col flex-1 min-h-0' : '')}>
      {/* Header cột */}
      <div className="grid shrink-0 grid-cols-[46px_84px_1fr_1fr] gap-2 border-b border-line bg-appbg px-3 py-1.5 text-[9.5px] font-bold uppercase tracking-wide text-slate-400">
        <span>Bill</span><span>Trạng thái</span><span>Đại lý</span><span>NĐT (cc)</span>
      </div>
      <div className={'divide-y divide-line/50 overflow-auto text-xs ' + (fill ? 'flex-1 min-h-0' : 'max-h-60')}>
        {rows.map((l, i) => {
          const r = parseLogRow(l);
          if (r.plain != null) {
            // [Admin Demo 4/9] Dòng SÓT BILL / LÔ THIẾU / LỆCH ĐẾM = NGHIÊM TRỌNG (tiền) → ĐỎ ĐẬM, không để xám nhạt lẫn (user
            // "cảnh báo thiếu lô mà không thấy lô nào"). Nhận theo nội dung: "THIẾU lô" / "NGHI SÓT" / "LỆCH ĐẾM" / "CHƯA ra bill".
            const isSot = /THIẾU lô|NGHI SÓT|LỆCH ĐẾM|CHƯA ra bill|NGÀY LÙI|lô sau mà ngày trước|🔴/.test(l);
            const soBill = docSoBill(l);
            const tidLo = docTidLo(l);
            const coLoiTat = (isSot || r.warn) && ((soBill != null && onMoBill) || (tidLo && onMoBaoCaoLo));
            return (
              <div key={i} className={'px-3 py-1.5 leading-snug ' + (i % 2 ? 'bg-white/40 ' : '') + (isSot ? 'text-danger font-bold' : r.warn ? 'text-amber-700 font-medium' : 'text-slate-500')}>
                {isSot ? '🔴 ' : r.warn ? '⚠️ ' : ''}{r.plain}
                {coLoiTat && (
                  <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
                    {soBill != null && onMoBill && (
                      <button type="button" onClick={() => onMoBill(soBill)} title="Mở đúng bill này để sửa ngay"
                        className="rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-[10px] font-bold text-brand-deep hover:bg-brand/20">→ Sửa bill {soBill + 1}</button>
                    )}
                    {tidLo && onMoBaoCaoLo && (
                      <button type="button" onClick={() => onMoBaoCaoLo(tidLo.tid, tidLo.lo)} title="Mở màn Báo cáo lô ở đúng máy/lô này"
                        className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-600 hover:bg-slate-50">→ Báo cáo lô</button>
                    )}
                  </span>
                )}
              </div>
            );
          }
          return (
            <div key={i} className={'grid grid-cols-[46px_84px_1fr_1fr] items-center gap-2 px-3 py-1.5 ' + (i % 2 ? 'bg-white/40' : '')}>
              <span className="font-mono text-[10px] font-bold tabular-nums text-slate-500">{r.num}</span>
              <span className={'font-semibold ' + stColor(r.status)}>{r.status}</span>
              <span className="min-w-0 truncate text-slate-700" title={r.dealer}>{r.dealer || '—'}</span>
              <span className="min-w-0 truncate text-slate-600" title={r.ndt}>{r.ndt || '—'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** [Admin Demo 16/9 khuya "màn OCR phải hiện TRONG NỀN doanh số, clone 100% tính năng"] Nhận props để NHÚNG
 *  nguyên màn này vào panel con của màn Doanh số — dùng CHÍNH component (không clone code = không lệch tính
 *  năng về sau). `initialMode` chọn tab sẵn; `embedded` bỏ khoảng đệm/độ cao toàn màn cho vừa panel. */
export function OcrSendScreen(
  { initialMode, embedded = false, onSent: onSentExternal }: {
    initialMode?: 'manual' | 'auto' | 'qr';
    embedded?: boolean;
    /** [Admin Demo 17/9] Báo RA NGOÀI mỗi lần gửi xong: màn Doanh số dùng để TỰ ĐÓNG khối OCR + refresh doanh số.
     *  `conBillTiepTheo` = hàng đợi folder còn bill chưa review → KHÔNG đóng (đóng giữa chừng là phá luồng quét). */
    onSent?: (info: SentInfo, conBillTiepTheo: boolean) => void;
  } = {}
): JSX.Element {
  // Khôi phục tab + review thủ công từ sessionStorage (Admin Demo 30/8 "qua menu là mất") — rời menu rồi quay lại
  // GIỮ nguyên bill đang review; card tự khôi phục chi tiết tách thẻ theo token của nó.
  const parentSnap = useMemo(() => { try { return JSON.parse(sessionStorage.getItem('ocrSend.parent') ?? 'null'); } catch { return null; } }, []);
  // [Admin Demo 16/9 khuya] Nút "OCR thủ công/tự động" ở màn Doanh số mở màn này kèm ?mode=manual|auto|qr →
  // ĐỌC tham số để vào ĐÚNG TAB ngay (không có bước này thì nút chỉ mở màn, không chọn chế độ = vô nghĩa).
  const modeTuUrl = ((): 'manual' | 'auto' | 'qr' | null => {
    try {
      const v = new URLSearchParams(window.location.search).get('mode');
      return v === 'manual' || v === 'auto' || v === 'qr' ? v : null;
    } catch { return null; }
  })();
  const [mode, setMode] = useState<'manual' | 'auto' | 'qr'>(initialMode ?? modeTuUrl ?? parentSnap?.mode ?? 'manual');
  // [Admin Demo 17/9] Panel nhúng: bấm nút "OCR tự động" khi đang mở tab "Thủ công" phải ĐỔI TAB. initialMode chỉ là
  // giá trị KHỞI TẠO nên không tự đổi; remount bằng key thì mất tiến trình OCR đang chạy → dùng effect đổi tab,
  // GIỮ nguyên state (bill đang review, hàng đợi folder).
  useEffect(() => { if (initialMode) setMode(initialMode); }, [initialMode]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState<{ token: string; items: ReviewItem[]; cached: boolean; transfers?: TransferReview[]; qr?: QrReviewItem[] } | null>(parentSnap?.manual ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  // [Tab QUÉT QR] refs RIÊNG cho tab QR (upload 1 ảnh + quét folder) — tách khỏi fileRef/folderInputRef của 2 tab kia
  // để CẢ 3 tab mounted đồng thời KHÔNG dẫm ref lên nhau. Handler OCR/gửi TÁI DÙNG y hệt (onPickFile/onFolderPicked).
  const qrFileRef = useRef<HTMLInputElement>(null);
  const qrFolderInputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<string>(() => localStorage.getItem(LS_FOLDER) || '');
  // Khôi phục TIẾN TRÌNH AUTO qua menu (Admin Demo 31/8 "chuyển menu về folder-choose là sai"): giữ bill đang review +
  // log + tiến độ. webFiles (File-object) KHÔNG serialize được → không lưu; nhưng bill ĐANG review (auto) giữ được.
  const [scanned, setScanned] = useState<{ total: number; newCount: number } | null>(parentSnap?.scanned ?? null);
  const [queue, setQueue] = useState<ScanFile[]>([]);
  const [idx, setIdx] = useState<number>(parentSnap?.idx ?? 0);
  // [Admin Demo 6/9] RESUME: key folder hiện tại + banner "đã tiếp tục từ bill N".
  const [folderKey, setFolderKey] = useState<string | null>(parentSnap?.folderKey ?? null);
  const [resumeFrom, setResumeFrom] = useState<number | null>(null);
  // [Admin Demo 6/9] Tiến trình OCR DỞ đã lưu (sống qua văng/crash/đóng app) → hiện NÚT "Tiếp tục OCR dở" khi quay lại.
  const [savedResume, setSavedResume] = useState<{ key: string; idx: number; total: number } | null>(() => {
    try { const s = JSON.parse(localStorage.getItem(LS_RESUME) || 'null') as { key: string; idx: number; total: number } | null; return s && s.idx > 0 ? s : null; } catch { return null; }
  });
  const [auto, setAuto] = useState<{ token: string; items: ReviewItem[]; cached: boolean; transfers?: TransferReview[]; qr?: QrReviewItem[] } | null>(parentSnap?.auto ?? null);
  // [Admin Demo 4/9 "tất cả trường hợp KHÔNG được bỏ qua câm, phải review rõ ràng"] idx bill CẦN KIỂM TAY (ngày lùi /
  // không đọc được / lỗi OCR) → sau scan TỰ MỞ từng bill + banner đỏ lý do; nút "Bill cần kiểm kế" đi hết, cấm bỏ sót.
  const [flagged, setFlagged] = useState<Record<number, { reason: string; suggestDate?: string }>>({});
  const [log, setLog] = useState<string[]>(parentSnap?.log ?? []);
  useEffect(() => {
    try { sessionStorage.setItem('ocrSend.parent', JSON.stringify({ mode, manual, auto, scanned, idx, log, folderKey })); } catch { /* quota */ }
  }, [mode, manual, auto, scanned, idx, log, folderKey]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  // [Admin Demo 17/9] KẾT QUẢ ĐỔI TÊN FILE hiện NGAY trên tab Thủ công/QR — trước chỉ ghi vào nhật ký mà nhật ký chỉ
  // có ở tab Tự động ⇒ đổi được hay lỗi đều câm, người dùng tưởng "chưa đổi tên".
  const [tenFileMoi, setTenFileMoi] = useState<{ ok: boolean; text: string } | null>(null);
  const [webFiles, setWebFiles] = useState<File[]>([]); // ảnh từ folder WEB (webkitdirectory) → OCR lần lượt (File in-mem)
  // EXE (Admin Demo 31/8, FIX FREEZE): danh sách {name,path} — ĐỌC LƯỜI từng ảnh khi tới lượt (RAM ~1 ảnh, không giữ
  // cả folder base64 → hết đơ khi chuyển tab). Nguồn PC tách khỏi webFiles để ocrAt biết đọc-lười vs dùng File sẵn.
  const [pcFiles, setPcFiles] = useState<{ name: string; path: string }[]>([]);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // NÚT DỪNG OCR (Admin Demo 31/8 "bill treo không có nút dừng") — abortRef hủy THẬT request THỦ CÔNG đang chạy (không
  // chờ 150s timeout); pool prefetch (auto) hủy qua poolRef.abortAll(). `stopped`=true → auto KHÔNG tự chạy bill kế.
  const abortRef = useRef<AbortController | null>(null);
  const [stopped, setStopped] = useState(false);
  // Cầu nối EXE (Electron) — readFolderImages trả DANH SÁCH {name,path}; readImageFile đọc 1 ảnh khi tới lượt.
  const pc = (window as unknown as { SigMaPC?: {
    pickFolder?: () => Promise<string | null>;
    readFolderImages?: (p: string) => Promise<{ ok: boolean; files?: { name: string; path: string }[]; error?: string; fromSubDirs?: string[] }>;
    readImageFile?: (p: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
    renameBillFile?: (p: string, newBaseName: string) => Promise<{ ok: boolean; path?: string; name?: string; unchanged?: boolean; error?: string }>;
    /** [Admin Demo 16/9 tối] Chọn ẢNH bill qua dialog Electron → [{name,path}] (có PATH ⇒ tab Thủ công đổi tên được). */
    pickBillFiles?: () => Promise<{ name: string; path: string }[]>;
  } }).SigMaPC;
  const isExe = !!pc?.readFolderImages;

  // [Admin Demo 8/9 — QUY TẮC ĐẶT TÊN MỚI] Sau khi OCR THÀNH CÔNG, đổi tên ảnh thành:
  //     "<TÊN HKD> - <TID> <SỐ LÔ>"     vd: "ABB KHACH HANG 35 M2 - 53550081 0113"
  // để SẮP THEO TÊN là ảnh cùng HKD/cùng TID nằm liền nhau và SỐ LÔ TĂNG DẦN → dò bill cực nhanh.
  //   · SỐ LÔ được ĐỆM 0 cho đủ 4 chữ số ("0113"): sắp theo tên là sắp theo CHUỖI, không đệm thì "10" đứng
  //     trước "9" → thứ tự lô loạn, mất đúng cái lợi mà anh cần.
  //   · Bill CK: "CK <người chuyển> - <ngày>". Bill QR: "<HKD> - QR <số giao dịch>".
  //   · ĐỌC KHÔNG RA → GIỮ NGUYÊN tên gốc, chỉ THÊM " - thất bại" ở đuôi (biết ngay ảnh nào phải kiểm tay).
  //   · Ảnh CHƯA OCR → không đụng tới.
  // CHỈ chạy trên bản EXE (trình duyệt không có quyền ghi file người dùng) và chỉ với nguồn folder-máy (pcFiles).
  /** [Admin Demo 16/9 tối "ocr thủ công chưa đổi tên file"] LÕI đổi tên theo ĐƯỜNG DẪN — dùng chung cho tab Tự động
   *  (qua renameAfterOcr) và tab Thủ công trên EXE (ảnh chọn bằng dialog Electron nên có path thật). */
  async function renameByPath(oldPath: string, oldName: string, label: string | null): Promise<{ path: string; name: string } | null> {
    if (!pc?.renameBillFile || !oldPath) {
      // Web/APK: trình duyệt KHÔNG cho biết đường dẫn và không cho ghi đè file trên đĩa → nói thẳng, đừng để im.
      setTenFileMoi({ ok: false, text: 'Bản web/điện thoại KHÔNG đổi được tên file (trình duyệt chặn) — dùng bản máy tính (.exe) để tự đổi tên.' });
      return null;
    }
    const clean = (label ?? '').replace(/\s+/g, ' ').trim();
    const base = clean ? clean : failBillFileName(oldName || '');
    try {
      const r = await pc.renameBillFile(oldPath, base);
      if (!r.ok) {
        setLog((L) => [...L, `⚠ Không đổi được tên ảnh: ${r.error ?? 'lỗi không rõ'}`]);
        setTenFileMoi({ ok: false, text: `Không đổi được tên ảnh: ${r.error ?? 'lỗi không rõ'}` });
        return null;
      }
      if (r.unchanged || !r.path || !r.name) { setTenFileMoi({ ok: true, text: `Tên file đã đúng, giữ nguyên: ${oldName}` }); return null; }
      setLog((L) => [...L, `📄 Đổi tên ảnh → "${r.name}"`]);
      setTenFileMoi({ ok: true, text: `Đã đổi tên file → ${r.name}` });
      const rp = await renameProcessed({ oldPath, newPath: r.path }); // đồng bộ sổ đã-đọc theo tên mới
      if (!rp.ok) setLog((L) => [...L, `⚠ Đổi tên xong nhưng CHƯA đồng bộ được sổ đã-đọc (${rp.message}).`]);
      return { path: r.path, name: r.name };
    } catch (e) {
      setLog((L) => [...L, `⚠ Không đổi được tên ảnh: ${e instanceof Error ? e.message : String(e)}`]);
      return null;
    }
  }
  /** Nhãn tên file từ kết quả OCR 1 ảnh (POS/CK/QR) — dùng CHUNG quy tắc với tab Tự động. */
  function nhanTenFile(d: { kind?: string; review?: ReviewItem[]; transferReview?: TransferReview[]; qrReview?: QrReviewItem[] }): string | null {
    if (d.kind === 'TRANSFER' && (d.transferReview?.length ?? 0) > 0) {
      const t = d.transferReview![0];
      return t.senderName ? ckBillFileName({ senderName: t.senderName }, undefined) : null;
    }
    if (d.kind === 'QR' && (d.qrReview?.length ?? 0) > 0) {
      const q = d.qrReview![0];
      return qrBillFileName(q.hkdNameMatched ?? q.qr.hkdName, q.qr.ref);
    }
    const items = d.review ?? [];
    return items.length > 0 ? posBillFileName(items) : null;
  }
  async function renameAfterOcr(i: number, label: string | null): Promise<void> {
    if (!pc?.renameBillFile) return;
    const f = pcFilesRef.current[i];
    if (!f?.path) return;
    const clean = (label ?? '').replace(/\s+/g, ' ').trim();
    // Thất bại → giữ NGUYÊN tên cũ + đuôi " - thất bại" (không đánh số lại, không mất tên gốc để đối chiếu Zalo).
    const base = clean ? clean : failBillFileName(f.name || '');
    try {
      const r = await pc.renameBillFile(f.path, base);
      if (!r.ok) { setLog((L) => [...L, `⚠ Không đổi được tên ảnh bill ${i + 1}: ${r.error ?? 'lỗi không rõ'}`]); return; }
      if (r.unchanged || !r.path || !r.name) return;
      const newPath = r.path, newName = r.name;
      // Cập nhật NGAY vào ref (setState chỉ có hiệu lực ở render sau) — nếu không, vòng đổi tên cả nhóm ngay sau đó
      // sẽ dùng ĐƯỜNG DẪN CŨ đã bị đổi → báo "ảnh không tồn tại".
      pcFilesRef.current = pcFilesRef.current.map((x, j) => (j === i ? { name: newName, path: newPath } : x));
      setPcFiles((prev) => prev.map((x, j) => (j === i ? { name: newName, path: newPath } : x)));
      setLog((L) => [...L, `📄 Đổi tên ảnh bill ${i + 1} → "${newName}"`]);
      // ĐỒNG BỘ SỔ server (đã đọc + lỗi) theo tên mới — không làm thì lần quét sau coi đây là ảnh MỚI (mất dấu đã
      // đọc) và sổ lỗi còn trỏ file cũ đã biến mất. Cache NỘI DUNG khoá theo hash ảnh nên vẫn giữ (0 quota).
      const rp = await renameProcessed({ oldPath: f.path, newPath });
      if (!rp.ok) setLog((L) => [...L, `⚠ Đổi tên xong nhưng CHƯA đồng bộ được sổ đã-đọc (${rp.message}) — lần quét sau có thể đọc lại ảnh này.`]);
    } catch (e) {
      setLog((L) => [...L, `⚠ Không đổi được tên ảnh bill ${i + 1}: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }

  function dataUrlToFile(dataUrl: string, name: string): File {
    const [meta, b64] = dataUrl.split(',');
    const mime = /data:([^;]+);/.exec(meta)?.[1] ?? 'image/jpeg';
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }
  function startFolderFiles(files: File[], srcLabel: string): void {
    if (!files.length) { setErr('Thư mục không có ảnh bill.'); return; }
    resetPrefetch(); // xoá cache + hủy job folder cũ trước khi nạp nguồn mới (chống lẫn kết quả).
    setErr(null); setAuto(null); setQueue([]); setPcFiles([]);
    setWebFiles(files); setScanned({ total: files.length, newCount: files.length });
    // RESUME: key = tên thư mục gốc (webkitRelativePath) + số ảnh. Khớp lần trước → nhảy tới bill dở.
    const dirName = files[0]?.webkitRelativePath?.split('/')[0] || srcLabel;
    const key = folderKeyOf(dirName, files.length);
    // AN TOÀN NHẤT (Admin Demo 6/9): LÙI 1 bill so với chỗ dừng → chắc chắn không sót bill đang dở (bill kề trước đã gửi
    // thì dedup chặn gửi lại, chỉ mất công xem lại 1 bill). savedIdx=0 → không resume.
    const savedIdx = readResumeIdx(key, files.length);
    const resume = savedIdx > 0 ? Math.max(0, savedIdx - 1) : 0;
    setFolderKey(key); setIdx(resume); setResumeFrom(savedIdx > 0 ? resume : null);
    setLog([`${srcLabel}: ${files.length} ảnh bill — OCR lần lượt (bill đã quét/đã gửi tự bỏ qua).${resume > 0 ? ` ▶ Tiếp tục từ bill ${resume + 1}.` : ''}`]);
  }
  // EXE (đọc LƯỜI): giữ DANH SÁCH {name,path}, đọc từng ảnh khi tới lượt trong ocrAt (không giữ cả folder trong RAM).
  function startPcFiles(files: { name: string; path: string }[], srcLabel: string, srcKey?: string): void {
    if (!files.length) { setErr('Thư mục không có ảnh bill.'); return; }
    resetPrefetch(); // xoá cache + hủy job folder cũ trước khi nạp nguồn mới (chống lẫn kết quả).
    setErr(null); setAuto(null); setQueue([]); setWebFiles([]);
    setPcFiles(files); setScanned({ total: files.length, newCount: files.length });
    // RESUME: key = đường dẫn folder (EXE ổn định) + số ảnh.
    const key = folderKeyOf(srcKey || files[0]?.path?.replace(/[\\/][^\\/]*$/, '') || srcLabel, files.length);
    const resume = readResumeIdx(key, files.length);
    setFolderKey(key); setIdx(resume); setResumeFrom(resume > 0 ? resume : null);
    setLog([`${srcLabel}: ${files.length} ảnh bill — OCR lần lượt (bill đã quét/đã gửi tự bỏ qua).${resume > 0 ? ` ▶ Tiếp tục từ bill ${resume + 1}.` : ''}`]);
  }
  // EXE: lấy DANH SÁCH ảnh folder qua fs (KHÔNG base64) → đọc lười từng ảnh. WEB: mở webkitdirectory.
  async function loadFolderFromPath(p: string): Promise<void> {
    if (!pc?.readFolderImages) return;
    setBusy(true); setErr(null);
    const r = await pc.readFolderImages(p);
    setBusy(false);
    if (!r.ok || !r.files) { setErr(r.error ?? 'Không đọc được folder.'); return; }
    startPcFiles(r.files, 'Đọc folder đã lưu', p); // p = đường dẫn folder → key resume ổn định
    // [Admin Demo 8/9] Ảnh nằm trong THƯ MỤC CON (vd bill\8.9\QR) → nói rõ lấy từ đâu, tránh tưởng quét nhầm chỗ.
    if (r.fromSubDirs?.length) setLog((L) => [...L, `📂 Thư mục ngoài không có ảnh — đã lấy ảnh từ thư mục con: ${r.fromSubDirs!.join(', ')}.`]);
  }
  async function chooseFolder(): Promise<void> {
    if (isExe && pc?.pickFolder) {
      const p = await pc.pickFolder();
      if (!p) return;
      setFolder(p); localStorage.setItem(LS_FOLDER, p); setSavedMsg('Đã lưu đường dẫn ✓ — lần sau chỉ cần bấm "OCR folder đã lưu".');
      window.setTimeout(() => setSavedMsg(null), 4000);
      await loadFolderFromPath(p);
      return;
    }
    folderInputRef.current?.click(); // WEB: webkitdirectory
  }
  // WEB: đã chọn folder (webkitdirectory) → lấy ảnh bill → OCR lần lượt.
  async function onFolderPicked(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? []).filter((f) => /\.(jpe?g|png|webp|jxl)$/i.test(f.name));
    if (folderInputRef.current) folderInputRef.current.value = '';
    startFolderFiles(files, 'Chọn thư mục');
  }
  const autoTotal = webFiles.length || pcFiles.length || queue.length;
  // [Admin Demo 6/9] RESUME persist: lưu con trỏ bill theo folder vào localStorage (SỐNG qua văng/đóng app) mỗi khi idx đổi.
  useEffect(() => {
    if (!folderKey || autoTotal <= 0) return;
    try { localStorage.setItem(LS_RESUME, JSON.stringify({ key: folderKey, idx, total: autoTotal, at: Date.now() })); } catch { /* quota */ }
  }, [idx, folderKey, autoTotal]);

  // ── PREFETCH OCR SONG SONG (Admin Demo 1/9) ──────────────────────────────────────────────────────────────────
  // Nguồn (webFiles / pcFiles / queue) mirror vào REF để pool (tạo 1 lần, bền qua render) luôn đọc dữ liệu MỚI NHẤT.
  const webFilesRef = useRef<File[]>(webFiles); webFilesRef.current = webFiles;
  const pcFilesRef = useRef<{ name: string; path: string }[]>(pcFiles); pcFilesRef.current = pcFiles;
  const queueRef = useRef<ScanFile[]>(queue); queueRef.current = queue;
  const [tick, setTick] = useState(0);
  const bump = (): void => setTick((t) => t + 1);
  // [Admin Demo 3/9] SET idx đã CHỐT outcome (chống re-log/re-advance). Set (không phải 1 số) để XEM LẠI bill cũ mà KHÔNG
  // đếm trùng: revisit idx đã handled → chỉ HIỂN THỊ, không count/không auto-advance.
  const handledRef = useRef<Set<number>>(new Set());
  const forceIdxRef = useRef(new Set<number>()); // [Admin Demo 3/9] idx cần ĐỌC LẠI (Quét lại ảnh này) → OCR bỏ cache.
  const opusIdxRef = useRef(new Set<number>()); // [Admin Demo 4/9] idx cần đọc lại bằng OPUS (escalate bill nghi đọc sai ngày).
  // [Admin Demo 8/9] "Bill CK ĐẦU TIÊN của NGƯỜI CHUYỂN trong NGÀY (trong folder) là 1, tiếp theo THEO TIME là n+1".
  // Giữ DANH SÁCH bill CK đã đọc (người + ngày + giờ trên bill) → mỗi lần có bill mới thì ĐÁNH SỐ LẠI cả nhóm theo
  // GIỜ và đổi tên những file bị đổi số. KHÔNG đếm theo thứ tự quét: folder có thể không sắp theo giờ (đã có test).
  const ckDsRef = useRef<CkBillDaDoc[]>([]);
  const daCanhBaoRef = useRef(new Set<number>());
  // [Admin Demo 8/9] Gom BILL CỦA FOLDER đang quét (kể cả bill lỗi/chưa gửi) → hết folder dựng BẢNG BÁO CÁO như
  // báo cáo lô. Key = idx ảnh trong folder nên sửa/quét lại 1 bill là ghi đè đúng dòng đó, không đẻ dòng ma.
  const folderBillsRef = useRef(new Map<number, BillTrongFolder>());
  const [baoCaoFolder, setBaoCaoFolder] = useState<BaoCaoFolder | null>(null);
  const [dangTaiBaoCao, setDangTaiBaoCao] = useState(false); // bill từng có cảnh báo → gửi xong thì ghi log "đã sửa"
  const claudeIdxRef = useRef(new Set<number>()); // [8/9; 16/9 OCR máy đã gỡ] idx ép claude=1 khi đọc lại — giờ chỉ theo nút Opus.
  // [Admin Demo 8/9 "vẫn đọc sai liên tục — chuyển sang auto Sonnet, khó thì Opus, phải có NÚT CHỌN"] CHẾ ĐỘ ĐỌC BILL
  // [Admin Demo 16/9 "bỏ hết UI liên quan OCR máy"] Chế độ 'may' đã GỠ (OCR máy khoá cứng server-side): 'sonnet' =
  // đường API chuẩn (Gemini → fallback Claude Sonnet, mặc định) · 'opus' = luôn Opus (bill khó). Nhớ localStorage;
  // giá trị cũ 'may' còn lưu trong máy user → tự nắn về 'sonnet'.
  const LS_ENGINE = 'ocrsend.engine.v1';
  const [engine, setEngine] = useState<'sonnet' | 'opus'>(() => {
    const v = (typeof localStorage !== 'undefined' && localStorage.getItem(LS_ENGINE)) || 'sonnet';
    return v === 'opus' ? 'opus' : 'sonnet';
  });
  const engineRef = useRef(engine); engineRef.current = engine;
  const modeRef = useRef(mode); modeRef.current = mode; // pool đọc tab hiện tại (ép nhánh QR khi ở tab Quét QR)
  useEffect(() => { try { localStorage.setItem(LS_ENGINE, engine); } catch { /* quota */ } }, [engine]);
  // [Admin Demo 3/9 "không đọc được 2 lần thì chạy thêm lần 3, vẫn không được thì MỞ kiểm tay, KHÔNG nhảy cóc"] đếm số
  // lần OCR đã thử cho từng idx. Hụt (lỗi/không-ra-bill) → tự đọc lại tới MAX_OCR_ATTEMPTS lần rồi mới mở card kiểm tay.
  const ocrRetryRef = useRef(new Map<number, number>());
  // Admin Demo 1/9 "log báo rõ CÒN ảnh nào CHƯA OCR được để clear nốt": đếm outcome từng bill (error=OCR lỗi/timeout,
  // unread=đọc-được-nhưng-không-ra-bill-POS/CK) → cuối folder in DÒNG TỔNG KẾT cảnh báo còn bao nhiêu ảnh cần kiểm tay.
  // [Admin Demo 2/9 "lô nhảy cóc không cảnh báo — cấm tái diễn"] ĐỐI SOÁT ĐẦY ĐỦ mỗi folder: đếm MỌI ngả kết cục
  // (shown=đã hiện review · sent=đã gửi trước, bỏ qua · error · unread) + gom (tid→lô) để dò LÔ NHẢY SỐ. Tổng phải
  // = số ảnh; lệch hoặc có lô nhảy → BẢNG LỖI ĐỎ cuối folder (không còn nuốt câm).
  const outcomeRef = useRef<{ error: number; unread: number; sent: number; shown: number; lots: Map<string, { lots: number[]; hkdName?: string | null }>; lotDates: Map<string, { entries: { lot: number; dateMs: number; dateStr: string }[]; hkdName?: string | null }> }>({ error: 0, unread: 0, sent: 0, shown: 0, lots: new Map(), lotDates: new Map() });
  // [Audit 3/9 #25] Đóng góp outcome CỦA TỪNG idx (kind + các lô đã gom) → khi RE-OCR 1 bill (Quét lại / Chạy tiếp) phải
  // UNDO đóng góp cũ trước khi đếm lại, nếu không bill bị đếm 2 lần + lô đẩy trùng → bảng đối soát lệch (lệch-đếm/lô-nhảy giả).
  const outcomeByIdxRef = useRef<Map<number, { kind: 'error' | 'unread' | 'sent' | 'shown'; lots: { tid: string; lot: number }[] }>>(new Map());
  function undoOutcome(i: number): void {
    const rec = outcomeByIdxRef.current.get(i);
    if (!rec) return;
    if (outcomeRef.current[rec.kind] > 0) outcomeRef.current[rec.kind]--;
    for (const { tid, lot } of rec.lots) { const e = outcomeRef.current.lots.get(tid); if (e) { const j = e.lots.indexOf(lot); if (j >= 0) e.lots.splice(j, 1); } }
    outcomeByIdxRef.current.delete(i);
  }
  const doneLoggedRef = useRef(false); // in tổng kết ĐÚNG 1 lần khi hết folder (chống lặp do effect chạy lại).

  // Pool tạo 1 LẦN (useRef) — closures đọc *Ref.current nên luôn thấy nguồn mới; onChange=bump để UI re-render.
  const poolRef = useRef<OcrPrefetchPool<OcrResult> | null>(null);
  if (!poolRef.current) {
    poolRef.current = new OcrPrefetchPool<OcrResult>({
      concurrency: OCR_CONCURRENCY,
      window: OCR_PREFETCH_WINDOW,
      staggerMs: OCR_LAUNCH_STAGGER_MS, // Admin Demo 3/9 — mỗi luồng OCR THẬT khởi động cách nhau 4s (chống bắn đồng thời).
      total: () => webFilesRef.current.length || pcFilesRef.current.length || queueRef.current.length,
      // ĐỊNH DANH bill theo VỊ TRÍ (Admin Demo 2/9 "review loạn lô — bill này hiện lô bill kia"): GỐC = keyOf CŨ chỉ
      // tên+size+lastModified (web) → 2 ảnh Zalo TRÙNG metadata (tên/size/ngày giống nhau) = CÙNG khoá → pool DEDUP
      // gộp làm 1 → phục vụ CHUNG 1 kết quả OCR + CHUNG snapshot → bill A hiện tid/lô/tiền của bill B (CROSS-LẪN,
      // sai tiền khi gửi). FIX: thêm INDEX i vào khoá → MỖI vị trí bill là khoá DUY NHẤT, KHÔNG thể lẫn nhau. Đánh
      // đổi: 2 ảnh y HỆT sẽ OCR 2 lần (tốn nhẹ quota) — chấp nhận, ĐÚNG TIỀN quan trọng hơn.
      keyOf: (i) => {
        const w = webFilesRef.current, p = pcFilesRef.current, q = queueRef.current;
        if (w.length) { const f = w[i]; return `w:${i}:${f?.name}:${f?.size}:${f?.lastModified}`; }
        if (p.length) return `p:${i}:${p[i]?.path}`;
        return `q:${i}:${q[i]?.path}`;
      },
      run: async (i, signal) => {
        const w = webFilesRef.current, p = pcFilesRef.current, q = queueRef.current;
        const force = forceIdxRef.current.has(i); if (force) forceIdxRef.current.delete(i); // "Quét lại ảnh này" → đọc lại, bỏ cache.
        const opus = opusIdxRef.current.has(i); if (opus) opusIdxRef.current.delete(i); // [Admin Demo 4/9] escalate: đọc lại bằng Opus.
        const claudeIdx = claudeIdxRef.current.has(i); if (claudeIdx) claudeIdxRef.current.delete(i); // nút "Đọc lại bằng Claude".
        // [16/9] OCR máy đã gỡ — mọi chế độ đi thẳng API (Gemini → Claude/Opus).
        const eng = engineRef.current;
        const claude = claudeIdx || eng === 'sonnet' || eng === 'opus';
        const opusFinal = opus || eng === 'opus';
        const preferQr = modeRef.current === 'qr'; // đang ở tab "Quét QR" → ép server đọc nhánh QR (chống nhận vơ POS)
        try {
          let r: Awaited<ReturnType<typeof ocrUpload>>;
          if (w.length) {
            r = await ocrUpload(w[i], signal, force, opusFinal, claude, preferQr);
          } else if (p.length) {
            const bridge = (window as unknown as { SigMaPC?: { readImageFile?: (pp: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }> } }).SigMaPC;
            const rd = await bridge?.readImageFile?.(p[i].path);
            if (!rd?.ok || !rd.dataUrl) return { ok: false, message: `không đọc được ảnh — ${rd?.error ?? 'lỗi fs'}` };
            r = await ocrUpload(dataUrlToFile(rd.dataUrl, p[i].name), signal, force, opusFinal, claude, preferQr);
          } else {
            r = await ocrFile(q[i].path, signal, force, opusFinal, claude, preferQr);
          }
          return r.ok ? { ok: true, data: r.data } : { ok: false, aborted: r.error === 'ABORTED', message: r.message };
        } catch (e) {
          const aborted = e instanceof DOMException && e.name === 'AbortError';
          return { ok: false, aborted, message: e instanceof Error ? e.message : 'lỗi mạng' };
        }
      },
      onChange: bump
    });
  }
  const pool = poolRef.current;

  // ĐỔI NGUỒN/folder: xoá cache pool + reset cờ chốt + BỎ cờ "đã dừng" (folder mới = quét lại từ đầu, không kẹt).
  function resetPrefetch(): void { pool.reset(); handledRef.current = new Set(); outcomeByIdxRef.current = new Map(); ocrRetryRef.current = new Map(); setStopped(false); setFlagged({}); outcomeRef.current = { error: 0, unread: 0, sent: 0, shown: 0, lots: new Map(), lotDates: new Map() }; doneLoggedRef.current = false; }
  // DỪNG: hủy request THỦ CÔNG + HỦY THẬT mọi request prefetch đang bay (không chạy nền đốt tiền).
  function stopOcr(): void { abortRef.current?.abort(); pool.abortAll(); setStopped(true); }
  // CHỌN LẠI FOLDER / QUÉT LẠI TỪ ĐẦU (Admin Demo 1/9 "auto kẹt ở bill đang OCR, không có nút chọn lại folder/chạy
  // lại"): hủy hết + xoá nguồn/scan/review → quay về màn CHỌN FOLDER (điều kiện `!auto && !scanned` lại đúng).
  function restartScan(): void {
    abortRef.current?.abort(); pool.abortAll(); resetPrefetch();
    setWebFiles([]); setPcFiles([]); setQueue([]); setScanned(null); setIdx(0); setAuto(null); setLog([]);
  }
  // QUÉT LẠI 1 bill (token hết hạn): bỏ cache slot + ép xử lý lại idx.
  // [Admin Demo 3/9 "Quét lại ảnh này KHÔNG đọc lại, trả cache sai"] force idx này → pool.invalidate + OCR bỏ cache (đọc lại thật).
  // [Admin Demo 8/9 — LỐI TẮT] Mở LẠI đúng bill số i để sửa (KHÔNG tốn lượt OCR — chỉ hiện lại thẻ đã đọc).
  function moBillDeSua(i: number): void {
    const total = webFiles.length || pcFiles.length || queue.length;
    if (i < 0 || i >= total) return;
    handledRef.current.delete(i);
    setAuto(null); setStopped(false); setIdx(i); bump();
    setLog((L) => [...L, `↪ Mở lại bill ${i + 1}/${total} để sửa (từ lối tắt trên log).`]);
  }
  /** Mở màn Báo cáo lô đúng máy/lô đang cảnh báo (mở tab mới để KHÔNG mất phiên quét đang dở). */
  // [Admin Demo 9/9 — BUG: "click cảnh báo sót lô mà KHÔNG có lối tắt đến"] TRƯỚC ĐÂY mở `/app/room-revenue?tid=…` —
  // ROUTE NÀY KHÔNG TỒN TẠI (báo cáo lô nằm ở `/app/chat/:roomId/revenue`) ⇒ bấm ra trang trắng = như không có gì.
  // NAY: hỏi server phòng đại lý của TID (rerouteBill — chính hàm card review dùng) rồi mở ĐÚNG phòng, kèm tid+lô để
  // màn báo cáo tự lọc máy + tô lô. Không resolve được → ghi 1 dòng log nói rõ (KHÔNG im lặng).
  async function moBaoCaoLo(tid: string, lo?: string): Promise<void> {
    const r = await rerouteBill(tid.trim());
    if (!r.ok || !r.data.dealerRoomId) {
      setLog((L) => [...L, `⚠ Không mở được Báo cáo lô cho TID ${tid}: ${r.ok ? 'TID chưa gắn phòng đại lý nào' : r.message}`]);
      return;
    }
    const q = new URLSearchParams({ tid: tid.trim(), ...(lo ? { lo } : {}) }).toString();
    window.open(`${window.location.origin}/app/chat/${encodeURIComponent(r.data.dealerRoomId)}/revenue?${q}`, '_blank', 'noopener');
  }
  /** Nạp BẢNG BÁO CÁO FOLDER từ server (dựng bằng chính hàm báo cáo lô → số khớp tuyệt đối). */
  async function napBaoCaoFolder(): Promise<void> {
    const ds = [...folderBillsRef.current.values()];
    if (ds.length === 0) return;
    setDangTaiBaoCao(true);
    try {
      const r = await fetchFolderReport(ds);
      if (r.ok) setBaoCaoFolder(r.data);
      else setLog((L) => [...L, `⚠ Không dựng được bảng báo cáo folder: ${r.message}`]);
    } catch (e) {
      setLog((L) => [...L, `⚠ Không dựng được bảng báo cáo folder: ${e instanceof Error ? e.message : String(e)}`]);
    } finally { setDangTaiBaoCao(false); }
  }

  function rescanAt(i: number, opus = false, claude = false): void { forceIdxRef.current.add(i); if (opus) opusIdxRef.current.add(i); if (claude) claudeIdxRef.current.add(i); pool.invalidate(i); undoOutcome(i); handledRef.current.delete(i); ocrRetryRef.current.delete(i); setAuto(null); setStopped(false); bump(); } // [#25] undo + reset retry; opus=escalate Opus (bill nghi sai ngày)
  // TIẾP TỤC sau khi Dừng: bỏ kết quả DỞ để OCR lại (giữ done), ép xử lý lại idx.
  function resumeOcr(): void { pool.clearIncomplete(); undoOutcome(idx); handledRef.current.delete(idx); setStopped(false); bump(); } // [#25] undo trước khi xử lại idx

  // DISPLAY (tuần tự): đọc cache[idx] → sẵn thì hiện review NGAY; chưa thì spinner; skip (UNKNOWN/đã gửi/lỗi) thì
  // advance sang bill kế. pump() luôn giữ pool đầy quanh idx (prefetch chạy nền trong lúc user review bill hiện tại).
  useEffect(() => {
    // [Tab QUÉT QR] pipeline quét-folder DÙNG CHUNG cho cả tab 'auto' và 'qr' (tái dùng, không viết lại). Chỉ tab
    // 'manual' (upload đơn lẻ) không dùng vòng lặp folder này.
    if (mode !== 'auto' && mode !== 'qr') return;
    const total = webFiles.length || pcFiles.length || queue.length;
    if (total === 0) return;
    if (idx >= total) {
      setAuto(null);
      // HẾT folder → BẢNG ĐỐI SOÁT 1 lần (Admin Demo 2/9 "phải có bảng lỗi rõ ràng, cấm nuốt câm"): đối chiếu TỔNG ảnh
      // = shown + sent + error + unread (lệch → đỏ) + DÒ LÔ NHẢY SỐ (bắt sót bill kiểu lô 94 KHACH HANG 62 3).
      void napBaoCaoFolder(); // [Admin Demo 8/9] hết folder → LÊN BẢNG BÁO CÁO ngay (không phải bấm gì)
      if (!doneLoggedRef.current) {
        doneLoggedRef.current = true;
        const o = outcomeRef.current;
        const accounted = o.shown + o.sent + o.error + o.unread;
        const gaps = detectLotGaps(o.lots);
        const dateBack = detectLotDateBackward(o.lotDates); // [Admin Demo 4/9] GATE lô↑⟹ngày↑ (bắt đọc sai ngày như lô 68)
        const lines: string[] = [];
        lines.push('════════ BẢNG ĐỐI SOÁT FOLDER ════════');
        lines.push(`• Tổng ảnh: ${total}  |  đã hiện review: ${o.shown}  |  đã gửi trước (bỏ qua): ${o.sent}  |  OCR lỗi/timeout: ${o.error}  |  không đọc được POS/CK: ${o.unread}`);
        if (accounted !== total) {
          lines.push(`🔴 LỆCH ĐẾM: cộng lại = ${accounted} ≠ tổng ${total} → có ${Math.abs(total - accounted)} ảnh KHÔNG được xử lý (kiểm tay NGAY, có thể sót bill).`);
        }
        if (o.error + o.unread > 0) {
          lines.push(`🔴 CÒN ${o.error + o.unread} ảnh CHƯA ra bill (${o.error} lỗi OCR · ${o.unread} không đọc được) — quét lại/kiểm tay để clear nốt.`);
        }
        if (gaps.length > 0) {
          lines.push(`🔴 NGHI SÓT BILL — LÔ NHẢY SỐ (${gaps.length} máy):`);
          for (const g of gaps) lines.push(`    · ${g.hkdName ?? 'TID ' + g.tid} (TID ${g.tid}): THIẾU lô ${g.missing.join(', ')}  (đã thấy ${g.seen[0]}…${g.seen[g.seen.length - 1]}) → tìm ảnh lô ${g.missing.join('/')} gửi/OCR bổ sung.`);
        }
        // [Admin Demo 4/9] GATE lô↑⟹ngày↑: lô to hơn nhưng NGÀY LÙI = bất khả thi → nghi OCR/máy đọc SAI NGÀY. Cờ đỏ + kiểm tay.
        if (dateBack.length > 0) {
          lines.push(`🔴 NGÀY LÙI KHI LÔ TĂNG (${dateBack.length} lô) — nghi ĐỌC SAI NGÀY, kiểm tay + sửa ngày:`);
          for (const d of dateBack) lines.push(`    · ${d.hkdName ?? 'TID ' + d.tid} (TID ${d.tid}): lô ${d.lot} ngày ${d.date} < lô ${d.prevLot} ngày ${d.prevDate} (lô sau mà ngày trước!) → sửa ngày lô ${d.lot} cho khớp dãy.`);
        }
        if (gaps.length === 0 && dateBack.length === 0 && accounted === total && o.error + o.unread === 0) {
          lines.push('✓ Không lệch đếm, không lô nhảy, không ngày lùi — KHÔNG sót bill.');
        }
        lines.push('═══════════════════════════════════════');
        setLog((L) => [...L, ...lines]);
        // [Admin Demo 4/9 "MỌI trường hợp cấm bỏ qua câm, phải review rõ ràng"] gom idx bill CẦN KIỂM TAY: ngày-lùi +
        // không-đọc-được + lỗi-OCR → TỰ MỞ bill đầu tiên + banner đỏ; nút "Bill cần kiểm kế" đi hết.
        const flag: Record<number, { reason: string; suggestDate?: string }> = {};
        for (const d of dateBack) {
          for (const [ix, rec] of outcomeByIdxRef.current) {
            if (rec.lots.some((l) => l.tid === d.tid && l.lot === d.lot)) {
              const dm = /^(\d{1,2}\/\d{1,2}\/\d{4})/.exec(d.prevDate);
              flag[ix] = { reason: `🔴 NGÀY LÙI: lô ${d.lot} đọc NGÀY ${d.date} < lô ${d.prevLot} (${d.prevDate}) — lô sau mà ngày trước = nghi máy/OCR SAI NGÀY. Sửa ngày về ${dm?.[1] ?? 'ngày lô kề'} rồi gửi lại.`, suggestDate: dm?.[1] };
              break;
            }
          }
        }
        for (const [ix, rec] of outcomeByIdxRef.current) {
          if (flag[ix]) continue;
          if (rec.kind === 'unread') flag[ix] = { reason: '🔴 KHÔNG đọc được bill — nhìn ảnh, "Quét lại"/"Đọc lại (Opus)" hoặc nhập tay.' };
          else if (rec.kind === 'error') flag[ix] = { reason: '🔴 LỖI OCR — đọc lại/kiểm tay, không bỏ qua.' };
        }
        setFlagged(flag);
        const need = Object.keys(flag).map(Number).sort((a, b) => a - b);
        if (need.length > 0) { setLog((L) => [...L, `🔴 ${need.length} BILL CẦN KIỂM TAY — tự mở lần lượt (cấm bỏ qua). Sửa/xác nhận từng bill.`]); setAuto(null); handledRef.current.delete(need[0]); setIdx(need[0]); bump(); }
      }
      return;
    }
    if (stopped) return;
    pool.pump(idx);
    // [Admin Demo 3/9] firstTime = idx CHƯA chốt outcome. Chỉ ĐẾM + AUTO-ADVANCE + LOG ở firstTime; revisit (xem lại bill
    // cũ qua nút Trước) → chỉ HIỂN THỊ lại, KHÔNG đếm trùng, KHÔNG tự nhảy bill.
    const firstTime = !handledRef.current.has(idx);
    const name = webFiles.length ? webFiles[idx]?.name : pcFiles.length ? pcFiles[idx]?.name : queue[idx]?.name;
    const entry = pool.get(idx);
    if (!entry || entry.status === 'pending') { setAuto(null); return; } // chưa xong → spinner "đang OCR bill idx".
    if (entry.status === 'aborted') return; // đã bị Dừng — chờ user "Tiếp tục".
    handledRef.current.add(idx); // CHỐT: bill này đã xử lý (revisit sau chỉ hiển thị).
    if (entry.status === 'error') {
      const tries = ocrRetryRef.current.get(idx) ?? 0;
      // [Admin Demo 3/9] TỰ đọc lại tới đủ MAX_OCR_ATTEMPTS lần TRƯỚC khi bỏ cuộc — KHÔNG nhảy cóc ngay lần đầu hụt.
      if (firstTime && tries < MAX_OCR_ATTEMPTS - 1) {
        ocrRetryRef.current.set(idx, tries + 1);
        setLog((L) => [...L, `Bill ${idx + 1}/${total} (${name}): OCR chưa ra (lần ${tries + 1}/${MAX_OCR_ATTEMPTS}) — tự đọc lại…`]);
        forceIdxRef.current.add(idx); pool.invalidate(idx); handledRef.current.delete(idx); setAuto(null); bump();
        return; // chờ đọc lại; CHƯA đếm, CHƯA nhảy bill.
      }
      // Hết retry → GIỮ bill, MỞ card kiểm tay + OCR lại (KHÔNG bỏ qua). Log ĐỎ.
      if (firstTime) {
        outcomeRef.current.error++; outcomeByIdxRef.current.set(idx, { kind: 'error', lots: [] }); // [#25] ghi đóng góp để undo khi re-OCR
        setLog((L) => [...L, `🔴 Bill ${idx + 1}/${total} (${name}): KHÔNG đọc được sau ${MAX_OCR_ATTEMPTS} lần (${entry.message || 'OCR hụt'}) — MỞ để kiểm tay + OCR lại (không bỏ qua).`]);
        void renameAfterOcr(idx, null); // → giữ tên gốc + " - thất bại"
      }
      setAuto({ token: '', items: [blankReviewItem()], cached: false }); // token rỗng (lỗi cứng, ảnh có thể mất) → card hiện form + nút Quét lại.
      return;
    }
    const data = entry.result;
    // [Admin Demo 7/9] LOG RÕ: từng bill đọc CACHE (0 quota) hay OCR MỚI (tốn quota) + đã tới bước phân loại/mở review.
    if (firstTime) setLog((L) => [...L, data.cached
      ? `📁 Bill ${idx + 1}/${total} (${name}): ĐỌC CACHE (đã quét trước — 0 quota) → phân loại xong, mở review.`
      : `🔍 Bill ${idx + 1}/${total} (${name}): OCR MỚI (Sonnet@2400 — tốn quota) → đọc xong, mở review.`]);
    // BILL CHUYỂN KHOẢN: LUÔN hiện card để review + gửi (KHÔNG skip), kể cả transferReview rỗng (kiểm tay).
    if (data.kind === 'TRANSFER') {
      const trs = data.transferReview ?? [];
      // [Audit 3/9 #16] ĐẾM bill CK vào đối soát (như 'shown') — trước đây KHÔNG đếm → folder trộn POS+CK báo 'LỆCH ĐẾM'
      // GIẢ (accounted < total) → mòn lưới chống-sót kiểu lô-94. CK cũng là 1 bill đã xử lý.
      if (firstTime) { outcomeRef.current.shown++; outcomeByIdxRef.current.set(idx, { kind: 'shown', lots: [] }); }
      if (firstTime) setLog((L) => [...L, trs.length > 0
        ? `Bill ${idx + 1}/${total} (${name}): bill CHUYỂN KHOẢN — xem để gửi nhóm đại lý.`
        : `Bill ${idx + 1}/${total} (${name}): bill CHUYỂN KHOẢN nhưng không đọc được chi tiết — kiểm tay (KHÔNG bỏ qua).`]);
      // Đổi tên: bill CK → tên NGƯỜI CK (người gửi); OCR không ra người gửi thì lấy người nhận; không có gì → chưa thành công.
      if (firstTime) {
        const t0 = trs[0];
        const nguoiCk = tenNgan(t0?.senderName ?? t0?.receiverName);
        if (!nguoiCk) void renameAfterOcr(idx, null); // không rõ người chuyển → coi như đọc hụt ("- thất bại")
        else {
          ckDsRef.current = [...ckDsRef.current.filter((x) => x.idx !== idx), { idx, nguoi: nguoiCk, ngay: t0?.date ?? null, gio: t0?.time ?? null }];
          const soTheoGio = danhSoCkTheoGio(ckDsRef.current);
          void (async () => {
            // Đổi tên CẢ NHÓM (bill mới có thể chen vào giữa → số của các bill sau phải dịch). renameAfterOcr tự bỏ
            // qua khi tên không đổi nên không đụng đĩa thừa.
            for (const b of ckDsRef.current) {
              await renameAfterOcr(b.idx, ckBillFileName({ senderName: b.nguoi }, soTheoGio.get(b.idx)));
            }
          })();
        }
      }
      setAuto({ token: data.token, items: [], cached: data.cached === true, transfers: trs });
      return;
    }
    // BILL QR BÁN HÀNG (Đợt 2) — hiện card QR để review + gửi (ghi doanh số + hoàn đại lý). Đếm 'shown' cho đối soát.
    if (data.kind === 'QR') {
      const qrs = data.qrReview ?? [];
      if (firstTime) { outcomeRef.current.shown++; outcomeByIdxRef.current.set(idx, { kind: 'shown', lots: [] }); }
      if (firstTime) setLog((L) => [...L, qrs.length > 0
        ? `Bill ${idx + 1}/${total} (${name}): bill QR bán hàng — xem để ghi doanh số + hoàn đại lý.`
        : `Bill ${idx + 1}/${total} (${name}): bill QR nhưng không đọc được chi tiết — kiểm tay (KHÔNG bỏ qua).`]);
      // Đổi tên: bill QR → TÊN HKD. App ngân hàng cắt tên → dùng SỐ GIAO DỊCH (vẫn là đọc được, không phải thất bại).
      if (firstTime) {
        const q0 = qrs[0];
        const nhan = q0 ? qrBillFileName(q0.hkdNameMatched ?? q0.qr.hkdName, q0.qr.ref) : null;
        void renameAfterOcr(idx, nhan);
      }
      setAuto({ token: data.token, items: [], cached: data.cached === true, qr: qrs });
      return;
    }
    // UNKNOWN / không có review POS → TỰ đọc lại tới MAX_OCR_ATTEMPTS, vẫn hụt → MỞ ẢNH kiểm tay (KHÔNG nhảy cóc).
    if (data.kind === 'UNKNOWN' || (data.review ?? []).length === 0) {
      const tries = ocrRetryRef.current.get(idx) ?? 0;
      if (firstTime && tries < MAX_OCR_ATTEMPTS - 1) {
        ocrRetryRef.current.set(idx, tries + 1);
        setLog((L) => [...L, `Bill ${idx + 1}/${total} (${name}): OCR chưa ra bill (lần ${tries + 1}/${MAX_OCR_ATTEMPTS}) — tự đọc lại…`]);
        forceIdxRef.current.add(idx); pool.invalidate(idx); handledRef.current.delete(idx); setAuto(null); bump();
        return; // chờ đọc lại; CHƯA đếm, CHƯA nhảy bill.
      }
      if (firstTime) {
        outcomeRef.current.unread++; outcomeByIdxRef.current.set(idx, { kind: 'unread', lots: [] }); // [#25]
        setLog((L) => [...L, `🔴 Bill ${idx + 1}/${total} (${name}): KHÔNG đọc được POS/CK sau ${MAX_OCR_ATTEMPTS} lần — MỞ ảnh để kiểm tay + OCR lại (không bỏ qua).`]);
        void renameAfterOcr(idx, null); // → giữ tên gốc + " - thất bại"
      }
      setAuto({ token: data.token, items: [blankReviewItem()], cached: false }); // hiện ẢNH + form nhập tay + nút Quét lại (KHÔNG skip).
      return;
    }
    const items = data.review ?? [];
    // ĐỐI SOÁT: gom (tid→lô) để dò lô nhảy — CHỈ firstTime (revisit không gom lại → không nhân đôi dãy lô).
    const idxLots: { tid: string; lot: number }[] = []; // [#25] lô idx này đóng góp → để undo khi re-OCR.
    if (firstTime) for (const it of items) {
      const tid = (it.bill?.tid ?? '').trim();
      const lot = parseLotNumber(it.bill?.batchNumber);
      if (!tid || lot == null) continue;
      const e = outcomeRef.current.lots.get(tid) ?? { lots: [], hkdName: it.hkdName ?? null };
      e.lots.push(lot); idxLots.push({ tid, lot });
      if (!e.hkdName && it.hkdName) e.hkdName = it.hkdName;
      outcomeRef.current.lots.set(tid, e);
      // [Admin Demo 4/9] GATE lô↑⟹ngày↑: gom (tid → lô + ngày OCR) để dò "lô to hơn nhưng ngày lùi" (nghi đọc sai ngày).
      const dateStr = (it.bill?.dateTime ?? '').trim();
      const dateMs = parseBillDateMs(dateStr);
      if (dateMs != null) {
        const d = outcomeRef.current.lotDates.get(tid) ?? { entries: [], hkdName: it.hkdName ?? null };
        d.entries.push({ lot, dateMs, dateStr });
        if (!d.hkdName && it.hkdName) d.hkdName = it.hkdName;
        outcomeRef.current.lotDates.set(tid, d);
      }
    }
    // Bill ĐÃ GỬI rồi (Admin Demo 2/9 "re-OCR phải HIỆN lại bill POS đã ocr, không chỉ CK"): VẪN HIỆN card (badge ĐÃ GỬI
    // ở dòng dưới) để anh xem/sửa/gửi lại nếu cần — KHÔNG nuốt câm. Đếm 'sent' để bảng đối soát khớp tổng (firstTime).
    if (items.length > 0 && items.every((it) => it.alreadySent)) {
      if (firstTime) {
        outcomeRef.current.sent++; outcomeByIdxRef.current.set(idx, { kind: 'sent', lots: idxLots }); // [#25]
        setLog((L) => [...L, `Bill ${idx + 1}/${total} (${name}): ĐÃ GỬI trước đó — hiện lại để xem (không gửi trùng trừ khi bấm gửi).`]);
        void renameAfterOcr(idx, posBillFileName(items)); // → "<HKD> - <TID> <lô>"
      }
      setAuto({ token: data.token, items: data.review, cached: data.cached === true });
      return;
    }
    if (firstTime) {
      outcomeRef.current.shown++; outcomeByIdxRef.current.set(idx, { kind: 'shown', lots: idxLots }); // [#25]
      // [Admin Demo 3/9 "log nhảy cóc, quy trình xiết kiểu gì?"] TRƯỚC ĐÂY bill POS đọc-xong-vào-review KHÔNG ghi dòng log
      // (chỉ tăng đếm) → bill đọc-được vẫn "biến mất" khỏi bảng → nhìn như sót/nhảy cóc. NAY: MỌI bill đọc xong ghi 1
      // dòng NGAY (kèm TID+lô) → số duy nhất còn thiếu là bill đang đọc THẬT (pending), không phải bill bị nuốt.
      const tids = [...new Set(items.map((it) => (it.bill?.tid ?? '').trim()).filter(Boolean))];
      const lots = [...new Set(idxLots.map((l) => l.lot))];
      const tidStr = tids.length ? ` — TID ${tids.join(', ')}` : '';
      const lotStr = lots.length ? ` · lô ${lots.join(', ')}` : '';
      setLog((L) => [...L, `Bill ${idx + 1}/${total} (${name}): đọc xong POS${tidStr}${lotStr} — đang xem để gửi.`]);
      void renameAfterOcr(idx, posBillFileName(items)); // → "<HKD> - <TID> <lô>" (nhiều bill 1 ảnh → gộp lô bằng +)
    }
    // [Admin Demo 8/9] Ghi bill này vào danh sách folder (để cuối folder lên bảng báo cáo).
    {
      const it0 = items[0];
      folderBillsRef.current.set(idx, {
        idx, fileName: name ?? null,
        tid: (it0?.bill?.tid ?? '').trim() || null,
        lo: (it0?.bill?.batchNumber ?? '') || null,
        dateTime: it0?.bill?.dateTime ?? null,
        amount: items.reduce((sum, it) => sum + (it.bill?.totalAmount ?? 0), 0),
        roomId: it0?.dealerRoomId ?? null,
        sent: it0?.alreadySent ?? false
      });
    }
    // [Admin Demo 8/9] Bill có cảnh báo ĐỎ (gate ngày/số lô/gán nhầm máy…) → ghi nhớ để khi gửi xong in dòng "ĐÃ SỬA".
    if (items.some((it) => (it.warnings ?? []).some((w) => laCanhBao(w)))) daCanhBaoRef.current.add(idx);
    setAuto({ token: data.token, items: data.review, cached: data.cached === true });
    // eslint-disable-next-line
  }, [idx, tick, mode, stopped, webFiles, pcFiles, queue]);

  const poolActive = pool.activeJobs > 0; // có job OCR prefetch đang chạy nền (dùng cho spinner tiến trình).
  // [Tab QUÉT QR] folderMode = tab dùng vòng lặp quét-folder (auto + qr) → spinner/trạng thái OCR áp cho cả 2.
  const folderMode = mode === 'auto' || mode === 'qr';
  const curEntry = folderMode ? pool.get(idx) : undefined;
  // [Audit 3/9 #18] currentLoading = ĐANG OCR THẬT (entry chưa có / pending). KHÔNG tính bill đã xong-LỖI/UNKNOWN
  // (revisit qua nút ← Trước) → tránh spinner "Đang OCR" KẸT VĨNH VIỄN cho bill đã OCR xong nhưng không ra card.
  const currentLoading = folderMode && autoTotal > 0 && idx < autoTotal && !auto && !stopped && (!curEntry || curEntry.status === 'pending');
  // Bill đã OCR XONG nhưng không có card (lỗi/không-ra-bill) mà đang xem lại (auto null) → hiện thông báo + nút tiến, KHÔNG spinner.
  const curDoneNoCard = folderMode && autoTotal > 0 && idx < autoTotal && !auto && !stopped && !!curEntry && curEntry.status !== 'pending';
  // [Admin Demo 3/9 "bill đã sửa re-OCR không giữ trạng thái"] snapBase (giữ chỉnh sửa loại-hoàn/đối-tác/ngày qua re-OCR)
  // PHẢI ổn định THEO ẢNH (KHÔNG theo vị trí). keyOf pool nay có INDEX (chống loạn) → KHÔNG dùng cho snap (re-scan đổi
  // vị trí → mất snap). Dùng định-danh ẢNH riêng (path/tên+size) — ổn định qua mọi lần quét.
  const imgId = (i: number): string => {
    // [Audit 3/9 #15/#17] WEB: name:size:lastModified có thể TRÙNG giữa 2 ảnh Zalo khác nhau → CHUNG snap → chỉnh sửa
    // (tid/lô/tiền) bill A đè bill B (sai tiền/máy). Thêm INDEX → duy nhất. Web KHÔNG re-scan-reorder nên index ỔN ĐỊNH.
    // PC/QUEUE giữ path (đã duy nhất + ổn định qua re-scan folder — KHÔNG thêm index để không mất snap khi đổi thứ tự).
    if (webFiles.length) { const f = webFiles[i]; return `w:${i}:${f?.name}:${f?.size}:${f?.lastModified}`; }
    if (pcFiles.length) return `p:${pcFiles[i]?.path}`;
    return `q:${queue[i]?.path}`;
  };

  /** [Admin Demo 16/9 tối] TAB THỦ CÔNG trên EXE: chọn ảnh bằng dialog Electron (có PATH) → OCR → ĐỔI TÊN FILE.
   *  Chọn nhiều ảnh → đẩy sang luồng folder (tab Tự động) vì đó là pipeline hàng loạt sẵn có. */
  async function onPickFileExe(preferQr = false): Promise<void> {
    if (!pc?.pickBillFiles || !pc.readImageFile) return;
    const ds = await pc.pickBillFiles();
    if (!ds || ds.length === 0) return;
    if (ds.length > 1) { startPcFiles(ds, `Chọn ${ds.length} ảnh (máy)`, `pick:${ds[0].path}`); setMode('auto'); return; }
    const f0 = ds[0];
    setBusy(true); setErr(null); setManual(null); setStopped(false); setTenFileMoi(null);
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      const rd = await pc.readImageFile(f0.path);
      if (!rd.ok || !rd.dataUrl) { setBusy(false); setErr(`Không đọc được ảnh: ${rd.error ?? 'lỗi không rõ'}`); return; }
      const r = await ocrUpload(dataUrlToFile(rd.dataUrl, f0.name), ctrl.signal, false, engineRef.current === 'opus', true, preferQr);
      setBusy(false);
      if (!r.ok && r.error === 'ABORTED') { setErr('Đã DỪNG OCR.'); return; }
      if (!r.ok) { setErr(r.message); return; }
      const d = r.data;
      void renameByPath(f0.path, f0.name, nhanTenFile(d)); // đọc hụt → nhãn null → "<tên cũ> - thất bại"
      if (d.kind === 'TRANSFER' && (d.transferReview?.length ?? 0) > 0) { setManual({ token: d.token, items: [], cached: d.cached === true, transfers: d.transferReview }); return; }
      if (d.kind === 'QR' && (d.qrReview?.length ?? 0) > 0) { setManual({ token: d.token, items: [], cached: d.cached === true, qr: d.qrReview }); return; }
      if (d.kind === 'UNKNOWN' || (d.review ?? []).length === 0) { setErr('Không đọc được bill POS/chuyển khoản/QR từ ảnh này.'); return; }
      setManual({ token: d.token, items: d.review, cached: d.cached === true });
    } catch (err) {
      setBusy(false);
      setErr(`Lỗi/timeout OCR — thử lại. (${err instanceof Error ? err.message : 'lỗi mạng'})`);
    }
  }
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    // ĐỒNG NHẤT với TAB TỰ ĐỘNG (Admin Demo 31/8 "auto ok, thủ công treo trắng, không có nút cancel"): manual DÙNG CHUNG
    // AbortController (nút "Dừng OCR" hủy THẬT) + try/catch (lỗi/timeout/abort → KHÔNG treo/không trắng màn) + xử lý
    // ĐỦ kind (POS/TRANSFER/UNKNOWN) như ocrAt. Trước đây manual chỉ ocrUpload trần → treo + không hiện bill CK.
    setBusy(true); setErr(null); setManual(null); setStopped(false); setTenFileMoi(null);
    const ctrl = new AbortController(); abortRef.current = ctrl;
    let r: Awaited<ReturnType<typeof ocrUpload>>;
    try {
      r = await ocrUpload(f, ctrl.signal, false, engineRef.current === 'opus', true); // [16/9] OCR máy đã gỡ — mọi bill đi thẳng API
    } catch (err) {
      setBusy(false);
      setErr(`Lỗi/timeout OCR — thử lại. (${err instanceof Error ? err.message : 'lỗi mạng'})`);
      return;
    }
    setBusy(false);
    if (!r.ok && r.error === 'ABORTED') { setErr('Đã DỪNG OCR.'); return; }
    if (!r.ok) { setErr(r.message); return; }
    // BILL CHUYỂN KHOẢN HOÀN TIỀN (kind=TRANSFER) — hiện card hoàn tiền (gửi CHỈ đại lý), như tab tự động.
    if (r.data.kind === 'TRANSFER' && (r.data.transferReview?.length ?? 0) > 0) {
      setManual({ token: r.data.token, items: [], cached: r.data.cached === true, transfers: r.data.transferReview }); return;
    }
    // BILL QR BÁN HÀNG (Đợt 2) — "Thanh toán thành công" → card QR (ghi doanh số + hoàn đại lý CHỌN từ dropdown).
    if (r.data.kind === 'QR' && (r.data.qrReview?.length ?? 0) > 0) {
      setManual({ token: r.data.token, items: [], cached: r.data.cached === true, qr: r.data.qrReview }); return;
    }
    if (r.data.kind === 'UNKNOWN' || (r.data.review ?? []).length === 0) { setErr('Không đọc được bill POS/chuyển khoản/QR từ ảnh này.'); return; }
    setManual({ token: r.data.token, items: r.data.review, cached: r.data.cached === true });
  }

  async function doScan(): Promise<void> {
    // Reset webFiles (nguồn WEB) để KHÔNG lẫn nguồn — nếu trước đó chọn folder web thì quét-path-PC phải dùng
    // queue mới, không dùng webFiles cũ (bug MEDIUM audit 30/8).
    resetPrefetch(); // xoá cache + hủy job folder cũ trước khi quét folder mới (chống lẫn kết quả).
    setBusy(true); setErr(null); setAuto(null); setLog([]); setScanned(null); setQueue([]); setWebFiles([]); setPcFiles([]);
    const r = await scanFolder(folder.trim());
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    localStorage.setItem(LS_FOLDER, folder.trim());
    const newFiles = r.data.files.filter((f) => !f.alreadyOcr);
    setScanned({ total: r.data.count, newCount: r.data.newCount });
    setQueue(newFiles); setIdx(0);
    const startLines = [`Phát hiện ${r.data.count} bill: ${r.data.newCount} MỚI · ${r.data.count - r.data.newCount} đã quét trước (bỏ qua, không đốt quota).`];
    // [Admin Demo 2/9] file đuôi lạ (.heic/.pdf...) KHÔNG vào phép đếm → cảnh báo NGAY để anh không sót bill nằm trong đó.
    const suspect = (r.data as { suspectBillFiles?: string[]; suspectBillCount?: number }).suspectBillFiles ?? [];
    const suspectN = (r.data as { suspectBillCount?: number }).suspectBillCount ?? suspect.length;
    if (suspectN > 0) startLines.push(`🔴 CẢNH BÁO: folder còn ${suspectN} file KHÔNG phải ảnh nhận dạng được (${suspect.slice(0, 6).join(', ')}${suspect.length > 6 ? '…' : ''}) — có thể là BILL (.heic/.pdf/.bmp…) mà máy CHƯA đọc được. Đổi sang .jpg/.png rồi quét lại, đừng bỏ sót.`);
    setLog(startLines);
  }

  // [Admin Demo 4/9] TẢI LẠI FOLDER ĐANG CHỌN — sau khi chọn folder rồi mới tải thêm bill về → đọc lại folder CŨ, CHỈ THÊM
  // bill MỚI vào CUỐI (không reset, GIỮ tiến độ + bill đang review). Chạy đúng CẢ 3 NỀN (EXE fs / path-scan / WEB picker).
  async function reloadFolder(): Promise<void> {
    if (busy) return;
    // EXE (Electron): đọc lại folder theo path đã lưu (folder state) → merge pcFiles mới theo path.
    if (isExe && pc?.readFolderImages && folder.trim()) {
      setBusy(true); setErr(null);
      const r = await pc.readFolderImages(folder.trim());
      setBusy(false);
      if (!r.ok || !r.files) { setErr(r.error ?? 'Không đọc được folder.'); return; }
      const files = r.files;
      const existing = new Set(pcFilesRef.current.map((f) => f.path));
      const added = files.filter((f) => !existing.has(f.path)); // MỚI = chưa có trong danh sách; đã có (đã OCR/đang chờ) → giữ nguyên, KHÔNG quét lại
      if (added.length === 0) { setLog((L) => [...L, `🔄 Tải lại folder: KHÔNG có bill mới (tổng ${files.length} ảnh, danh sách đã đủ — bill đã OCR/đang chờ giữ nguyên).`]); return; }
      setPcFiles((q) => [...q, ...added]);
      setScanned((s) => (s ? { total: s.total + added.length, newCount: s.newCount + added.length } : { total: files.length, newCount: added.length }));
      setLog((L) => [...L, `🔄 Tải lại folder: +${added.length} bill MỚI → thêm vào CUỐI, giữ tiến độ (tổng ${files.length} ảnh; bill đã OCR/đang chờ KHÔNG quét lại).`]);
      return;
    }
    // Path-scan (queue): scanFolder có cờ alreadyOcr → phân 3 nhóm rạch ròi (đã OCR / đang chờ / mới).
    if (folder.trim() && queueRef.current.length > 0) {
      setBusy(true); setErr(null);
      const r = await scanFolder(folder.trim());
      setBusy(false);
      if (!r.ok) { setErr(r.message); return; }
      const { added, daOcr, dangCho } = categorizeReloadFiles(r.data.files, new Set(queueRef.current.map((q) => q.path)));
      const breakdown = `tổng ${r.data.count} · đã OCR ${daOcr} (bỏ qua) · đang chờ ${dangCho} · MỚI ${added.length}`;
      if (added.length === 0) { setLog((L) => [...L, `🔄 Tải lại folder: KHÔNG có bill mới — ${breakdown}.`]); return; }
      setQueue((q) => [...q, ...added]);
      setScanned((s) => (s ? { total: s.total + added.length, newCount: s.newCount + added.length } : { total: r.data.count, newCount: added.length }));
      setLog((L) => [...L, `🔄 Tải lại folder: +${added.length} bill MỚI → thêm vào CUỐI, giữ tiến độ. [${breakdown}]`]);
      return;
    }
    // WEB: trình duyệt KHÔNG cho đọc lại folder tự động (bảo mật) → mở LẠI picker để chọn lại folder (nạp ảnh mới).
    setLog((L) => [...L, `🔄 Web: trình duyệt không cho tự đọc lại folder — bấm chọn LẠI folder để nạp ảnh mới tải về.`]);
    folderInputRef.current?.click();
  }

  function onSentAuto(info: SentInfo): void {
    const total = webFiles.length || pcFiles.length || queue.length;
    setLog((L) => [...L, `✓ Bill ${idx + 1}/${total}: đã gửi nhóm đại lý "${info.dealer}"${info.investor ? ` + cc NĐT "${info.investor}"` : ' (không cc NĐT)'}.`]);
    // [Admin Demo 8/9 "sửa xong phải đồng bộ dữ liệu, cập nhật log đã sửa"] Bill từng bị cảnh báo mà nay gửi được →
    // ghi 1 dòng CHỐT để nhìn log biết việc đã xử lý xong, không phải dò lại cảnh báo cũ ở phía trên.
    const b0 = folderBillsRef.current.get(idx);
    if (b0) {
      // [24/9] ĐỒNG BỘ BẢN SỬA: ghi đè tid/lô/ngày-giờ/tiền bằng GIÁ TRỊ THẬT vừa gửi (info.billSent) — nếu chỉ
      // set sent=true như trước thì bảng báo cáo vẫn dò theo số OCR cũ ⇒ "đã sửa mà ngoài không đổi".
      const bs = info.billSent;
      folderBillsRef.current.set(idx, bs
        ? { ...b0, sent: true, tid: (bs.tid ?? '').trim() || null, lo: (bs.lo ?? '') || null, dateTime: bs.dateTime, amount: bs.amount }
        : { ...b0, sent: true });
    }
    if (baoCaoFolder) void napBaoCaoFolder(); // bảng đang mở → nạp lại NGAY từ server (đồng bộ, không vá cục bộ)
    if (daCanhBaoRef.current.has(idx)) {
      daCanhBaoRef.current.delete(idx);
      setLog((L) => [...L, `✅ Bill ${idx + 1}/${total}: ĐÃ SỬA & GỬI XONG — cảnh báo trước đó đã xử lý.`]);
    }
    // [Admin Demo 6/9] LOG riêng khi gửi DÙ CÓ CẢNH BÁO — để soát lại (nhân viên đã xác nhận gửi bill có lỗi cảnh báo).
    if (info.warned && info.warned.length) setLog((L) => [...L, `⚠ Bill ${idx + 1}/${total} GỬI DÙ CÓ CẢNH BÁO (đã xác nhận): ${info.warned!.join(' · ')} — soát lại nếu cần.`]);
    // GỐC BUG (Admin Demo 1/9 "review Thành Nam ra data Huê Xinh"): PHẢI clear `auto` NGAY khi advance — nếu không,
    // render kế idx đã sang bill mới nhưng `auto` (token+items) CÒN bill CŨ → card vị trí mới hiện SAI bill (cả ảnh
    // lẫn số, vì imgUrl fetch từ token stale). Clear → card không render bill cũ, spinner tới khi effect nạp bill idx mới.
    setAuto(null);
    setIdx((v) => v + 1);
    // [Admin Demo 17/9] Báo ra màn Doanh số: còn bill trong hàng đợi thì GIỮ khối OCR (quét tiếp), hết thì đóng.
    onSentExternal?.(info, idx + 1 < total);
  }

  // Tab active = pill glass 3D ĐÃ DUYỆT (.btn-primary brand→teal) — ĐỒNG BỘ với <Button variant="confirm">,
  // hết "xanh phẳng bg-brand lệch brand" (Admin Demo 30/8). Inactive = chữ xám trong máng glass.
  const seg = (active: boolean): string => `flex-1 rounded-full px-4 py-2 text-sm font-bold transition ${active ? 'btn-primary text-white' : 'text-slate-500 hover:text-slate-700'}`;

  return (
    // [Admin Demo 17/9 "chọn quét bill trong màn doanh số bị VĂNG về OCR, không chạy nền trên màn doanh số"]
    // embedded = chạy như TÁC VỤ CON trong panel của màn Doanh số: bỏ lề 1.5cm + đệm đáy toàn màn (thanh nav),
    // cao theo panel chứ không chiếm cả màn hình. KHÔNG clone code — vẫn CHÍNH component này (clone 100% tính năng).
    <div className={embedded
      ? 'h-full overflow-y-auto px-2 pt-1 pb-4 space-y-2' // khung nổi của màn Doanh số tự lo chiều cao
      : 'h-full overflow-y-auto px-[1.5cm] pt-2 pb-[max(6rem,calc(env(safe-area-inset-bottom)+5rem))] space-y-2'}>
      {/* BỎ header "Quét bill gửi" + icon (Admin Demo 30/8) — sidebar đã có tên menu, lấy chiều cao cho nội dung
          để KHÔNG mất nút "Xác nhận tách" khi tách thẻ. */}

      {/* [Admin Demo 6/9] 3 TAB đảo thứ tự Tự động · Thủ công · QR — mỗi tab 1 NỀN brand riêng + icon + nút 3D nổi. */}
      <div className="flex gap-3">
        {([
          { key: 'auto', label: 'Tự động', Icon: FolderOpen, on: 'from-emerald-400 to-emerald-600 shadow-emerald-500/40', off: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200' },
          { key: 'manual', label: 'Thủ công', Icon: Upload, on: 'from-sky-400 to-sky-600 shadow-sky-500/40', off: 'bg-sky-50 text-sky-700 hover:bg-sky-100 border-sky-200' },
          { key: 'qr', label: 'Quét QR', Icon: QrCode, on: 'from-violet-400 to-violet-600 shadow-violet-500/40', off: 'bg-violet-50 text-violet-700 hover:bg-violet-100 border-violet-200' }
        ] as const).map((t) => {
          const active = mode === t.key;
          return (
            <button key={t.key} onClick={() => setMode(t.key)}
              className={`flex-1 flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-bold transition-all active:translate-y-0 ${active
                ? `bg-gradient-to-b ${t.on} text-white shadow-lg -translate-y-0.5`
                : `${t.off} border shadow-md hover:-translate-y-0.5`}`}>
              <t.Icon className="h-5 w-5" /> {t.label}
            </button>
          );
        })}
      </div>

      {/* [Admin Demo 8/9] CHỌN CHẾ ĐỘ ĐỌC BILL — hiện rõ như chọn tab, áp cho CẢ phiên quét (nhớ lần sau). */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white/70 px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Đọc bill bằng</span>
        {([
          { key: 'sonnet', label: 'AI chuẩn (Gemini → Claude)', tip: 'Đọc bằng Gemini (nhanh ~5s); hết quota/lỗi tự chuyển Claude Sonnet. Mặc định — chuẩn cho bill tiền.' },
          { key: 'opus', label: 'Opus (bill khó)', tip: 'Luôn đọc bằng Opus — mạnh nhất, chậm nhất. Dùng khi bill mờ/đọc lệch liên tục.' }
        ] as const).map((e) => {
          const on = engine === e.key;
          return (
            <button key={e.key} type="button" title={e.tip} data-testid={`ocr-engine-${e.key}`}
              onClick={() => { setEngine(e.key); setLog((L) => [...L, `⚙ Chế độ đọc bill: ${e.label}.`]); }}
              className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${on ? 'btn-primary text-white shadow' : 'border border-line bg-white text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
              {e.label}
            </button>
          );
        })}
        <span className="ml-auto text-[11px] text-slate-400">{engine === 'sonnet' ? 'Mọi bill đi thẳng API: Gemini trước, hết quota tự chuyển Claude' : 'Mọi bill đọc bằng Opus (chậm)'}</span>
      </div>

      {err && <div className="flex items-center gap-2 rounded-xl bg-danger/10 border border-danger/20 p-3 text-sm text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {err}</div>}

      {/* [Admin Demo 6/9] RESUME: mở lại folder dở → nhảy đúng bill đang OCR (khỏi bấm bỏ qua từ đầu). Cho phép về bill 1. */}
      {resumeFrom != null && (mode === 'auto' || mode === 'qr') && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-brand/40 bg-brand-tint px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-brand-deep"><RefreshCw className="h-4 w-4 shrink-0" /> Đã tiếp tục từ <b>bill {resumeFrom + 1}/{webFiles.length || pcFiles.length || queue.length}</b> (lần trước dừng ở đây).</span>
          <button onClick={() => { setIdx(0); setResumeFrom(null); }} className="shrink-0 rounded-lg border border-line bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-brand-tint">Về bill 1</button>
        </div>
      )}

      {/* GIỮ CẢ 2 TAB MOUNTED (ẩn bằng CSS) — đổi tab KHÔNG unmount → state review + tách thẻ KHÔNG mất
          (Admin Demo 30/8 "qua tab là mất"). */}
      <div className={mode === 'manual' ? 'space-y-3' : 'hidden'}>
          <input ref={fileRef} type="file" accept="image/*" onChange={onPickFile} className="hidden" />
          {/* [Admin Demo 17/9] KẾT QUẢ ĐỔI TÊN FILE — bản EXE tự đổi tên ảnh theo nội dung bill (như tab Tự động).
              Trước đây chỉ ghi vào nhật ký mà nhật ký chỉ có ở tab Tự động ⇒ tab Thủ công câm, tưởng không đổi. */}
          {tenFileMoi && (
            <div data-testid="bang-doi-ten"
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${tenFileMoi.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-amber-400 bg-amber-50 text-amber-700'}`}>
              {tenFileMoi.ok ? '📄 ' : '⚠ '}{tenFileMoi.text}
            </div>
          )}
          {/* Khung upload TO chỉ hiện khi CHƯA có review (chống tràn — sau khi quét chỉ còn nút nhỏ). */}
          {!manual && (
            <div className="glass-panel shadow-soft rounded-2xl border border-dashed border-brand/40 p-6 flex flex-col items-center gap-3 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand"><Upload className="h-7 w-7" /></div>
              <p className="text-sm text-slate-500">Chọn hoặc chụp ảnh bill POS để đọc & gửi</p>
              <Button variant="confirm" icon={<Upload className="h-4 w-4" />} onClick={() => { if (isExe && pc?.pickBillFiles) void onPickFileExe(); else fileRef.current?.click(); }} disabled={busy}>Chọn / chụp ảnh bill</Button>
              {isExe && pc?.pickBillFiles && <div className="text-[11px] text-slate-400">Bản EXE: ảnh chọn từ máy sẽ được ĐỔI TÊN sau khi OCR (chọn nhiều ảnh → chuyển tab Tự động).</div>}
            </div>
          )}
          {busy && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Đang OCR… <Button variant="soft" size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={stopOcr}>Dừng OCR</Button></div>}
          {manual?.cached && <div className="text-xs text-slate-400">ℹ Ảnh này đã quét trước — dùng lại kết quả, không tốn quota.</div>}
          {/* ĐỒNG NHẤT tab tự động: bill CHUYỂN KHOẢN → TransferReviewCard (có ảnh + gửi đại lý-only); bill POS → BillReviewCard. */}
          {manual?.transfers && manual.transfers.length > 0
            ? manual.transfers.map((t, i) => <CardErrorBoundary key={`m-t${i}`}><TransferReviewCard token={manual.token} transfer={t} onSent={(info) => onSentExternal?.(info, false) /* thủ công: 1 bill, gửi xong là xong */} onPickAnother={() => fileRef.current?.click()} /></CardErrorBoundary>)
            : manual?.qr && manual.qr.length > 0
            ? manual.qr.map((it, i) => <CardErrorBoundary key={`m-qr${i}`}><QrBillReviewCard token={manual.token} item={it} onSent={(info) => onSentExternal?.(info, false) /* thủ công: 1 bill, gửi xong là xong */} onPickAnother={() => fileRef.current?.click()} /></CardErrorBoundary>)
            : manual?.items.map((it, i) => <CardErrorBoundary key={i}><BillReviewCard token={manual.token} item={it} billIndex={i} onSent={(info) => onSentExternal?.(info, false) /* thủ công: 1 bill, gửi xong là xong */} onPickAnother={() => fileRef.current?.click()} pickBusy={busy} /></CardErrorBoundary>)}
      </div>

      <div className={mode === 'auto' ? 'space-y-3' : 'hidden'}>
          {/* Panel chọn folder ẨN khi đang REVIEW (auto set) HOẶC đang QUÉT DỞ (scanned + còn bill) — Admin Demo 31/8
              "gửi xong quay về màn chọn folder là sai". Chỉ hiện khi CHƯA quét / đã XONG hết bill. */}
          {!auto && !(scanned && autoTotal > 0 && idx < autoTotal) && (
          <div className="glass-panel shadow-soft rounded-2xl border border-line p-4 space-y-3">
            {/* [Admin Demo 6/9] NÚT TIẾP TỤC OCR DỞ — hiện khi có tiến trình đã lưu (văng/crash/đóng app giữa chừng).
                EXE: mở lại đúng folder đã lưu → nhảy tới bill dở. WEB: mở picker chọn lại đúng folder → tự nhảy. */}
            {savedResume && savedResume.idx > 0 && (
              <button
                onClick={() => { if (isExe && folder) { void loadFolderFromPath(folder); } else { void chooseFolder(); } }}
                disabled={busy}
                className="flex w-full items-center justify-between gap-2 rounded-xl border-2 border-brand/50 bg-brand-tint px-3 py-2.5 text-left transition hover:bg-brand/10 disabled:opacity-50">
                <span className="flex items-center gap-2 text-sm font-bold text-brand-deep">
                  <ScanLine className="h-4 w-4 shrink-0" />
                  ▶ Tiếp tục OCR dở: <b>bill {savedResume.idx}/{savedResume.total}</b>
                  <span className="text-[11px] font-normal text-slate-500 break-all">— {savedResume.key.split('|')[0]}{isExe ? '' : ' (chọn lại folder)'}</span>
                </span>
                <RefreshCw className="h-4 w-4 shrink-0 text-brand" />
              </button>
            )}
            <span className={LABEL}>Folder bill tải về máy</span>
            {/* EXE (Electron): đọc folder qua fs → LƯU đường dẫn → lần sau chỉ bấm "OCR folder đã lưu" (Admin Demo 31/8).
                WEB: webkitdirectory (bảo mật trình duyệt → phải chọn lại mỗi lần). */}
            {isExe ? (
              <>
                {folder ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="confirm" icon={<ScanLine className="h-4 w-4" />} onClick={() => void loadFolderFromPath(folder)} disabled={busy}>OCR folder đã lưu</Button>
                    <Button variant="soft" size="sm" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={chooseFolder} disabled={busy}>Đổi folder khác</Button>
                    {/* Folder TO RÕ + NỔI (Admin Demo 2/9 "quá bé đọc mờ, nổi lên tránh nhầm folder"): TÊN folder (đoạn
                        cuối) in ĐẬM TO màu brand trên nền nổi; đường dẫn đầy đủ nhỏ bên dưới. Tránh chọn nhầm folder. */}
                    <div className="w-full rounded-lg border-2 border-brand/40 bg-brand-tint px-3 py-2">
                      <div className="flex items-center gap-1.5 text-base font-extrabold text-brand-deep break-all">📁 {folder.split(/[\\/]/).filter(Boolean).pop() || folder}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500 break-all">{folder}</div>
                    </div>
                  </div>
                ) : (
                  <Button variant="confirm" icon={<FolderOpen className="h-4 w-4" />} onClick={chooseFolder} disabled={busy}>Chọn folder bill…</Button>
                )}
              </>
            ) : (
              <>
                <Button variant="confirm" icon={<FolderOpen className="h-4 w-4" />} onClick={chooseFolder} disabled={busy}>Chọn folder bill…</Button>
                {/* data-testid: MỐC cho harness chọn ĐÚNG ô chọn-thư-mục (trang có nhiều input file) — không đổi giao diện. */}
                <input ref={folderInputRef} data-testid="auto-folder-input" type="file" multiple onChange={onFolderPicked} className="hidden" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} />
                <span className="text-[11px] text-slate-400 normal-case">Trên web: chọn THƯ MỤC ảnh bill mỗi lần (trình duyệt không lưu được folder). Bản PC (.exe) lưu đường dẫn, lần sau chỉ bấm OCR.</span>
              </>
            )}
            {savedMsg && <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" /> {savedMsg}</span>}
          </div>
          )}

          {/* ĐANG REVIEW (auto set): card TRÁI đủ cao NHƯ thủ công + tiến trình/log sang PHẢI (không đẩy card xuống,
              Admin Demo 30/8). Chưa review (auto=null): log + thông báo xong nằm dưới config như cũ. */}
          {/* GIỮ NGUYÊN màn render (card+log) SUỐT quá trình quét (Admin Demo 31/8 "ở nguyên màn render, log tiến trình
              đang OCR→xong→đang gửi→đã gửi→bill tiếp") — KHÔNG nhảy về màn folder. Trái: card (khi có review) HOẶC
              spinner "đang OCR bill X". */}
          {(auto || (scanned && autoTotal > 0 && idx < autoTotal)) ? (
            <div className="flex items-stretch gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                {auto ? (
                  <>
                    {/* Nút "Bỏ qua bill này" đưa LÊN ĐẦU (Admin Demo 1/9 "vẫn tràn khuất dưới"): card có footer sticky (nút Gửi
                        nổi đáy) → nút đặt SAU card bị đẩy khuất/che. Đặt trên card = LUÔN thấy, không cần cuộn. */}
                    {/* [Admin Demo 5/9 — BUG "Bỏ qua nhảy về ĐỐI SOÁT"] GỐC: hàng nút này (nhiều nút whitespace-nowrap) TRÀN
                        ngang khỏi cột flex-1, mà panel LOG (w-96, đứng SAU trong DOM, không z-index) VẼ ĐÈ lên → nút
                        "Bỏ qua bill này" bị span "Đang xử lý bill mới" che → click chuột thật trúng log panel, KHÔNG
                        trúng nút (elementFromPoint = SPAN log). Fix: flex-wrap (nút xuống dòng, không tràn) + relative
                        z-10 (nếu còn chồng, hàng nút vẫn nhận click trước log). */}
                    <div className="relative z-10 flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 text-xs text-slate-400">{auto.cached ? 'ℹ Đã quét trước — dùng lại, không tốn quota.' : ''}</div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {/* [Admin Demo 3/9] XEM LẠI bill trước / vị trí hiện tại. Quay lại → chỉ hiển thị (không đếm/gửi trùng). */}
                        <button
                          type="button"
                          disabled={idx <= 0}
                          onClick={() => { setAuto(null); setIdx((v) => Math.max(0, v - 1)); }}
                          title="Xem lại bill trước đó"
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >← Trước</button>
                        <span className="whitespace-nowrap text-xs font-semibold text-slate-500 tabular-nums">Bill {Math.min(idx + 1, autoTotal)}/{autoTotal}</span>
                        {/* [Admin Demo 4/9] BILL CẦN KIỂM TAY: nút ĐỎ đi tới bill flag KẾ (ngày lùi/không đọc được/lỗi) — cấm bỏ sót. */}
                        {(() => { const need = Object.keys(flagged).map(Number).sort((a, b) => a - b); const next = need.find((n) => n > idx) ?? need.find((n) => n !== idx); const remain = need.filter((n) => n !== idx).length; return need.length > 0 && next != null ? (
                          <button type="button" onClick={() => { setAuto(null); handledRef.current.delete(next); setIdx(next); bump(); }} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border-2 border-danger bg-danger/10 px-3 py-1.5 text-sm font-bold text-danger transition hover:bg-danger/20">
                            <AlertTriangle className="h-3.5 w-3.5" /> Bill cần kiểm ({remain}) →
                          </button>
                        ) : null; })()}
                        {/* Admin Demo 1/9: nút CHỌN LẠI FOLDER / quét lại — auto kẹt vẫn thoát được, không phải đóng app. */}
                        <Button variant="soft" size="sm" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={restartScan}>Chọn folder khác</Button>
                        {/* [Admin Demo 4/9] TẢI LẠI folder đang chọn — nạp bill mới tải về sau, không mất tiến độ. Hiện khi đang quét folder (EXE/web/path). */}
                        {autoTotal > 0 && <Button variant="soft" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={reloadFolder} disabled={busy} title="Đọc lại folder đang chọn để nạp bill mới tải về (giữ nguyên tiến độ, bill đã OCR không quét lại)">Tải lại folder</Button>}
                        {/* NÚT BỎ QUA — màu AMBER outline (Admin Demo 2/9 "cho màu khác đi"): KHÁC HẲN nút Gửi (pill CYAN
                            confirm) để KHÔNG bấm nhầm. Không dùng Button variant (neutral/soft đều là pill xanh dễ lẫn). */}
                        <button
                          type="button"
                          disabled={currentLoading}
                          onClick={() => { setAuto(null); setIdx((v) => v + 1); }} /* [Admin Demo 3/9] CLEAR auto trước advance → chống "chồng review cũ" (key idx-mới + data cũ). */
                          className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border-2 border-amber-400 bg-amber-50 px-3 py-1.5 text-sm font-bold text-amber-700 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <SkipForward className="h-3.5 w-3.5" /> Bỏ qua bill này
                        </button>
                      </div>
                    </div>
                    {(auto.transfers?.length ?? 0) > 0
                      ? auto.transfers!.map((t, i) => <CardErrorBoundary key={`${idx}-t${i}`}><TransferReviewCard token={auto.token} transfer={t} onSent={onSentAuto} snapBase={`${imgId(idx)}#t${i}`} stacked /></CardErrorBoundary>)
                      : (auto.qr?.length ?? 0) > 0
                      ? auto.qr!.map((it, i) => <CardErrorBoundary key={`${idx}-qr${i}`}><QrBillReviewCard token={auto.token} item={it} onSent={onSentAuto} onPickAnother={() => { setAuto(null); setIdx((v) => v + 1); }} onRescan={() => rescanAt(idx)} onRescanClaude={() => rescanAt(idx, false, true)} onRescanOpus={() => rescanAt(idx, true, true)} rescanBusy={currentLoading} stacked folderName={folder ? (folder.split(/[\\/]/).filter(Boolean).pop() || undefined) : (webFiles[0]?.webkitRelativePath?.split('/')[0] || undefined)} /></CardErrorBoundary>)
                      : auto.items.map((it, i) => <CardErrorBoundary key={`${idx}-${i}`}><BillReviewCard token={auto.token} item={it} billIndex={i} stacked snapBase={imgId(idx)} onSent={onSentAuto} onRescan={() => rescanAt(idx)} onRescanOpus={() => rescanAt(idx, true)} rescanBusy={currentLoading} flagWarn={flagged[idx]} folderName={folder ? (folder.split(/[\\/]/).filter(Boolean).pop() || undefined) : (webFiles[0]?.webkitRelativePath?.split('/')[0] || undefined)} /></CardErrorBoundary>)}
                  </>
                ) : stopped ? (
                  <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 text-center">
                    <X className="h-8 w-8 text-slate-400" />
                    <div className="text-sm font-semibold text-slate-600">Đã dừng OCR.</div>
                    <div className="flex items-center gap-2">
                      <Button variant="confirm" size="sm" icon={<ScanLine className="h-4 w-4" />} onClick={resumeOcr}>Chạy tiếp</Button>
                      <Button variant="soft" size="sm" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={restartScan}>Quay lại chọn folder</Button>
                    </div>
                  </div>
                ) : curDoneNoCard ? (
                  /* [Audit 3/9 #18] Bill đã OCR XONG nhưng lỗi/không-ra-bill, đang XEM LẠI (← Trước) → KHÔNG spinner giả. */
                  <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-amber-300 bg-amber-50 text-center">
                    <AlertTriangle className="h-8 w-8 text-amber-500" />
                    <div className="text-sm font-semibold text-slate-600">Bill {Math.min(idx + 1, autoTotal)}/{autoTotal}: {curEntry?.status === 'error' ? 'LỖI OCR' : 'không đọc được bill (đã bỏ qua)'}</div>
                    <div className="max-w-[80%] truncate text-xs text-slate-400">{webFiles.length ? webFiles[idx]?.name : pcFiles.length ? pcFiles[idx]?.name : queue[idx]?.name}</div>
                    <div className="flex items-center gap-2">
                      <Button variant="soft" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => rescanAt(idx)}>Quét lại ảnh này</Button>
                      <Button variant="soft" size="sm" icon={<SkipForward className="h-3.5 w-3.5" />} onClick={() => { setAuto(null); setIdx((v) => v + 1); }}>Bill sau →</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-brand/30 bg-brand/5 text-center">
                    <Loader2 className="h-8 w-8 animate-spin text-brand" />
                    <div className="text-sm font-semibold text-slate-600">Đang OCR bill {Math.min(idx + 1, autoTotal)}/{autoTotal}…</div>
                    <div className="max-w-[80%] truncate text-xs text-slate-400">{webFiles.length ? webFiles[idx]?.name : pcFiles.length ? pcFiles[idx]?.name : queue[idx]?.name}</div>
                    {/* Admin Demo 1/9 "kẹt ở bill đang OCR không có nút chọn lại folder": LUÔN có lối thoát khi đang OCR. */}
                    <div className="flex items-center gap-2">
                      <Button variant="soft" size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={stopOcr}>Dừng OCR</Button>
                      {autoTotal > 0 && <Button variant="soft" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={reloadFolder} disabled={busy} title="Đọc lại folder nạp bill mới">Tải lại folder</Button>}
                      <Button variant="soft" size="sm" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={restartScan}>Chọn folder khác</Button>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex w-96 shrink-0 flex-col gap-2">
                {scanned && autoTotal > 0 && idx < autoTotal && (
                  <div className="flex items-start gap-2 rounded-xl bg-brand/5 border border-brand/15 p-2.5 text-sm text-slate-600"><Loader2 className={`h-4 w-4 shrink-0 mt-0.5 ${poolActive || currentLoading ? 'animate-spin' : ''} text-brand`} /> <span>Đang xử lý bill mới <b>{Math.min(idx + 1, autoTotal)}</b>/{autoTotal} — gửi server OCR (Sonnet@2400) hoặc đọc cache…<br /><span className="text-xs text-slate-400 break-all">{webFiles.length ? webFiles[idx]?.name : pcFiles.length ? pcFiles[idx]?.name : queue[idx]?.name}</span></span></div>
                )}
                {/* Log dạng BẢNG chia cột (fill cao bằng card). */}
                {baoCaoFolder && <BangBaoCaoFolder bc={baoCaoFolder} dangTai={dangTaiBaoCao} onSua={moBillDeSua} onLamMoi={() => void napBaoCaoFolder()} />}
                {log.length > 0 && <LogList log={log} fill onMoBill={moBillDeSua} onMoBaoCaoLo={(tid, lo) => void moBaoCaoLo(tid, lo)} />}
              </div>
            </div>
          ) : (
            <>
              {/* [Admin Demo 8/9] QUÉT XONG FOLDER → BẢNG BÁO CÁO (không còn card bill nào) — đây là chỗ người duyệt nhìn. */}
              {baoCaoFolder && <BangBaoCaoFolder bc={baoCaoFolder} dangTai={dangTaiBaoCao} onSua={moBillDeSua} onLamMoi={() => void napBaoCaoFolder()} />}
              {log.length > 0 && <LogList log={log} onMoBill={moBillDeSua} onMoBaoCaoLo={(tid, lo) => void moBaoCaoLo(tid, lo)} />}
              {scanned && autoTotal > 0 && idx >= autoTotal && <div className="flex items-center gap-2 rounded-xl bg-success/10 border border-success/20 p-3 text-sm font-medium text-success"><CheckCircle2 className="h-5 w-5" /> Đã xử lý hết {autoTotal} bill mới.</div>}
              {scanned && autoTotal === 0 && <div className="text-sm text-slate-500">Không có bill mới — tất cả đã quét trước.</div>}
            </>
          )}
      </div>

      {/* ── TAB QUÉT QR (mode 'qr') ────────────────────────────────────────────────────────────────────────────
          Bill "Thanh toán thành công" (QR bán hàng) → ghi doanh số + hoàn đại lý. TÁI DÙNG NGUYÊN pipeline OCR/gửi:
          upload 1 ảnh = onPickFile (→ manual state); quét folder = onFolderPicked/chooseFolder + vòng lặp folder chung
          (→ auto state). Bill KHÔNG phải QR (POS/CK) → báo nhẹ (NotQrNotice), KHÔNG xử lý ở đây. GIỮ MOUNTED (hidden)
          như 2 tab kia; nội dung chỉ render khi mode==='qr' để tab Thủ công/Tự động chạy y NGUYÊN (không dẫm card). */}
      <div className={mode === 'qr' ? 'space-y-3' : 'hidden'} data-testid="qr-tab-panel">
        {mode === 'qr' && (
          <>
            <input ref={qrFileRef} type="file" accept="image/*" onChange={onPickFile} className="hidden" />
            {tenFileMoi && (
              <div data-testid="bang-doi-ten-qr"
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${tenFileMoi.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-amber-400 bg-amber-50 text-amber-700'}`}>
                {tenFileMoi.ok ? '📄 ' : '⚠ '}{tenFileMoi.text}
              </div>
            )}
            <input ref={qrFolderInputRef} type="file" multiple onChange={onFolderPicked} className="hidden" data-testid="qr-folder-input" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} />

            {/* Mô tả ngắn đầu tab. */}
            <div className="glass-panel shadow-soft rounded-2xl border border-brand/30 bg-brand-tint px-4 py-3 flex items-start gap-2 text-sm text-slate-600">
              <ScanLine className="h-5 w-5 shrink-0 text-brand" />
              <span>Quét bill <b>"Thanh toán thành công"</b> (QR bán hàng) → <b>ghi doanh số + hoàn đại lý</b>. Chọn 1 ảnh hoặc quét cả folder.</span>
            </div>

            {/* Entry: upload 1 ảnh + quét folder — ẩn khi đang review đơn lẻ (manual) / đang quét folder dở. */}
            {!manual && !auto && !(scanned && autoTotal > 0 && idx < autoTotal) && (
              <div className="glass-panel shadow-soft rounded-2xl border border-line p-4 space-y-4">
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-brand/40 p-5 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand"><ScanLine className="h-7 w-7" /></div>
                  <p className="text-sm text-slate-500">Chọn hoặc chụp <b>1 ảnh bill QR</b> để đọc & gửi</p>
                  {/* [Admin Demo 17/9] Trên EXE đi dialog Electron (CÓ đường dẫn) để ĐỔI TÊN FILE như tab Tự động;
                      web/APK không có path nên vẫn dùng input file. */}
                  <Button variant="confirm" icon={<Upload className="h-4 w-4" />} onClick={() => { if (isExe && pc?.pickBillFiles) void onPickFileExe(true); else qrFileRef.current?.click(); }} disabled={busy}>Chọn / chụp ảnh bill QR</Button>
                </div>
                <div className="space-y-2">
                  <span className={LABEL}>Hoặc quét cả folder bill QR</span>
                  {isExe ? (
                    folder ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="confirm" icon={<ScanLine className="h-4 w-4" />} onClick={() => void loadFolderFromPath(folder)} disabled={busy}>OCR folder đã lưu</Button>
                        <Button variant="soft" size="sm" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={chooseFolder} disabled={busy}>Đổi folder khác</Button>
                        <div className="w-full rounded-lg border-2 border-brand/40 bg-brand-tint px-3 py-2">
                          <div className="flex items-center gap-1.5 text-base font-extrabold text-brand-deep break-all">📁 {folder.split(/[\\/]/).filter(Boolean).pop() || folder}</div>
                          <div className="mt-0.5 text-[11px] text-slate-500 break-all">{folder}</div>
                        </div>
                      </div>
                    ) : (
                      <Button variant="confirm" icon={<FolderOpen className="h-4 w-4" />} onClick={chooseFolder} disabled={busy}>Chọn folder bill…</Button>
                    )
                  ) : (
                    <>
                      <Button variant="confirm" icon={<FolderOpen className="h-4 w-4" />} onClick={() => qrFolderInputRef.current?.click()} disabled={busy}>Chọn folder bill…</Button>
                      <span className="block text-[11px] text-slate-400 normal-case">Trên web: chọn THƯ MỤC ảnh bill QR mỗi lần. Bản PC (.exe) lưu đường dẫn, lần sau chỉ bấm OCR.</span>
                    </>
                  )}
                </div>
              </div>
            )}

            {busy && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Đang OCR… <Button variant="soft" size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={stopOcr}>Dừng OCR</Button></div>}

            {/* UPLOAD 1 ảnh (manual state): QR → card QR; POS/CK → báo nhẹ + chọn ảnh khác. */}
            {manual && (
              (manual.qr && manual.qr.length > 0)
                ? manual.qr.map((it, i) => <CardErrorBoundary key={`qr-m-${i}`}><QrBillReviewCard token={manual.token} item={it} onSent={(info) => onSentExternal?.(info, false) /* thủ công: 1 bill, gửi xong là xong */} onPickAnother={() => qrFileRef.current?.click()} /></CardErrorBoundary>)
                : <NotQrNotice onGoTab={() => setMode('manual')} goLabel="Sang tab Thủ công →" onPick={() => qrFileRef.current?.click()} />
            )}

            {/* QUÉT FOLDER (auto state, pipeline chung): QR → card QR; POS/CK → báo nhẹ + Bỏ qua. */}
            {(auto || (scanned && autoTotal > 0 && idx < autoTotal)) && (
              <div className="flex items-stretch gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="relative z-10 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 text-xs text-slate-400">{auto?.cached ? 'ℹ Đã quét trước — dùng lại, không tốn quota.' : ''}</div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button type="button" disabled={idx <= 0} onClick={() => { setAuto(null); setIdx((v) => Math.max(0, v - 1)); }} title="Xem lại bill trước đó" className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">← Trước</button>
                      <span className="whitespace-nowrap text-xs font-semibold text-slate-500 tabular-nums">Bill {Math.min(idx + 1, autoTotal)}/{autoTotal}</span>
                      <Button variant="soft" size="sm" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={restartScan}>Chọn folder khác</Button>
                      {autoTotal > 0 && <Button variant="soft" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={reloadFolder} disabled={busy} title="Đọc lại folder đang chọn để nạp bill mới (giữ tiến độ)">Tải lại folder</Button>}
                      <button type="button" disabled={currentLoading} onClick={() => { setAuto(null); setIdx((v) => v + 1); }} className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border-2 border-amber-400 bg-amber-50 px-3 py-1.5 text-sm font-bold text-amber-700 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"><SkipForward className="h-3.5 w-3.5" /> Bỏ qua bill này</button>
                    </div>
                  </div>
                  {auto ? (
                    (auto.qr && auto.qr.length > 0)
                      ? auto.qr.map((it, i) => <CardErrorBoundary key={`qr-a-${idx}-${i}`}><QrBillReviewCard token={auto.token} item={it} onSent={onSentAuto} onRescan={() => rescanAt(idx)} onRescanClaude={() => rescanAt(idx, false, true)} onRescanOpus={() => rescanAt(idx, true, true)} rescanBusy={currentLoading} stacked folderName={folder ? (folder.split(/[\\/]/).filter(Boolean).pop() || undefined) : (webFiles[0]?.webkitRelativePath?.split('/')[0] || undefined)} /></CardErrorBoundary>)
                      : <NotQrNotice onGoTab={() => setMode('auto')} goLabel="Sang tab Tự động →" onSkip={() => { setAuto(null); setIdx((v) => v + 1); }} />
                  ) : stopped ? (
                    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 text-center">
                      <X className="h-8 w-8 text-slate-400" />
                      <div className="text-sm font-semibold text-slate-600">Đã dừng OCR.</div>
                      <div className="flex items-center gap-2"><Button variant="confirm" size="sm" icon={<ScanLine className="h-4 w-4" />} onClick={resumeOcr}>Chạy tiếp</Button><Button variant="soft" size="sm" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={restartScan}>Quay lại chọn folder</Button></div>
                    </div>
                  ) : curDoneNoCard ? (
                    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-amber-300 bg-amber-50 text-center">
                      <AlertTriangle className="h-8 w-8 text-amber-500" />
                      <div className="text-sm font-semibold text-slate-600">Bill {Math.min(idx + 1, autoTotal)}/{autoTotal}: {curEntry?.status === 'error' ? 'LỖI OCR' : 'không đọc được bill (đã bỏ qua)'}</div>
                      <div className="flex items-center gap-2"><Button variant="soft" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => rescanAt(idx)}>Quét lại ảnh này</Button><Button variant="soft" size="sm" icon={<SkipForward className="h-3.5 w-3.5" />} onClick={() => { setAuto(null); setIdx((v) => v + 1); }}>Bill sau →</Button></div>
                    </div>
                  ) : (
                    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-brand/30 bg-brand/5 text-center">
                      <Loader2 className="h-8 w-8 animate-spin text-brand" />
                      <div className="text-sm font-semibold text-slate-600">Đang OCR bill {Math.min(idx + 1, autoTotal)}/{autoTotal}…</div>
                      <div className="max-w-[80%] truncate text-xs text-slate-400">{webFiles.length ? webFiles[idx]?.name : pcFiles.length ? pcFiles[idx]?.name : queue[idx]?.name}</div>
                      <div className="flex items-center gap-2"><Button variant="soft" size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={stopOcr}>Dừng OCR</Button><Button variant="soft" size="sm" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={restartScan}>Chọn folder khác</Button></div>
                    </div>
                  )}
                </div>
                <div className="flex w-96 shrink-0 flex-col gap-2">
                  {scanned && autoTotal > 0 && idx < autoTotal && (<div className="flex items-start gap-2 rounded-xl bg-brand/5 border border-brand/15 p-2.5 text-sm text-slate-600"><Loader2 className={`h-4 w-4 shrink-0 mt-0.5 ${poolActive || currentLoading ? 'animate-spin' : ''} text-brand`} /> <span>Đang xử lý bill <b>{Math.min(idx + 1, autoTotal)}</b>/{autoTotal} — gửi server OCR (Sonnet@2400) hoặc đọc cache…<br /><span className="text-xs text-slate-400 break-all">{webFiles.length ? webFiles[idx]?.name : pcFiles.length ? pcFiles[idx]?.name : queue[idx]?.name}</span></span></div>)}
                  {baoCaoFolder && <BangBaoCaoFolder bc={baoCaoFolder} dangTai={dangTaiBaoCao} onSua={moBillDeSua} onLamMoi={() => void napBaoCaoFolder()} />}
                {log.length > 0 && <LogList log={log} fill onMoBill={moBillDeSua} onMoBaoCaoLo={(tid, lo) => void moBaoCaoLo(tid, lo)} />}
                </div>
              </div>
            )}

            {!auto && baoCaoFolder && <BangBaoCaoFolder bc={baoCaoFolder} dangTai={dangTaiBaoCao} onSua={moBillDeSua} onLamMoi={() => void napBaoCaoFolder()} />}
            {!auto && scanned && autoTotal > 0 && idx >= autoTotal && <div className="flex items-center gap-2 rounded-xl bg-success/10 border border-success/20 p-3 text-sm font-medium text-success"><CheckCircle2 className="h-5 w-5" /> Đã xử lý hết {autoTotal} bill.</div>}
          </>
        )}
      </div>
    </div>
  );
}
