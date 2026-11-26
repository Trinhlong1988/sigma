import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Lock, Unlock, Trash2, ShieldCheck, Loader2, Download, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission } from '@sigma/shared';
import type { RoleDto, PermissionDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { StatusPill, statusLabel, statusTone } from '../components/StatusPill.js';
import { StatBar } from '../components/StatBar.js';
import { Field, inputCls } from '../components/Field.js';
import { exportCsv } from '../lib/exportCsv.js';
// MẪU CHỐT 6/11 — kiểu bảng lấy TỪ MODULE DÙNG CHUNG, cấm chép chuỗi class vào trang.
import { thChuan, tdChuan, trChuan, KhungBang } from '../components/BangChuan.js';

/** SỐ CỘT bảng vai trò — dùng chung cho hàng rỗng / hàng đệm (§1). */
const SO_COT = 6;

export function RolesPage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [assignedTotal, setAssignedTotal] = useState(0); // số nhân sự riêng biệt có ≥1 vai trò (distinct từ backend)
  const [perms, setPerms] = useState<PermissionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RoleDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'lock' | 'unlock' | 'delete'; role: RoleDto } | null>(null);

  const canCreate = hasPermission(user, 'ROLE_CREATE');
  const canUpdate = hasPermission(user, 'ROLE_UPDATE');
  const canLock = hasPermission(user, 'ROLE_LOCK');
  const canUnlock = hasPermission(user, 'ROLE_UNLOCK');
  const canDelete = hasPermission(user, 'ROLE_DELETE');

  async function reload(): Promise<void> {
    setLoading(true);
    const [r, p] = await Promise.all([window.api.roleList(), window.api.rolePermissions()]);
    if (r.ok && r.data) {
      setRoles(r.data);
      setAssignedTotal(r.assignedUserTotal ?? 0); // Admin Demo 11/8: số NHÂN SỰ riêng biệt (backend distinct), không cộng dồn theo vai trò
    } else if (r.message) toast.alert(r.message);
    if (p.ok && p.data) setPerms(p.data);
    setLoading(false);
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doLock(role: RoleDto, lock: boolean): Promise<void> {
    const res = lock ? await window.api.roleLock(role.id) : await window.api.roleUnlock(role.id);
    if (res.ok) toast.success(lock ? `Đã khóa vai trò ${role.name}` : `Đã mở khóa vai trò ${role.name}`);
    else toast.alert(res.message ?? 'Thao tác thất bại');
    setConfirm(null);
    await reload();
  }
  async function doDelete(role: RoleDto, password?: string): Promise<void> {
    const res = await window.api.roleDelete(role.id, password ?? '');
    if (res.ok) toast.success(`Đã xóa vai trò ${role.name}`);
    else toast.alert(res.message ?? 'Không thể xóa vai trò');
    setConfirm(null);
    await reload();
  }

  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Quản lý vai trò</h2>
          <p className="text-sm text-slate-500">Tạo, phân quyền, khóa/mở khóa và xóa vai trò hệ thống.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button data-nut="lammoi" variant="soft" onClick={reload} title="Tải lại dữ liệu mới nhất" icon={<RefreshCw className="h-4 w-4" />}>
            Làm mới
          </Button>
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('vai_tro', ['Vai trò', 'Mã', 'Số quyền', 'Nhân sự', 'Trạng thái'], roles.map((r) => [r.name, r.code, r.permissions.length, r.userCount, statusLabel(r.status)]))}>
            Xuất Excel
          </Button>
          {canCreate && (
            <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Thêm vai trò
            </Button>
          )}
        </div>
      </div>

      {/* Bộ đếm (đếm CLIENT từ roleList — trả full, không phân trang). userCount sẵn trong RoleDto
          dùng cho tổng nhân sự đang gán vai trò. */}
      <StatBar
        items={[
          { label: 'Tổng vai trò', value: roles.length, tone: 'bg-brand-tint text-brand' },
          { label: statusLabel('ACTIVE'), value: roles.filter((r) => r.status === 'ACTIVE').length, tone: statusTone('ACTIVE') },
          { label: statusLabel('LOCKED'), value: roles.filter((r) => r.status === 'LOCKED').length, tone: statusTone('LOCKED') },
          { label: 'Nhân sự đã gán', value: assignedTotal, tone: statusTone('DISABLED') }
        ]}
      />

      {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên. Không cột tiền ⇒ không hàng TỔNG. */}
      <KhungBang>
        <table className="h-full w-full min-w-[920px] text-xs">
          <thead className="sticky top-0 z-20 bg-slate-200">
            <tr>
              <th className={thChuan + ' w-[320px]'}>Vai trò</th>
              <th className={thChuan + ' w-[160px]'}>Mã</th>
              <th className={thChuan + ' w-[110px]'}>Quyền</th>
              <th className={thChuan + ' w-[100px]'}>Nhân sự</th>
              <th className={thChuan + ' w-[120px]'}>Trạng thái</th>
              <th className={thChuan + ' w-[150px]'}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={SO_COT} className="px-4 py-8 text-center text-slate-400">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            )}
            {!loading && roles.length === 0 && (
              <tr>
                <td colSpan={SO_COT} className="px-4 py-10 text-center text-slate-400">
                  <ShieldCheck className="mx-auto mb-2 h-6 w-6" /> Chưa có vai trò.
                </td>
              </tr>
            )}
            {!loading &&
              roles.map((r, i) => (
                <tr key={r.id} className={trChuan(i)}>
                  <td className={tdChuan + ' whitespace-normal'}>
                    <div className="flex items-center gap-2 font-medium text-slate-800">
                      <ShieldCheck className="h-4 w-4 text-brand" />
                      {r.name}
                      {r.isSystem && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">
                          hệ thống
                        </span>
                      )}
                    </div>
                    {r.description && <div className="text-slate-400">{r.description}</div>}
                  </td>
                  <td className={tdChuan + ' font-mono text-slate-500'}>{r.code}</td>
                  {/* 2 cột SỐ — căn phải + tabular-nums, cùng cỡ chữ 12px (§2). */}
                  <td className={tdChuan + ' text-right tabular-nums text-slate-600'}>{r.permissions.length} quyền</td>
                  <td className={tdChuan + ' text-right tabular-nums text-slate-600'}>{r.userCount}</td>
                  <td className={tdChuan + ' text-center'}>
                    <StatusPill status={r.status} />
                  </td>
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      {canUpdate && (
                        <IconButton title="Sửa" tone="edit" onClick={() => setEditing(r)}>
                          <Pencil className="h-4 w-4" />
                        </IconButton>
                      )}
                      {r.status === 'ACTIVE' && canLock && (
                        <IconButton title="Khóa" onClick={() => setConfirm({ kind: 'lock', role: r })}>
                          <Lock className="h-4 w-4" />
                        </IconButton>
                      )}
                      {r.status === 'LOCKED' && canUnlock && (
                        <IconButton title="Mở khóa" onClick={() => setConfirm({ kind: 'unlock', role: r })}>
                          <Unlock className="h-4 w-4" />
                        </IconButton>
                      )}
                      {canDelete && (
                        <IconButton title="Xóa" tone="danger" onClick={() => setConfirm({ kind: 'delete', role: r })}>
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            {/* HÀNG ĐỆM (§1). */}
            <tr aria-hidden className="h-full"><td colSpan={SO_COT} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>

      {(creating || editing) && (
        <RoleForm
          role={editing}
          allPerms={perms}
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
          title="Khóa vai trò"
          message={`Bạn có chắc muốn khóa vai trò "${confirm.role.name}"? Người dùng thuộc vai trò này sẽ mất quyền tương ứng.`}
          confirmLabel="Khóa"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => doLock(confirm.role, true)}
        />
      )}
      {confirm?.kind === 'unlock' && (
        <ConfirmDialog
          title="Mở khóa vai trò"
          message={`Mở khóa vai trò "${confirm.role.name}"?`}
          confirmLabel="Mở khóa"
          onCancel={() => setConfirm(null)}
          onConfirm={() => doLock(confirm.role, false)}
        />
      )}
      {confirm?.kind === 'delete' && (
        <ConfirmDialog
          title="Xóa vai trò"
          message={`Bạn đang xóa vai trò "${confirm.role.name}". Không thể xóa nếu vai trò đang có nhân sự sử dụng. Vui lòng nhập lại mật khẩu.`}
          confirmLabel="Xóa"
          danger
          requirePassword
          onCancel={() => setConfirm(null)}
          onConfirm={(pwd) => doDelete(confirm.role, pwd)}
        />
      )}
    </div>
  );
}

function RoleForm({
  role,
  allPerms,
  onClose,
  onSaved
}: {
  role: RoleDto | null;
  allPerms: PermissionDto[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const toast = useToast();
  const editing = !!role;
  const [name, setName] = useState(role?.name ?? '');
  const [code, setCode] = useState(role?.code ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [status, setStatus] = useState(role?.status ?? 'ACTIVE');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(false);

  const groups = useMemo(() => {
    const g: Record<string, PermissionDto[]> = {};
    for (const p of allPerms) {
      const key = p.group ?? 'KHÁC';
      (g[key] ??= []).push(p);
    }
    return g;
  }, [allPerms]);

  function toggle(codeStr: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(codeStr)) next.delete(codeStr);
      else next.add(codeStr);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (!name.trim()) {
      toast.alert('Tên vai trò bắt buộc.');
      return;
    }
    setBusy(true);
    const input = {
      name: name.trim(),
      code: code.trim(),
      description: description.trim(),
      status,
      permissionCodes: [...selected]
    };
    const res = editing ? await window.api.roleUpdate(role!.id, { ...input, expectedUpdatedAt: role!.updatedAt }) : await window.api.roleCreate(input);
    setBusy(false);
    setPendingConfirm(false);
    if (res.ok) {
      toast.success(editing ? `Đã cập nhật vai trò ${name}` : `Đã tạo vai trò ${name}`);
      onSaved();
    } else if (isStaleWrite(res)) {
      toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE);
      onSaved();
    } else {
      toast.alert(res.message ?? 'Lưu vai trò thất bại');
    }
  }

  return (
    <>
      <Modal title={editing ? 'Sửa vai trò' : 'Thêm vai trò mới'} onClose={onClose} width="max-w-2xl" onSubmit={() => (editing ? setPendingConfirm(true) : void save())}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Tên vai trò" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing" />
          </Field>
          <Field label="Mã vai trò" required hint="CHỮ HOA, số, gạch dưới — không dấu">
            <input
              className={inputCls + (editing ? ' bg-appbg text-slate-400' : '')}
              value={code}
              disabled={editing}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="MARKETING"
            />
          </Field>
          <Field label="Mô tả">
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Trạng thái" required>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="ACTIVE">Hoạt động</option>
              <option value="LOCKED">Khóa</option>
            </select>
          </Field>
        </div>

        <div className="mt-5">
          <div className="mb-2 text-sm font-medium text-slate-700">Phân quyền</div>
          <div className="space-y-3">
            {Object.entries(groups).map(([group, list]) => (
              <div key={group} className="rounded-lg border border-line p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{group}</div>
                <div className="grid grid-cols-2 gap-2">
                  {list.map((p) => (
                    <label key={p.code} className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                      <input
                        type="checkbox"
                        checked={selected.has(p.code)}
                        onChange={() => toggle(p.code)}
                        className="h-4 w-4 accent-brand"
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

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
            {editing ? 'Lưu thay đổi' : 'Tạo vai trò'}
          </Button>
        </div>
      </Modal>

      {/* R_ROLE_010: sửa vai trò → popup xác nhận Có/Hủy */}
      {pendingConfirm && (
        <ConfirmDialog
          title="Xác nhận thay đổi"
          message="Bạn có chắc muốn lưu thay đổi cho vai trò này?"
          confirmLabel="Đồng ý"
          onCancel={() => setPendingConfirm(false)}
          onConfirm={save}
        />
      )}
    </>
  );
}
