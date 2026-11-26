import { useEffect, useState, useRef } from 'react';
import { baoLoi } from '../lib/bao-loi';
// `Undo2` đã bỏ: nút rời "Cần thu hồi" chuyển thành Ô TÍCH trong thanh lọc (mẫu chốt 6/11 §4).
import { Loader2, HardDrive, History, Wrench, Download, List, PackagePlus, Building2, Cpu, Tag, Trash2, Banknote, Pencil, Warehouse as WarehouseIcon, PackageOpen } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, hasAnyPermission, fmtDate, fmtTimeSec, groupDigits } from '@sigma/shared';
import type { PosDto, TimelineEventDto, CustomerDto, FundDto, LiteRef, WarehouseLite, UpdatePosInput, HandoverTypeLite, BankLite } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { Button } from '../components/Button.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { RequestCancelModal, BulkRequestCancelModal, type RequestCancelTarget } from '../components/RequestCancelModal.js';
import { MONEY_KIND_LABEL } from './HandoverConfigPage.js';
import { StatusBadge, useStatusOptions, toneCls } from '../components/StatusBadge.js';
import { StatBar } from '../components/StatBar.js';
import { StaleBanner } from '../lib/realtime.js';
import { Field, inputCls } from '../components/Field.js';
import { CustomerPicker } from '../components/CustomerPicker.js';
import { FilterBar } from '../components/FilterBar.js';
import { TabBar, TabButton } from '../components/Tabs.js';
import { useRowSelection, SelectionBar, SelectAllCell, SelectCell } from '../components/Selection.js';
import { useDanhSachDayDu } from '../components/Pagination.js';
import { exportCsv } from '../lib/exportCsv.js';
// MẪU THIẾT KẾ CHỐT 6/11 — kiểu bảng lấy từ MODULE DÙNG CHUNG, CẤM chép chuỗi class vào trang.
import { KhungBang, thChuan, tdChuan, tdTongChuan, tdTien, trChuan, theadChuan, tfootChuan, trTongChuan, tdTrong, HangDem } from '../components/BangChuan.js';
// PHASE K1 — hợp nhất: các tab cấu hình cung ứng POS dùng lại nguyên các panel của PosSupplyPage.
import { SupplierTab, ModelTab, StatusTab, IntakeTab } from './PosSupplyPage.js';
// Nhóm 1 — "Danh mục kho" gộp thành TAB ĐẦU của trang này (tái dùng nguyên component, không viết lại).
import { WarehousePage } from './WarehousePage.js';
// PHASE 2 — tab "Yêu cầu xuất kho" (tạo phiếu POS chưa seri → duyệt sau).
import { ExportRequestPanel } from '../components/ExportRequestPanel.js';

/** Định dạng tiền VND (nhóm 3 chữ số kiểu Việt Nam) — không dùng toLocaleString. */
function fmtVnd(n: number | null): string {
  if (n == null) return '—';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' ₫';
}
/** Tiền DÙNG TRONG BẢNG: BỎ ký hiệu ₫ (mẫu chốt 6/11 §2 — trong bảng không in đơn vị). */
function vndBang(n: number | null): string {
  if (n == null) return '—';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

type PosTab = 'warehouse' | 'devices' | 'exportreq' | 'intake' | 'supplier' | 'model' | 'status';

/** PHASE K1 (§2.3) — 1 trang "Quản Lý Máy POS" nhiều tab. Danh sách máy (POS_*) + cấu hình cung ứng
 * (CONFIG_POS_SUPPLY_*). Ẩn/hiện từng tab theo quyền (rủi ro #4: quyền lệch sau gộp menu). */
export function PosPage({ user, initialSearch }: { user: AuthUser; initialSearch?: string }): JSX.Element {
  const canView = hasPermission(user, 'POS_VIEW');
  const canConfigView = hasPermission(user, 'CONFIG_POS_SUPPLY_VIEW');
  const canConfigManage = hasPermission(user, 'CONFIG_POS_SUPPLY_MANAGE');
  const canWarehouseView = hasPermission(user, 'CONFIG_WAREHOUSE_VIEW');
  const canExportReq = hasAnyPermission(user, ['EXPORT_REQUEST_VIEW', 'EXPORT_REQUEST_CREATE']);

  const allTabs: { key: PosTab; label: string; icon: JSX.Element; show: boolean }[] = [
    { key: 'devices', label: 'Danh sách máy', icon: <List className="h-4 w-4" />, show: canView },
    // PHASE 2 — cụm "Yêu cầu xuất kho" POS (tạo phiếu chưa seri; duyệt ở trang "Duyệt xuất kho").
    { key: 'exportreq', label: 'Yêu cầu xuất kho', icon: <PackageOpen className="h-4 w-4" />, show: canExportReq },
    { key: 'intake', label: 'Nhập kho', icon: <PackagePlus className="h-4 w-4" />, show: canConfigView },
    { key: 'supplier', label: 'Nhà cung cấp', icon: <Building2 className="h-4 w-4" />, show: canConfigView },
    { key: 'model', label: 'Chủng loại POS', icon: <Cpu className="h-4 w-4" />, show: canConfigView },
    { key: 'status', label: 'Trạng thái nhập', icon: <Tag className="h-4 w-4" />, show: canConfigView },
    // Nhóm 1 (Admin Demo 13/7) — "Danh sách kho" chuyển sang NGOÀI CÙNG, cạnh "Trạng thái nhập".
    { key: 'warehouse', label: 'Danh sách kho', icon: <WarehouseIcon className="h-4 w-4" />, show: canWarehouseView }
  ];
  const tabs = allTabs.filter((t) => t.show);

  const [tab, setTab] = useState<PosTab>(tabs[0]?.key ?? 'devices');

  return (
    /* `data-nut-vuong` để trang ăn luật NÚT + THANH CUỘN của mau-moi.css (nạp ở main.tsx). */
    <div data-nut-vuong data-trang-full>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-800">Quản Lý Máy POS</h2>
        <p className="text-sm text-slate-500">Danh sách máy (nguồn sự thật) · nhập kho · nhà cung cấp · chủng loại · trạng thái nhập.</p>
      </div>
      <TabBar>
        {tabs.map((t) => (
          <TabButton key={t.key} active={tab === t.key} onClick={() => setTab(t.key)} icon={t.icon}>
            {t.label}
          </TabButton>
        ))}
      </TabBar>
      {tab === 'warehouse' && <WarehousePage user={user} />}
      {tab === 'devices' && <DeviceListTab user={user} initialSearch={initialSearch} />}
      {tab === 'exportreq' && <ExportRequestPanel user={user} kind="POS" />}
      {tab === 'intake' && <IntakeTab canManage={canConfigManage} />}
      {tab === 'supplier' && <SupplierTab canManage={canConfigManage} />}
      {tab === 'model' && <ModelTab canManage={canConfigManage} />}
      {tab === 'status' && <StatusTab canManage={canConfigManage} />}
    </div>
  );
}

/** Nút thao tác CHỈ ICON (chống tràn cột Thao tác) — hover hiện nhãn chữ TO RÕ (Admin Demo 13/7). */
function IconAction({ label, tone, onClick, children }: { label: string; tone: 'slate' | 'warning' | 'emerald' | 'danger'; onClick: () => void; children: JSX.Element }): JSX.Element {
  const toneCls: Record<string, string> = {
    slate: 'border-line text-slate-600 hover:bg-appbg',
    warning: 'border-warning/40 bg-warning/5 text-warning hover:brightness-110',
    emerald: 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:brightness-105',
    danger: 'border-danger/30 bg-danger/5 text-danger hover:brightness-110'
  };
  return (
    <button onClick={onClick} title={label} aria-label={label} className={`group relative rounded-md border p-1.5 ${toneCls[tone]}`}>
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-800 px-3 py-1.5 text-sm font-bold text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
        {label}
      </span>
    </button>
  );
}

/** Tab [Danh sách máy] — nguồn PosDevice. StatBar theo status + hành động vòng đời máy. */
function DeviceListTab({ user, initialSearch }: { user: AuthUser; initialSearch?: string }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<PosDto[]>([]);
  const [models, setModels] = useState<LiteRef[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseLite[]>([]); // Model 1 — lọc theo kho
  const [banks, setBanks] = useState<BankLite[]>([]); // Cài APP — lọc theo app ngân hàng
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(initialSearch ?? ''); // nhảy từ ô tìm kiếm topbar → lọc sẵn theo serial đã chọn
  const [statusFilter, setStatusFilter] = useState('');
  // LANE B (#24) — lọc "Chủng loại" phía client trên tập rows (posList trả full, không phân trang).
  const [modelFilter, setModelFilter] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState(''); // Model 1 — lọc theo kho vật lý (server-side)
  const [bankFilter, setBankFilter] = useState(''); // Cài APP — '' tất cả · 'BLANK' máy trắng · '<id>' app ngân hàng
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [timelineOf, setTimelineOf] = useState<PosDto | null>(null);
  const [actionOf, setActionOf] = useState<{ device: PosDto; event: string } | null>(null);
  const [saleTarget, setSaleTarget] = useState<PosDto | null>(null);
  const [cancelTarget, setCancelTarget] = useState<RequestCancelTarget | null>(null);
  const [editTarget, setEditTarget] = useState<PosDto | null>(null); // Nhóm 1 — sửa hồ sơ máy
  const [bulkCancel, setBulkCancel] = useState(false); // Nhóm 1 — yêu cầu hủy hàng loạt (qua Duyệt Hủy)
  const [onlyRecall, setOnlyRecall] = useState(false); // #6 — lọc "cần thu hồi"
  const sel = useRowSelection();

  const canManage = hasPermission(user, 'POS_MANAGE');
  const canSell = hasPermission(user, 'DEVICE_SALE_MANAGE');
  const canCancelReq = hasPermission(user, 'POS_CANCEL_REQUEST');
  // R14 — danh mục trạng thái máy POS (entity POS_DEVICE) từ catalog tùy biến.
  const { options: posOptions, byCode: posByCode } = useStatusOptions('POS_DEVICE');
  const posStatusLabel = (code: string): string => posByCode.get(code)?.label ?? code;

  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    sel.clear();
    try {
      const res = await window.api.posList({
        search: search || undefined,
        status: statusFilter || undefined,
        warehouseId: warehouseFilter ? Number(warehouseFilter) : undefined,
        bankBlank: bankFilter === 'BLANK' ? true : undefined,
        bankId: bankFilter && bankFilter !== 'BLANK' ? Number(bankFilter) : undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined
      });
      if (res.ok && res.data) setRows(res.data);
      else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
    } catch (e) {
      // FE-03 (Codex 15/7): IPC reject không được để spinner treo mãi.
      toast.alert(e instanceof Error ? e.message : 'Không tải được dữ liệu (mất kết nối máy chủ?).', 'Lỗi tải dữ liệu');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    window.api.posModelLite().then((r) => r.ok && r.data && setModels(r.data));
    window.api.warehouseLite().then((r) => r.ok && r.data && setWarehouses(r.data));
    window.api.bankLite().then((r) => r.ok && r.data && setBanks(r.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Đổi kho / Cài APP là lọc lại ngay (server-side).
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseFilter, bankFilter]);

  // Lọc chủng loại (client-side) trên tập đã lọc phía server. Ưu tiên posModelId; nếu DTO thiếu id
  // nhưng có tên khớp option đang chọn thì fallback theo posModelName.
  const selectedModel = models.find((m) => String(m.id) === modelFilter);
  const filteredRows = (modelFilter
    ? rows.filter((d) =>
        d.posModelId != null
          ? String(d.posModelId) === modelFilter
          : !!selectedModel && d.posModelName === selectedModel.name
      )
    : rows
  ).filter((d) => (onlyRecall ? d.recallPending : true));
  const recallCount = rows.filter((d) => d.recallPending).length;
  // Admin Demo 13/11 — BỎ PHÂN TRANG: vẽ HẾT máy đã lọc, cuộn trong khung bảng. Tích chọn/bulk vì thế
  // chạy trên TOÀN BỘ tập đang lọc (trước đây chỉ trang hiện tại). Số lượng xem ở hàng TỔNG ghim đáy.
  const { pageRows } = useDanhSachDayDu(filteredRows);

  // "Xóa lọc" phải trả MỌI ô lọc về mặc định (mẫu chốt 6/11 §4). Trước đây BỎ SÓT `bankFilter`
  // (Cài APP) và `onlyRecall` (Cần thu hồi) ⇒ 2 bộ lọc còn dính im lặng sau khi bấm Xóa lọc.
  function resetFilters(): void {
    setSearch('');
    setStatusFilter('');
    setModelFilter('');
    setWarehouseFilter('');
    setBankFilter('');
    setOnlyRecall(false);
    setFromDate('');
    setToDate('');
    setTimeout(() => reloadRef.current(), 0);
  }

  // SỐ CỘT bảng máy — 1 biến duy nhất cho hàng rỗng / hàng đệm / hàng TỔNG.
  const soCot = 16 + (canCancelReq ? 1 : 0); // [15/11] +STT +NGÀY XUẤT +GIÁ XUẤT +GHI CHÚ
  // Tổng GIÁ NHẬP của TOÀN BỘ tập đang lọc (cùng tập với bộ đếm "N máy POS" ở trên) — không lấy nguồn khác.
  const tongGiaNhap = filteredRows.reduce((s, d) => s + (d.importPrice ?? 0), 0);

  return (
    <div>
      <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
        <div className="shrink-0 text-xs text-slate-500">{filteredRows.length} máy POS</div>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="confirm"
            data-nut="excel"
            icon={<Download className="h-4 w-4" />}
            onClick={() =>
              exportCsv(
                'may_pos',
                // [Admin Demo 15/11] File xuất đi ĐÚNG thứ tự + đúng tên cột như trên bảng (kể cả GHI CHÚ, KHO,
                // NGÀY XUẤT, GIÁ XUẤT) — xuất mà lệch bảng là người đọc file phải đoán.
                ['STT', 'NCC', 'LOẠI', 'DÒNG MÁY', 'SERIAL', 'APP', 'TID', 'HKD', 'NGÀY NHẬP', 'GIÁ NHẬP', 'KHO', 'KHÁCH', 'NGÀY XUẤT', 'GIÁ XUẤT', 'GHI CHÚ'],
                filteredRows.map((d, i) => [i + 1, d.supplierName ?? '', posStatusLabel(d.status), d.posModelName ?? '', d.serial, d.bankCode ?? 'Máy trắng', d.currentTid ?? '', d.currentTid ? (d.hkdName ?? '') : '', d.importedAt ? fmtDate(d.importedAt) : '', d.importPrice ?? '', d.warehouseName ?? '', d.customerName ?? '', d.exportedAt ? fmtDate(d.exportedAt) : '', d.exportPrice ?? '', d.note ?? ''])
              )
            }
          >
            Xuất Excel
          </Button>
          {/* "Xóa lọc" / "Làm mới" đặt Ở THANH CÔNG CỤ (FilterBar nhận hideReset/hideRefresh) — y hệt
              bản mẫu đã duyệt: chỉ nút mang `data-nut` mới được mau-moi.css khoá bề ngang 119px. */}
          <Button variant="soft" data-nut="xoaloc" onClick={resetFilters} title="Xóa toàn bộ bộ lọc, đưa về mặc định">Xóa lọc</Button>
          <Button variant="soft" data-nut="lammoi" onClick={() => void reload()} title="Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc)">Làm mới</Button>
        </div>
      </div>

      {/* Thanh lọc: 1 HÀNG, chữ nhỏ (`coChuNho`), nút "Lọc" căn mép phải (`locPhai`).
          4 dropdown + 2 ngày + ô tìm không vừa 1150px ⇒ cho hàng lọc CUỘN NGANG trong khung của nó,
          nhờ vậy vẫn "1 hàng" mà TRANG không tràn ngang. */}
      <div className="overflow-x-auto">
      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Tìm serial / TID…"
        fromDate={fromDate}
        toDate={toDate}
        onFromDate={setFromDate}
        onToDate={setToDate}
        coChuNho
        locPhai
        oTich={recallCount > 0 ? [
          // "Cần thu hồi" là điều kiện BẬT/TẮT 1 trạng thái ⇒ ô TÍCH, không phải nút rời (mẫu chốt §4).
          { key: 'recall', nhan: `Cần thu hồi (${recallCount})`, value: onlyRecall, onChange: setOnlyRecall, title: 'Chỉ hiện máy khách đã hủy mà chưa thu về' }
        ] : []}
        selects={[
          { key: 'status', placeholder: 'Tất cả trạng thái', value: statusFilter, options: posOptions.filter((o) => o.active).map((o) => ({ value: o.code, label: o.label })), onChange: setStatusFilter },
          // Lọc chủng loại (client-side) — đổi giá trị là lọc ngay, không cần bấm "Lọc".
          { key: 'model', placeholder: 'Tất cả chủng loại', value: modelFilter, options: models.map((m) => ({ value: String(m.id), label: m.name })), onChange: setModelFilter },
          // Model 1 — lọc theo KHO đang chứa máy (server-side). "Chưa gán kho" bắt máy IN_STOCK chưa có kho.
          { key: 'warehouse', placeholder: 'Tất cả kho', value: warehouseFilter, options: warehouses.map((w) => ({ value: String(w.id), label: `${w.code} · ${w.name}` })), onChange: setWarehouseFilter },
          // Cài APP — lọc theo app ngân hàng (server-side). "Máy trắng" = máy chưa cài app.
          { key: 'bankapp', placeholder: 'Tất cả Cài APP', value: bankFilter, options: [{ value: 'BLANK', label: 'Máy trắng' }, ...banks.map((b) => ({ value: String(b.id), label: `${b.code}` }))], onChange: setBankFilter }
        ]}
        onApply={reload}
        onReset={resetFilters}
        hideReset
        hideRefresh
      />
      </div>

      {/* Bộ đếm (đếm CLIENT từ posList — trả full, không phân trang; theo tập kết quả lọc hiện tại). */}
      <StatBar
        items={[
          { label: 'Tổng máy', value: filteredRows.length, tone: 'bg-brand-tint text-brand' },
          ...posOptions.filter((o) => o.active).map((o) => ({
            label: o.label,
            value: filteredRows.filter((d) => d.status === o.code).length,
            tone: toneCls(o.tone)
          }))
        ]}
      />
      {/* Admin Demo 14/7 — bộ đếm theo CÀI APP (ngân hàng) — đếm CLIENT từ tập đã lọc (gồm Máy trắng). */}
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Cài APP (ngân hàng)</div>
      <div className="mb-3 flex flex-wrap gap-2">
        <span className="rounded-full border border-line bg-white px-3 py-1 text-xs text-slate-600">Máy trắng: <b className="text-slate-500">{filteredRows.filter((d) => !d.bankCode).length}</b></span>
        {banks.map((b) => (
          <span key={b.id} className="rounded-full border border-line bg-white px-3 py-1 text-xs text-slate-600">
            {b.code}: <b className="text-brand">{filteredRows.filter((d) => d.bankCode === b.code).length}</b>
          </span>
        ))}
      </div>

      {canCancelReq && <SelectionBar count={sel.count} entityLabel="máy POS" onClear={sel.clear} onDelete={() => setBulkCancel(true)} actionLabel={`Yêu cầu hủy (${sel.count})`} />}
      <StaleBanner domain="Pos" onReload={reload} className="mb-2" />
      <KhungBang className="list-scroll bg-white shadow-sm">
        {/* 17 cột → `min-w` cho CUỘN NGANG chủ ý; số cột CỐ ĐỊNH ở mọi bề ngang (CẤM ẩn cột theo breakpoint). */}
        <table className="w-full min-w-[2120px] text-xs">
          <thead className={theadChuan}>
            {/* Nền trên `<tr>`: ô checkbox do SelectAllCell (module chung) render, không mang `thChuan`. */}
            <tr className="bg-slate-200">
              {canCancelReq && <SelectAllCell ids={pageRows.map((r) => r.id)} sel={sel} />}
              {/* [Admin Demo 15/11] THỨ TỰ + TÊN CỘT chốt: STT · NCC · LOẠI · DÒNG MÁY · SERIAL · APP · NGÀY NHẬP ·
                  GIÁ NHẬP · KHO · NGÀY XUẤT · GIÁ XUẤT · GHI CHÚ — rồi mới tới 4 cột giữ lại (TID/HKD/Khách/Thao tác).
                  Bề ngang: SERIAL 140→119, GIÁ NHẬP 130→110, THAO TÁC 240→204 (hẹp 15% theo yêu cầu). */}
              {/* [Admin Demo 15/11] THỨ TỰ CHỐT: STT · NCC · DÒNG MÁY · SERIAL · APP · NGÀY NHẬP · GIÁ NHẬP ·
                  KHO · THAO TÁC · TID · HKD · KHÁCH · NGÀY XUẤT · GIÁ XUẤT · GHI CHÚ.
                  Bề ngang theo yêu cầu: STT −10% (60→54) · DÒNG MÁY −20% (130→104) · APP −20% (110→88) ·
                  KHO −20% (150→120) · SERIAL −15% (140→119) · GIÁ NHẬP −15% · THAO TÁC −15%. */}
              {/* [Admin Demo 15/11] THỨ TỰ CHỐT: STT · NCC · LOẠI · DÒNG MÁY · SERIAL · APP · THAO TÁC · TID · HKD ·
                  NGÀY NHẬP · GIÁ NHẬP · KHO · KHÁCH · NGÀY XUẤT · GIÁ XUẤT · GHI CHÚ · LOẠI (ngoài cùng).
                  Bề ngang: STT −10% · DÒNG MÁY −20% · APP −20% · KHO −20% · SERIAL/GIÁ NHẬP/THAO TÁC −15%. */}
              <th className={thChuan + ' w-[54px] text-center'}>STT</th>
              <th className={thChuan + ' w-[150px]'}>NCC</th>
              <th className={thChuan + ' w-[130px] text-center'}>LOẠI</th>
              <th className={thChuan + ' w-[104px] text-center'}>DÒNG MÁY</th>
              <th className={thChuan + ' w-[119px] text-center'}>SERIAL</th>
              <th className={thChuan + ' w-[88px] text-center'}>APP</th>
              <th className={thChuan + ' w-[204px]'}>THAO TÁC</th>
              <th className={thChuan + ' w-[120px] text-center'}>TID</th>
              <th className={thChuan + ' w-[210px]'}>HKD</th>
              <th className={thChuan + ' w-[100px] text-center'}>NGÀY NHẬP</th>
              <th className={thChuan + ' w-[110px]'}>GIÁ NHẬP</th>
              <th className={thChuan + ' w-[120px] text-center'}>KHO</th>
              <th className={thChuan + ' w-[150px] text-center'}>KHÁCH</th>
              <th className={thChuan + ' w-[100px] text-center'}>NGÀY XUẤT</th>
              <th className={thChuan + ' w-[110px]'}>GIÁ XUẤT</th>
              <th className={thChuan + ' w-[180px]'}>GHI CHÚ</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={soCot} className={tdTrong}>
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            )}
            {!loading && filteredRows.length === 0 && (
              <tr>
                <td colSpan={soCot} className={tdTrong}>
                  <HardDrive className="mx-auto mb-2 h-6 w-6" />
                  {rows.length === 0 ? 'Chưa có máy POS.' : 'Không có máy POS khớp bộ lọc.'}
                </td>
              </tr>
            )}
            {!loading &&
              pageRows.map((d, i) => (
                /* Sọc ngựa vằn; dòng đang tích nổi bật vàng (trChuan). */
                <tr key={d.id} className={trChuan(i, sel.isSelected(d.id))}>
                  {canCancelReq && <SelectCell id={d.id} sel={sel} />}
                  {/* [Admin Demo 15/11] thứ tự ô PHẢI khớp y hệt hàng tiêu đề ở trên. */}
                  <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{i + 1}</td>
                  <td className={tdChuan + ' text-center text-slate-600'}>{d.supplierName ?? '—'}</td>
                  <td className={tdChuan + ' text-center'}>
                    <StatusBadge entity="POS_DEVICE" code={d.status} />
                  </td>
                  <td className={tdChuan + ' text-center text-slate-600'}>{d.posModelName ?? '—'}</td>
                  <td className={tdChuan + ' text-center font-mono font-semibold text-slate-700'}>{d.serial}</td>
                  <td className={tdChuan + ' text-center'}>
                    {d.bankCode
                      ? <span className="rounded-full bg-brand-tint/60 px-2 py-0.5 font-semibold text-brand">{d.bankCode}</span>
                      : <span className="text-slate-400">Máy trắng</span>}
                  </td>
                  <td className={tdChuan}>
                    <div className="flex items-center justify-center gap-1.5">
                      <IconAction label="Vòng đời" tone="slate" onClick={() => setTimelineOf(d)}><History className="h-5 w-5" /></IconAction>
                      {d.recallPending && (
                        <span title="Khách đã hủy — máy chưa thu về" className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning whitespace-nowrap">Cần thu hồi</span>
                      )}
                      {canManage && (
                        <IconAction label="Sửa hồ sơ máy" tone="warning" onClick={() => setEditTarget(d)}><Pencil className="h-5 w-5" /></IconAction>
                      )}
                      {canManage && (NEXT[d.status]?.length ?? 0) > 0 && (
                        <select
                          className="w-[104px] rounded-md border border-line px-1.5 py-1.5 text-xs text-slate-600 hover:bg-appbg"
                          value=""
                          onChange={(e) => e.target.value && setActionOf({ device: d, event: e.target.value })}
                        >
                          <option value="">Thao tác…</option>
                          {NEXT[d.status].map((n) => (
                            <option key={n.key} value={n.key}>
                              {n.label}
                            </option>
                          ))}
                        </select>
                      )}
                      {canSell && (d.status === 'IN_STOCK' || d.status === 'DEPLOYED') && (
                        <IconAction label="Bán máy (kèm TID nếu có)" tone="emerald" onClick={() => setSaleTarget(d)}><Banknote className="h-5 w-5" /></IconAction>
                      )}
                      {canCancelReq && (
                        <IconAction label="Yêu cầu hủy" tone="danger" onClick={() => setCancelTarget({ entityType: 'PosDevice', entityId: d.id, entityLabel: d.serial, typeLabel: 'máy POS' })}><Trash2 className="h-5 w-5" /></IconAction>
                      )}
                    </div>
                  </td>
                  <td className={tdChuan + ' text-center font-mono font-semibold tabular-nums text-slate-600'}>{d.currentTid ?? '—'}</td>
                  <td className={tdChuan + ' max-w-[210px] truncate text-center text-slate-600'} title={d.hkdName ?? ''}>{d.currentTid ? (d.hkdName ?? '—') : '—'}</td>
                  <td className={tdChuan + ' text-center text-slate-500'}>{d.importedAt ? fmtDate(d.importedAt) : '—'}</td>
                  {/* Cột TIỀN: tdTien — căn phải · tabular-nums · slate-800 · không in đậm · bỏ ₫ trong bảng. */}
                  <td className={tdTien}>{vndBang(d.importPrice)}</td>
                  <td className={tdChuan + ' text-center text-slate-600'}>{d.warehouseName ?? (d.status === 'IN_STOCK' ? <span className="text-amber-500">Chưa gán kho</span> : '—')}</td>
                  <td className={tdChuan + ' max-w-[150px] truncate text-center text-slate-600'} title={d.customerName ?? ''}>{d.customerName ?? '—'}</td>
                  <td className={tdChuan + ' text-center text-slate-500'}>{d.exportedAt ? fmtDate(d.exportedAt) : '—'}</td>
                  <td className={tdTien}>{vndBang(d.exportPrice)}</td>
                  <td className={tdChuan + ' max-w-[180px] truncate text-center text-slate-600'} title={d.note ?? ''}>{d.note ?? '—'}</td>
                </tr>
              ))}
            <HangDem soCot={soCot} />
          </tbody>
          {/* Hàng TỔNG ghim đáy — tổng GIÁ NHẬP của TOÀN BỘ tập đang lọc (cùng tập với bộ đếm phía trên). */}
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              {/* GIÁ NHẬP nay là cột thứ 11 ⇒ 10 cột đứng trước (+ ô tích chọn nếu có), và 5 cột còn lại phía sau. */}
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={10 + (canCancelReq ? 1 : 0)}>
                TỔNG {filteredRows.length} máy (toàn bộ bộ lọc)
              </td>
              <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{vndBang(tongGiaNhap)}</td>
              <td className={tdTongChuan} colSpan={5} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>

      {timelineOf && <TimelineModal device={timelineOf} onClose={() => setTimelineOf(null)} />}
      {actionOf && (
        <TransitionModal
          device={actionOf.device}
          event={actionOf.event}
          onClose={() => setActionOf(null)}
          onDone={async () => {
            setActionOf(null);
            await reload();
          }}
          onOpenSell={
            canSell
              ? () => {
                  const d = actionOf.device;
                  setActionOf(null);
                  setSaleTarget(d);
                }
              : undefined
          }
        />
      )}
      {saleTarget && (
        <SellDeviceModal
          device={saleTarget}
          onClose={() => setSaleTarget(null)}
          onDone={async () => {
            setSaleTarget(null);
            await reload();
          }}
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
      {editTarget && (
        <EditDeviceModal
          device={editTarget}
          onClose={() => setEditTarget(null)}
          onDone={async () => {
            setEditTarget(null);
            await reload();
          }}
        />
      )}
      {bulkCancel && (
        <BulkRequestCancelModal
          entityType="PosDevice"
          ids={[...sel.selected]}
          typeLabel="máy POS"
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

/** Nhóm 1 — Sửa THÔNG TIN HỒ SƠ máy POS (không đụng trạng thái/gán — luồng thao tác riêng). Serial bất biến. */
function EditDeviceModal({ device, onClose, onDone }: { device: PosDto; onClose: () => void; onDone: () => void }): JSX.Element {
  const toast = useToast();
  const [models, setModels] = useState<LiteRef[]>([]);
  const [suppliers, setSuppliers] = useState<LiteRef[]>([]);
  const [banks, setBanks] = useState<BankLite[]>([]); // Cài APP — danh mục ngân hàng
  const [warehouses, setWarehouses] = useState<WarehouseLite[]>([]); // Admin Demo 15/7 — đổi kho ngay trong form
  const isInStock = device.status === 'IN_STOCK'; // chỉ máy TRONG KHO mới đổi kho được (invariant)
  const [warehouseId, setWarehouseId] = useState(device.warehouseId != null ? String(device.warehouseId) : '');
  const [posModelId, setPosModelId] = useState(device.posModelId ? String(device.posModelId) : '');
  const [supplierId, setSupplierId] = useState(device.supplierId ? String(device.supplierId) : '');
  const [bank, setBank] = useState(device.bank ?? '');
  const [bankId, setBankId] = useState(device.bankId != null ? String(device.bankId) : ''); // Cài APP ('' = máy trắng)
  const [importPrice, setImportPrice] = useState(device.importPrice != null ? String(device.importPrice) : '');
  const [importedAt, setImportedAt] = useState(device.importedAt ? device.importedAt.slice(0, 10) : '');
  // [Admin Demo 15/11] GIÁ/NGÀY XUẤT — nhập tay y như giá nhập (chốt phương án B).
  const [exportPrice, setExportPrice] = useState(device.exportPrice != null ? String(device.exportPrice) : '');
  const [exportedAt, setExportedAt] = useState(device.exportedAt ? device.exportedAt.slice(0, 10) : '');
  const [warehouseLoc, setWarehouseLoc] = useState(device.warehouseLoc ?? '');
  const [note, setNote] = useState(device.note ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.posModelLite().then((r) => r.ok && r.data && setModels(r.data));
    window.api.supplierLite().then((r) => r.ok && r.data && setSuppliers(r.data));
    window.api.bankLite().then((r) => r.ok && r.data && setBanks(r.data));
    window.api.warehouseLite().then((r) => r.ok && r.data && setWarehouses(r.data));
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    const input: UpdatePosInput = {
      posModelId: posModelId ? Number(posModelId) : null,
      supplierId: supplierId ? Number(supplierId) : null,
      bank: bank.trim() || null,
      bankId: bankId ? Number(bankId) : null,
      importPrice: importPrice ? Number(importPrice) : null,
      importedAt: importedAt ? new Date(importedAt).toISOString() : null,
      exportPrice: exportPrice ? Number(exportPrice) : null,
      exportedAt: exportedAt ? new Date(exportedAt).toISOString() : null,
      // Chỉ gửi đổi kho khi máy IN_STOCK (backend cũng chặn); undefined = giữ nguyên.
      warehouseId: isInStock ? (warehouseId ? Number(warehouseId) : null) : undefined,
      warehouseLoc: warehouseLoc.trim() || null,
      note: note.trim() || null,
      expectedUpdatedAt: device.updatedAt // optimistic-lock (Admin Demo 11/8) — chống 2 người sửa đè hồ sơ máy
    };
    const res = await window.api.posUpdate(device.id, input);
    setBusy(false);
    if (res.ok) { toast.success(`Đã cập nhật hồ sơ máy ${device.serial}`); onDone(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onDone(); }
    else baoLoi(toast.alert, res, 'Lưu');
  }

  return (
    <Modal title={`Sửa hồ sơ máy ${device.serial}`} onClose={onClose}>
      <div className="mb-2 rounded-md bg-appbg px-3 py-2 text-xs text-slate-500">
        Serial <b className="font-mono text-slate-700">{device.serial}</b> là định danh cố định — không sửa ở đây. Trạng thái / gán khách / TID đổi qua nút <b>Thao tác</b>. Kho đổi được ở đây khi máy đang TRONG KHO.
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Chủng loại POS">
          <select className={inputCls} value={posModelId} onChange={(e) => setPosModelId(e.target.value)}>
            <option value="">— Không chọn —</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Nhà cung cấp">
          <select className={inputCls} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">— Không chọn —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Cài APP (ngân hàng)" hint="Máy trắng = chưa cài app. TID chỉ gán được khi cùng ngân hàng với app này.">
          <select className={inputCls} value={bankId} onChange={(e) => setBankId(e.target.value)}>
            <option value="">— Máy trắng (chưa cài app) —</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
          </select>
        </Field>
        <Field label="Ngân hàng (ghi chú)">
          <input className={inputCls} value={bank} onChange={(e) => setBank(e.target.value)} />
        </Field>
        <Field label="Giá nhập (VND)">
          <input className={inputCls + ' text-right tabular-nums'} inputMode="numeric" value={groupDigits(importPrice)} onChange={(e) => setImportPrice(e.target.value.replace(/[^\d]/g, ''))} placeholder="0" />
        </Field>
        <Field label="Ngày nhập">
          <input type="date" className={inputCls} value={importedAt} onChange={(e) => setImportedAt(e.target.value)} />
        </Field>
        <Field label="Giá xuất (VND)" hint="Nhập tay — giá bán/xuất máy khỏi kho.">
          <input className={inputCls + ' text-right tabular-nums'} inputMode="numeric" value={groupDigits(exportPrice)} onChange={(e) => setExportPrice(e.target.value.replace(/[^\d]/g, ''))} placeholder="0" />
        </Field>
        <Field label="Ngày xuất">
          <input type="date" className={inputCls} value={exportedAt} onChange={(e) => setExportedAt(e.target.value)} />
        </Field>
        <Field label="Kho" hint={isInStock ? 'Kho vật lý đang chứa máy (chỉ đổi khi máy TRONG KHO).' : 'Máy đã giao/bán — đổi kho qua nút Thao tác.'}>
          <select className={inputCls} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} disabled={!isInStock}>
            {!isInStock && <option value="">— (ngoài kho) —</option>}
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
          </select>
        </Field>
        <Field label="Vị trí kho (ghi chú)">
          <input className={inputCls} value={warehouseLoc} onChange={(e) => setWarehouseLoc(e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="Ghi chú">
            <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Lưu thay đổi</Button>
      </div>
    </Modal>
  );
}

/** #3 — Bán máy POS (kèm TID nếu có). Form tiền + mật khẩu xác nhận. */
function SellDeviceModal({ device, onClose, onDone }: { device: PosDto; onClose: () => void; onDone: () => void }): JSX.Element {
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
    if (!password) return toast.alert('Nhập mật khẩu để xác nhận bán máy.', 'Cần mật khẩu');
    setBusy(true);
    const res = await window.api.deviceSellPos(device.serial, {
      customerId: Number(customerId), salePrice: price, paidNow: paid,
      fundId: fundId ? Number(fundId) : null, method, warehouseId: device.warehouseId ?? null, // ĐỒNG BỘ: kho xuất = kho đang chứa máy
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null, note: note || null
    }, password);
    setBusy(false);
    if (res.ok) { toast.success(`Đã bán máy ${device.serial}${device.currentTid ? ` (kèm TID ${device.currentTid})` : ''}`); onDone(); }
    else baoLoi(toast.alert, res, 'Bán máy');
  }

  return (
    <Modal title={`Bán máy ${device.serial}`} onClose={onClose}>
      <div className="mb-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
        Máy sẽ chuyển <b>ĐÃ BÁN</b>{device.currentTid ? <> và <b>TID {device.currentTid}</b> bán kèm sang khách mua.</> : '.'} Doanh thu ghi nhận đủ giá ngay; phần chưa thu thành công nợ mua thiết bị.
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Khách mua" required>
          {/* [Admin Demo 16/11] ĐÚNG BRAND như ô chọn khách bên TID: bảng 2 cột MÃ KHÁCH | TÊN KHÁCH, dòng so le,
              nổi ra ngoài hộp thoại. KHÔNG dùng <select> nữa (không kẻ cột được, không điều khiển được chỗ bung). */}
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
        {device.warehouseId != null && (
          <Field label="Từ kho" hint="Kho đang chứa máy (đồng bộ, không chọn lệch)">
            <div className="rounded-md border border-line bg-appbg px-3 py-2 text-sm font-medium text-slate-700">{device.warehouseName ?? `Kho #${device.warehouseId}`}</div>
          </Field>
        )}
        <Field label="Thời gian bán" hint="Bỏ trống = hiện tại">
          <input type="datetime-local" className={inputCls} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
        <Field label="Ghi chú"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Mật khẩu xác nhận" required><input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="soft" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={submit} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Bán máy</Button>
      </div>
    </Modal>
  );
}

/** Transitions available from each status (mirrors the main-process state machine §A3). */
const NEXT: Record<string, { key: string; label: string }[]> = {
  IN_STOCK: [
    { key: 'deploy', label: 'Triển khai (giao khách)' },
    { key: 'reportDamage', label: 'Báo hỏng' },
    { key: 'retire', label: 'Thanh lý' }
  ],
  DEPLOYED: [
    { key: 'changeCustomer', label: 'Đổi khách giữ máy' },
    { key: 'cancelCustomer', label: 'Hủy khách giữ máy' },
    { key: 'recall', label: 'Thu hồi về kho' },
    { key: 'reportDamage', label: 'Báo hỏng' },
    { key: 'retire', label: 'Thanh lý' }
  ],
  DAMAGED: [
    { key: 'sendRepair', label: 'Gửi bảo trì' },
    { key: 'retire', label: 'Thanh lý' }
  ],
  IN_REPAIR: [
    { key: 'receiveRepaired', label: 'Nhận sửa xong' },
    { key: 'retire', label: 'Thanh lý' }
  ],
  RETIRED: []
};

// Nhãn tiếng Việt cho vòng đời máy (phủ HẾT eventType AssetEvent gắn máy — gồm cả sự kiện TID trên máy).
const POS_TIMELINE_EVENT_LABELS: Record<string, string> = {
  STOCK_IN: 'Nhập kho',
  DEPLOY: 'Giao máy',
  RECALL: 'Thu hồi về kho',
  TRANSFER_AGENT: 'Chuyển đại lý',
  CHANGE_CUSTOMER: 'Đổi khách giữ máy',
  CANCEL_CUSTOMER: 'Hủy khách giữ máy',
  SELL: 'Bán máy',
  REPORT_DAMAGE: 'Báo hỏng',
  SEND_REPAIR: 'Gửi bảo trì',
  RECEIVE_REPAIRED: 'Nhận sửa xong',
  RETIRE: 'Thanh lý',
  TID_ASSIGN: 'Gán TID lên máy',
  TID_DELIVERED: 'Giao TID cho khách',
  TID_SELL: 'Bán TID',
  TID_UNBIND: 'Gỡ TID khỏi máy',
  TID_DEAD: 'TID chết (đổi)',
  TID_CLOSE: 'Đóng TID',
  TID_RECALL: 'Thu hồi TID',
  TID_REPLACE: 'TID mới thay thế'
};

// Nhãn trạng thái (POS + TID — vòng đời máy có thể ghi cả state TID khi gán/gỡ TID).
const POS_STATE_LABELS: Record<string, string> = {
  IN_STOCK: 'Trong kho',
  DEPLOYED: 'Đã giao',
  IN_REPAIR: 'Đang sửa',
  DAMAGED: 'Hỏng',
  RETIRED: 'Đã thanh lý',
  SOLD: 'Đã bán',
  UNASSIGNED: 'Chưa gán',
  ACTIVE: 'Đang hoạt động',
  DEAD: 'Chết',
  CLOSED: 'Đã đóng',
  RECALLED: 'Đã thu hồi'
};

// eventType có "khách" mang ý nghĩa giao/bán cho khách (dòng "Khách: …").
const CUSTOMER_EVENT_TYPES = new Set(['DEPLOY', 'CHANGE_CUSTOMER', 'TID_DELIVERED', 'SELL', 'TID_SELL']);
// eventType máy VỀ kho (nhãn "Về kho:" thay vì "Từ kho:" khi có warehouseName).
const RETURN_WAREHOUSE_EVENT_TYPES = new Set(['RECALL', 'RECEIVE_REPAIRED']);

function TimelineModal({ device, onClose }: { device: PosDto; onClose: () => void }): JSX.Element {
  const [events, setEvents] = useState<TimelineEventDto[] | null>(null);
  useEffect(() => {
    window.api.posTimeline(device.serial).then((r) => setEvents(r.ok && r.data ? r.data : []));
  }, [device.serial]);

  return (
    <Modal title={`Vòng đời máy ${device.serial}`} onClose={onClose}>
      {!events && <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />}
      {events && events.length === 0 && <p className="text-sm text-slate-400">Chưa có sự kiện.</p>}
      {events && events.length > 0 && (
        <ol className="relative ml-3 border-l border-line">
          {events.map((e) => (
            <li key={e.id} className="mb-5 ml-5">
              <span className="absolute -left-[7px] mt-1 h-3 w-3 rounded-full bg-brand" />
              <div className="flex items-center gap-2">
                <span className="rounded bg-brand-tint px-1.5 py-0.5 text-xs font-medium text-brand">{POS_TIMELINE_EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                {e.fromState && (
                  <span className="text-xs text-slate-400">
                    {POS_STATE_LABELS[e.fromState] ?? e.fromState} → {e.toState ? (POS_STATE_LABELS[e.toState] ?? e.toState) : ''}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-slate-500">{fmtDate(e.occurredAt)} {fmtTimeSec(e.occurredAt)}</div>
              {e.customerName && CUSTOMER_EVENT_TYPES.has(e.eventType) && (
                <div className="mt-0.5 text-xs text-slate-500">Khách: <span className="font-medium text-slate-700">{e.customerName}</span></div>
              )}
              {e.warehouseName && (
                <div className="mt-0.5 text-xs text-slate-500">{RETURN_WAREHOUSE_EVENT_TYPES.has(e.eventType) ? 'Về kho: ' : 'Từ kho: '}<span className="font-medium text-slate-700">{e.warehouseName}</span>{e.deliveryAddress ? ` — ${e.deliveryAddress}` : ''}</div>
              )}
              {e.handoverName && (
                <div className="mt-0.5 text-xs text-slate-500">
                  · <span className="font-medium text-slate-700">{e.handoverName}</span>
                  {e.handoverAmount != null && <span className="ml-1 font-medium text-slate-700">{fmtVnd(e.handoverAmount)}</span>}
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

const EVENT_LABELS: Record<string, string> = {
  deploy: 'Triển khai (giao khách)',
  recall: 'Thu hồi về kho',
  changeCustomer: 'Đổi khách giữ máy',
  cancelCustomer: 'Hủy khách giữ máy',
  reportDamage: 'Báo hỏng',
  sendRepair: 'Gửi bảo trì',
  receiveRepaired: 'Nhận sửa xong',
  retire: 'Thanh lý'
};

function TransitionModal({ device, event, onClose, onDone, onOpenSell }: { device: PosDto; event: string; onClose: () => void; onDone: () => void; onOpenSell?: () => void }): JSX.Element {
  const toast = useToast();
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [warehouses, setWarehouses] = useState<WarehouseLite[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState(''); // Model 1 — thu hồi/nhận-sửa VỀ kho nào
  const [occurredAt, setOccurredAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  // LOẠI GIAO MÁY (Admin Demo) — chỉ áp cho "Giao khách" (deploy): loại giao + số tiền + quỹ.
  const [handoverTypes, setHandoverTypes] = useState<HandoverTypeLite[]>([]);
  const [handoverTypeId, setHandoverTypeId] = useState('');
  const [handoverAmount, setHandoverAmount] = useState('');
  const [fundId, setFundId] = useState('');
  // Admin Demo 9/8 — CỌC ĐỘC LẬP khi giao (loại giao hasDeposit): tiền cọc + quỹ cọc riêng.
  const [depositAmount, setDepositAmount] = useState('');
  const [depositFundId, setDepositFundId] = useState('');
  const [method, setMethod] = useState('CASH');
  const [funds, setFunds] = useState<FundDto[]>([]);

  const needCustomer = event === 'deploy' || event === 'changeCustomer';
  // R27: giao / đổi-khách ghi "Từ kho" (chọn kho → hiện địa chỉ).
  const needFromWarehouse = event === 'deploy' || event === 'changeCustomer';
  // Model 1: thu hồi / nhận-sửa xong → máy VỀ kho nào.
  const needToWarehouse = event === 'recall' || event === 'receiveRepaired';
  // ĐỒNG BỘ: máy đang có kho (đang trong kho) → deploy xuất TỪ chính kho đó, KHÓA không cho chọn lệch.
  const lockedFromWarehouse = event === 'deploy' && device.warehouseId != null;
  const selectedWarehouse = warehouses.find((w) => String(w.id) === warehouseId);
  const needHandover = event === 'deploy';
  const selectedHandover = handoverTypes.find((h) => String(h.id) === handoverTypeId);
  const moneyKind = selectedHandover?.moneyKind ?? 'NONE';
  const amountNum = Number(handoverAmount) || 0;
  // Cọc độc lập: hiện khi loại giao cho phép cọc VÀ không phải loại "Cọc" (DEPOSIT nhập ở ô số tiền chính).
  const showDeposit = !!selectedHandover?.hasDeposit && moneyKind !== 'DEPOSIT';
  const depositNum = Number(depositAmount) || 0;

  useEffect(() => {
    if (needCustomer) window.api.customerList({}).then((r) => r.ok && r.data && setCustomers(r.data));
    if (needFromWarehouse || needToWarehouse) window.api.warehouseLite().then((r) => r.ok && r.data && setWarehouses(r.data));
    if (event === 'deploy' && device.warehouseId != null) setWarehouseId(String(device.warehouseId));
    if (needHandover) {
      window.api.handoverTypeListLite().then((r) => {
        if (r.ok && r.data) {
          const sorted = [...r.data].sort((a, b) => a.sortOrder - b.sortOrder);
          setHandoverTypes(sorted);
          if (sorted[0]) setHandoverTypeId(String(sorted[0].id));
        }
      });
      window.api.fundList({}).then((r) => r.ok && r.data && setFunds(r.data.filter((f) => f.active)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needCustomer, needFromWarehouse, needToWarehouse, needHandover, event, device.warehouseId]);

  // Mượn (NONE) — khóa số tiền = 0. Bán (SALE) — không dùng luồng này (chặn ở nút Bán máy riêng).
  useEffect(() => {
    if (needHandover && (moneyKind === 'NONE' || moneyKind === 'COUNTERPART')) { setHandoverAmount('0'); setFundId(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moneyKind, needHandover]);

  async function run(password?: string): Promise<void> {
    if (needCustomer && !customerId) return toast.alert(event === 'changeCustomer' ? 'Phải chọn khách hàng mới.' : 'Phải chọn khách hàng nhận máy.');
    if (needToWarehouse && !toWarehouseId) return toast.alert('Phải chọn KHO nhận máy về (để biết máy đang ở kho nào).', 'Thiếu kho');
    if (needHandover) {
      if (!handoverTypeId) return toast.alert('Phải chọn loại giao.', 'Thiếu thông tin');
      if (moneyKind === 'SALE') return toast.alert('Loại giao "Bán" dùng chức năng Bán máy riêng (nút Bán máy) — không giao qua luồng này.', 'Dùng chức năng Bán máy');
      if (moneyKind === 'DEPOSIT' && !(amountNum > 0)) return toast.alert('Loại giao "Cọc" phải nhập số tiền cọc > 0.', 'Thiếu số tiền');
      if (amountNum > 0 && !fundId) return toast.alert('Có số tiền thì phải chọn quỹ nhận.', 'Thiếu quỹ');
      if (showDeposit && depositNum > 0 && !depositFundId) return toast.alert('Có đặt cọc thì phải chọn quỹ nhận cọc.', 'Thiếu quỹ cọc');
    }
    setBusy(true);
    const input = {
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
      note: note || null,
      customerId: customerId ? Number(customerId) : null,
      agentId: null,
      fromWarehouseId: needFromWarehouse && warehouseId ? Number(warehouseId) : null,
      toWarehouseId: needToWarehouse && toWarehouseId ? Number(toWarehouseId) : null,
      handoverTypeId: needHandover && handoverTypeId ? Number(handoverTypeId) : null,
      handoverAmount: needHandover ? amountNum : null,
      fundId: needHandover && fundId ? Number(fundId) : null,
      handoverDepositAmount: needHandover && showDeposit ? depositNum : null,
      handoverDepositFundId: needHandover && showDeposit && depositFundId ? Number(depositFundId) : null,
      method: needHandover ? method : null
    };
    let res;
    switch (event) {
      case 'deploy': res = await window.api.posDeploy(device.serial, input); break;
      case 'recall': res = await window.api.posRecall(device.serial, input); break;
      case 'changeCustomer': res = await window.api.posChangeCustomer(device.serial, input); break;
      case 'cancelCustomer': res = await window.api.posCancelCustomer(device.serial, input); break;
      case 'reportDamage': res = await window.api.posReportDamage(device.serial, input); break;
      case 'sendRepair': res = await window.api.posSendRepair(device.serial, input); break;
      case 'receiveRepaired': res = await window.api.posReceiveRepaired(device.serial, input); break;
      case 'retire': res = await window.api.posRetire(device.serial, password ?? '', input); break;
      default: res = { ok: false, message: 'Sự kiện không hợp lệ' };
    }
    setBusy(false);
    if (res.ok) {
      toast.success(`${EVENT_LABELS[event]} — thành công cho máy ${device.serial}`);
      onDone();
    } else {
      baoLoi(toast.alert, res, 'Thao tác');
    }
  }

  // Retire is destructive → password confirm dialog.
  if (event === 'retire' && confirmRetire) {
    return (
      <ConfirmDialog
        title="Thanh lý máy POS"
        message={`Thanh lý (RETIRED) máy "${device.serial}" là thao tác không hoàn tác. Nếu máy còn gắn TID, TID sẽ được gỡ và thu hồi. Nhập lại mật khẩu để xác nhận.`}
        confirmLabel="Thanh lý"
        danger
        requirePassword
        onCancel={() => setConfirmRetire(false)}
        onConfirm={(pwd) => run(pwd)}
      />
    );
  }

  return (
    <Modal title={`${EVENT_LABELS[event]} — ${device.serial}`} onClose={onClose}>
      <div className="mb-2 flex items-center gap-2 rounded-md bg-appbg px-3 py-2 text-sm text-slate-600">
        <Wrench className="h-4 w-4 text-brand" /> Trạng thái hiện tại: <StatusBadge entity="POS_DEVICE" code={device.status} />
      </div>
      {event === 'recall' && device.currentTid && (
        <div className="mb-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">Thu hồi máy sẽ GỠ gán TID {device.currentTid} (TID về "chưa gán máy").</div>
      )}
      {event === 'changeCustomer' && (
        <div className="mb-2 rounded-md bg-brand-tint px-3 py-2 text-xs text-brand">
          Khách đang giữ: <b>{device.customerName ?? '—'}</b>. Máy giữ nguyên trạng thái đang triển khai
          {device.currentTid ? <> và TID <b>{device.currentTid}</b> sẽ đi theo khách mới.</> : '.'}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4">
        {needCustomer && (
          <Field label={event === 'changeCustomer' ? 'Khách hàng mới' : 'Khách hàng nhận máy'} required>
            {/* [Admin Demo 16/11] "danh sách khách hàng phải đúng brand danh sách khách bên TID" — cùng 1 component
                với màn TID, sửa 1 chỗ ăn cả 2 màn (cấm chép lại thành <select> riêng). */}
            <CustomerPicker customers={customers} value={customerId} onChange={setCustomerId} />
          </Field>
        )}
        {needFromWarehouse && lockedFromWarehouse && (
          <Field label="Từ kho" hint="Máy đang trong kho này — xuất giao từ đúng kho (đồng bộ, không chọn lệch)">
            <div className="rounded-md border border-line bg-appbg px-3 py-2 text-sm font-medium text-slate-700">{device.warehouseName ?? `Kho #${device.warehouseId}`}</div>
            {selectedWarehouse?.address && (
              <div className="mt-1.5 rounded-md bg-appbg px-3 py-2 text-xs text-slate-600"><span className="text-slate-400">Địa chỉ giao: </span>{selectedWarehouse.address}</div>
            )}
          </Field>
        )}
        {needFromWarehouse && !lockedFromWarehouse && (
          <Field label="Từ kho" hint="Chọn kho xuất — địa chỉ kho sẽ hiện bên dưới">
            <select className={inputCls} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">— Không chọn kho —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </select>
            {selectedWarehouse && (
              <div className="mt-1.5 rounded-md bg-appbg px-3 py-2 text-xs text-slate-600">
                <span className="text-slate-400">Địa chỉ giao: </span>
                {selectedWarehouse.address || <span className="italic text-slate-400">kho chưa có địa chỉ</span>}
              </div>
            )}
          </Field>
        )}
        {needToWarehouse && (
          <Field label="Về kho" required hint="Máy thu về kho nào (để lọc/biết máy đang ở kho nào)">
            <select className={inputCls} value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
              <option value="">— Chọn kho nhận —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {needHandover && (
          <Field label="Loại giao" required hint="Hình thức giao máy cho khách">
            <select className={inputCls} value={handoverTypeId} onChange={(e) => setHandoverTypeId(e.target.value)}>
              {handoverTypes.length === 0 && <option value="">— Chưa có loại giao —</option>}
              {handoverTypes.map((h) => <option key={h.id} value={h.id}>{h.name} ({MONEY_KIND_LABEL[h.moneyKind] ?? h.moneyKind})</option>)}
            </select>
          </Field>
        )}
        {needHandover && moneyKind === 'SALE' && (
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-slate-600">
            Loại giao <b>Bán</b> — máy bán đứt, không giao qua luồng này. Hãy dùng chức năng <b>Bán máy</b>.
            {onOpenSell && (
              <div className="mt-2">
                <Button variant="confirm" onClick={onOpenSell}>Mở Bán máy</Button>
              </div>
            )}
          </div>
        )}
        {needHandover && moneyKind !== 'SALE' && (
          <div className="grid grid-cols-2 gap-4">
            <Field label={moneyKind === 'DEPOSIT' ? 'Số tiền cọc (VND)' : moneyKind === 'RENT' ? 'Số tiền thuê (VND)' : 'Số tiền (VND)'} required={moneyKind === 'DEPOSIT'} hint={moneyKind === 'NONE' ? 'Mượn — khóa 0đ' : moneyKind === 'COUNTERPART' ? 'Đối ứng — phí lấy từ biểu phí niêm yết' : undefined}>
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
        {needHandover && showDeposit && (
          <div className="grid grid-cols-2 gap-4 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
            <Field label="Tiền cọc thiết bị (VND)" hint="Cọc POS/TID — hoàn lại khi thu máy. Để 0 = không cọc.">
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
        <Field label="Thời gian thao tác" hint="Bỏ trống = thời điểm hiện tại">
          <input type="datetime-local" className={inputCls} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
        <Field label="Ghi chú">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="soft" onClick={onClose}>Hủy</Button>
        <Button
          variant="confirm"
          onClick={() => (event === 'retire' ? setConfirmRetire(true) : run())}
          disabled={busy || (needHandover && moneyKind === 'SALE')}
          icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
        >
          {EVENT_LABELS[event]}
        </Button>
      </div>
    </Modal>
  );
}
