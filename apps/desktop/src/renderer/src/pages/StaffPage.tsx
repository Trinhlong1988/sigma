import { useEffect, useState, useRef } from 'react';
import { Plus, Pencil, Lock, Unlock, Trash2, Loader2, Users, KeyRound, Download } from 'lucide-react';
import { AdminResetPasswordModal } from '../components/AdminResetPasswordModal.js';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, roleLabel, ROLES } from '@sigma/shared';
import type { UserDto, RoleDto, InvestorDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { RequestCancelModal, type RequestCancelTarget } from '../components/RequestCancelModal.js';
import { StatusPill, statusLabel, statusTone } from '../components/StatusPill.js';
import { StatBar } from '../components/StatBar.js';
import { StaleBanner } from '../lib/realtime.js';
import { RoleBadge } from '../components/RoleBadge.js';
import { Field, inputCls } from '../components/Field.js';
import { PasswordInput } from '../components/PasswordInput.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { exportCsv } from '../lib/exportCsv.js';
import { useRowSelection } from '../components/Selection.js';
import { FilterBar } from '../components/FilterBar.js';
import { thChuan, tdChuan, trChuan, KhungBang } from '../components/BangChuan.js';

const STATUSES = ['ACTIVE', 'PENDING', 'LOCKED', 'DISABLED', 'DELETED'];

/** MẪU CHỐT 6/11: trang nằm trong `<main overflow-auto>` nên khung bảng phải KHÓA chiều cao để
 *  `overflow-auto` tạo khung cuộn thật — nhờ đó tiêu đề `sticky top-0` ghim TRONG bảng.
 *  15rem = giữ đúng chiều cao cũ của `.list-scroll`. */
const CAO_KHUNG = 'max-h-[calc(100vh-15rem)] bg-white shadow-sm';

export function StaffPage({ user, initialRole }: { user: AuthUser; initialRole?: string }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<UserDto[]>([]);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState(initialRole ?? '');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'lock' | 'unlock'; u: UserDto } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<RequestCancelTarget | null>(null);
  const [resetTarget, setResetTarget] = useState<UserDto | null>(null);
  const sel = useRowSelection(); // Admin Demo 15/7 — tích chọn nhiều nhân sự để yêu cầu hủy hàng loạt
  const [bulkBusy, setBulkBusy] = useState(false);
  // KHÔNG cho chọn: tài khoản đang đăng nhập (self) — chống tự-xóa. Backend còn chặn Admin cuối cùng.
  const selectableIds = rows.filter((u) => u.id !== user.id && u.status !== 'DELETED').map((u) => u.id);

  async function doBulkCancel(): Promise<void> {
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    const okc = await toast.confirm(
      `Yêu cầu hủy ${ids.length} nhân sự đã chọn? Mỗi người tạo 1 yêu cầu hủy (chờ duyệt). Không gồm tài khoản của bạn; Admin cuối cùng sẽ bị backend từ chối.`,
      { title: 'Yêu cầu hủy hàng loạt', okLabel: `Tạo ${ids.length} yêu cầu`, cancelLabel: 'Hủy' }
    );
    if (!okc) return;
    setBulkBusy(true);
    let done = 0;
    const failed: string[] = [];
    for (const id of ids) {
      const res = await window.api.entityCancelRequest('User', id, 'Yêu cầu hủy hàng loạt');
      if (res.ok) done++;
      else failed.push(`#${id}: ${res.message ?? res.error}`);
    }
    setBulkBusy(false);
    sel.clear();
    await reload();
    if (failed.length) toast.alert(`Đã tạo ${done} yêu cầu. Bỏ qua ${failed.length}:\n${failed.slice(0, 8).join('\n')}`, 'Kết quả hàng loạt');
    else toast.success(`Đã tạo ${done} yêu cầu hủy — chờ duyệt.`);
  }

  const canCreate = hasPermission(user, 'USER_CREATE') || hasPermission(user, 'USER_CREATE_LIMITED');
  const canUpdate = hasPermission(user, 'USER_UPDATE');
  const canLock = hasPermission(user, 'USER_LOCK');
  const canUnlock = hasPermission(user, 'USER_UNLOCK');
  const canCancelReq = hasPermission(user, 'USER_CANCEL_REQUEST');
  const canReset = hasPermission(user, 'USER_RESET_PASSWORD');

  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    sel.clear(); // audit 15/7 — dọn lựa chọn cũ khi lọc/tải lại để không hủy nhầm hàng đã ẩn
    try {
      const res = await window.api.userList({ roleCode: roleFilter || undefined, status: statusFilter || undefined, search: search || undefined });
      if (res.ok && res.data) setRows(res.data);
      else if (res.message) toast.alert(res.message);
    } catch (e) {
      // FE-03 (Codex 15/7): IPC reject không được để spinner treo mãi.
      toast.alert(e instanceof Error ? e.message : 'Không tải được dữ liệu (mất kết nối máy chủ?).', 'Lỗi tải dữ liệu');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleFilter, statusFilter]);
  useEffect(() => {
    window.api.roleList().then((r) => {
      if (r.ok && r.data) setRoles(r.data);
    });
  }, []);

  async function doLock(u: UserDto, lock: boolean): Promise<void> {
    const res = lock ? await window.api.userLock(u.id) : await window.api.userUnlock(u.id);
    if (res.ok) toast.success(lock ? `Đã khóa tài khoản ${u.username}` : `Đã mở khóa ${u.username}`);
    else toast.alert(res.message ?? 'Thao tác thất bại', 'Thao tác thất bại');
    setConfirm(null);
    await reload();
  }
  function resetFilters(): void {
    setSearch('');
    setRoleFilter('');
    setStatusFilter('');
    setTimeout(() => reloadRef.current(), 0);
  }

  const roleOptions = mergeRoles(roles);
  // Số cột THẬT: ô tích (nếu được yêu cầu hủy) + 7 cột dữ liệu. Hàng rỗng / hàng đệm dùng đúng số này.
  const soCot = 7 + (canCancelReq ? 1 : 0);

  return (
    // MẪU CHỐT 6/11: `data-nut-vuong` ở thẻ bọc NGOÀI CÙNG để trang ăn luật nút/thanh cuộn/màu của mau-moi.css.
    <div data-nut-vuong data-trang-full>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Quản lý danh sách nhân sự</h2>
          <p className="text-sm text-slate-500">Sổ nhân sự theo từng vai trò, trạng thái — có tìm kiếm & lọc.</p>
        </div>
        <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('nhan_su', ['Mã NV', 'Họ tên', 'Tên đăng nhập', 'Số điện thoại', 'Vai trò', 'Trạng thái'], rows.map((u) => [u.employeeCode ?? '', u.fullName, u.username, u.phone ?? '', u.roles.map(roleLabel).join(' | '), statusLabel(u.status)]))}>
            Xuất Excel
          </Button>
          {canCreate && (
            <Button data-nut="them" variant="confirm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Thêm nhân sự
            </Button>
          )}
        </div>
      </div>

      {/* Bộ đếm (đếm CLIENT từ danh sách đã tải — userList trả full, không phân trang;
          phản ánh đúng tập kết quả theo bộ lọc hiện tại). */}
      <StatBar
        items={[
          { label: 'Tổng nhân sự', value: rows.length, tone: 'bg-brand-tint text-brand' },
          { label: statusLabel('ACTIVE'), value: rows.filter((u) => u.status === 'ACTIVE').length, tone: statusTone('ACTIVE') },
          { label: statusLabel('LOCKED'), value: rows.filter((u) => u.status === 'LOCKED').length, tone: statusTone('LOCKED') },
          { label: 'Chờ/Ngưng', value: rows.filter((u) => u.status === 'PENDING' || u.status === 'DISABLED').length, tone: statusTone('PENDING') }
        ]}
      />

      {/* THANH LỌC dùng chung FilterBar (mẫu chốt 6/11 §4): 1 hàng · cỡ chữ nhỏ (coChuNho) · nút Lọc căn
          mép phải (locPhai) · Xóa lọc + Làm mới do chính FilterBar dựng (1 nguồn, không mỗi trang 1 kiểu).
          `debounceMs={0}`: GIỮ NGUYÊN hành vi cũ — chỉ gọi máy chủ khi Enter / bấm Lọc (đợt này chỉ đồng bộ
          giao diện, không đổi số lượt gọi API). */}
      <FilterBar
        coChuNho
        locPhai
        debounceMs={0}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Tìm tên, tên đăng nhập, email, Số điện thoại…"
        selects={[
          { key: 'vaitro', placeholder: 'Tất cả vai trò', value: roleFilter, options: roleOptions.map((r) => ({ value: r.code, label: r.name })), onChange: setRoleFilter },
          { key: 'trangthai', placeholder: 'Tất cả trạng thái', value: statusFilter, options: STATUSES.map((s) => ({ value: s, label: statusLabel(s) })), onChange: setStatusFilter }
        ]}
        onApply={() => void reload()}
        onReset={resetFilters}
        onRefresh={() => void reload()}
      />

      <StaleBanner domain="User" onReload={reload} className="mb-2" />

      {canCancelReq && sel.count > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-tint px-4 py-2.5">
          <span className="text-sm font-medium text-brand">Đã chọn {sel.count} nhân sự</span>
          <div className="flex-1" />
          <Button variant="neutral" onClick={sel.clear}>Bỏ chọn tất cả</Button>
          <Button variant="danger" disabled={bulkBusy} onClick={doBulkCancel}>Yêu cầu hủy đã chọn ({sel.count})</Button>
        </div>
      )}
      <KhungBang className={CAO_KHUNG}>
        {/* min-w: thiếu chỗ thì CUỘN NGANG, tuyệt đối KHÔNG ẩn cột theo breakpoint (mẫu chốt 6/11 §1). */}
        <table className="w-full min-w-[1320px] text-xs">
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              {canCancelReq && (
                <th className={thChuan + ' w-9 !px-1.5'}>
                  <input
                    type="checkbox"
                    className="accent-brand"
                    aria-label="Chọn tất cả"
                    checked={selectableIds.length > 0 && selectableIds.every((id) => sel.isSelected(id))}
                    onChange={(e) => sel.setAll(selectableIds, e.target.checked)}
                  />
                </th>
              )}
              <th className={thChuan + ' w-[160px]'}>Mã NV</th>
              <th className={thChuan + ' w-[340px]'}>Nhân sự</th>
              <th className={thChuan + ' w-[150px]'}>Tên đăng nhập</th>
              <th className={thChuan + ' w-[120px]'}>Liên hệ</th>
              <th className={thChuan + ' w-[260px]'}>Vai trò</th>
              <th className={thChuan + ' w-[130px]'}>Trạng thái</th>
              <th className={thChuan + ' w-[180px]'}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={soCot} className="px-4 py-8 text-center text-slate-400">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={soCot} className="px-4 py-10 text-center text-sm text-slate-400">
                  <Users className="mx-auto mb-2 h-6 w-6" />
                  Không có nhân sự phù hợp bộ lọc.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((u, i) => (
                // SỌC NGỰA VẰN dùng chung `trChuan(i)`; dòng ĐANG TÍCH tô sáng (tham số noiBat).
                <tr key={u.id} className={trChuan(i, sel.isSelected(u.id))}>
                  {canCancelReq && (u.id === user.id || u.status === 'DELETED'
                    ? <td className={tdChuan + ' !px-1.5 text-center'} title="Không thể chọn tài khoản này"><span className="text-slate-300">—</span></td>
                    : (
                      <td className={tdChuan + ' !px-1.5 text-center'}>
                        <input type="checkbox" className="accent-brand" checked={sel.isSelected(u.id)} aria-label={`Chọn dòng ${u.id}`} onChange={() => sel.toggle(u.id)} />
                      </td>
                    ))}
                  <td className={tdChuan}>
                    <div className="flex items-center justify-center gap-1.5">
                      <span className="font-mono font-semibold text-brand">{u.employeeCode ?? '—'}</span>
                      <RoleBadge roles={u.roles} />
                    </div>
                  </td>
                  <td className={tdChuan}>
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-tint font-semibold text-brand">
                        {u.fullName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-800">{u.fullName}</div>
                        {u.email && <div className="truncate text-slate-400">{u.email}</div>}
                      </div>
                    </div>
                  </td>
                  <td className={tdChuan + ' text-center font-mono text-slate-500'}>{u.username}</td>
                  <td className={tdChuan + ' text-center tabular-nums text-slate-600'}>{u.phone ?? '—'}</td>
                  <td className={tdChuan}>
                    <div className="flex flex-wrap justify-center gap-1">
                      {u.roles.map((c) => (
                        <span key={c} className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                          {roleLabel(c)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className={tdChuan + ' text-center'}>
                    <StatusPill status={u.status} />
                  </td>
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      {canUpdate && u.status !== 'DELETED' && (
                        <IconButton title="Sửa" tone="edit" onClick={() => setEditing(u)}>
                          <Pencil className="h-4 w-4" />
                        </IconButton>
                      )}
                      {u.status === 'ACTIVE' && canLock && (
                        <IconButton title="Khóa" onClick={() => setConfirm({ kind: 'lock', u })}>
                          <Lock className="h-4 w-4" />
                        </IconButton>
                      )}
                      {u.status === 'LOCKED' && canUnlock && (
                        <IconButton title="Mở khóa" onClick={() => setConfirm({ kind: 'unlock', u })}>
                          <Unlock className="h-4 w-4" />
                        </IconButton>
                      )}
                      {canReset && u.status !== 'DELETED' && (
                        <IconButton title="Đặt lại mật khẩu" tone="edit" onClick={() => setResetTarget(u)}>
                          <KeyRound className="h-4 w-4" />
                        </IconButton>
                      )}
                      {canCancelReq && u.status !== 'DELETED' && (
                        <IconButton
                          title="Yêu cầu hủy"
                          tone="danger"
                          onClick={() => setCancelTarget({ entityType: 'User', entityId: u.id, entityLabel: u.username, typeLabel: 'nhân sự' })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            {/* HÀNG ĐỆM (mẫu chốt 6/11 §1): chừa 1 hàng để dòng cuối không bị che khi cuộn tới đáy. */}
            <tr aria-hidden><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>

      {(creating || editing) && (
        <StaffForm
          actor={user}
          target={editing}
          roleOptions={roleOptions}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await reload();
          }}
        />
      )}

      {confirm?.kind === 'lock' && (
        <ConfirmDialog
          title="Khóa tài khoản"
          message={`Bạn có chắc muốn khóa tài khoản "${confirm.u.username}"?`}
          confirmLabel="Khóa"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => doLock(confirm.u, true)}
        />
      )}
      {confirm?.kind === 'unlock' && (
        <ConfirmDialog
          title="Mở khóa tài khoản"
          message={`Mở khóa tài khoản "${confirm.u.username}"?`}
          confirmLabel="Mở khóa"
          onCancel={() => setConfirm(null)}
          onConfirm={() => doLock(confirm.u, false)}
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
      {resetTarget && (
        <AdminResetPasswordModal
          target={{ id: resetTarget.id, fullName: resetTarget.fullName, username: resetTarget.username }}
          onClose={() => setResetTarget(null)}
          onDone={reload}
        />
      )}
    </div>
  );
}

/** Merge static system roles with fetched custom roles (dedupe by code). */
function mergeRoles(fetched: RoleDto[]): { code: string; name: string }[] {
  const map = new Map<string, { code: string; name: string }>();
  for (const r of ROLES) map.set(r.code, { code: r.code, name: r.name });
  for (const r of fetched) map.set(r.code, { code: r.code, name: r.name });
  return [...map.values()];
}

function StaffForm({
  actor,
  target,
  roleOptions,
  onClose,
  onSaved
}: {
  actor: AuthUser;
  target: UserDto | null;
  roleOptions: { code: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const toast = useToast();
  const editing = !!target;
  const [fullName, setFullName] = useState(target?.fullName ?? '');
  const [birthDate, setBirthDate] = useState(target?.birthDate ? target.birthDate.slice(0, 10) : '');
  const [gender, setGender] = useState(target?.gender ?? '');
  const [phone, setPhone] = useState(target?.phone ?? '');
  const [email, setEmail] = useState(target?.email ?? '');
  const [address, setAddress] = useState(target?.address ?? '');
  const [joinDate, setJoinDate] = useState(target?.joinedAt ? target.joinedAt.slice(0, 10) : '');
  const [username, setUsername] = useState(target?.username ?? '');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState(target?.status ?? 'ACTIVE');
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set(target?.roles ?? []));
  // Hợp nhất NĐT (Admin Demo 11/8) — CHỈ chế độ TẠO: tích "Nhà đầu tư" → tạo luôn hồ sơ NĐT + role R_INVESTOR, nhập
  // % phí đầu tư (mặc định 0.1). Sửa nhân sự KHÔNG hiện (đổi hồ sơ NĐT ở tab Nhà đầu tư).
  const [isInvestor, setIsInvestor] = useState(false);
  // [B206 19/11 — Admin Demo "thêm quyền hoàn tiền, chỉ ai được tích hoàn tiền mới hiện ở danh sách người"]
  const [duocHoanTien, setDuocHoanTien] = useState<boolean>(!!target?.canRefund);
  const [investFeePct, setInvestFeePct] = useState('0.1');
  // [KẾ TOÁN NĐT 24/11 — VIỆC 2] Gán 1 NĐT cho vai R_KETOAN_NDT (BẮT BUỘC khi chọn vai này). Prefill từ target khi sửa.
  const [scopeInvestorId, setScopeInvestorId] = useState<string>(target?.scopeInvestorId != null ? String(target.scopeInvestorId) : '');
  const [investors, setInvestors] = useState<InvestorDto[]>([]);
  const laKeToanNdt = selectedRoles.has('R_KETOAN_NDT');
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(false);

  // [KẾ TOÁN NĐT 24/11] Khi chọn vai Kế toán NĐT → nạp danh sách NĐT (1 lần) để xổ dropdown gán phạm vi.
  useEffect(() => {
    if (!laKeToanNdt || investors.length > 0) return;
    void window.api.investorList({}).then((r) => { if (r.ok && r.data) setInvestors(r.data); });
  }, [laKeToanNdt, investors.length]);

  // Manager cannot assign ADMIN/MANAGER (R_MANAGER_002/003) — hide those options for non-admin.
  const isAdmin = actor.roles.includes('ADMIN');
  const assignable = roleOptions.filter((r) => isAdmin || (r.code !== 'ADMIN' && r.code !== 'MANAGER'));

  function toggleRole(code: string): void {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (!fullName.trim()) return toast.alert('Họ và tên bắt buộc.');
    if (selectedRoles.size === 0 && !isInvestor) return toast.alert('Phải chọn ít nhất 1 vai trò.');
    // [KẾ TOÁN NĐT 24/11] BẮT BUỘC gán NĐT khi chọn vai Kế toán NĐT (nếu không, backend chặn SCOPE_REQUIRED và
    // user sẽ bị gate chặn sạch — "kẹt"). Chặn ngay ở UI cho rõ.
    if (laKeToanNdt && !scopeInvestorId) return toast.alert('Vai Kế toán NĐT phải được gán 1 nhà đầu tư — hãy chọn nhà đầu tư ở ô bên dưới.');
    // Tích NĐT: % phí đầu tư phải là số ≥ 0 (backend còn cap trần 100%). Trống → 0.
    let feeNum = 0;
    if (!editing && isInvestor) {
      feeNum = investFeePct.trim() === '' ? 0 : Number(investFeePct);
      if (!Number.isFinite(feeNum) || feeNum < 0) return toast.alert('% phí đầu tư không hợp lệ — nhập số ≥ 0 (ví dụ 0.1).');
    }
    setBusy(true);
    let res;
    if (editing) {
      res = await window.api.userUpdate(target!.id, {
        fullName: fullName.trim(),
        birthDate: birthDate || null,
        gender: gender || null,
        phone: phone || null,
        email: email || null,
        address: address || null,
        joinDate: joinDate || null,
        status,
        roleCodes: [...selectedRoles],
        canRefund: duocHoanTien,
        // [KẾ TOÁN NĐT] gửi NĐT gán khi vai Kế toán NĐT; vai khác → null (backend tự gỡ phạm vi).
        scopeInvestorId: laKeToanNdt ? Number(scopeInvestorId) : null,
        expectedUpdatedAt: target!.updatedAt
      });
    } else {
      res = await window.api.userCreate({
        fullName: fullName.trim(),
        birthDate: birthDate || null,
        gender: gender || null,
        phone: phone || null,
        email: email || null,
        address: address || null,
        joinDate: joinDate || null,
        username: username.trim(),
        password,
        status,
        roleCodes: [...selectedRoles],
        // Hợp nhất NĐT — backend tự thêm role R_INVESTOR + tạo hồ sơ NĐT khi investor=true.
        investor: isInvestor,
        investFeePct: isInvestor ? feeNum : null,
        // [KẾ TOÁN NĐT] gửi NĐT gán khi vai Kế toán NĐT.
        scopeInvestorId: laKeToanNdt ? Number(scopeInvestorId) : null
      });
    }
    setBusy(false);
    setPendingConfirm(false);
    if (res.ok) {
      toast.success(editing ? `Đã cập nhật ${fullName}` : `Đã tạo nhân sự ${fullName}`);
      onSaved();
    } else if (isStaleWrite(res)) {
      toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE);
      onSaved();
    } else {
      toast.alert(res.message ?? 'Lưu nhân sự thất bại');
    }
  }

  return (
    <>
      <Modal title={editing ? 'Sửa thông tin nhân sự' : 'Thêm nhân sự mới'} onClose={onClose} width="max-w-2xl" onSubmit={() => (editing ? setPendingConfirm(true) : void save())}>
        {editing ? (
          <div className="mb-3 rounded-md bg-brand-tint px-3 py-2 text-sm text-brand">
            Mã nhân viên: <span className="font-mono font-semibold">{target!.employeeCode ?? '—'}</span> (tự sinh, không đổi)
          </div>
        ) : (
          <div className="mb-3 rounded-md bg-appbg px-3 py-2 text-sm text-slate-500">Mã nhân viên (NV##) sẽ được tự sinh khi tạo.</div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Họ và tên" required>
            <input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label="Ngày sinh">
            <input type="date" className={inputCls} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
          </Field>
          <Field label="Giới tính">
            <select className={inputCls} value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="">—</option>
              <option value="Nam">Nam</option>
              <option value="Nữ">Nữ</option>
              <option value="Khác">Khác</option>
            </select>
          </Field>
          <Field label="Số điện thoại" required>
            <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Email" required hint="Không được trùng">
            <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Địa chỉ">
            <input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label="Tên đăng nhập" required hint="≥8 ký tự, chỉ A-Z a-z 0-9">
            <input
              className={inputCls + (editing ? ' bg-appbg text-slate-400' : '')}
              value={username}
              disabled={editing}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          {!editing && (
            <Field label="Mật khẩu" required hint="≥8 ký tự, gồm chữ và số">
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          )}
          <Field label="Ngày vào làm">
            <input type="date" className={inputCls} value={joinDate} onChange={(e) => setJoinDate(e.target.value)} />
          </Field>
          <Field label="Trạng thái" required>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="ACTIVE">Hoạt động</option>
              <option value="PENDING">Chờ kích hoạt</option>
              {editing && <option value="DISABLED">Ngưng dùng</option>}
            </select>
          </Field>
        </div>

        <div className="mt-5">
          <div className="mb-2 text-sm font-medium text-slate-700">
            Vai trò <span className="text-danger">*</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {assignable.map((r) => (
              <label key={r.code} className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-slate-600 hover:bg-appbg">
                <input
                  type="checkbox"
                  checked={selectedRoles.has(r.code)}
                  onChange={() => toggleRole(r.code)}
                  className="h-4 w-4 accent-brand"
                />
                {r.name}
              </label>
            ))}
          </div>
        </div>

        {/* [KẾ TOÁN NĐT 24/11 — VIỆC 2] Chọn vai Kế toán NĐT → BẮT BUỘC gán đúng 1 nhà đầu tư (phạm vi khóa).
            Lưu users.scope_investor_id ở backend; gate deny-by-default chặn user nếu chưa gán. */}
        {laKeToanNdt && (
          <div className="mt-5 rounded-lg border border-brand/30 bg-brand-tint/40 p-3">
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Nhà đầu tư phụ trách <span className="text-danger">*</span>
              <span className="ml-1 font-normal text-slate-400">— Kế toán NĐT chỉ thấy/nhập dữ liệu của đúng nhà đầu tư này</span>
            </label>
            <select
              data-nut="scope-ndt"
              className={inputCls}
              value={scopeInvestorId}
              onChange={(e) => setScopeInvestorId(e.target.value)}
            >
              <option value="">— Chọn nhà đầu tư —</option>
              {investors.map((iv) => (
                <option key={iv.id} value={String(iv.id)}>
                  {(iv.nickname || iv.fullName) + ' · ' + iv.code}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* [B206] QUYỀN HOÀN TIỀN — hiện ở CẢ chế độ sửa (khác ô "Nhà đầu tư" chỉ có lúc tạo): ô "Người hoàn"
            ở màn nhập bill nay CHỈ liệt kê những người được tích ở đây, không còn lấy theo vai trò. */}
        {editing && (
          <div className="mt-5 rounded-lg border border-line bg-appbg/50 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                data-nut="duochoantien"
                checked={duocHoanTien}
                onChange={(e) => setDuocHoanTien(e.target.checked)}
                className="h-4 w-4 accent-brand"
              />
              Được hoàn tiền
              <span className="font-normal text-slate-400">— chỉ người được tích mới hiện trong ô &quot;Người hoàn&quot; khi nhập bill</span>
            </label>
          </div>
        )}

        {!editing && (
          <div className="mt-5 rounded-lg border border-line bg-appbg/50 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={isInvestor}
                onChange={(e) => setIsInvestor(e.target.checked)}
                className="h-4 w-4 accent-brand"
              />
              Nhà đầu tư
              <span className="font-normal text-slate-400">— tạo luôn hồ sơ nhà đầu tư gắn tài khoản này (thêm vai trò Nhà đầu tư)</span>
            </label>
            {isInvestor && (
              <div className="mt-3 max-w-[16rem]">
                <label className="mb-1 block text-xs text-slate-500">% phí đầu tư <span className="text-slate-400">(0 hoặc 0.1…)</span></label>
                <input
                  className={inputCls + ' text-right'}
                  inputMode="decimal"
                  value={investFeePct}
                  onChange={(e) => setInvestFeePct(e.target.value)}
                  placeholder="0.1"
                />
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="soft" onClick={onClose}>
            Hủy
          </Button>
          <Button
            variant="confirm"
            onClick={() => (editing ? setPendingConfirm(true) : save())}
            disabled={busy}
            icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
          >
            {editing ? 'Lưu thay đổi' : 'Tạo nhân sự'}
          </Button>
        </div>
      </Modal>

      {pendingConfirm && (
        <ConfirmDialog
          title="Xác nhận thay đổi"
          message="Bạn có chắc muốn lưu thay đổi cho nhân sự này?"
          confirmLabel="Đồng ý"
          onCancel={() => setPendingConfirm(false)}
          onConfirm={save}
        />
      )}
    </>
  );
}
