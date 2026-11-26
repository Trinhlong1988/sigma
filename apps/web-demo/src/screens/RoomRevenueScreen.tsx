// SIGMA "Doanh số theo nhóm chat" (1/8, B100 hạ tầng backend + B101-tiếp UI thật) — khớp demo Artifact đã
// duyệt (Admin Demo "demo ok build hạ tầng" rồi "thiết kế UI doanh số duyệt"): lọc theo ngày/tuần/tháng/tùy chọn,
// xem gộp TẤT CẢ TID hoặc TỪNG TID riêng, tổng trước phí/sau phí/phí đã trừ, biểu đồ tăng trưởng canvas, bảng
// chi tiết theo Lô (kèm số tiền phải hoàn nếu lô bị hủy = gross-fee, đại lý đã chi tiền mặt theo số này).
//
// Cập nhật (Admin Demo 21/8): GỠ toàn bộ UI cho khách/đại lý TỰ gắn/gỡ TID vào phòng — "khách hàng KHÔNG được
// tự ý thêm TID". TID↔khách nay do ADMIN quản trên desktop; doanh số phòng suy TỪ KHÁCH qua
// customer_chat_groups (backend đã đổi, KHÔNG còn dùng chat_room_tids/linkRoomTid). Màn này CHỈ XEM doanh số:
// lọc kỳ, chip lọc theo TID (report.tids — TID của khách), tổng gross/fee/net, biểu đồ, bảng chi tiết theo Lô.
//
// Nguồn dữ liệu "gross/fee/net" lấy TỪ Lo/LoRow đã có (createLo() lo-service.ts — báo giá lúc bán TID), KHÔNG
// phải từ OCR trực tiếp — badge "nguồn" trong demo Artifact (OCR/Nhập tay/Đối chiếu hệ thống) mô tả ĐỘ TIN CẬY
// của 6 trường mở rộng đọc lúc quét bill (OcrBillPreview.tsx), KHÁC PHẠM VI với báo cáo doanh số này (tổng hợp
// SAU khi Lô đã có, không phải preview lúc quét) — CỐ Ý KHÔNG thêm badge nguồn giả ở màn này (sẽ SUY ĐOÁN
// nguồn không có dữ liệu thật hỗ trợ, đúng nguyên tắc "cấm suy luận value/spec"). Refund/cảnh báo rủi ro theo
// Lô (khối đỏ trong demo) CẦN field DB mới (lưu lại `checkSettlementRisk()` lúc quét vào chính Lô) — CHƯA làm,
// ghi rõ trong BUGS_FIXED.md B100, không giả vờ có ở màn này.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ROUTES } from '../routes';
import { DotsLoader } from '../components/DotsLoader';
import { BackButton } from '../components/BackButton';
import { listChatRoomsWithNames, getRoomRevenue, getRefundReconcile, fetchLoCardOptions, correctLoCard, getChatRoomDetail, getLotGaps, getLoEditSource, type RoomRevenueReport, type RefundReconcileReport, type RoomTidDto, type LoCardOptionsDto, type LoCardOptionDto, type LotGapDto, type LoEditSourceDto } from '../lib/chat-client';
import { editBillParams as apiEditBillParams } from '../lib/bill-edit-client';
import { subscribeMessageEdited, subscribeRoomMessages } from '../lib/chat-realtime';
import { BillReviewCard, OcrSendScreen, type SentInfo, TransferReviewCard } from './OcrSendScreen';
import { prepareEditBill, editRefundBill, type ReviewItem, type TransferReview } from '../lib/ocr-send-api';
import { InvestorBaocoCheck } from '../components/InvestorBaocoCheck';
import { investorReportExportXlsxUrl, fetchInvestorReportDetail, type InvestorReportDetail, type InvestorDetailBill } from '../lib/investor-report-client';
import { downloadAttachment, downloadBlob } from '../lib/attachment-blob';
import { useDownloadDialog } from '../components/DownloadDoneDialog';
import { InvestorDetailLots } from '../components/InvestorDetailLots';
import { caCuaGio } from '../lib/ca-tien';
import { RevenueLotTable } from '../components/RevenueLotTable';
import { buildRevenueWorkbookXls, isoToLocalParts, AGENT_COLUMNS, AGENT_XLS_COLUMNS, type RevenueLotRow, type RevenueSheetInput } from '../lib/revenue-lot-xls';
// [Admin Demo 16/9 tối] Đối soát + hoàn tiền per LÔ POS ngay tại màn doanh số (làm tắt sau OCR) + QR VietQR.
import { getPosLotRecon, postPosLotRecon, postLotNote, postLotRefundDone, postLotRefundUndo, lamTronNghinXuong, getDealerRefundAccount, getDealerRefundAccounts, fetchVietQrPngUrl, noiDungChuyenKhoanQr, getYcTheoLo, taoYc, maYcHienThi, xacNhanYcDaChuyen, type DealerRefundAccount } from '../lib/digistore-client';
import { RefundQrModal, type NhomHoan } from '../components/RefundQrModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { isAlphaOwnerCode } from '../lib/alpha-aggregate-client';
import { getCachedAuthenticatedAgent } from '../lib/bot-api-client';
import { bankColor, compareBankTidLo } from '../lib/bank-visual';
import { Banknote, Percent, Landmark, Store, CreditCard, RotateCcw, Wallet, CalendarRange, Pencil, RefreshCw } from 'lucide-react';

// BỘ ICON ĐỒNG BỘ (Admin Demo 31/8) — tiền / % / bank / HKD / TID / hoàn. Dùng NHẤT QUÁN mọi trường liên quan.
const IconMoney = Banknote; // trường TIỀN
const IconPct = Percent; // trường %
const IconBank = Landmark; // NGÂN HÀNG
const IconHkd = Store; // TÊN HKD
const IconTid = CreditCard; // TID
const IconRefund = RotateCcw; // tiền phải hoàn / đã hoàn
const IconFee = Wallet; // phí

type PeriodKey = 'today' | 'yesterday' | 'week' | 'month' | '30d';

const PERIOD_LABEL: Record<PeriodKey, string> = {
  today: 'Hôm nay',
  yesterday: 'Hôm qua',
  week: 'Tuần này',
  month: 'Tháng này',
  '30d': '30 ngày qua'
};

/** Tính [from, to) LOCAL cho 1 mốc thời gian nhanh — CÙNG quy ước "local half-open bounds" các endpoint theo
 * kỳ khác trong workspace (xem feedback_period_bound_timezone_consistency, kpi.ts). */
function periodRange(key: PeriodKey): { from: Date; to: Date } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  switch (key) {
    case 'today':
      return { from: startOfToday, to };
    case 'yesterday': {
      // Hôm qua (Admin Demo 27/8): [đầu hôm qua, đầu hôm nay) — half-open, cùng quy ước local bounds.
      const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
      return { from: startOfYesterday, to: startOfToday };
    }
    case 'week': {
      const day = now.getDay() === 0 ? 7 : now.getDay(); // Thứ 2 = đầu tuần (CN=0 -> coi là ngày 7).
      const from = new Date(startOfToday.getTime() - (day - 1) * 24 * 60 * 60 * 1000);
      return { from, to };
    }
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to };
    case '30d':
      return { from: new Date(startOfToday.getTime() - 29 * 24 * 60 * 60 * 1000), to };
  }
}

/** Danh sách CHU KỲ để xuất Excel nhiều sheet (mỗi phần tử = 1 sheet). Thứ tự đọc quen thuộc. */
const EXPORT_PERIODS: PeriodKey[] = ['today', 'yesterday', 'week', 'month', '30d'];

/** 1 báo cáo phòng (RoomRevenueReport) → các hàng lô kiểu bảng, ĐÃ SẮP theo bank→TID→lô. Cột "Giờ" = giờ VN từ
 *  effDateIso (mốc bill thật có giờ); cột "NĐT" = investorNickname per-lô (backend resolve TID→NĐT). '—' nếu trống. */
function roomReportToLotRows(report: RoomRevenueReport, agentName: string): RevenueLotRow[] {
  const meta = new Map(report.tids.map((t) => [t.tidId, t]));
  const roomInvestorName = report.investor?.investorName ?? '';
  const loOf = (r: RoomRevenueReport['rows'][number]): string | null => (r.bankReportedLoNumber != null ? String(r.bankReportedLoNumber) : r.billLoNumber);
  const sorted = [...report.rows].sort((a, b) =>
    compareBankTidLo(
      { bankName: meta.get(a.tidId)?.bankName, tid: meta.get(a.tidId)?.tid, lo: loOf(a) },
      { bankName: meta.get(b.tidId)?.bankName, tid: meta.get(b.tidId)?.tid, lo: loOf(b) }
    )
  );
  return sorted.map((r) => {
    const t = meta.get(r.tidId);
    return {
      ndt: r.investorNickname || roomInvestorName, // NĐT per-lô (fallback NĐT của nhóm nếu phòng là nhóm NĐT)
      daiLy: agentName,
      date: r.date,
      time: isoToLocalParts(r.effDateIso).time, // giờ VN "HH:mm" từ mốc bill thật
      tid: r.borrowed ? (r.borrowedTid ?? t?.tid ?? String(r.tidId)) : (t?.tid ?? String(r.tidId)),
      // [Admin Demo 16/9 khuya] lô đóng 95 → "84(95)" (kể cả khi đã có số lô ngân hàng) để theo dõi lô rủi ro.
      lo: ((): string => { const g = String(r.bankReportedLoNumber ?? r.billLoNumber ?? `#${r.loId} (nội bộ)`); const sc = String(r.settlementCode ?? '').replace(/[^0-9]/g, ''); return sc && !g.includes('(') ? `${g}(${sc})` : g; })(),
      truoc: r.gross,
      sau: r.net,
      bankName: (r.borrowed ? r.borrowedBank : t?.bankName) ?? undefined,
      hkdName: (r.borrowed ? r.borrowedHkd : t?.hkdName) ?? undefined, // cột "Tên HKD" báo cáo đại lý
      fee: r.fee, // cột "% phí" = fee/gross
      borrowed: r.borrowed, // [Admin Demo 7/9] cờ + tên chủ TID mượn → hiện nhãn "Mượn TID của <chủ>"
      tidOwnerName: r.tidOwnerName
    };
  });
}

// ═══ [Admin Demo 16/9 tối] BÁO CÁO ẢNH LÔ POS (brand SigMa, khuôn veCanvasBaoCaoQr) + khối VietQR hoàn ═══
interface HoanQrLo {
  img: HTMLImageElement; accName: string; accBank: string; accNo: string; tien: number; dealer: string;
  /** [Admin Demo 17/9] NỘI DUNG CK in trên ảnh phải TRÙNG nội dung nhúng trong mã QR ("YC 001" / "DL a Binh SG").
   *  Trước ghi cứng "SigMa hoan lo POS <đại lý>" → người đọc ảnh và người quét QR thấy 2 nội dung khác nhau. */
  noiDung?: string;
}
function veCanvasBaoCaoLo(rows: RevenueLotRow[], dealer: string, hoan?: HoanQrLo): HTMLCanvasElement {
  // [Admin Demo 17/9 "bảng thông tin lô, giao dịch to rõ hơn"] rowH 46→56 + cỡ chữ tăng đều (xem bên dưới).
  const W = 1150, S = 2, padX = 34, rowH = 56;
  const H = 150 + 108 + rows.length * rowH + 96 + 46 + (hoan ? 500 : 0); // [16/9 tối] QR x2
  const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
  const c = cv.getContext('2d')!; c.scale(S, S);
  c.fillStyle = '#f2f7fc'; c.fillRect(0, 0, W, H);
  const gr = c.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0, '#0f1a24'); gr.addColorStop(0.6, '#1877d6'); gr.addColorStop(1, '#3bc3d0');
  c.fillStyle = gr; c.fillRect(0, 0, W, 96);
  c.fillStyle = '#fff'; c.font = '800 30px Segoe UI';
  c.fillText('SIGMA — BÁO CÁO LÔ POS (HOÀN SAU PHÍ)', padX, 44);
  c.font = '500 15px Segoe UI'; c.fillStyle = 'rgba(255,255,255,.85)';
  c.fillText(`Đại lý ${dealer} · lập lúc ` + new Date().toLocaleString('vi-VN', { hour12: false }), padX, 74);
  const cols = [padX, 176, 470, 620, 800, 930, W - padX];
  const money2 = (n: number): string => Math.round(n).toLocaleString('vi-VN');
  const ptext = (txt: string, x: number, y: number, align: CanvasTextAlign): void => { const a = c.textAlign; c.textAlign = align; c.fillText(txt, x, y); c.textAlign = a; };
  const rr = (x: number, y: number, w: number, h: number, r0: number): void => { c.beginPath(); c.arcTo(x + w, y, x + w, y + h, r0); c.arcTo(x + w, y + h, x, y + h, r0); c.arcTo(x, y + h, x, y, r0); c.arcTo(x, y, x + w, y, r0); c.closePath(); };
  const fitText = (txt: string, maxW: number): string => {
    if (c.measureText(txt).width <= maxW) return txt;
    let t = txt;
    while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  };
  let y = 96 + 30;
  c.fillStyle = '#1763a5'; c.font = '800 23px Segoe UI';
  c.fillText('Lô được chọn', padX, y);
  y += 26;
  c.fillStyle = '#1763a5'; rr(padX - 10, y, W - 2 * padX + 20, 44, 10); c.fill();
  c.fillStyle = '#fff'; c.font = '800 16px Segoe UI';
  c.fillText('NGÀY · GIỜ', cols[0] + 6, y + 29);
  c.fillText('HKD', cols[1], y + 29);
  c.fillText('TID', cols[2], y + 29);
  ptext('LÔ', cols[3], y + 29, 'right');
  ptext('DOANH SỐ', cols[4], y + 29, 'right');
  ptext('% PHÍ', cols[5], y + 29, 'right');
  ptext('PHẢI HOÀN', cols[6], y + 29, 'right');
  y += 44;
  let tongTruoc = 0, tongSau = 0, i = 0;
  for (const r of rows) {
    i += 1; tongTruoc += r.truoc; tongSau += r.sau;
    c.fillStyle = (i % 2) ? '#ffffff' : '#eff6fd';
    c.fillRect(padX - 10, y, W - 2 * padX + 20, rowH);
    c.fillStyle = '#0f1a24'; c.font = '600 17px Segoe UI';
    const [yy, mm, dd] = r.date.split('-');
    c.fillText(`${dd}/${mm}/${yy} ${r.time ?? ''}`, cols[0] + 6, y + 35);
    c.font = '700 16px Segoe UI';
    c.fillText(fitText(r.hkdName ?? '—', cols[2] - cols[1] - 12), cols[1], y + 35);
    c.fillStyle = '#1877d6';
    c.fillText(fitText(r.tid, cols[3] - cols[2] - 60), cols[2], y + 35);
    c.fillStyle = '#0f1a24'; c.font = '800 17px Segoe UI';
    ptext(r.lo, cols[3], y + 35, 'right');
    c.fillStyle = '#059669'; c.font = '800 19px Segoe UI';
    ptext(money2(r.truoc) + 'đ', cols[4], y + 35, 'right');
    c.fillStyle = '#b45309'; c.font = '700 16px Segoe UI';
    ptext(r.truoc > 0 ? ((r.truoc - r.sau) / r.truoc * 100).toFixed(2) + '%' : '—', cols[5], y + 35, 'right');
    c.fillStyle = '#1763a5'; c.font = '800 19px Segoe UI';
    ptext(money2(r.sau) + 'đ', cols[6], y + 35, 'right');
    y += rowH;
  }
  y += 18;
  const gr2 = c.createLinearGradient(0, y, 0, y + 72);
  gr2.addColorStop(0, '#1877d6'); gr2.addColorStop(1, '#1763a5');
  c.fillStyle = gr2; rr(padX - 10, y, W - 2 * padX + 20, 72, 14); c.fill();
  c.fillStyle = '#fff'; c.font = '800 20px Segoe UI';
  c.fillText('TỔNG ' + rows.length + ' LÔ', padX + 8, y + 44);
  c.font = '800 23px Segoe UI';
  ptext(money2(tongTruoc) + 'đ', cols[4], y + 45, 'right');
  c.font = '800 26px Segoe UI';
  ptext('HOÀN: ' + money2(tongSau) + 'đ', cols[6], y + 45, 'right');
  y += 72;
  if (hoan) {
    // [Admin Demo 16/9 tối] QR x2 (180→360px) cho dễ quét.
    const yQ = y + 16;
    const QR = 432, KHOI = 462; // [Admin Demo 16/9 khuya] QR x2.4 bản gốc (540 −20% cho khỏi phải cuộn lên xuống khi xem ảnh)
    c.fillStyle = '#ffffff'; rr(padX - 10, yQ, W - 2 * padX + 20, KHOI, 14); c.fill();
    c.strokeStyle = '#1877d6'; c.lineWidth = 2; rr(padX - 10, yQ, W - 2 * padX + 20, KHOI, 14); c.stroke();
    c.drawImage(hoan.img, padX + 10, yQ + 15, QR, QR);
    const tx = padX + QR + 34;
    c.fillStyle = '#1763a5'; c.font = '800 22px Segoe UI';
    c.fillText(fitText(`HOÀN CHO ĐẠI LÝ: ${hoan.dealer}`, W - padX - tx - 10), tx, yQ + 100);
    c.fillStyle = '#0f1a24'; c.font = '700 19px Segoe UI';
    c.fillText(fitText(`${hoan.accName} · ${hoan.accBank} · ${hoan.accNo}`, W - padX - tx - 10), tx, yQ + 150);
    c.fillStyle = '#059669'; c.font = '800 40px Segoe UI';
    c.fillText(hoan.tien.toLocaleString('vi-VN') + 'đ', tx, yQ + 222);
    c.fillStyle = '#5b7484'; c.font = '500 14px Segoe UI';
    c.fillText(fitText('Quét QR để chuyển ĐÚNG số tiền trên', W - padX - tx - 10), tx, yQ + 274);
    c.fillText(fitText('(đã làm tròn XUỐNG nghìn — bỏ phần lẻ dưới 1.000đ).', W - padX - tx - 10), tx, yQ + 300);
    c.fillText(fitText(`Nội dung: ${hoan.noiDung ?? `SigMa hoan lo POS ${hoan.dealer}`}`, W - padX - tx - 10), tx, yQ + 326);
    y = yQ + KHOI;
  }
  c.fillStyle = '#5b7484'; c.font = '500 12px Segoe UI';
  c.fillText('SigMa · Báo cáo lô POS · phải hoàn = doanh số − phí bán · liên hệ SigMa để đối soát', padX, y + 30);
  return cv;
}

/** [Admin Demo 17/9 — "gom hết vào blog lúc ấn xác nhận đối soát, topbar sẽ có menu tạo ảnh báo cáo, yêu cầu gộp
 *  bill, xác nhận hoàn tiền, thay vì phải thao tác 3 button ở ngoài"]
 *
 *  KHỐI ĐỐI SOÁT LÔ — mở NGAY khi bấm "Xác nhận đối soát" cho các lô đang tích. Cả quy trình chạy 1 mạch trong
 *  đây, thao tác nằm trên THANH TRÊN của khối:
 *     📸 Tạo ảnh báo cáo → 🧾 Yêu cầu gộp bill (YC) → 💸 Xác nhận hoàn tiền (gen QR VietQR) → ⬇ Xuất file ảnh
 *  Trước đây 3 nút rời ngoài màn doanh số, phải nhớ thứ tự và tự đối chiếu — nay đi thẳng theo dòng việc. */
function LotImageReportModal(
  { rows, dealer, onClose, lotIds = [], maYcSan = null, ycAmountSan = null, onXong }: {
    rows: RevenueLotRow[]; dealer: string; onClose: () => void;
    lotIds?: number[];        // lô đang xử (tạo YC / đánh dấu hoàn)
    maYcSan?: string | null;  // các lô này đã thuộc YC nào chưa
    ycAmountSan?: number | null; // số tiền ĐÃ CHỐT của YC đó (để bắt lệch khi tích thêm/bớt lô)
    onXong?: () => void;      // báo màn cha nạp lại trạng thái + mã YC
  }
): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  // [Admin Demo 17/9] 1 đại lý có NHIỀU TK nhận (nhà Bảo: OCB·Bảo và TPB·Phi) → phải CHỌN được, và ảnh/QR phải theo
  // ĐÚNG TK đang chọn. Trước đây luôn lấy TK mặc định ⇒ chọn Phi vẫn gen ra Bảo = chuyển nhầm người.
  const [dsTk, setDsTk] = useState<DealerRefundAccount[]>([]);
  const [tkChon, setTkChon] = useState<string>('');
  const [maYc, setMaYc] = useState<string | null>(maYcSan);
  const [daHoan, setDaHoan] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // [Admin Demo 17/9 "sinh đúng số tiền chống hoàn thừa thiếu"] Giữ CẢ HAI con số: tổng THẬT phải hoàn và số ĐƯA
  // VÀO QR (tròn xuống nghìn theo luật hoàn). Chênh lệch = phần lẻ bị bỏ → HIỆN RA, không để thiếu âm thầm.
  const tongThat = Math.round(rows.reduce((s, r) => s + r.sau, 0));
  const tongSauPhi = lamTronNghinXuong(tongThat);
  const leBoDi = tongThat - tongSauPhi;
  // Lô đã gộp YC rồi mà tổng hiện tại KHÁC số đã chốt trong YC (tích thêm/bớt lô) ⇒ quét QR là chuyển SAI số.
  const tienYcDaChot = maYcSan ? (ycAmountSan ?? null) : null;
  const lechVoiYc = tienYcDaChot != null && tienYcDaChot !== tongSauPhi ? tongSauPhi - tienYcDaChot : 0;

  /** Bước 1 — dựng ảnh báo cáo (kèm khối QR nếu đại lý đã có TK nhận). */
  async function taoAnhBaoCao(ycHienTai: string | null): Promise<void> {
    setBusy('anh');
    try {
      let hoan: HoanQrLo | undefined;
      if (tongSauPhi > 0 && dealer !== '—') {
        // TK dùng để gen = TK ĐANG CHỌN trong khối (không phải TK mặc định) — sai chỗ này là chuyển nhầm người.
        const acc = dsTk.find((x) => x.accountNo === tkChon) ?? dsTk.find((x) => x.isDefault) ?? dsTk[0] ?? null;
        if (acc) {
          // Nội dung CK = MÃ YC nếu đã gộp (Admin Demo chốt "YC 001"); chưa gộp thì theo tên đại lý.
          const q = await fetchVietQrPngUrl(dealer, tongSauPhi, ycHienTai ? maYcHienThi(ycHienTai) : noiDungChuyenKhoanQr('DL', dealer), acc.accountNo);
          if (q.ok) {
            const img = new Image();
            await new Promise<void>((rs, rj) => { img.onload = () => rs(); img.onerror = () => rj(new Error('QR load')); img.src = q.data; });
            hoan = { img, accName: acc.accountName, accBank: acc.bankCode, accNo: acc.accountNo, tien: tongSauPhi, dealer,
              noiDung: ycHienTai ? maYcHienThi(ycHienTai) : noiDungChuyenKhoanQr('DL', dealer) };
          }
        }
      }
      setDataUrl(veCanvasBaoCaoLo(rows, dealer, hoan).toDataURL('image/png'));
    } catch {
      setDataUrl(veCanvasBaoCaoLo(rows, dealer).toDataURL('image/png'));
    } finally { setBusy(null); }
  }
  useEffect(() => {
    let huy = false;
    void getDealerRefundAccounts(dealer).then((r) => {
      if (huy || !r.ok) return;
      setDsTk(r.data);
      const mac = r.data.find((x) => x.isDefault) ?? r.data[0];
      setTkChon(mac?.accountNo ?? '');
    });
    return () => { huy = true; };
  }, [dealer]);
  // Dựng ảnh lần đầu + MỖI KHI ĐỔI TK (ảnh/QR phải khớp TK đang chọn — Admin Demo 17/9).
  useEffect(() => { void taoAnhBaoCao(maYc); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tkChon]);

  /** Bước 2 — gộp các lô này thành 1 YÊU CẦU HOÀN; mã YC chính là nội dung chuyển khoản. */
  async function taoYeuCauGop(): Promise<void> {
    if (lotIds.length === 0) { setMsg('Không có lô nào để gộp.'); return; }
    setBusy('yc'); setMsg(null);
    const acc = dsTk.find((x) => x.accountNo === tkChon) ?? dsTk.find((x) => x.isDefault) ?? dsTk[0] ?? null;
    const r = await taoYc({
      dealerKey: dealer, dealerLabel: dealer, nguon: 'DL', lotIds, amount: tongSauPhi,
      bankCode: acc?.bankCode ?? null, accountNo: acc?.accountNo ?? null, accountName: acc?.accountName ?? null
    });
    setBusy(null);
    if (!r.ok) { setMsg(r.message); return; }
    setMaYc(r.data.data.code);
    setMsg(r.data.message);
    onXong?.();
    void taoAnhBaoCao(r.data.data.code); // vẽ lại ảnh để nội dung CK mang mã YC
  }

  /** Bước 3 — xác nhận ĐÃ HOÀN + hiện QR VietQR để quét chuyển. */
  async function xacNhanHoan(): Promise<void> {
    setBusy('hoan'); setMsg(null);
    const r = maYc ? await xacNhanYcDaChuyen(maYc) : await postLotRefundDone(lotIds, dealer, tongSauPhi);
    setBusy(null);
    if (!r.ok) { setMsg(r.message); return; }
    setDaHoan(true);
    setMsg(r.data.message);
    onXong?.();
    // [Admin Demo 17/9 "bấm tạo QR đi tiền lại sinh 2 mã QR"] KHÔNG hiện QR riêng nữa — ẢNH BÁO CÁO bên dưới đã nhúng
    // QR (to, quét được, kèm tên/STK/ngân hàng). Chỉ VẼ LẠI ảnh để QR mang đúng mã YC vừa chốt.
    void taoAnhBaoCao(maYc);
  }

  function taiAnh(): void {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `BaoCaoLo_${(dealer || 'DaiLy').replace(/[^\p{L}\d]+/gu, '')}_${ymdLocal(new Date()).replace(/-/g, '')}.png`;
    a.click();
  }

  const nut = 'rounded-full px-3 py-1.5 text-sm font-bold transition disabled:opacity-40';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose} data-testid="lot-rpt-modal">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-0 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* THANH TRÊN = MENU QUY TRÌNH (thay 3 nút rời ngoài màn doanh số) */}
        <div className="sticky top-0 z-10 border-b border-line bg-white px-4 py-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-extrabold text-slate-800">Đối soát {rows.length} lô · {dealer}</span>
            <span className="font-bold tabular-nums text-brand" data-testid="tien-hoan">
              Phải hoàn {fmtVnd(tongSauPhi)}đ
              {leBoDi > 0 && <span className="ml-1 text-xs font-semibold text-slate-500">(Σ thật {fmtVnd(tongThat)}đ · bỏ lẻ {fmtVnd(leBoDi)}đ)</span>}
            </span>
            {maYc && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-extrabold text-brand" data-testid="yc-trong-khoi">{maYcHienThi(maYc)}</span>}
            {daHoan && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-extrabold text-emerald-700">✓ Đã hoàn tiền</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-testid="btn-tao-anh" disabled={busy !== null} onClick={() => void taoAnhBaoCao(maYc)}
              className={`${nut} border-2 border-brand/50 bg-white text-brand hover:bg-brand/10`}>📸 Tạo ảnh báo cáo</button>
            <button type="button" data-testid="btn-yeu-cau-gop" disabled={busy !== null || !!maYc || lotIds.length === 0} onClick={() => void taoYeuCauGop()}
              title={maYc ? `Đã gộp vào ${maYcHienThi(maYc)}` : 'Gộp các lô này thành 1 yêu cầu hoàn — mã YC dùng làm nội dung chuyển khoản'}
              className={`${nut} border-2 border-brand bg-white text-brand hover:bg-brand/10`}>🧾 {maYc ? `Đã gộp ${maYcHienThi(maYc)}` : 'Yêu cầu gộp bill'}</button>
            <button type="button" data-testid="btn-xac-nhan-hoan" disabled={busy !== null || daHoan || lechVoiYc !== 0} onClick={() => void xacNhanHoan()}
              title={lechVoiYc !== 0 ? 'Số tiền đang chọn khác số đã chốt của YC — sửa lại trước khi hoàn' : 'Ghi ĐÃ CHUYỂN TIỀN cho các lô này'}
              className={`${nut} border-2 border-success bg-success/10 text-success hover:bg-success/20`}>💸 Xác nhận hoàn tiền + QR</button>
            <button type="button" data-testid="btn-xuat-anh" disabled={!dataUrl} onClick={taiAnh}
              className={`${nut} border border-brand bg-brand-tint text-brand-deep hover:bg-brand/10`}>⬇ Xuất file ảnh</button>
            <button type="button" onClick={onClose} className={`${nut} ml-auto border border-line bg-white text-slate-600`}>Đóng</button>
          </div>
          {/* [Admin Demo 17/9] Tổng hiện tại KHÁC số đã chốt trong YC (do tích thêm/bớt lô) ⇒ quét QR là chuyển SAI
              số so với yêu cầu đã tạo → CHẶN nhầm bằng cảnh báo đỏ, nói rõ chênh bao nhiêu. */}
          {lechVoiYc !== 0 && (
            <div className="mt-1.5 rounded-lg border-2 border-danger bg-danger/10 px-2.5 py-1.5 text-xs font-bold text-danger" data-testid="canh-bao-lech-yc">
              ⚠ Số tiền đang chọn ({fmtVnd(tongSauPhi)}đ) KHÁC số đã chốt của {maYcHienThi(maYcSan ?? '')} ({fmtVnd(tienYcDaChot ?? 0)}đ) — chênh {lechVoiYc > 0 ? '+' : ''}{fmtVnd(lechVoiYc)}đ.
              Bỏ bớt/chọn lại đúng các lô của yêu cầu này, hoặc huỷ YC rồi gộp lại — quét QR bây giờ là chuyển SAI số.
            </div>
          )}
          {msg && <div className="mt-1.5 text-xs font-semibold text-slate-600" data-testid="khoi-msg">{msg}</div>}
        </div>
        <div className="space-y-3 p-4">
          {/* [Admin Demo 17/9] CHỌN TK NHẬN — danh sách DỌC, mỗi thẻ mang MÀU BRAND ngân hàng, tên chủ TK cỡ to;
              thẻ đang chọn NỔI 3D. Dropdown cũ chữ bé, dễ chọn nhầm người nhận tiền (ca thật: chọn Phi ra Bảo). */}
          {dsTk.length > 0 && (
            <div data-testid="ds-tk-hoan">
              <div className="mb-1.5 text-[11px] font-extrabold uppercase tracking-wide text-slate-400">Tài khoản nhận tiền hoàn ({dsTk.length})</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {dsTk.map((a) => {
                  const mau = bankColor(a.bankCode) ?? '#1877d6';
                  const chon = a.accountNo === tkChon;
                  return (
                    <button key={a.accountNo} type="button" data-testid="tk-item" onClick={() => setTkChon(a.accountNo)}
                      aria-pressed={chon}
                      className={`flex items-center gap-3 rounded-2xl border-2 bg-white px-3 py-2.5 text-left transition-all ${chon
                        ? '-translate-y-0.5 shadow-lg ring-2 ring-offset-1'
                        : 'border-line shadow-sm hover:-translate-y-0.5 hover:shadow-md'}`}
                      style={chon ? { borderColor: mau, boxShadow: `0 8px 18px -6px ${mau}80`, ['--tw-ring-color' as string]: `${mau}55` } : undefined}>
                      {/* Ô tích tròn — nhìn là biết đang chọn cái nào */}
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2"
                        style={{ borderColor: mau, background: chon ? mau : 'transparent' }}>
                        {chon && <span className="text-sm font-black leading-none text-white">✓</span>}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-extrabold leading-tight text-slate-800">{a.accountName}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-md px-1.5 py-0.5 text-[11px] font-extrabold text-white" style={{ background: mau }}>{a.bankCode}</span>
                          <span className="font-mono text-sm font-bold tabular-nums text-slate-600">{a.accountNo}</span>
                          {a.isDefault && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">mặc định</span>}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {dataUrl ? <img src={dataUrl} alt="Báo cáo lô POS" className="w-full rounded-xl border border-line" /> : <div className="my-8 text-center text-sm text-slate-400">Đang dựng ảnh…</div>}
        </div>
      </div>
    </div>
  );
}

/** YYYY-MM-DD LOCAL (cho input type=date) — KHÔNG dùng toISOString (lệch múi giờ). */
function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Đầu ngày LOCAL từ chuỗi YYYY-MM-DD — an toàn múi giờ (KHÔNG new Date(str) vì bị hiểu UTC). */
function startOfDayLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Màu + nhãn trạng thái đối soát hoàn tiền — KHỚP KpiReportScreen (đủ=xanh, thiếu=hổ phách, thừa=đỏ, chưa hoàn=xám). */
function reconcileStatus(s: 'match' | 'over' | 'partial' | 'none'): { color: string; label: string } {
  switch (s) {
    // Admin Demo 1/9 (áp TOÀN APP): THIẾU=ĐỎ (SigMa còn nợ, gấp) · THỪA=VÀNG (đại lý nợ lại, cảnh báo nhẹ).
    case 'over': return { color: '#d97706', label: 'Hoàn thừa' };
    case 'partial': return { color: '#dc2626', label: 'Hoàn thiếu' };
    case 'none': return { color: '#94a3b8', label: 'Chưa hoàn' };
    default: return { color: '#16a34a', label: 'Hoàn đủ' };
  }
}

function fmtVnd(n: number): string {
  return n.toLocaleString('vi-VN') + 'đ';
}
/** Trạng thái TỔNG kỳ có DUNG SAI (Agent-1 1/9): |thừa/thiếu| ≤ 50k = KHỚP (xanh), tránh kỳ cân bằng lệch vài đồng
 *  làm tròn hiện ĐỎ "+0". (Per-day đã có dung sai riêng ±50k ở backend.) */
const TOTAL_RECONCILE_TOLERANCE_VND = 50_000;
function totalReconcileStatus(tt: number): 'match' | 'over' | 'partial' {
  return Math.abs(tt) <= TOTAL_RECONCILE_TOLERANCE_VND ? 'match' : tt > 0 ? 'over' : 'partial';
}
/** YYYY-MM-DD (backend) → DD/MM/YYYY (Admin Demo ghét ngược năm-tháng-ngày; đồng bộ fmtBillDate của card CK). */
function ymdToDmy(s: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s ?? '—');
}

const TID_SWATCHES = ['#f59e0b', '#16a34a', '#8b5cf6', '#0ea5e9', '#ec4899', '#14b8a6'];

export function RoomRevenueScreen(): JSX.Element {
  const navigate = useNavigate();
  const { roomId } = useParams();
  // [Admin Demo 7/9] NHỚ kỳ + khoảng ngày qua tab/menu (sessionStorage theo phòng). Đọc lúc khởi tạo, ghi khi đổi.
  const PERIOD_SNAP = `roomRev.period.${roomId ?? ''}`;
  const persisted = useMemo(() => { try { return JSON.parse(sessionStorage.getItem(PERIOD_SNAP) ?? 'null') as { period?: PeriodKey; rangeMode?: boolean; from?: string; to?: string } | null; } catch { return null; } }, [PERIOD_SNAP]);
  // [Admin Demo 10/9] "mở doanh số của NĐT/đại lý ở phòng chat PHẢI LUÔN mặc định là ngày HÔM NAY" → KHÔNG khôi phục
  // kỳ đã chọn lần trước (trước đây nhớ kỳ nên mở ra hay thấy "Tuần này" rồi tưởng số hôm nay). Người dùng vẫn đổi
  // kỳ bình thường sau khi mở; lựa chọn đó chỉ sống trong lần xem này.
  const [period, setPeriod] = useState<PeriodKey>('today');
  // Chế độ "Khoảng ngày tùy chọn" (Admin Demo 1/9) — TÁI DÙNG date-range "Từ ngày/Đến ngày" của màn Doanh số NĐT
  // (InvestorRevenueScreen). rangeMode=true → dùng [customFrom, customTo] thay kỳ nhanh; giữ nửa mở [from, to).
  const [rangeMode, setRangeMode] = useState(false); // [10/9] mở ra luôn ở kỳ nhanh 'Hôm nay', không khôi phục chế độ khoảng ngày
  const [customFrom, setCustomFrom] = useState(() => persisted?.from ?? ymdLocal(new Date()));
  const [customTo, setCustomTo] = useState(() => persisted?.to ?? ymdLocal(new Date()));
  const [selectedTidId, setSelectedTidId] = useState<number | 'all'>('all');
  // [Admin Demo 9/9 — LỐI TẮT TỪ LOG] Mở kèm ?tid=&lo= (bấm cảnh báo "sót lô/sai giờ" ở màn Quét bill) → tự LỌC đúng máy
  // + TÔ SÁNG và cuộn tới đúng lô, khỏi dò tay giữa hàng trăm dòng.
  const chiDich = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    const tid = (q.get('tid') ?? '').trim();
    const lo = (q.get('lo') ?? '').trim();
    return tid ? { tid, lo } : null;
  }, []);
  const [tids, setTids] = useState<RoomTidDto[] | null>(null);
  // [Admin Demo 17/9] PANEL OCR NHÚNG: null = đóng; 'manual'/'auto' = chạy màn Quét bill gửi như TÁC VỤ CON ngay
  // trên nền doanh số (không navigate, không rời màn — doanh số của đại lý đang chọn vẫn nằm ngay dưới).
  const [ocrPanel, setOcrPanel] = useState<'manual' | 'auto' | 'qr' | null>(null);
  const [report, setReport] = useState<RoomRevenueReport | null>(null);
  // [Admin Demo 11/9] BỘ LỌC báo cáo lô: ca tiền (giờ tổng kết bill + bảng mốc bank) / ngân hàng / TID / HKD.
  const [locCa, setLocCa] = useState('');
  const [locBank, setLocBank] = useState('');
  const [locTid, setLocTid] = useState('');
  const [locHkd, setLocHkd] = useState('');
  const [invDl, setInvDl] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  // Chi tiết theo Lô của NĐT trong nhóm (Admin Demo 31/8 "làm luôn NĐT detail như đại lý trong nhóm chat") — tải khi mở.
  const [invDetail, setInvDetail] = useState<{ status: 'idle' | 'loading' | 'error' | 'ready'; data?: InvestorReportDetail | null; message?: string }>({ status: 'idle' });
  // Đối soát hoàn tiền đại lý (hướng-1) — cần hoàn (Σ net) vs đã hoàn (Σ CK waterfall khớp số) theo ngày.
  const [reconcile, setReconcile] = useState<{ status: 'idle' | 'loading' | 'error' | 'ready'; data?: RefundReconcileReport | null; message?: string }>({ status: 'idle' });
  const { showDownloadDone, downloadDialog } = useDownloadDialog();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // SỬA THẺ lô (Admin Demo 31/8 "chọn nhầm thẻ gửi rồi doanh số sai không sửa được") — picker + tải lại sau khi sửa.
  const [reloadTick, setReloadTick] = useState(0);
  const [cardEdit, setCardEdit] = useState<{ loId: number; loLabel: string; status: 'loading' | 'ready' | 'error'; data?: LoCardOptionsDto; message?: string } | null>(null);
  const [correcting, setCorrecting] = useState(false);
  // [Admin Demo 7/9] SỬA bằng ĐÚNG card review OCR (1 render gốc): nút Sửa → nhập mật khẩu → prepare-edit (nạp ảnh tin cũ
  // + review item) → render BillReviewCard y hệt OCR → "Gửi" = bug #1 tự cập nhật tin cũ + ghi lại doanh số + sổ.
  const [reviewEdit, setReviewEdit] = useState<{
    loId: number; loLabel: string; phase: 'password' | 'loading' | 'ready' | 'error';
    password: string; token?: string; item?: ReviewItem; message?: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Tên ĐẠI LÝ (tên phòng/nhóm) — cho cột "Đại lý" của bảng + tên file Excel. Tải 1 lần theo phòng.
  const [agentName, setAgentName] = useState('');
  // Trạng thái tải Excel ĐẠI LÝ (nhiều sheet theo chu kỳ) — Admin Demo 2/9.
  const [agentXlsx, setAgentXlsx] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  // [Admin Demo 7/9] LƯỚI LÔ SÓT / SAI GIỜ ghim đầu báo cáo (per-TID/ngày) — độc lập báo cáo, gọi /lot-gaps theo kỳ đang xem.
  const [lotGaps, setLotGaps] = useState<LotGapDto[]>([]);
  // [Admin Demo 7/9] LỌC bảng "Từng bill hoàn/ứng": theo TÊN NGƯỜI HOÀN (người chuyển) + theo NGÂN HÀNG (NH nhận). Rỗng = tất cả.
  const [refundNameFilter, setRefundNameFilter] = useState('');
  const [refundBankFilter, setRefundBankFilter] = useState('');
  // [Admin Demo 7/9] SỬA bill hoàn/ứng (CK) trên bảng đối soát — ngày/giờ/tiền + mật khẩu sửa (mặc định 1111).
  // [Admin Demo 11/9] Tên nhóm đang xem cho tiêu đề — lấy từ danh sách phòng (fetch nhẹ, có cache phía client).
  const [tenNhom, setTenNhom] = useState<string>('');
  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    void listChatRoomsWithNames().then((r) => {
      if (!alive || !r.ok) return;
      setTenNhom(r.data.find((x) => x.id === roomId)?.name ?? '');
    });
    return () => { alive = false; };
  }, [roomId]);

  const [refundEdit, setRefundEdit] = useState<{ messageId: string; label: string; billDate: string; billTime: string; amount: string; password: string; phase: 'form' | 'saving'; message?: string } | null>(null);
  // [Admin Demo 11/9 — "Sửa bill hoàn phải ra đúng màn review như sửa bill POS"] Nhập mật khẩu ở form trên → mở
  // TransferReviewCard (server prepare-edit trả kind='CK' + transferReview dựng từ metadata tin cũ, cùng ảnh gốc
  // → cùng hash → bấm Gửi = CẬP NHẬT chính tin cũ, không đăng trùng).
  const [ckReview, setCkReview] = useState<{ token: string; transfer: TransferReview; label: string } | null>(null);

  const range = useMemo(() => {
    if (rangeMode) {
      // Nửa mở [from, to): to = ĐẦU NGÀY KẾ của "đến ngày" — CÙNG quy ước local half-open như periodRange.
      return { from: startOfDayLocal(customFrom), to: new Date(startOfDayLocal(customTo).getTime() + 24 * 60 * 60 * 1000) };
    }
    return periodRange(period);
  }, [rangeMode, period, customFrom, customTo]);
  // Nhãn kỳ hiển thị (dùng ở khối đối soát) — kỳ nhanh dùng nhãn cố định, khoảng ngày hiện "từ → đến".
  const periodLabelText = rangeMode ? (customFrom === customTo ? customFrom : `${customFrom} → ${customTo}`) : PERIOD_LABEL[period];
  // [Admin Demo 7/9] Ghi nhớ kỳ + khoảng ngày (qua tab/menu) — persist mỗi khi đổi.
  useEffect(() => { try { sessionStorage.setItem(PERIOD_SNAP, JSON.stringify({ period, rangeMode, from: customFrom, to: customTo })); } catch { /* quota */ } }, [PERIOD_SNAP, period, rangeMode, customFrom, customTo]);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInvDetail({ status: 'idle' }); // đổi kỳ/TID → bỏ chi tiết NĐT cũ.
    getRoomRevenue(roomId, { from: range.from, to: range.to, tidId: selectedTidId === 'all' ? undefined : selectedTidId }).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setReport(r.data);
      setTids(r.data.tids);
    });
    // Đối soát hoàn tiền (hướng-1) — tải song song theo kỳ (không phụ thuộc TID, đối soát theo cả đại lý).
    setReconcile({ status: 'loading' });
    getRefundReconcile(roomId, { from: range.from, to: range.to }).then((r) => {
      if (cancelled) return;
      if (!r.ok) { setReconcile({ status: 'error', message: r.message }); return; }
      setReconcile({ status: 'ready', data: r.data });
    });
    // Lưới lô sót/sai-giờ theo kỳ (lọc về TID của phòng ở render). Lỗi → panel tự ẩn (không chặn báo cáo).
    setLotGaps([]);
    getLotGaps({ from: range.from, to: range.to }).then((r) => {
      if (cancelled) return;
      if (r.ok) setLotGaps(r.data.gaps);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, period, rangeMode, customFrom, customTo, selectedTidId, reloadTick]);

  // [Admin Demo 24/9 — BUG "sửa bill xong màn báo cáo chi tiết doanh số lô KHÔNG cập nhật"] GỐC: màn này chỉ nạp lại
  // khi ĐỔI BỘ LỌC hoặc khi bill được gửi từ CHÍNH khối OCR nhúng trong màn. Sửa bill ở nơi KHÁC (thẻ bill trong
  // phòng chat, máy khác, người khác) thì server đã đổi dữ liệu + ĐÃ PHÁT tín hiệu realtime `message-edited`
  // nhưng màn doanh số KHÔNG hề lắng nghe ⇒ đứng im với số cũ tới khi bấm làm mới ⇒ nhìn như "sửa không ăn".
  // NAY: nghe đúng phòng đang xem — có bill mới hoặc bill bị sửa là nạp lại (gộp 400ms tránh dội khi sửa liên tục).
  useEffect(() => {
    if (!roomId) return;
    let hen: number | undefined;
    const napLai = (): void => {
      window.clearTimeout(hen);
      hen = window.setTimeout(() => setReloadTick((v) => v + 1), 400);
    };
    const boSua = subscribeMessageEdited(roomId, napLai);
    const boMoi = subscribeRoomMessages(roomId, napLai);
    return () => { window.clearTimeout(hen); boSua(); boMoi(); };
  }, [roomId]);

  // Mở picker "Sửa thẻ" cho 1 lô — tải danh sách thẻ hợp lệ + phí bán % thực tế.
  function openCardEdit(loId: number, label: string): void {
    if (!roomId) return;
    setCardEdit({ loId, loLabel: label, status: 'loading' });
    fetchLoCardOptions(roomId, loId).then((r) => {
      setCardEdit((cur) => (cur && cur.loId === loId ? (r.ok ? { ...cur, status: 'ready', data: r.data } : { ...cur, status: 'error', message: r.message }) : cur));
    });
  }
  // [Admin Demo 7/9] Nút Sửa → nhập mật khẩu → mở ĐÚNG card review OCR để sửa (1 render gốc).
  function openReviewEdit(loId: number, label: string): void {
    setReviewEdit({ loId, loLabel: label, phase: 'password', password: '' });
  }
  // Xác nhận mật khẩu → resolve lô→messageId → prepare-edit (nạp ảnh + review) → render BillReviewCard.
  function submitReviewEdit(): void {
    const re = reviewEdit;
    if (!re || !roomId) return;
    if (!re.password.trim()) { setReviewEdit((c) => (c ? { ...c, message: 'Nhập mật khẩu sửa (mặc định 1111).' } : c)); return; }
    setReviewEdit((c) => (c ? { ...c, phase: 'loading', message: undefined } : c));
    getLoEditSource(roomId, re.loId).then((src) => {
      if (!src.ok) { setReviewEdit((c) => (c ? { ...c, phase: 'error', message: src.message } : c)); return; }
      prepareEditBill(src.data.messageId, re.password).then((r) => {
        setReviewEdit((c) => {
          if (!c || c.loId !== re.loId) return c;
          if (!r.ok) return { ...c, phase: 'password', message: r.error === 'BAD_PASSWORD' ? 'Sai mật khẩu sửa.' : (r.message ?? 'Không mở được bill để sửa.') };
          const item = r.data.review[0];
          if (!item) return { ...c, phase: 'error', message: 'Bill này không mở được review (thiếu ảnh/dữ liệu) — dùng đổi thẻ.' };
          return { ...c, phase: 'ready', token: r.data.token, item };
        });
      });
    });
  }
  // Sửa xong (BillReviewCard onSent) → đóng + refresh báo cáo + toast.
  function onReviewEditSent(_info: SentInfo): void {
    setReviewEdit(null);
    setToast('Đã cập nhật bill + doanh số (theo bản sửa).');
    setReloadTick((n) => n + 1);
    window.setTimeout(() => setToast(null), 4000);
  }
  // [Admin Demo 7/9] Mở form SỬA bill HOÀN/ỨNG (CK) — nạp ngày/giờ/tiền hiện tại.
  function openRefundEdit(b: { messageId: string; billDate: string | null; billTime: string | null; amount: number }, label: string): void {
    setRefundEdit({ messageId: b.messageId, label, billDate: b.billDate ?? '', billTime: b.billTime ?? '', amount: String(Math.abs(b.amount)), password: '', phase: 'form' });
  }
  // Gửi sửa bill hoàn → cập nhật metadata (ngày ISO/giờ/tiền) + refresh đối soát.
  function submitRefundEdit(): void {
    const re = refundEdit;
    if (!re) return;
    if (!re.password.trim()) { setRefundEdit((c) => (c ? { ...c, message: 'Nhập mật khẩu sửa (mặc định 1111).' } : c)); return; }
    const amt = Number(re.amount.replace(/[^\d]/g, ''));
    if (!(amt > 0)) { setRefundEdit((c) => (c ? { ...c, message: 'Số tiền không hợp lệ.' } : c)); return; }
    setRefundEdit((c) => (c ? { ...c, phase: 'saving', message: undefined } : c));
    // [Admin Demo 11/9] ƯU TIÊN mở MÀN REVIEW CK (đồng nhất bill POS). prepare-edit trả kind='CK' → TransferReviewCard;
    // tin quá cũ không mở được review → rơi về đường sửa nhanh ngày/giờ/tiền như trước (không chặn việc).
    prepareEditBill(re.messageId, re.password).then((pr) => {
      if (pr.ok && pr.data.kind === 'CK' && pr.data.transferReview?.[0]) {
        setRefundEdit(null);
        setCkReview({ token: pr.data.token, transfer: pr.data.transferReview[0], label: re.label });
        return;
      }
      if (!pr.ok && pr.error === 'BAD_PASSWORD') { setRefundEdit((c) => (c ? { ...c, phase: 'form', message: 'Sai mật khẩu sửa.' } : c)); return; }
      editRefundBill(re.messageId, re.password, { billDate: re.billDate || undefined, billTime: re.billTime || undefined, amount: amt }).then((r) => {
        if (!r.ok) { setRefundEdit((c) => (c ? { ...c, phase: 'form', message: r.error === 'BAD_PASSWORD' ? 'Sai mật khẩu sửa.' : (r.message ?? 'Không sửa được bill hoàn.') } : c)); return; }
        setRefundEdit(null);
        setToast('Đã sửa bill hoàn (ngày/giờ/tiền) — đối soát cập nhật.');
        setReloadTick((n) => n + 1);
        window.setTimeout(() => setToast(null), 4000);
      });
    });
  }
  // Sửa CK bằng review xong (TransferReviewCard onSent) → đóng + refresh đối soát.
  function onCkReviewSent(): void {
    setCkReview(null);
    setToast('Đã cập nhật bill CK — đối soát tính lại.');
    setReloadTick((n) => n + 1);
    window.setTimeout(() => setToast(null), 4000);
  }
  // Áp đổi thẻ (money → CONFIRM bắt buộc). Thành công → tải lại báo cáo + toast.
  function doCorrectCard(opt: LoCardOptionDto): void {
    if (!roomId || !cardEdit) return;
    const pct = opt.phiBanMilli != null ? (opt.phiBanMilli / 1000).toFixed(2) : '?';
    if (!window.confirm(`Đổi thẻ ${cardEdit.loLabel} sang "${opt.name}" (phí bán ${pct}%)?\nSẽ tính lại doanh số đại lý + NĐT + hủy GD cũ tạo GD mới.`)) return;
    setCorrecting(true);
    correctLoCard(roomId, cardEdit.loId, opt.cardTypeId).then((r) => {
      setCorrecting(false);
      if (!r.ok) { setCardEdit((cur) => (cur ? { ...cur, status: 'error', message: r.message } : cur)); return; }
      setCardEdit(null);
      setToast('Đã sửa thẻ — doanh số đại lý + NĐT đã cập nhật.');
      setReloadTick((n) => n + 1);
      window.setTimeout(() => setToast(null), 3500);
    });
  }

  // Tên đại lý (tên phòng) — cho cột "Đại lý" + tên file Excel. Không chặn UI nếu lỗi (cột hiện '—').
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    getChatRoomDetail(roomId).then((r) => {
      if (!cancelled && r.ok) setAgentName(r.data.name ?? '');
    });
    return () => { cancelled = true; };
  }, [roomId]);

  /** [Admin Demo 7/9] Tải Excel ĐẠI LÝ — sheet: TUẦN NÀY + THÁNG NÀY + TÁCH TỪNG NGÀY (mùng 1 → hôm nay). Bỏ 30 ngày qua.
   *  Chỉ 2 call (tuần + tháng) — sheet theo ngày CHIA từ rows tháng (đỡ 30 request). Lấy TẤT CẢ TID. */
  async function handleAgentExcelDownload(): Promise<void> {
    if (!roomId) return;
    setAgentXlsx('busy');
    try {
      const suffix = agentName ? ` · Đại lý: ${agentName}` : '';
      const weekRange = periodRange('week'), monthRange = periodRange('month');
      const [weekR, monthR] = await Promise.all([getRoomRevenue(roomId, weekRange), getRoomRevenue(roomId, monthRange)]);
      const weekRows = weekR.ok ? roomReportToLotRows(weekR.data, agentName) : [];
      const monthRows = monthR.ok ? roomReportToLotRows(monthR.data, agentName) : [];
      const sheets: RevenueSheetInput[] = [
        { name: 'Tuần này', subtitle: `Tuần này · ${ymdLocal(weekRange.from)} → ${ymdLocal(new Date(weekRange.to.getTime() - 86400000))}${suffix}`, rows: weekRows },
        { name: 'Tháng này', subtitle: `Tháng này · ${ymdLocal(monthRange.from)} → ${ymdLocal(new Date(monthRange.to.getTime() - 86400000))}${suffix}`, rows: monthRows }
      ];
      // Tách TỪNG NGÀY từ rows tháng: mùng 1 → hôm nay (mỗi ngày 1 sheet, kể cả ngày trống).
      const byDay = new Map<string, RevenueLotRow[]>();
      for (const r of monthRows) { const a = byDay.get(r.date) ?? []; a.push(r); byDay.set(r.date, a); }
      const now = new Date(); const y = now.getFullYear(), mo = now.getMonth();
      for (let d = 1; d <= now.getDate(); d++) {
        const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dd = String(d).padStart(2, '0'), mm = String(mo + 1).padStart(2, '0');
        sheets.push({ name: `${dd}.${mm}`, subtitle: `Ngày ${dd}/${mm}/${y}${suffix}`, rows: byDay.get(key) ?? [] });
      }
      const blob = buildRevenueWorkbookXls(sheets, AGENT_XLS_COLUMNS);
      const safe = (agentName || 'DaiLy').replace(/[^\p{L}\d]+/gu, '') || 'DaiLy';
      const fileName = `BaoCaoDoanhSo_${safe}_${ymdLocal(new Date()).replace(/-/g, '')}.xls`;
      const result = await downloadBlob(blob, fileName);
      setAgentXlsx('ok'); setTimeout(() => setAgentXlsx('idle'), 2500);
      showDownloadDone(result, fileName);
    } catch { setAgentXlsx('err'); setTimeout(() => setAgentXlsx('idle'), 4000); }
  }

  const tidColor = useMemo(() => {
    const map = new Map<number, string>();
    (tids ?? []).forEach((t, i) => map.set(t.tidId, TID_SWATCHES[i % TID_SWATCHES.length]));
    return map;
  }, [tids]);

  // [Admin Demo 11/9] LỌC rows theo ca/bank/TID/HKD. bank/hkd/tid của lô MƯỢN lấy theo borrowed*; ca theo GIỜ BILL
  // THẬT (effDateIso → giờ VN). Lọc ca: bill không xếp được ca (bank ngoài bảng mốc / thiếu giờ) bị LOẠI + ĐẾM.
  const coLoc = locCa !== '' || locBank !== '' || locTid !== '' || locHkd.trim() !== '';
  // [Admin Demo 12/9 "màn doanh số NĐT trong phòng chat thiếu lọc"] 1 predicate DÙNG CHUNG cho bảng chi tiết + Σ tổng
  // NĐT theo lọc — tổng lọc = Σ các cột server đã tính per-bill (amount/sauPhi/lai), KHÔNG suy luận công thức.
  const qualInvBill = (b: InvestorDetailBill): boolean => {
    if (locBank !== '' && (b.bankName ?? '') !== locBank) return false;
    if (locTid !== '' && b.tid !== locTid) return false;
    if (locHkd.trim() !== '' && !(b.hkdName ?? '').toLowerCase().includes(locHkd.trim().toLowerCase())) return false;
    if (locCa !== '') { const ca = caCuaGio(b.bankName, isoToLocalParts(b.txnDateIso).time); if (ca == null || String(ca) !== locCa) return false; }
    return true;
  };
  // [Admin Demo 12/9 — ảnh thật phòng NĐT 2 "0 TID ghi nhận"] Phòng NĐT có thể KHÔNG gắn TID nào → option
  // Bank/TID phải gộp thêm từ CHÍNH các dòng bill chi tiết NĐT (AB Bank/675122xx…), không thì dropdown rỗng.
  const invBillsForOpts = invDetail.data?.bills ?? [];
  const bankOptions = [...new Set([
    ...((tids ?? []).map((t) => t.bankName).filter((x): x is string => !!x)),
    ...invBillsForOpts.map((b) => b.bankName).filter((x): x is string => !!x)
  ])];
  const tidOptions = (() => {
    const m = new Map<string, string>();
    for (const t of tids ?? []) if (locBank === '' || t.bankName === locBank) m.set(t.tid, t.hkdName ?? '');
    for (const b of invBillsForOpts) if (locBank === '' || b.bankName === locBank) { if (!m.has(b.tid)) m.set(b.tid, b.hkdName ?? ''); }
    return [...m.entries()].map(([tid, hkd]) => ({ tid, hkd }));
  })();
  const invLoc = (() => {
    const bills = invDetail.data?.bills;
    if (!coLoc || !bills) return null;
    const bs = bills.filter(qualInvBill);
    return { n: bs.length, truoc: bs.reduce((x, b) => x + b.amount, 0), tienVe: bs.reduce((x, b) => x + b.sauPhi, 0), lai: bs.reduce((x, b) => x + b.lai, 0) };
  })();
  const { rowsLoc, soKhongCa } = useMemo(() => {
    if (!report) return { rowsLoc: [] as RoomRevenueReport['rows'], soKhongCa: 0 };
    const meta = new Map((tids ?? report.tids).map((t) => [t.tidId, t]));
    let khongCa = 0;
    const out = report.rows.filter((r) => {
      const t = meta.get(r.tidId);
      const bank = (r.borrowed ? r.borrowedBank : t?.bankName) ?? null;
      const hkd = (r.borrowed ? r.borrowedHkd : t?.hkdName) ?? '';
      const tid = (r.borrowed ? r.borrowedTid : t?.tid) ?? String(r.tidId);
      if (locBank !== '' && (bank ?? '') !== locBank) return false;
      if (locTid !== '' && tid !== locTid) return false;
      if (locHkd.trim() !== '' && !hkd.toLowerCase().includes(locHkd.trim().toLowerCase())) return false;
      if (locCa !== '') {
        const ca = caCuaGio(bank, isoToLocalParts(r.effDateIso).time);
        if (ca == null) { khongCa++; return false; }
        if (String(ca) !== locCa) return false;
      }
      return true;
    });
    return { rowsLoc: out, soKhongCa: khongCa };
  }, [report, tids, locCa, locBank, locTid, locHkd]);
  // Tổng + daily HIỂN THỊ: có lọc → tính từ rowsLoc (số đúng theo bộ lọc); không lọc → số server (giữ nguyên).
  const tongHienThi = useMemo(() => {
    if (!report) return null;
    if (!coLoc) return { gross: report.totalGross, net: report.totalNet, loCount: report.loCount, daily: report.daily };
    const byDay = new Map<string, { gross: number; net: number }>();
    let gross = 0, net = 0;
    for (const r of rowsLoc) {
      gross += r.gross; net += r.net;
      const d = byDay.get(r.date) ?? { gross: 0, net: 0 };
      d.gross += r.gross; d.net += r.net; byDay.set(r.date, d);
    }
    const daily = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]) => ({ date, gross: v.gross, net: v.net }));
    return { gross, net, loCount: rowsLoc.length, daily };
  }, [report, coLoc, rowsLoc]);

  // THỨ TỰ CHUẨN (Admin Demo 31/8): cùng NGÂN HÀNG → cùng TID → lần lượt SỐ LÔ, rồi sang bank khác. Đồng nhất với NĐT.
  const sortedRows = useMemo(() => {
    if (!report) return [];
    const meta = new Map((tids ?? report.tids).map((t) => [t.tidId, t]));
    const loOf = (r: RoomRevenueReport['rows'][number]): string | null => (r.bankReportedLoNumber != null ? String(r.bankReportedLoNumber) : r.billLoNumber);
    // [Admin Demo 16/9 "lô mới sắp xếp lên trên, lô cũ xuống dưới"] SẮP theo MỐC BILL THẬT giảm dần;
    // cùng thời điểm → nếp cũ bank→TID→lô để ổn định.
    return [...rowsLoc].sort((a, b) => {
      const ta = Date.parse(a.effDateIso) || 0, tb = Date.parse(b.effDateIso) || 0;
      if (tb !== ta) return tb - ta;
      return compareBankTidLo(
        { bankName: meta.get(a.tidId)?.bankName, tid: meta.get(a.tidId)?.tid, lo: loOf(a) },
        { bankName: meta.get(b.tidId)?.bankName, tid: meta.get(b.tidId)?.tid, lo: loOf(b) }
      );
    });
  }, [report, tids, rowsLoc]);

  // ── [Admin Demo 16/9 tối] ĐỐI SOÁT + HOÀN per LÔ (chỉ chủ SigMa thấy nút; server vẫn owner-gate) ──
  const laChuAlpha = isAlphaOwnerCode(getCachedAuthenticatedAgent()?.code);
  const [lotRecon, setLotRecon] = useState<Record<string, { ds: boolean; refundDone: boolean; note?: string | null }>>({});
  const [lotTick, setLotTick] = useState<Set<number>>(new Set());
  // [Admin Demo 17/9] Lọc đủ trạng thái đang dùng hằng ngày: đối soát (chưa/đã) · hoàn tiền (chưa/đã) · YC (chưa/đã tạo).
  const [lotLoc, setLotLoc] = useState<'all' | 'chua' | 'choHoan' | 'daHoan' | 'chuaHoan' | 'daYc' | 'chuaYc'>('all');
  const [locYc, setLocYc] = useState(''); // [17/9] lọc theo MÃ YC (khớp lỏng: "1" / "yc001" / "YC 001" đều ra)
  const [lotMsg, setLotMsg] = useState<string | null>(null);
  const [lotHoi, setLotHoi] = useState<'ds' | 'boDs' | null>(null);
  const [lotRefundGroups, setLotRefundGroups] = useState<NhomHoan[] | null>(null);
  const [lotRptOpen, setLotRptOpen] = useState(false);
  // [Admin Demo 17/9] MÃ YC của từng lô — "phải có cache đại lý nào đi với mã YC bao nhiêu". Nạp cùng trạng thái đối soát.
  const [ycTheoLo, setYcTheoLo] = useState<Record<string, { code: string; status: string; amount: number }>>({});
  useEffect(() => { // nạp trạng thái đối soát + mã YC của các lô đang hiện (chủ SigMa)
    if (!laChuAlpha || sortedRows.length === 0) { setLotRecon({}); setYcTheoLo({}); return; }
    let huy = false;
    const ids = sortedRows.map((r) => r.loId);
    void getPosLotRecon(ids).then((r) => { if (!huy && r.ok) setLotRecon(r.data); });
    void getYcTheoLo(ids).then((r) => { if (!huy && r.ok) setYcTheoLo(r.data); });
    return () => { huy = true; };
  }, [laChuAlpha, sortedRows]);
  /** Nạp lại mã YC sau khi tạo/huỷ — bảng phải hiện ngay, không đợi đổi kỳ. */
  async function napLaiYc(): Promise<void> {
    const r = await getYcTheoLo(sortedRows.map((x) => x.loId));
    if (r.ok) setYcTheoLo(r.data);
  }
  /** Tên đại lý CHUẨN cho danh bạ TK/QR: bỏ tiền tố phòng "ĐL -"/"QR -" (danh bạ lưu "Tuyên SG", phòng tên "ĐL - Tuyên SG"). */
  const tenDaiLyChuan = (agentName || '').replace(/^\s*(QR|ĐL|DL)\s*[-_—–]?\s*/i, '').trim() || agentName || '—';
  /** Trạng thái 1 lô: chua → choHoan (ds) → daHoan (ds + refund_done). */
  const lotTrangThai = (loId: number): 'chua' | 'choHoan' | 'daHoan' => {
    const r = lotRecon[String(loId)];
    return !r || !r.ds ? 'chua' : r.refundDone ? 'daHoan' : 'choHoan';
  };
  async function lamRecon(ds: boolean): Promise<void> {
    const ids = [...lotTick]; if (ids.length === 0) return;
    const r = await postPosLotRecon(ids, ds);
    setLotMsg(r.ok ? r.data.message : r.message);
    if (r.ok) { const rc = await getPosLotRecon(sortedRows.map((x) => x.loId)); if (rc.ok) setLotRecon(rc.data); if (!ds) setLotTick(new Set()); }
  }
  /** [Admin Demo 17/9] GỘP các lô đang tích thành 1 YÊU CẦU HOÀN (YC001…): 1 mã · 1 số tiền · danh sách lô cố định.
   *  Mã YC chính là NỘI DUNG CHUYỂN KHOẢN trên VietQR → bill CK về khớp bằng MÃ, không phải dò theo số tiền. */
  async function gopTaoYc(): Promise<void> {
    const ids = [...lotTick];
    if (ids.length === 0) { setLotMsg('Chưa tích lô nào để gộp.'); return; }
    const daCo = ids.filter((id) => ycTheoLo[String(id)]);
    if (daCo.length > 0) { setLotMsg(`${daCo.length} lô đã thuộc YC khác (${[...new Set(daCo.map((id) => maYcHienThi(ycTheoLo[String(id)]!.code)))].join(', ')}) — bỏ tích lô đó ra.`); return; }
    const rows = sortedRows.filter((r) => lotTick.has(r.loId));
    const tong = rows.reduce((s, r) => s + r.net, 0);
    const tk = await getDealerRefundAccount(tenDaiLyChuan);
    const acc = tk.ok ? tk.data : null;
    const r = await taoYc({
      dealerKey: tenDaiLyChuan, dealerLabel: tenDaiLyChuan, nguon: 'DL', lotIds: ids, amount: tong,
      bankCode: acc?.bankCode ?? null, accountNo: acc?.accountNo ?? null, accountName: acc?.accountName ?? null
    });
    if (!r.ok) { setLotMsg(r.message); return; }
    setLotMsg(r.data.message);
    await napLaiYc();
  }

  /** Mã YC chung của các lô đang tích — CHỈ khi TẤT CẢ cùng 1 YC. Lô lẻ/khác YC → null (giữ đường hoàn từng lô cũ,
   *  không gộp bừa 2 yêu cầu vào 1 lệnh chuyển). */
  const ycChung = useMemo<string | null>(() => {
    const ids = [...lotTick];
    if (ids.length === 0) return null;
    const codes = new Set(ids.map((id) => ycTheoLo[String(id)]?.code ?? ''));
    return codes.size === 1 && !codes.has('') ? [...codes][0]! : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lotTick, ycTheoLo]);

  function moHoanTien(): void {
    const ids = [...lotTick]; if (ids.length === 0) return;
    const chuaDs = ids.filter((id) => lotTrangThai(id) === 'chua');
    if (chuaDs.length > 0) { setLotMsg(`${chuaDs.length} lô chưa xác nhận đối soát — xác nhận đối soát trước rồi mới hoàn.`); return; }
    const rows = sortedRows.filter((r) => lotTick.has(r.loId));
    const tong = rows.reduce((s, r) => s + r.net, 0);
    setLotRefundGroups([{ dealer: tenDaiLyChuan, billIds: ids.map(String), tongGoc: tong, thieuPhi: 0 }]);
  }

  // Hàng bảng ĐẠI LÝ hiển thị — map TỪ sortedRows (CÙNG thứ tự) để index nút "Sửa thẻ" khớp sortedRows[index].
  // [Admin Demo 16/9] LỌC theo trạng thái đối soát/hoàn (chủ SigMa) — bảng + nút Sửa cùng nguồn, index khớp 1:1.
  const sortedRowsHienThi = useMemo(() => {
    if (!laChuAlpha) return sortedRows;
    const q = locYc.trim().replace(/[^0-9a-zA-Z]/g, '').toUpperCase(); // "YC 001" → "YC001"; "1" → "1"
    return sortedRows.filter((r) => {
      const tt = lotTrangThai(r.loId);                 // 'chua' | 'choHoan' | 'daHoan'
      const coYc = !!ycTheoLo[String(r.loId)];          // lô đã nằm trong 1 yêu cầu gộp chưa
      if (lotLoc === 'chua' || lotLoc === 'choHoan' || lotLoc === 'daHoan') { if (tt !== lotLoc) return false; }
      else if (lotLoc === 'chuaHoan') { if (tt === 'daHoan') return false; } // chưa đối soát + chờ hoàn
      else if (lotLoc === 'daYc') { if (!coYc) return false; }
      else if (lotLoc === 'chuaYc') { if (coYc) return false; }
      if (!q) return true;
      const code = (ycTheoLo[String(r.loId)]?.code ?? '').toUpperCase(); // "YC001"
      if (!code) return false;
      // khớp lỏng: gõ "1" ra YC001; gõ "YC001"/"yc 001" cũng ra.
      return code.includes(q) || code.replace(/^YC0*/, '').includes(q.replace(/^YC0*/, ''));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedRows, lotLoc, lotRecon, laChuAlpha, locYc, ycTheoLo]);
  const daiLyLotRows = useMemo<RevenueLotRow[]>(() => {
    const roomInvestorName = report?.investor?.investorName ?? '';
    return sortedRowsHienThi.map((r) => {
      const t = tids?.find((x) => x.tidId === r.tidId);
      return {
        ndt: r.investorNickname || roomInvestorName, // NĐT per-lô (backend resolve TID→NĐT); fallback NĐT của nhóm
        daiLy: agentName,
        date: r.date,
        time: isoToLocalParts(r.effDateIso).time, // giờ VN "HH:mm" từ mốc bill thật (effDateIso)
        tid: r.borrowed ? (r.borrowedTid ?? t?.tid ?? String(r.tidId)) : (t?.tid ?? String(r.tidId)),
        // [Admin Demo 16/9 khuya] lô đóng 95 → "84(95)" (kể cả khi đã có số lô ngân hàng) để theo dõi lô rủi ro.
      lo: ((): string => { const g = String(r.bankReportedLoNumber ?? r.billLoNumber ?? `#${r.loId} (nội bộ)`); const sc = String(r.settlementCode ?? '').replace(/[^0-9]/g, ''); return sc && !g.includes('(') ? `${g}(${sc})` : g; })(),
        truoc: r.gross,
        sau: r.net,
        bankName: (r.borrowed ? r.borrowedBank : t?.bankName) ?? undefined,
        hkdName: (r.borrowed ? r.borrowedHkd : t?.hkdName) ?? undefined, // cột "Tên HKD" báo cáo đại lý
        fee: r.fee, // cột "% phí" = fee/gross
        borrowed: r.borrowed, // [Admin Demo 7/9] nhãn "Mượn TID của <chủ>" trên bảng
        tidOwnerName: r.tidOwnerName,
        // [Admin Demo 17/9] CỘT "Mã YC" cạnh tiền hoàn sau phí — lô đã gộp vào yêu cầu hoàn nào (YC 001).
        maYc: ycTheoLo[String(r.loId)] ? maYcHienThi(ycTheoLo[String(r.loId)]!.code) : null,
        // [Admin Demo 21/9] GHI CHÚ per-lô (đồng nhất ĐL/NĐT/hoàn tiền) — nguồn pos_lot_recon.note qua getPosLotRecon.
        loId: r.loId,
        note: lotRecon[String(r.loId)]?.note ?? null
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedRowsHienThi, tids, agentName, report, ycTheoLo]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !report) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width || 300;
    const h = 150;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const daily = tongHienThi?.daily ?? report.daily; // [Admin Demo 11/9] chart theo bộ lọc
    if (daily.length === 0) return;
    const maxVal = Math.max(...daily.map((d) => d.gross), 1) * 1.15;
    // Đồ thị X-Y RÕ RÀNG (Admin Demo 31/8): thêm nhãn trục Y (TIỀN) bên trái + nhãn ngày X dưới. padL rộng cho số tiền.
    const padL = 48;
    const padR = 8;
    const padT = 12;
    const padB = 22;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const bw = plotW / daily.length;
    const shortMoney = (n: number): string => n >= 1e9 ? `${(n / 1e9).toFixed(1)}tỷ` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}tr` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));

    // Lưới ngang + NHÃN TIỀN trục Y (4 mức) + trục X-Y.
    ctx.strokeStyle = '#eef1f6';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px ui-sans-serif, system-ui';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const gy = padT + plotH * (g / 4);
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
      ctx.fillText(shortMoney(maxVal * (1 - g / 4)), padL - 5, gy); // nhãn tiền giảm dần từ trên xuống
    }
    // trục Y dọc + trục X ngang (đậm hơn)
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(w - padR, padT + plotH); ctx.stroke();
    ctx.textBaseline = 'alphabetic';

    daily.forEach((d, i) => {
      const bh = (d.gross / maxVal) * plotH;
      const x = padL + i * bw + bw * 0.22;
      const bwReal = bw * 0.56;
      const y = padT + plotH - bh;
      ctx.fillStyle = '#1877d6';
      ctx.globalAlpha = 0.85;
      const r = 3;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + bwReal, y, x + bwReal, y + bh, r);
      ctx.arcTo(x + bwReal, y + bh, x, y + bh, r);
      ctx.arcTo(x, y + bh, x, y, r);
      ctx.arcTo(x, y, x + bwReal, y, r);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    ctx.beginPath();
    daily.forEach((d, i) => {
      const cy = padT + plotH - (d.net / maxVal) * plotH;
      const cx = padL + i * bw + bw / 2;
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    daily.forEach((d, i) => {
      const cy = padT + plotH - (d.net / maxVal) * plotH;
      const cx = padL + i * bw + bw / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = '#16a34a';
      ctx.fill();
    });

    // NHÃN NGÀY trục X — thưa bớt nếu nhiều ngày (chống chữ chồng): hiện tối đa ~8 nhãn.
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.ceil(daily.length / 8));
    daily.forEach((d, i) => {
      if (i % step !== 0 && i !== daily.length - 1) return;
      const cx = padL + i * bw + bw / 2;
      const [, mm, dd] = d.date.split('-'); // YYYY-MM-DD → dd/mm (đúng thứ tự VN)
      ctx.fillText(`${dd}/${mm}`, cx, h - 6);
    });
  }, [tongHienThi, report]);

  const inv = report?.investor;
  // [Admin Demo 12/9] Bật bộ lọc trong phòng NĐT → tự nạp chi tiết theo Lô (nguồn số cho tổng-theo-lọc) + mở bảng.
  useEffect(() => {
    // Phòng NĐT → tự nạp + mở chi tiết theo Lô (nguồn option lọc Bank/TID + tổng-theo-lọc; ảnh thật Admin Demo 12/9
    // phòng 0-TID vẫn phải lọc được theo bill). Người dùng vẫn ẩn được bằng nút.
    if (inv && invDetail.status === 'idle') toggleInvestorDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv?.investorId]);
  async function handleInvestorDownload(): Promise<void> {
    if (!inv) return;
    setInvDl('busy');
    try {
      const url = investorReportExportXlsxUrl(inv.investorId, inv.from, inv.to);
      const safe = inv.investorName.replace(/[^\p{L}\d]+/gu, '') || `NDT${inv.investorId}`;
      const fileName = `BaoCaoNDT_${safe}_${inv.to.replace(/-/g, '')}.xlsx`;
      const result = await downloadAttachment(url, fileName);
      setInvDl('ok'); setTimeout(() => setInvDl('idle'), 2500);
      showDownloadDone(result, fileName); // hộp thoại "Đã tải xong. Mở file?".
    } catch { setInvDl('err'); setTimeout(() => setInvDl('idle'), 4000); }
  }
  /** Mở/ẩn chi tiết theo Lô của NĐT nhóm này — tải khi mở lần đầu (đúng kỳ đang xem). */
  function toggleInvestorDetail(): void {
    if (!inv) return;
    if (invDetail.status !== 'idle') { setInvDetail({ status: 'idle' }); return; }
    setInvDetail({ status: 'loading' });
    fetchInvestorReportDetail(inv.investorId, inv.from, inv.to).then((res) => {
      setInvDetail(res.ok ? { status: 'ready', data: res.data } : { status: 'error', message: res.message });
    });
  }

  if (!roomId) return <div className="p-4 text-sm text-danger">Thiếu roomId.</div>;

  return (
    <div className="flex h-full flex-col bg-appbg">
      {/* Route lồng TRONG AppShell (CÙNG pattern ReconcileDetailScreen.tsx) — TopBar chung đã lo status-bar
          safe-area, KHÔNG cần đệm riêng ở đây (tránh đệm đúp). */}
      <div className="border-b border-line bg-white px-4">
        <div className="flex items-center gap-2 py-2.5">
          <BackButton variant="icon-only" onClick={() => navigate(-1)} className="shrink-0" />
          <div className="min-w-0 flex-1">
            {/* [Admin Demo 11/9] Tiêu đề PHẢI nêu ĐANG XEM NHÀ NÀO — tên nhóm lấy từ danh sách phòng (cùng nguồn
                màn chat), NĐT/đại lý phân theo hạng tên + khối investor của báo cáo. */}
            <h1 className="truncate text-sm font-bold text-slate-800">
              Doanh số · <span className="text-brand">{tenNhom || '…'}</span>
              {report?.investor ? <span className="ml-1 rounded-full bg-brand/10 px-1.5 py-px text-[10px] font-bold uppercase text-brand">Nhà đầu tư</span> : null}
            </h1>
            <p className="truncate text-xs text-slate-400">{(tids?.length ?? 0)} TID ghi nhận doanh số nhóm này</p>
          </div>
          {/* [Admin Demo 17/9 "chọn quét bill trong màn doanh số bị VĂNG về OCR, không chạy nền trên màn doanh số"]
              2 nút này TRƯỚC ĐÂY navigate sang màn Quét bill gửi ⇒ rời hẳn màn doanh số. NAY mở PANEL NHÚNG ngay
              dưới đây (tác vụ con): vừa OCR vừa nhìn doanh số của đúng đại lý đang chọn. Bấm lại = đóng panel. */}
          <div className="flex shrink-0 items-center gap-2">
            {([
              { key: 'manual', label: '🧾 OCR thủ công', title: 'Quét 1 ảnh bill (thủ công) — mở ngay trên nền doanh số' },
              { key: 'auto', label: '📂 OCR tự động', title: 'Quét cả folder bill (tự động) — mở ngay trên nền doanh số' },
              { key: 'qr', label: '🔳 OCR QR', title: 'Quét bill QR — mở ngay trên nền doanh số' }
            ] as const).map((b) => (
              <button key={b.key} type="button" data-testid={`lot-btn-ocr-${b.key}`} title={b.title}
                onClick={() => setOcrPanel((m) => (m === b.key ? null : b.key))}
                className={`rounded-full border-2 px-3 py-1.5 text-xs font-bold transition ${ocrPanel === b.key ? 'border-brand bg-brand text-white' : 'border-brand/50 bg-white text-brand hover:bg-brand/10'}`}>{b.label}</button>
            ))}
          </div>
        </div>

        {/* [Admin Demo 17/9] PANEL OCR NHÚNG — "tác vụ con trên nền doanh số": mở ngay dưới tên đại lý, doanh số vẫn
            nằm nguyên bên dưới (chỉ cuộn xuống là thấy). Dùng CHÍNH <OcrSendScreen/> nên clone 100% tính năng,
            không có bản sao code để lệch về sau. KHÔNG dùng key={mode} (remount = mất tiến trình OCR đang chạy):
            OcrSendScreen tự đổi tab theo initialMode bằng effect, giữ nguyên bill đang review + hàng đợi folder. */}

        {/* Bộ chọn kỳ — segmented brand-3D glass (ĐỒNG BỘ OcrSendScreen seg(): glass-panel + .btn-primary active),
            hết nút phẳng lệch brand/màu sai (Admin Demo 1/9). Kỳ nhanh + chế độ "Khoảng ngày tùy chọn" (TÁI DÙNG
            date-range "Từ ngày/Đến ngày" của màn Doanh số NĐT — InvestorRevenueScreen). KHÔNG cuộn ngang. */}
        <div className="space-y-1.5 pb-2.5">
          {/* [Admin Demo 7/9] Kỳ nhanh (5, bỏ "7 ngày qua") + nút "Từ → Đến" CÙNG hàng; ô chọn ngày NẰM TRONG CÙNG card
              (không tràn xuống block riêng). flex-nowrap + input co được → không xuống dòng. */}
          {/* [Admin Demo 7/9] rangeMode BẬT → ẩn tab kỳ, hiện Từ [ngày] → Đến [ngày] TRÊN CÙNG 1 HÀNG + nút ‹ Kỳ để quay lại. */}
          <div className="glass-panel shadow-soft rounded-2xl border border-line p-1">
            {rangeMode ? (
              <div className="flex flex-nowrap items-center gap-1.5 px-0.5">
                <button type="button" onClick={() => setRangeMode(false)} title="Quay lại kỳ nhanh" className="shrink-0 rounded-full px-2 py-1.5 text-xs font-bold text-slate-500 hover:text-slate-700">‹ Kỳ</button>
                <span className="shrink-0 text-xs font-semibold text-slate-500">Từ</span>
                <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} className="min-w-0 flex-1 rounded-lg-mac border border-line bg-appbg px-1.5 py-1 text-xs tabular-nums text-slate-700" />
                <span className="shrink-0 text-slate-400">→</span>
                <span className="shrink-0 text-xs font-semibold text-slate-500">Đến</span>
                <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} className="min-w-0 flex-1 rounded-lg-mac border border-line bg-appbg px-1.5 py-1 text-xs tabular-nums text-slate-700" />
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-1 sm:grid-cols-7">
                {(Object.keys(PERIOD_LABEL) as PeriodKey[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => { setPeriod(k); setRangeMode(false); }}
                    className={'rounded-full px-2 py-1.5 text-center text-xs font-bold transition ' + (period === k ? 'btn-primary text-white' : 'text-slate-500 hover:text-slate-700')}
                  >
                    {PERIOD_LABEL[k]}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setRangeMode(true)}
                  title="Chọn khoảng ngày Từ → Đến (nhớ khi chuyển tab/menu)"
                  className="flex items-center justify-center gap-1 rounded-full px-2 py-1.5 text-xs font-bold text-slate-500 transition hover:text-slate-700"
                >
                  <CalendarRange className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Từ → Đến</span>
                </button>
                {/* [Admin Demo 7/9] Nút Tải Excel đại lý NGOÀI CÙNG hàng tab kỳ. Chỉ báo cáo đại lý (không nhóm NĐT). */}
                {report && tids && tids.length > 0 && !inv && (
                  <button
                    type="button"
                    onClick={() => void handleAgentExcelDownload()}
                    disabled={agentXlsx === 'busy'}
                    title="Tải Excel đại lý: nhiều sheet Tuần/Tháng + từng ngày (mùng 1 → hôm nay)"
                    className={'flex items-center justify-center gap-1 rounded-full px-2 py-1.5 text-xs font-bold transition ' + (agentXlsx === 'err' ? 'text-danger' : agentXlsx === 'ok' ? 'text-success' : 'text-brand hover:bg-brand/10') + (agentXlsx === 'busy' ? ' opacity-60' : '')}
                  >
                    {agentXlsx === 'busy' ? '⏳' : agentXlsx === 'ok' ? '✓ Excel' : agentXlsx === 'err' ? 'Lỗi' : '⬇ Excel'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Dải TID lọc — wrap tự do, không cuộn ngang. */}
        {tids && tids.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-2.5">
            <button
              onClick={() => setSelectedTidId('all')}
              className={
                'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ' +
                (selectedTidId === 'all' ? 'bg-brand-tint text-brand ring-1 ring-brand' : 'border border-line text-slate-600')
              }
            >
              <span className="h-2 w-2 rounded-full bg-brand" /> Tất cả TID
            </button>
            {/* [Admin Demo 7/9] Chip TID SẮP theo BANK (MBV→MB→ABB→khác) rồi TID TĂNG DẦN; card RỘNG hiện rõ tên HKD;
                click NỔI 3D (nhấc + đổ bóng) dễ nhìn. Màu theo bank (Admin Demo 31/8). */}
            {[...tids].sort((a, b) => {
              const rank = (n?: string | null): number => { const s = (n ?? '').toUpperCase(); return s.includes('MBV') ? 0 : s.includes('MB') ? 1 : s.includes('ABB') ? 2 : 3; };
              const ra = rank(a.bankName), rb = rank(b.bankName);
              return ra !== rb ? ra - rb : (Number(a.tid) || 0) - (Number(b.tid) || 0);
            }).map((t) => {
              const bc = bankColor(t.bankName) ?? '#64748b';
              const active = selectedTidId === t.tidId;
              return (
                <button
                  key={t.tidId}
                  onClick={() => setSelectedTidId(t.tidId)}
                  className={'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all duration-150 ' + (active ? '-translate-y-0.5' : 'hover:-translate-y-px')}
                  style={active
                    ? { color: bc, backgroundColor: `${bc}1a`, boxShadow: `inset 0 0 0 1.5px ${bc}, 0 6px 14px -4px ${bc}66` }
                    : { color: bc, boxShadow: `inset 0 0 0 1px var(--color-line)` }}
                  title={`${t.bankName ?? ''} · ${t.hkdName ?? ''} · ${t.tid}`}
                >
                  <IconBank className="h-3 w-3 shrink-0" />
                  <span className="tabular-nums">{t.tid}</span>
                  {t.hkdName && <span className="max-w-[180px] truncate font-normal opacity-80">· {t.hkdName}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-4 pt-0 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400">
            <DotsLoader /> Đang tải doanh số...
          </div>
        )}
        {!loading && error && <p className="text-sm text-danger">{error}</p>}

        {/* [Admin Demo 7/9] LƯỚI LÔ SÓT / SAI NGÀY-GIỜ — ghim ĐẦU báo cáo. Lọc về TID của phòng. Thiếu lô (đỏ chắc /
            hổ phách thưa) + nghi đọc sai lô (số lạc ngoài cụm) + sai giờ (lô↑ giờ↓). CHỈ báo, KHÔNG suy tiền — kiểm tay. */}
        {!loading && !error && (() => {
          const roomTidSet = new Set((tids ?? []).map((t) => t.tid));
          const gaps = lotGaps.filter((g) => roomTidSet.size === 0 || roomTidSet.has(g.tid));
          if (gaps.length === 0) return null;
          return (
            <div className="mb-3 overflow-hidden rounded-lg-mac border border-amber-300 bg-amber-50/70">
              <div className="flex items-center gap-1.5 border-b border-amber-200 bg-amber-100/70 px-3 py-2 text-[12px] font-bold text-amber-800">
                🚩 Nghi sót lô / sai ngày-giờ · {gaps.length} mục — kiểm tay (không tự suy tiền)
              </div>
              <div className="divide-y divide-amber-200/70">
                {gaps.map((g, gi) => (
                  <div key={`${g.tid}-${g.day}-${gi}`} className="flex flex-col gap-1 px-3 py-2 text-[12px]">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-bold text-slate-700">{g.hkdName ?? g.tid}</span>
                      <span className="tabular-nums text-slate-400">· TID {g.tid}</span>
                      <span className="tabular-nums text-slate-500">· {ymdToDmy(g.day)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {g.missing.length > 0 && (
                        <span className={'rounded-full px-2 py-0.5 text-[11px] font-semibold ' + (g.sparse ? 'bg-amber-200/80 text-amber-900' : 'bg-danger/15 text-danger')}>
                          {g.sparse ? 'Nghi thiếu' : 'THIẾU'} lô: {g.missing.length > 20 ? `${g.missing.slice(0, 20).join(', ')}… (+${g.missing.length - 20})` : g.missing.join(', ')}
                        </span>
                      )}
                      {g.suspectMisread.length > 0 && (
                        <span className="rounded-full bg-violet-200/70 px-2 py-0.5 text-[11px] font-semibold text-violet-900">
                          Nghi đọc sai lô: {g.suspectMisread.join(', ')}
                        </span>
                      )}
                      {g.timeBackward.map((tb, ti) => (
                        <span key={ti} className="rounded-full bg-orange-200/70 px-2 py-0.5 text-[11px] font-semibold text-orange-900">
                          Sai giờ: lô {tb.lot} ({tb.time ?? '?'}) sau lô {tb.prevLot} ({tb.prevTime ?? '?'})
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* GHIM SUMMARY (Admin Demo 31/8 "luôn ghim NĐT + Đại lý chống cuộn bị mất trôi lên trên"): pin đầu vùng cuộn;
            chi tiết NĐT + biểu đồ + danh sách lô cuộn PHÍA DƯỚI. Nền đục + shadow để không lộ nội dung cuộn phía sau. */}
        {!loading && !error && (inv || (report && tids && tids.length > 0)) && (
          <div className="sticky top-0 z-20 -mx-4 mb-3 space-y-2.5 border-b border-line/60 bg-appbg px-4 pb-2.5 pt-3 shadow-sm">
            {report && (inv != null || report.rows.length > 0) && (
              <div className="flex flex-wrap items-end gap-2 rounded-lg-mac border border-line bg-white p-2.5">
                {/* [Admin Demo 11/9] BỘ LỌC báo cáo lô: ca tiền / ngân hàng / TID / HKD — tổng + bảng + chart theo lọc. */}
                <label className="flex flex-col text-[10px] font-bold uppercase tracking-wide text-slate-400">Ca tiền
                  <select value={locCa} onChange={(e) => setLocCa(e.target.value)} className="mt-1 rounded-lg-mac border border-line bg-appbg px-2 py-1 text-xs font-semibold text-slate-700">
                    <option value="">Tất cả</option><option value="1">Ca 1</option><option value="2">Ca 2</option><option value="3">Ca 3</option>
                  </select>
                </label>
                <label className="flex flex-col text-[10px] font-bold uppercase tracking-wide text-slate-400">Ngân hàng
                  <select value={locBank} onChange={(e) => { setLocBank(e.target.value); setLocTid(''); }} className="mt-1 rounded-lg-mac border border-line bg-appbg px-2 py-1 text-xs font-semibold text-slate-700">
                    <option value="">Tất cả</option>
                    {bankOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </label>
                <label className="flex flex-col text-[10px] font-bold uppercase tracking-wide text-slate-400">TID
                  <select value={locTid} onChange={(e) => setLocTid(e.target.value)} className="mt-1 max-w-[180px] rounded-lg-mac border border-line bg-appbg px-2 py-1 text-xs font-semibold text-slate-700">
                    <option value="">Tất cả</option>
                    {tidOptions.map((t) => <option key={t.tid} value={t.tid}>{t.tid}{t.hkd ? ` · ${t.hkd}` : ''}</option>)}
                  </select>
                </label>
                <label className="flex flex-col text-[10px] font-bold uppercase tracking-wide text-slate-400">Tên HKD
                  <input type="text" value={locHkd} placeholder="Chứa chữ…" onChange={(e) => setLocHkd(e.target.value)} className="mt-1 w-[120px] rounded-lg-mac border border-line bg-appbg px-2 py-1 text-xs font-semibold text-slate-700" />
                </label>
                {coLoc && (
                  <button type="button" onClick={() => { setLocCa(''); setLocBank(''); setLocTid(''); setLocHkd(''); }} className="rounded-lg-mac border border-line bg-white px-2 py-1 text-xs font-semibold text-slate-500 hover:border-danger hover:text-danger">✕ Bỏ lọc</button>
                )}
                {locCa !== '' && soKhongCa > 0 && (
                  <span className="text-[10px] font-semibold text-amber-600">⚠ {soKhongCa} lô không xếp được ca (bank ngoài bảng mốc/thiếu giờ) — đã loại khỏi lọc ca.</span>
                )}
              </div>
            )}
            {/* [Admin Demo 2/9] BỎ khối "Đối soát hoàn tiền" ghim-đầu — Cần/Đã/Thừa-Thiếu ĐÃ có trong "BÁO CÁO HOÀN TIỀN"
                bên dưới (tránh hiện 2 lần, rối mắt). Chỉ còn 1 báo cáo hoàn tiền theo chu kỳ tab. */}
            {inv && (
              <div className="rounded-lg-mac border border-brand/30 bg-brand-tint p-3">
                <div className="mb-2.5 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold text-slate-800">Doanh số nhà đầu tư · {inv.investorName}</div>
                    <div className="text-[11px] text-slate-500">{inv.soBill} bill · kỳ {inv.from === inv.to ? inv.from : `${inv.from} → ${inv.to}`}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleInvestorDownload()}
                    disabled={invDl === 'busy'}
                    className={
                      'flex shrink-0 items-center gap-1.5 rounded-lg-mac border px-3 py-2 text-xs font-semibold transition ' +
                      (invDl === 'err' ? 'border-danger/50 bg-danger/10 text-danger' : invDl === 'ok' ? 'border-success/50 bg-success/10 text-success' : 'border-brand/50 bg-white text-brand hover:bg-brand/10 disabled:opacity-60')
                    }
                  >
                    {invDl === 'busy' ? 'Đang tạo…' : invDl === 'ok' ? '✓ Đã tải' : invDl === 'err' ? 'Lỗi, thử lại' : '⬇ Tải Excel'}
                  </button>
                  <InvestorBaocoCheck investorId={inv.investorId} from={inv.from} to={inv.to} />
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {/* [Admin Demo 12/9] Có BỘ LỌC → hiện số THEO LỌC (Σ per-bill server) + số trọn kỳ nhỏ bên dưới. */}
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Doanh số (trước phí){invLoc ? ' · theo lọc' : ''}</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-700">{(invLoc ? invLoc.truoc : inv.doanhThu).toLocaleString('vi-VN')}đ</div>
                    {invLoc && <div className="text-[10px] text-slate-400">trọn kỳ: {inv.doanhThu.toLocaleString('vi-VN')}đ</div>}
                  </div>
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Tiền về (sau phí){invLoc ? ' · theo lọc' : ''}</div>
                    <div className="mt-0.5 text-sm font-bold text-brand">{(invLoc ? invLoc.tienVe : inv.tienVe).toLocaleString('vi-VN')}đ</div>
                    {invLoc && <div className="text-[10px] text-slate-400">trọn kỳ: {inv.tienVe.toLocaleString('vi-VN')}đ</div>}
                  </div>
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Lãi NĐT (0,1%){invLoc ? ' · theo lọc' : ''}</div>
                    <div className="mt-0.5 text-sm font-bold text-success">{(invLoc ? invLoc.lai : inv.laiNDT).toLocaleString('vi-VN')}đ</div>
                    {invLoc && <div className="text-[10px] text-slate-400">trọn kỳ: {inv.laiNDT.toLocaleString('vi-VN')}đ</div>}
                  </div>
                  {/* [Admin Demo 13/9 "là số đã tạm ứng − sau phí cm + lãi chứ"] Ô PHẢI HOÀN VỀ = TẠM ỨNG − tiền về
                      (sau phí cài máy) + lãi — đồng nhất menu Doanh số NĐT + tra soát. Tạm ứng theo NĐT (không theo
                      lọc TID) → ô này luôn tính TRỌN KỲ. Giữ dấu: âm = NĐT nhận dư/chưa ứng đủ. */}
                  {/* [Admin Demo 13/9 "phải có ô đã tạm ứng, đã hoàn về"] 2 ô LUÔN hiện (0 nếu chưa có). */}
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Đã tạm ứng</div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-700">{(inv.tamUng ?? 0).toLocaleString('vi-VN')}đ</div>
                  </div>
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Đã hoàn về NĐT</div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums text-emerald-700">{(inv.daHoan ?? 0).toLocaleString('vi-VN')}đ</div>
                  </div>
                  {/* [Admin Demo 13/9 "tách riêng QR"] Ô tạm ứng CHỈ POS (trừ QR per-GD); NĐT có QR → ô tím
                      "trả SigMa theo phí mua"; thuần QR → chỉ ô tím. */}
                  {(() => {
                    const q = inv.qr ?? null;
                    const tvPos = inv.tienVe - (q?.tvTrongReport ?? 0);
                    const laiPos = inv.laiNDT - (q?.laiTrongReport ?? 0);
                    const thuanQr = q != null && tvPos === 0 && (inv.tamUng ?? 0) === 0;
                    const phv = (inv.tamUng ?? 0) - tvPos + laiPos;
                    return (
                      <>
                        {!thuanQr && (
                          <div className="rounded-lg-mac border border-amber-300/60 bg-amber-50 p-2.5" data-testid="phai-hoan-ve-phong">
                            <div className="text-[11px] font-semibold text-amber-700">Phải hoàn về (ứng − sau phí + lãi{q ? ', POS' : ''})</div>
                            <div className={`mt-0.5 text-sm font-extrabold tabular-nums ${phv < 0 ? 'text-danger' : 'text-amber-700'}`}>{phv < 0 ? '−' : ''}{Math.abs(phv).toLocaleString('vi-VN')}đ</div>
                            <div className="text-[10px] text-amber-600/80">ứng {(inv.tamUng ?? 0).toLocaleString('vi-VN')}đ trọn kỳ</div>
                          </div>
                        )}
                        {q && (
                          <div className="rounded-lg-mac border border-violet-300/60 bg-violet-50 p-2.5" data-testid="qr-tra-alpha-phong">
                            <div className="text-[11px] font-semibold text-violet-700">NĐT trả SigMa (QR, sau phí mua)</div>
                            <div className="mt-0.5 text-sm font-extrabold tabular-nums text-violet-700">{q.traAlpha.toLocaleString('vi-VN')}đ</div>
                            <div className="text-[10px] text-violet-600/80">giữ phí mua {q.phiMuaGiu.toLocaleString('vi-VN')}đ · {q.soBill} GD QR</div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
                {invLoc && invDetail.status === 'loading' && <div className="mt-1 text-[10px] text-slate-400">Đang nạp chi tiết để tính theo lọc…</div>}
                {/* Chi tiết theo Lô của NĐT (đồng nhất đại lý) — mở/ẩn; danh sách chi tiết render DƯỚI vùng ghim (cuộn). */}
                <button
                  type="button"
                  onClick={() => toggleInvestorDetail()}
                  className="mt-3 w-full rounded-lg-mac border border-brand/40 bg-white px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/10"
                >
                  {invDetail.status !== 'idle' ? '▲ Ẩn chi tiết theo Lô' : '▼ Xem chi tiết theo Lô'}
                </button>
              </div>
            )}
            {/* [Admin Demo 7/9] 2 BLOG CÙNG 1 HÀNG: trái = Doanh số (theo kỳ), phải = Hoàn tiền (theo kỳ). lg:2 cột. */}
            <div className="grid gap-2 lg:grid-cols-2 lg:items-start">
            {/* [Admin Demo 7/9] BỎ card "Phí đã trừ" → 3 ô: Tổng trước phí · Sau phí thực nhận · Số lô. */}

            {report && tids && tids.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg-mac border border-brand/30 bg-brand-tint p-2.5">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-brand/70">Tổng trước phí{coLoc ? ' (lọc)' : ''}</div>
                  <div className="mt-0.5 text-sm font-extrabold tabular-nums text-brand break-words">{fmtVnd(tongHienThi?.gross ?? report.totalGross)}</div>
                </div>
                <div className="rounded-lg-mac border border-line bg-white p-2.5">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Sau phí (thực nhận){coLoc ? ' (lọc)' : ''}</div>
                  <div className="mt-0.5 text-sm font-extrabold tabular-nums text-slate-800 break-words">{fmtVnd(tongHienThi?.net ?? report.totalNet)}</div>
                </div>
                <div className="rounded-lg-mac border border-line bg-white p-2.5">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Số lô{coLoc ? ' (lọc)' : ''}</div>
                  <div className="mt-0.5 text-sm font-extrabold tabular-nums text-slate-800">{tongHienThi?.loCount ?? report.loCount}</div>
                </div>
              </div>
            )}
            {/* [Admin Demo 2/9 "hoàn tiền GHIM Ở TRÊN, dưới doanh số"] SUMMARY hoàn tiền ghim ngay dưới doanh số (chi tiết
                theo ngày + từng bill ở DƯỚI, không lặp tổng). */}
            {reconcile.status === 'ready' && reconcile.data && (reconcile.data.days.length > 0 || reconcile.data.unmatchedDaHoan > 0 || reconcile.data.totalDaUng > 0) && (() => {
              const rec = reconcile.data;
              const st = reconcileStatus(totalReconcileStatus(rec.totalThuaThieu));
              // [Admin Demo 7/9] BỎ header "Hoàn tiền · period"; 3 card GIỐNG khối doanh số (cùng cao); trạng thái hoàn-đủ
              // vào NGAY card "Đã hoàn" (cùng 1 card, cùng dòng).
              return (
                <div className="space-y-2">
                  {/* [Admin Demo 12/9] Hàng 1 = 3 ô Cần/Đã/Ứng THU NHỎ + whitespace-nowrap (hết break-words tràn 2 hàng);
                      Thừa/thiếu TÁCH thành Ô RIÊNG hàng dưới (không còn đè trên đầu số Đã hoàn). */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-lg-mac border border-line bg-white px-1.5 py-1.5"><div className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Cần hoàn</div><div className="mt-0.5 text-[11px] font-extrabold tabular-nums whitespace-nowrap text-slate-700">{fmtVnd(rec.totalCanHoan)}</div></div>
                    <div className="rounded-lg-mac border px-1.5 py-1.5" style={{ borderColor: `${st.color}55`, background: `${st.color}0d` }}>
                      <div className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Đã hoàn</div>
                      <div className="mt-0.5 text-[11px] font-extrabold tabular-nums whitespace-nowrap" style={{ color: st.color }}>{fmtVnd(rec.totalDaHoan)}</div>
                    </div>
                    {/* [Admin Demo 4/9] Đã ứng > 0 = ứng CÒN TREO (đại lý chưa trả) → "chưa trả" đỏ; =0 = đã trả. */}
                    <div className="rounded-lg-mac border border-brand/25 bg-brand/5 px-1.5 py-1.5"><div className="whitespace-nowrap text-[9px] font-bold uppercase tracking-wide text-brand/80">Ứng {rec.totalDaUng > 0 ? <span className="text-danger">chưa trả</span> : <span className="text-success">đã trả</span>}</div><div className="mt-0.5 text-[11px] font-extrabold tabular-nums whitespace-nowrap text-brand">{fmtVnd(rec.totalDaUng)}</div></div>
                  </div>
                  <div className="rounded-lg-mac border px-2.5 py-1.5" style={{ borderColor: `${st.color}55`, background: `${st.color}12` }} data-testid="o-thua-thieu">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: st.color }}>Hoàn thừa/thiếu · {st.label}</span>
                      <span className="text-[11px] font-extrabold tabular-nums whitespace-nowrap" style={{ color: st.color }}>{rec.totalThuaThieu >= 0 ? '+' : ''}{fmtVnd(rec.totalThuaThieu)}</span>
                    </div>
                  </div>
                </div>
              );
            })()}
            </div>
            {/* [Admin Demo 7/9] Nút Tải Excel đã CHUYỂN lên hàng tab kỳ (ngoài cùng) — bỏ nút dưới summary. */}
          </div>
        )}

        {/* Chi tiết NĐT theo Lô — CUỘN (không ghim) để khối summary pin luôn gọn. */}
        {!loading && !error && inv && invDetail.status !== 'idle' && (
          <div className="mb-3 rounded-lg-mac border border-brand/30 bg-white p-3">
            {invDetail.status === 'loading' && (
              <div className="flex items-center justify-center gap-2 py-4 text-xs text-slate-400"><DotsLoader /> Đang tải chi tiết…</div>
            )}
            {invDetail.status === 'error' && (
              <p className="py-3 text-center text-xs text-danger">Không tải được chi tiết: {invDetail.message}</p>
            )}
            {invDetail.status === 'ready' && (
              <InvestorDetailLots bills={(invDetail.data?.bills ?? []).filter(qualInvBill)} investorName={inv.investorName} />
            )}
          </div>
        )}

        {!loading && !error && report && tids && tids.length === 0 && !inv && (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-slate-400">
            {/* Chỉ XEM: khách/đại lý không tự gắn TID — TID↔khách do admin quản trên desktop (Admin Demo 21/8). */}
            <p>Nhóm này chưa có TID nào ghi nhận doanh số.</p>
          </div>
        )}

        {!loading && !error && report && tids && tids.length > 0 && (
          <>

            <div className="mt-3 rounded-lg-mac border border-line bg-white p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700">Tăng trưởng doanh số</span>
                <span className="flex items-center gap-2.5 text-[10.5px] text-slate-400">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-brand" /> Trước phí
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-success" /> Sau phí
                  </span>
                </span>
              </div>
              {report.daily.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-400">Chưa có dữ liệu trong kỳ này.</p>
              ) : (
                <canvas ref={canvasRef} style={{ width: '100%', height: 150 }} />
              )}
            </div>

            {/* CHI TIẾT THEO LÔ — BẢNG CHIA CỘT kiểu Excel, BỘ CỘT ĐẠI LÝ (Admin Demo 2/9 "phòng đại lý sao lại có NĐT"):
                Tên HKD·Ngân hàng·TID·Số lô·Ngày·Giờ·Trước phí·% phí·Sau phí — KHÔNG có NĐT/Đại lý. Zebra + hover 3D.
                Đại lý xem "Sau phí" = số PHẢI HOÀN nếu lô hủy (= net). Nút "Sửa thẻ" ở cột cuối. NÚT TẢI EXCEL — 1
                file nhiều sheet theo từng chu kỳ tab (dùng AGENT_COLUMNS, KHỚP bảng). */}
            <div className="mt-3 rounded-lg-mac border border-line bg-white p-2.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-bold text-slate-700">Chi tiết theo Lô</div>
                  <div className="truncate text-[10px] text-slate-400">Sau phí = số phải hoàn nếu lô hủy{agentName ? ` · Đại lý: ${agentName}` : ''}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleAgentExcelDownload()}
                  disabled={agentXlsx === 'busy'}
                  className={
                    'flex shrink-0 items-center gap-1.5 rounded-lg-mac border px-3 py-2 text-xs font-semibold transition ' +
                    (agentXlsx === 'err' ? 'border-danger/50 bg-danger/10 text-danger' : agentXlsx === 'ok' ? 'border-success/50 bg-success/10 text-success' : 'border-brand/50 bg-white text-brand hover:bg-brand/10 disabled:opacity-60')
                  }
                  title="Tải Excel: nhiều sheet theo từng chu kỳ (hôm nay/hôm qua/tuần/tháng…), mỗi sheet sắp theo ngày"
                >
                  {agentXlsx === 'busy' ? 'Đang tạo…' : agentXlsx === 'ok' ? '✓ Đã tải' : agentXlsx === 'err' ? 'Lỗi, thử lại' : '⬇ Tải Excel'}
                </button>
              </div>
              {/* [Admin Demo 16/9 tối] LÀM TẮT sau OCR: lọc trạng thái + tick nhiều lô → Xác nhận đối soát / Hoàn tiền
                  (QR VietQR) / Báo cáo ảnh / Excel lô đã chọn. Chỉ CHỦ SIGMA thấy (server vẫn owner-gate). */}
              {laChuAlpha && (
                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg-mac border border-brand/20 bg-brand-tint/40 px-2.5 py-2">
                  {/* [Admin Demo 17/9] LỌC THEO MÃ YC — gõ "1" hay "YC001" đều ra, để soi nhanh 1 yêu cầu gộp gồm lô nào. */}
                  <input value={locYc} onChange={(e) => { setLocYc(e.target.value); setLotTick(new Set()); }}
                    placeholder="Lọc mã YC…" data-testid="lot-filter-yc"
                    className="w-32 rounded-xl border-2 border-line bg-white px-3 py-2 text-sm font-semibold text-slate-700 placeholder:font-normal placeholder:text-slate-400" />
                  <select value={lotLoc} onChange={(e) => { setLotLoc(e.target.value as typeof lotLoc); setLotTick(new Set()); }}
                    className="rounded-xl border-2 border-line bg-white px-3 py-2 text-sm font-semibold text-slate-700" data-testid="lot-filter">
                    <option value="all">Tất cả lô</option>
                    <option value="chua">Chưa đối soát</option>
                    <option value="choHoan">Đã đối soát — chờ hoàn</option>
                    <option value="chuaHoan">CHƯA hoàn tiền (gồm chưa đối soát)</option>
                    <option value="daHoan">Đã hoàn tiền</option>
                    <option value="daYc">Đã tạo YC</option>
                    <option value="chuaYc">Chưa tạo YC</option>
                  </select>
                  <button type="button" className="rounded-full border-2 border-line bg-white px-4 py-2 text-sm font-bold text-slate-600 transition hover:text-slate-800"
                    onClick={() => setLotTick((t) => t.size === sortedRowsHienThi.length ? new Set() : new Set(sortedRowsHienThi.map((r) => r.loId)))}>
                    {lotTick.size === sortedRowsHienThi.length && sortedRowsHienThi.length > 0 ? '☐ Bỏ chọn hết' : '☑ Chọn hết'}
                  </button>
                  <span className="rounded-full bg-brand px-3 py-1.5 text-sm font-extrabold text-white tabular-nums shadow-sm">{lotTick.size} lô</span>
                  {/* [Admin Demo 16/9 khuya "nút quá bé, tích chọn quá nhỏ khó chọn — làm rõ ràng như QR"] Pill TO
                      (py-2 + chữ sm + viền dày) đồng cỡ action bar màn Báo cáo QR. */}
                  {/* [Admin Demo 17/9] "gom hết vào blog lúc ấn xác nhận đối soát — topbar có menu tạo ảnh báo cáo,
                      yêu cầu gộp bill, xác nhận hoàn tiền, thay vì thao tác 3 button ở ngoài". Ngoài này CHỈ còn
                      1 nút mở quy trình; 3 nút cũ (gộp YC / hoàn tiền / tạo ảnh) đã chuyển vào thanh của khối. */}
                  <button type="button" disabled={lotTick.size === 0} onClick={() => setLotHoi('ds')} data-testid="lot-btn-ds"
                    title="Xác nhận đối soát các lô đang tích → mở khối làm tiếp: tạo ảnh báo cáo · yêu cầu gộp · hoàn tiền + QR"
                    className="rounded-full border-2 border-emerald-500 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-700 shadow-sm transition hover:bg-emerald-100 disabled:opacity-40">✅ Xác nhận đối soát</button>
                  <button type="button" disabled={lotTick.size === 0} onClick={() => setLotHoi('boDs')}
                    className="rounded-full border-2 border-line bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-danger hover:text-danger disabled:opacity-40">↩ Bỏ đối soát</button>
                  <button type="button" disabled={lotTick.size === 0}
                    onClick={() => { const rows = daiLyLotRows.filter((_, i) => lotTick.has(sortedRowsHienThi[i]?.loId)); const blob = buildRevenueWorkbookXls([{ name: 'Lô đã chọn', subtitle: `${agentName || ''} · ${rows.length} lô · xuất ${ymdLocal(new Date())}`, rows }], AGENT_XLS_COLUMNS); void downloadBlob(blob, `LoDaChon_${(agentName || 'DaiLy').replace(/[^\p{L}\d]+/gu, '')}_${ymdLocal(new Date()).replace(/-/g, '')}.xls`); }}
                    className="rounded-full border-2 border-line bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-brand hover:text-brand disabled:opacity-40">⬇ Excel lô đã chọn</button>
                  {lotMsg && <span className="w-full text-[11px] text-slate-500">{lotMsg}</span>}
                </div>
              )}
              <RevenueLotTable
                rows={daiLyLotRows}
                columns={AGENT_COLUMNS}
                onNoteSave={laChuAlpha ? (loId, note) => { void postLotNote(loId, note).then(async () => { const rc = await getPosLotRecon(sortedRows.map((x) => x.loId)); if (rc.ok) setLotRecon(rc.data); }); } : undefined}
                /* [Admin Demo 16/9 tối] cột thao tác PHẢI đủ rộng cho tick + chip trạng thái + nút Sửa — 84px mặc
                   định làm cụm nút tràn ĐÈ cột tiền (số bị cắt "54.844.00"). Không phải chủ SigMa → chỉ nút Sửa. */
                actionWidth={laChuAlpha ? '138px' : '84px'} /* [17/9] cụm thao tác XẾP 2 DÒNG → hẹp lại, bảng hết cuộn ngang */
                highlight={chiDich && chiDich.lo ? { tid: chiDich.tid, lo: chiDich.lo } : null}
                labelSau="Phải hoàn (sau phí)"
                renderAction={(_row, i) => {
                  const src = sortedRowsHienThi[i];
                  if (!src) return null;
                  const tt = laChuAlpha ? lotTrangThai(src.loId) : null;
                  // [Admin Demo 11/9] Nhãn sửa PHẢI đủ Lô + TID + HKD — tránh nhầm máy khi tên na ná nhau.
                  const metaTid = report?.tids.find((t) => t.tidId === src.tidId);
                  const label = `Lô ${src.bankReportedLoNumber ?? src.billLoNumber ?? `#${src.loId}`}${metaTid ? ` · TID ${metaTid.tid} · ${metaTid.hkdName ?? ''}` : ''}`.trim();
                  return (
                    /* [Admin Demo 17/9] XẾP 2 DÒNG (flex-wrap) thay vì 1 hàng dài: cột thao tác hẹp lại ⇒ bảng vừa
                       màn, hết cuộn ngang; vẫn đủ ô tích to + mã YC + trạng thái + nút Sửa. */
                    <span className="flex shrink-0 flex-wrap items-center justify-center gap-1 gap-y-0.5">
                      {laChuAlpha && (
                        <>
                          {/* Ô TÍCH TO (h-5 w-5, accent brand) — mặc định quá nhỏ, khó bấm trúng khi tick nhiều lô. */}
                          <input type="checkbox" checked={lotTick.has(src.loId)} data-testid="lot-tick"
                            className="h-5 w-5 cursor-pointer accent-[#1877d6]"
                            onChange={() => setLotTick((t) => { const n = new Set(t); if (n.has(src.loId)) n.delete(src.loId); else n.add(src.loId); return n; })} />
                          {/* [Admin Demo 17/9] Nhãn nói ĐÚNG việc đã xảy ra: "Đã hoàn tiền" (không phải "Hoàn tất" chung chung).
                              whitespace-nowrap: giữ 1 DÒNG, cấm cắt chữ xuống dòng thứ 2 trong ô hẹp. */}
                          {tt === 'daHoan' ? <span className="whitespace-nowrap rounded-md px-1.5 py-1 text-[11px] font-bold text-emerald-700 bg-emerald-100" title="Đã đối soát + đã hoàn tiền (đủ 2 xác nhận)">✓ Đã hoàn tiền</span>
                            : tt === 'choHoan' ? <span className="whitespace-nowrap rounded-md px-1.5 py-1 text-[11px] font-bold text-amber-700 bg-amber-100" title="Đã xác nhận đối soát — chưa xác nhận hoàn tiền">⏳ Chờ hoàn</span>
                            : <span className="whitespace-nowrap rounded-md px-1.5 py-1 text-[11px] font-bold text-danger bg-danger/10" title="Chưa xác nhận đối soát">Chưa ĐS</span>}
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => openReviewEdit(src.loId, label)}
                        title="Sửa bill bằng giao diện review OCR (tiền/lô/TID/ngày/giờ/thẻ) — cần mật khẩu"
                        className="flex shrink-0 items-center gap-1 rounded-full border border-brand/30 bg-brand/5 px-1.5 py-0.5 text-[10px] font-bold text-brand transition hover:bg-brand/10"
                      >
                        <Pencil className="h-3 w-3" /> Sửa
                      </button>
                    </span>
                  );
                }}
              />
            </div>

            {/* [16/9 tối] Modal xác nhận + QR hoàn + báo cáo ảnh cho LÔ đã tick */}
            <ConfirmModal open={lotHoi === 'ds'} title="Xác nhận đối soát lô"
              message={<>Xác nhận ĐÃ ĐỐI SOÁT <b>{lotTick.size} lô</b> đang chọn? (bước 1/2 — sau đó mới hoàn tiền được)</>}
              confirmLabel="Xác nhận đối soát"
              onConfirm={() => { setLotHoi(null); void lamRecon(true).then(() => setLotRptOpen(true)); }}
              onClose={() => setLotHoi(null)} />
            <ConfirmModal open={lotHoi === 'boDs'} title="Bỏ đối soát lô" danger
              message={<>Bỏ đối soát <b>{lotTick.size} lô</b>? Cờ ĐÃ HOÀN (nếu có) cũng bị bỏ theo — chuỗi 2 bước tính lại từ đầu.</>}
              confirmLabel="Bỏ đối soát" onConfirm={() => { setLotHoi(null); void lamRecon(false); }} onClose={() => setLotHoi(null)} />
            {/* [Admin Demo 17/9] Các lô đang hoàn đều thuộc CÙNG 1 YC → nội dung CK chỉ là mã đó ("YC 001") và khi
                bấm "đã hoàn" thì ghi thẳng vào YC (đóng cả nhóm lô 1 lần) thay vì ghi rời từng lô. */}
            {lotRefundGroups && <RefundQrModal groups={lotRefundGroups} nguonTien="DL" maYc={ycChung}
              onClose={() => setLotRefundGroups(null)}
              onDone={() => { void getPosLotRecon(sortedRows.map((x) => x.loId)).then((r) => { if (r.ok) setLotRecon(r.data); }); void napLaiYc(); setLotTick(new Set()); }}
              onXacNhanHoan={async (g, tien) => {
                if (ycChung) { const r = await xacNhanYcDaChuyen(ycChung); return { ok: r.ok, message: r.ok ? r.data.message : r.message }; }
                const r = await postLotRefundDone(g.billIds.map(Number), g.dealer, tien);
                return { ok: r.ok, message: r.ok ? r.data.message : r.message };
              }} />}
            {lotRptOpen && <LotImageReportModal
              rows={daiLyLotRows.filter((_, i) => lotTick.has(sortedRowsHienThi[i]?.loId))}
              dealer={tenDaiLyChuan}
              lotIds={[...lotTick]}
              maYcSan={ycChung}
              ycAmountSan={ycChung ? (ycTheoLo[String([...lotTick][0] ?? '')]?.amount ?? null) : null}
              onXong={() => { void getPosLotRecon(sortedRows.map((x) => x.loId)).then((r) => { if (r.ok) setLotRecon(r.data); }); void napLaiYc(); }}
              onClose={() => setLotRptOpen(false)} />}

            {/* ĐỐI SOÁT HOÀN TIỀN (hướng-1, Admin Demo 31/8): cần hoàn (Σ net) vs đã hoàn (Σ CK waterfall khớp số tiền)
                theo NGÀY. Màu quy chuẩn KpiReportScreen: đủ=xanh, thiếu=hổ phách, thừa=đỏ, chưa hoàn=xám. */}
            <div className="mt-3 overflow-hidden rounded-lg-mac border border-line bg-white">
              {/* Admin Demo 2/9 "bỏ nhãn Cần·Đã·Thừa/Thiếu lặp, để 1 TIÊU ĐỀ": header gọn 1 dòng theo chu kỳ tab đang chọn. */}
              <div className="flex items-center gap-1.5 border-b border-line bg-appbg px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <IconRefund className="h-3.5 w-3.5" /> Chi tiết hoàn tiền theo ngày · {PERIOD_LABEL[period]}
              </div>
              {reconcile.status === 'loading' && <p className="py-6 text-center text-xs text-slate-400">Đang đối soát…</p>}
              {reconcile.status === 'error' && <p className="px-3 py-4 text-xs text-danger">{reconcile.message ?? 'Lỗi đối soát.'}</p>}
              {reconcile.status === 'ready' && reconcile.data && (
                (reconcile.data.days.length === 0 && reconcile.data.unmatchedDaHoan === 0) ? (
                  <p className="py-8 text-center text-xs text-slate-400">Chưa có hoàn tiền trong kỳ này.</p>
                ) : (
                  <>
                    {reconcile.data.unmatchedDaHoan > 0 && (
                      <div className="border-b border-danger/20 bg-danger/5 px-3 py-2 text-[11px] font-semibold text-danger">
                        ⚠ CK chưa gán được ngày: {fmtVnd(reconcile.data.unmatchedDaHoan)}
                      </div>
                    )}
                    {reconcile.data.days.map((d) => {
                      const st = reconcileStatus(d.status);
                      return (
                        <div key={d.date} className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5 last:border-b-0">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[12px] font-bold text-slate-700">{ymdToDmy(d.date)}</div>
                            <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: `${st.color}1a`, color: st.color }}>{st.label}</span>
                          </div>
                          <div className="grid grid-cols-3 gap-1.5 text-[11.5px]">
                            <div className="rounded-lg bg-slate-50 px-1.5 py-1"><div className="flex items-center gap-1 text-[9px] uppercase text-slate-400"><IconRefund className="h-3 w-3" />Cần hoàn</div><b className="tabular-nums text-slate-800">{fmtVnd(d.canHoan)}</b></div>
                            <div className="rounded-lg bg-success/5 px-1.5 py-1"><div className="flex items-center gap-1 text-[9px] uppercase text-success/80"><IconMoney className="h-3 w-3" />Đã hoàn</div><b className="tabular-nums text-success">{fmtVnd(d.daHoan)}</b></div>
                            <div className="rounded-lg px-1.5 py-1" style={{ background: `${st.color}12` }}><div className="flex items-center gap-1 text-[9px] uppercase" style={{ color: st.color }}><IconPct className="h-3 w-3" />Thừa/Thiếu</div><b className="tabular-nums" style={{ color: st.color }}>{d.thuaThieu >= 0 ? '+' : ''}{fmtVnd(d.thuaThieu)}</b></div>
                          </div>
                        </div>
                      );
                    })}
                    {/* [Admin Demo 2/9] TỔNG Cần/Đã/Thừa-Thiếu ĐÃ GHIM Ở TRÊN (dưới doanh số) → BỎ ở đây tránh lặp 2 lần. */}
                    {/* DANH SÁCH TỪNG BILL HOÀN/ỨNG — BẢNG CHIA CỘT kiểu Excel (Admin Demo 2/9): STT·Ngày·Giờ·Số tiền·Người
                        chuyển·NH gửi·Người nhận·NH nhận·Loại hoàn. Zebra + hover-3D (như bảng lô). NH gửi = OCR CK CHƯA
                        bắt (chỉ có 1 bank = bên nhận) → '—' (KHÔNG bịa). */}
                    {reconcile.data.bills.length > 0 && (
                      <div className="border-t border-line">
                        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2 pb-1">
                          <div className="text-[10.5px] font-bold uppercase tracking-wide text-slate-400">Từng bill hoàn/ứng ({reconcile.data.bills.length})</div>
                          {/* [Admin Demo 7/9] LỌC bill hoàn: dropdown NGƯỜI HOÀN (người chuyển) + NGÂN HÀNG (NH nhận). Options = giá trị có thật trong kỳ. */}
                          {(() => {
                            const senders = [...new Set(reconcile.data!.bills.map((b) => b.senderName).filter((x): x is string => !!x && x.trim() !== ''))].sort((a, b) => a.localeCompare(b));
                            const banks = [...new Set(reconcile.data!.bills.map((b) => b.bank).filter((x): x is string => !!x && x.trim() !== ''))].sort((a, b) => a.localeCompare(b));
                            return (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <select value={refundNameFilter} onChange={(e) => setRefundNameFilter(e.target.value)} className="rounded-full border border-line bg-white px-3 py-1 text-[11px] text-slate-700 outline-none focus:border-brand/50">
                                  <option value="">Người hoàn: tất cả</option>
                                  {senders.map((s) => <option key={s} value={s}>{s}</option>)}
                                </select>
                                <select value={refundBankFilter} onChange={(e) => setRefundBankFilter(e.target.value)} className="rounded-full border border-line bg-white px-3 py-1 text-[11px] text-slate-700 outline-none focus:border-brand/50">
                                  <option value="">Ngân hàng: tất cả</option>
                                  {banks.map((bk) => <option key={bk} value={bk}>{bk}</option>)}
                                </select>
                                {/* Bỏ lọc — chỉ hiện khi đang lọc. */}
                                {(refundNameFilter || refundBankFilter) && (
                                  <button type="button" onClick={() => { setRefundNameFilter(''); setRefundBankFilter(''); }} className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-100" title="Bỏ lọc">✕ Bỏ lọc</button>
                                )}
                                {/* Tải lại đối soát hoàn tiền (lấy bill hoàn mới). */}
                                <button type="button" onClick={() => setReloadTick((n) => n + 1)} className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand/5 px-2.5 py-1 text-[11px] font-bold text-brand hover:bg-brand/10" title="Tải lại danh sách hoàn tiền"><RefreshCw className="h-3 w-3" /> Tải lại</button>
                              </div>
                            );
                          })()}
                        </div>
                        <div className="overflow-x-auto px-2 pb-2">
                          <div className="min-w-[860px]">
                            {(() => {
                              const CK_GRID = '40px 92px 56px minmax(110px,1fr) minmax(110px,1.1fr) 80px minmax(110px,1.1fr) 80px 110px 52px';
                              // kind chỉ 'ADVANCE'|'REFUND'; "hoàn thừa" suy từ amount<0 (đại lý hoàn LẠI phần thừa).
                              const kindLabel = (b: { kind: string; amount: number }): string => b.kind === 'ADVANCE' ? 'Tạm ứng' : b.amount < 0 ? 'Hoàn thừa' : 'Hoàn tiền';
                              const HEAD = ['STT', 'Ngày', 'Giờ', 'Số tiền', 'Người chuyển', 'NH gửi', 'Người nhận', 'NH nhận', 'Loại hoàn', 'Sửa'];
                              // [Admin Demo 7/9] Áp LỌC người hoàn (người chuyển) + ngân hàng (NH nhận) — khớp CHÍNH XÁC giá trị dropdown.
                              const hasFilter = !!refundNameFilter || !!refundBankFilter;
                              const filteredBills = reconcile.data!.bills.filter((b) =>
                                (!refundNameFilter || (b.senderName ?? '') === refundNameFilter) &&
                                (!refundBankFilter || (b.bank ?? '') === refundBankFilter));
                              return (
                                <>
                                  <div className="grid items-center gap-x-2 rounded-t-lg bg-brand/10 px-2 py-1.5 text-[9.5px] font-bold uppercase tracking-wide text-brand-deep" style={{ gridTemplateColumns: CK_GRID }}>
                                    {/* [Admin Demo 7/9] Căn giữa tiêu đề mọi cột trừ "Số tiền" (phải) — đồng bộ với dữ liệu căn giữa dưới. */}
                                    {HEAD.map((h, i) => <div key={h} className={i === 3 ? 'text-right' : 'text-center'}>{h}</div>)}
                                  </div>
                                  {hasFilter && filteredBills.length === 0 && (
                                    <div className="px-2 py-4 text-center text-[11px] text-slate-400">Không có bill hoàn khớp bộ lọc.</div>
                                  )}
                                  {/* [Admin Demo 7/9] Sắp theo THỜI GIAN hoàn TĂNG DẦN (ngày rồi giờ). billDate YYYY-MM-DD + billTime HH:MM → so chuỗi = đúng thứ tự thời gian. */}
                                  {[...filteredBills].sort((x, y) => `${x.billDate ?? ''} ${x.billTime ?? ''}`.localeCompare(`${y.billDate ?? ''} ${y.billTime ?? ''}`)).map((b, i) => (
                                    <div key={b.messageId} className="group grid items-center gap-x-2 border-b border-line px-2 py-1.5 text-[11.5px] transition-colors duration-150 last:border-b-0 odd:bg-white even:bg-slate-50/70 hover:bg-brand/[0.06]" style={{ gridTemplateColumns: CK_GRID }}>
                                      <div className="text-center tabular-nums text-slate-400">{i + 1}</div>
                                      <div className="text-center tabular-nums text-slate-600">{ymdToDmy(b.billDate)}</div>
                                      <div className="text-center tabular-nums text-slate-500">{b.billTime || '—'}</div>
                                      <div className={'text-right font-bold tabular-nums ' + (b.amount < 0 ? 'text-danger' : 'text-slate-800')}>{b.amount < 0 ? '−' : ''}{fmtVnd(b.amount)}</div>
                                      <div className="truncate text-center text-slate-700" title={b.senderName || ''}>{b.senderName || '—'}</div>
                                      {/* NH gửi (Admin Demo 2/9): OCR không đọc được → học qua sender-bank-alias; hiện senderBank nếu đã học, else '—'. */}
                                      <div className={'truncate text-center ' + (b.senderBank ? 'text-slate-600' : 'text-slate-400')} title={b.senderBank || ''}>{b.senderBank || '—'}</div>
                                      <div className="truncate text-center text-slate-700" title={b.receiverName || ''}>{b.receiverName || '—'}</div>
                                      <div className="truncate text-center text-slate-600">{b.bank || '—'}</div>
                                      <div><span className={'rounded px-1.5 py-0.5 text-[9.5px] font-bold ' + (b.kind === 'ADVANCE' ? 'bg-brand/10 text-brand' : b.amount < 0 ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success')}>{kindLabel(b)}</span></div>
                                      {/* [Admin Demo 7/9] Nút SỬA bill hoàn/ứng — mở form ngày/giờ/tiền (gate mật khẩu). */}
                                      <div className="flex justify-center">
                                        <button type="button" onClick={() => openRefundEdit(b, `${kindLabel(b)} ${fmtVnd(Math.abs(b.amount))}${b.billDate ? ` · ${b.billDate.slice(8, 10)}/${b.billDate.slice(5, 7)}` : ''}${(b.amount < 0 ? b.senderName : b.receiverName) ? ` · ${b.amount < 0 ? b.senderName : b.receiverName}` : ''}`)} title="Sửa ngày/giờ/số tiền bill hoàn (cần mật khẩu)"
                                          className="flex items-center gap-0.5 rounded-full border border-brand/30 bg-brand/5 px-1.5 py-0.5 text-[9.5px] font-bold text-brand transition hover:bg-brand/10">
                                          <Pencil className="h-2.5 w-2.5" /> Sửa
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )
              )}
            </div>
          </>
        )}
      </div>
      {/* [Admin Demo 7/9] SỬA bill = mở ĐÚNG card review OCR (1 render gốc). phase password → nhập mk; ready → BillReviewCard. */}
      {reviewEdit && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={() => reviewEdit.phase !== 'loading' && setReviewEdit(null)}>
          {reviewEdit.phase === 'ready' && reviewEdit.token && reviewEdit.item ? (
            <div className="my-4 w-full max-w-6xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-base font-extrabold text-white">✏️ Sửa bill · <span className="text-emerald-300">{reviewEdit.loLabel}</span> — sửa xong bấm <b>Gửi</b> để cập nhật</span>
                <button type="button" onClick={() => setReviewEdit(null)} className="shrink-0 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold text-white hover:bg-white/30">Đóng</button>
              </div>
              <BillReviewCard token={reviewEdit.token} item={reviewEdit.item} onSent={onReviewEditSent} snapBase={`edit-lo-${reviewEdit.loId}`} folderName="Sửa bill" />
            </div>
          ) : (
            <div className="my-auto w-full max-w-xs rounded-lg-mac border border-line bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-start gap-2 text-base font-extrabold text-slate-800"><Pencil className="mt-0.5 h-5 w-5 shrink-0 text-brand" /> <span>Sửa bill · <span className="text-brand">{reviewEdit.loLabel}</span></span></div>
              {reviewEdit.phase === 'loading' && <p className="py-6 text-center text-xs text-slate-400">Đang mở bill để sửa…</p>}
              {reviewEdit.phase === 'error' && <p className="rounded-lg bg-danger/10 p-2.5 text-xs text-danger">{reviewEdit.message ?? 'Không mở được bill này.'}</p>}
              {reviewEdit.phase === 'password' && (
                <div className="flex flex-col gap-2.5">
                  <p className="text-[11px] text-slate-500">Nhập mật khẩu sửa để mở bill bằng giao diện review (chỉ người SigMa).</p>
                  <input type="password" autoFocus value={reviewEdit.password} onChange={(e) => setReviewEdit((c) => (c ? { ...c, password: e.target.value } : c))} onKeyDown={(e) => { if (e.key === 'Enter') submitReviewEdit(); }}
                    className="rounded-lg border border-amber-300 bg-amber-50/40 px-3 py-2 text-[14px] focus:border-brand focus:outline-none" placeholder="mật khẩu (mặc định 1111)" />
                  {reviewEdit.message && <p className="rounded-lg bg-danger/10 p-2 text-[11px] font-semibold text-danger">{reviewEdit.message}</p>}
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setReviewEdit(null)} className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50">Hủy</button>
                    <button type="button" onClick={() => submitReviewEdit()} className="rounded-full bg-brand px-5 py-1.5 text-xs font-bold text-white hover:bg-brand-deep">Mở sửa</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* [Admin Demo 11/9] SỬA BILL CK = mở ĐÚNG card review CK (TransferReviewCard) — đồng nhất sửa bill POS. */}
      {ckReview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={() => setCkReview(null)}>
          <div className="my-4 w-full max-w-6xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-sm font-bold text-white">✏️ Sửa bill CK · {ckReview.label} — sửa xong bấm <b>Gửi</b> để cập nhật (không đăng trùng)</span>
              <button type="button" onClick={() => setCkReview(null)} className="shrink-0 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold text-white hover:bg-white/30">Đóng</button>
            </div>
            <TransferReviewCard token={ckReview.token} transfer={ckReview.transfer} onSent={onCkReviewSent} snapBase={`edit-ck-${ckReview.transfer.date ?? ''}-${ckReview.transfer.amount}`} />
          </div>
        </div>
      )}
      {/* [Admin Demo 7/9] MODAL SỬA BILL HOÀN/ỨNG (CK) — ngày/giờ/tiền + mật khẩu sửa. Cập nhật đối soát ngay. */}
      {refundEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => refundEdit.phase !== 'saving' && setRefundEdit(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-appbg p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-700"><Pencil className="h-4 w-4 text-brand" /> Sửa bill hoàn · {refundEdit.label}</div>
            <p className="mb-2 text-[11px] text-slate-400">Sửa ngày/giờ/số tiền — đối soát hoàn tiền tính lại theo ngày mới. Cần mật khẩu sửa.</p>
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold text-slate-500">Ngày hoàn</span>
                <input type="date" value={refundEdit.billDate} onChange={(e) => setRefundEdit((c) => (c ? { ...c, billDate: e.target.value } : c))} className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-brand/50" />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold text-slate-500">Giờ (HH:MM, để trống nếu không có)</span>
                <input type="text" placeholder="14:22" value={refundEdit.billTime} onChange={(e) => setRefundEdit((c) => (c ? { ...c, billTime: e.target.value } : c))} className="rounded-lg border border-line bg-white px-2 py-1 text-sm tabular-nums text-slate-700 outline-none focus:border-brand/50" />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold text-slate-500">Số tiền hoàn</span>
                {/* [Admin Demo 11/9 ảnh thật: "số tiền hoàn sai định dạng"] HIỂN THỊ nhóm nghìn vi-VN (179.630.000), state vẫn giữ chuỗi CHỮ SỐ thô. */}
                <input inputMode="numeric" value={refundEdit.amount ? Number(refundEdit.amount).toLocaleString('vi-VN') : ''} onChange={(e) => setRefundEdit((c) => (c ? { ...c, amount: e.target.value.replace(/[^\d]/g, '') } : c))} className="rounded-lg border border-line bg-white px-2 py-1 text-lg font-bold tabular-nums text-slate-800 outline-none focus:border-brand/50" />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold text-slate-500">Mật khẩu sửa</span>
                <input type="password" value={refundEdit.password} onChange={(e) => setRefundEdit((c) => (c ? { ...c, password: e.target.value } : c))} onKeyDown={(e) => { if (e.key === 'Enter') submitRefundEdit(); }} className="rounded-lg border border-line bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-brand/50" />
              </label>
              {refundEdit.message && <p className="rounded-lg bg-danger/10 px-2 py-1 text-xs font-medium text-danger">{refundEdit.message}</p>}
              <div className="mt-1 flex justify-end gap-2">
                <button type="button" onClick={() => setRefundEdit(null)} disabled={refundEdit.phase === 'saving'} className="rounded-full border border-line px-4 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-50">Hủy</button>
                <button type="button" onClick={() => submitRefundEdit()} disabled={refundEdit.phase === 'saving'} className="rounded-full bg-brand px-5 py-1.5 text-xs font-bold text-white hover:bg-brand-deep disabled:opacity-50">{refundEdit.phase === 'saving' ? 'Đang lưu…' : 'Lưu'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* PICKER SỬA THẺ — modal chọn thẻ mới cho lô. Mỗi thẻ hiện phí bán % thực tế; thẻ chưa cấu hình giá bán mờ. */}
      {cardEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !correcting && setCardEdit(null)}>
          <div className="w-full max-w-md rounded-2xl bg-appbg p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-700"><CreditCard className="h-4 w-4 text-brand" /> Sửa thẻ · {cardEdit.loLabel}</div>
            {cardEdit.status === 'loading' && <p className="py-6 text-center text-xs text-slate-400">Đang tải danh sách thẻ…</p>}
            {cardEdit.status === 'error' && <p className="rounded-lg bg-danger/10 p-2.5 text-xs text-danger">{cardEdit.message ?? 'Lỗi tải thẻ.'}</p>}
            {cardEdit.status === 'ready' && cardEdit.data && (
              <>
                <p className="mb-2 text-[11px] text-slate-400">Chọn thẻ đúng — doanh số đại lý + NĐT sẽ tính lại, GD cũ hủy tạo GD mới (giữ ngày gốc).</p>
                <div className="flex flex-col gap-1.5">
                  {cardEdit.data.options.map((opt) => {
                    const pct = opt.phiBanMilli != null ? (opt.phiBanMilli / 1000).toFixed(2) : null;
                    const disabled = !opt.available || opt.isCurrent || correcting;
                    return (
                      <button
                        key={opt.cardTypeId}
                        type="button"
                        disabled={disabled}
                        onClick={() => doCorrectCard(opt)}
                        title={!opt.available ? opt.reason : opt.isCurrent ? 'Thẻ hiện tại' : ''}
                        className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-[12px] transition ${
                          opt.isCurrent ? 'border-brand/40 bg-brand/10' : opt.available ? 'border-line bg-appbg hover:border-brand/40 hover:bg-brand/5' : 'border-line bg-slate-50 opacity-50'
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-1.5 font-semibold text-slate-700">
                          <CreditCard className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          <span className="truncate">{opt.name}</span>
                          {opt.isCurrent && <span className="shrink-0 rounded-full bg-brand/15 px-1.5 py-0.5 text-[9px] font-bold text-brand">hiện tại</span>}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {opt.available && pct != null ? (
                            <span className="flex items-center gap-1 font-bold text-amber-700"><Percent className="h-3 w-3" />{pct}%</span>
                          ) : (
                            <span className="text-[10px] font-normal text-slate-400">chưa có giá bán</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="mt-3 flex justify-end">
              <button type="button" disabled={correcting} onClick={() => setCardEdit(null)} className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50">
                {correcting ? 'Đang sửa…' : 'Đóng'}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-success px-4 py-2 text-xs font-bold text-white shadow-lg">{toast}</div>
      )}
      {/* [Admin Demo 17/9] KHỐI OCR NỔI — "click vào sẽ hiện nổi blog đầy đủ lên, màn doanh số nằm PHÍA DƯỚI làm nền,
          không phải chèn trên rồi đẩy doanh số xuống gây tràn/cuộn". Overlay phủ giữa màn, nền doanh số vẫn thấy
          qua lớp mờ. Gửi xong: doanh số REFRESH NGAY (real-time) + hết bill thì khối tự biến mất. */}
      {ocrPanel && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/45 p-3 backdrop-blur-[2px]"
          data-testid="ocr-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOcrPanel(null); }}>
          <div className="flex h-[88vh] w-[min(1180px,96vw)] flex-col overflow-hidden rounded-2xl border-2 border-brand/40 bg-white shadow-2xl"
            data-testid="panel-ocr-nhung" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex shrink-0 items-center justify-between bg-brand/10 px-3 py-2">
              {/* 1 DÒNG, không cắt chữ (Admin Demo 17/9). KHÔNG ghi tên chế độ ở đây: người dùng đổi tab NGAY TRONG
                  khối (Tự động/Thủ công/Quét QR) nên tiêu đề cứng sẽ mâu thuẫn với tab đang mở. */}
              <div className="min-w-0 truncate whitespace-nowrap text-sm font-bold text-brand">
                🔎 Quét bill
                <span className="ml-2 text-xs font-semibold text-slate-500">— doanh số {tenNhom || ''} ở nền dưới, gửi xong tự cập nhật</span>
              </div>
              <button type="button" data-testid="ocr-panel-dong" onClick={() => setOcrPanel(null)}
                className="rounded-full border border-brand/40 bg-white px-3 py-1 text-xs font-bold text-brand hover:bg-brand/10">✕ Đóng</button>
            </div>
            <div className="min-h-0 flex-1">
              <OcrSendScreen
                initialMode={ocrPanel}
                embedded
                onSent={() => {
                  // REAL-TIME: mỗi bill gửi xong là nạp lại doanh số ngay — Admin Demo "ocr xong doanh số phải tự
                  // cập nhật real time luôn".
                  setReloadTick((v) => v + 1);
                  // [Admin Demo 17/9 SỬA LẠI] "ocr xong 1 ảnh thủ công bấm gửi lại bị đóng màn ocr — màn ocr CHỈ
                  // đóng khi bấm Đóng": gửi xong GIỮ NGUYÊN khối để quét ảnh tiếp, không tự tắt nữa.
                }}
              />
            </div>
          </div>
        </div>
      )}

      {downloadDialog}
    </div>
  );
}
