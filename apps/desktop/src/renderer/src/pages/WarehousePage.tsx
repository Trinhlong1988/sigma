import { useEffect, useState, useRef } from 'react';
import { Plus, Pencil, Trash2, Loader2, Warehouse as WarehouseIcon, Download } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate, fmtTime } from '@sigma/shared';
import type { WarehouseDto, CreateWarehouseInput, UpdateWarehouseInput, WarehouseManagerCandidate } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Field, inputCls } from '../components/Field.js';
import { FilterBar } from '../components/FilterBar.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { StatBar } from '../components/StatBar.js';
import { StaleBanner } from '../lib/realtime.js';
import { statusTone } from '../components/StatusPill.js';
import { useRowSelection, SelectionBar, SelectAllCell, SelectCell } from '../components/Selection.js';
import { AuditTrailHeadCells, AuditTrailCells, AUDIT_TRAIL_COLS } from '../components/AuditCells.js';
import { exportCsv } from '../lib/exportCsv.js';
// MẪU CHỐT 6/11 — kiểu bảng lấy TỪ MODULE DÙNG CHUNG, cấm chép chuỗi class vào trang.
import { thChuan, tdChuan, trChuan, KhungBang } from '../components/BangChuan.js';

/** Nhãn trạng thái kho — dùng chung màu StatusPill (R_UI_STANDARD). */
function StatusPill({ status }: { status: string }): JSX.Element {
  const active = status === 'ACTIVE';
  const tone = active ? statusTone('ACTIVE') : statusTone('DISABLED');
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{active ? 'Đang dùng' : 'Ngừng dùng'}</span>;
}

export function WarehousePage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const canManage = hasPermission(user, 'CONFIG_WAREHOUSE_MANAGE');
  const [rows, setRows] = useState<WarehouseDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: WarehouseDto } | null>(null);
  const [del, setDel] = useState<WarehouseDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.warehouseList({ search: search || undefined, status: fStatus || undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [fStatus]);

  async function doDelete(r: WarehouseDto, password?: string): Promise<void> {
    const res = await window.api.warehouseDelete([r.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa kho ${r.name}`);
    else toast.alert(res.message ?? 'Xóa thất bại', 'Xóa thất bại');
    setDel(null); await reload();
  }
  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.warehouseDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} kho`);
    else toast.alert(res.message ?? 'Xóa thất bại', 'Xóa thất bại');
    setBulkDel(false); await reload();
  }

  const activeCount = rows.filter((r) => r.status === 'ACTIVE').length;
  // SỐ CỘT THẬT (§1) — phụ thuộc QUYỀN. Trước đây hard-code `7 + AUDIT_TRAIL_COLS` nên sai khi không có quyền.
  const soCot = 5 + AUDIT_TRAIL_COLS + (canManage ? 2 : 0);

  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      <div className="mb-4 shrink-0">
        <h2 className="text-lg font-semibold text-slate-800">Danh mục kho</h2>
        <p className="text-sm text-slate-500">Danh sách kho hàng của công ty (mã · tên · địa chỉ). Khi giao máy chọn "Từ kho" → địa chỉ kho tự hiện.</p>
      </div>

      <StatBar items={[
        { label: 'Tổng kho', value: rows.length },
        { label: 'Đang dùng', value: activeCount, tone: statusTone('ACTIVE') },
        { label: 'Ngừng dùng', value: rows.length - activeCount, tone: statusTone('DISABLED') }
      ]} />

      <div className="mb-3 flex shrink-0 items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} kho</div>
        <div className="flex gap-2">
          <Button variant="confirm" data-nut="excel" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('danh_muc_kho', ['Mã kho', 'Tên kho', 'Địa chỉ', 'Điện thoại', 'Trạng thái', 'Ghi chú', 'Người tạo', 'Ngày tạo', 'Giờ tạo', 'Người sửa', 'Ngày sửa', 'Giờ sửa'], rows.map((r) => [r.code, r.name, r.address ?? '', r.phone ?? '', r.status === 'ACTIVE' ? 'Đang dùng' : 'Ngừng dùng', r.note ?? '', r.createdByName ?? '', fmtDate(r.createdAt), fmtTime(r.createdAt), r.updatedByName ?? '', fmtDate(r.updatedAt), fmtTime(r.updatedAt)]))}>Xuất Excel</Button>
          {canManage && <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm kho</Button>}
        </div>
      </div>

      <FilterBar search={search} onSearch={setSearch} searchPlaceholder="Tìm theo mã / tên / địa chỉ kho…"
        selects={[{ key: 's', placeholder: 'Tất cả trạng thái', value: fStatus, options: [{ value: 'ACTIVE', label: 'Đang dùng' }, { value: 'INACTIVE', label: 'Ngừng dùng' }], onChange: setFStatus }]}
        onApply={reload} onReset={() => { setSearch(''); setFStatus(''); setTimeout(() => reloadRef.current(), 0); }}
        coChuNho locPhai />

      {canManage && <SelectionBar count={sel.count} entityLabel="kho" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <StaleBanner domain="Warehouse" onReload={reload} className="mb-2" />
      {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên. Bảng danh mục ⇒ không có hàng TỔNG. */}
      <KhungBang>
        <table className="h-full w-full min-w-[1140px] text-xs">
          <thead className="sticky top-0 z-20 bg-slate-200">
            <tr>
              {canManage && <SelectAllCell ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[110px]'}>Mã kho</th>
              <th className={thChuan + ' w-[200px]'}>Tên kho</th>
              <th className={thChuan + ' w-[260px]'}>Địa chỉ</th>
              <th className={thChuan + ' w-[120px]'}>Điện thoại</th>
              <th className={thChuan + ' w-[120px]'}>Trạng thái</th>
              <AuditTrailHeadCells />
              {canManage && <th className={thChuan + ' w-[100px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-slate-400"><WarehouseIcon className="mx-auto mb-2 h-6 w-6" /> Chưa có kho.</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={r.id} className={trChuan(i, sel.isSelected(r.id))}>
                {canManage && <SelectCell id={r.id} sel={sel} />}
                <td className={tdChuan + ' font-mono font-medium text-slate-800'}>{r.code}</td>
                <td className={tdChuan + ' font-medium text-slate-800'}>{r.name}</td>
                <td className={tdChuan + ' text-slate-600'}>{r.address ?? '—'}</td>
                <td className={tdChuan + ' text-center tabular-nums text-slate-600'}>{r.phone ?? '—'}</td>
                <td className={tdChuan + ' text-center'}><StatusPill status={r.status} /></td>
                <AuditTrailCells row={r} />
                {canManage && (
                  <td className={tdChuan}><div className="flex justify-center gap-1">
                    <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: r })}><Pencil className="h-4 w-4" /></IconButton>
                    <IconButton title="Xóa" tone="danger" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton>
                  </div></td>
                )}
              </tr>
            ))}
            {/* HÀNG ĐỆM (§1). */}
            <tr aria-hidden className="h-full"><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>

      {form && <WarehouseForm mode={form.mode} row={form.row} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa kho" message={`Kho "${del.name}" sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều kho" message={`${sel.count} kho đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

function WarehouseForm({ mode, row, onClose, onSaved }: { mode: 'create' | 'edit'; row?: WarehouseDto; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [code, setCode] = useState(row?.code ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [address, setAddress] = useState(row?.address ?? '');
  const [phone, setPhone] = useState(row?.phone ?? '');
  const [status, setStatus] = useState(row?.status ?? 'ACTIVE');
  const [note, setNote] = useState(row?.note ?? '');
  const [managerUserId, setManagerUserId] = useState(row?.managerUserId ? String(row.managerUserId) : '');
  const [managers, setManagers] = useState<WarehouseManagerCandidate[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.warehouseManagerCandidates().then((r) => r.ok && r.data && setManagers(r.data));
  }, []);

  // §4 — có chọn User quản lý → địa chỉ + SĐT LẤY TỪ hồ sơ user (read-only). Không chọn → nhập tay (kho cũ).
  const manager = managers.find((m) => String(m.id) === managerUserId);
  const effAddress = manager ? manager.address ?? '' : address;
  const effPhone = manager ? manager.phone ?? '' : phone;

  async function save(): Promise<void> {
    if (!code.trim()) return toast.alert('Mã kho bắt buộc.', 'Thiếu thông tin');
    if (!name.trim()) return toast.alert('Tên kho bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    const mgrId = managerUserId ? Number(managerUserId) : null;
    // Khi có user quản lý: địa chỉ/SĐT lấy từ hồ sơ user (server tự resolve) → không gửi address/phone tay.
    const res = mode === 'edit' && row
      ? await window.api.warehouseUpdate(row.id, { code: code.trim(), name: name.trim(), address: mgrId ? null : address.trim() || null, phone: mgrId ? null : phone.trim() || null, managerUserId: mgrId, note: note.trim() || null, status, expectedUpdatedAt: row.updatedAt } satisfies UpdateWarehouseInput)
      : await window.api.warehouseCreate({ code: code.trim(), name: name.trim(), address: mgrId ? null : address.trim() || null, phone: mgrId ? null : phone.trim() || null, managerUserId: mgrId, note: note.trim() || null, status } satisfies CreateWarehouseInput);
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật kho' : `Đã thêm kho ${name}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else toast.alert(res.message ?? 'Lưu thất bại', 'Không lưu được');
  }

  return (
    <Modal title={mode === 'edit' ? `Sửa kho ${row?.code}` : 'Thêm kho'} onClose={onClose} width="max-w-md" onSubmit={() => void save()}>
      <Field label="Mã kho" required hint="Ví dụ: KHO-HN, KHO-HCM"><input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></Field>
      <Field label="Tên kho" required><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="User quản lý kho" hint="Chọn user → Địa chỉ + SĐT tự lấy từ hồ sơ user (không nhập tay)">
        <select className={inputCls} value={managerUserId} onChange={(e) => setManagerUserId(e.target.value)}>
          <option value="">— Không gán (nhập địa chỉ tay) —</option>
          {managers.map((m) => <option key={m.id} value={m.id}>{m.fullName} · @{m.username}</option>)}
        </select>
      </Field>
      {manager ? (
        <>
          <Field label="Địa chỉ" hint="Lấy từ hồ sơ User quản lý (chỉ đọc)">
            <div className={inputCls + ' min-h-[38px] bg-appbg text-slate-600'}>{effAddress || <span className="italic text-warning">User quản lý chưa có địa chỉ — không giao máy được</span>}</div>
          </Field>
          <Field label="Điện thoại" hint="Lấy từ hồ sơ User quản lý (chỉ đọc)">
            <div className={inputCls + ' min-h-[38px] bg-appbg text-slate-600'}>{effPhone || '—'}</div>
          </Field>
        </>
      ) : (
        <>
          <Field label="Địa chỉ" hint="Địa chỉ kho — dùng khi giao máy (chọn kho → hiện địa chỉ)"><textarea className={inputCls} rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
          <Field label="Điện thoại"><input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </>
      )}
      <Field label="Trạng thái sử dụng">
        <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ACTIVE">Đang dùng</option>
          <option value="INACTIVE">Ngừng dùng</option>
        </select>
      </Field>
      <Field label="Ghi chú"><textarea className={inputCls} rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm kho'}</Button>
      </div>
    </Modal>
  );
}
