import { useEffect, useState, useRef } from 'react';
import { baoLoi } from '../lib/bao-loi';
import { Plus, Pencil, Trash2, Loader2, Building2, Cpu, PackagePlus, Tag, Download, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate, fmtTime, groupDigits, parseVndInput, prereqMessage } from '@sigma/shared';
import type { PrereqDef } from '@sigma/shared';
import type { SupplierDto, PosModelDto, IntakeStatusDto, PosIntakeDto, LiteRef, WarehouseLite, BankLite } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { DateInput } from '../components/DateInput.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Field, inputCls } from '../components/Field.js';
import { FilterBar } from '../components/FilterBar.js';
import { StatBar } from '../components/StatBar.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { ImportButton } from '../components/ImportModal.js';
import { TabBar, TabButton } from '../components/Tabs.js';
import { useRowSelection, SelectionBar } from '../components/Selection.js';
import { exportCsv } from '../lib/exportCsv.js';
import type { AuditTrailRow } from '../components/AuditCells.js';
import { thChuan, tdChuan, tdTongChuan, tdTien, trChuan, KhungBang } from '../components/BangChuan.js';

type Tab = 'supplier' | 'model' | 'intake' | 'status';

// Tông màu luân phiên cho bộ đếm theo nhóm (đồng bộ CustomersPage).
const GROUP_TONES = ['bg-indigo-50 text-indigo-600', 'bg-emerald-50 text-emerald-600', 'bg-amber-50 text-amber-600', 'bg-sky-50 text-sky-600', 'bg-violet-50 text-violet-600', 'bg-rose-50 text-rose-600'];

/** MẪU CHỐT 6/11: khung bảng của các trang KHÔNG dựng theo chiều cao flex (nằm trong `<main overflow-auto>`)
 *  nên phải KHÓA chiều cao bằng max-h để `overflow-auto` thật sự tạo khung cuộn — có khung cuộn thì tiêu đề
 *  `sticky top-0` và hàng TỔNG `sticky bottom-0` mới ghim trong bảng (giống màn DOANH SỐ). Số 15rem giữ đúng
 *  chiều cao cũ của `.list-scroll` để không đổi bố cục trang. */
const CAO_KHUNG = 'max-h-[calc(100vh-15rem)] bg-white shadow-sm';

/** Nhóm 3 chữ số kiểu VN, KHÔNG kèm ký hiệu tiền — dùng TRONG BẢNG (mẫu chốt 6/11 §2: bảng bỏ ký tự đ/₫).
 *  Dùng `groupDigits` của @sigma/shared (nguồn duy nhất), KHÔNG toLocaleString. */
function soTien(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? '−' : '') + groupDigits(Math.abs(v).toString());
}
/** Có ký hiệu ₫ — chỉ dùng NGOÀI bảng (gợi ý dưới ô nhập giá). */
function fmtVnd(n: number): string {
  return soTien(n) + ' ₫';
}

/** 3 ô TIÊU ĐỀ khối "thông tin tạo" theo KIỂU CHUẨN (thChuan).
 *  Vì sao không dùng `AuditTrailHeadCells`: component dùng chung đó còn mang chuỗi class tự chế
 *  (`px-4 py-3`, canh trái, không nền) nên 3 ô này sẽ HỞ NỀN giữa hàng tiêu đề xám — lỗi chỉ nhìn ảnh mới
 *  thấy. Đợt này không được sửa file dùng chung ngoài nhóm B ⇒ render tại trang bằng thChuan; đề xuất bổ
 *  sung prop class cho AuditCells đã ghi trong báo cáo. */
function ThTao(): JSX.Element {
  return (
    <>
      <th className={thChuan + ' w-[120px]'}>Người tạo</th>
      <th className={thChuan + ' w-[88px]'}>Ngày tạo</th>
      <th className={thChuan + ' w-[72px]'}>Giờ tạo</th>
    </>
  );
}
/** 3 ô DỮ LIỆU tương ứng ThTao — cột ngày/giờ là cột SỐ nên cùng cỡ chữ 12px của bảng (không text-[11px]). */
function TdTao({ row }: { row: AuditTrailRow }): JSX.Element {
  return (
    <>
      <td className={tdChuan + ' truncate text-center text-slate-600'} title={row.createdByName ?? ''}>{row.createdByName ?? '—'}</td>
      <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{fmtDate(row.createdAt)}</td>
      <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{fmtTime(row.createdAt)}</td>
    </>
  );
}
/** Ô tích CHỌN TẤT CẢ theo kiểu chuẩn (không dùng SelectAllCell vì nó tự chế class px-4 py-3). */
function ThTich({ ids, sel }: { ids: number[]; sel: ReturnType<typeof useRowSelection> }): JSX.Element {
  const allOn = ids.length > 0 && ids.every((id) => sel.isSelected(id));
  return (
    <th className={thChuan + ' w-9 !px-1.5'}>
      <input type="checkbox" className="accent-brand" checked={allOn} aria-label="Chọn tất cả" onChange={(e) => sel.setAll(ids, e.target.checked)} />
    </th>
  );
}
/** Ô tích 1 dòng theo kiểu chuẩn. */
function TdTich({ id, sel }: { id: number; sel: ReturnType<typeof useRowSelection> }): JSX.Element {
  return (
    <td className={tdChuan + ' !px-1.5 text-center'}>
      <input type="checkbox" className="accent-brand" checked={sel.isSelected(id)} aria-label={`Chọn dòng ${id}`} onChange={() => sel.toggle(id)} />
    </td>
  );
}


export function PosSupplyPage({ user }: { user: AuthUser }): JSX.Element {
  const [tab, setTab] = useState<Tab>('supplier');
  const canManage = hasPermission(user, 'CONFIG_POS_SUPPLY_MANAGE');
  return (
    // MẪU CHỐT 6/11: `data-nut-vuong` ở thẻ bọc NGOÀI CÙNG để trang ăn luật nút/thanh cuộn/màu của mau-moi.css.
    <div data-nut-vuong data-trang-full>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-800">Cấu hình máy POS</h2>
        <p className="text-sm text-slate-500">Nhà cung cấp · Chủng loại máy · Nhập kho máy POS · Trạng thái nhập.</p>
      </div>
      <TabBar>
        <TabButton active={tab === 'supplier'} onClick={() => setTab('supplier')} icon={<Building2 className="h-4 w-4" />}>Nhà cung cấp</TabButton>
        <TabButton active={tab === 'model'} onClick={() => setTab('model')} icon={<Cpu className="h-4 w-4" />}>Chủng loại POS</TabButton>
        <TabButton active={tab === 'status'} onClick={() => setTab('status')} icon={<Tag className="h-4 w-4" />}>Trạng thái nhập</TabButton>
        <TabButton active={tab === 'intake'} onClick={() => setTab('intake')} icon={<PackagePlus className="h-4 w-4" />}>Nhập kho POS</TabButton>
      </TabBar>
      {tab === 'supplier' && <SupplierTab canManage={canManage} />}
      {tab === 'model' && <ModelTab canManage={canManage} />}
      {tab === 'intake' && <IntakeTab canManage={canManage} />}
      {tab === 'status' && <StatusTab canManage={canManage} />}
    </div>
  );
}

// ── §C6 NHÀ CUNG CẤP ─────────────────────────────────────────────────────────
export function SupplierTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<SupplierDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: SupplierDto } | null>(null);
  const [del, setDel] = useState<SupplierDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef1 = useRef<() => void>(() => {});
  reloadRef1.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.supplierList({ search: search || undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  async function doDelete(s: SupplierDto, password?: string): Promise<void> {
    const res = await window.api.supplierDelete([s.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa nhà cung cấp ${s.code}`);
    else baoLoi(toast.alert, res, 'Xóa nhà cung cấp');
    setDel(null);
    await reload();
  }

  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.supplierDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} nhà cung cấp`);
    else baoLoi(toast.alert, res, 'Xóa nhà cung cấp');
    setBulkDel(false);
    await reload();
  }

  // Số cột THẬT của bảng (ô tích + 4 cột dữ liệu + 3 cột thông tin tạo + Thao tác). Hàng rỗng / hàng đệm
  // dùng đúng số này — lệch là bài kiểm `_mau-nhomB.mjs` bắt ngay (đếm <th> render thật).
  const soCot = 7 + (canManage ? 2 : 0);

  return (
    <div data-nut-vuong>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} nhà cung cấp</div>
        <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('nha_cung_cap', ['Mã', 'Tên nhà cung cấp', 'Người liên hệ', 'Số điện thoại', 'Địa chỉ', 'Người tạo', 'Ngày tạo', 'Giờ tạo', 'Người sửa', 'Ngày sửa', 'Giờ sửa'], rows.map((r) => [r.code, r.name, r.contactPerson, r.phone, r.address, r.createdByName ?? '', fmtDate(r.createdAt), fmtTime(r.createdAt), r.updatedByName ?? '', fmtDate(r.updatedAt), fmtTime(r.updatedAt)]))}>Xuất Excel</Button>
          {canManage && <Button data-nut="them" variant="confirm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm nhà cung cấp</Button>}
        </div>
      </div>
      <FilterBar search={search} onSearch={setSearch} searchPlaceholder="Tìm mã / tên / số điện thoại nhà cung cấp…" onApply={reload} onReset={() => { setSearch(''); setTimeout(() => reloadRef1.current(), 0); }} coChuNho locPhai />
      <StatBar items={[{ label: 'Tổng nhà cung cấp', value: rows.length, tone: 'bg-brand-tint text-brand' }]} />
      {canManage && <SelectionBar count={sel.count} entityLabel="nhà cung cấp" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <KhungBang className={CAO_KHUNG}>
        {/* min-w: thiếu chỗ thì CUỘN NGANG, tuyệt đối KHÔNG ẩn cột theo breakpoint (mẫu chốt 6/11 §1). */}
        <table className="w-full min-w-[1120px] text-xs">
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              {canManage && <ThTich ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[110px]'}>Mã</th>
              <th className={thChuan + ' w-[300px]'}>Tên nhà cung cấp</th>
              <th className={thChuan + ' w-[160px]'}>Người liên hệ</th>
              <th className={thChuan + ' w-[120px]'}>Số điện thoại</th>
              <ThTao />
              {canManage && <th className={thChuan + ' w-[96px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-sm text-slate-400"><Building2 className="mx-auto mb-2 h-6 w-6" /> Chưa có nhà cung cấp.</td></tr>}
            {!loading && rows.map((s, i) => (
              // SỌC NGỰA VẰN dùng chung `trChuan(i)`; dòng ĐANG TÍCH tô sáng (tham số noiBat).
              <tr key={s.id} className={trChuan(i, sel.isSelected(s.id))}>
                {canManage && <TdTich id={s.id} sel={sel} />}
                <td className={tdChuan + ' text-center font-mono font-semibold text-brand'}>{s.code}</td>
                <td className={tdChuan + ' font-medium text-slate-800'} title={s.name}>{s.name}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{s.contactPerson ?? '—'}</td>
                <td className={tdChuan + ' text-center tabular-nums text-slate-600'}>{s.phone ?? '—'}</td>
                <TdTao row={s} />
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: s })}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(s)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {/* HÀNG ĐỆM (mẫu chốt 6/11 §1): chừa 1 hàng để dòng cuối không bị che khi cuộn tới đáy. */}
            <tr aria-hidden><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>
      {form && <SupplierForm mode={form.mode} row={form.row} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa nhà cung cấp" message={`Nhà cung cấp "${del.name}" (${del.code}) sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều nhà cung cấp" message={`${sel.count} nhà cung cấp đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

function SupplierForm({ mode, row, onClose, onSaved }: { mode: 'create' | 'edit'; row?: SupplierDto; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [name, setName] = useState(row?.name ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  const [address, setAddress] = useState(row?.address ?? '');
  const [phone, setPhone] = useState(row?.phone ?? '');
  const [contactPerson, setContactPerson] = useState(row?.contactPerson ?? '');
  const [busy, setBusy] = useState(false);
  async function save(): Promise<void> {
    if (!name.trim()) return toast.alert('Tên nhà cung cấp bắt buộc.', 'Thiếu thông tin');
    if (!code.trim()) return toast.alert('Mã nhà cung cấp bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    const payload = { name: name.trim(), code: code.trim(), address: address || null, phone: phone || null, contactPerson: contactPerson || null };
    const res = mode === 'edit' && row ? await window.api.supplierUpdate(row.id, { ...payload, expectedUpdatedAt: row.updatedAt }) : await window.api.supplierCreate(payload);
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật nhà cung cấp' : `Đã thêm nhà cung cấp ${code}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else baoLoi(toast.alert, res, 'Lưu nhà cung cấp');
  }
  return (
    <Modal title={mode === 'edit' ? `Sửa nhà cung cấp ${row?.code}` : 'Thêm nhà cung cấp mới'} onClose={onClose} width="max-w-xl" onSubmit={() => void save()}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Tên nhà cung cấp" required><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Mã nhà cung cấp" required hint="Không trùng"><input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label="Người liên hệ"><input className={inputCls} value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} /></Field>
        <Field label="Số điện thoại"><input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label="Địa chỉ"><input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm nhà cung cấp'}</Button>
      </div>
    </Modal>
  );
}

// ── §C7 CHỦNG LOẠI POS ───────────────────────────────────────────────────────
export function ModelTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<PosModelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: PosModelDto } | null>(null);
  const [del, setDel] = useState<PosModelDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef2 = useRef<() => void>(() => {});
  reloadRef2.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.posModelList({ search: search || undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  async function doDelete(m: PosModelDto, password?: string): Promise<void> {
    const res = await window.api.posModelDelete([m.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa chủng loại ${m.code}`);
    else baoLoi(toast.alert, res, 'Xóa chủng loại');
    setDel(null);
    await reload();
  }

  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.posModelDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} chủng loại`);
    else baoLoi(toast.alert, res, 'Xóa chủng loại');
    setBulkDel(false);
    await reload();
  }

  // Ô tích + 2 cột dữ liệu + 3 cột thông tin tạo + Thao tác.
  const soCot = 5 + (canManage ? 2 : 0);

  return (
    <div data-nut-vuong>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} chủng loại máy</div>
        <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('chung_loai_pos', ['Mã máy', 'Tên máy', 'Người tạo', 'Ngày tạo', 'Giờ tạo', 'Người sửa', 'Ngày sửa', 'Giờ sửa'], rows.map((r) => [r.code, r.name, r.createdByName ?? '', fmtDate(r.createdAt), fmtTime(r.createdAt), r.updatedByName ?? '', fmtDate(r.updatedAt), fmtTime(r.updatedAt)]))}>Xuất Excel</Button>
          {canManage && <Button data-nut="them" variant="confirm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm chủng loại</Button>}
        </div>
      </div>
      <FilterBar search={search} onSearch={setSearch} searchPlaceholder="Tìm mã / tên máy…" onApply={reload} onReset={() => { setSearch(''); setTimeout(() => reloadRef2.current(), 0); }} coChuNho locPhai />
      <StatBar items={[{ label: 'Tổng chủng loại', value: rows.length, tone: 'bg-brand-tint text-brand' }]} />
      {canManage && <SelectionBar count={sel.count} entityLabel="chủng loại" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <KhungBang className={CAO_KHUNG}>
        <table className="w-full min-w-[900px] text-xs">
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              {canManage && <ThTich ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[150px]'}>Mã máy POS</th>
              <th className={thChuan + ' w-[300px]'}>Tên máy POS</th>
              <ThTao />
              {canManage && <th className={thChuan + ' w-[96px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-sm text-slate-400"><Cpu className="mx-auto mb-2 h-6 w-6" /> Chưa có chủng loại máy.</td></tr>}
            {!loading && rows.map((m, i) => (
              <tr key={m.id} className={trChuan(i, sel.isSelected(m.id))}>
                {canManage && <TdTich id={m.id} sel={sel} />}
                <td className={tdChuan + ' text-center font-mono font-semibold text-brand'}>{m.code}</td>
                <td className={tdChuan + ' font-medium text-slate-800'} title={m.name}>{m.name}</td>
                <TdTao row={m} />
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: m })}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(m)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <tr aria-hidden><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>
      {form && <ModelForm mode={form.mode} row={form.row} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa chủng loại máy POS" message={`Chủng loại "${del.name}" (${del.code}) sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều chủng loại" message={`${sel.count} chủng loại đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

function ModelForm({ mode, row, onClose, onSaved }: { mode: 'create' | 'edit'; row?: PosModelDto; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [code, setCode] = useState(row?.code ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [busy, setBusy] = useState(false);
  async function save(): Promise<void> {
    if (!code.trim()) return toast.alert('Mã máy POS bắt buộc.', 'Thiếu thông tin');
    if (!name.trim()) return toast.alert('Tên máy POS bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    const res = mode === 'edit' && row ? await window.api.posModelUpdate(row.id, { code: code.trim(), name: name.trim(), expectedUpdatedAt: row.updatedAt }) : await window.api.posModelCreate({ code: code.trim(), name: name.trim() });
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật chủng loại' : `Đã thêm chủng loại ${code}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else baoLoi(toast.alert, res, 'Lưu chủng loại');
  }
  return (
    <Modal title={mode === 'edit' ? `Sửa chủng loại ${row?.code}` : 'Thêm chủng loại máy POS'} onClose={onClose} width="max-w-md" onSubmit={() => void save()}>
      <div className="grid gap-4">
        <Field label="Mã máy POS" required hint="Ví dụ: PAX-A920, VX520"><input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></Field>
        <Field label="Tên máy POS" required><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm chủng loại'}</Button>
      </div>
    </Modal>
  );
}

// ── §C8a TRẠNG THÁI NHẬP MÁY ─────────────────────────────────────────────────
export function StatusTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<IntakeStatusDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: IntakeStatusDto } | null>(null);
  const [del, setDel] = useState<IntakeStatusDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.intakeStatusList();
    if (res.ok && res.data) setRows(res.data);
    else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  async function doDelete(s: IntakeStatusDto, password?: string): Promise<void> {
    const res = await window.api.intakeStatusDelete([s.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa trạng thái ${s.name}`);
    else baoLoi(toast.alert, res, 'Xóa trạng thái');
    setDel(null);
    await reload();
  }

  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.intakeStatusDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} trạng thái`);
    else baoLoi(toast.alert, res, 'Xóa trạng thái');
    setBulkDel(false);
    await reload();
  }

  // Ô tích + 1 cột dữ liệu + 3 cột thông tin tạo + Thao tác.
  const soCot = 4 + (canManage ? 2 : 0);

  return (
    <div data-nut-vuong>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} trạng thái nhập máy · <span className="text-slate-400">ví dụ: Máy mới, Máy cũ, Máy đổi, Máy thuê</span></div>
        <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
          <Button data-nut="lammoi" variant="soft" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reload()} title="Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc)">Làm mới</Button>
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('trang_thai_nhap', ['Tên trạng thái', 'Người tạo', 'Ngày tạo', 'Giờ tạo', 'Người sửa', 'Ngày sửa', 'Giờ sửa'], rows.map((s) => [s.name, s.createdByName ?? '', fmtDate(s.createdAt), fmtTime(s.createdAt), s.updatedByName ?? '', fmtDate(s.updatedAt), fmtTime(s.updatedAt)]))}>Xuất Excel</Button>
          {canManage && <Button data-nut="them" variant="confirm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm trạng thái</Button>}
        </div>
      </div>
      <StatBar items={[{ label: 'Tổng trạng thái', value: rows.length, tone: 'bg-brand-tint text-brand' }]} />
      {canManage && <SelectionBar count={sel.count} entityLabel="trạng thái" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <KhungBang className={CAO_KHUNG}>
        <table className="w-full min-w-[820px] text-xs">
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              {canManage && <ThTich ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[280px]'}>Tên trạng thái</th>
              <ThTao />
              {canManage && <th className={thChuan + ' w-[96px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-sm text-slate-400"><Tag className="mx-auto mb-2 h-6 w-6" /> Chưa có trạng thái nhập máy.</td></tr>}
            {!loading && rows.map((s, i) => (
              <tr key={s.id} className={trChuan(i, sel.isSelected(s.id))}>
                {canManage && <TdTich id={s.id} sel={sel} />}
                <td className={tdChuan + ' font-medium text-slate-800'} title={s.name}>{s.name}</td>
                <TdTao row={s} />
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: s })}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(s)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <tr aria-hidden><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>
      {form && <StatusForm mode={form.mode} row={form.row} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa trạng thái nhập máy" message={`Trạng thái "${del.name}" sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều trạng thái" message={`${sel.count} trạng thái đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

function StatusForm({ mode, row, onClose, onSaved }: { mode: 'create' | 'edit'; row?: IntakeStatusDto; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [name, setName] = useState(row?.name ?? '');
  const [busy, setBusy] = useState(false);
  async function save(): Promise<void> {
    if (!name.trim()) return toast.alert('Tên trạng thái bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    const res = mode === 'edit' && row ? await window.api.intakeStatusUpdate(row.id, { name: name.trim(), expectedUpdatedAt: row.updatedAt }) : await window.api.intakeStatusCreate({ name: name.trim() });
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật trạng thái' : `Đã thêm trạng thái ${name}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else baoLoi(toast.alert, res, 'Lưu trạng thái');
  }
  return (
    <Modal title={mode === 'edit' ? 'Sửa trạng thái nhập máy' : 'Thêm trạng thái nhập máy'} onClose={onClose} width="max-w-md" onSubmit={() => void save()}>
      <Field label="Tên trạng thái" required hint="Ví dụ: Máy mới, Máy cũ, Máy đổi, Máy thuê"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm trạng thái'}</Button>
      </div>
    </Modal>
  );
}

// ── §C8b NHẬP KHO MÁY POS ────────────────────────────────────────────────────
export function IntakeTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<PosIntakeDto[]>([]);
  const [models, setModels] = useState<LiteRef[]>([]);
  const [suppliers, setSuppliers] = useState<LiteRef[]>([]);
  const [statuses, setStatuses] = useState<IntakeStatusDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [modelId, setModelId] = useState('');
  const [statusId, setStatusId] = useState(''); // FIX 1d — lọc trạng thái máy CLIENT-SIDE
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: PosIntakeDto } | null>(null);
  const [del, setDel] = useState<PosIntakeDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  async function loadRefs(): Promise<void> {
    const [m, s, st] = await Promise.all([window.api.posModelLite(), window.api.supplierLite(), window.api.intakeStatusList()]);
    if (m.ok && m.data) setModels(m.data);
    if (s.ok && s.data) setSuppliers(s.data);
    if (st.ok && st.data) setStatuses(st.data);
  }
  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef4 = useRef<() => void>(() => {});
  reloadRef4.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.posIntakeList({ search: search || undefined, supplierId: supplierId ? Number(supplierId) : undefined, posModelId: modelId ? Number(modelId) : undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void loadRefs(); }, []);
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [supplierId, modelId]);

  async function doDelete(pi: PosIntakeDto, password?: string): Promise<void> {
    const res = await window.api.posIntakeDelete([pi.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa máy POS ${pi.serial}`);
    else baoLoi(toast.alert, res, 'Xóa máy POS');
    setDel(null);
    await reload();
  }

  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.posIntakeDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} máy POS`);
    else baoLoi(toast.alert, res, 'Xóa máy POS');
    setBulkDel(false);
    await reload();
  }

  const prereqDefs: PrereqDef[] = [
    { count: models.length, label: 'Chủng loại máy', where: "tab 'Chủng loại POS'" },
    { count: suppliers.length, label: 'Nhà cung cấp', where: "tab 'Nhà cung cấp'" },
    { count: statuses.length, label: 'Trạng thái nhập máy', where: "tab 'Trạng thái nhập'" }
  ];
  const canAdd = canManage && prereqMessage(prereqDefs) === null;
  // FIX 1d — lọc trạng thái máy client-side (không đổi API posIntakeList).
  const visibleRows = statusId ? rows.filter((r) => String(r.intakeStatusId) === statusId) : rows;
  // Ô tích + 8 cột dữ liệu + Thao tác.
  const soCot = 8 + (canManage ? 2 : 0);
  // Tổng GIÁ NHẬP của ĐÚNG tập đang lọc (mẫu chốt 6/11 §5: cộng từ cùng mảng đã lọc, không từ nguồn khác).
  const tongGiaNhap = visibleRows.reduce((s, r) => s + (Number.isFinite(r.importPrice) ? r.importPrice : 0), 0);

  return (
    <div data-nut-vuong>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{visibleRows.length} máy POS trong kho</div>
        <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('nhap_kho_pos', ['Số thứ tự', 'Chủng loại', 'Cài APP', 'Số seri', 'Nhà cung cấp', 'Giá nhập', 'Ngày nhập', 'Trạng thái'], visibleRows.map((r, i) => [i + 1, r.posModelName, r.bankCode ?? 'Máy trắng', r.serial, r.supplierName, r.importPrice, fmtDate(r.importedAt), r.intakeStatusName]))}>Xuất Excel</Button>
          {canManage && <ImportButton entityKey="posIntake" label="POS nhập kho" onImported={reload} />}
          {canManage && <Button variant="confirm" icon={<PackagePlus className="h-4 w-4" />} onClick={() => canAdd ? setForm({ mode: 'create' }) : toast.alert(prereqMessage(prereqDefs) ?? 'Thiếu dữ liệu nền để nhập kho.', 'Thiếu dữ liệu nền')}>Nhập kho máy POS</Button>}
        </div>
      </div>
      <FilterBar
        search={search} onSearch={setSearch} searchPlaceholder="Tìm seri / ghi chú…"
        selects={[
          { key: 'model', placeholder: 'Tất cả chủng loại', value: modelId, options: models.map((m) => ({ value: String(m.id), label: m.name })), onChange: setModelId },
          { key: 'sup', placeholder: 'Tất cả nhà cung cấp', value: supplierId, options: suppliers.map((s) => ({ value: String(s.id), label: s.name })), onChange: setSupplierId },
          { key: 'status', placeholder: 'Tất cả trạng thái', value: statusId, options: statuses.map((s) => ({ value: String(s.id), label: s.name })), onChange: setStatusId }
        ]}
        onApply={reload} onReset={() => { setSearch(''); setSupplierId(''); setModelId(''); setStatusId(''); setTimeout(() => reloadRef4.current(), 0); }}
        coChuNho locPhai
      />
      {/* StatBar Nhập kho — tổng + đếm theo trạng thái nhập máy (trên tập đã lọc client). */}
      <StatBar
        items={[
          { label: 'Tổng máy trong kho', value: visibleRows.length, tone: 'bg-brand-tint text-brand' },
          ...Array.from(new Set(visibleRows.map((r) => r.intakeStatusName).filter((n): n is string => !!n)))
            .map((name, i) => ({ label: name, value: visibleRows.filter((r) => r.intakeStatusName === name).length, tone: GROUP_TONES[i % GROUP_TONES.length] }))
        ]}
      />
      {canManage && <SelectionBar count={sel.count} entityLabel="máy POS" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <KhungBang className={CAO_KHUNG}>
        <table className="w-full min-w-[1420px] text-xs">
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              {canManage && <ThTich ids={visibleRows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[70px]'}>STT</th>
              <th className={thChuan + ' w-[170px]'}>Chủng loại</th>
              <th className={thChuan + ' w-[110px]'}>Cài APP</th>
              <th className={thChuan + ' w-[180px]'}>Seri number</th>
              <th className={thChuan + ' w-[280px]'}>Nhà cung cấp</th>
              <th className={thChuan + ' w-[140px]'}>Giá nhập</th>
              <th className={thChuan + ' w-[100px]'}>Ngày nhập</th>
              <th className={thChuan + ' w-[130px]'}>Trạng thái</th>
              {canManage && <th className={thChuan + ' w-[96px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && visibleRows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-sm text-slate-400"><PackagePlus className="mx-auto mb-2 h-6 w-6" /> {statusId ? 'Không có máy POS khớp trạng thái đã lọc.' : 'Chưa có máy POS nào nhập kho.'}</td></tr>}
            {!loading && visibleRows.map((pi, i) => (
              <tr key={pi.id} className={trChuan(i, sel.isSelected(pi.id))}>
                {canManage && <TdTich id={pi.id} sel={sel} />}
                <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{i + 1}</td>
                <td className={tdChuan + ' text-center text-slate-700'}>{pi.posModelName}</td>
                <td className={tdChuan + ' text-center'}>{pi.bankCode ? <span className="rounded-full bg-brand-tint/60 px-2 py-0.5 font-semibold text-brand">{pi.bankCode}</span> : <span className="text-slate-400">Máy trắng</span>}</td>
                <td className={tdChuan + ' text-center font-mono font-medium text-slate-800'}>{pi.serial}</td>
                <td className={tdChuan + ' text-slate-600'} title={pi.supplierName ?? ''}>{pi.supplierName ?? '—'}</td>
                {/* Cột TIỀN: căn phải, tabular-nums, text-slate-800, KHÔNG in đậm, BỎ ký hiệu ₫ (mẫu chốt §2). */}
                <td className={tdTien}>{soTien(pi.importPrice)}</td>
                <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{fmtDate(pi.importedAt)}</td>
                <td className={tdChuan + ' text-center'}><span className="rounded bg-brand-tint px-1.5 py-0.5 font-medium text-brand">{pi.intakeStatusName ?? '—'}</span></td>
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: pi })}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(pi)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <tr aria-hidden><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
          {/* HÀNG TỔNG ghim ĐÁY khung cuộn: nền đặt trên TỪNG <td> (tdTongChuan), KHÔNG trên <tr> —
              đặt trên <tr> thì sticky làm hở nền bên phải (mẫu chốt 6/11 §1). */}
          <tfoot className="sticky bottom-0 z-10">
            <tr className="border-t-2 border-brand">
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={canManage ? 6 : 5}>TỔNG {visibleRows.length} máy</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{soTien(tongGiaNhap)}</td>
              <td className={tdTongChuan} colSpan={canManage ? 3 : 2} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {form && <IntakeForm mode={form.mode} row={form.row} models={models} suppliers={suppliers} statuses={statuses} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa máy POS nhập kho" message={`Máy POS seri "${del.serial}" sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều máy POS" message={`${sel.count} máy POS đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

function IntakeForm({ mode, row, models, suppliers, statuses, onClose, onSaved }: { mode: 'create' | 'edit'; row?: PosIntakeDto; models: LiteRef[]; suppliers: LiteRef[]; statuses: IntakeStatusDto[]; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [posModelId, setPosModelId] = useState(row?.posModelId ? String(row.posModelId) : '');
  const [serial, setSerial] = useState(row?.serial ?? '');
  const [intakeStatusId, setIntakeStatusId] = useState(row?.intakeStatusId ? String(row.intakeStatusId) : '');
  const [supplierId, setSupplierId] = useState(row?.supplierId ? String(row.supplierId) : '');
  const [price, setPrice] = useState(row ? String(row.importPrice) : '');
  const [importedAt, setImportedAt] = useState(row ? row.importedAt.slice(0, 10) : '');
  const [note, setNote] = useState(row?.note ?? '');
  const [warehouseId, setWarehouseId] = useState(''); // Model 1 — nhập vào kho nào (chỉ khi nhập kho mới)
  const [warehouses, setWarehouses] = useState<WarehouseLite[]>([]);
  // Cài APP (Admin Demo 13/7) — app ngân hàng của máy ('' = MÁY TRẮNG). Sửa được ở CẢ tạo mới LẪN sửa (prefill từ máy).
  const [bankId, setBankId] = useState(row?.bankId != null ? String(row.bankId) : '');
  const [banks, setBanks] = useState<BankLite[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Ngân hàng: nạp ở CẢ 2 mode (edit cũng sửa Cài APP được). Kho: chỉ khi nhập mới.
    window.api.bankLite().then((r) => r.ok && r.data && setBanks(r.data));
    if (mode === 'create') window.api.warehouseLite().then((r) => r.ok && r.data && setWarehouses(r.data));
  }, [mode]);

  async function save(): Promise<void> {
    if (!posModelId) return toast.alert('Vui lòng chọn chủng loại máy.', 'Thiếu thông tin');
    if (!serial.trim()) return toast.alert('Seri number bắt buộc.', 'Thiếu thông tin');
    if (!intakeStatusId) return toast.alert('Vui lòng chọn trạng thái nhập máy.', 'Thiếu thông tin');
    if (!supplierId) return toast.alert('Vui lòng chọn nhà cung cấp.', 'Thiếu thông tin');
    const priceNum = Number(price.replace(/\D/g, ''));
    if (!price || !Number.isInteger(priceNum) || priceNum < 0) return toast.alert('Giá nhập phải là số nguyên ≥ 0.', 'Giá không hợp lệ');
    if (!importedAt) return toast.alert('Vui lòng nhập đủ ngày/tháng/năm nhập.', 'Thiếu ngày nhập');
    setBusy(true);
    const payload = { posModelId: Number(posModelId), serial: serial.trim(), intakeStatusId: Number(intakeStatusId), supplierId: Number(supplierId), importPrice: priceNum, importedAt, note: note || null };
    const res = mode === 'edit' && row
      ? await window.api.posIntakeUpdate(row.id, { ...payload, bankId: bankId ? Number(bankId) : null, expectedUpdatedAt: row.updatedAt })
      : await window.api.posIntakeCreate({ ...payload, warehouseId: warehouseId ? Number(warehouseId) : null, bankId: bankId ? Number(bankId) : null });
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật máy POS' : `Đã nhập kho máy ${serial}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else baoLoi(toast.alert, res, 'Lưu máy POS');
  }

  const priceNum = parseVndInput(price) ?? 0;
  return (
    <Modal title={mode === 'edit' ? `Sửa máy POS ${row?.serial}` : 'Nhập kho máy POS mới'} onClose={onClose} width="max-w-xl" onSubmit={() => void save()}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Chủng loại máy" required><select className={inputCls} value={posModelId} onChange={(e) => setPosModelId(e.target.value)} autoFocus><option value="">— Chọn chủng loại —</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        <Field label="Seri number" required hint="Chữ + số, không giới hạn"><input className={inputCls} value={serial} onChange={(e) => setSerial(e.target.value)} /></Field>
        <Field label="Nhà cung cấp" required><select className={inputCls} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">— Chọn nhà cung cấp —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Trạng thái nhập" required><select className={inputCls} value={intakeStatusId} onChange={(e) => setIntakeStatusId(e.target.value)}><option value="">— Chọn trạng thái —</option>{statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Giá nhập (VND)" required hint={price ? fmtVnd(priceNum) : 'Số nguyên đồng'}><input className={inputCls} inputMode="numeric" value={groupDigits(price)} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} placeholder="5.000.000" /></Field>
        <Field label="Ngày nhập" required><DateInput value={importedAt} onChange={setImportedAt} /></Field>
        {mode === 'create' && (
          <Field label="Nhập vào kho" hint="Máy sẽ nằm ở kho này (để lọc/thu hồi/giao đúng kho)">
            <select className={inputCls} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">— Chưa gán kho —</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Cài APP (ngân hàng)" hint="Máy trắng = chưa cài app. Gán TID chỉ được khi TID cùng ngân hàng với app. Sửa ở đây đồng bộ sang máy.">
          <select className={inputCls} value={bankId} onChange={(e) => setBankId(e.target.value)}>
            <option value="">— Máy trắng (chưa cài app) —</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
          </select>
        </Field>
        <div className="col-span-2"><Field label="Ghi chú"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Nhập kho'}</Button>
      </div>
    </Modal>
  );
}
