import { useEffect, useState, useRef } from 'react';
import { baoLoi } from '../lib/bao-loi';
import { Plus, Pencil, Trash2, Loader2, CreditCard, Tag, Download, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate, fmtTime, prereqMessage } from '@sigma/shared';
import type { TidConfigStatusDto, ConfigTidDto, ConfigTidInput, BankLite, PartnerDto, RcvAccountDto, DossierSourceDto, FeeRateDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Field, inputCls } from '../components/Field.js';
import { FilterBar } from '../components/FilterBar.js';
import { StatBar } from '../components/StatBar.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { useRowSelection, SelectionBar, SelectAllCell, SelectCell } from '../components/Selection.js';
import { RequestCancelModal, type RequestCancelTarget } from '../components/RequestCancelModal.js';
import { AuditTrailHeadCells, AuditTrailCells, AUDIT_TRAIL_COLS } from '../components/AuditCells.js';
import { exportCsv } from '../lib/exportCsv.js';
import { TabBar, TabButton } from '../components/Tabs.js';
// MẪU CHỐT 6/11 — kiểu bảng lấy TỪ MODULE DÙNG CHUNG, cấm chép chuỗi class vào trang.
import { thChuan, tdChuan, tdPhanTram, trChuan, KhungBang } from '../components/BangChuan.js';

type Tab = 'tid' | 'status';

// Tông màu luân phiên cho bộ đếm theo nhóm (không phải trạng thái hệ thống) — đồng bộ CustomersPage.
const GROUP_TONES = ['bg-indigo-50 text-indigo-600', 'bg-emerald-50 text-emerald-600', 'bg-amber-50 text-amber-600', 'bg-sky-50 text-sky-600', 'bg-violet-50 text-violet-600', 'bg-rose-50 text-rose-600'];

const fmtPct = (v: number): string => `${Number(v.toFixed(3))}%`;

export function TidConfigPage({ user }: { user: AuthUser }): JSX.Element {
  const [tab, setTab] = useState<Tab>('tid');
  const canManage = hasPermission(user, 'CONFIG_TID_MANAGE');
  const canCancelReq = hasPermission(user, 'TID_CANCEL_REQUEST');
  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      <div className="mb-4 shrink-0">
        <h2 className="text-lg font-semibold text-slate-800">Cấu hình TID</h2>
        <p className="text-sm text-slate-500">Cấu hình TID (ngân hàng · đối tác · biểu phí · HKD · tài khoản nhận tiền · nguồn hồ sơ) · Trạng thái TID.</p>
      </div>
      <div className="shrink-0">
        <TabBar>
          <TabButton active={tab === 'tid'} onClick={() => setTab('tid')} icon={<CreditCard className="h-4 w-4" />}>Cấu hình TID</TabButton>
          <TabButton active={tab === 'status'} onClick={() => setTab('status')} icon={<Tag className="h-4 w-4" />}>Trạng thái TID</TabButton>
        </TabBar>
      </div>
      {tab === 'tid' && <TidTab canManage={canManage} canCancelReq={canCancelReq} />}
      {tab === 'status' && <StatusTab canManage={canManage} />}
    </div>
  );
}

// ── §9a TRẠNG THÁI TID ────────────────────────────────────────────────────────
// PHASE K2: export để trang "Quản Lý TID" hợp nhất (TidPage) tái dùng làm tab "Trạng thái TID cấu hình".
export function StatusTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<TidConfigStatusDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: TidConfigStatusDto } | null>(null);
  const [del, setDel] = useState<TidConfigStatusDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.tidStatusList();
    if (res.ok && res.data) setRows(res.data);
    else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  async function doDelete(s: TidConfigStatusDto, password?: string): Promise<void> {
    const res = await window.api.tidStatusDelete([s.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa trạng thái ${s.name}`);
    else baoLoi(toast.alert, res, 'Xóa');
    setDel(null); await reload();
  }
  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.tidStatusDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} trạng thái`);
    else baoLoi(toast.alert, res, 'Xóa');
    setBulkDel(false); await reload();
  }

  // SỐ CỘT THẬT (§1): Tên trạng thái + khối audit (3) + (ô tích, Thao tác) khi có quyền.
  // LỖI CŨ ĐÃ SỬA: colSpan hard-code 9/7 trong khi số cột thật chỉ 6/4.
  const soCot = 1 + AUDIT_TRAIL_COLS + (canManage ? 2 : 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex shrink-0 items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} trạng thái · <span className="text-slate-400">ví dụ: mới cấp, thu hồi, đổi cho đối tác</span></div>
        <div className="flex gap-2">
          <Button data-nut="lammoi" variant="soft" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reload()} title="Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc)">Làm mới</Button>
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('trang_thai_tid', ['Tên trạng thái', 'Người tạo', 'Ngày tạo', 'Giờ tạo', 'Người sửa', 'Ngày sửa', 'Giờ sửa'], rows.map((s) => [s.name, s.createdByName ?? '', fmtDate(s.createdAt), fmtTime(s.createdAt), s.updatedByName ?? '', fmtDate(s.updatedAt), fmtTime(s.updatedAt)]))}>Xuất Excel</Button>
          {canManage && <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm trạng thái</Button>}
        </div>
      </div>
      <StatBar items={[{ label: 'Tổng trạng thái', value: rows.length, tone: 'bg-brand-tint text-brand' }]} />
      {canManage && <SelectionBar count={sel.count} entityLabel="trạng thái" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên. Bảng danh mục ⇒ không có hàng TỔNG. */}
      <KhungBang>
        <table className="h-full w-full min-w-[720px] text-xs">
          <thead className="sticky top-0 z-20 bg-slate-200">
            <tr>
              {canManage && <SelectAllCell ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[320px]'}>Tên trạng thái</th>
              <AuditTrailHeadCells />
              {canManage && <th className={thChuan + ' w-[100px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-slate-400"><Tag className="mx-auto mb-2 h-6 w-6" /> Chưa có trạng thái TID.</td></tr>}
            {!loading && rows.map((s, i) => (
              <tr key={s.id} className={trChuan(i, sel.isSelected(s.id))}>
                {canManage && <SelectCell id={s.id} sel={sel} />}
                <td className={tdChuan + ' font-medium text-slate-800'}>{s.name}</td>
                <AuditTrailCells row={s} />
                {canManage && (
                  <td className={tdChuan}><div className="flex justify-center gap-1">
                    <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: s })}><Pencil className="h-4 w-4" /></IconButton>
                    <IconButton title="Xóa" tone="danger" onClick={() => setDel(s)}><Trash2 className="h-4 w-4" /></IconButton>
                  </div></td>
                )}
              </tr>
            ))}
            {/* HÀNG ĐỆM (§1). */}
            <tr aria-hidden className="h-full"><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>
      {form && <StatusForm mode={form.mode} row={form.row} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa trạng thái TID" message={`Trạng thái "${del.name}" sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều trạng thái" message={`${sel.count} trạng thái đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

function StatusForm({ mode, row, onClose, onSaved }: { mode: 'create' | 'edit'; row?: TidConfigStatusDto; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [name, setName] = useState(row?.name ?? '');
  const [busy, setBusy] = useState(false);
  async function save(): Promise<void> {
    if (!name.trim()) return toast.alert('Tên trạng thái bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    const res = mode === 'edit' && row ? await window.api.tidStatusUpdate(row.id, { name: name.trim(), expectedUpdatedAt: row.updatedAt }) : await window.api.tidStatusCreate({ name: name.trim() });
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật trạng thái' : `Đã thêm trạng thái ${name}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else baoLoi(toast.alert, res, 'Lưu');
  }
  return (
    <Modal title={mode === 'edit' ? 'Sửa trạng thái TID' : 'Thêm trạng thái TID'} onClose={onClose} width="max-w-md">
      <Field label="Tên trạng thái" required hint="Ví dụ: mới cấp, thu hồi, đổi cho đối tác"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm trạng thái'}</Button>
      </div>
    </Modal>
  );
}

// ── §9 CẤU HÌNH TID ───────────────────────────────────────────────────────────
function TidTab({ canManage, canCancelReq }: { canManage: boolean; canCancelReq: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<ConfigTidDto[]>([]);
  const [banks, setBanks] = useState<BankLite[]>([]);
  const [partners, setPartners] = useState<PartnerDto[]>([]);
  const [accounts, setAccounts] = useState<RcvAccountDto[]>([]);
  const [statuses, setStatuses] = useState<TidConfigStatusDto[]>([]);
  const [dsources, setDsources] = useState<DossierSourceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [fPartner, setFPartner] = useState('');
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: ConfigTidDto } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<RequestCancelTarget | null>(null);

  async function loadRefs(): Promise<void> {
    const [b, p, a, s, d] = await Promise.all([window.api.bankLite(), window.api.partnerList({}), window.api.rcvAccountList({}), window.api.tidStatusList(), window.api.dossierSourceList()]);
    if (b.ok && b.data) setBanks(b.data);
    if (p.ok && p.data) setPartners(p.data);
    if (a.ok && a.data) setAccounts(a.data);
    if (s.ok && s.data) setStatuses(s.data);
    if (d.ok && d.data) setDsources(d.data);
  }
  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef2 = useRef<() => void>(() => {});
  reloadRef2.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.tidConfigList({ search: search || undefined, partnerId: fPartner ? Number(fPartner) : undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (!res.ok) baoLoi(toast.alert, res, 'Tải dữ liệu'); // [B280] hết lỗi câm: ok:false không message trước đây im lặng tuyệt đối
    setLoading(false);
  }
  useEffect(() => { void loadRefs(); }, []);
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [fPartner]);

  // SỐ CỘT THẬT (§1): 8 cột nghiệp vụ + Thao tác khi có quyền sửa/yêu-cầu-hủy.
  const coThaoTac = canManage || canCancelReq;
  const soCot = 8 + (coThaoTac ? 1 : 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex shrink-0 items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} TID cấu hình</div>
        <div className="flex gap-2">
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('cau_hinh_tid', ['TID', 'Tên HKD', 'Ngân hàng', 'Đối tác', 'Ngày cấp', 'Trạng thái', 'Nguồn hồ sơ', 'TK nhận tiền'], rows.map((r) => [r.tid, r.hkdName, r.bankCode, r.partnerName, r.issuedAt ? fmtDate(r.issuedAt) : '', r.configStatusName, r.dossierSourceCode, r.receiveAccountLabel]))}>Xuất Excel</Button>
          {canManage && <Button data-nut="them" variant="confirm" icon={<Plus className="h-4 w-4" />} onClick={() => { const msg = prereqMessage([{ count: banks.length, label: 'Ngân hàng', where: "tab 'Ngân hàng'" }, { count: partners.length, label: 'Đối tác', where: "tab 'Đối tác'" }]); return msg ? toast.alert(msg, 'Thiếu dữ liệu nền') : setForm({ mode: 'create' }); }}>Thêm TID</Button>}
        </div>
      </div>
      <FilterBar search={search} onSearch={setSearch} searchPlaceholder="Tìm TID / tên HKD…"
        selects={[{ key: 'p', placeholder: 'Tất cả đối tác', value: fPartner, options: partners.map((p) => ({ value: String(p.id), label: p.name })), onChange: setFPartner }]}
        onApply={reload} onReset={() => { setSearch(''); setFPartner(''); setTimeout(() => reloadRef2.current(), 0); }}
        coChuNho locPhai />
      {/* StatBar Cấu hình TID — tổng + đếm theo trạng thái TID cấu hình (configStatusName). */}
      <StatBar
        items={[
          { label: 'Tổng TID cấu hình', value: rows.length, tone: 'bg-brand-tint text-brand' },
          ...Array.from(new Set(rows.map((r) => r.configStatusName).filter((n): n is string => !!n)))
            .map((name, i) => ({ label: name, value: rows.filter((r) => r.configStatusName === name).length, tone: GROUP_TONES[i % GROUP_TONES.length] })),
          ...(rows.some((r) => !r.configStatusName) ? [{ label: 'Chưa đặt trạng thái', value: rows.filter((r) => !r.configStatusName).length, tone: 'bg-slate-100 text-slate-500' }] : [])
        ]}
      />
      {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên. Không cột tiền ⇒ không hàng TỔNG. */}
      <KhungBang>
        <table className="h-full w-full min-w-[1280px] text-xs">
          <thead className="sticky top-0 z-20 bg-slate-200">
            <tr>
              <th className={thChuan + ' w-[120px]'}>TID</th>
              <th className={thChuan + ' w-[260px]'}>Tên HKD</th>
              <th className={thChuan + ' w-[110px]'}>Ngân hàng</th>
              <th className={thChuan + ' w-[160px]'}>Đối tác</th>
              <th className={thChuan + ' w-[100px]'}>Ngày cấp</th>
              <th className={thChuan + ' w-[150px]'}>Trạng thái</th>
              <th className={thChuan + ' w-[130px]'}>Nguồn hồ sơ</th>
              <th className={thChuan + ' w-[130px]'}>Vòng đời</th>
              {coThaoTac && <th className={thChuan + ' w-[100px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-slate-400"><CreditCard className="mx-auto mb-2 h-6 w-6" /> Chưa có TID cấu hình.</td></tr>}
            {!loading && rows.map((t, i) => (
              <tr key={t.id} className={trChuan(i)}>
                {/* TID là cột SỐ — tabular-nums, cùng cỡ chữ 12px như mọi cột (§2). */}
                <td className={tdChuan + ' font-mono font-medium tabular-nums text-slate-800'}>{t.tid}</td>
                <td className={tdChuan + ' text-slate-700'}>{t.hkdName ?? '—'}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{t.bankCode ?? '—'}</td>
                <td className={tdChuan + ' text-slate-600'}>{t.partnerName ?? '—'}</td>
                <td className={tdChuan + ' text-center text-slate-500'}>{t.issuedAt ? fmtDate(t.issuedAt) : '—'}</td>
                <td className={tdChuan + ' text-center'}>{t.configStatusName ? <span className="rounded bg-brand-tint px-1.5 py-0.5 font-medium text-brand">{t.configStatusName}</span> : <span className="text-slate-400">—</span>}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{t.dossierSourceCode ?? '—'}</td>
                <td className={tdChuan + ' text-center'}><span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{t.status}</span></td>
                {coThaoTac && (
                  <td className={tdChuan}><div className="flex justify-center gap-1">
                    {canManage && <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: t })}><Pencil className="h-4 w-4" /></IconButton>}
                    {canCancelReq && <IconButton title="Yêu cầu hủy" tone="danger" onClick={() => setCancelTarget({ entityType: 'Tid', entityId: t.id, entityLabel: t.tid, typeLabel: 'TID' })}><Trash2 className="h-4 w-4" /></IconButton>}
                  </div></td>
                )}
              </tr>
            ))}
            {/* HÀNG ĐỆM (§1). */}
            <tr aria-hidden className="h-full"><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>
      {form && <TidForm mode={form.mode} row={form.row} banks={banks} partners={partners} accounts={accounts} statuses={statuses} dsources={dsources} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {cancelTarget && <RequestCancelModal target={cancelTarget} onClose={() => setCancelTarget(null)} onDone={() => { setCancelTarget(null); reload(); }} />}
    </div>
  );
}

/** Bảng biểu phí dẫn xuất theo (Đối tác × Ngân hàng) — hiện realtime KỲ ĐANG HIỆU LỰC khi chọn đối tác (§9). */
export function FeePreview({ bankId, partnerId }: { bankId: number; partnerId: number }): JSX.Element {
  const [rows, setRows] = useState<FeeRateDto[] | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    // P1.1: chỉ hiển thị KỲ đang hiệu lực hôm nay của từng loại thẻ (bỏ các kỳ lịch sử/tương lai).
    window.api.feeRateList({ partnerId, bankId }).then((r) => { if (live) setRows(r.ok && r.data ? r.data.filter((x) => x.isCurrent) : []); });
    return () => { live = false; };
  }, [bankId, partnerId]);
  if (rows === null) return <div className="rounded-lg border border-line bg-appbg/50 p-3 text-sm text-slate-400"><Loader2 className="inline h-4 w-4 animate-spin" /> Đang tải biểu phí…</div>;
  if (rows.length === 0) return <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-slate-600">Đối tác này chưa có biểu phí hiệu lực cho ngân hàng đã chọn (cấu hình ở mục Cấu hình phí).</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <table className="w-full text-xs">
        {/* Bảng xem trước biểu phí trong BẢNG NỔI — vẫn dùng kiểu CHUNG để % đồng cỡ 12px (§2). */}
        <thead><tr><th className={thChuan}>Loại thẻ</th><th className={thChuan + ' w-[100px]'}>Phí mua</th><th className={thChuan + ' w-[110px]'}>Phí cài máy</th><th className={thChuan}>Phí bán niêm yết (theo loại phí)</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={trChuan(i)}>
              <td className={tdChuan + ' font-medium text-slate-700'}>{r.cardTypeCode ?? r.cardTypeName}</td>
              <td className={tdPhanTram}>{fmtPct(r.phiMua)}</td>
              <td className={tdPhanTram}>{fmtPct(r.phiCaiMay)}</td>
              <td className={tdChuan}>
                {r.sellQuotes.length === 0 ? <span className="text-slate-400">—</span> : (
                  <div className="flex flex-col gap-0.5">
                    {r.sellQuotes.map((q) => (
                      <span key={q.feeTypeId} className="whitespace-nowrap"><span className="text-slate-500">{q.feeTypeName}:</span> <span className="font-mono">{fmtPct(q.phiBan)}</span></span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TidForm({ mode, row, banks, partners, accounts, statuses, dsources, onClose, onSaved }: { mode: 'create' | 'edit'; row?: ConfigTidDto; banks: BankLite[]; partners: PartnerDto[]; accounts: RcvAccountDto[]; statuses: TidConfigStatusDto[]; dsources: DossierSourceDto[]; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [f, setF] = useState({
    tid: row?.tid ?? '',
    bankId: row?.bankId ? String(row.bankId) : '',
    partnerId: row?.partnerId ? String(row.partnerId) : '',
    hkdName: row?.hkdName ?? '',
    receiveAccountId: row?.receiveAccountId ? String(row.receiveAccountId) : '',
    issuedAt: row?.issuedAt ? row.issuedAt.slice(0, 10) : '',
    configStatusId: row?.configStatusId ? String(row.configStatusId) : '',
    dossierSourceId: row?.dossierSourceId ? String(row.dossierSourceId) : '',
    note: row?.note ?? ''
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>): void => setF({ ...f, [k]: e.target.value });

  async function save(): Promise<void> {
    if (!f.tid.trim()) return toast.alert('Chuỗi TID bắt buộc.', 'Thiếu thông tin');
    if (!f.bankId) return toast.alert('Vui lòng chọn ngân hàng.', 'Thiếu thông tin');
    if (!f.partnerId) return toast.alert('Vui lòng chọn đối tác.', 'Thiếu thông tin');
    if (!f.hkdName.trim()) return toast.alert('Tên Hộ Kinh Doanh bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    const input: ConfigTidInput = {
      tid: f.tid.trim(),
      bankId: Number(f.bankId),
      partnerId: Number(f.partnerId),
      hkdName: f.hkdName.trim(),
      receiveAccountId: f.receiveAccountId ? Number(f.receiveAccountId) : null,
      issuedAt: f.issuedAt || null,
      configStatusId: f.configStatusId ? Number(f.configStatusId) : null,
      dossierSourceId: f.dossierSourceId ? Number(f.dossierSourceId) : null,
      note: f.note || null
    };
    const res = mode === 'edit' && row ? await window.api.tidConfigUpdate(row.id, { ...input, expectedUpdatedAt: row.updatedAt }) : await window.api.tidConfigCreate(input);
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật TID' : `Đã thêm TID ${f.tid}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else baoLoi(toast.alert, res, 'Lưu TID');
  }

  return (
    <Modal title={mode === 'edit' ? `Sửa cấu hình TID ${row?.tid}` : 'Thêm cấu hình TID'} onClose={onClose} width="max-w-2xl">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Ngân hàng" required><select className={inputCls} value={f.bankId} onChange={set('bankId')} autoFocus><option value="">— Chọn ngân hàng —</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></Field>
        <Field label="Đối tác" required hint="Chọn xong hiện biểu phí bên dưới"><select className={inputCls} value={f.partnerId} onChange={set('partnerId')}><option value="">— Chọn đối tác —</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field>
      </div>
      {f.bankId && f.partnerId && (
        <div className="mt-3">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Biểu phí (mua / cài máy / bán) của đối tác</div>
          <FeePreview bankId={Number(f.bankId)} partnerId={Number(f.partnerId)} />
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label="Chuỗi TID" required><input className={inputCls} value={f.tid} onChange={set('tid')} /></Field>
        <Field label="Tên Hộ Kinh Doanh" required><input className={inputCls} value={f.hkdName} onChange={set('hkdName')} /></Field>
        <Field label="Tài khoản nhận tiền" hint="Từ nguồn TK nhận tiền – ủy quyền"><select className={inputCls} value={f.receiveAccountId} onChange={set('receiveAccountId')}><option value="">— Chọn TK nhận tiền —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.accountName} · {a.accountNumber}</option>)}</select></Field>
        <Field label="Ngày cấp TID"><input type="date" className={inputCls} value={f.issuedAt} onChange={set('issuedAt')} /></Field>
        <Field label="Trạng thái TID" hint="Từ cấu hình trạng thái (§9a)"><select className={inputCls} value={f.configStatusId} onChange={set('configStatusId')}><option value="">— Chọn trạng thái —</option>{statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Nguồn hồ sơ" hint="Từ nguồn hồ sơ (§10a)"><select className={inputCls} value={f.dossierSourceId} onChange={set('dossierSourceId')}><option value="">— Chọn nguồn hồ sơ —</option>{dsources.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}</select></Field>
      </div>
      <div className="mt-4">
        <Field label="Ghi chú"><textarea className={inputCls} rows={2} value={f.note} onChange={set('note')} /></Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm TID'}</Button>
      </div>
    </Modal>
  );
}
