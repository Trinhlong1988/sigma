import { useEffect, useState, useRef } from 'react';
import { Plus, Pencil, Trash2, Loader2, Landmark, CreditCard, Building2, Download, Link2, Percent, Tags, CircleDot, HandCoins } from 'lucide-react';
import { FeeConfigPage } from './FeeConfigPage.js';
import { IndustryConfigPage } from './IndustryConfigPage.js';
import { StatusConfigPage } from './StatusConfigPage.js';
import { HandoverConfigPage } from './HandoverConfigPage.js';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate, fmtTime } from '@sigma/shared';
import type { BankDto, CardTypeDto, PartnerDto, PartnerBankMatrix } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Field, inputCls } from '../components/Field.js';
import { FilterBar } from '../components/FilterBar.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { useRowSelection, SelectionBar } from '../components/Selection.js';
import { StatBar } from '../components/StatBar.js';
import { StaleBanner } from '../lib/realtime.js';
import type { AuditTrailRow } from '../components/AuditCells.js';
import { thChuan, tdChuan, trChuan, theadChuan, KhungBang } from '../components/BangChuan.js';
import { StatusBadge, useStatusOptions, statusSelectOptions, toneCls } from '../components/StatusBadge.js';
import { TabBar, TabButton } from '../components/Tabs.js';
import { exportCsv } from '../lib/exportCsv.js';

type Tab = 'bank' | 'cardtype' | 'partner' | 'industry' | 'status' | 'fee' | 'handover';

/** MẪU CHỐT 6/11: trang nằm trong `<main overflow-auto>` nên khung bảng phải KHÓA chiều cao để
 *  `overflow-auto` tạo khung cuộn thật — nhờ đó tiêu đề `sticky top-0` ghim TRONG bảng.
 *  15rem = giữ đúng chiều cao cũ của `.list-scroll`. */
const CAO_KHUNG = 'max-h-[calc(100vh-15rem)] bg-white shadow-sm';

/** 2 ô TIÊU ĐỀ khối "thông tin tạo" (chỉ ngày — dateOnly) theo KIỂU CHUẨN.
 *  Vì sao không dùng `AuditTrailHeadCells`: component dùng chung đó còn mang chuỗi class tự chế
 *  (`px-4 py-3`, canh trái, KHÔNG nền) nên 2 ô này sẽ HỞ NỀN giữa hàng tiêu đề xám — lỗi chỉ nhìn ảnh mới
 *  thấy. Đợt này không được sửa file dùng chung ngoài nhóm B ⇒ render tại trang bằng thChuan; đề xuất bổ
 *  sung prop class cho AuditCells đã ghi trong báo cáo. */
function ThTao(): JSX.Element {
  return (
    <>
      <th className={thChuan + ' w-[130px]'}>Người tạo</th>
      <th className={thChuan + ' w-[96px]'}>Ngày tạo</th>
    </>
  );
}
function TdTao({ row }: { row: AuditTrailRow }): JSX.Element {
  return (
    <>
      <td className={tdChuan + ' truncate text-center text-slate-600'} title={row.createdByName ?? ''}>{row.createdByName ?? '—'}</td>
      <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{fmtDate(row.createdAt)}</td>
    </>
  );
}
/** Ô tích CHỌN TẤT CẢ / 1 dòng theo KIỂU CHUẨN (SelectAllCell/SelectCell dùng chung còn class tự chế). */
function ThTich({ ids, sel }: { ids: number[]; sel: ReturnType<typeof useRowSelection> }): JSX.Element {
  const allOn = ids.length > 0 && ids.every((id) => sel.isSelected(id));
  return (
    <th className={thChuan + ' w-9 !px-1.5'}>
      <input type="checkbox" className="accent-brand" checked={allOn} aria-label="Chọn tất cả" onChange={(e) => sel.setAll(ids, e.target.checked)} />
    </th>
  );
}
function TdTich({ id, sel }: { id: number; sel: ReturnType<typeof useRowSelection> }): JSX.Element {
  return (
    <td className={tdChuan + ' !px-1.5 text-center'}>
      <input type="checkbox" className="accent-brand" checked={sel.isSelected(id)} aria-label={`Chọn dòng ${id}`} onChange={() => sel.toggle(id)} />
    </td>
  );
}

export function BankConfigPage({ user }: { user: AuthUser }): JSX.Element {
  const canBank = hasPermission(user, 'CONFIG_BANK_VIEW');
  const canFee = hasPermission(user, 'CONFIG_FEE_VIEW');
  const canIndustry = hasPermission(user, 'CONFIG_INDUSTRY_VIEW');
  const canStatus = hasPermission(user, 'SYSTEM_SETTING_VIEW');
  const canHandover = hasPermission(user, 'CONFIG_HANDOVER_VIEW');
  const [tab, setTab] = useState<Tab>(canBank ? 'bank' : canFee ? 'fee' : canIndustry ? 'industry' : canStatus ? 'status' : canHandover ? 'handover' : 'bank');
  const canManage = hasPermission(user, 'CONFIG_BANK_MANAGE');
  return (
    // MẪU CHỐT 6/11: `data-nut-vuong` ở thẻ bọc NGOÀI CÙNG để trang ăn luật nút/thanh cuộn/màu của mau-moi.css.
    <div data-nut-vuong data-trang-full>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-800">Cấu hình ngân hàng</h2>
        <p className="text-sm text-slate-500">Ngân hàng · Loại thẻ dùng trên máy POS · Đối tác và liên kết ngân hàng · Ngành nghề · Phí mua-cài máy-bán · Trạng thái · Loại giao.</p>
      </div>
      <TabBar>
        {canBank && <TabButton active={tab === 'bank'} onClick={() => setTab('bank')} icon={<Landmark className="h-4 w-4" />}>Ngân hàng</TabButton>}
        {canBank && <TabButton active={tab === 'cardtype'} onClick={() => setTab('cardtype')} icon={<CreditCard className="h-4 w-4" />}>Loại thẻ</TabButton>}
        {canBank && <TabButton active={tab === 'partner'} onClick={() => setTab('partner')} icon={<Building2 className="h-4 w-4" />}>Đối tác</TabButton>}
        {canIndustry && <TabButton active={tab === 'industry'} onClick={() => setTab('industry')} icon={<Tags className="h-4 w-4" />}>Ngành nghề</TabButton>}
        {canFee && <TabButton active={tab === 'fee'} onClick={() => setTab('fee')} icon={<Percent className="h-4 w-4" />}>Phí mua-cài máy-bán</TabButton>}
        {canStatus && <TabButton active={tab === 'status'} onClick={() => setTab('status')} icon={<CircleDot className="h-4 w-4" />}>Trạng thái</TabButton>}
        {canHandover && <TabButton active={tab === 'handover'} onClick={() => setTab('handover')} icon={<HandCoins className="h-4 w-4" />}>Loại giao</TabButton>}
      </TabBar>
      {tab === 'bank' && canBank && <BankTab canManage={canManage} />}
      {tab === 'cardtype' && canBank && <CardTypeTab canManage={canManage} />}
      {tab === 'partner' && canBank && <PartnerTab canManage={canManage} />}
      {tab === 'industry' && canIndustry && <IndustryConfigPage user={user} />}
      {tab === 'fee' && canFee && <FeeConfigPage user={user} />}
      {tab === 'status' && canStatus && <StatusConfigPage user={user} />}
      {tab === 'handover' && canHandover && <HandoverConfigPage user={user} />}
    </div>
  );
}

// ── C1/C2 NGÂN HÀNG ─────────────────────────────────────────────────────────
function BankTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const { options: bankStatusOptions } = useStatusOptions('BANK');
  const [rows, setRows] = useState<BankDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: BankDto } | null>(null);
  const [del, setDel] = useState<BankDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef1 = useRef<() => void>(() => {});
  reloadRef1.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.bankList({ search: search || undefined, status: statusFilter || undefined, fromDate: fromDate || undefined, toDate: toDate || undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  async function doDelete(b: BankDto, password?: string): Promise<void> {
    const res = await window.api.bankDelete([b.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa ngân hàng ${b.code}`);
    else toast.alert(res.message ?? 'Xóa ngân hàng thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }

  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.bankDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} ngân hàng`);
    else toast.alert(res.message ?? 'Xóa ngân hàng thất bại', 'Xóa thất bại');
    setBulkDel(false);
    await reload();
  }

  // Số cột THẬT: ô tích + 4 cột dữ liệu + 2 cột thông tin tạo + Thao tác.
  const soCot = 6 + (canManage ? 2 : 0);

  return (
    <div data-nut-vuong>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} ngân hàng</div>
        <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('ngan_hang', ['STT', 'Mã', 'Tên ngân hàng', 'Trạng thái', 'Người tạo', 'Ngày tạo', 'Giờ tạo', 'Người sửa', 'Ngày sửa', 'Giờ sửa'], rows.map((r) => [r.seqCode ?? '', r.code, r.name, r.status === 'ACTIVE' ? 'Đang hoạt động' : 'Không hoạt động', r.createdByName ?? '', fmtDate(r.createdAt), fmtTime(r.createdAt), r.updatedByName ?? '', fmtDate(r.updatedAt), fmtTime(r.updatedAt)]))}>Xuất Excel</Button>
          {canManage && <Button data-nut="them" variant="confirm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm ngân hàng</Button>}
        </div>
      </div>
      <StatBar
        items={[
          { label: 'Tổng ngân hàng', value: rows.length, tone: 'bg-brand-tint text-brand' },
          ...bankStatusOptions.filter((o) => o.active).map((o) => ({ label: o.label, value: rows.filter((b) => b.status === o.code).length, tone: toneCls(o.tone) }))
        ]}
      />
      <FilterBar search={search} onSearch={setSearch} searchPlaceholder="Tìm mã / tên ngân hàng…" fromDate={fromDate} toDate={toDate} onFromDate={setFromDate} onToDate={setToDate} selects={[{ key: 'status', placeholder: 'Tất cả trạng thái', value: statusFilter, options: bankStatusOptions.filter((o) => o.active).map((o) => ({ value: o.code, label: o.label })), onChange: setStatusFilter }]} onApply={reload} onReset={() => { setSearch(''); setStatusFilter(''); setFromDate(''); setToDate(''); setTimeout(() => reloadRef1.current(), 0); }} coChuNho locPhai />
      {canManage && <SelectionBar count={sel.count} entityLabel="ngân hàng" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <StaleBanner domain="Bank" onReload={reload} className="mb-2" />
      <KhungBang className={CAO_KHUNG}>
        {/* min-w: thiếu chỗ thì CUỘN NGANG, tuyệt đối KHÔNG ẩn cột theo breakpoint (mẫu chốt 6/11 §1). */}
        <table className="w-full min-w-[1020px] text-xs">
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              {canManage && <ThTich ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[90px]'}>STT</th>
              <th className={thChuan + ' w-[110px]'}>Mã</th>
              <th className={thChuan + ' w-[320px]'}>Tên ngân hàng</th>
              <th className={thChuan + ' w-[150px]'}>Trạng thái</th>
              <ThTao />
              {canManage && <th className={thChuan + ' w-[96px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-sm text-slate-400"><Landmark className="mx-auto mb-2 h-6 w-6" /> Chưa có ngân hàng.</td></tr>}
            {!loading && rows.map((b, i) => (
              // SỌC NGỰA VẰN dùng chung `trChuan(i)`; dòng ĐANG TÍCH tô sáng (tham số noiBat).
              <tr key={b.id} className={trChuan(i, sel.isSelected(b.id))}>
                {canManage && <TdTich id={b.id} sel={sel} />}
                <td className={tdChuan + ' text-center font-mono font-semibold tabular-nums text-slate-500'}>{b.seqCode ?? '—'}</td>
                <td className={tdChuan + ' text-center font-mono font-semibold text-brand'}>{b.code}</td>
                <td className={tdChuan + ' font-medium text-slate-800'} title={b.name}>{b.name}</td>
                <td className={tdChuan + ' text-center'}><StatusBadge entity="BANK" code={b.status} /></td>
                <TdTao row={b} />
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: b })}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(b)}><Trash2 className="h-4 w-4" /></IconButton>
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
      {form && <BankForm mode={form.mode} row={form.row} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa ngân hàng" message={`Ngân hàng "${del.name}" (${del.code}) sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều ngân hàng" message={`${sel.count} ngân hàng đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

/** [B189] 'HH:MM' → phút-trong-ngày; chuỗi hỏng → 0 (lớp dịch vụ còn kiểm lại biên giờ). */
function phutCuaGio(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v || '').trim());
  if (!m) return 0;
  return Math.min(1439, Math.max(0, Number(m[1]) * 60 + Number(m[2])));
}
/** [B189] phút-trong-ngày → 'HH:MM' để đổ vào ô nhập giờ. */
function gioCuaPhut(p: number): string {
  const h = Math.floor(p / 60), m = p % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function BankForm({ mode, row, onClose, onSaved }: { mode: 'create' | 'edit'; row?: BankDto; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const { options: bankStatusOptions } = useStatusOptions('BANK');
  const [name, setName] = useState(row?.name ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  const [status, setStatus] = useState(row?.status ?? 'ACTIVE');
  // [B189 19/11] DANH SÁCH CA TIỀN của ngân hàng. Giờ giữ dạng 'HH:MM' cho ô nhập, lúc lưu mới quy ra phút.
  const [caTien, setCaTien] = useState<{ ten: string; tu: string; den: string }[]>(
    (row?.caTien ?? []).map((c) => ({ ten: c.ten, tu: gioCuaPhut(c.tuPhut), den: gioCuaPhut(c.denPhut) }))
  );
  function themCa(): void {
    // Ca mới nối tiếp ca cuối (đỡ phải gõ lại), chưa có ca nào thì mở từ 00:00.
    const cuoi = caTien[caTien.length - 1];
    const batDau = cuoi?.den || '00:00';
    setCaTien((ds) => [...ds, { ten: 'Ca ' + (ds.length + 1), tu: batDau, den: '' }]);
  }
  function suaCa(i: number, thayDoi: Partial<{ ten: string; tu: string; den: string }>): void {
    setCaTien((ds) => ds.map((c, k) => (k === i ? { ...c, ...thayDoi } : c)));
  }
  function xoaCa(i: number): void {
    setCaTien((ds) => ds.filter((_, k) => k !== i));
  }
  const [busy, setBusy] = useState(false);
  async function save(): Promise<void> {
    if (!name.trim()) return toast.alert('Tên ngân hàng bắt buộc.', 'Thiếu thông tin');
    if (!code.trim()) return toast.alert('Mã ngân hàng bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    // [B189 19/11] gửi kèm DANH SÁCH CA TIỀN (thay toàn bộ). Giờ nhập dạng HH:MM → quy ra phút-trong-ngày.
    const dsCa = caTien
      .filter((c) => c.ten.trim() && c.tu && c.den)
      .map((c) => ({ ten: c.ten.trim(), tuPhut: phutCuaGio(c.tu), denPhut: phutCuaGio(c.den) }));
    const res = mode === 'edit' && row
      ? await window.api.bankUpdate(row.id, { name: name.trim(), code: code.trim(), status, caTien: dsCa, expectedUpdatedAt: row.updatedAt })
      : await window.api.bankCreate({ name: name.trim(), code: code.trim(), status, caTien: dsCa });
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật ngân hàng' : `Đã thêm ngân hàng ${code}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else toast.alert(res.message ?? 'Lưu ngân hàng thất bại', 'Không lưu được');
  }
  return (
    <Modal title={mode === 'edit' ? `Sửa ngân hàng ${row?.code}` : 'Thêm ngân hàng mới'} onClose={onClose} width="max-w-md" onSubmit={() => void save()}>
      <div className="grid gap-4">
        <Field label="Tên ngân hàng" required><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ngân hàng TMCP Ngoại thương" /></Field>
        <Field label="Mã ngân hàng" required hint="Ví dụ: VCB, TCB (không trùng)"><input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="VCB" /></Field>
        <Field label="Trạng thái"><select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>{statusSelectOptions(bankStatusOptions, row?.status).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</select></Field>

        {/* [B189 19/11 — Admin Demo "chọn ca, thêm ca, set giờ đến giờ" + "bảng ca phải có cột dòng, khác màu
            như brand thêm TID / POS danh sách khách"] BẢNG CA TIỀN: kiểu bảng lấy từ MODULE DÙNG CHUNG
            `BangChuan` (cấm chép chuỗi class vào trang), sọc dòng brand. Dùng CHUNG cho cả nút Thêm lẫn
            nút Sửa ngân hàng vì đây là một form. Để TRỐNG = ngân hàng chưa khai ca (không xếp ca). */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Ca tiền về</span>
            <Button variant="soft" size="sm" data-nut="them-ca" onClick={themCa} icon={<Plus className="h-3.5 w-3.5" />}>
              Thêm ca
            </Button>
          </div>
          <div className="overflow-hidden rounded-lg border border-line" data-kiem="bang-ca-tien">
            <table className="w-full border-collapse text-xs">
              <thead className={theadChuan}>
                <tr>
                  <th className={thChuan + ' w-[52px]'}>STT</th>
                  <th className={thChuan}>TÊN CA</th>
                  <th className={thChuan + ' w-[104px]'}>TỪ GIỜ</th>
                  <th className={thChuan + ' w-[104px]'}>ĐẾN GIỜ</th>
                  <th className={thChuan + ' w-[52px]'}>XÓA</th>
                </tr>
              </thead>
              <tbody>
                {caTien.length === 0 && (
                  <tr>
                    <td className={tdChuan + ' text-center text-slate-400'} colSpan={5}>
                      Chưa khai ca — ngân hàng này sẽ KHÔNG xếp ca cho bill.
                    </td>
                  </tr>
                )}
                {caTien.map((c, i) => (
                  <tr key={i} className={trChuan(i)}>
                    <td className={tdChuan + ' text-center text-slate-500'}>{i + 1}</td>
                    <td className={tdChuan}>
                      <input
                        className="w-full rounded border border-line bg-white px-2 py-1 text-xs outline-none focus:border-brand"
                        value={c.ten}
                        placeholder={'Ca ' + (i + 1)}
                        onChange={(e) => suaCa(i, { ten: e.target.value })}
                      />
                    </td>
                    <td className={tdChuan + ' text-center'}>
                      <input
                        type="time"
                        className="w-full rounded border border-line bg-white px-1 py-1 text-xs outline-none focus:border-brand"
                        value={c.tu}
                        onChange={(e) => suaCa(i, { tu: e.target.value })}
                      />
                    </td>
                    <td className={tdChuan + ' text-center'}>
                      <input
                        type="time"
                        className="w-full rounded border border-line bg-white px-1 py-1 text-xs outline-none focus:border-brand"
                        value={c.den}
                        onChange={(e) => suaCa(i, { den: e.target.value })}
                      />
                    </td>
                    <td className={tdChuan + ' text-center'}>
                      <button type="button" className="text-danger hover:brightness-110" title="Xóa ca này" onClick={() => xoaCa(i)}>
                        <Trash2 className="mx-auto h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Các ca KHÔNG được chồng giờ. Bill quẹt lúc nào rơi vào ca đó; giờ nằm ngoài mọi ca thì không xếp ca.
          </p>
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm ngân hàng'}</Button>
      </div>
    </Modal>
  );
}

// ── C3 LOẠI THẺ ─────────────────────────────────────────────────────────────
function CardTypeTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<CardTypeDto[]>([]);
  const [banks, setBanks] = useState<{ id: number; code: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [bankId, setBankId] = useState('');
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: CardTypeDto } | null>(null);
  const [del, setDel] = useState<CardTypeDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef2 = useRef<() => void>(() => {});
  reloadRef2.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.cardTypeList({ search: search || undefined, bankId: bankId ? Number(bankId) : undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { window.api.bankLite().then((r) => r.ok && r.data && setBanks(r.data)); }, []);
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [bankId]);

  async function doDelete(c: CardTypeDto, password?: string): Promise<void> {
    const res = await window.api.cardTypeDelete([c.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa loại thẻ ${c.name}`);
    else toast.alert(res.message ?? 'Xóa loại thẻ thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }

  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.cardTypeDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} loại thẻ`);
    else toast.alert(res.message ?? 'Xóa loại thẻ thất bại', 'Xóa thất bại');
    setBulkDel(false);
    await reload();
  }

  // Ô tích + 3 cột dữ liệu + 2 cột thông tin tạo + Thao tác.
  const soCot = 5 + (canManage ? 2 : 0);

  return (
    <div data-nut-vuong>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} loại thẻ</div>
        <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('loai_the', ['Mã', 'Tên loại thẻ', 'Ngân hàng', 'Người tạo', 'Ngày tạo', 'Giờ tạo', 'Người sửa', 'Ngày sửa', 'Giờ sửa'], rows.map((r) => [r.code, r.name, r.bankName, r.createdByName ?? '', fmtDate(r.createdAt), fmtTime(r.createdAt), r.updatedByName ?? '', fmtDate(r.updatedAt), fmtTime(r.updatedAt)]))}>Xuất Excel</Button>
          {canManage && <Button data-nut="them" variant="confirm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm loại thẻ</Button>}
        </div>
      </div>
      <FilterBar search={search} onSearch={setSearch} searchPlaceholder="Tìm mã / tên loại thẻ…" selects={[{ key: 'bank', placeholder: 'Tất cả ngân hàng', value: bankId, options: banks.map((b) => ({ value: String(b.id), label: `${b.code}` })), onChange: setBankId }]} onApply={reload} onReset={() => { setSearch(''); setBankId(''); setTimeout(() => reloadRef2.current(), 0); }} coChuNho locPhai />
      {canManage && <SelectionBar count={sel.count} entityLabel="loại thẻ" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <KhungBang className={CAO_KHUNG}>
        <table className="w-full min-w-[980px] text-xs">
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              {canManage && <ThTich ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[110px]'}>Mã</th>
              <th className={thChuan + ' w-[280px]'}>Tên loại thẻ</th>
              <th className={thChuan + ' w-[240px]'}>Ngân hàng</th>
              <ThTao />
              {canManage && <th className={thChuan + ' w-[96px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-sm text-slate-400"><CreditCard className="mx-auto mb-2 h-6 w-6" /> Chưa có loại thẻ.</td></tr>}
            {!loading && rows.map((c, i) => (
              <tr key={c.id} className={trChuan(i, sel.isSelected(c.id))}>
                {canManage && <TdTich id={c.id} sel={sel} />}
                <td className={tdChuan + ' text-center font-mono font-semibold text-brand'}>{c.code}</td>
                <td className={tdChuan + ' font-medium text-slate-800'} title={c.name}>
                  {c.name}
                  {c.isDefault && (
                    <span className="ml-2 rounded-full bg-brand-tint px-2 py-0.5 text-[11px] font-semibold text-brand">Mặc định</span>
                  )}
                </td>
                <td className={tdChuan + ' text-center text-slate-600'}>{c.bankCode ?? c.bankName ?? '—'}</td>
                <TdTao row={c} />
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: c })}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(c)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <tr aria-hidden><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>
      {form && <CardTypeForm mode={form.mode} row={form.row} banks={banks} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa loại thẻ" message={`Loại thẻ "${del.name}" sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều loại thẻ" message={`${sel.count} loại thẻ đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
    </div>
  );
}

function CardTypeForm({ mode, row, banks, onClose, onSaved }: { mode: 'create' | 'edit'; row?: CardTypeDto; banks: { id: number; code: string; name: string }[]; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [bankId, setBankId] = useState(row?.bankId ? String(row.bankId) : '');
  const [name, setName] = useState(row?.name ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  // [Admin Demo 15/11] THẺ MẶC ĐỊNH của ngân hàng — màn Thêm bill chọn sẵn thẻ này, đỡ phải chọn mỗi lần.
  const [macDinh, setMacDinh] = useState(row?.isDefault ?? false);
  const [busy, setBusy] = useState(false);
  const noBank = banks.length === 0; // FIX 3 — chống dead-end khi chưa có ngân hàng
  // "TẤT CẢ ngân hàng" (Admin Demo 13/11): khai 1 lần, gắn cho mọi ngân hàng — trước đây muốn JCB cho 12
  // ngân hàng phải mở form 12 lần. Chỉ có ở chế độ THÊM MỚI; sửa thì vẫn phải chọn đúng 1 ngân hàng.
  const TAT_CA = '__tat_ca__';
  const chonTatCa = mode === 'create' && bankId === TAT_CA;
  async function luuTatCa(): Promise<void> {
    // Gắn cho TỪNG ngân hàng. Chỗ đã có sẵn thì MÁY CHỦ từ chối (trùng) — đếm là "bỏ qua", không phải
    // hỏng; KHÔNG tự chế luật chống trùng ở đây để giữ 1 nguồn luật duy nhất.
    let them = 0;
    let boQua = 0;
    const hong: string[] = [];
    for (const b of banks) {
      const r = await window.api.cardTypeCreate({ bankId: b.id, name: name.trim(), code: code.trim() });
      if (r.ok) them++;
      else if (/tồn tại|trùng|duplicate/i.test(String(r.message ?? r.error ?? ''))) boQua++;
      else hong.push(b.code + ': ' + String(r.message ?? r.error ?? 'lỗi không rõ'));
    }
    setBusy(false);
    // Báo ĐỦ 3 con số — chỉ báo "đã thêm N" là để lỗi trôi qua lặng lẽ.
    const tom = 'Đã thêm ' + them + ' · bỏ qua ' + boQua + ' (đã có sẵn)' + (hong.length ? ' · HỎNG ' + hong.length : '');
    if (hong.length) toast.alert(tom + ' — ' + hong.slice(0, 5).join(' | '), 'Có ngân hàng không thêm được');
    else toast.success(tom + ' — loại thẻ ' + code.trim());
    onSaved();
  }
  async function save(): Promise<void> {
    if (noBank) return toast.alert('Chưa có ngân hàng — thêm ở tab \'Ngân hàng\' trước khi tạo loại thẻ.', 'Thiếu dữ liệu nền');
    if (!bankId) return toast.alert('Phải chọn ngân hàng.', 'Thiếu thông tin');
    if (!name.trim()) return toast.alert('Tên loại thẻ bắt buộc.', 'Thiếu thông tin');
    if (!code.trim()) return toast.alert('Mã loại thẻ bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    if (chonTatCa) return void luuTatCa();
    const payload = { bankId: Number(bankId), name: name.trim(), code: code.trim(), isDefault: macDinh };
    const res = mode === 'edit' && row ? await window.api.cardTypeUpdate(row.id, { ...payload, expectedUpdatedAt: row.updatedAt }) : await window.api.cardTypeCreate(payload);
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật loại thẻ' : `Đã thêm loại thẻ ${code}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else toast.alert(res.message ?? 'Lưu loại thẻ thất bại', 'Không lưu được');
  }
  return (
    <Modal title={mode === 'edit' ? `Sửa loại thẻ ${row?.code}` : 'Thêm loại thẻ mới'} onClose={onClose} width="max-w-md" onSubmit={() => void save()}>
      <div className="grid gap-4">
        <Field label="Ngân hàng" required hint={mode === 'create' ? 'Chọn “TẤT CẢ ngân hàng” để gắn loại thẻ này cho mọi ngân hàng trong một lần' : undefined}>
          <select data-kiem="chon-ngan-hang" className={inputCls} value={bankId} onChange={(e) => setBankId(e.target.value)} autoFocus disabled={noBank}>
            <option value="">{noBank ? '— Chưa có ngân hàng: thêm ở tab Ngân hàng —' : '— Chọn ngân hàng —'}</option>
            {mode === 'create' && !noBank && <option value={TAT_CA}>★ TẤT CẢ ngân hàng ({banks.length})</option>}
            {banks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
          </select>
        </Field>
        <Field label="Tên loại thẻ" required hint="Ví dụ: Visa nội địa, Napas"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Mã loại thẻ" required><input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="VISA" /></Field>
        {!chonTatCa && (
          <label className="flex items-start gap-2 rounded-lg border border-line bg-appbg/50 px-3 py-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5 accent-brand" data-kiem="the-mac-dinh" checked={macDinh} onChange={(e) => setMacDinh(e.target.checked)} />
            <span>
              Thẻ <b>mặc định</b> của ngân hàng này
              <span className="block text-xs text-slate-500">
                Màn <b>Thêm bill</b> sẽ chọn sẵn thẻ này (vẫn đổi sang thẻ khác được). Mỗi ngân hàng chỉ 1 thẻ mặc định —
                đánh dấu thẻ mới thì thẻ cũ tự bỏ cờ.
              </span>
            </span>
          </label>
        )}
      </div>
      {noBank && <p className="mt-2 text-xs font-medium text-warning">Chưa có ngân hàng nào — vào tab <b>Ngân hàng</b> thêm ít nhất 1 ngân hàng trước khi tạo loại thẻ.</p>}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" data-kiem="luu-loai-the" onClick={save} disabled={busy || noBank} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>
          {mode === 'edit' ? 'Lưu thay đổi' : chonTatCa ? `Thêm cho ${banks.length} ngân hàng` : 'Thêm loại thẻ'}
        </Button>
      </div>
    </Modal>
  );
}

// ── C4 ĐỐI TÁC + ma trận liên kết ngân hàng ─────────────────────────────────
function PartnerTab({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast();
  const { options: partnerStatusOptions } = useStatusOptions('PARTNER');
  const [rows, setRows] = useState<PartnerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: PartnerDto } | null>(null);
  const [del, setDel] = useState<PartnerDto | null>(null);
  const [matrix, setMatrix] = useState<PartnerBankMatrix | null>(null);
  const [linkOf, setLinkOf] = useState<PartnerDto | null>(null);
  const [bulkDel, setBulkDel] = useState(false);
  const sel = useRowSelection();

  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef3 = useRef<() => void>(() => {});
  reloadRef3.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.partnerList({ search: search || undefined, status: statusFilter || undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    const m = await window.api.partnerBankMatrix();
    if (m.ok && m.data) setMatrix(m.data);
    sel.clear();
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  async function doDelete(p: PartnerDto, password?: string): Promise<void> {
    const res = await window.api.partnerDelete([p.id], password ?? '');
    if (res.ok) toast.success(`Đã xóa đối tác ${p.code}`);
    else toast.alert(res.message ?? 'Xóa đối tác thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }

  async function doBulkDelete(password?: string): Promise<void> {
    const res = await window.api.partnerDelete([...sel.selected], password ?? '');
    if (res.ok) toast.success(`Đã xóa ${res.deleted ?? sel.count} đối tác`);
    else toast.alert(res.message ?? 'Xóa đối tác thất bại', 'Xóa thất bại');
    setBulkDel(false);
    await reload();
  }

  const bankName = (id: number): string => matrix?.banks.find((b) => b.id === id)?.code ?? String(id);
  const partnerStatusLabel = (code: string): string => partnerStatusOptions.find((o) => o.code === code)?.label ?? code;
  // Ô tích + 7 cột dữ liệu + 2 cột thông tin tạo + Thao tác.
  const soCot = 9 + (canManage ? 2 : 0);

  return (
    <div data-nut-vuong>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} đối tác</div>
        <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('doi_tac', ['Mã', 'Tên đối tác', 'Trạng thái', 'Người liên hệ', 'Số điện thoại', 'Địa chỉ', 'Ngân hàng liên kết', 'Người tạo', 'Ngày tạo', 'Giờ tạo', 'Người sửa', 'Ngày sửa', 'Giờ sửa'], rows.map((r) => [r.code, r.name, partnerStatusLabel(r.status), r.contactPerson, r.phone, r.address ?? '', r.bankIds.map(bankName).join(' | '), r.createdByName ?? '', fmtDate(r.createdAt), fmtTime(r.createdAt), r.updatedByName ?? '', fmtDate(r.updatedAt), fmtTime(r.updatedAt)]))}>Xuất Excel</Button>
          {canManage && <Button data-nut="them" variant="confirm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm đối tác</Button>}
        </div>
      </div>
      <StatBar
        items={[
          { label: 'Tổng đối tác', value: rows.length, tone: 'bg-brand-tint text-brand' },
          ...partnerStatusOptions.filter((o) => o.active).map((o) => ({ label: o.label, value: rows.filter((p) => p.status === o.code).length, tone: toneCls(o.tone) }))
        ]}
      />
      <FilterBar search={search} onSearch={setSearch} searchPlaceholder="Tìm mã / tên / Số điện thoại đối tác…" selects={[{ key: 'status', placeholder: 'Tất cả trạng thái', value: statusFilter, options: partnerStatusOptions.filter((o) => o.active).map((o) => ({ value: o.code, label: o.label })), onChange: setStatusFilter }]} onApply={reload} onReset={() => { setSearch(''); setStatusFilter(''); setTimeout(() => reloadRef3.current(), 0); }} coChuNho locPhai />
      {canManage && <SelectionBar count={sel.count} entityLabel="đối tác" onClear={sel.clear} onDelete={() => setBulkDel(true)} />}
      <KhungBang className={CAO_KHUNG}>
        {/* 9-11 cột ⇒ chật ở màn hẹp: CUỘN NGANG bằng min-w, tuyệt đối KHÔNG ẩn cột theo breakpoint. */}
        <table className="w-full min-w-[1560px] text-xs">
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              {canManage && <ThTich ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[110px]'}>Mã</th>
              <th className={thChuan + ' w-[200px]'}>Tên đối tác</th>
              <th className={thChuan + ' w-[150px]'}>Trạng thái</th>
              <th className={thChuan + ' w-[160px]'}>Người liên hệ</th>
              <th className={thChuan + ' w-[120px]'}>Số điện thoại</th>
              <th className={thChuan + ' w-[300px]'}>Địa chỉ</th>
              <th className={thChuan + ' w-[200px]'}>Ngân hàng liên kết</th>
              <ThTao />
              {canManage && <th className={thChuan + ' w-[120px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className="px-4 py-10 text-center text-sm text-slate-400"><Building2 className="mx-auto mb-2 h-6 w-6" /> Chưa có đối tác.</td></tr>}
            {!loading && rows.map((p, i) => (
              <tr key={p.id} className={trChuan(i, sel.isSelected(p.id))}>
                {canManage && <TdTich id={p.id} sel={sel} />}
                <td className={tdChuan + ' text-center font-mono font-semibold text-brand'}>{p.code}</td>
                <td className={tdChuan + ' font-medium text-slate-800'} title={p.name}>{p.name}</td>
                <td className={tdChuan + ' text-center'}><StatusBadge entity="PARTNER" code={p.status} /></td>
                <td className={tdChuan + ' text-center text-slate-600'}>{p.contactPerson ?? '—'}</td>
                <td className={tdChuan + ' text-center tabular-nums text-slate-600'}>{p.phone ?? '—'}</td>
                <td className={tdChuan + ' text-slate-500'} title={p.address ?? ''}>{p.address ?? '—'}</td>
                <td className={tdChuan}>
                  <div className="flex flex-wrap justify-center gap-1">
                    {p.bankIds.length === 0 ? <span className="text-slate-400">—</span> : p.bankIds.map((id) => <span key={id} className="rounded bg-brand-tint px-1.5 py-0.5 font-medium text-brand">{bankName(id)}</span>)}
                  </div>
                </td>
                <TdTao row={p} />
                {canManage && (
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      <IconButton title="Liên kết ngân hàng" onClick={() => setLinkOf(p)}><Link2 className="h-4 w-4" /></IconButton>
                      <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: p })}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton title="Xóa" tone="danger" onClick={() => setDel(p)}><Trash2 className="h-4 w-4" /></IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            <tr aria-hidden><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>
      {form && <PartnerForm mode={form.mode} row={form.row} banks={matrix?.banks ?? []} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa đối tác" message={`Đối tác "${del.name}" (${del.code}) sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
      {bulkDel && <ConfirmDialog title="Xóa nhiều đối tác" message={`${sel.count} đối tác đã chọn sẽ vào Thùng rác (có thể phục hồi). Nhập lại mật khẩu để xác nhận.`} confirmLabel={`Xóa ${sel.count} mục`} danger requirePassword onCancel={() => setBulkDel(false)} onConfirm={(pwd) => doBulkDelete(pwd)} />}
      {linkOf && matrix && <LinkBanksModal partner={linkOf} banks={matrix.banks} onClose={() => setLinkOf(null)} onSaved={() => { setLinkOf(null); void reload(); }} />}
    </div>
  );
}

function PartnerForm({ mode, row, banks, onClose, onSaved }: { mode: 'create' | 'edit'; row?: PartnerDto; banks: { id: number; code: string; name: string }[]; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const { options: partnerStatusOptions } = useStatusOptions('PARTNER');
  const [name, setName] = useState(row?.name ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  const [status, setStatus] = useState(row?.status ?? 'UNSIGNED');
  const [address, setAddress] = useState(row?.address ?? '');
  const [phone, setPhone] = useState(row?.phone ?? '');
  const [email, setEmail] = useState(row?.email ?? '');
  const [contactPerson, setContactPerson] = useState(row?.contactPerson ?? '');
  const [selectedBanks, setSelectedBanks] = useState<Set<number>>(new Set(row?.bankIds ?? []));
  const [busy, setBusy] = useState(false);
  function toggleBank(id: number): void { const s = new Set(selectedBanks); s.has(id) ? s.delete(id) : s.add(id); setSelectedBanks(s); }
  async function save(): Promise<void> {
    if (!name.trim()) return toast.alert('Tên đối tác bắt buộc.', 'Thiếu thông tin');
    if (!code.trim()) return toast.alert('Mã đối tác bắt buộc.', 'Thiếu thông tin');
    setBusy(true);
    const payload = { name: name.trim(), code: code.trim(), status, address: address || null, phone: phone || null, email: email || null, contactPerson: contactPerson || null };
    const res = mode === 'edit' && row ? await window.api.partnerUpdate(row.id, { ...payload, expectedUpdatedAt: row.updatedAt }) : await window.api.partnerCreate(payload);
    if (!res.ok) {
      setBusy(false);
      if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); return; }
      return toast.alert(res.message ?? 'Lưu đối tác thất bại', 'Không lưu được');
    }
    // Cập nhật liên kết ngân hàng ngay sau khi lưu đối tác (dùng id trả về khi tạo mới).
    const pid = mode === 'edit' && row ? row.id : res.id;
    if (pid) {
      const link = await window.api.partnerBankSet(pid, [...selectedBanks]);
      if (!link.ok) toast.alert('Đối tác đã lưu nhưng cập nhật liên kết ngân hàng thất bại: ' + (link.message ?? 'lỗi không rõ'), 'Liên kết chưa lưu');
    }
    setBusy(false);
    toast.success(mode === 'edit' ? 'Đã cập nhật đối tác' : `Đã thêm đối tác ${code}`);
    onSaved();
  }
  return (
    <Modal title={mode === 'edit' ? `Sửa đối tác ${row?.code}` : 'Thêm đối tác mới'} onClose={onClose} width="max-w-xl" onSubmit={() => void save()}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Tên đối tác" required><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Mã đối tác" required hint="Không trùng"><input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label="Trạng thái hợp đồng"><select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>{statusSelectOptions(partnerStatusOptions, row?.status).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</select></Field>
        <Field label="Người liên hệ"><input className={inputCls} value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} /></Field>
        <Field label="Số điện thoại"><input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label="Email"><input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Địa chỉ"><input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        {/* Ngân hàng liên kết — tích chọn ngay khi thêm/sửa đối tác (đồng bộ style với LinkBanksModal). */}
        <div className="col-span-2">
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Ngân hàng liên kết</label>
          {banks.length === 0 ? (
            <div className="text-sm text-slate-400">Chưa có ngân hàng — thêm ở tab Ngân hàng trước.</div>
          ) : (
            <div className="grid max-h-48 grid-cols-2 gap-2 overflow-auto">
              {banks.map((b) => (
                <label key={b.id} className={'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ' + (selectedBanks.has(b.id) ? 'border-brand bg-brand-tint text-brand' : 'border-line hover:bg-appbg')}>
                  <input type="checkbox" checked={selectedBanks.has(b.id)} onChange={() => toggleBank(b.id)} className="accent-brand" />
                  <span className="font-mono text-xs font-semibold">{b.code}</span>
                  <span className="truncate text-slate-600">{b.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm đối tác'}</Button>
      </div>
    </Modal>
  );
}

function LinkBanksModal({ partner, banks, onClose, onSaved }: { partner: PartnerDto; banks: { id: number; code: string; name: string }[]; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set(partner.bankIds));
  const [busy, setBusy] = useState(false);
  function toggle(id: number): void { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s); }
  async function save(): Promise<void> {
    setBusy(true);
    const res = await window.api.partnerBankSet(partner.id, [...selected]);
    setBusy(false);
    if (res.ok) { toast.success(`Đã cập nhật liên kết ngân hàng cho ${partner.code}`); onSaved(); }
    else toast.alert(res.message ?? 'Lưu liên kết thất bại', 'Không lưu được');
  }
  return (
    <Modal title={`Liên kết ngân hàng — ${partner.name}`} onClose={onClose} width="max-w-lg" onSubmit={() => void save()}>
      <p className="mb-3 text-sm text-slate-500">Tích chọn các ngân hàng mà đối tác này liên kết.</p>
      <div className="grid max-h-72 grid-cols-2 gap-2 overflow-auto">
        {banks.length === 0 && <div className="col-span-2 text-sm text-slate-400">Chưa có ngân hàng nào — thêm ở tab Ngân hàng trước.</div>}
        {banks.map((b) => (
          <label key={b.id} className={'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ' + (selected.has(b.id) ? 'border-brand bg-brand-tint text-brand' : 'border-line hover:bg-appbg')}>
            <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggle(b.id)} className="accent-brand" />
            <span className="font-mono text-xs font-semibold">{b.code}</span>
            <span className="truncate text-slate-600">{b.name}</span>
          </label>
        ))}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Lưu liên kết</Button>
      </div>
    </Modal>
  );
}
