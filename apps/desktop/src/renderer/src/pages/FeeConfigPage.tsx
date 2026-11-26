import { Fragment, useEffect, useState, useRef } from 'react';
import { Plus, Pencil, Trash2, Loader2, Percent, Tag, Save, Download, RefreshCw, CalendarDays, QrCode } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate, fmtTime } from '@sigma/shared';
import type { FeeTypeDto, FeeRateDto, PartnerDto, LiteRef, CardTypeDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Field, inputCls } from '../components/Field.js';
import { FilterBar } from '../components/FilterBar.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { useRowSelection, SelectionBar, SelectAllCell, SelectCell } from '../components/Selection.js';
import { AuditTrailHeadCells, AuditTrailCells, AUDIT_TRAIL_COLS } from '../components/AuditCells.js';
import { exportCsv } from '../lib/exportCsv.js';
import { TabBar, TabButton } from '../components/Tabs.js';
// MẪU THIẾT KẾ CHỐT 6/11 — kiểu bảng lấy từ MODULE DÙNG CHUNG, CẤM chép chuỗi class vào trang.
import { KhungBang, thChuan, tdChuan, tdTongChuan, tdPhanTram, trChuan, theadChuan, tfootChuan, trTongChuan, tdTrong, HangDem } from '../components/BangChuan.js';

type Tab = 'rate' | 'type' | 'weekend' | 'qrpartner' | 'qrdealer' | 'promo';

// [Admin Demo 12/9] Chương trình KHUYẾN MẠI (mirror PromoProgramDto — packages/services/src/qr-fee-config.ts).
interface PromoProgramRow {
  id: number;
  kenh: 'POS' | 'QR';
  cardTypeId: number | null;
  cardTypeName: string | null;
  bankId: number | null;
  bankName: string | null;
  deltaPct: number;
  fromDate: string;
  toDate: string; // loại trừ (00:00 ngày sau "đến ngày")
  lich: 'RANGE' | 'WEEKEND' | 'DATES';
  ngayCuThe: string[] | null;
  enabled: boolean;
  note: string | null;
}

// [Admin Demo 4/9] DTO cấu hình QR + giảm phí bán cuối tuần — api trả Promise<unknown> (preload), khai báo shape tại đây
// để render an toàn kiểu (khớp WeekendSellAdjustDto / QrPartnerFeeDto ở packages/services/src/qr-fee-config.ts).
interface WeekendSellAdjustRow {
  id: number;
  cardTypeId: number;
  cardTypeCode: string | null;
  cardTypeName: string | null;
  deltaPct: number;
  effectiveFrom: string;
}
interface QrPartnerFeeRow {
  id: number;
  partnerId: number;
  partnerCode: string | null;
  partnerName: string | null;
  phiMuaThuongPct: number;
  phiMuaCuoiTuanPct: number;
  phiBanPct: number;
  effectiveFrom: string;
}
interface QrDealerSellFeeRow {
  id: number;
  customerId: number;
  customerName: string | null;
  phiBanPct: number;
  effectiveFrom: string;
}
interface CustomerRef { id: number; code?: string | null; fullName?: string | null; nickname?: string | null }
interface ApiListResult<T> { ok: boolean; data?: T[]; error?: string; message?: string }
interface ApiMutResult { ok: boolean; error?: string; message?: string; id?: number }

/** Ngày → "YYYY-MM-DD" theo LOCAL (KHÔNG dùng toISOString().slice — UTC lệch -1 ngày trên UTC+7). Admin Demo 9/8:
 * GỐC bug "sửa biểu phí nhân đôi" — form edit lấy ngày bằng slice(0,10) của ISO-UTC → sai ngày → server không
 * khớp kỳ cũ → TẠO KỲ MỚI thay vì cập nhật. Dùng local getters để khớp fmtDate (hiển thị) + startOfDayLocal (server). */
function toLocalYmd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Hiển thị % gọn (tối đa 3 số thập phân, bỏ số 0 thừa). */
function fmtPct(v: number): string {
  const s = v.toFixed(3).replace(/\.?0+$/, '');
  return `${s}%`;
}
/** Chênh lệch: âm = đỏ trong ngoặc, dương = xanh dương (§C5b). */
function CL({ v }: { v: number }): JSX.Element {
  if (v < 0) return <span className="font-medium text-danger">({fmtPct(Math.abs(v))})</span>;
  return <span className="font-medium text-brand">{fmtPct(v)}</span>;
}

export function FeeConfigPage({ user }: { user: AuthUser }): JSX.Element {
  const [tab, setTab] = useState<Tab>('rate');
  const canManage = hasPermission(user, 'CONFIG_FEE_MANAGE');
  return (
    /* `data-nut-vuong` để trang ăn luật NÚT + THANH CUỘN của mau-moi.css (nạp ở main.tsx). */
    <div data-nut-vuong data-trang-full>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-800">Phí mua-cài máy-bán</h2>
        <p className="text-sm text-slate-500">Biểu phí % theo Đối tác × Loại thẻ · Danh mục loại phí bán · QR bán hàng · Giảm phí bán cuối tuần.</p>
      </div>
      <TabBar>
        <TabButton active={tab === 'rate'} onClick={() => setTab('rate')} icon={<Percent className="h-4 w-4" />}>Biểu phí %</TabButton>
        <TabButton active={tab === 'type'} onClick={() => setTab('type')} icon={<Tag className="h-4 w-4" />}>Loại phí</TabButton>
        <TabButton active={tab === 'weekend'} onClick={() => setTab('weekend')} icon={<CalendarDays className="h-4 w-4" />}>Giảm phí bán cuối tuần</TabButton>
        <TabButton active={tab === 'promo'} onClick={() => setTab('promo')} icon={<CalendarDays className="h-4 w-4" />}>Chương trình khuyến mại</TabButton>
        <TabButton active={tab === 'qrpartner'} onClick={() => setTab('qrpartner')} icon={<QrCode className="h-4 w-4" />}>Giá QR theo đối tác</TabButton>
        <TabButton active={tab === 'qrdealer'} onClick={() => setTab('qrdealer')} icon={<QrCode className="h-4 w-4" />}>Giá bán QR theo đại lý</TabButton>
      </TabBar>
      {tab === 'rate' && <RateTab canManage={canManage} />}
      {tab === 'type' && <TypeTab canManage={canManage} />}
      {tab === 'weekend' && <WeekendAdjustTab canManage={canManage} />}
      {tab === 'promo' && <PromoTab canManage={canManage} />}
      {tab === 'qrpartner' && <QrPartnerFeeTab canManage={canManage} />}
      {tab === 'qrdealer' && <QrDealerSellFeeTab canManage={canManage} />}
    </div>
  );
}

// ── §C5a LOẠI PHÍ ────────────────────────────────────────────────────────────
function TypeTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<FeeTypeDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: FeeTypeDto } | null>(null);
  const [del, setDel] = useState<FeeTypeDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.feeTypeList();
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  async function doDelete(t: FeeTypeDto, password?: string): Promise<void> {
    const res = await window.api.feeTypeDelete([t.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa loại phí ${t.name}`);
    else toast.alert(res.message ?? 'Xóa loại phí thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }
  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.feeTypeDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} loại phí`);
    else toast.alert(res.message ?? 'Xóa loại phí thất bại', 'Xóa thất bại');
    setBulkDel(false);
    await reload();
  }

  // SỐ CỘT = [ô chọn] + Tên loại phí + khối audit (AUDIT_TRAIL_COLS) + [Thao tác].
  // SỬA LỖI colSpan: trước đây hard-code 9/7 từ thời khối audit còn 6 cột; Admin Demo 13/7 cắt còn 3
  // (AUDIT_TRAIL_COLS) mà colSpan KHÔNG đổi ⇒ hàng rỗng/đang-tải thừa 3 cột. Nay tính ĐỘNG từ hằng số.
  const soCot = (canManage ? 1 : 0) + 1 + AUDIT_TRAIL_COLS + (canManage ? 1 : 0);

  return (
    <div>
      <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
        <div className="shrink-0 text-xs text-slate-500">{rows.length} loại phí · <span className="text-slate-400">ví dụ: Ủy quyền, Tiền chờ, Tiền Nhanh</span></div>
        <div className="flex-1" />
        <Button variant="soft" data-nut="lammoi" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reload()} title="Tải lại dữ liệu mới nhất">Làm mới</Button>
        <Button variant="confirm" data-nut="excel" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('loai_phi', ['Tên loại phí', 'Người tạo', 'Ngày tạo', 'Giờ tạo', 'Người sửa', 'Ngày sửa', 'Giờ sửa'], rows.map((t) => [t.name, t.createdByName ?? '', fmtDate(t.createdAt), fmtTime(t.createdAt), t.updatedByName ?? '', fmtDate(t.updatedAt), fmtTime(t.updatedAt)]))}>Xuất Excel</Button>
        {canManage && <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm loại phí</Button>}
      </div>
      {canManage && <SelectionBar count={sel.count} entityLabel="loại phí" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <KhungBang className="list-scroll bg-white shadow-sm">
        <table className="w-full min-w-[980px] text-xs">
          <thead className={theadChuan}>
            {/* Nền trên `<tr>`: ô checkbox + khối audit do module dùng chung render (không mang `thChuan`). */}
            <tr className="bg-slate-200">
              {canManage && <SelectAllCell ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan}>Tên loại phí</th>
              <AuditTrailHeadCells />
              {canManage && <th className={thChuan + ' w-[110px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className={tdTrong}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className={tdTrong}><Tag className="mx-auto mb-2 h-6 w-6" /> Chưa có loại phí.</td></tr>}
            {!loading && rows.map((t, i) => (
              <tr key={t.id} className={trChuan(i, sel.isSelected(t.id))}>
                {canManage && <SelectCell id={t.id} sel={sel} />}
                <td className={tdChuan + ' font-medium text-slate-800'}>{t.name}</td>
                <AuditTrailCells row={t} />
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: t })}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(t)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <HangDem soCot={soCot} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={soCot}>TỔNG {rows.length} loại phí</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {form && <TypeForm mode={form.mode} row={form.row} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa loại phí" message={`Loại phí "${del.name}" sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều loại phí" message={`${sel.count} loại phí đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

function TypeForm({ mode, row, onClose, onSaved }: { mode: 'create' | 'edit'; row?: FeeTypeDto; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [name, setName] = useState(row?.name ?? '');
  const [busy, setBusy] = useState(false);
  async function save(): Promise<void> {
    if (!name.trim()) return toast.alert('Tên loại phí bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    const res = mode === 'edit' && row ? await window.api.feeTypeUpdate(row.id, { name: name.trim(), expectedUpdatedAt: row.updatedAt }) : await window.api.feeTypeCreate({ name: name.trim() });
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật loại phí' : `Đã thêm loại phí ${name}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else toast.alert(res.message ?? 'Lưu loại phí thất bại', 'Không lưu được');
  }
  return (
    <Modal title={mode === 'edit' ? 'Sửa loại phí' : 'Thêm loại phí'} onClose={onClose} width="max-w-md" onSubmit={() => void save()}>
      <Field label="Tên loại phí" required hint="Ví dụ: Ủy quyền, Tiền chờ, Tiền Nhanh"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm loại phí'}</Button>
      </div>
    </Modal>
  );
}

// ── §C5b BIỂU PHÍ % (FEE_MODEL) ──────────────────────────────────────────────
// Phí mua + phí cài máy = 1 giá CỐ ĐỊNH (không theo loại phí). Phí BÁN NIÊM YẾT theo TỪNG loại phí.
function RateTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<FeeRateDto[]>([]);
  const [partners, setPartners] = useState<PartnerDto[]>([]);
  const [banks, setBanks] = useState<LiteRef[]>([]);
  const [feeTypes, setFeeTypes] = useState<FeeTypeDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [fPartner, setFPartner] = useState('');
  const [fBank, setFBank] = useState('');
  const [setOpen, setSetOpen] = useState<FeeRateDto | 'new' | null>(null);
  const [del, setDel] = useState<FeeRateDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  async function loadRefs(): Promise<void> {
    const [p, b, f] = await Promise.all([window.api.partnerList({}), window.api.bankLite(), window.api.feeTypeList()]);
    if (p.ok && p.data) setPartners(p.data);
    if (b.ok && b.data) setBanks(b.data);
    if (f.ok && f.data) setFeeTypes(f.data);
  }
  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef2 = useRef<() => void>(() => {});
  reloadRef2.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.feeRateList({ partnerId: fPartner ? Number(fPartner) : undefined, bankId: fBank ? Number(fBank) : undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void loadRefs(); }, []);
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [fPartner, fBank]);

  async function doDelete(fr: FeeRateDto, password?: string): Promise<void> {
    const res = await window.api.feeRateDelete([fr.id], password ?? '');
    if (res.ok) toast.success('Đã xóa biểu phí');
    else toast.alert(res.message ?? 'Xóa biểu phí thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }
  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.feeRateDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} biểu phí`);
    else toast.alert(res.message ?? 'Xóa biểu phí thất bại', 'Xóa thất bại');
    setBulkDel(false);
    await reload();
  }

  // Xuất Excel: 1 dòng / (biểu phí × loại phí niêm yết) để bung mảng sellQuotes.
  function exportRows(): void {
    const data: (string | number)[][] = [];
    for (const r of rows) {
      if (r.sellQuotes.length === 0) {
        data.push([r.partnerName ?? '', r.bankCode ?? '', r.cardTypeName ?? '', fmtDate(r.effectiveFrom), r.isCurrent ? 'x' : '', r.phiMua, r.phiCaiMay, r.clNcc, '', '', '']);
      }
      for (const q of r.sellQuotes) {
        data.push([r.partnerName ?? '', r.bankCode ?? '', r.cardTypeName ?? '', fmtDate(r.effectiveFrom), r.isCurrent ? 'x' : '', r.phiMua, r.phiCaiMay, r.clNcc, q.feeTypeName ?? '', q.phiBan, q.clKh]);
      }
    }
    exportCsv('bieu_phi', ['Đối tác', 'Ngân hàng', 'Loại thẻ', 'Hiệu lực từ', 'Đang hiệu lực', 'Phí mua %', 'Phí cài máy %', 'Chênh lệch với Nhà cung cấp %', 'Loại phí', 'Phí bán niêm yết %', 'Chênh lệch với Khách hàng %'], data);
  }

  // SỐ CỘT = [ô chọn] + 8 cột dữ liệu + [Thao tác].
  const soCot = (canManage ? 1 : 0) + 8 + (canManage ? 1 : 0);

  return (
    <div>
      <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
        <div className="shrink-0 text-xs text-slate-500">{rows.length} biểu phí · <span className="text-slate-400">phí mua &amp; cài máy cố định · phí bán niêm yết theo từng loại phí</span></div>
        <div className="flex-1" />
        {/* "Xóa lọc" đặt Ở ĐÂY (FilterBar nhận hideReset/hideRefresh) — chỉ nút mang `data-nut`
            mới được mau-moi.css khoá bề ngang 119px, giống bản mẫu đã duyệt. */}
        <Button variant="soft" data-nut="xoaloc" onClick={() => { setFPartner(''); setFBank(''); setTimeout(() => reloadRef2.current(), 0); }} title="Xóa toàn bộ bộ lọc, đưa về mặc định">Xóa lọc</Button>
        <Button variant="soft" data-nut="lammoi" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reload()} title="Tải lại dữ liệu mới nhất">Làm mới</Button>
        <Button variant="confirm" data-nut="excel" icon={<Download className="h-4 w-4" />} onClick={exportRows}>Xuất Excel</Button>
        {canManage && <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => partners.length ? setSetOpen('new') : toast.alert('Chưa có đối tác — thêm ở tab \'Đối tác\' (Cấu hình ngân hàng) rồi liên kết ngân hàng trước khi đặt phí.', 'Thiếu dữ liệu nền')}>Đặt biểu phí</Button>}
      </div>
      {/* Thanh lọc: 1 hàng, chữ nhỏ (`coChuNho`), nút "Lọc" căn mép phải (`locPhai`). */}
      <div className="overflow-x-auto">
        <FilterBar
          search="" onSearch={() => undefined} searchPlaceholder=""
          coChuNho
          locPhai
          selects={[
            { key: 'p', placeholder: 'Tất cả đối tác', value: fPartner, options: partners.map((p) => ({ value: String(p.id), label: `${p.code} · ${p.name}` })), onChange: setFPartner },
            { key: 'b', placeholder: 'Tất cả ngân hàng', value: fBank, options: banks.map((b) => ({ value: String(b.id), label: `${b.code}` })), onChange: setFBank }
          ]}
          onApply={reload} onReset={() => { setFPartner(''); setFBank(''); setTimeout(() => reloadRef2.current(), 0); }}
          hideReset
          hideRefresh
        />
      </div>
      {canManage && <SelectionBar count={sel.count} entityLabel="biểu phí" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <KhungBang className="list-scroll bg-white shadow-sm">
        <table className="w-full min-w-[1560px] text-xs">
          <thead className={theadChuan}>
            <tr className="bg-slate-200">
              {canManage && <SelectAllCell ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[190px]'}>Đối tác</th>
              <th className={thChuan + ' w-[110px]'}>Ngân hàng</th>
              <th className={thChuan + ' w-[170px]'}>Loại thẻ</th>
              <th className={thChuan + ' w-[160px]'}>Hiệu lực từ</th>
              <th className={thChuan + ' w-[110px]'}>Phí mua</th>
              <th className={thChuan + ' w-[120px]'}>Phí cài máy</th>
              <th className={thChuan + ' w-[160px]'}>Chênh lệch với Nhà cung cấp</th>
              <th className={thChuan}>Phí bán niêm yết theo loại phí</th>
              {canManage && <th className={thChuan + ' w-[110px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className={tdTrong}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className={tdTrong}><Percent className="mx-auto mb-2 h-6 w-6" /> Chưa có biểu phí.</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={r.id} className={trChuan(i, sel.isSelected(r.id))}>
                {canManage && <SelectCell id={r.id} sel={sel} />}
                <td className={tdChuan}><span className="font-mono font-semibold whitespace-nowrap text-brand">{r.partnerCode}</span> <span className="text-slate-700">{r.partnerName}</span></td>
                <td className={tdChuan + ' text-center text-slate-600'}>{r.bankCode ?? '—'}</td>
                <td className={tdChuan}><span className="font-mono font-semibold whitespace-nowrap text-brand">{r.cardTypeCode}</span> <span className="text-slate-700">{r.cardTypeName}</span></td>
                {/* Nhãn "Đang hiệu lực" nâng từ 10px lên 12px — mọi chữ trong bảng cùng cỡ (mẫu chốt §2). */}
                <td className={tdChuan + ' text-center text-slate-600'}>{fmtDate(r.effectiveFrom)}{r.isCurrent && <span className="ml-2 rounded-full bg-brand-tint px-2 py-0.5 font-semibold text-brand">Đang hiệu lực</span>}</td>
                {/* 3 cột % → tdPhanTram: căn giữa, 12px, slate-600, không in đậm. */}
                <td className={tdPhanTram}>{fmtPct(r.phiMua)}</td>
                <td className={tdPhanTram}>{fmtPct(r.phiCaiMay)}</td>
                <td className={tdPhanTram}><CL v={r.clNcc} /></td>
                <td className={tdChuan + ' whitespace-normal'}>
                  {r.sellQuotes.length === 0 ? <span className="text-slate-400">— chưa cấu hình —</span> : (
                    <div className="flex flex-col gap-0.5">
                      {r.sellQuotes.map((q) => (
                        <div key={q.feeTypeId} className="flex items-center gap-2 whitespace-nowrap">
                          <span className="text-slate-600">{q.feeTypeName}:</span>
                          <span className="tabular-nums text-slate-800">{fmtPct(q.phiBan)}</span>
                          <span className="text-slate-400">CL KH</span> <CL v={q.clKh} />
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Sửa phí" tone="edit" onClick={() => setSetOpen(r)}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <HangDem soCot={soCot} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={soCot}>TỔNG {rows.length} biểu phí</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {setOpen && <RateForm existing={setOpen === 'new' ? null : setOpen} partners={partners} banks={banks} feeTypes={feeTypes} onClose={() => setSetOpen(null)} onSaved={() => { setSetOpen(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa biểu phí" message={`Biểu phí ${del.partnerName} · ${del.cardTypeName} sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều biểu phí" message={`${sel.count} biểu phí đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

// FEE_MODEL — form biểu phí: phí mua (1 ô) + phí cài (1 ô) CỐ ĐỊNH + phí bán niêm yết theo TỪNG loại phí active.
function RateForm({ existing, partners, banks, feeTypes, onClose, onSaved }: { existing: FeeRateDto | null; partners: PartnerDto[]; banks: LiteRef[]; feeTypes: FeeTypeDto[]; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const isEdit = existing !== null;
  const [partnerId, setPartnerId] = useState(existing ? String(existing.partnerId) : '');
  const [bankId, setBankId] = useState(existing?.bankId ? String(existing.bankId) : '');
  const [cardTypeId, setCardTypeId] = useState(existing ? String(existing.cardTypeId) : '');
  const [cards, setCards] = useState<CardTypeDto[]>([]);
  const [phiMua, setPhiMua] = useState(existing ? String(existing.phiMua) : '');
  const [phiCaiMay, setPhiCaiMay] = useState(existing ? String(existing.phiCaiMay) : '');
  // Phí bán niêm yết theo TỪNG loại phí (map feeTypeId → chuỗi %). Sửa → nạp giá cũ; loại phí chưa có = rỗng.
  const [quotes, setQuotes] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    const existingByFt = new Map((existing?.sellQuotes ?? []).map((q) => [q.feeTypeId, q.phiBan]));
    for (const f of feeTypes) init[f.id] = existingByFt.has(f.id) ? String(existingByFt.get(f.id)) : '';
    return init;
  });
  const [effectiveFrom, setEffectiveFrom] = useState(existing ? toLocalYmd(new Date(existing.effectiveFrom)) : toLocalYmd(new Date()));
  const [busy, setBusy] = useState(false);

  // Ngân hàng khả dụng = ngân hàng ĐÃ liên kết với đối tác đang chọn (§C5b).
  const partner = partners.find((p) => String(p.id) === partnerId);
  const linkedBankIds = new Set(partner?.bankIds ?? []);
  const availBanks = banks.filter((b) => linkedBankIds.has(b.id));

  useEffect(() => {
    if (!bankId) { setCards([]); return; }
    window.api.cardTypeList({ bankId: Number(bankId) }).then((r) => { if (r.ok && r.data) setCards(r.data); });
  }, [bankId]);

  const clNcc = phiMua !== '' && phiCaiMay !== '' ? Number(phiMua) - Number(phiCaiMay) : null;

  function validPct(s: string): boolean {
    if (s === '') return false;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;
  }

  async function save(): Promise<void> {
    if (!partnerId) return toast.alert('Vui lòng chọn đối tác.', 'Thiếu thông tin');
    if (!bankId) return toast.alert('Vui lòng chọn ngân hàng (liên kết với đối tác).', 'Thiếu thông tin');
    if (!cardTypeId) return toast.alert('Vui lòng chọn loại thẻ.', 'Thiếu thông tin');
    for (const [label, v] of [['Phí mua', phiMua], ['Phí cài máy', phiCaiMay]] as const) {
      if (!validPct(v)) return toast.alert(`${label} không hợp lệ (≥ 0, tối đa 3 số thập phân).`, 'Giá trị không hợp lệ');
    }
    if (feeTypes.length === 0) return toast.alert('Chưa có loại phí bán nào — thêm ở tab "Loại phí" trước khi đặt biểu phí.', 'Thiếu dữ liệu nền');
    const sellQuotes: { feeTypeId: number; phiBan: number }[] = [];
    for (const f of feeTypes) {
      const raw = (quotes[f.id] ?? '').trim();
      // Admin Demo 9/8 — phí bán niêm yết theo loại phí (tiền chờ/uỷ quyền…) ĐƯỢC để = 0 hoặc GIÁ TRỊ BẤT KỲ (≥0),
      // KHÔNG ràng buộc ≥ phí mua, không phụ thuộc phí cài máy. Bỏ chặn "phải ≥ phí mua" (chặn cũ khiến không sửa được).
      if (!validPct(raw)) return toast.alert(`Phí bán niêm yết loại phí "${f.name}" không hợp lệ (≥ 0, tối đa 3 số thập phân).`, 'Giá trị không hợp lệ');
      sellQuotes.push({ feeTypeId: f.id, phiBan: Number(raw) });
    }
    if (!effectiveFrom) return toast.alert('Vui lòng chọn ngày hiệu lực.', 'Thiếu thông tin');
    setBusy(true);
    const res = await window.api.feeRateSet({ partnerId: Number(partnerId), cardTypeId: Number(cardTypeId), phiMua: Number(phiMua), phiCaiMay: Number(phiCaiMay), effectiveFrom: new Date(effectiveFrom + 'T00:00:00').toISOString(), sellQuotes });
    setBusy(false);
    if (res.ok) { toast.success('Đã lưu biểu phí'); onSaved(); }
    else toast.alert(res.message ?? 'Lưu biểu phí thất bại', 'Không lưu được');
  }

  return (
    <Modal title={isEdit ? `Sửa biểu phí — ${existing?.partnerName} · ${existing?.cardTypeName}` : 'Đặt biểu phí mới'} onClose={onClose} width="max-w-xl" onSubmit={() => void save()}>
      <div className="grid grid-cols-3 gap-4">
        <Field label="Đối tác" required><select className={inputCls} value={partnerId} disabled={isEdit} onChange={(e) => { setPartnerId(e.target.value); setBankId(''); setCardTypeId(''); }}><option value="">— Chọn đối tác —</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field>
        <Field label="Ngân hàng" required hint="Ngân hàng đã liên kết đối tác"><select className={inputCls} value={bankId} disabled={isEdit || !partnerId} onChange={(e) => { setBankId(e.target.value); setCardTypeId(''); }}><option value="">— Chọn ngân hàng —</option>{availBanks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></Field>
        <Field label="Loại thẻ" required><select className={inputCls} value={cardTypeId} disabled={isEdit || !bankId} onChange={(e) => setCardTypeId(e.target.value)}><option value="">— Chọn loại thẻ —</option>{cards.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></Field>
      </div>
      {/* FIX 2 — hướng dẫn thoát dead-end thay vì kẹt "Vui lòng chọn…" */}
      {!isEdit && partnerId && availBanks.length === 0 && (
        <p className="mt-2 text-xs font-medium text-warning">Đối tác này chưa liên kết ngân hàng nào — vào tab <b>Đối tác</b> › nút <b>Liên kết ngân hàng</b> để thêm, rồi mở lại form này.</p>
      )}
      {!isEdit && bankId && cards.length === 0 && (
        <p className="mt-2 text-xs font-medium text-warning">Ngân hàng đã chọn chưa có loại thẻ nào — thêm ở <b>Cấu hình ngân hàng › Loại thẻ</b> trước, rồi mở lại form này.</p>
      )}
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Field label="Phí mua (%)" required hint="1 giá cố định"><input className={inputCls} inputMode="decimal" value={phiMua} onChange={(e) => setPhiMua(e.target.value)} placeholder="1.02" /></Field>
        <Field label="Phí cài máy (%)" required hint="1 giá cố định"><input className={inputCls} inputMode="decimal" value={phiCaiMay} onChange={(e) => setPhiCaiMay(e.target.value)} placeholder="1.03" /></Field>
        <Field label="Ngày hiệu lực từ" required hint="Kỳ giá áp dụng cho GD có ngày ≥ mốc này"><input type="date" className={inputCls} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
      </div>
      <div className="mt-4">
        <div className="mb-1 text-sm font-medium text-slate-700">Phí bán niêm yết theo loại phí <span className="text-danger">*</span></div>
        <p className="mb-2 text-xs text-slate-400">Loại phí CHỈ đổi phí bán — mỗi loại phí một % niêm yết. Chênh lệch với Khách hàng = phí bán − phí cài máy.</p>
        {feeTypes.length === 0 ? (
          <p className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-slate-600">Chưa có loại phí bán nào — thêm ở tab <b>Loại phí</b> trước.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {feeTypes.map((f) => {
              const raw = quotes[f.id] ?? '';
              const clKh = raw !== '' && phiCaiMay !== '' ? Number(raw) - Number(phiCaiMay) : null;
              return (
                <div key={f.id} className="rounded-lg border border-line bg-appbg/40 px-3 py-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-700">{f.name}</span>
                    <span className="text-xs text-slate-400">CL KH {clKh === null ? '—' : <CL v={clKh} />}</span>
                  </div>
                  <input className={inputCls} inputMode="decimal" value={raw} onChange={(e) => setQuotes((s) => ({ ...s, [f.id]: e.target.value }))} placeholder="1.05" />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-4 flex gap-6 rounded-lg bg-appbg px-4 py-3 text-sm">
        <div>Chênh lệch với Nhà cung cấp: {clNcc === null ? <span className="text-slate-400">—</span> : <CL v={clNcc} />} <span className="text-xs text-slate-400">(phí mua − phí cài máy)</span></div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>Lưu biểu phí</Button>
      </div>
    </Modal>
  );
}

// ── §QR-1 GIẢM PHÍ BÁN CUỐI TUẦN (POS, theo LOẠI THẺ) ─────────────────────────
// Chỉ áp Thứ 7 + Chủ nhật, cho thẻ MB & MBV. Set = same-day replace (kỳ mới đè kỳ cùng ngày).
// [Admin Demo 12/9] CHƯƠNG TRÌNH KHUYẾN MẠI giảm giá bán — kênh POS (loại thẻ) / QR (ngân hàng hoặc mọi bank),
// cửa sổ từ-đến, lịch cả-kỳ / chỉ-T7-CN / ngày-cụ-thể, bật-tắt. Chỉ người SigMa (CONFIG_FEE). LƯU Ý hồi tố:
// set/tắt KHÔNG tự tính lại GD đã chốt — cần lệnh recalc riêng (LEAD chạy) khi muốn áp ngược quá khứ.
function PromoTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<PromoProgramRow[]>([]);
  const [cards, setCards] = useState<CardTypeDto[]>([]);
  const [banks, setBanks] = useState<{ id: number; code?: string | null; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<PromoProgramRow | 'new' | null>(null);
  const [del, setDel] = useState<PromoProgramRow | null>(null);

  async function loadRefs(): Promise<void> {
    const c = await window.api.cardTypeList({});
    if (c.ok && c.data) setCards(c.data);
    const b = (await window.api.bankList({})) as { ok?: boolean; data?: { id: number; code?: string | null; name: string }[] };
    if (b.ok && b.data) setBanks(b.data);
  }
  async function reload(): Promise<void> {
    setLoading(true);
    const res = (await window.api.promoProgramList()) as ApiListResult<PromoProgramRow>;
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void loadRefs(); void reload(); /* eslint-disable-next-line */ }, []);

  /** Bật/tắt nhanh: gửi lại nguyên chương trình với enabled đảo. */
  async function toggle(r: PromoProgramRow): Promise<void> {
    const res = (await window.api.promoProgramSet({
      id: r.id, kenh: r.kenh, cardTypeId: r.cardTypeId, bankId: r.bankId, deltaPct: r.deltaPct,
      fromDate: r.fromDate, toDate: ngayDenHienThi(r.toDate), lich: r.lich, ngayCuThe: r.ngayCuThe ?? undefined,
      enabled: !r.enabled, note: r.note
    })) as ApiMutResult;
    if (res.ok) toast.success(!r.enabled ? 'Đã BẬT chương trình khuyến mại' : 'Đã TẮT chương trình khuyến mại');
    else toast.alert(res.message ?? 'Không đổi được trạng thái');
    await reload();
  }
  async function doDelete(r: PromoProgramRow): Promise<void> {
    const res = (await window.api.promoProgramDelete(r.id)) as ApiMutResult;
    if (res.ok) toast.success('Đã xóa chương trình khuyến mại');
    else toast.alert(res.message ?? 'Xóa thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }
  const lichLabel = (r: PromoProgramRow): string =>
    r.lich === 'WEEKEND' ? 'Chỉ T7 + CN' : r.lich === 'DATES' ? `Ngày: ${(r.ngayCuThe ?? []).map((d) => d.slice(8, 10) + '/' + d.slice(5, 7)).join(', ')}` : 'Cả kỳ';

  const soCot = 6 + (canManage ? 1 : 0);

  return (
    <div>
      <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
        <div className="shrink-0 text-xs text-slate-500">{rows.length} chương trình · <span className="text-slate-400">giảm giá BÁN theo kỳ — POS theo loại thẻ, QR theo ngân hàng</span></div>
        <div className="flex-1" />
        <Button variant="soft" data-nut="lammoi" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reload()} title="Tải lại dữ liệu mới nhất">Làm mới</Button>
        {canManage && <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => setForm('new')}>Thêm chương trình</Button>}
      </div>
      <KhungBang className="list-scroll bg-white shadow-sm">
        <table className="w-full min-w-[1180px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan + ' w-[80px]'}>Kênh</th>
              <th className={thChuan}>Áp cho</th>
              <th className={thChuan + ' w-[110px]'}>Mức giảm</th>
              <th className={thChuan + ' w-[200px]'}>Kỳ</th>
              <th className={thChuan + ' w-[230px]'}>Lịch</th>
              <th className={thChuan + ' w-[140px]'}>Trạng thái</th>
              {canManage && <th className={thChuan + ' w-[110px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className={tdTrong}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className={tdTrong}><CalendarDays className="mx-auto mb-2 h-6 w-6" /> Chưa có chương trình khuyến mại nào.</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={r.id} className={trChuan(i) + (r.enabled ? '' : ' opacity-55')}>
                {/* 11px → 12px: mọi nhãn/số trong bảng cùng cỡ chữ (mẫu chốt §2). */}
                <td className={tdChuan + ' text-center'}><span className={`rounded-full px-2 py-0.5 font-bold ${r.kenh === 'QR' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>{r.kenh}</span></td>
                <td className={tdChuan + ' text-slate-700'}>{r.kenh === 'POS' ? (r.cardTypeName ?? (r.bankName ? `${r.bankName} (mọi loại thẻ)` : `Thẻ #${r.cardTypeId ?? '?'}`)) : (r.bankName ?? 'Mọi ngân hàng')}</td>
                <td className={tdPhanTram}>{fmtPct(r.deltaPct)}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{fmtDate(r.fromDate)} → {fmtDate(ngayDenHienThi(r.toDate))}</td>
                <td className={tdChuan + ' text-slate-600'}>{lichLabel(r)}</td>
                <td className={tdChuan + ' text-center'}>
                  {canManage ? (
                    <button type="button" onClick={() => void toggle(r)} title={r.enabled ? 'Bấm để TẮT' : 'Bấm để BẬT'}
                      className={`rounded-full px-2.5 py-1 font-bold ${r.enabled ? 'bg-success/15 text-success' : 'bg-slate-200 text-slate-500'}`}>
                      {r.enabled ? 'ĐANG CHẠY' : 'ĐANG TẮT'}
                    </button>
                  ) : (
                    <span className={`rounded-full px-2.5 py-1 font-bold ${r.enabled ? 'bg-success/15 text-success' : 'bg-slate-200 text-slate-500'}`}>{r.enabled ? 'ĐANG CHẠY' : 'ĐANG TẮT'}</span>
                  )}
                </td>
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Sửa" onClick={() => setForm(r)}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <HangDem soCot={soCot} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={soCot}>
                TỔNG {rows.length} chương trình · đang chạy {rows.filter((r) => r.enabled).length}
              </td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {form && <PromoForm cards={cards} banks={banks} init={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa chương trình khuyến mại" message={`Chương trình ${del.kenh} · ${del.kenh === 'POS' ? del.cardTypeName : (del.bankName ?? 'mọi ngân hàng')} sẽ bị xóa. Xác nhận?`} confirmLabel="Xóa" danger onCancel={() => setDel(null)} onConfirm={() => doDelete(del)} />}
    </div>
  );
}

/** to_date lưu = 00:00 HCM NGÀY SAU "đến ngày" (nửa-mở) → hiển thị/sửa lùi 1 ngày cho đúng ngôn ngữ người dùng. */
function ngayDenHienThi(toDateIso: string): string {
  const t = new Date(new Date(toDateIso).getTime() - 86_400_000);
  return t.toISOString();
}

function PromoForm({ cards, banks, init, onClose, onSaved }: { cards: CardTypeDto[]; banks: { id: number; code?: string | null; name: string }[]; init: PromoProgramRow | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [kenh, setKenh] = useState<'POS' | 'QR'>(init?.kenh ?? 'POS');
  const [cardTypeId, setCardTypeId] = useState(init?.cardTypeId != null ? String(init.cardTypeId) : '');
  const [bankId, setBankId] = useState(init?.bankId != null ? String(init.bankId) : '');
  const [deltaPct, setDeltaPct] = useState(init ? String(init.deltaPct) : '');
  const [fromDate, setFromDate] = useState(init ? init.fromDate.slice(0, 10) : '');
  const [toDate, setToDate] = useState(init ? ngayDenHienThi(init.toDate).slice(0, 10) : '');
  const [lich, setLich] = useState<'RANGE' | 'WEEKEND' | 'DATES'>(init?.lich ?? 'RANGE');
  const [ngayCuThe, setNgayCuThe] = useState((init?.ngayCuThe ?? []).join(', '));
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    if (kenh === 'POS' && !cardTypeId && !bankId) return toast.alert('Kênh POS: chọn NGÂN HÀNG (áp mọi loại thẻ) hoặc 1 loại thẻ.', 'Thiếu thông tin');
    const n = Number(deltaPct);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return toast.alert('Mức giảm không hợp lệ (>0 – 100).', 'Giá trị không hợp lệ');
    if (!fromDate || !toDate) return toast.alert('Chọn đủ Từ ngày / Đến ngày.', 'Thiếu thông tin');
    const ds = ngayCuThe.split(/[\s,;]+/).filter(Boolean);
    if (lich === 'DATES' && ds.length === 0) return toast.alert('Lịch "ngày cụ thể" phải nhập ≥1 ngày (YYYY-MM-DD).', 'Thiếu thông tin');
    setBusy(true);
    const res = (await window.api.promoProgramSet({
      id: init?.id, kenh,
      cardTypeId: kenh === 'POS' && cardTypeId ? Number(cardTypeId) : null,
      bankId: bankId ? Number(bankId) : null,
      deltaPct: n, fromDate, toDate, lich,
      ngayCuThe: lich === 'DATES' ? ds : undefined,
      enabled: init ? init.enabled : true, note: init?.note ?? null
    })) as ApiMutResult;
    setBusy(false);
    if (res.ok) { toast.success(init ? 'Đã cập nhật chương trình' : 'Đã tạo chương trình khuyến mại'); onSaved(); }
    else toast.alert(res.message ?? 'Lưu thất bại', 'Không lưu được');
  }
  return (
    <Modal title={init ? 'Sửa chương trình khuyến mại' : 'Thêm chương trình khuyến mại'} onClose={onClose} width="max-w-lg" onSubmit={() => void save()}>
      <p className="mb-3 text-xs text-slate-400">Giảm GIÁ BÁN trong kỳ. POS: theo loại thẻ · QR: theo ngân hàng của mã (bỏ trống = mọi ngân hàng, giảm cả bậc tiền chờ lẫn tiền nhanh). Áp NGAY khi lưu; tắt là về giá thường ngay.</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-slate-500">Kênh
          <div className="flex gap-2">
            {(['POS', 'QR'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setKenh(k)} className={`rounded-lg border px-4 py-1.5 text-sm font-semibold ${kenh === k ? 'border-brand bg-brand-tint text-brand' : 'border-line bg-white text-slate-500'}`}>{k}</button>
            ))}
          </div>
        </label>
        {kenh === 'POS' ? (
          <>
            {/* [Admin Demo 12/9] POS: thường CHỈ CẦN CHỌN NGÂN HÀNG (áp mọi loại thẻ); loại thẻ là TUỲ CHỌN thu hẹp. */}
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Ngân hàng (áp mọi loại thẻ)
              <select value={bankId} onChange={(e) => { setBankId(e.target.value); if (e.target.value) setCardTypeId(''); }} className="rounded-lg border border-line px-2 py-2 text-sm text-slate-700">
                <option value="">— Chọn ngân hàng —</option>
                {banks.map((b) => <option key={b.id} value={b.id}>{b.code ?? b.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Loại thẻ (tuỳ chọn — thu hẹp)
              <select value={cardTypeId} onChange={(e) => { setCardTypeId(e.target.value); if (e.target.value) setBankId(''); }} className="rounded-lg border border-line px-2 py-2 text-sm text-slate-700">
                <option value="">Tất cả loại thẻ của ngân hàng</option>
                {cards.map((c) => <option key={c.id} value={c.id}>{c.name}{c.bankName ? ` · ${c.bankName}` : ''}</option>)}
              </select>
            </label>
          </>
        ) : (
          <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-slate-500">Ngân hàng (mã QR)
            <select value={bankId} onChange={(e) => setBankId(e.target.value)} className="rounded-lg border border-line px-2 py-2 text-sm text-slate-700">
              <option value="">Mọi ngân hàng</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.code ?? b.name}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Mức giảm (%)
          <input value={deltaPct} onChange={(e) => setDeltaPct(e.target.value)} placeholder="0.02" className="rounded-lg border border-line px-2 py-2 text-sm text-slate-700" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Lịch áp
          <select value={lich} onChange={(e) => setLich(e.target.value as 'RANGE' | 'WEEKEND' | 'DATES')} className="rounded-lg border border-line px-2 py-2 text-sm text-slate-700">
            <option value="RANGE">Cả kỳ (mọi ngày)</option>
            <option value="WEEKEND">Chỉ Thứ 7 + Chủ nhật</option>
            <option value="DATES">Ngày cụ thể</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Từ ngày
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg border border-line px-2 py-2 text-sm text-slate-700" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Đến hết ngày
          <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} className="rounded-lg border border-line px-2 py-2 text-sm text-slate-700" />
        </label>
        {lich === 'DATES' && (
          <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-slate-500">Ngày cụ thể (YYYY-MM-DD, cách nhau dấu phẩy)
            <input value={ngayCuThe} onChange={(e) => setNgayCuThe(e.target.value)} placeholder="2026-09-18, 2026-09-25" className="rounded-lg border border-line px-2 py-2 font-mono text-sm text-slate-700" />
          </label>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="soft" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : init ? 'Cập nhật' : 'Tạo chương trình'}</Button>
      </div>
    </Modal>
  );
}

function WeekendAdjustTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<WeekendSellAdjustRow[]>([]);
  const [cards, setCards] = useState<CardTypeDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(false);
  const [del, setDel] = useState<WeekendSellAdjustRow | null>(null);

  async function loadRefs(): Promise<void> {
    const c = await window.api.cardTypeList({});
    if (c.ok && c.data) setCards(c.data);
  }
  async function reload(): Promise<void> {
    setLoading(true);
    const res = (await window.api.weekendSellAdjustList()) as ApiListResult<WeekendSellAdjustRow>;
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void loadRefs(); void reload(); /* eslint-disable-next-line */ }, []);

  async function doDelete(r: WeekendSellAdjustRow): Promise<void> {
    const res = (await window.api.weekendSellAdjustDelete(r.id)) as ApiMutResult;
    if (res.ok) toast.success(`Đã xóa mức giảm cuối tuần cho ${r.cardTypeName ?? 'thẻ'}`);
    else toast.alert(res.message ?? 'Xóa thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }

  const soCot = 3 + (canManage ? 1 : 0);

  return (
    <div>
      <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
        <div className="shrink-0 text-xs text-slate-500">{rows.length} mức giảm · <span className="text-slate-400">chỉ áp Thứ 7 + Chủ nhật, cho thẻ MB &amp; MBV</span></div>
        <div className="flex-1" />
        <Button variant="soft" data-nut="lammoi" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reload()} title="Tải lại dữ liệu mới nhất">Làm mới</Button>
        {canManage && <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => cards.length ? setForm(true) : toast.alert('Chưa có loại thẻ nào — thêm ở Cấu hình ngân hàng › Loại thẻ trước.', 'Thiếu dữ liệu nền')}>Thêm mức giảm</Button>}
      </div>
      <KhungBang className="list-scroll bg-white shadow-sm">
        <table className="w-full min-w-[760px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan}>Loại thẻ</th>
              <th className={thChuan + ' w-[180px]'}>Mức giảm phí bán</th>
              <th className={thChuan + ' w-[160px]'}>Hiệu lực từ</th>
              {canManage && <th className={thChuan + ' w-[110px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className={tdTrong}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className={tdTrong}><CalendarDays className="mx-auto mb-2 h-6 w-6" /> Chưa cấu hình mức giảm cuối tuần.</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={r.id} className={trChuan(i)}>
                <td className={tdChuan}><span className="font-mono font-semibold whitespace-nowrap text-brand">{r.cardTypeCode}</span> <span className="text-slate-700">{r.cardTypeName}</span></td>
                <td className={tdPhanTram}>{fmtPct(r.deltaPct)}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{fmtDate(r.effectiveFrom)}</td>
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <HangDem soCot={soCot} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={soCot}>TỔNG {rows.length} mức giảm cuối tuần</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {form && <WeekendAdjustForm cards={cards} onClose={() => setForm(false)} onSaved={() => { setForm(false); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa mức giảm cuối tuần" message={`Mức giảm phí bán cuối tuần cho "${del.cardTypeName}" sẽ bị xóa. Xác nhận?`} confirmLabel="Xóa" danger onCancel={() => setDel(null)} onConfirm={() => doDelete(del)} />}
    </div>
  );
}

function WeekendAdjustForm({ cards, onClose, onSaved }: { cards: CardTypeDto[]; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [cardTypeId, setCardTypeId] = useState('');
  const [deltaPct, setDeltaPct] = useState('');
  const [busy, setBusy] = useState(false);

  function validPct(s: string): boolean {
    if (s === '') return false;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 && n <= 100 && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;
  }
  async function save(): Promise<void> {
    if (!cardTypeId) return toast.alert('Vui lòng chọn loại thẻ.', 'Thiếu thông tin');
    if (!validPct(deltaPct)) return toast.alert('Mức giảm không hợp lệ (0–100, tối đa 3 số thập phân).', 'Giá trị không hợp lệ');
    setBusy(true);
    const res = (await window.api.weekendSellAdjustSet({ cardTypeId: Number(cardTypeId), deltaPct: Number(deltaPct) })) as ApiMutResult;
    setBusy(false);
    if (res.ok) { toast.success('Đã lưu mức giảm phí bán cuối tuần'); onSaved(); }
    else toast.alert(res.message ?? 'Lưu thất bại', 'Không lưu được');
  }
  return (
    <Modal title="Thêm mức giảm phí bán cuối tuần" onClose={onClose} width="max-w-md" onSubmit={() => void save()}>
      <p className="mb-3 text-xs text-slate-400">Chỉ áp Thứ 7 + Chủ nhật, cho thẻ MB &amp; MBV. Áp từ HÔM NAY trở đi (không lùi ngày).</p>
      <div className="grid grid-cols-1 gap-4">
        <Field label="Loại thẻ" required>
          <select className={inputCls} value={cardTypeId} onChange={(e) => setCardTypeId(e.target.value)} autoFocus>
            <option value="">— Chọn loại thẻ —</option>
            {cards.map((c) => <option key={c.id} value={c.id}>{c.bankCode ? `${c.bankCode} · ` : ''}{c.code} · {c.name}</option>)}
          </select>
        </Field>
        <Field label="Mức giảm phí bán (%)" required hint="% trừ vào phí bán khi giao dịch rơi vào cuối tuần">
          <input className={inputCls + ' text-right tabular-nums'} inputMode="decimal" value={deltaPct} onChange={(e) => setDeltaPct(e.target.value)} placeholder="0.05" />
        </Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>Lưu mức giảm</Button>
      </div>
    </Modal>
  );
}

// ── §QR-2 GIÁ QR THEO ĐỐI TÁC (TẦNG 1 — mặc định) ─────────────────────────────
function QrPartnerFeeTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<QrPartnerFeeRow[]>([]);
  const [partners, setPartners] = useState<PartnerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<false | { edit?: QrPartnerFeeRow }>(false);
  const [showHist, setShowHist] = useState<Set<number>>(new Set()); // [Admin Demo 6/9] đối tác đang mở "lịch sử giá".

  async function loadRefs(): Promise<void> {
    const p = await window.api.partnerList({});
    if (p.ok && p.data) setPartners(p.data);
  }
  async function reload(): Promise<void> {
    setLoading(true);
    const res = (await window.api.qrPartnerFeeList()) as ApiListResult<QrPartnerFeeRow>;
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void loadRefs(); void reload(); /* eslint-disable-next-line */ }, []);

  // [Admin Demo 6/9] 1 DÒNG/ĐỐI TÁC = giá HIỆN HÀNH (bản hiệu lực mới nhất); bản cũ = lịch sử (ẩn, bấm xem). rows đã
  // ORDER partner_id ASC, effective_from DESC → phần tử đầu mỗi group = hiện hành. Hết cảnh "2 Anh Quốc" (thực ra là lịch sử giá).
  const byPartner = new Map<number, QrPartnerFeeRow[]>();
  for (const r of rows) { const a = byPartner.get(r.partnerId) ?? []; a.push(r); byPartner.set(r.partnerId, a); }
  const groups = [...byPartner.values()];

  return (
    <div>
      <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
        <div className="shrink-0 text-xs text-slate-500">{groups.length} đối tác · <span className="text-slate-400">giá HIỆN HÀNH (bản mới nhất) · bấm "lịch sử" xem giá cũ · cuối tuần chỉ đổi giá mua</span></div>
        <div className="flex-1" />
        <Button variant="soft" data-nut="lammoi" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reload()} title="Tải lại dữ liệu mới nhất">Làm mới</Button>
        {canManage && <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => partners.length ? setForm({}) : toast.alert('Chưa có đối tác — thêm ở Cấu hình ngân hàng › Đối tác trước.', 'Thiếu dữ liệu nền')}>Đặt giá QR</Button>}
      </div>
      <KhungBang className="list-scroll bg-white shadow-sm">
        <table className="w-full min-w-[1080px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan}>Đối tác</th>
              <th className={thChuan + ' w-[180px]'}>Phí mua (ngày thường)</th>
              <th className={thChuan + ' w-[180px]'}>Phí mua (cuối tuần)</th>
              <th className={thChuan + ' w-[130px]'}>Phí bán</th>
              <th className={thChuan + ' w-[200px]'}>Hiệu lực từ</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className={tdTrong}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && groups.length === 0 && <tr><td colSpan={5} className={tdTrong}><QrCode className="mx-auto mb-2 h-6 w-6" /> Chưa cấu hình giá QR theo đối tác.</td></tr>}
            {!loading && groups.map((g, i) => {
              const cur = g[0]; const hist = g.slice(1); const open = showHist.has(cur.partnerId);
              return (
                <Fragment key={cur.id}>
                  <tr className={trChuan(i)}>
                    <td className={tdChuan}>
                      <span className="font-mono font-semibold whitespace-nowrap text-brand">{cur.partnerCode}</span> <span className="text-slate-700">{cur.partnerName}</span>
                      {/* 11px/10px → 12px: mọi chữ trong bảng cùng cỡ (mẫu chốt §2). */}
                      {canManage && <button type="button" onClick={() => setForm({ edit: cur })} className="ml-2 rounded border border-brand/40 px-1.5 py-0.5 font-semibold text-brand hover:bg-brand-tint">Sửa giá</button>}
                      {hist.length > 0 && <button type="button" onClick={() => setShowHist((s) => { const n = new Set(s); n.has(cur.partnerId) ? n.delete(cur.partnerId) : n.add(cur.partnerId); return n; })} className="ml-2 rounded border border-line px-1.5 py-0.5 text-slate-500 hover:bg-appbg">{open ? 'ẩn lịch sử' : `lịch sử (${hist.length})`}</button>}
                    </td>
                    <td className={tdPhanTram}>{fmtPct(cur.phiMuaThuongPct)}</td>
                    <td className={tdPhanTram}>{fmtPct(cur.phiMuaCuoiTuanPct)}</td>
                    <td className={tdPhanTram}>{fmtPct(cur.phiBanPct)}</td>
                    <td className={tdChuan + ' text-center text-slate-600'}>{fmtDate(cur.effectiveFrom)} <span className="ml-1 rounded bg-emerald-100 px-1 font-semibold text-emerald-700">hiện hành</span></td>
                  </tr>
                  {open && hist.map((h) => (
                    <tr key={h.id} className="border-t border-line bg-appbg/40 text-slate-400">
                      <td className={tdChuan + ' pl-8 italic'}>↳ lịch sử (hết hiệu lực)</td>
                      <td className={tdChuan + ' text-center tabular-nums'}>{fmtPct(h.phiMuaThuongPct)}</td>
                      <td className={tdChuan + ' text-center tabular-nums'}>{fmtPct(h.phiMuaCuoiTuanPct)}</td>
                      <td className={tdChuan + ' text-center tabular-nums'}>{fmtPct(h.phiBanPct)}</td>
                      <td className={tdChuan + ' text-center'}>{fmtDate(h.effectiveFrom)}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            <HangDem soCot={5} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={5}>TỔNG {groups.length} đối tác (giá hiện hành)</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {form && <QrPartnerFeeForm partners={partners} initial={form.edit} onClose={() => setForm(false)} onSaved={() => { setForm(false); void reload(); }} />}
    </div>
  );
}

function QrPartnerFeeForm({ partners, initial, onClose, onSaved }: { partners: PartnerDto[]; initial?: QrPartnerFeeRow; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [partnerId, setPartnerId] = useState(initial ? String(initial.partnerId) : '');
  const [phiMuaThuong, setPhiMuaThuong] = useState(initial ? String(initial.phiMuaThuongPct) : '');
  const [phiMuaCuoiTuan, setPhiMuaCuoiTuan] = useState(initial ? String(initial.phiMuaCuoiTuanPct) : '');
  const [phiBan, setPhiBan] = useState(initial ? String(initial.phiBanPct) : '');
  const [effectiveFrom, setEffectiveFrom] = useState(toLocalYmd(new Date())); // [Admin Demo 7/9] cho chọn NGÀY áp dụng; sửa giá = mốc mới.
  const [busy, setBusy] = useState(false);

  function validPct(s: string): boolean {
    if (s === '') return false;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 && n <= 100 && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;
  }
  async function save(): Promise<void> {
    if (!partnerId) return toast.alert('Vui lòng chọn đối tác.', 'Thiếu thông tin');
    for (const [label, v] of [['Phí mua ngày thường', phiMuaThuong], ['Phí mua cuối tuần', phiMuaCuoiTuan], ['Phí bán', phiBan]] as const) {
      if (!validPct(v)) return toast.alert(`${label} không hợp lệ (0–100, tối đa 3 số thập phân).`, 'Giá trị không hợp lệ');
    }
    if (!effectiveFrom) return toast.alert('Vui lòng chọn ngày áp dụng.', 'Thiếu thông tin');
    setBusy(true);
    const res = (await window.api.qrPartnerFeeSet({ partnerId: Number(partnerId), phiMuaThuongPct: Number(phiMuaThuong), phiMuaCuoiTuanPct: Number(phiMuaCuoiTuan), phiBanPct: Number(phiBan), effectiveFrom: new Date(effectiveFrom + 'T00:00:00').toISOString() })) as ApiMutResult;
    setBusy(false);
    if (res.ok) { toast.success('Đã lưu giá QR theo đối tác'); onSaved(); }
    else toast.alert(res.message ?? 'Lưu thất bại', 'Không lưu được');
  }
  return (
    <Modal title={initial ? 'Sửa giá QR theo đối tác' : 'Đặt giá QR theo đối tác'} onClose={onClose} width="max-w-lg" onSubmit={() => void save()}>
      <p className="mb-3 text-xs text-slate-400">Giá mặc định của đối tác (tầng 1). Cuối tuần chỉ đổi giá mua; phí bán không đổi theo thứ. Đặt <b>Ngày áp dụng</b> lùi về quá khứ để áp cho bill cũ (vd 01/09).</p>
      <Field label="Đối tác" required>
        <select className={inputCls} value={partnerId} onChange={(e) => setPartnerId(e.target.value)} autoFocus disabled={!!initial}>
          <option value="">— Chọn đối tác —</option>
          {partners.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
        </select>
      </Field>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Field label="Phí mua ngày thường (%)" required><input className={inputCls + ' text-right tabular-nums'} inputMode="decimal" value={phiMuaThuong} onChange={(e) => setPhiMuaThuong(e.target.value)} placeholder="1.10" /></Field>
        <Field label="Phí mua cuối tuần (%)" required><input className={inputCls + ' text-right tabular-nums'} inputMode="decimal" value={phiMuaCuoiTuan} onChange={(e) => setPhiMuaCuoiTuan(e.target.value)} placeholder="1.20" /></Field>
        <Field label="Phí bán (%)" required><input className={inputCls + ' text-right tabular-nums'} inputMode="decimal" value={phiBan} onChange={(e) => setPhiBan(e.target.value)} placeholder="1.05" /></Field>
      </div>
      <div className="mt-4">
        <Field label="Ngày áp dụng" required hint="Kỳ giá áp cho bill có ngày ≥ mốc này. Lùi về 01/09 để áp giá cho bill đầu tháng."><input type="date" className={inputCls} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>Lưu giá QR</Button>
      </div>
    </Modal>
  );
}

// §4 GIÁ BÁN QR THEO ĐẠI LÝ (Admin Demo 5/9 "phí bán tùy khách") — lớp ĐÈ giá bán mặc định của mã, khóa theo customerId
// (đại lý=khách=1). Chưa đặt → đại lý dùng giá bán mặc định của mã. KHÔNG đổi theo thứ.
function QrDealerSellFeeTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<QrDealerSellFeeRow[]>([]);
  const [customers, setCustomers] = useState<CustomerRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<false | { edit?: QrDealerSellFeeRow }>(false);

  async function loadRefs(): Promise<void> {
    const c = (await window.api.customerList({})) as { ok: boolean; data?: CustomerRef[] };
    if (c.ok && c.data) setCustomers(c.data);
  }
  async function reload(): Promise<void> {
    setLoading(true);
    const res = (await window.api.qrDealerSellFeeList()) as ApiListResult<QrDealerSellFeeRow>;
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void loadRefs(); void reload(); /* eslint-disable-next-line */ }, []);

  return (
    <div>
      <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
        <div className="shrink-0 text-xs text-slate-500">{rows.length} giá bán · <span className="text-slate-400">đè giá bán mặc định của mã; chưa đặt → dùng giá mặc định</span></div>
        <div className="flex-1" />
        <Button variant="soft" data-nut="lammoi" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reload()} title="Tải lại dữ liệu mới nhất">Làm mới</Button>
        {canManage && <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => customers.length ? setForm({}) : toast.alert('Chưa có khách/đại lý.', 'Thiếu dữ liệu nền')}>Đặt giá bán</Button>}
      </div>
      <KhungBang className="list-scroll bg-white shadow-sm">
        <table className="w-full min-w-[760px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan}>Đại lý (khách)</th>
              <th className={thChuan + ' w-[130px]'}>Phí bán</th>
              <th className={thChuan + ' w-[160px]'}>Hiệu lực từ</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={3} className={tdTrong}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={3} className={tdTrong}><QrCode className="mx-auto mb-2 h-6 w-6" /> Chưa đặt giá bán QR riêng cho đại lý nào (dùng giá mặc định của mã).</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={r.id} className={trChuan(i)}>
                <td className={tdChuan + ' text-slate-700'}>{r.customerName ?? `Khách ${r.customerId}`}{canManage && <button type="button" onClick={() => setForm({ edit: r })} className="ml-2 rounded border border-brand/40 px-1.5 py-0.5 font-semibold text-brand hover:bg-brand-tint">Sửa giá</button>}</td>
                <td className={tdPhanTram}>{fmtPct(r.phiBanPct)}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{fmtDate(r.effectiveFrom)}</td>
              </tr>
            ))}
            <HangDem soCot={3} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={3}>TỔNG {rows.length} giá bán theo đại lý</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {form && <QrDealerSellFeeForm customers={customers} initial={form.edit} onClose={() => setForm(false)} onSaved={() => { setForm(false); void reload(); }} />}
    </div>
  );
}

function QrDealerSellFeeForm({ customers, initial, onClose, onSaved }: { customers: CustomerRef[]; initial?: QrDealerSellFeeRow; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [customerId, setCustomerId] = useState(initial ? String(initial.customerId) : '');
  const [phiBan, setPhiBan] = useState(initial ? String(initial.phiBanPct) : '');
  const [effectiveFrom, setEffectiveFrom] = useState(toLocalYmd(new Date())); // [Admin Demo 7/9] cho chọn NGÀY áp dụng.
  const [busy, setBusy] = useState(false);
  function validPct(s: string): boolean {
    if (s === '') return false;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 && n <= 100 && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;
  }
  async function save(): Promise<void> {
    if (!customerId) return toast.alert('Vui lòng chọn đại lý.', 'Thiếu thông tin');
    if (!validPct(phiBan)) return toast.alert('Phí bán không hợp lệ (0–100, tối đa 3 số thập phân).', 'Giá trị không hợp lệ');
    if (!effectiveFrom) return toast.alert('Vui lòng chọn ngày áp dụng.', 'Thiếu thông tin');
    setBusy(true);
    const res = (await window.api.qrDealerSellFeeSet({ customerId: Number(customerId), phiBanPct: Number(phiBan), effectiveFrom: new Date(effectiveFrom + 'T00:00:00').toISOString() })) as ApiMutResult;
    setBusy(false);
    if (res.ok) { toast.success('Đã lưu giá bán QR cho đại lý'); onSaved(); }
    else toast.alert(res.message ?? 'Lưu thất bại', 'Không lưu được');
  }
  const custLabel = (c: CustomerRef): string => `${c.code ? c.code + ' · ' : ''}${c.nickname || c.fullName || 'Khách ' + c.id}`;
  return (
    <Modal title={initial ? 'Sửa giá bán QR theo đại lý' : 'Đặt giá bán QR theo đại lý'} onClose={onClose} width="max-w-md" onSubmit={() => void save()}>
      <p className="mb-3 text-xs text-slate-400">Đè giá bán QR MẶC ĐỊNH của mã cho riêng đại lý này. Chưa đặt → đại lý dùng giá mặc định. KHÔNG đổi theo thứ (cuối tuần chỉ đổi giá mua).</p>
      <Field label="Đại lý (khách)" required>
        <select className={inputCls} value={customerId} onChange={(e) => setCustomerId(e.target.value)} autoFocus disabled={!!initial}>
          <option value="">— Chọn đại lý —</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{custLabel(c)}</option>)}
        </select>
      </Field>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label="Phí bán (%)" required><input className={inputCls + ' text-right tabular-nums'} inputMode="decimal" value={phiBan} onChange={(e) => setPhiBan(e.target.value)} placeholder="1.05" /></Field>
        <Field label="Ngày áp dụng" required hint="Bill có ngày ≥ mốc này"><input type="date" className={inputCls} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>Lưu giá bán</Button>
      </div>
    </Modal>
  );
}
