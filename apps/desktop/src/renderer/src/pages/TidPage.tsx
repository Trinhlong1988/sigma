import { useEffect, useRef, useState, useMemo } from 'react';
import { baoLoi } from '../lib/bao-loi';
import { Plus, Loader2, CreditCard, Link2, RefreshCw, Undo2, PackageCheck, Send, Download, History, Tag, Trophy, FilterX, Percent, Trash2, Banknote, Pencil, PackageOpen, QrCode } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, hasAnyPermission, fmtDate, groupDigits } from '@sigma/shared';
import type { TidDto, UndeliveredTidDto, PosDto, CustomerDto, FundDto, TidRefs, TimelineEventDto, CreateTidInput, ConfigTidInput, TidRevenueRankRow, TidSellFeeRowDto, FeeTypeDto, HandoverTypeLite, ChatRoomOptionDto, RcvAccountDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { anySellFeeCustom, buildSellFeeEntriesNen } from '../lib/sell-fee-entries.js';
import { CustomerPicker } from '../components/CustomerPicker.js';
import { PosPicker, type MayPos } from '../components/PosPicker.js';
import { PickerGoiY } from '../components/PickerGoiY.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { StatusPill, statusLabel, statusTone } from '../components/StatusPill.js';
import { MONEY_KIND_LABEL } from './HandoverConfigPage.js';
import { StatBar } from '../components/StatBar.js';
import { Field, inputCls } from '../components/Field.js';
import { FilterBar } from '../components/FilterBar.js';
import { StaleBanner } from '../lib/realtime.js';
import { ImportButton } from '../components/ImportModal.js';
import { RequestCancelModal, BulkRequestCancelModal, type RequestCancelTarget } from '../components/RequestCancelModal.js';
import { useRowSelection, SelectAllCell, SelectCell } from '../components/Selection.js';
import { useDanhSachDayDu } from '../components/Pagination.js';
import { exportCsv } from '../lib/exportCsv.js';
import { StatusTab, FeePreview } from './TidConfigPage.js';
import { TabBar, TabButton } from '../components/Tabs.js';
// MẪU THIẾT KẾ CHỐT 6/11 — kiểu bảng lấy từ MODULE DÙNG CHUNG, CẤM chép chuỗi class vào trang.
import { KhungBang, thChuan, tdChuan, tdTongChuan, tdTien, tdPhanTram, trChuan, theadChuan, tfootChuan, trTongChuan, tdTrong, HangDem } from '../components/BangChuan.js';
// PHASE 3 — tab "Yêu cầu xuất kho TID" (tạo phiếu TID chưa seri → duyệt sau).
import { ExportRequestPanel } from '../components/ExportRequestPanel.js';

// [B292/F10 24/11] THIẾU 'SOLD' so với business-rules (TID đã bán không lọc ra được). Khai tay danh
// sách trạng thái là trôi — phải đủ như asset.rules; đổi trạng thái mới thì sửa CẢ hai nơi có cổng so.
const TID_STATUSES = ['UNASSIGNED', 'ACTIVE', 'DEAD', 'CLOSED', 'RECALLED', 'SOLD'];
// [Admin Demo 15/11] 'kpi' = tab "Quản Lý TID" CHỈ chứa khối thống kê. Tách ra để tab "Danh sách TID" lấy TRỌN
// chiều cao cho bảng — trước đây KPI + bộ lọc ăn hết, khung bảng chỉ còn ~3 dòng trên màn 904px (đo 13/11).
type Tab = 'kpi' | 'all' | 'undelivered' | 'exportreq' | 'status' | 'ranking';

/** VND, nhóm 3 số bằng dấu chấm (KHÔNG toLocaleString — R_UI QA gate). Giữ dấu âm. Đồng bộ RevenuePage. */
function money(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '−' : '') + s + 'đ';
}

export function TidPage({ user, initialSearch }: { user: AuthUser; initialSearch?: string }): JSX.Element {
  const toast = useToast();
  const canView = hasPermission(user, 'TID_VIEW') || hasPermission(user, 'CONFIG_TID_VIEW');
  const canOps = hasPermission(user, 'TID_MANAGE'); // gán/đổi/thu hồi/giao (vận hành)
  const canConfig = hasPermission(user, 'CONFIG_TID_MANAGE'); // thêm/sửa/xóa cấu hình
  const canConfigView = hasPermission(user, 'CONFIG_TID_VIEW');
  const canRevenue = hasPermission(user, 'REVENUE_VIEW'); // #13: tab xếp hạng doanh số (dữ liệu tài chính)
  const canCancelReq = hasPermission(user, 'TID_CANCEL_REQUEST'); // R34: yêu cầu hủy (xóa mềm qua duyệt)
  const canSell = hasPermission(user, 'DEVICE_SALE_MANAGE'); // Bán TID rời (doanh thu — quyền tiền, không dùng TID_MANAGE)
  const canExportReq = hasAnyPermission(user, ['EXPORT_REQUEST_VIEW', 'EXPORT_REQUEST_CREATE']); // PHASE 3 — yêu cầu xuất kho TID

  const [tab, setTab] = useState<Tab>('all');
  const [rows, setRows] = useState<TidDto[]>([]);
  const [undelivered, setUndelivered] = useState<UndeliveredTidDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(initialSearch ?? ''); // nhảy từ ô tìm kiếm topbar → lọc sẵn theo mã TID đã chọn
  const [statusFilter, setStatusFilter] = useState('');
  const [assignFilter, setAssignFilter] = useState(''); // '' | 'pos' | 'customer' | 'none' — nguồn máy (client-side)
  const [deliverFilter, setDeliverFilter] = useState('');
  const [industryFilter, setIndustryFilter] = useState(''); // LANE A (#11) — lọc theo ngành nghề (industryId)
  const [industries, setIndustries] = useState<{ id: number; code: string; name: string }[]>([]);
  // Danh mục cho MẪU EXCEL RỖNG (Admin Demo 15/11: "ngành nghề cho chọn dạng filler… từ phần mềm").
  const [dmNganHang, setDmNganHang] = useState<string[]>([]);
  const [dmDoiTac, setDmDoiTac] = useState<string[]>([]);
  const [holdingCustomerFilter, setHoldingCustomerFilter] = useState(''); // Admin Demo 12/7 — lọc theo khách hàng đang giữ
  // [B243 22/11 — Admin Demo "thêm lọc TID theo NĐT"] Lọc theo NHÀ ĐẦU TƯ sở hữu máy (qua tài khoản nhận tiền).
  // Lọc Ở MÀN vì danh sách TID đã tải ĐỦ dòng (không phân trang từ 13/11) — không cần đổi máy chủ.
  // Dùng Ô BRAND chọn-nhiều (MultiSelect) y như thanh lọc màn Doanh Số — Admin Demo yêu cầu "lọc brand
  // theo alpha". Ô `<select>` thuần của FilterBar nhìn lạc lõng giữa app.
  const [ndtFilter, setNdtFilter] = useState<string[]>([]);
  // [B246 22/11 — Admin Demo "lọc theo nđt xổ ra danh sách rỗng"] Danh sách NĐT PHẢI đứng độc lập với
  // bộ lọc đang bật. Trước đây nó gom từ `rows` — mà `rows` là KẾT QUẢ ĐÃ LỌC của máy chủ, và ở tab
  // "Chưa giao" thì `rows` còn RỖNG hoàn toàn (tab đó nạp vào `undelivered`) ⇒ bấm ô lọc xổ ra trống
  // trơn. Nay lấy từ DANH MỤC tài khoản nhận tiền (đủ mọi NĐT, không dính bộ lọc nào).
  const [tkNhanTien, setTkNhanTien] = useState<RcvAccountDto[]>([]);
  // [B251 22/11] Vì sao danh sách NĐT rỗng — hiện THẲNG trong ô lọc thay vì để người dùng đoán.
  const [loiNdt, setLoiNdt] = useState<string | null>(null);
  // [B252 22/11 — Admin Demo "danh sách không show NĐT để chọn lọc"] NGUỒN CHÍNH của ô lọc NĐT: danh
  // sách nhà đầu tư do MÁY CHỦ trả kèm `tidRefs` (endpoint màn này vốn đã gọi, chỉ cần quyền xem TID).
  // Không phụ thuộc bảng còn dòng nào, không phụ thuộc quyền xem danh mục tài khoản nhận tiền.
  const [ndtMayChu, setNdtMayChu] = useState<string[]>([]);
  const [dossierSourceFilter, setDossierSourceFilter] = useState(''); // Admin Demo 12/7 — lọc theo nguồn hồ sơ
  const [custOpts, setCustOpts] = useState<{ id: number; label: string }[]>([]);
  const [dossierSourceOpts, setDossierSourceOpts] = useState<{ id: number; label: string }[]>([]);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [deliveredFrom, setDeliveredFrom] = useState(''); // #14 "Kỳ giao" (deliveredAt) từ ngày
  const [deliveredTo, setDeliveredTo] = useState(''); // #14 "Kỳ giao" (deliveredAt) đến ngày
  const [creating, setCreating] = useState(false);
  const [creatingQr, setCreatingQr] = useState(false); // [Admin Demo 4/9] Thêm mã QR bán hàng (kind='QR')
  const [action, setAction] = useState<{ tid: TidDto; kind: 'assign' | 'replace' | 'recall' | 'deliver' } | null>(null);
  const [timelineTid, setTimelineTid] = useState<TidDto | null>(null);
  const [sellFeeTid, setSellFeeTid] = useState<TidDto | null>(null); // R30: phí bán thực tế theo TID × thẻ
  const [cancelTarget, setCancelTarget] = useState<RequestCancelTarget | null>(null); // R34: yêu cầu hủy TID
  const [editTid, setEditTid] = useState<TidDto | null>(null); // Nhóm 1: sửa full thông tin TID
  const [bulkCancel, setBulkCancel] = useState(false); // Nhóm 1: yêu cầu hủy hàng loạt (qua Duyệt Hủy)
  const [bulkEdit, setBulkEdit] = useState(false); // [Admin Demo 13/11] SỬA HÀNG LOẠT theo tích chọn (TK nhận tiền / ngành / đối tác / ngân hàng)
  const [sellTidTarget, setSellTidTarget] = useState<TidDto | null>(null); // Bán TID rời (chưa gắn máy, chưa giao)
  const sel = useRowSelection();
  // [Admin Demo 13/11] Cột tích chọn hiện khi NGƯỜI DÙNG có ÍT NHẤT 1 việc làm được trên nhiều dòng:
  // yêu cầu hủy (TID_CANCEL_REQUEST) HOẶC sửa hàng loạt cấu hình (CONFIG_TID_MANAGE).
  // Trước đây chỉ bám canCancelReq ⇒ người chỉ có quyền cấu hình KHÔNG thấy ô tích, không sửa hàng loạt được.
  const coTichChon = canCancelReq || canConfig;
  // Admin Demo 14/7 — lọc TID theo CÀI APP (ngân hàng của TID), client-side, đồng bộ như danh sách máy POS.
  const [bankFilter, setBankFilter] = useState('');
  const tidBankOptions = (() => {
    const m = new Map<number, string>();
    for (const t of rows) if (t.bankId != null && !m.has(t.bankId)) m.set(t.bankId, t.bankCode ?? t.bankName ?? `NH #${t.bankId}`);
    return [...m.entries()].map(([id, label]) => ({ value: String(id), label }));
  })();
  // Nguồn máy (client-side): pos=máy công ty (deviceAssigned), customer=máy khách, none=chưa gán.
  const tidSource = (t: TidDto): 'pos' | 'customer' | 'none' => t.deviceAssigned ? 'pos' : (t.customerDeviceSerial ? 'customer' : 'none');
  // Admin Demo 13/11 — BỎ PHÂN TRANG: danh sách TID (tab "all"/"chưa giao") vẽ HẾT dòng đã lọc,
  // người dùng cuộn trong khung bảng. Số lượng vẫn thấy ở hàng TỔNG ghim đáy ("TỔNG n TID").
  const tidDisplay = (tab === 'all' ? rows : undelivered)
    // audit 20/8: bankFilter chỉ áp tab 'all' (dropdown Cài-APP chỉ ở tab đó) — trước lọt sang tab 'chưa giao' gây
    // kẹt lọc không gỡ được. Cùng scope như assignFilter.
    .filter((t) => tab !== 'all' || !bankFilter || String((t as TidDto).bankId ?? '') === bankFilter)
    .filter((t) => tab !== 'all' || !assignFilter || tidSource(t as TidDto) === assignFilter)
    // [B243] Lọc theo NĐT. Giá trị '__KHONG__' = máy KHÔNG thuộc nhà đầu tư nào (nội bộ/khách/chưa gán)
    // — để soi được đúng nhóm này thay vì chỉ lọc được từng tên.
    .filter((t) => {
      // [B246] Áp cho CẢ tab "Chưa giao" — dòng tab đó cũng là TID, cũng có NĐT; trước đây ô lọc hiện
      // ra mà bấm không ăn gì ở tab này.
      if (ndtFilter.length === 0) return true;
      const x = t as TidDto;
      const laNdt = x.owyType === 'INVESTOR' && (x.owyName ?? '').trim() !== '';
      const ten = laNdt ? (x.owyName ?? '').trim() : '__KHONG__';
      return ndtFilter.includes(ten);
    });
  const { pageRows: tidPageRows } = useDanhSachDayDu(tidDisplay);
  // [B243 → B246] Danh sách NĐT để chọn: lấy từ DANH MỤC tài khoản nhận tiền (nguồn đầy đủ, không
  // dính bộ lọc) HỢP với tên đang thấy trong bảng — máy nào cũng tra được dù danh mục có thiếu.
  // Mục "(máy không thuộc NĐT)" LUÔN có, vì luôn tồn tại nhóm máy nội bộ/khách/chưa gán tài khoản.
  const dsNdt = useMemo(() => {
    const ten = new Set<string>();
    for (const n of ndtMayChu) if (n) ten.add(n);
    for (const a of tkNhanTien) {
      const n = a.owyType === 'INVESTOR' ? (a.owyName ?? '').trim() : '';
      if (n) ten.add(n);
    }
    for (const t of [...rows, ...undelivered]) {
      const n = t.owyType === 'INVESTOR' ? (t.owyName ?? '').trim() : '';
      if (n) ten.add(n);
    }
    const ds = [...ten].sort((a, b) => a.localeCompare(b, 'vi')).map((x) => ({ value: x, label: x }));
    ds.push({ value: '__KHONG__', label: '(máy không thuộc NĐT)' });
    return ds;
  }, [ndtMayChu, tkNhanTien, rows, undelivered]);

  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    if (tab === 'undelivered') {
      const res = await window.api.tidUndelivered();
      if (res.ok && res.data) setUndelivered(res.data);
      else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
    } else if (tab === 'all') {
      // [B179 → B180 16/11] Màn này từng CẮT MẤT 14/114 TID không báo gì (máy chủ trả pageSize mặc định
      // 100, màn lại không có phân trang). Nay lớp gọi API (`keoHetTrang`) TỰ kéo hết mọi trang cho các
      // đường dẫn có cắt trang, nên ở đây chỉ gọi 1 lần — nhưng VẪN phải đối chiếu `total` và kêu lên nếu
      // thiếu, vì im lặng chính là thứ đã làm lỗi này sống sót.
      const res = await window.api.tidList({
        search: search || undefined,
        status: statusFilter || undefined,
        delivered: deliverFilter ? deliverFilter === 'yes' : undefined,
        industryId: industryFilter ? Number(industryFilter) : undefined,
        holdingCustomerId: holdingCustomerFilter ? Number(holdingCustomerFilter) : undefined,
        dossierSourceId: dossierSourceFilter ? Number(dossierSourceFilter) : undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        deliveredFrom: deliveredFrom || undefined,
        deliveredTo: deliveredTo || undefined
      });
      if (res.ok && res.data) {
        setRows(res.data);
        if (typeof res.total === 'number' && res.data.length < res.total) {
          toast.alert(
            `Mới tải được ${res.data.length}/${res.total} TID — danh sách đang THIẾU. Hãy lọc hẹp lại rồi xem.`,
            'Danh sách TID chưa đủ'
          );
        }
      } else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
      sel.clear();
    }
    setLoading(false);
  }
  useEffect(() => {
    if (tab !== 'status' && tab !== 'ranking' && tab !== 'exportreq') void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, statusFilter, deliverFilter, industryFilter, holdingCustomerFilter, dossierSourceFilter, deliveredFrom, deliveredTo]);

  // [B246] Nạp DANH MỤC tài khoản nhận tiền MỘT LẦN để dựng ô lọc NĐT — độc lập với bộ lọc/tab.
  useEffect(() => {
    if (!canView) return;
    void window.api.rcvAccountList({})
      .then((r) => {
        if (r.ok && r.data) { setTkNhanTien(r.data); setLoiNdt(null); }
        else setLoiNdt('Chưa tải được danh mục tài khoản nhận tiền' + (r.message ? ': ' + r.message : '') + '. Danh sách NĐT đang dựng từ chính bảng TID.');
      })
      .catch((e: unknown) => setLoiNdt('Chưa tải được danh mục tài khoản nhận tiền: ' + String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  // LANE A (#11): nạp danh sách ngành nghề (active) cho bộ lọc — dùng tidRefs (không cần quyền ngành nghề).
  useEffect(() => {
    if (!canView) return;
    void window.api.tidRefs().then((r) => {
      if (!r.ok || !r.data) return;
      setIndustries(r.data.industries);
      // [B252] Nhận luôn danh sách NĐT ở đây (máy chủ cũ không trả thì bỏ qua, các nguồn kia đỡ).
      setNdtMayChu((r.data.investors ?? []).map((v) => v.name.trim()).filter(Boolean));
      // Giá trị đưa vào ô chọn phải là thứ BỘ NHẬP TRA ĐƯỢC: resolver nhận `code` HOẶC `name`
      // (import.ts buildResolvers) ⇒ dùng `name` cho dễ đọc, không ghép "mã · tên" (ghép là tra không ra).
      setDmNganHang(r.data.banks.map((b) => b.name));
      setDmDoiTac(r.data.partners.map((x) => x.name));
    });
  }, [canView]);

  // Admin Demo 12/7 — nạp khách hàng (đang giữ) + nguồn hồ sơ cho 2 bộ lọc mới (rỗng nếu thiếu quyền — graceful).
  useEffect(() => {
    if (!canView) return;
    window.api.customerList({}).then((r) => r.ok && r.data && setCustOpts(r.data.map((c) => ({ id: c.id, label: `${c.code} · ${c.nickname}` }))));
    window.api.dossierSourceList().then((r) => r.ok && r.data && setDossierSourceOpts(r.data.map((s) => ({ id: s.id, label: s.code }))));
  }, [canView]);

  function resetFilters(): void {
    setNdtFilter([]);
    setSearch('');
    setStatusFilter('');
    setBankFilter(''); // audit 20/8: trước đây "Xóa lọc" KHÔNG reset lọc Cài-APP → còn dính im lặng.
    setAssignFilter('');
    setDeliverFilter('');
    setIndustryFilter('');
    setHoldingCustomerFilter('');
    setDossierSourceFilter('');
    setFromDate('');
    setToDate('');
    setDeliveredFrom('');
    setDeliveredTo('');
    setTimeout(() => reloadRef.current(), 0);
  }

  function actionsFor(t: TidDto): { kind: 'assign' | 'replace' | 'recall' | 'deliver'; label: string; icon: JSX.Element }[] {
    const a: { kind: 'assign' | 'replace' | 'recall' | 'deliver'; label: string; icon: JSX.Element }[] = [];
    // Gán máy: khi CHƯA gán (posSerial=null) và còn sống HOẶC đã THU HỒI (RECALLED tái dùng — Admin Demo 1/9).
    if (!t.deviceAssigned && ['UNASSIGNED', 'ACTIVE', 'RECALLED'].includes(t.status)) a.push({ kind: 'assign', label: 'Gán máy POS', icon: <Link2 className="h-3.5 w-3.5" /> });
    if (t.status === 'ACTIVE') a.push({ kind: 'replace', label: 'Đổi TID', icon: <RefreshCw className="h-3.5 w-3.5" /> });
    // Giao khách: CHƯA giao & còn sống, HOẶC đã THU HỒI (RECALLED giữ deliveredAt cũ nhưng giao LẠI cho khách khác
    // được — Admin Demo 1/9 "thu hồi xong phải có nút giao cho khách khác"; server kích hoạt lại ACTIVE).
    if ((!t.delivered && ['UNASSIGNED', 'ACTIVE'].includes(t.status)) || t.status === 'RECALLED') a.push({ kind: 'deliver', label: t.status === 'RECALLED' ? 'Giao lại cho khách' : 'Giao cho khách', icon: <PackageCheck className="h-3.5 w-3.5" /> });
    if (['ACTIVE', 'DEAD', 'CLOSED'].includes(t.status)) a.push({ kind: 'recall', label: 'Thu hồi', icon: <Undo2 className="h-3.5 w-3.5" /> });
    return a;
  }

  const assignedCount = rows.filter((t) => t.deviceAssigned).length; // máy công ty
  const customerDeviceCount = rows.filter((t) => !t.deviceAssigned && t.customerDeviceSerial).length; // máy khách
  const noDeviceCount = rows.filter((t) => !t.deviceAssigned && !t.customerDeviceSerial).length; // chưa gán
  const deliveredCount = rows.filter((t) => t.delivered).length;

  // SỐ CỘT bảng TID — 1 biến duy nhất cho hàng rỗng / hàng đệm / hàng TỔNG.
  // 6 cột đầu + [Số ngày tồn (chỉ tab "chưa giao")] + Thao tác + 3 cột cuối + [ô chọn].
  // [15/11] 10 → 13: thêm STT · tách "Tài khoản nhận tiền" thành TÊN TÀI KHOẢN + STK · thêm ĐẠI LÝ ĐANG SỬ DỤNG.
  const soCotBang = 13 + (tab === 'undelivered' ? 1 : 0) + (tab === 'all' && coTichChon ? 1 : 0);

  return (
    /* `data-nut-vuong` để trang ăn luật NÚT + THANH CUỘN của mau-moi.css (nạp ở main.tsx).
       `data-trang-full` (13/11): trang chiếm trọn chiều cao, chỉ khung bảng cuộn ⇒ HẾT 2 thanh cuộn dọc. */
    <div data-nut-vuong data-trang-full>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Quản Lý TID</h2>
          <p className="text-sm text-slate-500">Terminal ID · 2 chiều độc lập: Gán máy POS · Giao cho khách · vòng đời + timeline TID.</p>
        </div>
        {/* Thanh công cụ: nút nào cũng mang `data-nut` để ăn luật "cùng bề ngang 119px + màu riêng"
            của mau-moi.css. "Xóa lọc" / "Làm mới" đặt Ở ĐÂY (FilterBar nhận hideReset/hideRefresh)
            — y hệt bản mẫu đã duyệt BillManualEntryPage, nhờ vậy 2 nút đó mới được khoá bề ngang. */}
        <div className="flex flex-nowrap items-center justify-end gap-1.5 overflow-x-auto">
          {tab === 'all' && (
            <Button variant="soft" data-nut="xoaloc" onClick={resetFilters} title="Xóa toàn bộ bộ lọc, đưa về mặc định" icon={<FilterX className="h-4 w-4" />}>
              Xóa lọc
            </Button>
          )}
          <Button variant="soft" data-nut="lammoi" onClick={() => void reload()} title="Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc)" icon={<RefreshCw className="h-4 w-4" />}>
            Làm mới
          </Button>
          {tab === 'all' && (
            <Button
              variant="confirm"
              data-nut="excel"
              icon={<Download className="h-4 w-4" />}
              onClick={() =>
                exportCsv(
                  'tid',
                  ['STT', 'TID', 'MID', 'HKD', 'NGÂN HÀNG', 'NGÀNH NGHỀ', 'ĐỐI TÁC', 'GÁN MÁY', 'GIAO KHÁCH', 'ĐẠI LÝ', 'TÊN TÀI KHOẢN', 'STK', 'ỦY QUYỀN', 'VÒNG ĐỜI'],
                  rows.map((t, i) => [i + 1, t.tid, t.mid ?? '', t.hkdName ?? '', t.bankCode ?? t.bank ?? '', t.industryName ?? '', t.partnerName ?? '', t.deviceAssigned ? (t.posSerial ?? 'Đã gán') : (t.customerDeviceSerial ? 'Máy khách' : 'Chưa gán'), t.delivered ? 'Đã giao' : 'Chưa giao', t.holdingCustomerName ?? '', t.receiveAccountName ?? '', t.receiveAccountNumber ?? '', t.owyType === 'INVESTOR' ? `NĐT: ${t.owyName ?? ''}` : t.owyType === 'CUSTOMER' ? `KH: ${t.owyName ?? ''}` : t.owyType === 'INTERNAL' ? 'Nội bộ' : '', statusLabel(t.status)])
                )
              }
            >
              Xuất Excel
            </Button>
          )}
          {tab === 'all' && canConfig && (
            <ImportButton
              entityKey="tid"
              label="TID"
              onImported={reload}
              danhSachChon={{ 'Ngành nghề': industries.map((i) => i.name), 'Ngân hàng': dmNganHang, 'Đối tác': dmDoiTac }}
            />
          )}
          {tab === 'all' && canConfig && (
            <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Thêm TID
            </Button>
          )}
          {/* CÒN TREO (báo cáo lên LEAD): mau-moi.css chỉ khoá bề ngang 119px cho danh sách data-nut
              đã chốt (chuky/ky/xoaloc/lammoi/xoabill/bieudo/baocao/excel/them). "Thêm mã QR" và nút của
              <ImportButton> chưa có tên trong danh sách ⇒ chưa khoá bề ngang. Phải BỔ SUNG TÊN vào
              mau-moi.css — file đó người khác đang sửa, đợt này CẤM chạm nên chưa làm. */}
          {tab === 'all' && canConfig && (
            <Button variant="confirm" data-nut="themqr" icon={<QrCode className="h-4 w-4" />} onClick={() => setCreatingQr(true)}>
              Thêm mã QR
            </Button>
          )}
        </div>
      </div>

      <TabBar>
        <TabButton active={tab === 'kpi'} onClick={() => setTab('kpi')} icon={<Tag className="h-4 w-4" />}>
          Quản Lý TID
        </TabButton>
        <TabButton active={tab === 'all'} onClick={() => setTab('all')} icon={<CreditCard className="h-4 w-4" />}>
          Danh sách TID
        </TabButton>
        <TabButton active={tab === 'undelivered'} onClick={() => setTab('undelivered')} icon={<PackageCheck className="h-4 w-4" />}>
          TID chưa giao {undelivered.length > 0 && <span className="ml-1 rounded-full bg-danger px-1.5 text-xs text-white">{undelivered.length}</span>}
        </TabButton>
        {canExportReq && (
          <TabButton active={tab === 'exportreq'} onClick={() => setTab('exportreq')} icon={<PackageOpen className="h-4 w-4" />}>
            Yêu cầu xuất kho TID
          </TabButton>
        )}
        {canRevenue && (
          <TabButton active={tab === 'ranking'} onClick={() => setTab('ranking')} icon={<Trophy className="h-4 w-4" />}>
            Xếp hạng doanh số
          </TabButton>
        )}
        {canConfigView && (
          <TabButton active={tab === 'status'} onClick={() => setTab('status')} icon={<Tag className="h-4 w-4" />}>
            Trạng thái TID cấu hình
          </TabButton>
        )}
      </TabBar>

      {tab === 'status' && <StatusTab canManage={canConfig} />}
      {tab === 'ranking' && <RevenueRankingTab />}
      {tab === 'exportreq' && <ExportRequestPanel user={user} kind="TID" />}

      {/* 2 nhóm StatBar theo 2 chiều độc lập (§3.4). Đếm CLIENT từ tidList (trả full).
          [15/11] CHỈ hiện ở tab "Quản Lý TID" — tab "Danh sách TID" để trống chỗ cho bảng. */}
      {tab === 'kpi' && (
        <>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Nguồn máy</div>
          <StatBar
            items={[
              { label: 'Máy công ty', value: assignedCount, tone: statusTone('ACTIVE') },
              { label: 'Máy khách', value: customerDeviceCount, tone: statusTone('UNASSIGNED') },
              { label: 'Chưa gán', value: noDeviceCount, tone: 'bg-slate-100 text-slate-500' }
            ]}
          />
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Giao cho khách</div>
          <StatBar
            items={[
              { label: 'Đã giao', value: deliveredCount, tone: statusTone('ACTIVE') },
              { label: 'Chưa giao', value: rows.length - deliveredCount, tone: statusTone('UNASSIGNED') }
            ]}
          />
          {/* Admin Demo 14/7 — bộ đếm TID theo CÀI APP (ngân hàng). Đếm CLIENT từ rows (trả full). */}
          {tidBankOptions.length > 0 && (
            <>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Cài APP (ngân hàng)</div>
              <div className="mb-3 flex flex-wrap gap-2">
                {tidBankOptions.map((b) => (
                  <span key={b.value} className="rounded-full border border-line bg-white px-3 py-1 text-xs text-slate-600">
                    {b.label}: <b className="text-brand">{rows.filter((t) => String(t.bankId ?? '') === b.value).length}</b>
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Thanh lọc: 1 HÀNG, chữ nhỏ (`coChuNho`), nút "Lọc" căn mép phải (`locPhai`).
          7 dropdown + ô tìm + 2 ngày không vừa 1150px ⇒ hàng lọc CUỘN NGANG trong khung của nó,
          nhờ vậy vẫn "1 hàng" mà TRANG không tràn ngang. */}
      {tab === 'all' && (
        <div className="overflow-x-auto">
        <FilterBar
          search={search}
          onSearch={setSearch}
          searchPlaceholder="Tìm TID / MID / HKD…"
          fromDate={fromDate}
          toDate={toDate}
          onFromDate={setFromDate}
          onToDate={setToDate}
          coChuNho
          locPhai
          multiSelects={[
            // [B243 22/11 — Admin Demo "thêm lọc tid theo NĐT phần lọc brand theo alpha"] Ô BRAND chọn-nhiều.
            // Danh sách NĐT rút TỪ CHÍNH dữ liệu đang có, không gọi thêm máy chủ.
            {
              key: 'ndt',
              nhan: 'NĐT',
              value: ndtFilter,
              options: dsNdt,
              onChange: setNdtFilter,
              khiRong: loiNdt ?? 'Chưa có máy nào gắn nhà đầu tư.',
              // [B253] Ô này rộng hơn các ô khác: tên NĐT ("Hòa Linh Đàm") dài hơn hẳn "Ca 1"/"Visa".
              rong: 'w-[190px]'
            }
          ]}
          selects={[
            /* Nhãn "(tất cả)" rút gọn thành "Tất cả …": bề ngang `<select>` = chuỗi DÀI NHẤT trong ô,
               nhãn dài đẩy thanh lọc tràn 60px ở 1920 → nút "Lọc" bị khuất (đo thật, không đoán). */
            { key: 'bankapp', placeholder: 'Tất cả ngân hàng', value: bankFilter, options: tidBankOptions, onChange: setBankFilter },
            { key: 'assign', placeholder: 'Tất cả nguồn máy', value: assignFilter, options: [{ value: 'pos', label: 'Máy công ty' }, { value: 'customer', label: 'Máy khách' }, { value: 'none', label: 'Chưa gán' }], onChange: setAssignFilter },
            { key: 'deliver', placeholder: 'Giao / chưa giao', value: deliverFilter, options: [{ value: 'yes', label: 'Đã giao' }, { value: 'no', label: 'Chưa giao' }], onChange: setDeliverFilter },
            { key: 'industry', placeholder: 'Tất cả ngành nghề', value: industryFilter, options: industries.map((i) => ({ value: String(i.id), label: `${i.code} · ${i.name}` })), onChange: setIndustryFilter },
            { key: 'holding', placeholder: 'Tất cả đại lý đang dùng', value: holdingCustomerFilter, options: custOpts.map((c) => ({ value: String(c.id), label: c.label })), onChange: setHoldingCustomerFilter },
            { key: 'dsource', placeholder: 'Tất cả nguồn hồ sơ', value: dossierSourceFilter, options: dossierSourceOpts.map((s) => ({ value: String(s.id), label: s.label })), onChange: setDossierSourceFilter },
            { key: 'status', placeholder: 'Tất cả trạng thái', value: statusFilter, options: TID_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })), onChange: setStatusFilter }
          ]}
          onApply={reload}
          onReset={resetFilters}
          hideReset
          hideRefresh
        />
        </div>
      )}

      {/* #14 "Kỳ giao" — bộ lọc khoảng ngày giao (deliveredAt), áp dụng ngay khi chọn (useEffect). 1 HÀNG. */}
      {tab === 'all' && (
        <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto text-xs text-slate-500">
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400">Kỳ giao</span>
          <span className="shrink-0 text-xs">Từ</span>
          <input type="date" className={inputCls + ' shrink-0 text-xs'} value={deliveredFrom} onChange={(e) => setDeliveredFrom(e.target.value)} />
          <span className="shrink-0 text-xs">đến</span>
          <input type="date" className={inputCls + ' shrink-0 text-xs'} value={deliveredTo} onChange={(e) => setDeliveredTo(e.target.value)} />
          {(deliveredFrom || deliveredTo) && (
            <button
              onClick={() => {
                setDeliveredFrom('');
                setDeliveredTo('');
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-brand hover:bg-brand/10"
            >
              <FilterX className="h-3.5 w-3.5" /> Bỏ kỳ giao
            </button>
          )}
        </div>
      )}

      {/* StatBar tab "TID chưa giao" — đếm CLIENT theo số ngày tồn (agingDays) từ tidUndelivered. */}
      {tab === 'undelivered' && (
        <StatBar
          items={[
            { label: 'Tổng chưa giao', value: undelivered.length, tone: 'bg-brand-tint text-brand' },
            { label: 'Tồn ≥ 30 ngày', value: undelivered.filter((u) => u.agingDays >= 30).length, tone: 'bg-rose-50 text-rose-600' },
            { label: 'Tồn 14–29 ngày', value: undelivered.filter((u) => u.agingDays >= 14 && u.agingDays < 30).length, tone: 'bg-amber-50 text-amber-600' },
            { label: 'Tồn dưới 14 ngày', value: undelivered.filter((u) => u.agingDays < 14).length, tone: 'bg-emerald-50 text-emerald-600' }
          ]}
        />
      )}

      {/* THANH THAO TÁC HÀNG LOẠT — dựng tại chỗ (không dùng SelectionBar chung) vì cần HAI nút hành động:
          "Sửa hàng loạt" (Admin Demo 13/11) + "Yêu cầu hủy" (R34). Giữ NGUYÊN khung/màu/chữ của SelectionBar
          để không lệch design-system. Mỗi nút gate theo đúng quyền của nó. */}
      {tab === 'all' && coTichChon && sel.count > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-tint px-4 py-2.5">
          <span className="text-sm font-medium text-brand">Đã chọn {sel.count} TID</span>
          <div className="flex-1" />
          <Button variant="neutral" onClick={sel.clear}>Bỏ chọn</Button>
          {canConfig && (
            <Button variant="edit" data-kiem="nut-sua-hang-loat" icon={<Pencil className="h-4 w-4" />} onClick={() => setBulkEdit(true)}>
              Sửa hàng loạt ({sel.count})
            </Button>
          )}
          {canCancelReq && <Button variant="danger" onClick={() => setBulkCancel(true)}>Yêu cầu hủy ({sel.count})</Button>}
        </div>
      )}
      {(tab === 'all' || tab === 'undelivered') && <StaleBanner domain="Tid" onReload={reload} className="mb-2" />}
      {(tab === 'all' || tab === 'undelivered') && (
        <KhungBang className="list-scroll bg-white shadow-sm">
          {/* 11 cột → `min-w` cho CUỘN NGANG chủ ý; số cột CỐ ĐỊNH ở mọi bề ngang (CẤM ẩn cột theo breakpoint:
              cột ẩn làm hàng TỔNG lệch 1 cột mà phép đếm querySelectorAll vẫn báo xanh). */}
          {/* 13/11 — thu 4 cột (Thao tác/Trạng thái/Nguồn máy/Ngành nghề) nên HẠ min-w theo đúng số hụt
              (210px): giữ min-w cũ thì bảng vẫn rộng y nguyên, phần thu được chỉ chạy sang cột khác. */}
          <table className="w-full min-w-[1602px] text-xs">
            <thead className={theadChuan}>
              {/* Nền trên `<tr>`: ô checkbox do SelectAllCell (module chung) render, không mang `thChuan`. */}
              <tr className="bg-slate-200">
                {tab === 'all' && coTichChon && <SelectAllCell ids={(tidPageRows as TidDto[]).map((r) => r.id)} sel={sel} />}
                {/* [Admin Demo 15/11] +STT · đổi tên 3 cột · căn giữa Nguồn máy + Trạng thái giao khách ·
                    tách "Tài khoản nhận tiền" thành TÊN TÀI KHOẢN rồi STK · GỌN bề ngang để hiện được nhiều cột hơn
                    (HKD 220→170, Giao khách 180→150, Ngành nghề 112→96, Uỷ quyền 160→140). */}
                <th className={thChuan + ' w-[52px] text-center'}>STT</th>
                <th className={thChuan + ' w-[92px]'}>TID</th>
                <th className={thChuan + ' w-[170px]'}>HKD</th>
                <th className={thChuan + ' w-[88px] text-center'}>NGÂN HÀNG</th>
                <th className={thChuan + ' w-[112px] text-center'}>GÁN MÁY</th>
                <th className={thChuan + ' w-[130px] text-center'}>GIAO KHÁCH</th>
                {/* [Admin Demo 15/11] cột ĐẠI LÝ ĐANG SỬ DỤNG — trước đây chỉ có trong FILE XUẤT, nay lên bảng.
                    Nguồn: holdingCustomerName = khách đang giữ TID (đã giao & còn sống), null khi chưa giao. */}
                <th className={thChuan + ' w-[150px] text-center'}>ĐẠI LÝ</th>
                <th className={thChuan + ' w-[96px] text-center'}>TRẠNG THÁI</th>
                {tab === 'undelivered' && <th className={thChuan + ' w-[96px] text-center'}>SỐ NGÀY TỒN</th>}
                {(tab === 'all' || tab === 'undelivered') && <th className={thChuan + ' w-[168px]'}>THAO TÁC</th>}
                <th className={thChuan + ' w-[150px] text-center'}>TÊN TÀI KHOẢN</th>
                <th className={thChuan + ' w-[124px] text-center'}>STK</th>
                <th className={thChuan + ' w-[140px]'}>ỦY QUYỀN</th>
                {/* [Admin Demo 15/11] NGÀNH NGHỀ chuyển xuống CUỐI bảng. */}
                <th className={thChuan + ' w-[96px]'}>NGÀNH NGHỀ</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={soCotBang} className={tdTrong}>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </td>
                </tr>
              )}
              {!loading && tab === 'all' && rows.length === 0 && (
                <tr>
                  <td colSpan={soCotBang} className={tdTrong}>
                    <CreditCard className="mx-auto mb-2 h-6 w-6" />
                    Chưa có TID.
                  </td>
                </tr>
              )}
              {!loading && tab === 'undelivered' && undelivered.length === 0 && (
                <tr>
                  <td colSpan={soCotBang} className={tdTrong}>
                    <PackageCheck className="mx-auto mb-2 h-6 w-6" />
                    Không có TID nào chưa giao. 🎉
                  </td>
                </tr>
              )}
              {!loading && (tidPageRows as (TidDto | UndeliveredTidDto)[]).map((t, i) => (
                /* Sọc ngựa vằn; TID tồn ≥30 ngày tô đỏ nhạt; dòng đang tích nổi bật vàng (trChuan). */
                <tr
                  key={t.id}
                  className={
                    trChuan(i, tab === 'all' && sel.isSelected(t.id)) +
                    (tab === 'undelivered' && (t as UndeliveredTidDto).agingDays >= 30 ? ' !bg-danger/5' : '')
                  }
                >
                  {tab === 'all' && coTichChon && <SelectCell id={t.id} sel={sel} />}
                  <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{i + 1}</td>
                  <td className={tdChuan + ' text-center font-mono font-semibold tabular-nums text-slate-700'}>{t.tid}</td>
                  <td className={tdChuan + ' max-w-[170px] truncate text-slate-600'} title={t.hkdName ?? ''}>{t.hkdName ?? '—'}</td>
                  <td className={tdChuan + ' text-center text-slate-600'}>{t.bankCode ?? t.bank ?? '—'}</td>
                  <td className={tdChuan + ' text-center'}>
                    <AssignCell t={t} />
                  </td>
                  <td className={tdChuan + ' text-center'}>
                    <DeliverCell t={t} />
                  </td>
                  <td className={tdChuan + ' max-w-[150px] truncate text-center text-slate-600'} title={t.holdingCustomerName ?? ''}>{t.holdingCustomerName ?? '—'}</td>
                  <td className={tdChuan + ' text-center'}>
                    <StatusPill status={t.status} />
                  </td>
                  {tab === 'undelivered' && (
                    <td className={tdChuan + ' text-center tabular-nums'}>
                      <span className={'font-semibold ' + ((t as UndeliveredTidDto).agingDays >= 30 ? 'text-danger' : (t as UndeliveredTidDto).agingDays >= 14 ? 'text-warning' : 'text-slate-600')}>
                        {(t as UndeliveredTidDto).agingDays} ngày
                      </span>
                    </td>
                  )}
                  {(tab === 'all' || tab === 'undelivered') && (
                    <td className={tdChuan}>
                      {/* Admin Demo 12/7 — nút thao tác ICON-ONLY (tooltip) cho gọn: cột Thao tác không còn chiếm nhiều
                          chỗ, nhường bề ngang cho dữ liệu (TID/HKD/Khách giữ hiển thị đủ 1 hàng). */}
                      <div className="flex justify-start gap-1">
                        <IconButton title="Vòng đời TID" tone="neutral" onClick={() => setTimelineTid(t)}>
                          <History className="h-4 w-4" />
                        </IconButton>
                        {tab === 'all' && canConfig && (
                          <IconButton title="Sửa thông tin TID" tone="edit" onClick={() => setEditTid(t)}>
                            <Pencil className="h-4 w-4" />
                          </IconButton>
                        )}
                        {canOps && (
                          <IconButton title="Phí bán thực tế theo loại thẻ (thỏa thuận khi giao)" tone="view" onClick={() => setSellFeeTid(t)}>
                            <Percent className="h-4 w-4" />
                          </IconButton>
                        )}
                        {canSell && !t.deviceAssigned && !t.delivered && ['UNASSIGNED', 'ACTIVE'].includes(t.status) && (
                          <IconButton title="Bán TID rời (chưa gắn máy)" tone="success" onClick={() => setSellTidTarget(t)}>
                            <Banknote className="h-4 w-4" />
                          </IconButton>
                        )}
                        {canOps &&
                          actionsFor(t).map((a) => {
                            // R33: mỗi thao tác 1 sắc thái riêng để phân biệt rõ (không còn xám giống nhau).
                            const tone = a.kind === 'assign' || a.kind === 'deliver' ? 'view' : a.kind === 'recall' ? 'edit' : 'neutral';
                            return (
                              <IconButton key={a.kind} title={a.label} tone={tone} onClick={() => setAction({ tid: t, kind: a.kind })}>
                                {a.icon}
                              </IconButton>
                            );
                          })}
                        {canCancelReq && (
                          <IconButton title="Yêu cầu hủy" tone="danger" onClick={() => setCancelTarget({ entityType: 'Tid', entityId: t.id, entityLabel: t.tid, typeLabel: 'TID' })}>
                            <Trash2 className="h-4 w-4" />
                          </IconButton>
                        )}
                      </div>
                    </td>
                  )}
                  <td className={tdChuan + ' max-w-[150px] truncate text-center text-slate-600'} title={t.receiveAccountName ?? ''}>{t.receiveAccountName ?? '—'}</td>
                  <td className={tdChuan + ' text-center font-mono tabular-nums text-slate-600'}>{t.receiveAccountNumber ?? '—'}</td>
                  <td className={tdChuan + ' text-center text-slate-600'}>{t.owyType === 'INVESTOR' ? `NĐT: ${t.owyName ?? '—'}` : t.owyType === 'CUSTOMER' ? `KH: ${t.owyName ?? '—'}` : t.owyType === 'INTERNAL' ? 'Nội bộ' : '—'}</td>
                  <td className={tdChuan + ' text-center text-slate-600'}>{t.industryName ?? '—'}</td>
                </tr>
              ))}
              <HangDem soCot={soCotBang} />
            </tbody>
            {/* Hàng TỔNG ghim đáy — đếm từ CHÍNH tập đang lọc (`tidDisplay`), không lấy nguồn khác. */}
            <tfoot className={tfootChuan}>
              <tr className={trTongChuan}>
                <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={soCotBang}>
                  TỔNG {tidDisplay.length} TID{tab === 'all' ? ` · đã giao ${deliveredCount}` : ''}
                </td>
              </tr>
            </tfoot>
          </table>
        </KhungBang>
      )}

      {creating && (
        <TidCreateForm
          canOps={canOps}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await reload();
          }}
        />
      )}
      {creatingQr && (
        <QrCreateForm
          onClose={() => setCreatingQr(false)}
          onSaved={async () => {
            setCreatingQr(false);
            await reload();
          }}
        />
      )}
      {action && (
        <TidActionModal
          tid={action.tid}
          kind={action.kind}
          onClose={() => setAction(null)}
          onDone={async () => {
            setAction(null);
            await reload();
          }}
          onOpenSell={
            canSell
              ? () => {
                  const t = action.tid;
                  setAction(null);
                  setSellTidTarget(t);
                }
              : undefined
          }
        />
      )}
      {timelineTid && <TidTimelineModal tid={timelineTid} onClose={() => setTimelineTid(null)} />}
      {sellFeeTid && (
        <TidSellFeeModal
          tid={sellFeeTid}
          onClose={() => setSellFeeTid(null)}
          onSaved={() => setSellFeeTid(null)}
        />
      )}
      {cancelTarget && (
        <RequestCancelModal
          target={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onDone={() => {
            setCancelTarget(null);
            void reload();
          }}
        />
      )}
      {sellTidTarget && (
        <SellTidModal
          tid={sellTidTarget}
          onClose={() => setSellTidTarget(null)}
          onDone={async () => {
            setSellTidTarget(null);
            await reload();
          }}
        />
      )}
      {editTid && (
        <TidEditForm
          tid={editTid}
          onClose={() => setEditTid(null)}
          onSaved={async () => {
            setEditTid(null);
            await reload();
          }}
        />
      )}
      {/* [Admin Demo 13/11] SỬA HÀNG LOẠT — truyền ĐÚNG các dòng đang tích chọn (lọc từ `rows` đang hiển thị).
          Chạy xong có TID sửa được thì `onDone` nạp lại danh sách + bỏ tích (reload() tự gọi sel.clear). */}
      {bulkEdit && (
        <TidBulkEditModal
          rows={rows.filter((r) => sel.isSelected(r.id))}
          onClose={() => setBulkEdit(false)}
          onDone={() => {
            setBulkEdit(false);
            void reload();
          }}
        />
      )}
      {bulkCancel && (
        <BulkRequestCancelModal
          entityType="Tid"
          ids={[...sel.selected]}
          typeLabel="TID"
          onClose={() => setBulkCancel(false)}
          onDone={() => {
            setBulkCancel(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

/** Nhóm 1 — Sửa FULL thông tin TID (cấu hình): HKD/đối tác/ngân hàng/ngành nghề/MID/ghi chú/ngày cấp/máy
 *  khách. Chuỗi TID = định danh (khóa join event-log) → CHỈ ĐỌC. Vận hành (gán/giao/thu hồi) qua nút riêng. */
function TidEditForm({ tid, onClose, onSaved }: { tid: TidDto; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [refs, setRefs] = useState<TidRefs | null>(null);
  const [dossierId, setDossierId] = useState(tid.dossierId ? String(tid.dossierId) : '');
  const [hkdName, setHkdName] = useState(tid.hkdName ?? '');
  const [partnerId, setPartnerId] = useState(tid.partnerId ? String(tid.partnerId) : '');
  const [bankId, setBankId] = useState(tid.bankId ? String(tid.bankId) : '');
  const [industryId, setIndustryId] = useState(tid.industryId ? String(tid.industryId) : '');
  const [mid, setMid] = useState(tid.mid ?? '');
  const [issuedAt, setIssuedAt] = useState(tid.issuedAt ? tid.issuedAt.slice(0, 10) : '');
  const [customerDeviceSerial, setCustomerDeviceSerial] = useState(tid.customerDeviceSerial ?? '');
  const [receiveAccountId, setReceiveAccountId] = useState(tid.receiveAccountId ? String(tid.receiveAccountId) : ''); // Phase B — TK nhận tiền (suy uỷ)
  const [investFeePct, setInvestFeePct] = useState(tid.investFeeMilli != null ? String(tid.investFeeMilli / 1000) : ''); // %phí đầu tư override theo TID
  const [accounts, setAccounts] = useState<RcvAccountDto[]>([]);
  const [note, setNote] = useState(tid.note ?? '');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false); // Admin Demo 3/9 — SỬA LỖI NHẬP chuỗi TID (cascade, gate mật khẩu)
  const [isQr, setIsQr] = useState(false); // [Admin Demo 5/9] mã QR? → mới hiện mục "Tài khoản DigiStore (báo có)"

  useEffect(() => {
    window.api.tidRefs().then((r) => r.ok && r.data && setRefs(r.data));
    window.api.rcvAccountList({}).then((r) => r.ok && r.data && setAccounts(r.data));
    // Suy mã QR qua endpoint DigiStore (trả isQr) — chỉ mã QR mới có mục tài khoản DigiStore.
    window.api.qrDigistoreCredGet(tid.id).then((r) => { if (r.ok && r.isQr) setIsQr(true); });
  }, [tid.id]);

  // Ngân hàng lọc theo liên kết đối tác (PartnerBank) — nhất quán form Thêm TID.
  const linkedBankIds = partnerId && refs ? refs.partnerBanks[Number(partnerId)] ?? [] : [];
  const linkedBanks = refs ? refs.banks.filter((b) => linkedBankIds.includes(b.id)) : [];
  // Phase B — chỉ hiện ô "% phí đầu tư theo TID" khi TK nhận tiền chọn có UỶ = Nhà đầu tư.
  const selectedAcc = accounts.find((a) => String(a.id) === receiveAccountId);
  const owyInvestor = selectedAcc?.owyType === 'INVESTOR';

  function onPickDossier(id: string): void {
    setDossierId(id);
    const d = refs?.dossiers.find((x) => String(x.id) === id);
    if (d) setHkdName(d.hkdName);
  }

  async function save(): Promise<void> {
    if (!partnerId) return toast.alert('Vui lòng chọn đối tác.', 'Thiếu thông tin');
    if (!bankId) return toast.alert('Vui lòng chọn ngân hàng.', 'Thiếu thông tin');
    if (!hkdName.trim()) return toast.alert('Tên Hộ Kinh Doanh bắt buộc.', 'Thiếu thông tin');
    // FE-6 (audit 20/8): %phí đầu tư nhập lỗi (vd "1.2.3") → Number=NaN → Math.round(NaN)=NaN → JSON hoá null → override
    // RƠI IM LẶNG (server tưởng bỏ trống). Chặn tại đây, báo rõ thay vì nuốt. Trống = dùng mặc định NĐT (hợp lệ).
    if (owyInvestor && investFeePct.trim() !== '' && !Number.isFinite(Number(investFeePct)))
      return toast.alert('% phí đầu tư (theo TID) không hợp lệ — nhập số (ví dụ 0.1).', 'Sai định dạng');
    setBusy(true);
    const input: ConfigTidInput = {
      tid: tid.tid, // định danh — server giữ nguyên (không đổi qua form này)
      partnerId: Number(partnerId),
      bankId: Number(bankId),
      hkdName: hkdName.trim(),
      industryId: industryId ? Number(industryId) : null,
      mid: mid.trim() || null,
      issuedAt: issuedAt || null,
      dossierId: dossierId ? Number(dossierId) : null,
      customerDeviceSerial: customerDeviceSerial.trim() || null,
      receiveAccountId: receiveAccountId ? Number(receiveAccountId) : null,
      investFeeMilli: owyInvestor && investFeePct.trim() !== '' ? Math.round(Number(investFeePct) * 1000) : null,
      note: note.trim() || null,
      expectedUpdatedAt: tid.updatedAt // optimistic-lock (Admin Demo 11/8) — chống 2 người sửa đè cấu hình TID
    };
    const res = await window.api.tidConfigUpdate(tid.id, input);
    setBusy(false);
    if (res.ok) { toast.success(`Đã cập nhật TID ${tid.tid}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else baoLoi(toast.alert, res, 'Cập nhật TID');
  }

  return (
    <Modal title={`Sửa TID ${tid.tid}`} onClose={onClose}>
      {!refs && <div className="py-6 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>}
      {refs && (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-appbg px-3 py-2 text-xs text-slate-500">
            <span>
              Chuỗi TID <b className="font-mono text-slate-700">{tid.tid}</b> là định danh cố định — không sửa ở đây. Gán máy / giao khách / thu hồi đổi qua nút thao tác riêng.
            </span>
            {/* Admin Demo 3/9 — SỬA LỖI NHẬP chuỗi TID: đổi định danh + cascade nguyên tử mọi bảng nối theo chuỗi
                (timeline/gắn máy/current_tid/chứng từ). Gate mật khẩu. KHÁC "Lưu thay đổi" (chỉ sửa field cấu hình). */}
            <button type="button" onClick={() => setRenaming(true)} className="flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-medium text-amber-700 hover:bg-amber-100">
              <Pencil className="h-3.5 w-3.5" /> Sửa lỗi nhập chuỗi TID
            </button>
          </div>
          {renaming && (
            <TidRenameModal
              tid={tid}
              onClose={() => setRenaming(false)}
              onDone={() => {
                setRenaming(false);
                onSaved(); // reload danh sách + đóng form (chuỗi đã đổi → row cũ stale)
              }}
            />
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Hộ Kinh Doanh (HKD)" hint="Chọn để tự điền tên + gắn hồ sơ">
              <select className={inputCls} value={dossierId} onChange={(e) => onPickDossier(e.target.value)}>
                <option value="">— Chọn HKD —</option>
                {refs.dossiers.map((d) => <option key={d.id} value={d.id}>{d.hkdName}{d.ownerName ? ` · ${d.ownerName}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Tên Hộ Kinh Doanh" required>
              <input className={inputCls} value={hkdName} onChange={(e) => setHkdName(e.target.value)} />
            </Field>
            <Field label="Đối tác" required>
              <select className={inputCls} value={partnerId} onChange={(e) => { setPartnerId(e.target.value); setBankId(''); }}>
                <option value="">— Chọn đối tác —</option>
                {refs.partners.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
              </select>
            </Field>
            <Field label="Ngân hàng" required hint="Lọc theo liên kết đối tác ↔ ngân hàng">
              <PickerGoiY
                items={(partnerId ? linkedBanks : refs.banks).map((b) => ({ value: String(b.id), nhan: `${b.code}` }))}
                value={bankId}
                onChange={setBankId}
                placeholder="Gõ mã hoặc tên ngân hàng…"
                dataKiem="o-chon-ngan-hang"
              />
            </Field>
            <Field label="Ngành nghề" hint="Theo ĐKKD của HKD">
              <select className={inputCls} value={industryId} onChange={(e) => setIndustryId(e.target.value)}>
                <option value="">— Không chọn —</option>
                {refs.industries.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
              </select>
            </Field>
            <Field label="Chuỗi MID">
              <input className={inputCls} value={mid} onChange={(e) => setMid(e.target.value)} />
            </Field>
            <Field label="Ngày cấp TID">
              <input type="date" className={inputCls} value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} />
            </Field>
            <Field label="Serial máy của khách" hint="Tùy chọn — tra cứu, không tạo máy trong kho">
              <input className={inputCls} value={customerDeviceSerial} onChange={(e) => setCustomerDeviceSerial(e.target.value)} />
            </Field>
            <Field label="Tài khoản nhận tiền" hint="TID suy UỶ (Khách/NĐT/Nội bộ) qua tài khoản này">
              <select className={inputCls} value={receiveAccountId} onChange={(e) => setReceiveAccountId(e.target.value)}>
                <option value="">— Không chọn —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}{a.owyType === 'INVESTOR' ? ` · NĐT: ${a.owyName ?? ''}` : a.owyType === 'CUSTOMER' ? ` · KH: ${a.owyName ?? ''}` : ' · Nội bộ'}</option>)}
              </select>
            </Field>
            {owyInvestor && (
              <Field label="% phí đầu tư (theo TID)" hint="Bỏ trống = dùng % mặc định của nhà đầu tư">
                <input className={inputCls + ' text-right tabular-nums'} inputMode="decimal" value={investFeePct} onChange={(e) => setInvestFeePct(e.target.value.replace(/[^\d.]/g, ''))} placeholder="vd 0.1" />
              </Field>
            )}
            <div className="col-span-2">
              <Field label="Ghi chú">
                <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>
            {/* [Admin Demo 5/9] Chỉ mã QR mới có mục Tài khoản DigiStore (báo có). Tự lưu riêng (không qua nút "Lưu thay đổi"). */}
            {isQr && <DigistoreCredSection tidId={tid.id} />}
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="neutral" onClick={onClose}>Hủy</Button>
            <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Lưu thay đổi</Button>
          </div>
        </>
      )}
    </Modal>
  );
}


// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ SỬA HÀNG LOẠT TID THEO TÍCH CHỌN (Admin Demo 13/11: "khi chọn tid cho tích chọn thì thêm sửa hàng loạt") ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝

/** 3 chế độ cho MỖI trường — tách bạch tuyệt đối, không đoán ý:
 *  • `giu` = KHÔNG gửi khoá đó lên máy chủ ⇒ lớp nghiệp vụ giữ nguyên giá trị cũ.
 *  • `dat` = gửi id đã chọn.
 *  • `xoa` = gửi THẲNG `null` ⇒ xoá trống.
 *  Ranh giới `giu` ↔ `xoa` dựa ĐÚNG cơ chế `'x' in body` mà route `tid-config.ts` vừa vá 13/11
 *  (trước đây `?? undefined` nuốt mất lệnh gỡ: API trả 200 ok mà sổ không đổi). */
type CheDoSua = 'giu' | 'dat' | 'xoa';

/** Kết quả chạy — BA con số tách bạch + DANH SÁCH TID hỏng kèm lý do (R198: cấm chỉ báo "đã xong"). */
interface KetQuaSuaHangLoat {
  thanhCong: number;
  boQua: { tid: string; lyDo: string }[];
  hong: { tid: string; lyDo: string }[];
}

/** Cụm 3 nút chọn chế độ của 1 trường. `khoaXoa` = trường BẮT BUỘC ở lớp nghiệp vụ (không thể để trống). */
function NutCheDo({
  khoa,
  cheDo,
  doiCheDo,
  khoaXoa,
  dang
}: {
  khoa: string;
  cheDo: CheDoSua;
  doiCheDo: (c: CheDoSua) => void;
  khoaXoa?: string;
  dang: boolean;
}): JSX.Element {
  const o = (c: CheDoSua, nhan: string, tatVi?: string): JSX.Element => (
    <button
      type="button"
      data-kiem={khoa + '-' + c}
      disabled={dang || !!tatVi}
      title={tatVi ?? ''}
      onClick={() => doiCheDo(c)}
      className={
        'rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ' +
        (cheDo === c
          ? c === 'xoa'
            ? 'border-rose-400 bg-rose-50 text-rose-700'
            : c === 'dat'
              ? 'border-brand bg-brand-tint text-brand'
              : 'border-slate-300 bg-slate-100 text-slate-700'
          : 'border-line bg-white text-slate-500 hover:bg-slate-50')
      }
    >
      {nhan}
    </button>
  );
  return (
    <div className="flex shrink-0 gap-1">
      {o('giu', 'Giữ nguyên')}
      {o('dat', 'Đặt thành…')}
      {o('xoa', 'Xoá trống', khoaXoa)}
    </div>
  );
}

/** Khung 1 trường trong hộp thoại: nhãn + cụm 3 chế độ + ô chọn giá trị (chỉ hiện khi chế độ = "đặt thành"). */
function OSuaHangLoat({
  khoa,
  nhan,
  moTa,
  cheDo,
  doiCheDo,
  khoaXoa,
  dang,
  children
}: {
  /** Tiền tố data-kiem cho cụm 3 nút chế độ (bài kiểm lái giao diện bám vào đây). */
  khoa: string;
  nhan: string;
  moTa: string;
  cheDo: CheDoSua;
  doiCheDo: (c: CheDoSua) => void;
  khoaXoa?: string;
  dang: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className={'rounded-xl border p-3 ' + (cheDo === 'giu' ? 'border-line bg-white' : cheDo === 'xoa' ? 'border-rose-300 bg-rose-50/40' : 'border-brand/40 bg-brand-tint/40')}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-700">{nhan}</span>
        <NutCheDo khoa={khoa} cheDo={cheDo} doiCheDo={doiCheDo} khoaXoa={khoaXoa} dang={dang} />
      </div>
      {cheDo === 'dat' && children}
      {cheDo === 'xoa' && <p className="text-xs font-medium text-rose-600">Sẽ XOÁ TRỐNG {moTa} trên các TID đã chọn.</p>}
      {cheDo === 'giu' && <p className="text-xs text-slate-400">Không đụng tới {moTa}.</p>}
    </div>
  );
}

/**
 * Hộp thoại SỬA HÀNG LOẠT — đặt CÙNG MỘT giá trị cho mọi TID đã tích chọn.
 *
 * ── Vì sao gọi LẦN LƯỢT endpoint sửa-1-TID (PATCH /v1/tid-configs/:id) thay vì làm API mới? ──
 * Giữ NGUYÊN toàn bộ lớp nghiệp vụ đã được kiểm: quyền CONFIG_TID_MANAGE, validateRefs (TK nhận/ngành/ngân
 * hàng/đối tác phải tồn tại), KHOÁ CHỐNG GHI ĐÈ `expectedUpdatedAt`, và bản ghi NHẬT KÝ `TID_CONFIG_UPDATED`
 * cho TỪNG TID. Một API gộp sẽ phải chép lại hết các lớp đó — nguy cơ sót.
 *
 * ── Chống nuốt lỗi (R198) ──
 * Mỗi TID chạy trong try/catch RIÊNG. Hỏng 1 TID thì vòng lặp CHẠY TIẾP, và TID hỏng được ghi tên + lý do.
 * Cuối cùng báo ĐỦ 3 con số: thành công / bỏ qua / HỎNG — đếm ĐỘNG từ chính vòng lặp, không hard-code.
 *
 * ── `expectedUpdatedAt` ──
 * Lấy Y NGUYÊN `updatedAt` mà API list vừa trả về cho dòng đó rồi gửi lại (đúng khuôn form sửa 1 TID).
 * KHÔNG tự tính/tự dựng mốc thời gian — API đọc `updatedAt` lệch +7h so với DB (lỗi múi giờ đã biết của
 * repo), tự dựng là chắc chắn lệch ⇒ bị chặn STALE_WRITE hàng loạt.
 */
function TidBulkEditModal({ rows, onClose, onDone }: { rows: TidDto[]; onClose: () => void; onDone: () => void }): JSX.Element {
  const toast = useToast();
  const [refs, setRefs] = useState<TidRefs | null>(null);
  const [accounts, setAccounts] = useState<RcvAccountDto[]>([]);

  // 1) Tài khoản nhận tiền — việc Admin Demo cần gấp nhất.
  const [cdTk, setCdTk] = useState<CheDoSua>('giu');
  const [tkMoi, setTkMoi] = useState('');
  // 2) Ngành nghề.
  const [cdNganh, setCdNganh] = useState<CheDoSua>('giu');
  const [nganhMoi, setNganhMoi] = useState('');
  // 3) Đối tác.
  const [cdDoiTac, setCdDoiTac] = useState<CheDoSua>('giu');
  const [doiTacMoi, setDoiTacMoi] = useState('');
  // 4) Ngân hàng.
  const [cdNganHang, setCdNganHang] = useState<CheDoSua>('giu');
  const [nganHangMoi, setNganHangMoi] = useState('');

  const [dang, setDang] = useState(false);
  const [tienDo, setTienDo] = useState(0);
  const [ketQua, setKetQua] = useState<KetQuaSuaHangLoat | null>(null);

  useEffect(() => {
    window.api.tidRefs().then((r) => r.ok && r.data && setRefs(r.data));
    window.api.rcvAccountList({}).then((r) => r.ok && r.data && setAccounts(r.data));
  }, []);

  // Ngân hàng lọc theo liên kết đối tác — CHỈ khi người dùng cũng đang đặt đối tác hàng loạt (lúc đó mọi TID
  // sẽ cùng 1 đối tác). Không đặt đối tác thì mỗi TID giữ đối tác riêng ⇒ hiện TOÀN BỘ ngân hàng, để máy chủ
  // phán quyết (TID nào không hợp lệ sẽ rơi vào cột HỎNG kèm lý do, không bị giấu).
  const nganHangTheoDoiTac =
    cdDoiTac === 'dat' && doiTacMoi && refs ? refs.banks.filter((b) => (refs.partnerBanks[Number(doiTacMoi)] ?? []).includes(b.id)) : refs?.banks ?? [];

  /** Trường nào đang THỰC SỰ được sửa (chế độ ≠ giữ nguyên). */
  const dangSua: { khoa: string; nhan: string }[] = [
    ...(cdTk !== 'giu' ? [{ khoa: 'receiveAccountId', nhan: 'Tài khoản nhận tiền' }] : []),
    ...(cdNganh !== 'giu' ? [{ khoa: 'industryId', nhan: 'Ngành nghề' }] : []),
    ...(cdDoiTac !== 'giu' ? [{ khoa: 'partnerId', nhan: 'Đối tác' }] : []),
    ...(cdNganHang !== 'giu' ? [{ khoa: 'bankId', nhan: 'Ngân hàng' }] : [])
  ];
  /** Chế độ "Đặt thành…" mà CHƯA chọn giá trị ⇒ chặn chạy (không để gửi rỗng rồi hỏng hàng loạt). */
  const thieuGiaTri: string[] = [
    ...(cdTk === 'dat' && !tkMoi ? ['Tài khoản nhận tiền'] : []),
    ...(cdNganh === 'dat' && !nganhMoi ? ['Ngành nghề'] : []),
    ...(cdDoiTac === 'dat' && !doiTacMoi ? ['Đối tác'] : []),
    ...(cdNganHang === 'dat' && !nganHangMoi ? ['Ngân hàng'] : [])
  ];
  const chayDuoc = dangSua.length > 0 && thieuGiaTri.length === 0 && rows.length > 0;

  /** TID này đã sẵn mang ĐÚNG mọi giá trị đích ⇒ không cần gọi máy chủ (tính vào "bỏ qua", có nêu lý do). */
  function daDungHet(t: TidDto): boolean {
    const okTk = cdTk === 'giu' || (cdTk === 'dat' ? t.receiveAccountId === Number(tkMoi) : t.receiveAccountId == null);
    const okNganh = cdNganh === 'giu' || (cdNganh === 'dat' ? t.industryId === Number(nganhMoi) : t.industryId == null);
    const okDoiTac = cdDoiTac === 'giu' || (cdDoiTac === 'dat' ? t.partnerId === Number(doiTacMoi) : t.partnerId == null);
    const okNganHang = cdNganHang === 'giu' || (cdNganHang === 'dat' ? t.bankId === Number(nganHangMoi) : t.bankId == null);
    return okTk && okNganh && okDoiTac && okNganHang;
  }

  async function chay(): Promise<void> {
    if (!chayDuoc) return;
    setDang(true);
    setTienDo(0);
    const thanhCongDs: string[] = [];
    const boQua: { tid: string; lyDo: string }[] = [];
    const hong: { tid: string; lyDo: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i]!;
      setTienDo(i + 1);
      // (a) Lớp nghiệp vụ BẮT BUỘC có ngân hàng / đối tác / tên HKD. TID nào đang thiếu thì KHÔNG im lặng bỏ:
      //     báo HỎNG kèm lý do để Admin Demo biết mà mở "Sửa" từng cái điền trước.
      const bankIdCuoi = cdNganHang === 'dat' ? Number(nganHangMoi) : t.bankId;
      const partnerIdCuoi = cdDoiTac === 'dat' ? Number(doiTacMoi) : t.partnerId;
      const hkdCuoi = (t.hkdName ?? '').trim();
      const thieu = [...(!bankIdCuoi ? ['Ngân hàng'] : []), ...(!partnerIdCuoi ? ['Đối tác'] : []), ...(!hkdCuoi ? ['Tên HKD'] : [])];
      if (thieu.length > 0) {
        hong.push({ tid: t.tid, lyDo: `TID đang thiếu ${thieu.join(' / ')} — mở nút "Sửa" của riêng TID này điền trước rồi chạy lại.` });
        continue;
      }
      // (b) Đã đúng sẵn ⇒ bỏ qua, KHÔNG gọi máy chủ (đỡ đốt lượt ghi + đỡ sinh nhật ký rỗng).
      if (daDungHet(t)) {
        boQua.push({ tid: t.tid, lyDo: 'đã sẵn đúng giá trị' });
        continue;
      }
      // (c) Thân gửi lên: 4 khoá BẮT BUỘC luôn gửi (route map thiếu-khoá → '' / 0 ⇒ máy chủ báo lỗi validate),
      //     các khoá còn lại CHỈ gửi khi người dùng chọn "Đặt thành…" / "Xoá trống". Không gửi = giữ nguyên.
      const input: ConfigTidInput = {
        tid: t.tid,
        bankId: bankIdCuoi as number,
        partnerId: partnerIdCuoi as number,
        hkdName: hkdCuoi,
        expectedUpdatedAt: t.updatedAt, // optimistic-lock — echo Y NGUYÊN mốc API list vừa trả
        ...(cdTk === 'dat' ? { receiveAccountId: Number(tkMoi) } : cdTk === 'xoa' ? { receiveAccountId: null } : {}),
        ...(cdNganh === 'dat' ? { industryId: Number(nganhMoi) } : cdNganh === 'xoa' ? { industryId: null } : {})
      };
      try {
        const res = await window.api.tidConfigUpdate(t.id, input);
        if (res?.ok) thanhCongDs.push(t.tid);
        else if (isStaleWrite(res)) hong.push({ tid: t.tid, lyDo: (res.message ?? STALE_TITLE) + ' — bấm "Làm mới" rồi chọn lại.' });
        else hong.push({ tid: t.tid, lyDo: res?.message ?? res?.error ?? 'Máy chủ từ chối nhưng KHÔNG nêu lý do.' });
      } catch (e) {
        // R198 — tuyệt đối không nuốt: lỗi ném ra cũng phải thành 1 dòng HỎNG nhìn thấy được.
        hong.push({ tid: t.tid, lyDo: 'Lỗi khi gọi máy chủ: ' + ((e as Error)?.message ?? String(e)) });
      }
    }
    setDang(false);
    setKetQua({ thanhCong: thanhCongDs.length, boQua, hong });
    if (hong.length === 0) toast.success(`Sửa hàng loạt xong: ${thanhCongDs.length} thành công · ${boQua.length} bỏ qua · 0 hỏng`);
    else toast.alert(`${hong.length}/${rows.length} TID KHÔNG sửa được — xem danh sách trong hộp thoại.`, 'Sửa hàng loạt có lỗi');
  }

  const dong = (): void => {
    if (dang) return; // đang chạy dở thì không cho đóng (tránh mất báo cáo 3 con số)
    if (ketQua && ketQua.thanhCong > 0) onDone();
    else onClose();
  };

  return (
    <Modal title={`Sửa hàng loạt — ${rows.length} TID đã chọn`} onClose={dong}>
      {!ketQua && (
        <>
          <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Sẽ áp dụng cho <b>{rows.length} TID</b>:{' '}
            <span className="font-mono">{rows.slice(0, 12).map((t) => t.tid).join(', ')}</span>
            {rows.length > 12 && <> … và {rows.length - 12} TID nữa</>}
          </div>
          <div className="grid gap-3">
            <OSuaHangLoat khoa="tk" nhan="Tài khoản nhận tiền" moTa="tài khoản nhận tiền" cheDo={cdTk} doiCheDo={setCdTk} dang={dang}>
              <select className={inputCls + ' w-full'} data-kiem="chon-tk-nhan" value={tkMoi} onChange={(e) => setTkMoi(e.target.value)}>
                <option value="">— Chọn tài khoản nhận tiền —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.accountNumber} · {a.accountName}
                    {a.owyType === 'INVESTOR' ? ` · NĐT: ${a.owyName ?? ''}` : a.owyType === 'CUSTOMER' ? ` · KH: ${a.owyName ?? ''}` : ' · Nội bộ'}
                  </option>
                ))}
              </select>
            </OSuaHangLoat>

            <OSuaHangLoat khoa="nganh" nhan="Ngành nghề" moTa="ngành nghề" cheDo={cdNganh} doiCheDo={setCdNganh} dang={dang}>
              <select className={inputCls + ' w-full'} data-kiem="chon-nganh" value={nganhMoi} onChange={(e) => setNganhMoi(e.target.value)}>
                <option value="">— Chọn ngành nghề —</option>
                {(refs?.industries ?? []).map((i) => (
                  <option key={i.id} value={i.id}>{i.code} · {i.name}</option>
                ))}
              </select>
            </OSuaHangLoat>

            <OSuaHangLoat
              khoa="doitac"
              nhan="Đối tác"
              moTa="đối tác"
              cheDo={cdDoiTac}
              doiCheDo={setCdDoiTac}
              khoaXoa="Đối tác là trường BẮT BUỘC của TID — không thể xoá trống. Chỉ có thể đặt sang đối tác khác."
              dang={dang}
            >
              <select
                className={inputCls + ' w-full'}
                data-kiem="chon-doi-tac"
                value={doiTacMoi}
                onChange={(e) => { setDoiTacMoi(e.target.value); setNganHangMoi(''); }}
              >
                <option value="">— Chọn đối tác —</option>
                {(refs?.partners ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                ))}
              </select>
            </OSuaHangLoat>

            <OSuaHangLoat
              khoa="nganhang"
              nhan="Ngân hàng"
              moTa="ngân hàng"
              cheDo={cdNganHang}
              doiCheDo={setCdNganHang}
              khoaXoa="Ngân hàng là trường BẮT BUỘC của TID — không thể xoá trống. Chỉ có thể đặt sang ngân hàng khác."
              dang={dang}
            >
              <select className={inputCls + ' w-full'} data-kiem="chon-ngan-hang" value={nganHangMoi} onChange={(e) => setNganHangMoi(e.target.value)}>
                <option value="">— Chọn ngân hàng —</option>
                {nganHangTheoDoiTac.map((b) => (
                  <option key={b.id} value={b.id}>{b.code}</option>
                ))}
              </select>
            </OSuaHangLoat>
          </div>

          {thieuGiaTri.length > 0 && (
            <p className="mt-3 text-xs font-medium text-rose-600">Chưa chọn giá trị cho: {thieuGiaTri.join(', ')}.</p>
          )}
          {dangSua.length === 0 && (
            <p className="mt-3 text-xs text-slate-500">Mọi trường đang để <b>Giữ nguyên</b> — chọn ít nhất 1 trường để sửa.</p>
          )}

          {/* [Admin Demo 15/11 "sửa hàng loạt chỉ áp dụng được 1"] — soi nhật ký thì SERVER ĐÃ SỬA ĐỦ 9/9 TID,
              nhưng mỗi dòng mất ~5 giây (gần 1,5 phút cho 9 dòng) mà tiến độ chỉ là 1 dòng chữ xám bé xíu ⇒
              nhìn vào tưởng chỉ 1 dòng ăn. Nay: THANH TIẾN ĐỘ to, nói rõ còn bao nhiêu và CẤM đóng giữa chừng. */}
          {dang && (
            <div className="mt-5 rounded-lg border border-brand/40 bg-brand-tint px-4 py-3" data-kiem="tien-do">
              <div className="flex items-center justify-between text-sm font-semibold text-brand">
                <span>Đang sửa {tienDo}/{rows.length} TID — đừng đóng cửa sổ</span>
                <span className="tabular-nums">{Math.round((tienDo / Math.max(1, rows.length)) * 100)}%</span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white">
                <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.round((tienDo / Math.max(1, rows.length)) * 100)}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-brand-deep">Mỗi TID mất vài giây (máy chủ tính lại doanh thu theo phí mới) — chạy xong sẽ hiện bảng kết quả.</p>
            </div>
          )}
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="neutral" onClick={dong} disabled={dang}>Hủy</Button>
            <Button
              variant="confirm"
              data-kiem="nut-chay-hang-loat"
              onClick={() => void chay()}
              disabled={!chayDuoc || dang}
              icon={dang ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
            >
              Sửa {rows.length} TID
            </Button>
          </div>
        </>
      )}

      {ketQua && (
        <div data-kiem="ket-qua-hang-loat">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-center">
              <div className="text-2xl font-bold text-emerald-700" data-kiem="so-thanh-cong">{ketQua.thanhCong}</div>
              <div className="text-xs font-medium text-emerald-700">Thành công</div>
            </div>
            <div className="rounded-xl border border-slate-300 bg-slate-50 p-3 text-center">
              <div className="text-2xl font-bold text-slate-600" data-kiem="so-bo-qua">{ketQua.boQua.length}</div>
              <div className="text-xs font-medium text-slate-600">Bỏ qua</div>
            </div>
            <div className={'rounded-xl border p-3 text-center ' + (ketQua.hong.length > 0 ? 'border-rose-400 bg-rose-50' : 'border-slate-300 bg-slate-50')}>
              <div className={'text-2xl font-bold ' + (ketQua.hong.length > 0 ? 'text-rose-700' : 'text-slate-600')} data-kiem="so-hong">{ketQua.hong.length}</div>
              <div className={'text-xs font-medium ' + (ketQua.hong.length > 0 ? 'text-rose-700' : 'text-slate-600')}>HỎNG</div>
            </div>
          </div>

          {ketQua.hong.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-sm font-semibold text-rose-700">TID KHÔNG sửa được ({ketQua.hong.length}):</p>
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-rose-200 bg-rose-50/50 p-2 text-xs">
                {ketQua.hong.map((x) => (
                  <li key={x.tid} className="text-rose-800"><b className="font-mono">{x.tid}</b> — {x.lyDo}</li>
                ))}
              </ul>
            </div>
          )}
          {ketQua.boQua.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-sm font-semibold text-slate-600">TID bỏ qua ({ketQua.boQua.length}):</p>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line bg-slate-50 p-2 text-xs">
                {ketQua.boQua.map((x) => (
                  <li key={x.tid} className="text-slate-600"><b className="font-mono">{x.tid}</b> — {x.lyDo}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <Button variant="confirm" data-kiem="nut-dong-ket-qua" onClick={dong}>Đóng</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Admin Demo 3/9 — SỬA LỖI NHẬP chuỗi TID (đổi định danh). Server cascade nguyên tử timeline/gắn-máy/current_tid/
 *  chứng từ theo CHUỖI; doanh số lô + nối nhóm join bằng id SỐ nên tự đúng. Gate MẬT KHẨU (thao tác nhạy cảm như
 *  tiền). Type-to-confirm: phải gõ lại đúng chuỗi mới để chống gõ nhầm. */
function TidRenameModal({ tid, onClose, onDone }: { tid: TidDto; onClose: () => void; onDone: () => void }): JSX.Element {
  const toast = useToast();
  const [newTid, setNewTid] = useState('');
  const [confirmTid, setConfirmTid] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = newTid.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== tid.tid && trimmed === confirmTid.trim() && password.length > 0;

  async function submit(): Promise<void> {
    if (trimmed === tid.tid) return toast.alert('Chuỗi TID mới trùng chuỗi cũ.', 'Không có gì để sửa');
    if (trimmed !== confirmTid.trim()) return toast.alert('2 ô chuỗi TID mới chưa khớp.', 'Xác nhận lại');
    if (!password) return toast.alert('Nhập mật khẩu để xác nhận.', 'Cần mật khẩu');
    setBusy(true);
    const res = await window.api.tidRename(tid.id, trimmed, password, tid.updatedAt);
    setBusy(false);
    if (res.ok) {
      const c = res.cascade;
      const detail = c ? ` (timeline ${c.assetEvents} · gắn máy ${c.bindings} · máy ${c.posDevices} · cọc ${c.deposits} · bán ${c.sales} · xuất kho ${c.exportLines})` : '';
      toast.success(`Đã sửa TID ${tid.tid} → ${trimmed}${detail}`);
      onDone();
    } else if (res.error === 'WRONG_PASSWORD') {
      toast.alert('Mật khẩu xác nhận không đúng.', 'Sai mật khẩu');
    } else if (isStaleWrite(res)) {
      toast.alert(res.message ?? 'TID đã được người khác cập nhật, mở lại rồi thử lại.', STALE_TITLE);
      onDone();
    } else {
      baoLoi(toast.alert, res, 'Sửa chuỗi TID');
    }
  }

  return (
    <Modal title={`Sửa lỗi nhập chuỗi TID`} onClose={onClose}>
      <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
        Đổi ĐỊNH DANH chuỗi TID. Hệ thống tự cập nhật đồng loạt: timeline vòng đời, gắn máy POS, TID hiện tại của máy,
        nhãn TID trên chứng từ cọc/bán/xuất kho. Doanh số theo lô + nối nhóm chat tự khớp (không đổi). Chỉ dùng khi
        chuỗi TID <b>nhập sai</b> — không dùng để cấp TID mới.
      </div>
      <div className="grid gap-3">
        <Field label="Chuỗi TID hiện tại (sai)">
          <input className={inputCls + ' font-mono bg-slate-50 text-slate-500'} value={tid.tid} readOnly />
        </Field>
        <Field label="Chuỗi TID ĐÚNG (mới)" required>
          <input className={inputCls + ' font-mono'} value={newTid} onChange={(e) => setNewTid(e.target.value)} autoFocus placeholder="vd 53590003" />
        </Field>
        <Field label="Gõ lại chuỗi TID mới để xác nhận" required>
          <input className={inputCls + ' font-mono'} value={confirmTid} onChange={(e) => setConfirmTid(e.target.value)} placeholder="gõ lại y hệt" />
        </Field>
        <Field label="Mật khẩu xác nhận" required>
          <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="soft" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={submit} disabled={busy || !canSubmit} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Sửa chuỗi TID</Button>
      </div>
    </Modal>
  );
}

/** Bán TID rời (chưa gắn máy). Form tiền + mật khẩu xác nhận. Không có trường kho (TID không phải thiết bị vật lý). */
function SellTidModal({ tid, onClose, onDone }: { tid: TidDto; onClose: () => void; onDone: () => void }): JSX.Element {
  const toast = useToast();
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [funds, setFunds] = useState<FundDto[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [paidNow, setPaidNow] = useState('');
  const [fundId, setFundId] = useState('');
  const [method, setMethod] = useState('CASH');
  const [occurredAt, setOccurredAt] = useState('');
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.customerList({}).then((r) => r.ok && r.data && setCustomers(r.data));
    window.api.fundList({}).then((r) => r.ok && r.data && setFunds(r.data.filter((f) => f.active)));
  }, []);

  const price = Number(salePrice) || 0;
  const paid = Number(paidNow) || 0;
  const remaining = Math.max(0, price - paid);

  async function submit(): Promise<void> {
    if (!customerId) return toast.alert('Phải chọn khách mua.', 'Thiếu thông tin');
    if (!(price > 0)) return toast.alert('Giá bán phải > 0.', 'Số tiền không hợp lệ');
    if (paid < 0 || paid > price) return toast.alert('Số tiền thu phải từ 0 đến giá bán.', 'Số tiền không hợp lệ');
    if (paid > 0 && !fundId) return toast.alert('Có thu tiền thì phải chọn quỹ nhận.', 'Thiếu quỹ');
    if (!password) return toast.alert('Nhập mật khẩu để xác nhận bán TID.', 'Cần mật khẩu');
    setBusy(true);
    const res = await window.api.deviceSellTid(tid.tid, {
      customerId: Number(customerId), salePrice: price, paidNow: paid,
      fundId: fundId ? Number(fundId) : null, method,
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null, note: note || null
    }, password);
    setBusy(false);
    if (res.ok) { toast.success(`Đã bán TID ${tid.tid}`); onDone(); }
    else baoLoi(toast.alert, res, 'Bán TID');
  }

  return (
    <Modal title={`Bán TID ${tid.tid}`} onClose={onClose}>
      <div className="mb-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
        TID sẽ chuyển <b>ĐÃ BÁN</b> sang khách mua. Doanh thu ghi nhận đủ giá ngay; phần chưa thu thành công nợ mua thiết bị.
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Khách mua" required>
          <CustomerPicker customers={customers} value={customerId} onChange={setCustomerId} />
        </Field>
        <Field label="Giá bán (VND)" required>
          <input className={inputCls + ' text-right tabular-nums'} inputMode="numeric" value={groupDigits(salePrice)} onChange={(e) => setSalePrice(e.target.value.replace(/[^\d]/g, ''))} placeholder="0" />
        </Field>
        <Field label="Thu ngay (VND)" hint={`Còn nợ: ${groupDigits(String(remaining))}`}>
          <input className={inputCls + ' text-right tabular-nums'} inputMode="numeric" value={groupDigits(paidNow)} onChange={(e) => setPaidNow(e.target.value.replace(/[^\d]/g, ''))} placeholder="0" />
        </Field>
        <Field label="Quỹ nhận tiền" hint={paid > 0 ? 'Bắt buộc khi có thu' : 'Không thu thì bỏ trống'}>
          <select className={inputCls} value={fundId} onChange={(e) => setFundId(e.target.value)}>
            <option value="">— Chọn quỹ —</option>
            {funds.map((f) => <option key={f.id} value={f.id}>{f.code} · {f.name}</option>)}
          </select>
        </Field>
        <Field label="Hình thức">
          <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="CASH">Tiền mặt</option>
            <option value="CK">Chuyển khoản</option>
          </select>
        </Field>
        <Field label="Thời gian bán" hint="Bỏ trống = hiện tại">
          <input type="datetime-local" className={inputCls} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
        <Field label="Ghi chú"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Mật khẩu xác nhận" required><input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="soft" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={submit} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Bán TID</Button>
      </div>
    </Modal>
  );
}

// ── #13 Xếp hạng doanh số theo TID — kỳ mặc định tháng hiện tại + lọc kỳ (tháng khác / from–to) ──
/** yyyy-mm → { from: 'yyyy-mm-01', to: 'yyyy-mm-<lastDay>' }. */
function monthBounds(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate(); // ngày 0 của tháng sau = ngày cuối tháng này
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}
function currentMonthStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

function RevenueRankingTab(): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<TidRevenueRankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(currentMonthStr()); // ô chọn tháng (hiển thị + nhanh)
  const [from, setFrom] = useState(''); // kỳ tùy chỉnh — rỗng = dùng mặc định (server tính tháng hiện tại)
  const [to, setTo] = useState('');

  async function load(f?: string, t?: string): Promise<void> {
    setLoading(true);
    const res = await window.api.tidRevenueRanking({ from: f || undefined, to: t || undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
    setLoading(false);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyMonth(ym: string): void {
    setMonth(ym);
    if (!ym) return;
    const b = monthBounds(ym);
    setFrom('');
    setTo('');
    void load(b.from, b.to);
  }
  function reset(): void {
    setMonth(currentMonthStr());
    setFrom('');
    setTo('');
    void load();
  }
  const total = rows.reduce((s, r) => s + r.revenue, 0);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Xếp hạng doanh số theo TID {rows.length > 0 && <span className="ml-1 text-slate-500">· {rows.length} TID · tổng {money(total)}</span>}
        </div>
        <Button data-nut="excel"
          variant="confirm"
          icon={<Download className="h-4 w-4" />}
          onClick={() => exportCsv('xep_hang_doanh_so_tid', ['Hạng', 'Chuỗi TID', 'HKD', 'Khách', 'Ngành nghề', 'Doanh số', 'Hoạt động'], rows.map((r) => [r.rank, r.tid, r.hkdName ?? '', r.customerName ?? '', r.industryName ?? '', Number(r.revenue), r.active ? 'Đang hoạt động' : 'Ngừng']), undefined, undefined, { cotTien: ['Doanh số'] })} /* [B299] tiền = SỐ, không phải chuỗi đã format */
        >
          Xuất Excel
        </Button>
      </div>

      {/* Thanh lọc: 1 HÀNG, chữ nhỏ, nút "Lọc" căn MÉP PHẢI (mẫu chốt §4). */}
      <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto text-xs text-slate-500">
        <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400">Kỳ</span>
        <input type="month" className={inputCls + ' shrink-0 text-xs'} value={month} onChange={(e) => applyMonth(e.target.value)} />
        <span className="shrink-0 text-xs">hoặc từ</span>
        <input type="date" className={inputCls + ' shrink-0 text-xs'} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="shrink-0 text-xs">đến</span>
        <input type="date" className={inputCls + ' shrink-0 text-xs'} value={to} onChange={(e) => setTo(e.target.value)} />
        <div className="min-w-[8px] flex-1" />
        <Button data-nut="loc" variant="confirm" onClick={() => load(from, to)}>
          Lọc
        </Button>
        <Button variant="soft" data-nut="xoaloc" onClick={reset} title="Về kỳ mặc định (tháng hiện tại)" icon={<FilterX className="h-4 w-4" />}>
          Xóa lọc
        </Button>
        <Button variant="soft" data-nut="lammoi" onClick={() => void load(from, to)} title="Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc)" icon={<RefreshCw className="h-4 w-4" />}>
          Làm mới
        </Button>
      </div>

      {/* StatBar tab "Xếp hạng doanh số" — đếm CLIENT từ kết quả kỳ đang xem. */}
      <StatBar
        items={[
          { label: 'Tổng TID', value: rows.length, tone: 'bg-brand-tint text-brand' },
          { label: 'Đang hoạt động', value: rows.filter((r) => r.active).length, tone: 'bg-emerald-50 text-emerald-600' },
          { label: 'Ngừng', value: rows.filter((r) => !r.active).length, tone: 'bg-slate-100 text-slate-500' },
          { label: 'Tổng doanh số', value: money(total), tone: 'bg-brand-tint text-brand' }
        ]}
      />

      <KhungBang className="list-scroll bg-white shadow-sm">
        <table className="w-full min-w-[1180px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan + ' w-[70px]'}>Hạng</th>
              <th className={thChuan + ' w-[130px]'}>Chuỗi TID</th>
              <th className={thChuan + ' w-[240px]'}>HKD</th>
              <th className={thChuan + ' w-[170px]'}>Khách</th>
              <th className={thChuan}>Ngành nghề</th>
              <th className={thChuan + ' w-[160px]'}>Doanh số</th>
              <th className={thChuan + ' w-[150px]'}>Hoạt động</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className={tdTrong}>
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className={tdTrong}>
                  <Trophy className="mx-auto mb-2 h-6 w-6" />
                  Chưa có giao dịch nào trong kỳ này.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((r, i) => (
                <tr key={r.tidId} className={trChuan(i)}>
                  <td className={tdPhanTram + ' font-semibold text-slate-700'}>{r.rank}</td>
                  <td className={tdChuan + ' text-center font-mono font-semibold tabular-nums text-slate-700'}>{r.tid}</td>
                  <td className={tdChuan + ' max-w-[240px] truncate text-slate-600'} title={r.hkdName ?? ''}>{r.hkdName ?? '—'}</td>
                  <td className={tdChuan + ' max-w-[170px] truncate text-center text-slate-600'} title={r.customerName ?? ''}>{r.customerName ?? '—'}</td>
                  <td className={tdChuan + ' text-center text-slate-600'}>{r.industryName ?? '—'}</td>
                  {/* Cột TIỀN: tdTien — bỏ "đ" trong bảng, không in đậm, cùng cỡ chữ 12px. */}
                  <td className={tdTien}>{money(r.revenue).replace('đ', '')}</td>
                  <td className={tdChuan + ' text-center'}>
                    {r.active ? (
                      <span className="rounded bg-success/15 px-1.5 py-0.5 font-medium text-success">Đang hoạt động</span>
                    ) : (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">Ngừng</span>
                    )}
                  </td>
                </tr>
              ))}
            <HangDem soCot={7} />
          </tbody>
          {/* Hàng TỔNG ghim đáy — `total` cộng từ CHÍNH mảng `rows` của kỳ đang xem. */}
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={5}>TỔNG {rows.length} TID</td>
              <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{money(total).replace('đ', '')}</td>
              <td className={tdTongChuan} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>
    </div>
  );
}

function AssignCell({ t }: { t: TidDto }): JSX.Element {
  if (t.deviceAssigned) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-brand-tint px-1.5 py-0.5 text-xs font-medium text-brand">Đã gán</span>
        {t.posSerial && <span className="font-mono text-xs text-slate-500 whitespace-nowrap">{t.posSerial}</span>}
      </div>
    );
  }
  if (t.customerDeviceSerial) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">Máy khách</span>
        <span className="font-mono text-xs text-slate-500 whitespace-nowrap">{t.customerDeviceSerial}</span>
      </div>
    );
  }
  return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">Chưa gán</span>;
}

function DeliverCell({ t }: { t: TidDto }): JSX.Element {
  if (t.delivered) {
    // [Admin Demo 15/11] Cột này là TRẠNG THÁI, không phải tên: trước đây hiện tên khách nên trùng y hệt cột
    // ĐẠI LÝ ĐANG SỬ DỤNG ngay bên cạnh (nhìn ảnh mới thấy). Nay chỉ "Đã giao · <ngày>"; TÊN đứng riêng 1 cột.
    const name = 'Đã giao';
    // P4 — TID đã giao cho 1 khách cụ thể nhưng cấu hình DỞ → cảnh báo (chỉ khi delivered & có khách).
    // `=== false` (không phải `!field`): chỉ cảnh báo khi API TRẢ RÕ false — tránh hiện nhầm badge khi desktop mới
    // gặp API cũ chưa có field (undefined) trong lúc rollout (audit 20/8).
    const incomplete = t.customerId != null && (t.customerHasActiveChatGroup === false || t.hasActualSellFee === false);
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-success/15 px-1.5 py-0.5 text-xs font-medium text-success whitespace-nowrap">{name}</span>
          {t.deliveredAt && <span className="text-xs text-slate-500 whitespace-nowrap">{fmtDate(t.deliveredAt)}</span>}
        </div>
        {incomplete && (
          <div className="flex flex-wrap items-center gap-1">
            {t.customerHasActiveChatGroup === false && (
              <span title="Khách chưa gắn nhóm chat — bill đại lý sẽ báo chưa liên kết" className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning whitespace-nowrap">⚠ chưa liên kết đại lý</span>
            )}
            {t.hasActualSellFee === false && (
              <span title="TID chưa có giá bán thực tế — bill & doanh số sẽ báo chưa cấu hình giá bán" className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning whitespace-nowrap">⚠ chưa có giá bán</span>
            )}
          </div>
        )}
      </div>
    );
  }
  return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">Chưa giao</span>;
}

// ── Phòng chat SigMa (Admin Demo 3/8) — dropdown gợi ý TỰ ĐỘNG qua Customer.agentId → ChatRoomMember đang
// hoạt động của Agent đó (tidChatRoomsForCustomer), nhân sự CHỌN 1 trong danh sách khi giao/gán TID cho 1
// khách hàng cụ thể — KHÔNG gõ tay ID phòng. Dùng CHUNG ở cả 2 chỗ chọn khách (Thêm TID + Gán/Giao TID) —
// đúng nguyên tắc "field xuất hiện ở TẤT CẢ các điểm mà TID có thể gắn với 1 customerId cụ thể".
function ChatRoomField({ customerId, value, onChange }: { customerId: string; value: string; onChange: (v: string) => void }): JSX.Element | null {
  const [rooms, setRooms] = useState<ChatRoomOptionDto[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setRooms([]);
    setLoaded(false);
    onChange(''); // đổi khách → bỏ chọn phòng cũ (tránh gắn nhầm phòng của khách trước đó)
    if (!customerId) return;
    let alive = true;
    window.api.tidChatRoomsForCustomer(Number(customerId)).then((r) => {
      if (!alive) return;
      setRooms(r.ok && r.data ? r.data : []);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  if (!customerId) return null;
  return (
    <Field
      label="Phòng chat SigMa"
      hint={rooms.length > 0 ? 'Tùy chọn — gắn để tính "Doanh số theo nhóm chat"' : loaded ? 'Khách này chưa có phòng chat SigMa nào để gắn' : 'Đang tải danh sách phòng…'}
    >
      <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={rooms.length === 0}>
        <option value="">— Không gắn phòng chat —</option>
        {rooms.map((r) => (
          <option key={r.roomId} value={r.roomId}>{r.displayName}</option>
        ))}
      </select>
    </Field>
  );
}

// ── Form Thêm TID — chuỗi phụ thuộc HKD → đối tác → ngân hàng (PartnerBank) + chế độ gán/giao ──
function TidCreateForm({ canOps, onClose, onSaved }: { canOps: boolean; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [refs, setRefs] = useState<TidRefs | null>(null);
  const [devices, setDevices] = useState<PosDto[]>([]);
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [busy, setBusy] = useState(false);

  const [dossierId, setDossierId] = useState('');
  const [hkdName, setHkdName] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [bankId, setBankId] = useState('');
  const [industryId, setIndustryId] = useState(''); // LANE A (#11) — ngành nghề BẮT BUỘC
  const [tid, setTid] = useState('');
  const [mid, setMid] = useState('');
  const [issuedAt, setIssuedAt] = useState('');
  const [note, setNote] = useState('');
  const [receiveAccountId, setReceiveAccountId] = useState(''); // Phase B — TK nhận tiền (suy uỷ)
  const [investFeePct, setInvestFeePct] = useState(''); // %phí đầu tư override theo TID (chỉ khi uỷ=NĐT)
  const [accounts, setAccounts] = useState<RcvAccountDto[]>([]);
  // chế độ gán: 'none' (chưa gán) | 'pos' (máy ta) | 'customer' (máy khách)
  const [assignMode, setAssignMode] = useState<'none' | 'pos' | 'customer'>('none');
  const [posSerial, setPosSerial] = useState('');
  const [customerDeviceSerial, setCustomerDeviceSerial] = useState('');
  const [assignCustomerId, setAssignCustomerId] = useState('');
  const [assignChatRoomId, setAssignChatRoomId] = useState(''); // Phòng chat SigMa (Admin Demo 3/8)
  // giao khách
  const [deliverNow, setDeliverNow] = useState(false);
  const [deliverCustomerId, setDeliverCustomerId] = useState('');
  const [deliverChatRoomId, setDeliverChatRoomId] = useState(''); // Phòng chat SigMa (Admin Demo 3/8)
  const [deliveredAt, setDeliveredAt] = useState('');
  // PHA 2 (2A) — giá bán thực tế thỏa thuận khi TẠO+GIAO ngay (TID chưa tồn tại → nguồn bankPartner). Ref = snapshot mới nhất.
  const sellFeeRef = useRef<SellFeeSnapshot | null>(null);

  useEffect(() => {
    window.api.tidRefs().then((r) => r.ok && r.data && setRefs(r.data));
    window.api.rcvAccountList({}).then((r) => r.ok && r.data && setAccounts(r.data));
    if (canOps) {
      window.api.posList({}).then((r) => r.ok && r.data && setDevices(r.data));
      window.api.customerList({}).then((r) => r.ok && r.data && setCustomers(r.data));
    }
  }, [canOps]);

  // Phase B — chỉ hiện ô "% phí đầu tư theo TID" khi TK nhận tiền chọn có UỶ = Nhà đầu tư.
  const selectedAcc = accounts.find((a) => String(a.id) === receiveAccountId);
  const owyInvestor = selectedAcc?.owyType === 'INVESTOR';

  // Quy tắc ưu tiên ngân hàng theo PartnerBank (Admin Demo KHÓA): 1 → tự chọn, ≥2 → dropdown, 0 → cảnh báo.
  const linkedBankIds = partnerId && refs ? refs.partnerBanks[Number(partnerId)] ?? [] : [];
  const linkedBanks = refs ? refs.banks.filter((b) => linkedBankIds.includes(b.id)) : [];
  useEffect(() => {
    if (linkedBanks.length === 1) setBankId(String(linkedBanks[0].id));
    else setBankId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);

  function onPickDossier(id: string): void {
    setDossierId(id);
    const d = refs?.dossiers.find((x) => String(x.id) === id);
    if (d) setHkdName(d.hkdName);
  }

  async function save(): Promise<void> {
    if (!tid.trim()) return toast.alert('Chuỗi TID bắt buộc.', 'Thiếu thông tin');
    if (!partnerId) return toast.alert('Vui lòng chọn đối tác.', 'Thiếu thông tin');
    if (!bankId) return toast.alert('Vui lòng chọn ngân hàng.', 'Thiếu thông tin');
    if (!industryId) return toast.alert('Phải chọn ngành nghề khi tạo TID.', 'Thiếu thông tin');
    if (!hkdName.trim()) return toast.alert('Tên Hộ Kinh Doanh bắt buộc (chọn HKD hoặc nhập tay).', 'Thiếu thông tin');
    if (assignMode === 'pos') {
      if (!posSerial) return toast.alert('Chọn máy POS để gán.', 'Thiếu thông tin');
      if (!assignCustomerId) return toast.alert('Chọn khách hàng nhận máy.', 'Thiếu thông tin');
    }
    const wantDeliver = deliverNow;
    const deliverCust = assignMode === 'pos' ? assignCustomerId : deliverCustomerId;
    if (wantDeliver && !deliverCust) return toast.alert('Chọn khách hàng để đánh dấu đã giao.', 'Thiếu thông tin');

    // PHA 2 (2A) — giá bán thực tế: CHỈ gửi khi giao-ngay + user THỰC SỰ nhập ≥1 giá custom (anyCustom), KHÔNG chỉ
    // (ready). Tất cả niêm yết = KHÔNG gửi gì (khớp gate assign/deliver modal — tránh gửi sellFees toàn null). Route
    // đọc defaultFeeTypeId + sellFees ở TOP-LEVEL (không trong deliver).
    const sfSnap = sellFeeRef.current;
    // VALIDATE client TRƯỚC submit: bán < phí mua niêm yết / phí mua null / ngoài 0–100 → CHẶN (editor đã hiện đỏ
    // inline; đây là gate cuối kèm toast). Chỉ khi có giao (editor mới hiển thị).
    if (wantDeliver && sfSnap && sfSnap.invalid) return toast.alert(sfSnap.invalidReason ?? 'Giá bán thực tế không hợp lệ.', 'Giá bán thực tế không hợp lệ');
    // [15/11] bỏ điều kiện anyCustom: không nhập cũng gửi, vì payload nay mang GIÁ NIÊM YẾT làm nền.
    const sendSellFee = !!(wantDeliver && sfSnap && sfSnap.ready && sfSnap.sellFees.length > 0);
    const sellFeeFields = sendSellFee
      ? { defaultFeeTypeId: sfSnap!.defaultFeeTypeId ?? undefined, sellFees: sfSnap!.sellFees }
      : {};

    const input: CreateTidInput = {
      tid: tid.trim(),
      mid: mid.trim() || null,
      dossierId: dossierId ? Number(dossierId) : null,
      industryId: Number(industryId),
      hkdName: hkdName.trim(),
      partnerId: Number(partnerId),
      bankId: Number(bankId),
      issuedAt: issuedAt || null,
      note: note.trim() || null,
      receiveAccountId: receiveAccountId ? Number(receiveAccountId) : null,
      investFeeMilli: owyInvestor && investFeePct.trim() !== '' ? Math.round(Number(investFeePct) * 1000) : null,
      customerDeviceSerial: assignMode === 'customer' ? customerDeviceSerial.trim() || null : null,
      // Phòng chat SigMa (Admin Demo 3/8): assignMode='pos' dùng CHUNG 1 dropdown "Khách hàng nhận" cho cả
      // assign lẫn deliver (deliverCust = assignCustomerId khi đó) → dùng chung luôn phòng chat đã chọn.
      assign: assignMode === 'pos' ? { posSerial, customerId: Number(assignCustomerId), chatRoomId: assignChatRoomId || null } : undefined,
      deliver: wantDeliver
        ? { deliveredAt: deliveredAt ? new Date(deliveredAt).toISOString() : null, customerId: Number(deliverCust), toAgentId: null, chatRoomId: (assignMode === 'pos' ? assignChatRoomId : deliverChatRoomId) || null }
        : undefined,
      ...sellFeeFields
    };
    setBusy(true);
    const res = await window.api.tidCreate(input);
    setBusy(false);
    if (res.ok) {
      toast.success(`Đã thêm TID ${tid}`);
      if (res.warning) toast.alert(res.warning, 'Đã tạo — lưu ý giá bán');
      onSaved();
    } else {
      baoLoi(toast.alert, res, 'Thêm TID');
    }
  }

  const inStock = devices.filter((d) => d.status === 'IN_STOCK');
  // Danh sách cho ô chọn máy POS dạng BẢNG (serial · dòng máy · app · kho) — Admin Demo 16/11.
  const dsMayPos: MayPos[] = inStock.map((d) => ({
    serial: d.serial,
    dongMay: d.posModelName ?? d.model ?? null,
    app: d.bankCode ?? d.bank ?? null,
    kho: d.warehouseName ?? d.warehouseLoc ?? null
  }));

  return (
    <Modal title="Thêm TID mới" onClose={onClose}>
      {!refs && (
        <div className="py-6 text-center text-slate-400">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      )}
      {refs && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Hộ Kinh Doanh (HKD)" hint="Chọn để tự điền tên + gắn hồ sơ">
              <select className={inputCls} value={dossierId} onChange={(e) => onPickDossier(e.target.value)} autoFocus>
                <option value="">— Chọn HKD —</option>
                {refs.dossiers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hkdName}
                    {d.ownerName ? ` · ${d.ownerName}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tên Hộ Kinh Doanh" required hint="Tự điền từ HKD, có thể sửa">
              <input className={inputCls} value={hkdName} onChange={(e) => setHkdName(e.target.value)} />
            </Field>
            <Field label="Đối tác" required>
              <select className={inputCls} value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                <option value="">— Chọn đối tác —</option>
                {refs.partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ngân hàng" required hint="Lọc theo liên kết đối tác ↔ ngân hàng">
              {partnerId && linkedBanks.length === 0 ? (
                <div className="rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs text-slate-600">Đối tác này chưa liên kết ngân hàng nào (cấu hình ở Cấu hình ngân hàng → Đối tác).</div>
              ) : (
                <PickerGoiY
                  items={(partnerId ? linkedBanks : refs.banks).map((b) => ({ value: String(b.id), nhan: `${b.code}` }))}
                  value={bankId}
                  onChange={setBankId}
                  disabled={linkedBanks.length === 1}
                  placeholder="Gõ mã hoặc tên ngân hàng…"
                  dataKiem="o-chon-ngan-hang"
                />
              )}
            </Field>
            <Field label="Ngành nghề" required hint="Bắt buộc — theo ĐKKD của HKD">
              <select className={inputCls} value={industryId} onChange={(e) => setIndustryId(e.target.value)}>
                <option value="">— Chọn ngành nghề —</option>
                {refs.industries.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.code} · {i.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {partnerId && bankId && (
            <div className="mt-3">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Biểu phí (mua / cài máy / bán) của đối tác</div>
              <FeePreview bankId={Number(bankId)} partnerId={Number(partnerId)} />
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-4">
            <Field label="Chuỗi TID" required>
              <input className={inputCls} value={tid} onChange={(e) => setTid(e.target.value)} />
            </Field>
            <Field label="Chuỗi MID">
              <input className={inputCls} value={mid} onChange={(e) => setMid(e.target.value)} />
            </Field>
            <Field label="Ngày cấp TID">
              <input type="date" className={inputCls} value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} />
            </Field>
            <Field label="Tài khoản nhận tiền" hint="TID suy UỶ (Khách/NĐT/Nội bộ) qua tài khoản này">
              <select className={inputCls} value={receiveAccountId} onChange={(e) => setReceiveAccountId(e.target.value)}>
                <option value="">— Không chọn —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}{a.owyType === 'INVESTOR' ? ` · NĐT: ${a.owyName ?? ''}` : a.owyType === 'CUSTOMER' ? ` · KH: ${a.owyName ?? ''}` : ' · Nội bộ'}</option>)}
              </select>
            </Field>
            {owyInvestor && (
              <Field label="% phí đầu tư (theo TID)" hint="Bỏ trống = dùng % mặc định của nhà đầu tư">
                <input className={inputCls + ' text-right tabular-nums'} inputMode="decimal" value={investFeePct} onChange={(e) => setInvestFeePct(e.target.value.replace(/[^\d.]/g, ''))} placeholder="vd 0.1" />
              </Field>
            )}
            <Field label="Ghi chú">
              <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>

          {canOps && (
            <>
              <div className="mt-4 rounded-lg border border-line p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Gán máy POS (tùy chọn)</div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-1.5"><input type="radio" checked={assignMode === 'none'} onChange={() => setAssignMode('none')} /> Chưa gán</label>
                  <label className="flex items-center gap-1.5"><input type="radio" checked={assignMode === 'pos'} onChange={() => setAssignMode('pos')} /> Gắn máy của công ty</label>
                  <label className="flex items-center gap-1.5"><input type="radio" checked={assignMode === 'customer'} onChange={() => setAssignMode('customer')} /> Gắn máy của khách</label>
                </div>
                {assignMode === 'pos' && (
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    <Field label="Máy POS trong kho công ty" required>
                      <PosPicker items={dsMayPos} value={posSerial} onChange={setPosSerial} />
                    </Field>
                    <Field label="Khách hàng nhận" required>
                      <CustomerPicker customers={customers} value={assignCustomerId} onChange={setAssignCustomerId} />
                    </Field>
                    <ChatRoomField customerId={assignCustomerId} value={assignChatRoomId} onChange={setAssignChatRoomId} />
                  </div>
                )}
                {assignMode === 'customer' && (
                  <div className="mt-3">
                    <Field label="Serial máy của khách" hint="Tùy chọn — tra cứu, KHÔNG tạo máy trong kho ta">
                      <input className={inputCls} value={customerDeviceSerial} onChange={(e) => setCustomerDeviceSerial(e.target.value)} />
                    </Field>
                  </div>
                )}
              </div>

              <div className="mt-3 rounded-lg border border-line p-3">
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <input type="checkbox" checked={deliverNow} onChange={(e) => setDeliverNow(e.target.checked)} /> Đánh dấu đã giao cho khách ngay
                </label>
                {deliverNow && (
                  <div className="mt-3 grid grid-cols-3 gap-4">
                    {assignMode !== 'pos' && (
                      <>
                        <Field label="Khách hàng" required>
                          {/* [Admin Demo 15/11] gõ mã hoặc tên để ra gợi ý, không phân biệt hoa/thường, xếp theo MÃ tăng dần. */}
                          <CustomerPicker customers={customers} value={deliverCustomerId} onChange={setDeliverCustomerId} />
                        </Field>
                        <ChatRoomField customerId={deliverCustomerId} value={deliverChatRoomId} onChange={setDeliverChatRoomId} />
                      </>
                    )}
                    {/* assignMode='pos' đã chọn "Khách hàng nhận" + phòng chat ở khối Gán máy POS phía trên — dùng chung, không lặp lại. */}
                    <Field label="Ngày giao" hint="Bỏ trống = hiện tại">
                      <input type="datetime-local" className={inputCls} value={deliveredAt} onChange={(e) => setDeliveredAt(e.target.value)} />
                    </Field>
                  </div>
                )}
                {/* PHA 2 (2A) — giá bán thực tế thỏa thuận khi giao. TID chưa tồn tại → nguồn (ngân hàng × đối tác).
                    Chỉ hiện khi ĐÃ chọn đối tác + ngân hàng + khách nhận (assignMode='pos' dùng "Khách hàng nhận"). */}
                {deliverNow && bankId && partnerId && (assignMode === 'pos' ? assignCustomerId : deliverCustomerId) && (
                  <div className="mt-3">
                    <SellFeeSection bankPartner={{ bankId: Number(bankId), partnerId: Number(partnerId) }} at={deliveredAt ? new Date(deliveredAt).toISOString() : undefined} onChange={(s) => { sellFeeRef.current = s; }} />
                  </div>
                )}
              </div>
            </>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="neutral" onClick={onClose}>Hủy</Button>
            <Button data-nut="them" variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Thêm TID</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// [Admin Demo 4/9] Thêm MÃ QR bán hàng (kind='QR'). QR KHÔNG gắn/giao máy POS (dùng chung, chọn đại lý lúc quét bill) →
// form CHỈ có: Tên HKD, Ngân hàng, Đối tác, Ngành nghề (bắt buộc), TK nhận (suy uỷ NĐT), Mã merchant (tuỳ chọn — thiếu
// thì server tự sinh mã định danh). Không hiện posSerial/gán/giao/mid. Reuse tidRefs + rcvAccountList như TidCreateForm.
function QrCreateForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [refs, setRefs] = useState<TidRefs | null>(null);
  const [accounts, setAccounts] = useState<RcvAccountDto[]>([]);
  const [busy, setBusy] = useState(false);

  const [dossierId, setDossierId] = useState('');
  const [hkdName, setHkdName] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [bankId, setBankId] = useState('');
  const [industryId, setIndustryId] = useState('');
  const [receiveAccountId, setReceiveAccountId] = useState('');
  const [maMerchant, setMaMerchant] = useState('');
  const [note, setNote] = useState('');
  // [Admin Demo 5/9] Tài khoản DigiStore (báo có) cho mã QR — User + Mật khẩu (+ Link tuỳ chọn, mặc định BVBank).
  // Lưu SAU khi tạo mã QR (cần tidId của mã mới) qua qrDigistoreCredSet (mã hoá password ở server). Tuỳ chọn — bỏ
  // trống thì bỏ qua (cấu hình sau ở màn Sửa mã QR). KHÔNG giữ password lâu hơn cần thiết.
  const [dsUser, setDsUser] = useState('');
  const [dsPass, setDsPass] = useState('');
  const [dsBase, setDsBase] = useState('');

  useEffect(() => {
    window.api.tidRefs().then((r) => r.ok && r.data && setRefs(r.data));
    window.api.rcvAccountList({}).then((r) => r.ok && r.data && setAccounts(r.data));
  }, []);

  // Quy tắc ngân hàng theo PartnerBank (KHÓA): 1 → tự chọn, ≥2 → dropdown, 0 → cảnh báo (đồng bộ TidCreateForm).
  const linkedBankIds = partnerId && refs ? refs.partnerBanks[Number(partnerId)] ?? [] : [];
  const linkedBanks = refs ? refs.banks.filter((b) => linkedBankIds.includes(b.id)) : [];
  useEffect(() => {
    if (linkedBanks.length === 1) setBankId(String(linkedBanks[0].id));
    else setBankId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);

  function onPickDossier(id: string): void {
    setDossierId(id);
    const d = refs?.dossiers.find((x) => String(x.id) === id);
    if (d) setHkdName(d.hkdName);
  }

  async function save(): Promise<void> {
    if (!partnerId) return toast.alert('Vui lòng chọn đối tác.', 'Thiếu thông tin');
    if (!bankId) return toast.alert('Vui lòng chọn ngân hàng.', 'Thiếu thông tin');
    if (!industryId) return toast.alert('Phải chọn ngành nghề khi tạo mã QR.', 'Thiếu thông tin');
    if (!hkdName.trim()) return toast.alert('Tên Hộ Kinh Doanh bắt buộc (chọn HKD hoặc nhập tay).', 'Thiếu thông tin');
    const input: CreateTidInput = {
      kind: 'QR',
      // Mã merchant tuỳ chọn — bỏ trống gửi '' để server tự sinh mã định danh (createTidUnified: tid rỗng + kind QR → sinh QR-<slug>-<base36>).
      tid: maMerchant.trim(),
      dossierId: dossierId ? Number(dossierId) : null,
      industryId: Number(industryId),
      hkdName: hkdName.trim(),
      partnerId: Number(partnerId),
      bankId: Number(bankId),
      receiveAccountId: receiveAccountId ? Number(receiveAccountId) : null,
      note: note.trim() || null
    };
    // Nếu điền DigiStore: phải đủ CẢ user + mật khẩu (không lưu nửa vời).
    const wantsDs = dsUser.trim() !== '' || dsPass !== '';
    if (wantsDs && (!dsUser.trim() || !dsPass)) return toast.alert('Tài khoản DigiStore cần đủ cả User và Mật khẩu (hoặc bỏ trống cả hai).', 'Thiếu thông tin');
    setBusy(true);
    const res = await window.api.tidCreate(input);
    if (!res.ok) {
      setBusy(false);
      baoLoi(toast.alert, res, 'Thêm mã QR');
      return;
    }
    // Lưu creds DigiStore (nếu có) cho mã vừa tạo — dùng id trả về từ tidCreate. Lỗi lưu creds KHÔNG rớt việc tạo mã.
    if (wantsDs && typeof res.id === 'number') {
      const cred = await window.api.qrDigistoreCredSet({ tidId: res.id, username: dsUser.trim(), password: dsPass, base: dsBase.trim() || null });
      setBusy(false);
      if (cred.ok) toast.success('Đã thêm mã QR + tài khoản DigiStore');
      else toast.alert(`Đã tạo mã QR nhưng chưa lưu được tài khoản DigiStore: ${cred.message ?? 'lỗi không rõ'}. Vào "Sửa mã QR" để nhập lại.`, 'Lưu DigiStore lỗi');
      onSaved();
      return;
    }
    setBusy(false);
    toast.success('Đã thêm mã QR');
    onSaved();
  }

  return (
    <Modal title="Thêm mã QR bán hàng" onClose={onClose}>
      {!refs && (
        <div className="py-6 text-center text-slate-400">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      )}
      {refs && (
        <>
          <p className="mb-3 text-xs text-slate-400">Mã QR dùng chung — chọn đại lý lúc quét bill, KHÔNG gắn/giao máy POS. Giá tra qua "Giá QR theo đối tác / theo mã".</p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Hộ Kinh Doanh (HKD)" hint="Chọn để tự điền tên + gắn hồ sơ">
              <select className={inputCls} value={dossierId} onChange={(e) => onPickDossier(e.target.value)} autoFocus>
                <option value="">— Chọn HKD —</option>
                {refs.dossiers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hkdName}
                    {d.ownerName ? ` · ${d.ownerName}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tên Hộ Kinh Doanh" required hint="Tự điền từ HKD, có thể sửa">
              <input className={inputCls} value={hkdName} onChange={(e) => setHkdName(e.target.value)} />
            </Field>
            <Field label="Đối tác" required>
              <select className={inputCls} value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                <option value="">— Chọn đối tác —</option>
                {refs.partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ngân hàng" required hint="Lọc theo liên kết đối tác ↔ ngân hàng">
              {partnerId && linkedBanks.length === 0 ? (
                <div className="rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs text-slate-600">Đối tác này chưa liên kết ngân hàng nào (cấu hình ở Cấu hình ngân hàng → Đối tác).</div>
              ) : (
                <PickerGoiY
                  items={(partnerId ? linkedBanks : refs.banks).map((b) => ({ value: String(b.id), nhan: `${b.code}` }))}
                  value={bankId}
                  onChange={setBankId}
                  disabled={linkedBanks.length === 1}
                  placeholder="Gõ mã hoặc tên ngân hàng…"
                  dataKiem="o-chon-ngan-hang"
                />
              )}
            </Field>
            <Field label="Ngành nghề" required hint="Bắt buộc — theo ĐKKD của HKD">
              <select className={inputCls} value={industryId} onChange={(e) => setIndustryId(e.target.value)}>
                <option value="">— Chọn ngành nghề —</option>
                {refs.industries.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.code} · {i.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tài khoản nhận tiền" hint="Mã QR suy UỶ (Khách/NĐT/Nội bộ) qua tài khoản này">
              <select className={inputCls} value={receiveAccountId} onChange={(e) => setReceiveAccountId(e.target.value)}>
                <option value="">— Không chọn —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName}{a.owyType === 'INVESTOR' ? ` · NĐT: ${a.owyName ?? ''}` : a.owyType === 'CUSTOMER' ? ` · KH: ${a.owyName ?? ''}` : ' · Nội bộ'}</option>)}
              </select>
            </Field>
            <Field label="Mã merchant" hint="Tuỳ chọn — bỏ trống thì hệ thống tự sinh mã định danh">
              <input className={inputCls} value={maMerchant} onChange={(e) => setMaMerchant(e.target.value)} />
            </Field>
            <Field label="Ghi chú">
              <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>

          {/* [Admin Demo 5/9] Tài khoản DigiStore (báo có) — per-mã QR. Link mặc định BVBank (bỏ trống). Tuỳ chọn lúc tạo,
              có thể nhập sau ở "Sửa mã QR". Mật khẩu mã hoá ở server, KHÔNG bao giờ hiện lại. */}
          <div className="mt-4 rounded-lg border border-slate-200 bg-appbg p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Tài khoản DigiStore (báo có)</div>
            <p className="mb-2 text-xs text-slate-400">Dùng để tự kéo "báo có" đối soát doanh số mã QR. Link mặc định BVBank — bỏ trống. Có thể nhập sau ở "Sửa mã QR".</p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Tài khoản (User)" hint="Tên đăng nhập DigiStore của mã QR này">
                <input className={inputCls} value={dsUser} onChange={(e) => setDsUser(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Mật khẩu" hint="Mã hoá khi lưu — không hiện lại">
                <input type="password" className={inputCls} value={dsPass} onChange={(e) => setDsPass(e.target.value)} autoComplete="new-password" />
              </Field>
              <div className="col-span-2">
                <Field label="Link DigiStore (tuỳ chọn)" hint="Bỏ trống = mặc định BVBank">
                  <input className={inputCls} value={dsBase} onChange={(e) => setDsBase(e.target.value)} placeholder="Mặc định BVBank" autoComplete="off" />
                </Field>
              </div>
            </div>
          </div>

          {partnerId && bankId && (
            <div className="mt-3">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Biểu phí (mua / cài máy / bán) của đối tác</div>
              <FeePreview bankId={Number(bankId)} partnerId={Number(partnerId)} />
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="neutral" onClick={onClose}>Hủy</Button>
            <Button data-nut="them" variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Thêm mã QR</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// [Admin Demo 5/9] Mục "Tài khoản DigiStore (báo có)" per-mã QR — dùng ở form SỬA mã QR (tự fetch trạng thái + tự lưu).
// Hiện "đã cấu hình: <user> / chưa cấu hình" (từ GET, KHÔNG trả password). Lưu qua qrDigistoreCredSet (mã hoá server).
// KHÔNG hiện password đã lưu (chỉ user). Link mặc định BVBank (bỏ trống). CHỈ render khi tid là mã QR (caller gate isQr).
function DigistoreCredSection({ tidId }: { tidId: number }): JSX.Element {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [savedUser, setSavedUser] = useState<string | null>(null);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    window.api.qrDigistoreCredGet(tidId).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setConfigured(!!r.configured);
        setSavedUser(r.username ?? null);
        if (r.username) setUser(r.username);
        if (r.base) setBase(r.base);
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, [tidId]);

  async function save(): Promise<void> {
    if (!user.trim()) return toast.alert('Nhập tài khoản (User) DigiStore.', 'Thiếu thông tin');
    if (!pass) return toast.alert('Nhập mật khẩu DigiStore.', 'Thiếu thông tin');
    setBusy(true);
    const res = await window.api.qrDigistoreCredSet({ tidId, username: user.trim(), password: pass, base: base.trim() || null });
    setBusy(false);
    if (res.ok) {
      toast.success('Đã lưu tài khoản DigiStore');
      setConfigured(true);
      setSavedUser(user.trim());
      setPass(''); // KHÔNG giữ password trong state sau khi lưu
    } else {
      baoLoi(toast.alert, res, 'Lưu tài khoản DigiStore');
    }
  }

  return (
    <div className="col-span-2 mt-2 rounded-lg border border-slate-200 bg-appbg p-3">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tài khoản DigiStore (báo có)</div>
        {loading ? (
          <span className="text-xs text-slate-400"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /></span>
        ) : configured ? (
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Đã cấu hình{savedUser ? ` · ${savedUser}` : ''}</span>
        ) : (
          <span className="rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">Chưa cấu hình</span>
        )}
      </div>
      <p className="mb-2 text-xs text-slate-400">Mật khẩu mã hoá khi lưu — KHÔNG hiện lại. Nhập mật khẩu mới để đổi. Link mặc định BVBank.</p>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Tài khoản (User)">
          <input className={inputCls} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
        </Field>
        <Field label={configured ? 'Mật khẩu mới (để đổi)' : 'Mật khẩu'} hint="Mã hoá khi lưu — không hiện lại">
          <input type="password" className={inputCls} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" placeholder={configured ? 'Để trống nếu không đổi' : ''} />
        </Field>
        <div className="col-span-2">
          <Field label="Link DigiStore (tuỳ chọn)" hint="Bỏ trống = mặc định BVBank">
            <input className={inputCls} value={base} onChange={(e) => setBase(e.target.value)} placeholder="Mặc định BVBank" autoComplete="off" />
          </Field>
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <Button variant="confirm" onClick={save} disabled={busy || loading} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Lưu tài khoản DigiStore</Button>
      </div>
    </div>
  );
}

const KIND_TITLE: Record<string, string> = {
  assign: 'Gán TID vào máy POS + khách hàng',
  replace: 'Đổi TID (TID cũ chết → TID mới)',
  recall: 'Thu hồi TID',
  deliver: 'Giao TID cho khách'
};

function TidActionModal({ tid, kind, onClose, onDone, onOpenSell }: { tid: TidDto; kind: 'assign' | 'replace' | 'recall' | 'deliver'; onClose: () => void; onDone: () => void; onOpenSell?: () => void }): JSX.Element {
  const toast = useToast();
  const [devices, setDevices] = useState<PosDto[]>([]);
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [posSerial, setPosSerial] = useState('');
  const [customerId, setCustomerId] = useState(tid.customerId ? String(tid.customerId) : '');
  const [chatRoomId, setChatRoomId] = useState(''); // Phòng chat SigMa (Admin Demo 3/8) — assign/deliver
  const [newTid, setNewTid] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // LOẠI GIAO MÁY (Admin Demo) — "Gán máy POS" = giao TID kèm máy: loại giao + số tiền + quỹ.
  const [handoverTypes, setHandoverTypes] = useState<HandoverTypeLite[]>([]);
  const [handoverTypeId, setHandoverTypeId] = useState('');
  const [handoverAmount, setHandoverAmount] = useState('');
  const [fundId, setFundId] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [depositFundId, setDepositFundId] = useState('');
  const [method, setMethod] = useState('CASH');
  const [funds, setFunds] = useState<FundDto[]>([]);
  // PHA 2 (2A) — giá bán thực tế thỏa thuận khi giao (nhúng SellFeeEditor). Ref = snapshot mới nhất; đọc lúc submit.
  const sellFeeRef = useRef<SellFeeSnapshot | null>(null);

  const selectedHandover = handoverTypes.find((h) => String(h.id) === handoverTypeId);
  const moneyKind = selectedHandover?.moneyKind ?? 'NONE';
  const amountNum = Number(handoverAmount) || 0;
  const showDeposit = !!selectedHandover?.hasDeposit && moneyKind !== 'DEPOSIT';
  const depositNum = Number(depositAmount) || 0;

  useEffect(() => {
    if (kind === 'assign') {
      window.api.posList({}).then((r) => r.ok && r.data && setDevices(r.data));
      window.api.customerList({}).then((r) => r.ok && r.data && setCustomers(r.data));
      window.api.handoverTypeListLite().then((r) => {
        if (r.ok && r.data) {
          const sorted = [...r.data].sort((a, b) => a.sortOrder - b.sortOrder);
          setHandoverTypes(sorted);
          if (sorted[0]) setHandoverTypeId(String(sorted[0].id));
        }
      });
      window.api.fundList({}).then((r) => r.ok && r.data && setFunds(r.data.filter((f) => f.active)));
    }
    if (kind === 'deliver') {
      window.api.customerList({}).then((r) => r.ok && r.data && setCustomers(r.data));
    }
  }, [kind]);

  // Mượn (NONE) — khóa số tiền = 0.
  useEffect(() => {
    if (kind === 'assign' && (moneyKind === 'NONE' || moneyKind === 'COUNTERPART')) { setHandoverAmount('0'); setFundId(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moneyKind, kind]);

  async function run(): Promise<void> {
    const when = occurredAt ? new Date(occurredAt).toISOString() : null;
    let res;
    // PHA 2 (2A) — payload giá bán thực tế; CHỈ gửi khi user THỰC SỰ nhập ít nhất 1 giá custom (anyCustom), KHÔNG
    // phải chỉ (ready). Để TẤT CẢ niêm yết = KHÔNG gửi gì (đúng ý Admin Demo "chưa set thì để trống, sửa sau") — tránh
    // gửi sellFees toàn null (audit 20/8 #4: fragile, có thể wipe override ở ca hiếm hasOverride nhưng giá rỗng).
    const sfSnap = sellFeeRef.current;
    // VALIDATE client TRƯỚC submit: bán < phí mua niêm yết / phí mua null / ngoài 0–100 → CHẶN (editor đã hiện đỏ
    // inline; đây là gate cuối kèm toast).
    if (sfSnap && sfSnap.invalid) return toast.alert(sfSnap.invalidReason ?? 'Giá bán thực tế không hợp lệ.', 'Giá bán thực tế không hợp lệ');
    // [15/11] bỏ điều kiện anyCustom — xem chú thích ở hàm giao TID.
    const sendSellFee = !!(sfSnap && sfSnap.ready && sfSnap.sellFees.length > 0);
    const sellFeeFields = sendSellFee
      ? { defaultFeeTypeId: sfSnap!.defaultFeeTypeId ?? undefined, sellFees: sfSnap!.sellFees }
      : {};
    if (kind === 'assign') {
      if (!posSerial) return toast.alert('Phải chọn máy POS.');
      if (!customerId) return toast.alert('Phải chọn khách hàng.');
      if (!handoverTypeId) return toast.alert('Phải chọn loại giao.', 'Thiếu thông tin');
      if (moneyKind === 'SALE') return toast.alert('Loại giao "Bán" dùng chức năng Bán TID riêng — không gán qua luồng này.', 'Dùng chức năng Bán TID');
      // [Admin Demo 16/11] "Số tiền cọc có hoặc không, KHÔNG bắt buộc" — bỏ chặn, để trống = 0đ.
      if (amountNum > 0 && !fundId) return toast.alert('Có số tiền thì phải chọn quỹ nhận.', 'Thiếu quỹ');
      if (showDeposit && depositNum > 0 && !depositFundId) return toast.alert('Có đặt cọc thì phải chọn quỹ nhận cọc.', 'Thiếu quỹ cọc');
      setBusy(true);
      res = await window.api.tidAssign(tid.tid, {
        posSerial,
        customerId: Number(customerId),
        occurredAt: when,
        note: note || null,
        handoverTypeId: Number(handoverTypeId),
        handoverAmount: amountNum,
        fundId: fundId ? Number(fundId) : null,
        handoverDepositAmount: showDeposit ? depositNum : null,
        handoverDepositFundId: showDeposit && depositFundId ? Number(depositFundId) : null,
        method,
        chatRoomId: chatRoomId || null,
        ...sellFeeFields
      });
    } else if (kind === 'replace') {
      if (!newTid.trim()) return toast.alert('Phải nhập TID mới (đã tạo sẵn, trạng thái Chưa gán).');
      setBusy(true);
      res = await window.api.tidReplace(tid.tid, { newTid: newTid.trim(), occurredAt: when, note: note || null });
    } else if (kind === 'recall') {
      setBusy(true);
      res = await window.api.tidRecall(tid.tid, { occurredAt: when, note: note || null });
    } else {
      if (!customerId) return toast.alert('Phải chọn khách hàng nhận.');
      setBusy(true);
      res = await window.api.tidMarkDelivered(tid.tid, { deliveredAt: when, customerId: Number(customerId), toAgentId: null, note: note || null, chatRoomId: chatRoomId || null, ...sellFeeFields });
    }
    setBusy(false);
    if (res.ok) {
      toast.success(`${KIND_TITLE[kind]} — thành công cho TID ${tid.tid}`);
      if (res.warning) toast.alert(res.warning, 'Đã giao — lưu ý giá bán');
      onDone();
    } else {
      baoLoi(toast.alert, res, 'Thao tác');
    }
  }

  // Gán máy POS (Admin Demo 12/8): TID đã mang ngân hàng (app-bank) → TỰ lọc ra danh sách máy CÀI ĐÚNG app-bank đó +
  // còn trong kho (IN_STOCK, chưa gắn TID). KHÔNG cho chọn máy khác app-bank (TID không chạy được trên app khác).
  const tidBankLabel = tid.bankCode ?? tid.bankName ?? tid.bank ?? '';
  const inStock = devices.filter((d) => d.status === 'IN_STOCK' && (tid.bankId == null || d.bankId === tid.bankId));
  // Danh sách cho ô chọn máy POS dạng BẢNG (serial · dòng máy · app · kho) — Admin Demo 16/11.
  const dsMayPos: MayPos[] = inStock.map((d) => ({
    serial: d.serial,
    dongMay: d.posModelName ?? d.model ?? null,
    app: d.bankCode ?? d.bank ?? null,
    kho: d.warehouseName ?? d.warehouseLoc ?? null
  }));

  return (
    // [Admin Demo 15/11] Hộp thoại GIAO TID phải RỘNG + CAO để không phải cuộn: bảng giá bán thực tế nhiều
    // loại thẻ + chọn khách + phòng chat vốn tràn khỏi max-w-lg/70vh. Giao/gán dùng khổ rộng; thu hồi/đổi TID
    // vẫn khổ nhỏ (ít ô).
    <Modal
      title={`${KIND_TITLE[kind]} — ${tid.tid}`}
      onClose={onClose}
      width={kind === 'deliver' || kind === 'assign' ? 'max-w-6xl' : 'max-w-lg'}
      bodyMaxH={kind === 'deliver' || kind === 'assign' ? 'max-h-[90vh]' : 'max-h-[70vh]'}
    >
      {/* [Admin Demo 15/11] GIAO/GÁN TID: xếp 2 CỘT để không phải cuộn — 1 cột dọc thì bảng giá bán + các ô đẩy
          chiều cao vượt màn (đo thật: hộp 1024×880 vẫn còn cuộn). Các khối chiếm nguyên hàng (bảng giá bán,
          cảnh báo) tự span 2 cột nhờ `[&>*:has(table)]:col-span-2`. Khổ nhỏ (thu hồi/đổi TID) giữ 1 cột. */}
      <div className={(kind === 'deliver' || kind === 'assign' ? 'grid grid-cols-2 items-start gap-x-6' : 'grid grid-cols-1') + ' gap-4'}>
        {kind === 'assign' && (
          <>
            <Field label={`Máy POS cài app ${tidBankLabel || 'ngân hàng của TID'} (còn trong kho, chưa gắn TID)`} required>
              <PosPicker items={dsMayPos} value={posSerial} onChange={setPosSerial} />
              {inStock.length === 0 && (
                <p className="mt-1 text-xs text-warning">Không có máy nào trong kho cài app <b>{tidBankLabel || 'ngân hàng này'}</b>. Nhập kho / cài app cho máy trước, hoặc kiểm tra lại ngân hàng của TID.</p>
              )}
            </Field>
            <Field label="Khách hàng" required>
              <CustomerPicker customers={customers} value={customerId} onChange={setCustomerId} />
            </Field>
            <ChatRoomField customerId={customerId} value={chatRoomId} onChange={setChatRoomId} />
            <Field label="Loại giao" required hint="Hình thức giao TID kèm máy cho khách">
              <select className={inputCls} value={handoverTypeId} onChange={(e) => setHandoverTypeId(e.target.value)}>
                {handoverTypes.length === 0 && <option value="">— Chưa có loại giao —</option>}
                {handoverTypes.map((h) => <option key={h.id} value={h.id}>{h.name} ({MONEY_KIND_LABEL[h.moneyKind] ?? h.moneyKind})</option>)}
              </select>
            </Field>
            {moneyKind === 'SALE' && (
              <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-slate-600">
                Loại giao <b>Bán</b> — TID bán đứt, không gán qua luồng này. Hãy dùng chức năng <b>Bán TID</b>.
                {onOpenSell && (
                  <div className="mt-2">
                    <Button variant="confirm" onClick={onOpenSell}>Mở Bán TID</Button>
                  </div>
                )}
              </div>
            )}
            {moneyKind !== 'SALE' && (
              <div className="grid grid-cols-2 gap-4">
                <Field label={moneyKind === 'DEPOSIT' ? 'Số tiền cọc (VND)' : moneyKind === 'RENT' ? 'Số tiền thuê (VND)' : 'Số tiền (VND)'} hint={moneyKind === 'NONE' ? 'Mượn — khóa 0đ' : moneyKind === 'DEPOSIT' ? 'Không bắt buộc — để trống = chưa thu cọc' : undefined}>
                  <input
                    className={inputCls + ' text-right tabular-nums'}
                    inputMode="numeric"
                    value={groupDigits(handoverAmount)}
                    disabled={moneyKind === 'NONE' || moneyKind === 'COUNTERPART'}
                    onChange={(e) => setHandoverAmount(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder="0"
                  />
                </Field>
                <Field label="Quỹ nhận tiền" hint={amountNum > 0 ? 'Bắt buộc khi có số tiền' : 'Không thu thì bỏ trống'}>
                  <select className={inputCls} value={fundId} disabled={moneyKind === 'NONE' || moneyKind === 'COUNTERPART'} onChange={(e) => setFundId(e.target.value)}>
                    <option value="">— Chọn quỹ —</option>
                    {funds.map((f) => <option key={f.id} value={f.id}>{f.code} · {f.name}</option>)}
                  </select>
                </Field>
                {amountNum > 0 && (
                  <Field label="Hình thức">
                    <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}>
                      <option value="CASH">Tiền mặt</option>
                      <option value="CK">Chuyển khoản</option>
                    </select>
                  </Field>
                )}
              </div>
            )}
            {showDeposit && (
              <div className="mt-3 grid grid-cols-2 gap-4 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                <Field label="Tiền cọc thiết bị (VND)" hint="Cọc POS/TID — hoàn lại khi thu về. Để 0 = không cọc.">
                  <input className={inputCls + ' text-right tabular-nums'} inputMode="numeric" value={groupDigits(depositAmount)} onChange={(e) => setDepositAmount(e.target.value.replace(/[^\d]/g, ''))} placeholder="0" />
                </Field>
                <Field label="Quỹ nhận cọc" hint={depositNum > 0 ? 'Bắt buộc khi có cọc' : 'Không cọc thì bỏ trống'}>
                  <select className={inputCls} value={depositFundId} onChange={(e) => setDepositFundId(e.target.value)}>
                    <option value="">— Chọn quỹ —</option>
                    {funds.map((f) => <option key={f.id} value={f.id}>{f.code} · {f.name}</option>)}
                  </select>
                </Field>
              </div>
            )}
            {/* [Admin Demo 16/11] "khung bảng có kích thước CỐ ĐỊNH chứ không phải chọn khách xong mới nhảy giá bán
                thực tế": CHỖ này luôn chiếm đúng 1 khoảng như nhau — chưa chọn khách thì hiện lời nhắc, chọn rồi
                thì thay bằng bảng giá bán. Hộp thoại KHÔNG đổi chiều cao giữa 2 trạng thái. */}
            {moneyKind !== 'SALE' && (
              <div className="col-span-2 min-h-[330px]" data-kiem="o-gia-ban">
                {customerId ? (
                  <SellFeeSection tidId={tid.id} at={occurredAt ? new Date(occurredAt).toISOString() : undefined} onChange={(s) => { sellFeeRef.current = s; }} />
                ) : (
                  <div className="flex h-[330px] items-center justify-center rounded-xl border border-dashed border-line bg-appbg/40 text-sm text-slate-400">
                    Chọn khách hàng để đặt <b className="mx-1 text-slate-500">giá bán thực tế</b> cho TID này.
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {kind === 'replace' && (
          <Field label="TID mới" required hint="TID mới phải đã được tạo và ở trạng thái Chưa gán">
            <input className={inputCls} value={newTid} onChange={(e) => setNewTid(e.target.value)} autoFocus />
          </Field>
        )}
        {kind === 'deliver' && (
          <>
            <Field label="Khách hàng nhận" required hint="TID chưa gán máy (máy khách) cần chọn khách">
              <CustomerPicker customers={customers} value={customerId} onChange={setCustomerId} />
            </Field>
            <ChatRoomField customerId={customerId} value={chatRoomId} onChange={setChatRoomId} />
            {/* Khổ CỐ ĐỊNH — xem chú thích ở nhánh 'assign' phía trên. */}
            {true && (
              <div className="col-span-2 min-h-[330px]" data-kiem="o-gia-ban">
                {customerId ? (
                  <SellFeeSection tidId={tid.id} at={occurredAt ? new Date(occurredAt).toISOString() : undefined} onChange={(s) => { sellFeeRef.current = s; }} />
                ) : (
                  <div className="flex h-[330px] items-center justify-center rounded-xl border border-dashed border-line bg-appbg/40 text-sm text-slate-400">
                    Chọn khách hàng để đặt <b className="mx-1 text-slate-500">giá bán thực tế</b> cho TID này.
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <Field label={kind === 'deliver' ? 'Thời gian giao' : 'Thời gian thao tác'} hint="Bỏ trống = hiện tại">
          <input type="datetime-local" className={inputCls} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
        <Field label="Ghi chú">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={run} disabled={busy || (kind === 'assign' && moneyKind === 'SALE')} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-3.5 w-3.5" />}>
          {kind === 'assign' ? 'Gán TID' : kind === 'replace' ? 'Đổi TID' : kind === 'recall' ? 'Thu hồi' : 'Đã giao'}
        </Button>
      </div>
    </Modal>
  );
}

const TID_EVENT_LABELS: Record<string, string> = {
  STOCK_IN: 'Nhập kho',
  TID_ASSIGN: 'Gán TID lên máy',
  TID_DELIVERED: 'Giao TID cho khách',
  TID_SELL: 'Bán TID',
  TID_UNBIND: 'Gỡ TID khỏi máy',
  TID_RECALL: 'Thu hồi TID',
  TID_DEAD: 'TID chết (đổi)',
  TID_CLOSE: 'Đóng TID',
  TID_REPLACE: 'TID mới thay thế',
  DEPLOY: 'Giao máy',
  RECALL: 'Thu hồi máy',
  SELL: 'Bán máy',
  RETIRE: 'Thanh lý'
};

// Nhãn trạng thái TID cho dòng "fromState → toState" trong vòng đời.
const TID_STATE_LABELS: Record<string, string> = {
  UNASSIGNED: 'Chưa gán',
  ACTIVE: 'Đang hoạt động',
  DEAD: 'Chết',
  CLOSED: 'Đã đóng',
  RECALLED: 'Đã thu hồi',
  SOLD: 'Đã bán'
};

// eventType có "khách" mang ý nghĩa giao/bán cho khách (dòng "Khách: …") trong vòng đời TID.
const TID_CUSTOMER_EVENT_TYPES = new Set(['DEPLOY', 'CHANGE_CUSTOMER', 'TID_DELIVERED', 'SELL', 'TID_SELL']);

// R30 — Phí bán THỰC TẾ theo TID × loại thẻ. Nhập khi giao máy; cột "Niêm yết" (FeeRate.phiBan hiệu lực)
// để đối chiếu tránh điền sai. Để trống = dùng niêm yết. Doanh thu GD sau đó ưu tiên phí thực tế này.
function pctText(p: number | null): string {
  if (p == null) return '—';
  return `${String(p).replace('.', ',')}%`;
}

// PHA 2 (2A) — snapshot phí bán thực tế mà SellFeeEditor phát ra cho parent (giao/gán/modal sửa-sau).
export type SellFeeSnapshot = {
  ready: boolean; // rows đã tải + đã chọn loại phí → payload gửi backend được
  hasRows: boolean; // có ≥1 loại thẻ để đặt phí
  anyCustom: boolean; // có ≥1 loại thẻ đặt phí TÙY CHỈNH (đã set giá bán thực tế)
  defaultFeeTypeId: number | null; // loại phí đang chọn
  // 'quote'→null, 'custom'→số nhập. [B236 22/11] phiMuaNdt = GIÁ SIGMA MUA CỦA NĐT cho thẻ đó:
  // undefined = không đụng tới · null = xoá khai báo · số = ghi mới.
  sellFees: { cardTypeId: number; phiBan: number | null; phiMuaNdt?: number | null }[];
  // VALIDATE client TRƯỚC submit (server vẫn enforce): bán < phí mua niêm yết / phí mua null / ngoài 0–100 →
  // invalid=true + invalidReason (thông điệp lỗi ĐẦU TIÊN cho toast). Parent CHẶN Lưu/Giao khi invalid.
  invalid: boolean;
  invalidReason: string | null;
};

// Validate client-side phí bán TÙY CHỈNH (entry.phiBan != null = có số nhập, mode 'custom'): PHẢI ≥ phí mua niêm
// yết của loại thẻ đó (bán < mua là lỗ — server tid-sell-fee.ts cũng CHẶN). phiMua null (chưa cấu hình FeeRate niêm
// yết) → không đặt được giá. Bao luôn 0–100. Trả map lỗi theo cardTypeId (render inline đỏ) + firstError (toast).
// entry.phiBan == null (Niêm yết / bỏ trống) → BỎ QUA (không tạo override, không cần so sánh). Hàm THUẦN (test được).
export function validateSellFeeEntries(
  entries: { cardTypeId: number; phiBan: number | null }[],
  phiMuaByCard: Record<number, number | null>
): { errors: Record<number, string>; firstError: string | null } {
  const errors: Record<number, string> = {};
  for (const e of entries) {
    if (e.phiBan == null) continue;
    if (!Number.isFinite(e.phiBan) || e.phiBan < 0 || e.phiBan > 100) {
      errors[e.cardTypeId] = 'Phí bán phải là số trong khoảng 0–100%.';
      continue;
    }
    const phiMua = phiMuaByCard[e.cardTypeId];
    if (phiMua == null) {
      errors[e.cardTypeId] = 'Chưa có phí mua niêm yết cho loại thẻ này — không đặt được giá bán.';
      continue;
    }
    if (e.phiBan < phiMua) {
      errors[e.cardTypeId] = `Phí bán phải ≥ phí mua niêm yết ${phiMua}%.`;
    }
  }
  const keys = Object.keys(errors);
  return { errors, firstError: keys.length ? errors[Number(keys[0])]! : null };
}

// 'quote' = dùng niêm yết → phiBan null (KHÔNG tạo/giữ override). 'custom' = phí tùy chỉnh → gửi số nhập.
function buildSellFeeEntries(
  rows: TidSellFeeRowDto[],
  mode: Record<number, 'quote' | 'custom'>,
  edited: Record<number, string>
): { cardTypeId: number; phiBan: number | null }[] {
  return rows.map((row) => {
    if ((mode[row.cardTypeId] ?? 'quote') === 'quote') return { cardTypeId: row.cardTypeId, phiBan: null };
    const raw = (edited[row.cardTypeId] ?? '').trim().replace(',', '.');
    return { cardTypeId: row.cardTypeId, phiBan: raw === '' ? null : Number(raw) };
  });
}

// (validateSellFees 0–100 cũ đã GỘP vào validateSellFeeEntries — bao 0–100 + bán≥mua + phí mua null. Xem trên.)
// anySellFeeCustom (suy anyCustom theo GIÁ TRỊ, không theo mode — chống wipe override) tách sang lib/sell-fee-entries.ts
// để test THUẦN không phải import cả cây renderer. Xem comment tại đó.

// SellFeeEditor — editor phí bán THỰC TẾ theo loại thẻ dưới 1 LOẠI PHÍ, TÁI SỬ DỤNG cho:
//  (1) TidSellFeeModal (sửa sau khi giao — có nút Lưu riêng),
//  (2) nhúng vào Giao/Gán TID (không có nút Lưu — parent gửi kèm defaultFeeTypeId + sellFees),
//  (3) nhúng vào "Thêm TID" giao-ngay khi TID CHƯA tồn tại (nguồn bankPartner, không override).
// Nguồn dữ liệu = discriminated: `tidId` (TID đã có → tidSellFeeList) HOẶC `bankPartner` (TID chưa có →
// sellFeePreviewByBankPartner, luôn hasPartner=true, chưa override). Phát snapshot qua onChange.
function SellFeeEditor({ tidId, bankPartner, at, onChange }: { tidId?: number; bankPartner?: { bankId: number; partnerId: number }; at?: string; onChange: (snap: SellFeeSnapshot) => void }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<TidSellFeeRowDto[] | null>(null);
  const [hasPartner, setHasPartner] = useState(true);
  const [edited, setEdited] = useState<Record<number, string>>({});
  // [B236 22/11 — Admin Demo] Ô nhập PHÍ MUA CỦA NĐT theo từng loại thẻ. Để TRỐNG = chưa khai (báo cáo lãi NĐT
  // sẽ để trống chứ KHÔNG bịa 0).
  const [muaNdt, setMuaNdt] = useState<Record<number, string>>({});
  // FEE_MODEL — mỗi loại thẻ chọn 1 trong 2: 'quote' = dùng phí bán NIÊM YẾT (read-only) | 'custom' = phí TÙY CHỈNH.
  const [mode, setMode] = useState<Record<number, 'quote' | 'custom'>>({});
  // FEE_TYPE — phí bán thực tế theo TID × thẻ × LOẠI PHÍ. MẶC ĐỊNH loại phí phần tử ĐẦU (Admin Demo "thứ tự 1").
  const [feeTypes, setFeeTypes] = useState<FeeTypeDto[]>([]);
  const [feeTypeId, setFeeTypeId] = useState('');

  // Giữ onChange ổn định để effect phát snapshot không phụ thuộc identity callback (tránh vòng lặp).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    window.api.feeTypeList().then((r) => {
      if (r.ok && r.data) {
        setFeeTypes(r.data);
        if (r.data[0]) setFeeTypeId(String(r.data[0].id));
      }
    });
  }, []);

  // Nguồn theo (bankId, partnerId) — tách primitive để dependency effect KHÔNG phụ thuộc identity object `bankPartner`
  // (parent truyền inline {bankId, partnerId} mỗi render → nếu depend object sẽ reload vô hạn).
  const bpBankId = bankPartner?.bankId;
  const bpPartnerId = bankPartner?.partnerId;
  useEffect(() => {
    if (!feeTypeId) return;
    if (tidId == null && (bpBankId == null || bpPartnerId == null)) return;
    let alive = true;
    setRows(null);
    // TID đã có → tidSellFeeList (kèm override). Chưa có → sellFeePreviewByBankPartner (niêm yết, không override).
    const loader = tidId != null
      ? window.api.tidSellFeeList(tidId, Number(feeTypeId), at).then((r) => (r.ok && r.data ? { ok: true as const, rows: r.data.rows, hasPartner: r.data.partnerId != null } : { ok: false as const, message: r.message }))
      : window.api.sellFeePreviewByBankPartner(bpBankId!, bpPartnerId!, Number(feeTypeId), at).then((r) => (r.ok && r.data ? { ok: true as const, rows: r.data, hasPartner: true } : { ok: false as const, message: r.message }));
    loader.then((r) => {
      if (!alive) return;
      if (r.ok) {
        setRows(r.rows);
        setHasPartner(r.hasPartner);
        const init: Record<number, string> = {};
        const initMode: Record<number, 'quote' | 'custom'> = {};
        // [B236] Nạp sẵn PHÍ MUA NĐT đang khai để người dùng thấy ngay số cũ, sửa đè được.
        const initMua: Record<number, string> = {};
        for (const row of r.rows) {
          init[row.cardTypeId] = row.phiBanThucTe != null ? String(row.phiBanThucTe) : '';
          initMode[row.cardTypeId] = row.hasOverride ? 'custom' : 'quote';
          initMua[row.cardTypeId] = row.phiMuaNdt != null ? String(row.phiMuaNdt) : '';
        }
        setEdited(init);
        setMode(initMode);
        setMuaNdt(initMua);
      } else {
        baoLoi(toast.alert, r, 'Không tải được phí bán');
        setRows([]);
      }
    });
    return () => {
      alive = false;
    };
    // `at` (ngày giao) trong deps — đổi ngày giao thì RELOAD niêm yết/override đúng kỳ hiệu lực TẠI ngày đó (khớp
    // KỲ mà applyHandoverSellFees sẽ ghi), để preview khớp backend.
  }, [tidId, bpBankId, bpPartnerId, feeTypeId, at]);

  // phí mua niêm yết theo loại thẻ (để validate bán ≥ mua ở client, khớp server).
  const phiMuaByCard: Record<number, number | null> = rows ? Object.fromEntries(rows.map((r) => [r.cardTypeId, r.phiMuaNiemYet])) : {};
  // Lỗi client theo loại thẻ (render inline đỏ dưới ô nhập + chặn submit). Tính LIVE mỗi render từ rows/mode/edited.
  const rowErrors = rows && rows.length > 0 ? validateSellFeeEntries(buildSellFeeEntries(rows, mode, edited), phiMuaByCard).errors : {};

  // Phát snapshot cho parent mỗi khi lựa chọn đổi (loại phí / mode / số nhập / rows tải xong).
  useEffect(() => {
    const rowsReady = rows != null && rows.length > 0;
    const entries = rowsReady ? buildSellFeeEntries(rows as TidSellFeeRowDto[], mode, edited) : [];
    const anyCustom = rowsReady && anySellFeeCustom(entries);
    // [Admin Demo 15/11] "không nhập giá bán thì mặc định LÀ GIÁ NIÊM YẾT; giá bán khác thì để giá đã set".
    // TRƯỚC: thẻ không nhập ⇒ phiBan null ⇒ KHÔNG gửi gì ⇒ TID giao xong KHÔNG có giá bán thực tế ⇒ bill bị
    // chặn NO_ACTUAL_SELL_FEE (ca thật 15/11: TID 20280817 giao rồi mà 0 dòng giá bán).
    // NAY: ô trống ⇒ lấy giá ĐÃ SET sẵn (nếu có) ⇒ nếu vẫn không có thì lấy NIÊM YẾT. Thẻ không có cả niêm yết
    // thì bỏ qua (không bịa số).
    const entriesGui = rowsReady ? buildSellFeeEntriesNen(rows as TidSellFeeRowDto[], entries) : [];
    // VALIDATE client — bán ≥ mua niêm yết / 0–100 / phí mua null. invalid=true ⇒ parent chặn Lưu/Giao + toast.
    const vres = rowsReady
      ? validateSellFeeEntries(entriesGui, Object.fromEntries((rows as TidSellFeeRowDto[]).map((r) => [r.cardTypeId, r.phiMuaNiemYet])))
      : { errors: {}, firstError: null };
    onChangeRef.current({
      ready: rowsReady && !!feeTypeId,
      hasRows: rowsReady,
      anyCustom,
      defaultFeeTypeId: feeTypeId ? Number(feeTypeId) : null,
      // [B236] Gắn phí mua NĐT vào từng dòng: ô TRỐNG mà sổ đang có số ⇒ undefined (GIỮ NGUYÊN, không âm
      // thầm xoá); gõ "-" hoặc "x" ⇒ null (xoá khai báo); có số ⇒ ghi số.
      sellFees: entriesGui.map((e) => {
        const o = (muaNdt[e.cardTypeId] ?? '').trim();
        if (o === '') return e;
        if (o === '-' || o.toLowerCase() === 'x') return { ...e, phiMuaNdt: null };
        const n = Number(o.replace(',', '.'));
        return Number.isFinite(n) ? { ...e, phiMuaNdt: n } : e;
      }),
      invalid: vres.firstError != null,
      invalidReason: vres.firstError
    });
  }, [feeTypeId, rows, edited, mode, muaNdt]);

  // Cùng nghĩa với gate gửi (anySellFeeCustom): "chưa đặt giá bán thực tế" khi KHÔNG thẻ nào có số custom hữu hạn
  // (toàn niêm yết HOẶC custom-nhưng-trống) → hiện chú thích bill "chưa cấu hình giá bán" cho khớp thực tế sẽ gửi.
  const anyCustom = rows != null && rows.length > 0 && anySellFeeCustom(buildSellFeeEntries(rows, mode, edited));

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-medium text-slate-600">Loại phí</span>
        <select className={inputCls + ' w-56'} value={feeTypeId} onChange={(e) => setFeeTypeId(e.target.value)}>
          <option value="">— Chọn loại phí —</option>
          {feeTypes.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>
      {rows === null && (
        <div className="py-6 text-center text-slate-400">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      )}
      {rows !== null && rows.length === 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-slate-600">
          TID chưa gán ngân hàng hoặc ngân hàng chưa có loại thẻ. Hãy cấu hình TID (ngân hàng) và loại thẻ trước khi đặt phí bán.
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <>
          {!hasPartner && (
            <div className="mb-3 rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs text-slate-600">
              TID chưa gán đối tác nên chưa có phí niêm yết để đối chiếu — vẫn có thể nhập phí bán thực tế.
            </div>
          )}
          <KhungBang className="max-h-[46vh] bg-white">
            <table className="w-full min-w-[720px] text-xs">
              <thead className={theadChuan}>
                <tr>
                  <th className={thChuan}>Loại thẻ</th>
                  <th className={thChuan + ' w-[120px]'}>Niêm yết</th>
                  <th className={thChuan + ' w-[200px]'}>Cách tính phí bán</th>
                  <th className={thChuan + ' w-[220px]'}>Phí bán áp dụng (%)</th>
                  {/* [B236 22/11 — Admin Demo "thêm loại phí mua NĐT cho dễ"] Khai NGAY CẠNH giá bán vì hai số
                      này luôn đi cùng nhau: lãi NĐT = phí mua NĐT − phí cài máy · SigMa = phí bán − phí mua NĐT. */}
                  <th className={thChuan + ' w-[180px]'} title="Giá SigMa mua của nhà đầu tư cho loại thẻ này">Phí mua NĐT (%)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const m = mode[row.cardTypeId] ?? 'quote';
                  return (
                  <tr key={row.cardTypeId} className={trChuan(i)}>
                    <td className={tdChuan + ' text-slate-700'}>
                      {row.cardTypeCode ? <span className="font-mono font-semibold text-brand whitespace-nowrap">{row.cardTypeCode}</span> : null} {row.cardTypeName}
                    </td>
                    {/* Cột % → tdPhanTram: căn giữa, 12px, slate-600, không in đậm. */}
                    <td className={tdPhanTram}>{pctText(row.phiBanNiemYet)}</td>
                    <td className={tdChuan + ' text-center'}>
                      <div className="inline-flex overflow-hidden rounded-md border border-line">
                        <button
                          type="button"
                          className={'px-2.5 py-1 ' + (m === 'quote' ? 'brand-accent text-white' : 'bg-white text-slate-600 hover:bg-appbg')}
                          onClick={() => setMode((s) => ({ ...s, [row.cardTypeId]: 'quote' }))}
                        >Niêm yết</button>
                        <button
                          type="button"
                          className={'px-2.5 py-1 ' + (m === 'custom' ? 'brand-accent text-white' : 'bg-white text-slate-600 hover:bg-appbg')}
                          onClick={() => setMode((s) => ({ ...s, [row.cardTypeId]: 'custom' }))}
                        >Tùy chỉnh</button>
                      </div>
                    </td>
                    <td className={tdChuan + ' text-right'}>
                      {m === 'quote' ? (
                        <span className="tabular-nums text-slate-500">{pctText(row.phiBanNiemYet)} <span className="text-slate-400">(niêm yết)</span></span>
                      ) : (
                        <>
                          <input
                            className={inputCls + ' w-28 text-right text-xs tabular-nums' + (rowErrors[row.cardTypeId] ? ' border-danger' : '')}
                            inputMode="decimal"
                            placeholder={row.phiBanNiemYet != null ? String(row.phiBanNiemYet) : '—'}
                            value={edited[row.cardTypeId] ?? ''}
                            onChange={(e) => setEdited((s) => ({ ...s, [row.cardTypeId]: e.target.value }))}
                          />
                          {/* VALIDATE client — bán < mua niêm yết / phí mua null / ngoài 0–100 → lỗi đỏ NGAY, chặn submit. */}
                          {rowErrors[row.cardTypeId] && (
                            <div className="mt-1 whitespace-normal text-danger">{rowErrors[row.cardTypeId]}</div>
                          )}
                        </>
                      )}
                    </td>
                    <td className={tdChuan + ' text-right'}>
                      <input
                        data-nut={'phimuandt-' + row.cardTypeId}
                        className={inputCls + ' w-24 text-right text-xs tabular-nums'}
                        inputMode="decimal"
                        placeholder="—"
                        value={muaNdt[row.cardTypeId] ?? ''}
                        onChange={(e) => setMuaNdt((s2) => ({ ...s2, [row.cardTypeId]: e.target.value }))}
                      />
                    </td>
                  </tr>
                  );
                })}
                <HangDem soCot={5} />
              </tbody>
              <tfoot className={tfootChuan}>
                <tr className={trTongChuan}>
                  <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={5}>
                    TỔNG {rows.length} loại thẻ · tùy chỉnh {rows.filter((r) => (mode[r.cardTypeId] ?? 'quote') === 'custom').length}
                  </td>
                </tr>
              </tfoot>
            </table>
          </KhungBang>
          {!anyCustom && (
            <div className="mt-2 text-xs text-slate-500">
              Tất cả loại thẻ đang dùng <b>Niêm yết</b> → chưa đặt giá bán thực tế. Bill đại lý sẽ hiện “chưa cấu hình giá bán”.
            </div>
          )}
        </>
      )}
    </>
  );
}

// SellFeeSection — khối "Giá bán thực tế (thỏa thuận khi giao)" nhúng trong Giao/Gán TID + Thêm-TID-giao-ngay.
// Nguồn = discriminated: `tidId` (TID đã có) HOẶC `bankPartner` (TID chưa có — luồng Thêm TID) — pass-through editor.
function SellFeeSection({ tidId, bankPartner, at, onChange }: { tidId?: number; bankPartner?: { bankId: number; partnerId: number }; at?: string; onChange: (snap: SellFeeSnapshot) => void }): JSX.Element {
  return (
    // [đo thật 16/11] khối này cao 404px — thủ phạm duy nhất làm hộp "Gán máy POS" còn phải cuộn 124px.
    // Rút lời dẫn còn 1 dòng + cho RIÊNG bảng loại thẻ tự cuộn khi ngân hàng có nhiều thẻ, để hộp thoại
    // NGOÀI không bao giờ phải cuộn (Admin Demo: "full view không cuộn").
    <div className="rounded-xl border border-line bg-appbg/40 p-3">
      <div className="mb-1 text-sm font-medium text-slate-700">Giá bán thực tế (thỏa thuận khi giao)</div>
      <p className="mb-2 text-xs text-slate-500">
        Để <b>trống</b> = áp giá <b>niêm yết</b>; chỉ dòng nào khác niêm yết mới cần nhập. Sửa lại sau ở màn “Phí bán thực tế”.
      </p>
      <div className="max-h-[42vh] overflow-auto">
        <SellFeeEditor tidId={tidId} bankPartner={bankPartner} at={at} onChange={onChange} />
      </div>
    </div>
  );
}

function TidSellFeeModal({ tid, onClose, onSaved }: { tid: TidDto; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState<SellFeeSnapshot | null>(null);
  // [B221 20/11 — Admin Demo "cho chọn thời gian áp dụng từ bao giờ"] TRƯỚC ĐÂY màn này KHÔNG gửi mốc hiệu lực
  // nên máy chủ luôn lấy HÔM NAY ⇒ giá mới không bao giờ áp được cho bill đã ghi. Nay cho chọn mốc; chọn lùi
  // về quá khứ thì máy chủ tính LẠI doanh số các bill từ mốc đó (bill đã đối soát/đã hoàn vẫn được giữ nguyên).
  const homNay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const [apDungTu, setApDungTu] = useState<string>(homNay);

  async function save(): Promise<void> {
    if (!snap || !snap.hasRows) return;
    if (!snap.defaultFeeTypeId) { toast.alert('Vui lòng chọn loại phí.'); return; }
    // VALIDATE client — bán < phí mua niêm yết / phí mua null / ngoài 0–100 → CHẶN (editor đã hiện đỏ inline).
    if (snap.invalid) { toast.alert(snap.invalidReason ?? 'Giá bán thực tế không hợp lệ.', 'Không lưu được'); return; }
    setBusy(true);
    const res = await window.api.tidSellFeeSet({
      tidId: tid.id,
      feeTypeId: snap.defaultFeeTypeId,
      entries: snap.sellFees,
      effectiveFrom: apDungTu || undefined
    });
    setBusy(false);
    if (res.ok) {
      // [B221] NÓI RÕ hệ quả, không chỉ "đã lưu": bao nhiêu bill bị tính lại, có trả dư không, bill nào
      // bị bỏ qua. Im lặng ở chỗ sửa TIỀN là nguy hiểm nhất.
      const r = res as { overpaid?: unknown[]; grandfathered?: unknown[]; duoiPhiMua?: { phiBan: number; phiMua: number; loPct: number }[]; loDaSua?: number; loBoQua?: string[] };
      const phan: string[] = ['Đã lưu giá bán, áp dụng từ ' + (apDungTu || homNay) + '.'];
      if (r.overpaid?.length) phan.push('CÓ ' + r.overpaid.length + ' giao dịch nay thành TRẢ DƯ — phải hoàn lại tay.');
      if (r.grandfathered?.length) phan.push(r.grandfathered.length + ' giao dịch CŨ (ghi bằng giá niêm yết) được GIỮ NGUYÊN, không tính lại.');
      // [B223] Báo rõ phần BILL (lô) đã được chỉnh tiền theo giá mới, và lô nào KHÔNG chỉnh được vì sao —
      // im lặng ở đây là người dùng tưởng cả sổ đã đổi trong khi vài lô giữ số cũ.
      if (r.loDaSua) phan.push('Đã chỉnh tiền của ' + r.loDaSua + ' bill cho khớp giá mới.');
      if (r.loBoQua?.length) phan.push('KHÔNG chỉnh được ' + r.loBoQua.length + ' bill: ' + r.loBoQua.slice(0, 3).join('; ') + '.');
      if (r.duoiPhiMua?.length) {
        const d = r.duoiPhiMua[0];
        phan.push('Lưu ý: giá bán ' + d.phiBan + '% THẤP HƠN giá vốn ' + d.phiMua + '% — mỗi bill lỗ ' + d.loPct + '%.');
      }
      if (phan.length > 1) toast.alert(phan.join(' '), 'Đã lưu — có điều cần biết');
      else toast.success(phan[0]);
      onSaved();
    } else {
      baoLoi(toast.alert, res, 'Lưu phí bán thất bại');
    }
  }

  return (
    <Modal title={`Phí bán thực tế — TID ${tid.tid}`} onClose={onClose} onSubmit={() => void save()}>
      <p className="mb-3 text-sm text-slate-500">
        Mỗi <span className="font-medium text-slate-600">loại thẻ</span> chọn 1 trong 2: <span className="font-medium text-slate-600">Niêm yết</span> (dùng % niêm yết của loại phí) hoặc{' '}
        <span className="font-medium text-slate-600">Tùy chỉnh</span> (nhập % phí bán thực tế khi giao máy). Chọn Niêm yết = không tạo phí tùy chỉnh.
      </p>
      {/* [B221] MỐC ÁP DỤNG — mặc định hôm nay. Lùi về quá khứ là tính lại doanh số đã ghi, nên phải nói rõ. */}
      <div className="mb-3 rounded-lg border border-line bg-appbg/50 p-3">
        <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-700">
          Áp dụng từ ngày
          <input
            type="date"
            data-nut="apdungtu"
            className={inputCls + ' w-[170px]'}
            value={apDungTu}
            max={homNay}
            onChange={(e) => setApDungTu(e.target.value)}
          />
        </label>
        <p className="mt-1.5 text-[12px] leading-snug text-slate-500">
          Để <b>hôm nay</b> thì chỉ bill từ hôm nay trở đi dùng giá mới. Chọn <b>ngày cũ hơn</b> thì
          <b> các bill đã ghi từ ngày đó sẽ được tính lại</b> theo giá mới — bill đã đối soát hoặc đã hoàn tiền
          vẫn giữ nguyên, và app sẽ báo lại số liệu bị ảnh hưởng sau khi lưu.
        </p>
      </div>
      <SellFeeEditor tidId={tid.id} onChange={setSnap} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>
          Hủy
        </Button>
        <Button variant="confirm" onClick={() => void save()} disabled={busy || !snap?.hasRows}>
          {busy ? 'Đang lưu…' : 'Lưu phí bán'}
        </Button>
      </div>
    </Modal>
  );
}

function TidTimelineModal({ tid, onClose }: { tid: TidDto; onClose: () => void }): JSX.Element {
  const [events, setEvents] = useState<TimelineEventDto[] | null>(null);
  useEffect(() => {
    window.api.tidTimeline(tid.tid).then((r) => setEvents(r.ok && r.data ? r.data : []));
  }, [tid.tid]);

  return (
    <Modal title={`Vòng đời TID ${tid.tid}`} onClose={onClose}>
      {!events && <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />}
      {events && events.length === 0 && <p className="text-sm text-slate-400">Chưa có sự kiện — TID mới cấp, chưa gán/giao.</p>}
      {events && events.length > 0 && (
        <ol className="relative ml-3 border-l border-line">
          {events.map((e) => (
            <li key={e.id} className="mb-5 ml-5">
              <span className="absolute -left-[7px] mt-1 h-3 w-3 rounded-full bg-brand" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-brand-tint px-1.5 py-0.5 text-xs font-medium text-brand">{TID_EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                {e.fromState && (
                  <span className="text-xs text-slate-400">
                    {TID_STATE_LABELS[e.fromState] ?? e.fromState} → {e.toState ? (TID_STATE_LABELS[e.toState] ?? e.toState) : ''}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-slate-500">{fmtDate(e.occurredAt)}</div>
              {e.customerName && TID_CUSTOMER_EVENT_TYPES.has(e.eventType) && (
                <div className="mt-0.5 text-xs text-slate-500">Khách: <span className="font-medium text-slate-700">{e.customerName}</span></div>
              )}
              {e.warehouseName && (
                <div className="mt-0.5 text-xs text-slate-500">Về kho: <span className="font-medium text-slate-700">{e.warehouseName}</span>{e.deliveryAddress ? ` — ${e.deliveryAddress}` : ''}</div>
              )}
              {e.handoverName && (
                <div className="mt-0.5 text-xs text-slate-500">
                  · <span className="font-medium text-slate-700">{e.handoverName}</span>
                  {e.handoverAmount != null && <span className="ml-1 font-medium text-slate-700">{money(e.handoverAmount)}</span>}
                </div>
              )}
              {e.actorName && (
                <div className="mt-0.5 text-xs text-slate-500">Người thực hiện: <span className="font-medium text-slate-700">{e.actorName}</span></div>
              )}
              {e.note && <div className="mt-0.5 text-sm text-slate-600">{e.note}</div>}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
