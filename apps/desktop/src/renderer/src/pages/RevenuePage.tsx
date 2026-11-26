import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Ban, Trash2, Loader2, TrendingUp, Download, Receipt, Handshake, Users, FilterX, RefreshCw, Pencil } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate, groupDigits } from '@sigma/shared';
import type {
  TransactionDto,
  RevenueSummary,
  ConfigTidDto,
  CardTypeDto,
  CustomerDto,
  LiteRef,
  CreateTransactionInput,
  FeeTypeDto,
  TidSellFeeRowDto,
  RevenueByFeeTypeRow,
  RevenueByHandoverRow,
  DepositHeldRow
} from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Field, inputCls } from '../components/Field.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { useRowSelection, SelectionBar, SelectAllCell, SelectCell } from '../components/Selection.js';
import { StatBar } from '../components/StatBar.js';
import { StaleBanner } from '../lib/realtime.js';
import { exportCsv } from '../lib/exportCsv.js';
import { MONEY_KIND_LABEL } from './HandoverConfigPage.js';
// MẪU THIẾT KẾ CHỐT 6/11 — kiểu bảng lấy từ MODULE DÙNG CHUNG, CẤM chép chuỗi class vào trang.
import { KhungBang, thChuan, tdChuan, tdTongChuan, tdTien, tdPhanTram, trChuan, theadChuan, tfootChuan, trTongChuan, tdTrong, HangDem } from '../components/BangChuan.js';

/** VND, nhóm 3 số bằng dấu chấm (KHÔNG toLocaleString — R_UI QA gate). Giữ dấu âm. */
function money(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '−' : '') + s + 'đ';
}

/** Badge trạng thái bill (P1.2): Đã ghi / Chờ duyệt hủy / Đã hủy — theo R_UI màu. */
function BillStatusBadge({ status }: { status: string }): JSX.Element {
  const map: Record<string, { label: string; cls: string }> = {
    POSTED: { label: 'Đã ghi', cls: 'bg-success/10 text-success' },
    CANCEL_PENDING: { label: 'Chờ duyệt hủy', cls: 'bg-warning/10 text-warning' },
    CANCELLED: { label: 'Đã hủy', cls: 'bg-slate-200 text-slate-500' }
  };
  const s = map[status] ?? { label: status, cls: 'bg-slate-100 text-slate-500' };
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

const emptySummary: RevenueSummary = { count: 0, totalAmount: 0, totalRevenuePartner: 0, totalRevenueSell: 0, totalRevenue: 0 };

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
   CUỘN TẢI DẦN (Admin Demo 13/11 — "bỏ nút chuyển trang, cuộn tới đâu tự nạp thêm tới đó")

   VÌ SAO KHÔNG VẼ HẾT 1 LẦN: đo thật 13/11 trên bản sao (3.276 giao dịch) — dựng + vẽ xong bảng mất
   4373 / 3787 / 4081 ms, màn hình đứng im suốt thời gian đó. Thêm nữa MÁY CHỦ KẸP `pageSize` tối đa
   500 (`packages/services/src/transaction.ts` ~dòng 774) nên một lượt gọi KHÔNG BAO GIỜ lấy quá 500
   dòng. ⇒ nạp theo LÔ, mỗi lô ≤ 500, cuộn gần đáy thì nối lô kế vào cuối danh sách.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Số dòng mỗi lô. PHẢI ≤ 500 (trần máy chủ) — xin 600 thì máy chủ lặng lẽ trả 500 và vòng nạp lệch. */
const SO_DONG_MOI_LO = 300;

/** Còn cách đáy bao nhiêu px thì kích hoạt nạp lô kế. */
const NGUONG_GAN_DAY = 300;

/** Giá trị 11 ô lọc trên màn (dạng chuỗi thô như state) — chụp lại để MỌI lô dùng CHUNG một bộ lọc. */
interface LocDoanhThu {
  mid: string; code: string; hkd: string; bank: string; partner: string; customer: string;
  tid: string; feeType: string; settled: string; from: string; to: string;
}
const LOC_RONG: LocDoanhThu = { mid: '', code: '', hkd: '', bank: '', partner: '', customer: '', tid: '', feeType: '', settled: '', from: '', to: '' };

/** Dựng tham số gửi máy chủ cho LÔ thứ `lo` (1-based) theo bộ lọc đã chụp. */
function thamSoLo(l: LocDoanhThu, lo: number): Record<string, unknown> {
  return {
    mid: l.mid.trim() || undefined,
    code: l.code.trim() || undefined,
    hkdName: l.hkd.trim() || undefined,
    bankId: l.bank ? Number(l.bank) : undefined,
    partnerId: l.partner ? Number(l.partner) : undefined,
    customerId: l.customer ? Number(l.customer) : undefined,
    tidId: l.tid ? Number(l.tid) : undefined,
    feeTypeId: l.feeType ? Number(l.feeType) : undefined,
    settled: l.settled === 'yes' ? true : l.settled === 'no' ? false : undefined,
    dateFrom: l.from ? new Date(l.from + 'T00:00:00').toISOString() : undefined,
    dateTo: l.to ? new Date(l.to + 'T23:59:59').toISOString() : undefined,
    page: lo,
    pageSize: SO_DONG_MOI_LO
  };
}

/**
 * DÒ Ô CUỘN THẬT lúc chạy — CẤM đoán. Bố cục full-height làm khung bảng (`[data-kiem='khung-bang']`)
 * thành ô cuộn, nhưng ở màn khác/bề ngang khác ô cuộn lại là `<main>` hoặc cả trang (bẫy đã dính
 * thật ở màn POS: cứ cuộn khung bảng nên "ảnh đáy bảng" chụp ra y hệt ảnh đầu).
 * Đi từ khung bảng LÊN cha tìm phần tử đầu tiên vừa cho cuộn dọc vừa ĐANG tràn nội dung.
 */
function timOCuon(el: HTMLElement | null): HTMLElement | null {
  let x: HTMLElement | null = el;
  while (x) {
    const c = getComputedStyle(x);
    if ((c.overflowY === 'auto' || c.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 2) return x;
    x = x.parentElement;
  }
  return document.scrollingElement as HTMLElement | null;
}

/** #4 — giá trị điền sẵn cho form Ghi nhận giao dịch khi Điều chỉnh (từ bill cũ). Tất cả dạng chuỗi (state form). */
interface TxnFormInitial {
  bankId?: string;
  hkdName?: string;
  tidId?: string;
  cardTypeId?: string;
  feeTypeId?: string;
  amount?: string;
  note?: string;
}

export function RevenuePage({ user, initialCustomerId, initialCode }: { user: AuthUser; initialCustomerId?: number; initialCode?: string }): JSX.Element {
  const toast = useToast();
  const canManage = hasPermission(user, 'REVENUE_MANAGE');
  const canRequestCancel = hasPermission(user, 'BILL_CANCEL_REQUEST');
  const [rows, setRows] = useState<TransactionDto[]>([]);
  const [summary, setSummary] = useState<RevenueSummary>(emptySummary);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);        // đang nạp LÔ ĐẦU (bảng trống, hiện vòng quay)
  const [dangTaiThem, setDangTaiThem] = useState(false); // đang nối LÔ KẾ vào cuối
  const [hetDuLieu, setHetDuLieu] = useState(false);     // máy chủ hết dòng để trả
  const [loiTaiThem, setLoiTaiThem] = useState('');      // lô kế hỏng → DỪNG tự nạp, hiện nút "Thử lại"

  // ── Bộ máy cuộn-tải-dần. Dùng ref (đọc/ghi ĐỒNG BỘ) vì bộ xử lý sự kiện cuộn chạy ngoài vòng render:
  //    state ở đó luôn là ảnh cũ ⇒ sẽ bắn 5-10 lượt nạp chồng nhau trong một cú lăn chuột.
  const rowsRef = useRef<TransactionDto[]>([]);        // bản sao `rows` để handler cuộn đọc được ngay
  const locRef = useRef<LocDoanhThu>(LOC_RONG);        // BỘ LỌC ĐÃ CHỤP lúc nạp lô đầu — mọi lô dùng CHUNG
  const loKeRef = useRef(2);                           // số thứ tự lô kế cần xin
  const dangTaiRef = useRef(false);                    // KHOÁ chống nạp chồng
  const hetRef = useRef(false);
  const loiRef = useRef('');
  const luotRef = useRef(0);                           // mã lượt: kết quả của lượt CŨ bị vứt sau khi reset
  const khungRef = useRef<HTMLDivElement | null>(null); // khung bảng — điểm xuất phát để DÒ ô cuộn
  const taiLoKeRef = useRef<() => void>(() => {});     // hàm nạp lô kế MỚI NHẤT cho handler cuộn gọi

  /** Ghi `rows` kèm bản sao ref — 1 cửa duy nhất, không để 2 nguồn lệch nhau. */
  function datRows(ds: TransactionDto[]): void { rowsRef.current = ds; setRows(ds); }
  function datHet(v: boolean): void { hetRef.current = v; setHetDuLieu(v); }
  function datLoi(v: string): void { loiRef.current = v; setLoiTaiThem(v); }

  // Bộ lọc đa chiều
  const [fMid, setFMid] = useState('');
  const [fHkd, setFHkd] = useState('');
  const [fBank, setFBank] = useState('');
  const [fPartner, setFPartner] = useState('');
  const [fCustomer, setFCustomer] = useState(initialCustomerId ? String(initialCustomerId) : ''); // Bug #1 — nhảy từ ô tìm topbar chọn khách → lọc sẵn
  const [fCode, setFCode] = useState(initialCode ?? ''); // Bug #1 — nhảy từ ô tìm topbar chọn giao dịch → lọc sẵn theo mã GD
  const [fTid, setFTid] = useState('');
  const [fFeeType, setFFeeType] = useState('');
  const [fSettled, setFSettled] = useState(''); // '' | 'yes' | 'no'
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');

  // Dữ liệu nền
  const [tids, setTids] = useState<ConfigTidDto[]>([]);
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [banks, setBanks] = useState<LiteRef[]>([]);
  const [partners, setPartners] = useState<{ id: number; name: string; code: string | null }[]>([]);
  const [feeTypes, setFeeTypes] = useState<FeeTypeDto[]>([]);
  // FEE_TYPE — báo cáo doanh thu tách theo loại phí (tổng toàn bộ theo bộ lọc).
  const [byFeeType, setByFeeType] = useState<RevenueByFeeTypeRow[]>([]);
  // LOẠI GIAO MÁY (Admin Demo) — doanh thu theo loại giao (Bán/Cho thuê/Cọc/Mượn) + cọc đang giữ (KHÔNG phải doanh thu).
  const [byHandover, setByHandover] = useState<RevenueByHandoverRow[]>([]);
  const [depositsHeldRows, setDepositsHeldRows] = useState<DepositHeldRow[]>([]);

  const [showForm, setShowForm] = useState(false); // GD chỉ GHI NHẬN (create); bill bất biến — sửa = hủy+tạo lại (BILL_IMMUTABLE)
  const [formInitial, setFormInitial] = useState<TxnFormInitial | undefined>(undefined); // #4 — điền sẵn khi Điều chỉnh
  const [del, setDel] = useState<TransactionDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<TransactionDto | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<TransactionDto | null>(null); // #4 — Điều chỉnh (hủy cũ + tạo mới)
  const sel = useRowSelection();

  /** Chụp 11 ô lọc đang gõ trên màn thành một bộ bất biến. */
  function locTrenMan(): LocDoanhThu {
    return { mid: fMid, code: fCode, hkd: fHkd, bank: fBank, partner: fPartner, customer: fCustomer, tid: fTid, feeType: fFeeType, settled: fSettled, from: fFrom, to: fTo };
  }

  async function loadRefs(): Promise<void> {
    const [t, c, b, p, f] = await Promise.all([
      window.api.tidConfigList({}),
      window.api.customerList({}),
      window.api.bankLite(),
      window.api.partnerList({}),
      window.api.feeTypeList()
    ]);
    if (t.ok && t.data) setTids(t.data);
    if (c.ok && c.data) setCustomers(c.data);
    if (b.ok && b.data) setBanks(b.data);
    if (p.ok && p.data) setPartners(p.data.map((x: { id: number; name: string; code: string | null }) => ({ id: x.id, name: x.name, code: x.code })));
    if (f.ok && f.data) setFeeTypes(f.data);
  }

  /**
   * NẠP LÔ ĐẦU — reset danh sách về lô 1. Dùng cho: mở màn, bấm "Lọc", "Xóa lọc", "Làm mới",
   * và sau mọi thao tác ghi (xóa / hủy / điều chỉnh / tạo mới).
   *
   * `locChiDinh` để nơi gọi truyền TƯỜNG MINH bộ lọc (vd "Xóa lọc" truyền `LOC_RONG`) — KHÔNG
   * dựa vào state vừa `set` xong, vì hàm này đóng gói giá trị của LẦN RENDER HIỆN TẠI: gọi ngay
   * sau `setFMid('')` thì trong thân hàm `fMid` VẪN là chuỗi cũ (lỗi đóng-gói-cũ, trước đây màn
   * này lách bằng `setTimeout(...,0)` — vẫn sai vì hàm trong hàng đợi cũng là hàm của render cũ).
   */
  async function taiLoDau(locChiDinh?: LocDoanhThu): Promise<void> {
    const loc = locChiDinh ?? locTrenMan();
    const luot = ++luotRef.current;   // vô hiệu hoá mọi lượt đang bay
    locRef.current = loc;
    loKeRef.current = 2;
    dangTaiRef.current = true;
    datLoi('');
    datHet(false);
    setDangTaiThem(false);
    setLoading(true);
    const thamSo = thamSoLo(loc, 1);
    try {
      // LOẠI GIAO MÁY — tôn trọng cùng khoảng ngày Từ/Đến đang lọc trên trang (raw yyyy-mm-dd).
      const [res, bf, bh, dh] = await Promise.all([
        window.api.transactionList(thamSo),
        window.api.revenueByFeeType(thamSo),
        window.api.revenueByHandover({ from: loc.from || undefined, to: loc.to || undefined }),
        window.api.depositsHeld()
      ]);
      if (luot !== luotRef.current) return; // đã có lượt mới hơn → vứt kết quả này
      if (res.ok) {
        const ds = res.data ?? [];
        const tong = res.total ?? 0;
        datRows(ds);
        setSummary(res.summary ?? emptySummary);
        setTotal(tong);
        // HẾT khi: máy chủ trả ÍT hơn một lô (chắc chắn là lô cuối) HOẶC đã đủ tổng.
        datHet(ds.length < SO_DONG_MOI_LO || ds.length >= tong);
      } else if (res.message) toast.alert(res.message);
      setByFeeType(bf.ok && bf.data ? bf.data : []);
      setByHandover(bh.ok && bh.data ? bh.data : []);
      setDepositsHeldRows(dh.ok && dh.data ? dh.data : []);
    } catch (e) {
      // FE-03 (Codex 15/7): 1 IPC reject không được để spinner treo mãi.
      if (luot === luotRef.current) toast.alert(e instanceof Error ? e.message : 'Không tải được dữ liệu (mất kết nối máy chủ?).', 'Lỗi tải dữ liệu');
    } finally {
      if (luot === luotRef.current) {
        sel.clear();
        setLoading(false);
        dangTaiRef.current = false;
      }
    }
  }

  /**
   * NẠP LÔ KẾ và NỐI vào cuối danh sách. Chỉ chạm `transactionList` — 3 bảng báo cáo phía trên
   * (loại phí / loại giao / cọc) là tổng TOÀN BỘ bộ lọc nên KHÔNG gọi lại theo từng lô.
   */
  async function taiLoKe(): Promise<void> {
    if (dangTaiRef.current || hetRef.current || loiRef.current) return; // KHOÁ chống nạp chồng
    const luot = luotRef.current;
    const lo = loKeRef.current;
    dangTaiRef.current = true;
    setDangTaiThem(true);
    try {
      const res = await window.api.transactionList(thamSoLo(locRef.current, lo));
      if (luot !== luotRef.current) return;
      if (res.ok) {
        const them = res.data ?? [];
        const tong = res.total ?? 0;
        setTotal(tong);
        if (res.summary) setSummary(res.summary);
        // Chống TRÙNG id: giữa 2 lượt nạp mà có người xóa/thêm bill thì cửa sổ offset trượt,
        // lô kế có thể lặp lại dòng đã nạp. Lọc theo id để hàng TỔNG đếm-dòng không phình giả.
        const daCo = new Set(rowsRef.current.map((r) => r.id));
        const moi = them.filter((r) => !daCo.has(r.id));
        const gop = rowsRef.current.concat(moi);
        datRows(gop);
        loKeRef.current = lo + 1;
        datHet(them.length < SO_DONG_MOI_LO || gop.length >= tong);
      } else {
        // Hỏng thì DỪNG tự nạp (nếu không, mỗi lần lăn chuột lại bắn 1 request hỏng).
        datLoi(res.message ?? 'Không tải thêm được dữ liệu.');
      }
    } catch (e) {
      if (luot === luotRef.current) datLoi(e instanceof Error ? e.message : 'Mất kết nối máy chủ khi tải thêm.');
    } finally {
      if (luot === luotRef.current) {
        setDangTaiThem(false);
        dangTaiRef.current = false;
      }
    }
  }
  taiLoKeRef.current = () => { void taiLoKe(); }; // handler cuộn luôn gọi bản MỚI NHẤT

  /** Bí danh giữ nguyên tên cũ cho mọi nơi gọi sau thao tác ghi — đều quay về LÔ ĐẦU. */
  const reload = taiLoDau;

  useEffect(() => { void loadRefs(); }, []);
  useEffect(() => { void taiLoDau(); /* eslint-disable-next-line */ }, []);

  // ── Bắt sự kiện CUỘN. Nghe ở `document` pha BẮT (scroll KHÔNG nổi bọt lên từ phần tử con) + ở
  //    `window` cho trường hợp cả trang cuộn ⇒ phủ mọi khả năng ô cuộn là khung bảng / <main> / trang.
  useEffect(() => {
    const xuLy = (): void => {
      const o = timOCuon(khungRef.current);
      if (!o) return;
      if (o.scrollHeight - o.scrollTop - o.clientHeight <= NGUONG_GAN_DAY) taiLoKeRef.current();
    };
    document.addEventListener('scroll', xuLy, { capture: true, passive: true });
    window.addEventListener('scroll', xuLy, { passive: true });
    return () => {
      document.removeEventListener('scroll', xuLy, { capture: true });
      window.removeEventListener('scroll', xuLy);
    };
  }, []);

  // ── Lô đầu KHÔNG đủ cao để sinh thanh cuộn (bộ lọc hẹp, màn hình rất cao) thì sẽ KHÔNG BAO GIỜ có
  //    sự kiện cuộn ⇒ phải tự nạp tiếp. Vòng này tự dừng khi nội dung đã vượt ngưỡng hoặc hết dữ liệu.
  useEffect(() => {
    if (loading || dangTaiThem || hetDuLieu || loiTaiThem) return;
    const o = timOCuon(khungRef.current);
    if (!o) return;
    if (o.scrollHeight - o.scrollTop - o.clientHeight <= NGUONG_GAN_DAY) void taiLoKe();
    /* eslint-disable-next-line */
  }, [rows.length, loading, dangTaiThem, hetDuLieu, loiTaiThem]);

  function applyFilter(): void { void taiLoDau(); }
  function resetFilter(): void {
    setFMid(''); setFHkd(''); setFBank(''); setFPartner(''); setFCustomer(''); setFCode(''); setFTid(''); setFFeeType(''); setFSettled(''); setFFrom(''); setFTo('');
    void taiLoDau(LOC_RONG); // truyền TƯỜNG MINH, không chờ state kịp đổi
  }

  async function doDelete(t: TransactionDto, password?: string): Promise<void> {
    const res = await window.api.transactionDelete([t.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa giao dịch ${t.code ?? t.id}`);
    else toast.alert(res.message ?? 'Xóa giao dịch thất bại', 'Xóa thất bại');
    setDel(null); await reload();
  }
  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.transactionDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} giao dịch`);
    else toast.alert(res.message ?? 'Xóa giao dịch thất bại', 'Xóa thất bại');
    setBulkDel(false); await reload();
  }

  async function doRequestCancel(t: TransactionDto, reason: string): Promise<void> {
    const res = await window.api.cancelRequest(t.id, reason);
    if (res.ok) toast.success(`Đã gửi yêu cầu hủy bill ${t.code ?? t.id} — chờ Quản lý/Admin duyệt.`);
    else toast.alert(res.message ?? 'Không gửi được yêu cầu hủy.', 'Yêu cầu hủy thất bại');
    setCancelTarget(null);
    await reload();
  }

  // #4 Điều chỉnh bill (phương án 1 Admin Demo): bill bất biến → tạo YÊU CẦU HỦY bill cũ (qua duyệt) rồi
  // MỞ SẴN form tạo bill mới, điền sẵn TID/thẻ/loại phí/số tiền của bill cũ để sửa + tạo lại.
  async function doAdjust(t: TransactionDto, reason: string): Promise<void> {
    const res = await window.api.cancelRequest(t.id, reason);
    if (res.ok) {
      toast.success(`Đã gửi yêu cầu hủy bill ${t.code ?? t.id} — điền form để tạo bill mới thay thế.`);
      setFormInitial({
        bankId: t.bankId != null ? String(t.bankId) : '',
        hkdName: t.hkdName ?? '',
        tidId: String(t.tidId),
        cardTypeId: t.cardTypeId != null ? String(t.cardTypeId) : '',
        feeTypeId: t.feeTypeId != null ? String(t.feeTypeId) : '',
        amount: String(t.amount),
        note: t.note ?? ''
      });
      setShowForm(true);
      await reload();
    } else {
      toast.alert(res.message ?? 'Không gửi được yêu cầu hủy.', 'Điều chỉnh thất bại');
    }
    setAdjustTarget(null);
  }

  const showActions = canManage || canRequestCancel;
  // 13 cột dữ liệu (thêm Loại phí) + ô chọn (canManage) + ô thao tác (showActions).
  const colCount = 13 + (canManage ? 1 : 0) + (showActions ? 1 : 0);
  /* HÀNG TỔNG — ĐỔI 13/11 cùng lúc bỏ phân trang.
     Trước: cộng từ `rows` = 50 dòng của TRANG đang xem, nhãn "(trang này)".
     Nay danh sách lớn dần theo lượt cuộn, nên tổng "phần đã nạp" sẽ NHẢY SỐ mỗi lần nạp thêm —
     người xem không thể biết đang nhìn tổng của bao nhiêu. ⇒ hàng TỔNG lấy `summary`, là
     AGGREGATE máy chủ tính trên TOÀN BỘ bộ lọc (`db.transaction.aggregate`, không phải cộng
     từ trang). Khớp đúng 4 ô KPI ở StatBar phía trên.
     ⚠️ NÓI THẲNG: `summary` LOẠI bill đã hủy (service lọc `status != 'CANCELLED'`), còn `total`
     (số bản ghi) thì KHÔNG loại. Vì vậy nhãn ghi rõ "trừ bill đã hủy" và số "đang xem N/M" để
     riêng — KHÔNG trộn 2 con số mang nghĩa khác nhau vào một chỗ. */
  const tTong = {
    amount: summary.totalAmount,
    part: summary.totalRevenuePartner,
    sell: summary.totalRevenueSell,
    rev: summary.totalRevenue
  };

  return (
    /* `data-nut-vuong` để trang ăn luật NÚT + THANH CUỘN của mau-moi.css (nạp ở main.tsx). */
    <div data-nut-vuong data-trang-full>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Quản Lý Doanh Thu</h2>
          <p className="text-sm text-slate-500">Ghi nhận giao dịch qua TID · doanh thu = chênh đối tác (phí mua − phí cài máy) + chênh bán (phí bán − phí cài máy).</p>
        </div>
        {canManage && (
          <Button data-nut="them" variant="confirm" icon={<Plus className="h-4 w-4" />} onClick={() => tids.length ? setShowForm(true) : toast.alert('Cần có ít nhất 1 TID đã cấu hình Đối tác trước.', 'Thiếu dữ liệu nền')}>Ghi nhận giao dịch</Button>
        )}
      </div>

      {/* KPI realtime — GIÁ TRỊ TỪ summary (đếm ở MAIN trên toàn bộ theo bộ lọc, KHÔNG từ mảng đã
          phân trang) → tránh count-pagination-drift. StatBar dùng CHUNG mọi trang. */}
      <StatBar
        items={[
          { icon: <TrendingUp className="h-4 w-4" />, tone: 'bg-brand-tint text-brand', label: 'Tổng doanh thu', value: money(summary.totalRevenue) },
          { icon: <Handshake className="h-4 w-4" />, tone: 'bg-indigo-50 text-indigo-500', label: 'Chênh đối tác', value: money(summary.totalRevenuePartner) },
          { icon: <Users className="h-4 w-4" />, tone: 'bg-emerald-50 text-emerald-500', label: 'Chênh bán', value: money(summary.totalRevenueSell) },
          { icon: <Receipt className="h-4 w-4" />, tone: 'bg-slate-100 text-slate-500', label: 'Số giao dịch', value: summary.count }
        ]}
      />

      {/* FEE_TYPE — báo cáo doanh thu TÁCH theo loại phí (Ủy quyền/Đối ứng/Tiền chờ…), tổng toàn bộ theo bộ lọc. */}
      {byFeeType.length > 0 && (
        <div className="mb-3 rounded-xl border border-line bg-white p-3 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-slate-700">Doanh thu theo loại phí</div>
          <KhungBang className="max-h-[32vh]">
            <table className="w-full min-w-[920px] text-xs">
              <thead className={theadChuan}>
                <tr>
                  <th className={thChuan + ' w-[260px]'}>Loại phí</th>
                  <th className={thChuan + ' w-[90px]'}>Số GD</th>
                  <th className={thChuan + ' w-[150px]'}>Số tiền</th>
                  <th className={thChuan + ' w-[150px]'}>Chênh đối tác</th>
                  <th className={thChuan + ' w-[150px]'}>Chênh bán</th>
                  <th className={thChuan + ' w-[150px]'}>Doanh thu</th>
                </tr>
              </thead>
              <tbody>
                {byFeeType.map((r, i) => (
                  <tr key={r.feeTypeId ?? 'null'} className={trChuan(i)}>
                    <td className={tdChuan + ' font-medium text-slate-700'}>{r.feeTypeName ?? '(Chưa gán loại phí)'}</td>
                    <td className={tdPhanTram}>{r.count}</td>
                    {/* Cột tiền: tdTien (căn phải · tabular-nums · slate-800 · không in đậm) · bỏ "đ" trong bảng. */}
                    <td className={tdTien}>{money(r.totalAmount).replace('đ', '')}</td>
                    <td className={tdTien}>{money(r.totalRevenuePartner).replace('đ', '')}</td>
                    <td className={tdTien}>{money(r.totalRevenueSell).replace('đ', '')}</td>
                    <td className={tdTien}>{money(r.totalRevenue).replace('đ', '')}</td>
                  </tr>
                ))}
                <HangDem soCot={6} />
              </tbody>
              <tfoot className={tfootChuan}>
                <tr className={trTongChuan}>
                  <td className={tdTongChuan + ' font-semibold text-brand-deep'}>TỔNG {byFeeType.length} loại phí</td>
                  <td className={tdTongChuan + ' text-center tabular-nums text-slate-800'}>{byFeeType.reduce((s, r) => s + r.count, 0)}</td>
                  <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(byFeeType.reduce((s, r) => s + r.totalAmount, 0)).replace('đ', '')}</td>
                  <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(byFeeType.reduce((s, r) => s + r.totalRevenuePartner, 0)).replace('đ', '')}</td>
                  <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(byFeeType.reduce((s, r) => s + r.totalRevenueSell, 0)).replace('đ', '')}</td>
                  <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(byFeeType.reduce((s, r) => s + r.totalRevenue, 0)).replace('đ', '')}</td>
                </tr>
              </tfoot>
            </table>
          </KhungBang>
        </div>
      )}

      {/* LOẠI GIAO MÁY (Admin Demo) — doanh thu TÁCH theo loại giao (Bán/Cho thuê/Cọc/Mượn), tôn trọng khoảng ngày Từ/Đến. */}
      {byHandover.length > 0 && (
        <div className="mb-3 rounded-xl border border-line bg-white p-3 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-slate-700">Doanh thu theo loại giao</div>
          <KhungBang className="max-h-[32vh]">
            <table className="w-full min-w-[720px] text-xs">
              <thead className={theadChuan}>
                <tr>
                  <th className={thChuan + ' w-[260px]'}>Loại giao</th>
                  <th className={thChuan + ' w-[180px]'}>Hình thức tiền</th>
                  <th className={thChuan + ' w-[120px]'}>Số chứng từ</th>
                  <th className={thChuan + ' w-[160px]'}>Doanh thu</th>
                </tr>
              </thead>
              <tbody>
                {byHandover.map((r, i) => (
                  <tr key={r.handoverTypeId ?? 'null'} className={trChuan(i)}>
                    <td className={tdChuan + ' font-medium text-slate-700'}>{r.handoverName}</td>
                    <td className={tdChuan + ' text-center text-slate-600'}>{MONEY_KIND_LABEL[r.moneyKind] ?? r.moneyKind}</td>
                    <td className={tdPhanTram}>{r.docCount}</td>
                    <td className={tdTien}>{money(r.revenue).replace('đ', '')}</td>
                  </tr>
                ))}
                <HangDem soCot={4} />
              </tbody>
              <tfoot className={tfootChuan}>
                <tr className={trTongChuan}>
                  <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={2}>TỔNG {byHandover.length} loại giao</td>
                  <td className={tdTongChuan + ' text-center tabular-nums text-slate-800'}>{byHandover.reduce((s, r) => s + r.docCount, 0)}</td>
                  <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(byHandover.reduce((s, r) => s + r.revenue, 0)).replace('đ', '')}</td>
                </tr>
              </tfoot>
            </table>
          </KhungBang>
        </div>
      )}

      {/* Đang giữ cọc — CÔNG NỢ PHẢI TRẢ khách (chưa hoàn cọc), KHÔNG phải doanh thu. Hiển thị riêng để không lẫn vào KPI doanh thu. */}
      {depositsHeldRows.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-300/60 bg-amber-50/40 p-3 shadow-sm">
          <div className="mb-0.5 text-sm font-semibold text-amber-700">Đang giữ cọc của khách</div>
          <p className="mb-2 text-xs text-amber-700/80">Công nợ phải trả khách (tiền cọc chưa hoàn) — KHÔNG tính vào doanh thu ở trên.</p>
          <KhungBang className="max-h-[32vh] bg-white/70">
            <table className="w-full min-w-[620px] text-xs">
              <thead className={theadChuan}>
                <tr>
                  <th className={thChuan + ' w-[280px]'}>Khách hàng</th>
                  <th className={thChuan + ' w-[120px]'}>Số lần cọc</th>
                  <th className={thChuan + ' w-[160px]'}>Còn giữ</th>
                </tr>
              </thead>
              <tbody>
                {depositsHeldRows.map((r, i) => (
                  <tr key={r.customerId} className={trChuan(i)}>
                    <td className={tdChuan + ' font-medium text-slate-700'}>{r.customerName ?? '—'}</td>
                    <td className={tdPhanTram}>{r.depositCount}</td>
                    <td className={tdTien}>{money(r.remaining).replace('đ', '')}</td>
                  </tr>
                ))}
                <HangDem soCot={3} />
              </tbody>
              <tfoot className={tfootChuan}>
                <tr className={trTongChuan}>
                  <td className={tdTongChuan + ' font-semibold text-brand-deep'}>TỔNG {depositsHeldRows.length} khách</td>
                  <td className={tdTongChuan + ' text-center tabular-nums text-slate-800'}>{depositsHeldRows.reduce((s, r) => s + r.depositCount, 0)}</td>
                  <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(depositsHeldRows.reduce((s, r) => s + r.remaining, 0)).replace('đ', '')}</td>
                </tr>
              </tfoot>
            </table>
          </KhungBang>
        </div>
      )}

      {/* Bộ lọc đa chiều — mỗi chiều một ô riêng.
          MẪU CHỐT 6/11 §4: MỘT HÀNG, không xuống dòng, cỡ chữ nhỏ, nút "Lọc" căn MÉP PHẢI.
          11 ô lọc + 4 nút không thể nhét vào 1150px ⇒ hàng lọc tự CUỘN NGANG trong khung của nó
          (`overflow-x-auto`), nhờ vậy vẫn đúng "1 hàng" mà TRANG không bị tràn ngang.
          KHÔNG dùng component FilterBar ở đây: FilterBar chỉ có 1 ô tìm kiếm, còn màn này gửi
          3 tham số chữ RIÊNG (Mã GD / MID / HKD) xuống máy chủ — gộp lại là đổi logic. */}
      <div className="mb-3 rounded-xl border border-line bg-white p-3 shadow-sm">
        <div className="flex flex-nowrap items-end gap-1.5 overflow-x-auto">
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Mã GD
            <input className={inputCls + ' w-24 text-xs'} value={fCode} onChange={(e) => setFCode(e.target.value)} placeholder="GD00001…" onKeyDown={(e) => e.key === 'Enter' && applyFilter()} />
          </label>
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Mã MID
            <input className={inputCls + ' w-28 text-xs tabular-nums'} value={fMid} onChange={(e) => setFMid(e.target.value)} placeholder="Chứa…" onKeyDown={(e) => e.key === 'Enter' && applyFilter()} />
          </label>
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Tên Hộ Kinh Doanh
            <input className={inputCls + ' w-32 text-xs'} value={fHkd} onChange={(e) => setFHkd(e.target.value)} placeholder="Chứa…" onKeyDown={(e) => e.key === 'Enter' && applyFilter()} />
          </label>
          <label className="flex shrink-0 flex-col text-xs text-slate-500">TID
            <select className={inputCls + ' w-28 text-xs'} value={fTid} onChange={(e) => setFTid(e.target.value)}><option value="">Tất cả TID</option>{tids.map((t) => <option key={t.id} value={t.id}>{t.tid}{t.hkdName ? ` · ${t.hkdName}` : ''}</option>)}</select>
          </label>
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Ngân hàng
            <select className={inputCls + ' w-32 text-xs'} value={fBank} onChange={(e) => setFBank(e.target.value)}><option value="">Tất cả</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select>
          </label>
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Đối tác
            <select className={inputCls + ' w-32 text-xs'} value={fPartner} onChange={(e) => setFPartner(e.target.value)}><option value="">Tất cả</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Khách hàng
            <select className={inputCls + ' w-28 text-xs'} value={fCustomer} onChange={(e) => setFCustomer(e.target.value)}><option value="">Tất cả</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.nickname} ({c.fullName})</option>)}</select>
          </label>
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Loại phí
            <select className={inputCls + ' w-28 text-xs'} value={fFeeType} onChange={(e) => setFFeeType(e.target.value)}><option value="">Tất cả</option>{feeTypes.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
          </label>
          {/* "Đối soát" giữ dropdown vì có 3 trạng thái (Tất cả / Chưa / Đã) — KHÔNG phải bật-tắt 2 trạng
              thái nên không đổi sang ô tích (đổi là mất trạng thái "Tất cả" = đổi logic lọc). */}
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Đối soát
            <select className={inputCls + ' w-28 text-xs'} value={fSettled} onChange={(e) => setFSettled(e.target.value)}><option value="">Tất cả</option><option value="no">Chưa đối soát</option><option value="yes">Đã đối soát</option></select>
          </label>
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Từ ngày
            <input type="date" className={inputCls + ' text-xs'} value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
          </label>
          <label className="flex shrink-0 flex-col text-xs text-slate-500">Đến ngày
            <input type="date" className={inputCls + ' text-xs'} value={fTo} onChange={(e) => setFTo(e.target.value)} />
          </label>
          {/* Nút "Lọc" căn MÉP PHẢI hàng lọc. */}
          <div className="min-w-[8px] flex-1" />
          <Button data-nut="loc" variant="confirm" onClick={applyFilter}>Lọc</Button>
          <Button variant="soft" data-nut="xoaloc" title="Xóa toàn bộ bộ lọc, đưa về mặc định" onClick={resetFilter} icon={<FilterX className="h-4 w-4" />}>Xóa lọc</Button>
          <Button variant="soft" data-nut="lammoi" title="Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc)" onClick={() => void reload()} icon={<RefreshCw className="h-4 w-4" />}>Làm mới</Button>
          {/* Xuất Excel lấy ĐÚNG phần ĐÃ NẠP (giống trước đây chỉ xuất 50 dòng của trang đang xem).
              Muốn xuất trọn bộ lọc thì cuộn tới "Đã hết" rồi bấm — nói rõ trong tooltip để không ai tưởng
              nút này luôn xuất đủ cả 3.000 dòng. */}
          <Button variant="confirm" data-nut="excel" title="Xuất phần ĐÃ NẠP trên màn (cuộn tới 'Đã hết' để xuất trọn bộ lọc)" icon={<Download className="h-4 w-4" />} onClick={() => /* [B299] tiền = SỐ + khai cotTien; thêm cột Trạng thái cho khớp màn */ exportCsv('doanh_thu',['Mã GD', 'Ngày', 'TID', 'MID', 'HKD', 'Khách', 'Loại thẻ', 'Loại phí', 'Số tiền', 'Chênh đối tác', 'Chênh bán', 'Doanh thu', 'Trạng thái', 'Đối soát'], rows.map((r) => [r.code ?? '', fmtDate(r.txnDate), r.tid ?? '', r.mid ?? '', r.hkdName ?? '', r.customerName ?? '', r.cardTypeName ?? '', r.feeTypeName ?? '', Number(r.amount), Number(r.revenuePartner), Number(r.revenueSell), Number(r.revenueAmount), r.status === 'CANCELLED' ? 'Đã hủy' : 'Đã ghi', r.settled ? 'Đã đối soát' : 'Chưa']), undefined, undefined, { cotTien: ['Số tiền', 'Chênh đối tác', 'Chênh bán', 'Doanh thu'] })}>Xuất Excel</Button>
        </div>
      </div>

      {canManage && <SelectionBar count={sel.count} entityLabel="giao dịch" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}

      <StaleBanner domain="Transaction" onReload={reload} className="mb-2" />
      {/* `khungRef` = điểm xuất phát để DÒ ô cuộn thật lúc chạy (xem `timOCuon`). */}
      <KhungBang ref={khungRef} className="list-scroll bg-white shadow-sm">
        {/* 15 cột → `min-w` cho CUỘN NGANG chủ ý. Số cột CỐ ĐỊNH ở mọi bề ngang (CẤM ẩn cột theo breakpoint:
            cột ẩn làm hàng TỔNG lệch 1 cột mà phép đếm querySelectorAll vẫn báo xanh). */}
        <table className="w-full min-w-[1960px] text-xs">
          <thead className={theadChuan}>
            {/* Nền đặt trên `<tr>` vì ô checkbox do SelectAllCell (module dùng chung) render — ô đó không
                mang `thChuan`, thiếu nền sẽ hở 1 ô trắng ở đầu hàng tiêu đề. */}
            <tr className="bg-slate-200">
              {canManage && <SelectAllCell ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[100px]'}>Mã GD</th>
              <th className={thChuan + ' w-[92px]'}>Ngày</th>
              <th className={thChuan + ' w-[130px]'}>TID · MID</th>
              <th className={thChuan + ' w-[210px]'}>Hộ Kinh Doanh</th>
              <th className={thChuan + ' w-[150px]'}>Khách hàng</th>
              <th className={thChuan + ' w-[110px]'}>Loại thẻ</th>
              <th className={thChuan + ' w-[110px]'}>Loại phí</th>
              <th className={thChuan + ' w-[140px]'}>Số tiền</th>
              <th className={thChuan + ' w-[140px]'}>Chênh đối tác</th>
              <th className={thChuan + ' w-[140px]'}>Chênh bán</th>
              <th className={thChuan + ' w-[140px]'}>Doanh thu</th>
              <th className={thChuan + ' w-[130px]'}>Trạng thái</th>
              <th className={thChuan + ' w-[100px]'}>Đối soát</th>
              {showActions && <th className={thChuan + ' w-[120px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={colCount} className={tdTrong}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={colCount} className={tdTrong}><Receipt className="mx-auto mb-2 h-6 w-6" /> Chưa có giao dịch nào khớp bộ lọc.</td></tr>}
            {!loading && rows.map((r, i) => {
              const cancelled = r.status === 'CANCELLED';
              return (
              /* Sọc ngựa vằn + dòng đang tích nổi bật vàng (trChuan). Bill đã hủy làm mờ như cũ. */
              <tr key={r.id} data-kiem="dong-gd" className={trChuan(i, sel.isSelected(r.id)) + (cancelled ? ' opacity-50' : '')}>
                {canManage && <SelectCell id={r.id} sel={sel} />}
                <td className={tdChuan + ' text-center font-mono font-medium text-slate-700'}>{r.code ?? '—'}</td>
                <td className={tdChuan + ' text-center text-slate-500'}>{fmtDate(r.txnDate)}</td>
                <td className={tdChuan + ' text-center tabular-nums text-slate-700'}>{r.tid ?? '—'}{r.mid ? <span className="block text-slate-400">{r.mid}</span> : null}</td>
                <td className={tdChuan + ' max-w-[210px] truncate text-slate-600'} title={r.hkdName ?? ''}>{r.hkdName ?? '—'}</td>
                <td className={tdChuan + ' max-w-[150px] truncate text-center text-slate-600'} title={r.customerName ?? ''}>{r.customerName ?? <span className="text-slate-400">—</span>}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{r.cardTypeName ?? '—'}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{r.feeTypeName ?? '—'}</td>
                {/* 4 cột TIỀN: tdTien — bỏ "đ" trong bảng, không in đậm, cùng cỡ chữ 12px. */}
                <td className={tdTien}>{money(r.amount).replace('đ', '')}</td>
                <td className={tdTien}>{money(r.revenuePartner).replace('đ', '')}</td>
                <td className={tdTien}>{money(r.revenueSell).replace('đ', '')}</td>
                <td className={tdTien}>{money(r.revenueAmount).replace('đ', '')}</td>
                <td className={tdChuan + ' text-center'}><BillStatusBadge status={r.status} /></td>
                <td className={tdChuan + ' text-center'}>{r.settled ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-600">Đã thu</span> : <span className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-600">Chưa</span>}</td>
                {showActions && (
                  <td className={tdChuan}><div className="flex justify-center gap-1">
                    {canManage && canRequestCancel && r.status === 'POSTED' && (
                      <IconButton title="Điều chỉnh (yêu cầu hủy bill cũ + tạo bill mới)" tone="edit" onClick={() => setAdjustTarget(r)}><Pencil className="h-4 w-4" /></IconButton>
                    )}
                    {canRequestCancel && r.status === 'POSTED' && (
                      <IconButton title="Yêu cầu hủy bill" tone="edit" onClick={() => setCancelTarget(r)}><Ban className="h-4 w-4" /></IconButton>
                    )}
                    {canManage && <IconButton title="Xóa" tone="danger" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton>}
                  </div></td>
                )}
              </tr>
              );
            })}
            {/* CHÂN DANH SÁCH — nằm TRONG khung cuộn, ngay dưới dòng cuối: cuộn tới đây là thấy ngay
                "đang tải thêm…" / "đã hết". `data-kiem` để bài kiểm bắt đúng dòng này, và các dòng dữ
                liệu đếm bằng `tr[data-kiem='dong-gd']` nên dòng chân KHÔNG làm sai phép đếm. */}
            {!loading && rows.length > 0 && (
              <tr data-kiem="chan-cuon">
                <td colSpan={colCount} className="border-t border-line px-3 py-3 text-center text-xs text-slate-500">
                  {loiTaiThem ? (
                    <span className="inline-flex items-center gap-2 text-danger">
                      Không tải thêm được: {loiTaiThem}
                      <button
                        className="rounded-md border border-line px-2 py-0.5 text-slate-600 hover:bg-appbg"
                        onClick={() => { datLoi(''); void taiLoKe(); }}
                      >Thử lại</button>
                    </span>
                  ) : dangTaiThem ? (
                    <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải thêm…</span>
                  ) : hetDuLieu ? (
                    <span>Đã hết — đã nạp đủ <b className="text-slate-700">{rows.length}</b>/<b className="text-slate-700">{total}</b> giao dịch.</span>
                  ) : (
                    <span>Cuộn xuống để nạp thêm… (đang xem <b className="text-slate-700">{rows.length}</b>/<b className="text-slate-700">{total}</b>)</span>
                  )}
                </td>
              </tr>
            )}
            <HangDem soCot={colCount} />
          </tbody>
          {/* Hàng TỔNG ghim đáy — số của TOÀN BỘ bộ lọc (summary máy chủ), KHÔNG phải phần đã nạp.
              Kèm luôn "đang xem N/M" để lúc nào cũng biết đã cuộn được bao nhiêu trên tổng bao nhiêu. */}
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={7 + (canManage ? 1 : 0)}>
                TỔNG {summary.count} giao dịch (toàn bộ bộ lọc · trừ bill đã hủy)
                <span className="ml-2 font-normal text-slate-500">· đang xem {rows.length}/{total}</span>
              </td>
              <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(tTong.amount).replace('đ', '')}</td>
              <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(tTong.part).replace('đ', '')}</td>
              <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(tTong.sell).replace('đ', '')}</td>
              <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(tTong.rev).replace('đ', '')}</td>
              <td className={tdTongChuan} colSpan={2 + (showActions ? 1 : 0)} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>

      {showForm && <TransactionForm tids={tids} feeTypes={feeTypes} initial={formInitial} onClose={() => { setShowForm(false); setFormInitial(undefined); }} onSaved={() => { setShowForm(false); setFormInitial(undefined); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa giao dịch" message={`Giao dịch "${del.code ?? del.id}" (${money(del.amount)}) sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều giao dịch" message={`${sel.count} giao dịch đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
      {cancelTarget && <CancelReasonModal bill={cancelTarget} onClose={() => setCancelTarget(null)} onSubmit={(reason) => doRequestCancel(cancelTarget, reason)} />}
      {adjustTarget && <AdjustReasonModal bill={adjustTarget} onClose={() => setAdjustTarget(null)} onSubmit={(reason) => doAdjust(adjustTarget, reason)} />}
    </div>
  );
}

/** #4 — Ô lý do khi Điều chỉnh bill: gửi yêu cầu hủy bill cũ (qua duyệt) + mở form tạo bill mới điền sẵn. */
function AdjustReasonModal({ bill, onClose, onSubmit }: { bill: TransactionDto; onClose: () => void; onSubmit: (reason: string) => Promise<void> }): JSX.Element {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(): Promise<void> {
    if (!reason.trim()) return toast.alert('Vui lòng nhập lý do điều chỉnh (làm lý do hủy bill cũ).', 'Thiếu lý do');
    setBusy(true);
    try { await onSubmit(reason.trim()); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Điều chỉnh bill ${bill.code ?? bill.id}`} onClose={onClose} width="max-w-md">
      <p className="mb-3 text-sm text-slate-600">Bill đã ghi là <b>bất biến</b>. Điều chỉnh = gửi <b>yêu cầu hủy</b> bill cũ (Quản lý/Admin duyệt) và mở sẵn form <b>tạo bill mới</b> đã điền TID / loại thẻ / loại phí / số tiền của bill cũ để bạn sửa lại. Bill cũ giữ nguyên tới khi được duyệt hủy.</p>
      <Field label="Lý do điều chỉnh" required>
        <textarea className={inputCls + ' min-h-[80px] resize-y'} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Ví dụ: nhập nhầm số tiền / sai loại thẻ — tạo lại bill đúng…" />
      </Field>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={submit} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Gửi yêu cầu hủy & mở form mới</Button>
      </div>
    </Modal>
  );
}

/** Ô nhập lý do hủy bill (bắt buộc) — gửi yêu cầu hủy cho Quản lý/Admin duyệt (P1.2 §5). */
function CancelReasonModal({ bill, onClose, onSubmit }: { bill: TransactionDto; onClose: () => void; onSubmit: (reason: string) => Promise<void> }): JSX.Element {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(): Promise<void> {
    if (!reason.trim()) return toast.alert('Vui lòng nhập lý do hủy bill.', 'Thiếu lý do');
    setBusy(true);
    try { await onSubmit(reason.trim()); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Yêu cầu hủy bill ${bill.code ?? bill.id}`} onClose={onClose} width="max-w-md">
      <p className="mb-3 text-sm text-slate-600">Bill đã ghi là <b>bất biến</b> — không sửa được. Gửi yêu cầu hủy (kèm lý do) để Quản lý/Admin duyệt; duyệt xong bill mới chuyển sang <b>Đã hủy</b> và không còn tính vào doanh thu.</p>
      <Field label="Lý do hủy" required>
        <textarea className={inputCls + ' min-h-[80px] resize-y'} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Ví dụ: nhập nhầm số tiền / sai loại thẻ…" />
      </Field>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={submit} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Gửi yêu cầu hủy</Button>
      </div>
    </Modal>
  );
}

/** % biểu phí (giá trị đã ÷1000 ở main) — dấu phẩy thập phân kiểu VN, đồng nhất TidPage/TidSellFeeModal. */
function pctText(p: number | null): string {
  if (p == null) return 'chưa cấu hình';
  return `${String(p).replace('.', ',')}%`;
}

function TransactionForm({ tids, feeTypes, initial, onClose, onSaved }: { tids: ConfigTidDto[]; feeTypes: FeeTypeDto[]; initial?: TxnFormInitial; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  // #10 — luồng CASCADING theo thứ tự Admin Demo: Ngân hàng → Tên HKD → TID → Loại thẻ → Loại phí → …
  // #4 — điền sẵn từ `initial` khi Điều chỉnh (tạo lại bill từ bill cũ vừa gửi yêu cầu hủy).
  const [bankId, setBankId] = useState(initial?.bankId ?? '');
  const [hkdName, setHkdName] = useState(initial?.hkdName ?? '');
  const [tidId, setTidId] = useState(initial?.tidId ?? '');
  const [cardTypeId, setCardTypeId] = useState(initial?.cardTypeId ?? '');
  // Loại phí: MẶC ĐỊNH phần tử ĐẦU danh sách (Admin Demo "hiển thị theo thứ tự 1").
  const [feeTypeId, setFeeTypeId] = useState(initial?.feeTypeId ?? (feeTypes[0] ? String(feeTypes[0].id) : ''));
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [txnDate, setTxnDate] = useState(new Date().toISOString().slice(0, 10));
  // #8 — Giờ giao dịch: mặc định GIỜ HIỆN TẠI lúc mở form (HH:mm), cho sửa; ghép ngày+giờ khi lưu.
  const [txnTime, setTxnTime] = useState(() => new Date().toTimeString().slice(0, 5));
  const [note, setNote] = useState(initial?.note ?? '');
  const [cards, setCards] = useState<CardTypeDto[]>([]);
  // #6 — biểu phí tham chiếu cho (TID × thẻ × loại phí) đang chọn.
  const [sellFee, setSellFee] = useState<TidSellFeeRowDto | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedTid = tids.find((t) => t.id === Number(tidId));

  // #10/#11 — danh sách CASCADING, mỗi cấp lọc theo cấp trên (nguồn = prop tids đã kèm bank/hkd/khách).
  // (1) Ngân hàng = distinct theo bankId trong tids.
  const bankOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of tids) if (t.bankId != null && !m.has(t.bankId)) m.set(t.bankId, t.bankCode ?? t.bankName ?? `NH #${t.bankId}`);
    return [...m.entries()].map(([id, label]) => ({ value: String(id), label }));
  }, [tids]);
  // (2) Tên HKD = distinct hkdName của các TID thuộc ngân hàng đã chọn.
  const hkdOptions = useMemo(() => {
    if (!bankId) return [];
    const s = new Set<string>();
    for (const t of tids) if (String(t.bankId) === bankId && t.hkdName) s.add(t.hkdName);
    return [...s].map((h) => ({ value: h, label: h }));
  }, [tids, bankId]);
  // (3) TID = các TID thuộc ĐÚNG ngân hàng + HKD đã chọn.
  const tidOptions = useMemo(() => {
    if (!bankId || !hkdName) return [];
    return tids
      .filter((t) => String(t.bankId) === bankId && t.hkdName === hkdName)
      .map((t) => ({ value: String(t.id), label: t.tid + (t.partnerName ? ` · ${t.partnerName}` : '') }));
  }, [tids, bankId, hkdName]);

  // Reset cấp dưới khi đổi cấp trên (chống dữ liệu "mồ côi" không còn khớp bộ lọc).
  function onBank(v: string): void { setBankId(v); setHkdName(''); setTidId(''); setCardTypeId(''); }
  function onHkd(v: string): void { setHkdName(v); setTidId(''); setCardTypeId(''); }
  function onTid(v: string): void { setTidId(v); setCardTypeId(''); }

  // Nạp loại thẻ theo ngân hàng của TID được chọn.
  useEffect(() => {
    if (!selectedTid?.bankId) { setCards([]); return; }
    void window.api.cardTypeList({ bankId: selectedTid.bankId }).then((r) => {
      if (r.ok && r.data) setCards(r.data);
    });
  }, [selectedTid?.bankId]);

  // #6 — sau khi chọn đủ TID + Loại thẻ + Loại phí → tra biểu phí (phí mua/cài máy/bán thực tế|niêm yết).
  // FIX B (Admin Demo 20/8) — resolve override/niêm-yết THEO NGÀY GIAO DỊCH đang nhập (ghép txnDate+txnTime y hệt lúc
  // ghi GD), KHÔNG phải "hôm nay". Nhờ vậy hasOverride/phiBanThucTe (→ missingActualSell/phiBanApplied/chenhBan)
  // phản ánh đúng kỳ override hiệu lực tại ngày GD → gate UI KHỚP backend (không còn preview override tương lai rồi
  // bị NO_ACTUAL_SELL_FEE sau submit). Reload khi txnDate/txnTime đổi (thêm vào deps).
  useEffect(() => {
    if (!tidId || !cardTypeId || !feeTypeId) { setSellFee(null); return; }
    let alive = true;
    const d = txnDate && txnTime ? new Date(txnDate + 'T' + txnTime + ':00') : null;
    const at = d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
    void window.api.tidSellFeeList(Number(tidId), Number(feeTypeId), at).then((r) => {
      if (!alive) return;
      const row = r.ok && r.data ? r.data.rows.find((x) => x.cardTypeId === Number(cardTypeId)) ?? null : null;
      setSellFee(row);
    });
    return () => { alive = false; };
  }, [tidId, cardTypeId, feeTypeId, txnDate, txnTime]);

  // P5 (Admin Demo 20/8) — doanh số CHỈ dùng phí bán THỰC TẾ (override TID), KHÔNG mượn niêm yết. TID chỉ có niêm yết
  // (chưa đặt giá bán thực tế) → KHÔNG tính chênh bán/doanh số + CHẶN ghi GD (đồng bộ backend NO_ACTUAL_SELL_FEE).
  const missingActualSell = !!sellFee && !sellFee.hasOverride; // đã có biểu phí nhưng THIẾU giá bán thực tế
  const phiBanApplied = sellFee?.hasOverride ? sellFee.phiBanThucTe : null; // chỉ phí bán THỰC TẾ mới dùng để tính chênh
  const chenhBan = phiBanApplied != null && sellFee?.phiCaiMayNiemYet != null ? Number((phiBanApplied - sellFee.phiCaiMayNiemYet).toFixed(3)) : null;
  const showFee = !!(tidId && cardTypeId && feeTypeId);

  async function save(): Promise<void> {
    if (!bankId) return toast.alert('Vui lòng chọn ngân hàng.', 'Thiếu thông tin');
    if (!hkdName) return toast.alert('Vui lòng chọn Hộ Kinh Doanh.', 'Thiếu thông tin');
    if (!tidId) return toast.alert('Vui lòng chọn TID.', 'Thiếu thông tin');
    if (!cardTypeId) return toast.alert('Vui lòng chọn loại thẻ.', 'Thiếu thông tin');
    if (!feeTypeId) return toast.alert('Vui lòng chọn loại phí.', 'Thiếu thông tin');
    // P5 — phòng vệ: nếu TID chưa có giá bán thực tế, chặn tại chỗ (khớp nút disabled + backend NO_ACTUAL_SELL_FEE).
    if (missingActualSell) return toast.alert('TID chưa có giá bán thực tế — đặt phí bán thực tế cho TID trước khi ghi doanh số.', 'Chưa có giá bán thực tế');
    const amt = Number(amount);
    if (!amount.trim() || !Number.isFinite(amt) || amt <= 0 || !Number.isInteger(amt)) return toast.alert('Số tiền giao dịch phải là số nguyên lớn hơn 0.', 'Số tiền không hợp lệ');
    if (!txnDate) return toast.alert('Vui lòng chọn ngày giao dịch.', 'Thiếu thông tin');
    if (!txnTime) return toast.alert('Vui lòng chọn giờ giao dịch.', 'Thiếu thông tin');
    setBusy(true);
    // #8 — ghép NGÀY + GIỜ (local) → ISO; giữ đúng giờ nhập (không còn ép 00:00).
    const iso = new Date(txnDate + 'T' + txnTime + ':00').toISOString();
    // #7 — KHÔNG gửi customerId: backend tự lấy khách theo TID (Tid.customerId).
    const input: CreateTransactionInput = { tidId: Number(tidId), cardTypeId: Number(cardTypeId), feeTypeId: Number(feeTypeId), amount: amt, txnDate: iso, note };
    const res = await window.api.transactionCreate(input);
    setBusy(false);
    if (res.ok) { toast.success('Đã ghi nhận giao dịch'); onSaved(); }
    else toast.alert(res.message ?? 'Lưu giao dịch thất bại', 'Không lưu được');
  }

  return (
    <Modal title="Ghi nhận giao dịch" onClose={onClose} width="max-w-3xl">
      <div className="grid grid-cols-2 gap-x-5 gap-y-4">
        {/* #10/#11 — (1) Ngân hàng · (2) Tên HKD · (3) TID: 3 ô TÌM KIẾM ĐỘC LẬP, cascading. */}
        <Field label="Ngân hàng" required hint="Gõ để tìm nhanh ngân hàng">
          <SearchSelect value={bankId} onChange={onBank} options={bankOptions} placeholder="— Chọn ngân hàng —" />
        </Field>
        <Field label="Tên Hộ Kinh Doanh" required hint={bankId ? 'Chỉ HKD có TID thuộc ngân hàng đã chọn' : 'Chọn ngân hàng trước'}>
          <SearchSelect value={hkdName} onChange={onHkd} options={hkdOptions} placeholder="— Chọn Hộ Kinh Doanh —" disabled={!bankId} />
        </Field>
        <Field label="TID" required hint={hkdName ? 'Chỉ TID của HKD + ngân hàng đã chọn' : 'Chọn HKD trước'}>
          <SearchSelect value={tidId} onChange={onTid} options={tidOptions} placeholder="— Chọn TID —" disabled={!hkdName} />
        </Field>
        {/* (4) Loại thẻ · (5) Loại phí: danh sách ngắn → giữ select thường. */}
        <Field label="Loại thẻ" required hint={selectedTid ? `Ngân hàng: ${selectedTid.bankCode ?? selectedTid.bankName ?? '—'}` : 'Chọn TID trước'}>
          <select className={inputCls} value={cardTypeId} onChange={(e) => setCardTypeId(e.target.value)} disabled={!cards.length}>
            <option value="">— Chọn loại thẻ —</option>
            {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Loại phí" required hint="Tra biểu phí theo loại phí này">
          <select className={inputCls} value={feeTypeId} onChange={(e) => setFeeTypeId(e.target.value)}>
            <option value="">— Chọn loại phí —</option>
            {feeTypes.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
        {/* (6) SHOW PHÍ — khối tham chiếu biểu phí đã cài (full-width) ngay dưới Loại phí. */}
        <div className="col-span-2">
          {showFee ? (
            <div className="rounded-lg border border-line bg-appbg/60 px-3 py-2.5 text-sm text-slate-600">
              <span className="font-medium text-slate-700">Biểu phí đã cài: </span>
              Phí mua: <b className="tabular-nums text-slate-800">{pctText(sellFee?.phiMuaNiemYet ?? null)}</b>
              {' · '}Phí cài máy: <b className="tabular-nums text-slate-800">{pctText(sellFee?.phiCaiMayNiemYet ?? null)}</b>
              {' · '}Phí bán: {missingActualSell
                ? <b className="text-warning">chưa cấu hình giá bán</b>
                : <><b className="tabular-nums text-slate-800">{pctText(phiBanApplied)}</b>{sellFee?.hasOverride ? <span className="text-xs text-slate-400"> (thực tế)</span> : null}</>}
              {' · '}Chênh bán: <b className="tabular-nums text-emerald-600">{missingActualSell ? '—' : pctText(chenhBan)}</b>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-line bg-appbg/40 px-3 py-2.5 text-sm text-slate-400">Chọn TID, loại thẻ và loại phí để xem biểu phí đã cài.</div>
          )}
        </div>
        {/* (7) Số tiền — #5 hiển thị NHÓM NGHÌN kiểu VN (5.000.000); lưu số trần qua replace. */}
        <Field label="Số tiền giao dịch (VND)" required><input className={inputCls + ' text-right tabular-nums'} inputMode="numeric" value={groupDigits(amount)} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} placeholder="0" /></Field>
        {/* (8) Ngày · (9) Giờ (#8 mặc định giờ hiện tại, cho sửa). */}
        <Field label="Ngày giao dịch" required><input type="date" className={inputCls} value={txnDate} onChange={(e) => setTxnDate(e.target.value)} /></Field>
        <Field label="Giờ giao dịch" required hint="Mặc định giờ hiện tại — sửa nếu cần"><input type="time" className={inputCls} value={txnTime} onChange={(e) => setTxnTime(e.target.value)} /></Field>
        {/* (10) Khách hàng — #7 TỰ liên kết theo TID (read-only), KHÔNG chọn tay. */}
        <Field label="Khách hàng (theo TID)" hint="Người được giao TID"><input className={inputCls + ' bg-slate-50 text-slate-600'} readOnly value={!selectedTid ? '' : (selectedTid.customerName ?? 'TID chưa giao khách')} placeholder="Chọn TID trước" /></Field>
        <Field label="Ghi chú"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {selectedTid && !selectedTid.partnerId && <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">TID này chưa gán Đối tác — không tra được biểu phí. Hãy cấu hình TID trước.</div>}
      {/* P5 — chặn ghi doanh số khi TID chỉ có niêm yết (chưa có giá bán thực tế); pre-warn trước khi backend trả NO_ACTUAL_SELL_FEE. */}
      {missingActualSell && <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">TID chưa có giá bán thực tế — đặt phí bán thực tế cho TID (khi giao hoặc sửa sau) trước khi ghi doanh số.</div>}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy || missingActualSell} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Ghi nhận</Button>
      </div>
    </Modal>
  );
}
