// NHÀ ĐẦU TƯ (Admin Demo 9/8) — tab trong Quản Lý Nhân Sự (như Khách hàng). CRUD + %phí đầu tư. Gọi qua httpCall
// (quanly-api /v1/investors → @sigma/services). Nghiệp vụ ở core; trang này chỉ UI.
import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Loader2, TrendingUp, Download, X, Lock, Unlock } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate, fmtTime, groupDigits } from '@sigma/shared';
import type { InvestorDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Field, inputCls } from '../components/Field.js';
// MẪU THIẾT KẾ CHỐT 6/11 — kiểu bảng lấy từ MODULE DÙNG CHUNG, CẤM chép chuỗi class vào trang.
import { KhungBang, thChuan, tdChuan, tdTongChuan, tdTien, tdPhanTram, trChuan, theadChuan, tfootChuan, trTongChuan, tdTrong, HangDem } from '../components/BangChuan.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { exportCsv } from '../lib/exportCsv.js';
import { PasswordInput } from '../components/PasswordInput.js';
import { ChatGroupPicker } from '../components/ChatGroupsSection.js';
import type { InvestorAdvanceDto, InvestorBankAccountDto, InvestorChatGroupDto, InvestorSubUserDto } from '../../../preload/index.d';

function fmtPct(v: number): string { return `${v.toFixed(3).replace(/\.?0+$/, '')}%`; }
// Nhóm 3 số bằng dấu chấm: dùng `groupDigits` của @sigma/shared (NGUỒN DUY NHẤT) — bản chép tay trong
// trang này đã bỏ, tránh 2 cách nhóm số lệch nhau. KHÔNG toLocaleString (lệ thuộc locale máy).
function fmtMoney(n: number): string { return groupDigits(String(Math.trunc(Math.abs(n)))); }
/** Ngày hôm nay dạng 'YYYY-MM-DD' (local) — mặc định cho ô ngày tạm ứng. */
function todayIso(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

export function InvestorsPage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const canCreate = hasPermission(user, 'INVESTOR_CREATE');
  const canUpdate = hasPermission(user, 'INVESTOR_UPDATE');
  const canDelete = hasPermission(user, 'INVESTOR_DELETE');
  const canManageSub = hasPermission(user, 'INVESTOR_SUBUSER_MANAGE'); // Tài khoản xem (Admin Demo 12/8)
  const [rows, setRows] = useState<InvestorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: InvestorDto } | null>(null);
  const [del, setDel] = useState<InvestorDto | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.investorList({ search: search || undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  async function doDelete(inv: InvestorDto, password?: string): Promise<void> {
    const res = await window.api.investorDelete(inv.id, password ?? '');
    if (res.ok) toast.success(`Đã xóa nhà đầu tư ${inv.nickname}`);
    else toast.alert(res.message ?? 'Xóa nhà đầu tư thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }

  // SỐ CỘT của bảng chính — tính MỘT LẦN rồi dùng cho hàng rỗng / hàng đệm / hàng TỔNG.
  // Trước đây colSpan hard-code 7 trong khi cột "Thao tác" chỉ hiện khi có quyền ⇒ lệch 1 cột ở
  // tài khoản chỉ-xem (hàng rỗng co lại). Nay 1 biến duy nhất.
  const coThaoTac = canUpdate || canDelete;
  const soCot = 6 + (coThaoTac ? 1 : 0);

  return (
    /* `data-nut-vuong` để trang ăn luật NÚT + THANH CUỘN của mau-moi.css (nạp ở main.tsx). */
    <div data-nut-vuong data-trang-full>
      {/* Thanh công cụ: 1 HÀNG, không xuống dòng; tràn thì cuộn ngang TRONG thanh (trang không cuộn). */}
      <div className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
        <div className="shrink-0 text-xs text-slate-500">{rows.length} nhà đầu tư · <span className="text-slate-400">hưởng lãi theo % phí đầu tư trên doanh số</span></div>
        <div className="flex-1" />
        <input className={inputCls + ' w-44 shrink-0 text-xs'} placeholder="Tìm mã/tên/SĐT…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void reload()} />
        <Button variant="soft" data-nut="lammoi" onClick={() => void reload()}>Làm mới</Button>
        <Button variant="confirm" data-nut="excel" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('nha_dau_tu', ['Mã', 'Tên', 'Biệt danh', 'SĐT', '% phí đầu tư', 'Trạng thái', 'Người tạo', 'Ngày tạo', 'Giờ tạo'], rows.map((r) => [r.code, r.fullName, r.nickname, r.phone ?? '', fmtPct(r.investFeePct), r.status, r.createdByName ?? '', fmtDate(r.createdAt), fmtTime(r.createdAt)]))}>Xuất Excel</Button>
        {canCreate && <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ mode: 'create' })}>Thêm NĐT</Button>}
      </div>
      {/* Bảng: tiêu đề ghim trên · hàng TỔNG ghim đáy · hàng đệm cuối tbody · sọc ngựa vằn.
          `min-w` cho CUỘN NGANG chủ ý — số cột CỐ ĐỊNH ở mọi bề ngang, KHÔNG ẩn cột theo breakpoint. */}
      <KhungBang className="list-scroll bg-white shadow-sm">
        <table className="w-full min-w-[1120px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan + ' w-[96px]'}>Mã</th>
              <th className={thChuan + ' w-[240px]'}>Nhà đầu tư</th>
              <th className={thChuan + ' w-[130px]'}>SĐT</th>
              <th className={thChuan + ' w-[320px]'}>Nhóm chat</th>
              <th className={thChuan + ' w-[120px]'}>% phí đầu tư</th>
              <th className={thChuan + ' w-[150px]'}>Trạng thái</th>
              {coThaoTac && <th className={thChuan + ' w-[110px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCot} className={tdTrong}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={soCot} className={tdTrong}><TrendingUp className="mx-auto mb-2 h-6 w-6" /> Chưa có nhà đầu tư.</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={r.id} className={trChuan(i)}>
                <td className={tdChuan + ' text-center'}><span className="font-mono font-semibold text-brand">{r.code}</span></td>
                <td className={tdChuan}><div className="font-medium text-slate-800">{r.nickname}</div><div className="text-slate-400">{r.fullName}</div></td>
                <td className={tdChuan + ' text-center tabular-nums text-slate-600'}>{r.phone ?? '—'}</td>
                <td className={tdChuan + ' whitespace-normal'}>
                  {r.chatGroupNames.length > 0
                    ? <div className="flex flex-wrap gap-1">{r.chatGroupNames.map((n, k) => <span key={k} className="rounded-full bg-brand-tint px-2 py-0.5 font-medium text-brand">{n}</span>)}</div>
                    : <span className="text-slate-400">Chưa gán</span>}
                </td>
                <td className={tdPhanTram}>{fmtPct(r.investFeePct)}</td>
                <td className={tdChuan + ' text-center'}>{r.status === 'ACTIVE' ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">Đang hoạt động</span> : <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-500">{r.status}</span>}</td>
                {coThaoTac && (
                  <td className={tdChuan}><div className="flex justify-center gap-1">
                    {canUpdate && <IconButton title="Sửa" tone="edit" onClick={() => setForm({ mode: 'edit', row: r })}><Pencil className="h-4 w-4" /></IconButton>}
                    {canDelete && <IconButton title="Xóa" tone="danger" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton>}
                  </div></td>
                )}
              </tr>
            ))}
            <HangDem soCot={soCot} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={soCot}>TỔNG {rows.length} nhà đầu tư</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {form && <InvestorForm mode={form.mode} row={form.row} canManageSub={canManageSub} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
      {del && <ConfirmDialog title="Xóa nhà đầu tư" message={`Nhà đầu tư "${del.nickname}" sẽ vào Thùng rác. Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
    </div>
  );
}

function InvestorForm({ mode, row, canManageSub, onClose, onSaved }: { mode: 'create' | 'edit'; row?: InvestorDto; canManageSub: boolean; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [fullName, setFullName] = useState(row?.fullName ?? '');
  const [nickname, setNickname] = useState(row?.nickname ?? '');
  const [phone, setPhone] = useState(row?.phone ?? '');
  const [feePct, setFeePct] = useState(row?.investFeePct != null ? String(row.investFeePct) : '');
  const [note, setNote] = useState(row?.note ?? '');
  const [busy, setBusy] = useState(false);
  // Tài khoản đăng nhập NĐT được BACKEND tự tạo/gắn khi thêm nhân sự tích 'Nhà đầu tư' (createUser → createInvestorForUserTx).
  // Không còn dropdown chọn tay ở form này. Edit: gửi lại userId hiện có (không cho đổi). Create: userId=null (chờ auto-gắn).

  async function save(): Promise<void> {
    if (!fullName.trim()) return toast.alert('Tên nhà đầu tư bắt buộc.', 'Thiếu thông tin');
    if (!nickname.trim()) return toast.alert('Biệt danh bắt buộc.', 'Thiếu thông tin');
    const feeNum = feePct.trim() === '' ? 0 : Number(feePct);
    if (!Number.isFinite(feeNum) || feeNum < 0) return toast.alert('% phí đầu tư không hợp lệ — nhập số ≥ 0 (ví dụ 0.1).', 'Sai định dạng');
    setBusy(true);
    const payload = { fullName: fullName.trim(), nickname: nickname.trim(), phone: phone.trim() || null, investFeePct: feeNum, note: note.trim() || null, userId: mode === 'edit' ? (row?.userId ?? null) : null };
    const res = mode === 'edit' && row ? await window.api.investorUpdate(row.id, { ...payload, expectedUpdatedAt: row.updatedAt }) : await window.api.investorCreate(payload);
    setBusy(false);
    if (res.ok) { toast.success(mode === 'edit' ? 'Đã cập nhật nhà đầu tư' : `Đã thêm nhà đầu tư ${nickname}`); onSaved(); }
    else if (isStaleWrite(res)) { toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE); onSaved(); }
    else toast.alert(res.message ?? 'Lưu nhà đầu tư thất bại', 'Không lưu được');
  }

  return (
    <Modal title={mode === 'edit' ? `Sửa nhà đầu tư ${row?.fullName ?? ''}${row?.code ? ` · ${row.code}` : ''}`.trim() : 'Thêm nhà đầu tư'} onClose={onClose} width={mode === 'edit' ? 'max-w-2xl' : 'max-w-md'} onSubmit={() => void save()}>
      <div className="grid gap-4">
        <Field label="Tên nhà đầu tư" required><input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus /></Field>
        <Field label="Biệt danh" required hint="Tên dễ gọi"><input className={inputCls} value={nickname} onChange={(e) => setNickname(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Số điện thoại"><input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="% phí đầu tư" hint="0 hoặc 0.1…"><input className={inputCls + ' text-right'} inputMode="decimal" value={feePct} onChange={(e) => setFeePct(e.target.value)} placeholder="0.1" /></Field>
        </div>
        <Field label="Ghi chú"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Tài khoản đăng nhập" hint="Tự động gắn khi tạo tài khoản nhân sự tích 'Nhà đầu tư'">
          {mode === 'edit' ? (
            row?.userId != null && row.loginUsername
              ? <div className={inputCls + ' bg-slate-50 text-slate-600'}>{row.loginUsername}</div>
              : <div className="text-sm text-slate-400">Chưa gắn tài khoản đăng nhập</div>
          ) : (
            <div className="text-sm text-slate-400">Tài khoản đăng nhập được tạo tự động khi thêm nhân sự và tích 'Nhà đầu tư' (mục Nhân sự).</div>
          )}
        </Field>
      </div>
      {mode === 'edit' && row && (
        <div className="mt-6 grid gap-6 border-t border-line pt-5">
          {canManageSub && <SubUserSection investorId={row.id} />}
          <AdvanceSection investorId={row.id} />
          <BankAccountSection investorId={row.id} />
          <ChatGroupSection investorId={row.id} />
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{mode === 'edit' ? 'Lưu thay đổi' : 'Thêm nhà đầu tư'}</Button>
      </div>
    </Modal>
  );
}

/** Khu TÀI KHOẢN XEM (tài khoản con) của 1 NĐT (Admin Demo 12/8) — thêm (username/mật khẩu/họ tên) + Khóa/Mở + Xóa.
 *  Tài khoản R_INVESTOR gắn investorId để NĐT chia sẻ quyền xem báo cáo CỦA MÌNH. Xóa cần nhập lại mật khẩu (§14). */
function SubUserSection({ investorId }: { investorId: number }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<InvestorSubUserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<InvestorSubUserDto | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.investorSubUserList(investorId);
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [investorId]);

  async function add(): Promise<void> {
    if (!username.trim()) { toast.alert('Nhập tên đăng nhập (≥8 ký tự, chỉ A-Z a-z 0-9).', 'Thiếu thông tin'); return; }
    if (!password) { toast.alert('Nhập mật khẩu (≥8 ký tự, gồm chữ và số).', 'Thiếu thông tin'); return; }
    setBusy(true);
    const res = await window.api.investorSubUserCreate(investorId, { username: username.trim(), password, fullName: fullName.trim() || null });
    setBusy(false);
    if (res.ok) { toast.success(`Đã thêm tài khoản xem ${username.trim()}`); setUsername(''); setPassword(''); setFullName(''); await reload(); }
    else toast.alert(res.message ?? 'Thêm tài khoản xem thất bại', 'Không lưu được');
  }
  async function doLock(u: InvestorSubUserDto, lock: boolean): Promise<void> {
    const res = lock ? await window.api.investorSubUserLock(u.id) : await window.api.investorSubUserUnlock(u.id);
    if (res.ok) toast.success(lock ? `Đã khóa ${u.username}` : `Đã mở khóa ${u.username}`);
    else toast.alert(res.message ?? 'Thao tác thất bại', 'Thao tác thất bại');
    await reload();
  }
  async function doDelete(u: InvestorSubUserDto, pwd?: string): Promise<void> {
    const res = await window.api.investorSubUserDelete(u.id, pwd ?? '');
    if (res.ok) toast.success(`Đã xóa tài khoản xem ${u.username}`);
    else toast.alert(res.message ?? 'Xóa tài khoản xem thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }

  return (
    <div>
      <div className="mb-2 text-sm font-semibold text-slate-700">Tài khoản xem <span className="font-normal text-slate-400">— tài khoản đăng nhập chỉ xem báo cáo của nhà đầu tư này</span></div>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[9rem]">
          <label className="mb-1 block text-xs text-slate-500">Tên đăng nhập</label>
          <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="≥8 ký tự, A-Z a-z 0-9" />
        </div>
        <div className="flex-1 min-w-[9rem]">
          <label className="mb-1 block text-xs text-slate-500">Mật khẩu</label>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="≥8 ký tự, gồm chữ và số" />
        </div>
        <div className="flex-1 min-w-[9rem]">
          <label className="mb-1 block text-xs text-slate-500">Họ tên</label>
          <input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Tùy chọn" />
        </div>
        <Button data-nut="them" variant="confirm" onClick={add} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}>Thêm tài khoản</Button>
      </div>
      <KhungBang className="max-h-[36vh] bg-white">
        <table className="w-full min-w-[620px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan + ' w-[200px]'}>Tên đăng nhập</th>
              <th className={thChuan}>Họ tên</th>
              <th className={thChuan + ' w-[150px]'}>Trạng thái</th>
              <th className={thChuan + ' w-[130px]'}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={4} className={tdTrong}><Loader2 className="mx-auto h-4 w-4 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={4} className={tdTrong}>Chưa có tài khoản xem.</td></tr>}
            {!loading && rows.map((u, i) => (
              <tr key={u.id} className={trChuan(i)}>
                <td className={tdChuan + ' font-mono font-semibold text-slate-800'}>{u.username}</td>
                <td className={tdChuan + ' text-slate-600'}>{u.fullName}</td>
                <td className={tdChuan + ' text-center'}>{u.status === 'ACTIVE' ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">Đang hoạt động</span> : <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-500">{u.status === 'LOCKED' ? 'Đã khóa' : u.status}</span>}</td>
                <td className={tdChuan}><div className="flex justify-center gap-1">
                  {u.status === 'ACTIVE' && <IconButton title="Khóa" onClick={() => doLock(u, true)}><Lock className="h-4 w-4" /></IconButton>}
                  {u.status === 'LOCKED' && <IconButton title="Mở khóa" onClick={() => doLock(u, false)}><Unlock className="h-4 w-4" /></IconButton>}
                  <IconButton title="Xóa" tone="danger" onClick={() => setDel(u)}><Trash2 className="h-4 w-4" /></IconButton>
                </div></td>
              </tr>
            ))}
            <HangDem soCot={4} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={4}>TỔNG {rows.length} tài khoản xem</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {del && <ConfirmDialog title="Xóa tài khoản xem" message={`Tài khoản "${del.username}" sẽ bị xóa. Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
    </div>
  );
}

/** Khu SỔ TẠM ỨNG vốn của 1 NĐT — thêm (số tiền nhóm-3-số + ngày + ghi chú) + bảng + tổng đã ứng (Phase C-2a). */
/** 1 bên chuyển khoản (người ứng / người nhận) trong bảng: STK · tên · NH xếp dọc; tất cả rỗng → "—". */
function PartyCell({ acc, name, bank }: { acc: string | null; name: string | null; bank: string | null }): JSX.Element {
  if (!acc && !name && !bank) return <span className="text-slate-400">—</span>;
  return (
    <div className="leading-tight">
      {name && <div className="font-medium text-slate-700">{name}</div>}
      {acc && <div className="tabular-nums text-slate-600">{acc}</div>}
      {bank && <div className="text-xs text-slate-500">{bank}</div>}
    </div>
  );
}

function AdvanceSection({ investorId }: { investorId: number }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<InvestorAdvanceDto[]>([]);
  const [loading, setLoading] = useState(true);
  // Form thêm tạm ứng — số tiền + ngày + chi tiết CK (nhập tay; nếu có OCR sai thì sửa tay) + ghi chú.
  const [amountRaw, setAmountRaw] = useState('');
  const [dateStr, setDateStr] = useState(todayIso());
  const [noteStr, setNoteStr] = useState('');
  const [sAcc, setSAcc] = useState(''); const [sName, setSName] = useState(''); const [sBank, setSBank] = useState('');
  const [rAcc, setRAcc] = useState(''); const [rName, setRName] = useState(''); const [rBank, setRBank] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<InvestorAdvanceDto | null>(null);
  // Lọc khoảng ngày (từ/đến) — trống = tất cả. Gửi xuống core lọc theo advanceDate (local half-open).
  const [fromStr, setFromStr] = useState('');
  const [toStr, setToStr] = useState('');

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.advanceList({ investorId, from: fromStr || undefined, to: toStr || undefined });
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [investorId, fromStr, toStr]);

  // [B326/SV2 24/11 — agent soát, NẶNG] `investor_advances` TRỘN 3 nguồn: OCR + MANUAL (NĐT TẠM ỨNG vào)
  // + REPAYMENT (SigMa HOÀN tiền NGƯỢC ra NĐT, lưu dương). Cộng chung một dấu làm TỔNG "đã ứng" phồng
  // (đo sổ thật: +2,7 tỉ repayment lẫn vào). Tách: tổng TẠM ỨNG = nguồn ≠ REPAYMENT; tổng HOÀN riêng.
  const total = rows.reduce((s, r) => s + (r.source === 'REPAYMENT' ? 0 : r.amount), 0);
  const totalHoan = rows.reduce((s, r) => s + (r.source === 'REPAYMENT' ? r.amount : 0), 0);

  async function add(): Promise<void> {
    if (!amountRaw) { toast.alert('Nhập số tiền tạm ứng.', 'Thiếu thông tin'); return; }
    if (!dateStr) { toast.alert('Chọn ngày tạm ứng.', 'Thiếu thông tin'); return; }
    setBusy(true);
    const res = await window.api.advanceCreate({
      investorId, amount: amountRaw, advanceDate: dateStr,
      senderAccountNumber: sAcc.trim() || null, senderName: sName.trim() || null, senderBank: sBank.trim() || null,
      receiverAccountNumber: rAcc.trim() || null, receiverName: rName.trim() || null, receiverBank: rBank.trim() || null,
      note: noteStr.trim() || null
    });
    setBusy(false);
    if (res.ok) {
      toast.success('Đã thêm tạm ứng');
      setAmountRaw(''); setNoteStr('');
      setSAcc(''); setSName(''); setSBank(''); setRAcc(''); setRName(''); setRBank('');
      await reload();
    } else toast.alert(res.message ?? 'Thêm tạm ứng thất bại', 'Không lưu được');
  }
  async function doDelete(a: InvestorAdvanceDto, password?: string): Promise<void> {
    const res = await window.api.advanceDelete(a.id, password ?? '');
    if (res.ok) toast.success('Đã xóa tạm ứng');
    else toast.alert(res.message ?? 'Xóa tạm ứng thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-700">Tạm ứng vốn</div>
        <div className="text-sm text-slate-500">Tổng đã ứng: <span className="font-semibold text-brand tabular-nums">{fmtMoney(total)}đ</span>{totalHoan > 0 ? <> · đã hoàn về NĐT: <span className="font-semibold text-danger tabular-nums">{fmtMoney(totalHoan)}đ</span></> : null}</div>
      </div>
      {/* Form thêm — số tiền/ngày/ghi chú */}
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-slate-500">Số tiền (đ)</label>
          <input className={inputCls + ' text-right tabular-nums'} inputMode="numeric" value={groupDigits(amountRaw)} onChange={(e) => setAmountRaw(e.target.value.replace(/\D/g, ''))} placeholder="0" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500">Ngày ứng</label>
          <input type="date" className={inputCls} value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-slate-500">Ghi chú</label>
          <input className={inputCls} value={noteStr} onChange={(e) => setNoteStr(e.target.value)} placeholder="Tùy chọn" />
        </div>
      </div>
      {/* Chi tiết chuyển khoản — nhập tay; nếu quét OCR bill sai thì sửa tay lại */}
      <div className="mb-1 text-xs text-slate-400">Chi tiết chuyển khoản (tùy chọn — OCR bill sai thì sửa tay):</div>
      <div className="mb-2 grid gap-2 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-appbg/40 p-2">
          <div className="mb-1 text-xs font-medium text-slate-500">Người ứng (chuyển đi)</div>
          <div className="flex flex-wrap gap-2">
            <input className={inputCls + ' flex-1 min-w-[7rem] tabular-nums'} value={sAcc} onChange={(e) => setSAcc(e.target.value)} placeholder="Số tài khoản" />
            <input className={inputCls + ' flex-1 min-w-[7rem]'} value={sName} onChange={(e) => setSName(e.target.value)} placeholder="Tên" />
            <input className={inputCls + ' flex-1 min-w-[6rem]'} value={sBank} onChange={(e) => setSBank(e.target.value)} placeholder="Ngân hàng" />
          </div>
        </div>
        <div className="rounded-lg border border-line bg-appbg/40 p-2">
          <div className="mb-1 text-xs font-medium text-slate-500">Người nhận</div>
          <div className="flex flex-wrap gap-2">
            <input className={inputCls + ' flex-1 min-w-[7rem] tabular-nums'} value={rAcc} onChange={(e) => setRAcc(e.target.value)} placeholder="Số tài khoản" />
            <input className={inputCls + ' flex-1 min-w-[7rem]'} value={rName} onChange={(e) => setRName(e.target.value)} placeholder="Tên" />
            <input className={inputCls + ' flex-1 min-w-[6rem]'} value={rBank} onChange={(e) => setRBank(e.target.value)} placeholder="Ngân hàng" />
          </div>
        </div>
      </div>
      <div className="mb-3 flex justify-end">
        <Button data-nut="them" variant="confirm" onClick={add} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}>Thêm tạm ứng</Button>
      </div>
      {/* Lọc khoảng ngày — 1 HÀNG, cỡ chữ nhỏ, nút "Bỏ lọc" căn MÉP PHẢI (mẫu chốt 6/11 §4). */}
      <div className="mb-2 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
        <span className="shrink-0 text-xs text-slate-500">Từ</span>
        <input type="date" className={inputCls + ' shrink-0 text-xs'} value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
        <span className="shrink-0 text-xs text-slate-500">đến</span>
        <input type="date" className={inputCls + ' shrink-0 text-xs'} value={toStr} onChange={(e) => setToStr(e.target.value)} />
        <div className="flex-1" />
        {(fromStr || toStr) && (
          <Button variant="soft" data-nut="xoaloc" onClick={() => { setFromStr(''); setToStr(''); }} icon={<X className="h-4 w-4" />}>Bỏ lọc</Button>
        )}
      </div>
      <KhungBang className="max-h-[42vh] bg-white">
        <table className="w-full min-w-[1240px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan + ' w-[92px]'}>Ngày</th>
              <th className={thChuan + ' w-[78px]'}>Giờ</th>
              <th className={thChuan + ' w-[140px]'}>Số tiền</th>
              <th className={thChuan + ' w-[190px]'}>Người ứng</th>
              <th className={thChuan + ' w-[190px]'}>Người nhận</th>
              <th className={thChuan + ' w-[80px]'}>Nguồn</th>
              <th className={thChuan}>Ghi chú</th>
              <th className={thChuan + ' w-[140px]'}>Người tạo</th>
              <th className={thChuan + ' w-[90px]'}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className={tdTrong}><Loader2 className="mx-auto h-4 w-4 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={9} className={tdTrong}>Chưa có lần tạm ứng nào.</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={r.id} className={trChuan(i)}>
                <td className={tdChuan + ' text-center text-slate-600'}>{fmtDate(r.advanceDate)}</td>
                <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{fmtTime(r.advanceDate)}</td>
                {/* Cột TIỀN: căn phải · tabular-nums · text-slate-800 · KHÔNG in đậm · BỎ ký tự "đ" trong bảng. */}
                <td className={tdTien}>{fmtMoney(r.amount)}</td>
                <td className={tdChuan + ' whitespace-normal'}><PartyCell acc={r.senderAccountNumber} name={r.senderName} bank={r.senderBank} /></td>
                <td className={tdChuan + ' whitespace-normal'}><PartyCell acc={r.receiverAccountNumber} name={r.receiverName} bank={r.receiverBank} /></td>
                <td className={tdChuan + ' text-center ' + (r.source === 'REPAYMENT' ? 'font-semibold text-danger' : 'text-slate-500')}>{r.source === 'OCR' ? 'OCR' : r.source === 'REPAYMENT' ? 'Hoàn' : 'Tay'}</td>
                <td className={tdChuan + ' text-slate-600'}>{r.note ?? '—'}</td>
                <td className={tdChuan + ' text-center text-slate-500'}>{r.createdByName ?? '—'}</td>
                <td className={tdChuan}><div className="flex justify-center"><IconButton title="Xóa" tone="danger" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton></div></td>
              </tr>
            ))}
            <HangDem soCot={9} />
          </tbody>
          {/* Hàng TỔNG ghim đáy — tổng cộng từ CHÍNH mảng đang hiển thị (`rows`), không lấy nguồn khác. */}
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={2}>TỔNG {rows.length} lần</td>
              <td className={tdTongChuan + ' text-right tabular-nums text-slate-800'}>{fmtMoney(total)}</td>
              <td className={tdTongChuan} colSpan={6} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {del && <ConfirmDialog title="Xóa tạm ứng" message={`Dòng tạm ứng ${fmtMoney(del.amount)}đ (${fmtDate(del.advanceDate)}) sẽ bị xóa. Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
    </div>
  );
}

/** Khu TÀI KHOẢN CK "đi tiền tạm ứng" của NĐT — thêm/xóa STK (cấu hình; khớp OCR bill là phase sau). */
function BankAccountSection({ investorId }: { investorId: number }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<InvestorBankAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountNumber, setAccountNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountHolder, setAccountHolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<InvestorBankAccountDto | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.investorBankAccountList(investorId);
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [investorId]);

  async function add(): Promise<void> {
    if (!accountNumber.trim()) { toast.alert('Nhập số tài khoản.', 'Thiếu thông tin'); return; }
    setBusy(true);
    const res = await window.api.investorBankAccountCreate(investorId, { accountNumber: accountNumber.trim(), bankName: bankName.trim() || null, accountHolder: accountHolder.trim() || null });
    setBusy(false);
    if (res.ok) { toast.success('Đã thêm tài khoản CK'); setAccountNumber(''); setBankName(''); setAccountHolder(''); await reload(); }
    else toast.alert(res.message ?? 'Thêm tài khoản thất bại', 'Không lưu được');
  }
  async function doDelete(a: InvestorBankAccountDto, password?: string): Promise<void> {
    const res = await window.api.investorBankAccountDelete(investorId, a.id, password ?? '');
    if (res.ok) toast.success('Đã xóa tài khoản CK');
    else toast.alert(res.message ?? 'Xóa tài khoản thất bại', 'Xóa thất bại');
    setDel(null);
    await reload();
  }

  return (
    <div>
      <div className="mb-2 text-sm font-semibold text-slate-700">Tài khoản CK tạm ứng</div>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-slate-500">Số tài khoản</label>
          <input className={inputCls} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="STK" />
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-slate-500">Ngân hàng</label>
          <input className={inputCls} value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Tùy chọn" />
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-slate-500">Chủ tài khoản</label>
          <input className={inputCls} value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} placeholder="Tùy chọn" />
        </div>
        <Button data-nut="them" variant="confirm" onClick={add} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}>Thêm TK</Button>
      </div>
      <KhungBang className="max-h-[36vh] bg-white">
        <table className="w-full min-w-[620px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan + ' w-[200px]'}>Số tài khoản</th>
              <th className={thChuan}>Ngân hàng</th>
              <th className={thChuan}>Chủ tài khoản</th>
              <th className={thChuan + ' w-[90px]'}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={4} className={tdTrong}><Loader2 className="mx-auto h-4 w-4 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={4} className={tdTrong}>Chưa có tài khoản CK.</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={r.id} className={trChuan(i)}>
                <td className={tdChuan + ' font-mono font-semibold tabular-nums text-slate-800'}>{r.accountNumber}</td>
                <td className={tdChuan + ' text-slate-600'}>{r.bankName ?? '—'}</td>
                <td className={tdChuan + ' text-slate-600'}>{r.accountHolder ?? '—'}</td>
                <td className={tdChuan}><div className="flex justify-center"><IconButton title="Xóa" tone="danger" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton></div></td>
              </tr>
            ))}
            <HangDem soCot={4} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={4}>TỔNG {rows.length} tài khoản CK</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {del && <ConfirmDialog title="Xóa tài khoản CK" message={`Tài khoản "${del.accountNumber}" sẽ bị xóa. Nhập lại mật khẩu để xác nhận.`} confirmLabel="Xóa" danger requirePassword onCancel={() => setDel(null)} onConfirm={(pwd) => doDelete(del, pwd)} />}
    </div>
  );
}

/** Khu NHÓM CHAT riêng của NĐT (Phase E) — thêm/sửa/xóa nhóm (tên/link/QR/roomId/ghi chú) + bảng. NĐT có nhiều
 *  nhóm TỰ DO (không khóa theo loại phí). Xóa = đóng kỳ (soft). Gắn nhóm vào TK nhận tiền ở màn "TK nhận tiền". */
function ChatGroupSection({ investorId }: { investorId: number }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<InvestorChatGroupDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<number | null>(null); // null = đang THÊM mới; số = đang SỬA nhóm đó
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [roomName, setRoomName] = useState<string | null>(null); // tên phòng đã chọn (hiển thị nút picker; có thể ngoài danh sách trống)
  const [link, setLink] = useState('');
  const [qr, setQr] = useState('');
  const [noteStr, setNoteStr] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<InvestorChatGroupDto | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.investorChatGroupList(investorId);
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [investorId]);

  function resetForm(): void {
    setEditId(null); setName(''); setRoomId(''); setRoomName(null); setLink(''); setQr(''); setNoteStr('');
  }
  function startEdit(g: InvestorChatGroupDto): void {
    setEditId(g.id); setName(g.name ?? ''); setRoomId(g.roomId ?? ''); setRoomName(g.roomName ?? null); setLink(g.link ?? ''); setQr(g.qr ?? ''); setNoteStr(g.note ?? '');
  }

  async function save(): Promise<void> {
    if (!name.trim() && !roomId.trim() && !link.trim()) { toast.alert('Chọn nhóm chat (hoặc nhập link).', 'Thiếu thông tin'); return; }
    setBusy(true);
    const payload = { name: name.trim() || null, roomId: roomId.trim() || null, link: link.trim() || null, qr: qr.trim() || null, note: noteStr.trim() || null };
    const res = editId != null ? await window.api.investorChatGroupUpdate(editId, payload) : await window.api.investorChatGroupCreate(investorId, payload);
    setBusy(false);
    if (res.ok) { toast.success(editId != null ? 'Đã cập nhật nhóm chat' : 'Đã thêm nhóm chat'); resetForm(); await reload(); }
    else toast.alert(res.message ?? 'Lưu nhóm chat thất bại', 'Không lưu được');
  }
  async function doDelete(g: InvestorChatGroupDto): Promise<void> {
    const res = await window.api.investorChatGroupDelete(g.id);
    if (res.ok) toast.success('Đã xóa nhóm chat');
    else toast.alert(res.message ?? 'Xóa nhóm chat thất bại', 'Xóa thất bại');
    setDel(null);
    if (editId === g.id) resetForm();
    await reload();
  }

  return (
    <div>
      <div className="mb-2 text-sm font-semibold text-slate-700">Nhóm chat của nhà đầu tư</div>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <div className="flex-[2] min-w-[16rem]">
          <label className="mb-1 block text-xs text-slate-500">Nhóm chat (SigMa)</label>
          <ChatGroupPicker
            value={roomId || null}
            valueLabel={roomName}
            /* Admin Demo 20/8 — loại các nhóm ĐÃ gán cho dòng khác của CHÍNH NĐT này (backend assertRoomAssignable chặn
               trùng → nếu vẫn hiện & chọn trúng thì "không lưu được"). Giữ lại nhóm ĐANG sửa (roomId) để còn thấy. */
            exclude={rows.map((r) => r.roomId).filter((x): x is string => !!x).filter((id) => id !== roomId)}
            fetchGroups={window.api.investorChatGroupsForPicker}
            onPick={(rid, nm) => { setRoomId(rid ?? ''); setRoomName(nm); setName(nm ?? ''); }}
          />
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-slate-500">Link</label>
          <input className={inputCls} value={link} onChange={(e) => setLink(e.target.value)} placeholder="Tùy chọn" />
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-slate-500">QR</label>
          <input className={inputCls} value={qr} onChange={(e) => setQr(e.target.value)} placeholder="Tùy chọn" />
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-slate-500">Ghi chú</label>
          <input className={inputCls} value={noteStr} onChange={(e) => setNoteStr(e.target.value)} placeholder="Tùy chọn" />
        </div>
        <Button variant="confirm" onClick={save} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}>{editId != null ? 'Lưu nhóm' : 'Thêm nhóm'}</Button>
        {editId != null && <Button variant="neutral" onClick={resetForm} icon={<X className="h-4 w-4" />}>Hủy sửa</Button>}
      </div>
      <KhungBang className="max-h-[36vh] bg-white">
        <table className="w-full min-w-[680px] text-xs">
          <thead className={theadChuan}>
            <tr>
              <th className={thChuan + ' w-[230px]'}>Nhóm chat</th>
              <th className={thChuan}>Link</th>
              <th className={thChuan}>Ghi chú</th>
              <th className={thChuan + ' w-[110px]'}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={4} className={tdTrong}><Loader2 className="mx-auto h-4 w-4 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={4} className={tdTrong}>Chưa có nhóm chat.</td></tr>}
            {!loading && rows.map((g, i) => (
              /* Dòng ĐANG SỬA = nổi bật vàng (trChuan tham số noiBat), các dòng khác sọc ngựa vằn. */
              <tr key={g.id} className={trChuan(i, editId === g.id)}>
                <td className={tdChuan + ' text-slate-600'}>{g.roomName ?? g.name ?? g.roomId ?? '—'}</td>
                <td className={tdChuan + ' max-w-[16rem] truncate text-slate-600'} title={g.link ?? ''}>{g.link ?? '—'}</td>
                <td className={tdChuan + ' text-slate-600'}>{g.note ?? '—'}</td>
                <td className={tdChuan}><div className="flex justify-center gap-1">
                  <IconButton title="Sửa" tone="edit" onClick={() => startEdit(g)}><Pencil className="h-4 w-4" /></IconButton>
                  <IconButton title="Xóa" tone="danger" onClick={() => setDel(g)}><Trash2 className="h-4 w-4" /></IconButton>
                </div></td>
              </tr>
            ))}
            <HangDem soCot={4} />
          </tbody>
          <tfoot className={tfootChuan}>
            <tr className={trTongChuan}>
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={4}>TỔNG {rows.length} nhóm chat</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      {del && <ConfirmDialog title="Xóa nhóm chat" message={`Nhóm chat "${del.name ?? del.roomId ?? del.id}" sẽ bị gỡ khỏi danh sách. Xác nhận xóa?`} confirmLabel="Xóa" danger onCancel={() => setDel(null)} onConfirm={() => doDelete(del)} />}
    </div>
  );
}
