import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Loader2, UserRound, Download } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission } from '@sigma/shared';
import type { CustomerDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { isStaleWrite, STALE_TITLE } from '../lib/optlock.js';
import { Modal } from '../components/Modal.js';
import { RequestCancelModal, type RequestCancelTarget } from '../components/RequestCancelModal.js';
import { Field, inputCls } from '../components/Field.js';
import { FilterBar } from '../components/FilterBar.js';
import { StatBar } from '../components/StatBar.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { StaleBanner } from '../lib/realtime.js';
import { CanhBaoCatDanhSach } from '../components/CanhBaoCatDanhSach.js';
import { ImportButton } from '../components/ImportModal.js';
import { StatusBadge, useStatusOptions, statusSelectOptions, toneCls } from '../components/StatusBadge.js';
import { exportCsv } from '../lib/exportCsv.js';
import { useRowSelection, SelectAllCell, SelectCell } from '../components/Selection.js';
import { ChatGroupsSection, type ChatGroupRow } from '../components/ChatGroupsSection.js';
// MẪU CHỐT 6/11 — kiểu bảng lấy TỪ MODULE DÙNG CHUNG, cấm chép chuỗi class vào trang.
import { thChuan, tdChuan, trChuan, KhungBang } from '../components/BangChuan.js';

// Bộ đếm TOÀN CỤC (độc lập bộ lọc list) cho dash StatBar — khớp shape countCustomers ở main.
type CustomerCounts = { total: number; active: number; locked: number; cancelled: number };

/** Khách hàng (§D): hiển thị `KH## · biệt danh (tên thật)` + Số điện thoại. Mã tự sinh, nickname bắt buộc. */
export function CustomersPage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const { options: statusOptions } = useStatusOptions('CUSTOMER');
  const [rows, setRows] = useState<CustomerDto[]>([]);
  const [tongDs, setTongDs] = useState<number | null>(null); // [B331] tổng thật trong bộ lọc (để cảnh báo cắt)
  const [counts, setCounts] = useState<CustomerCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CustomerDto | null>(null);
  const [cancelTarget, setCancelTarget] = useState<RequestCancelTarget | null>(null);
  const sel = useRowSelection(); // Admin Demo 15/7 — tích chọn nhiều khách để yêu cầu hủy hàng loạt
  const [bulkBusy, setBulkBusy] = useState(false);

  const canCreate = hasPermission(user, 'CUSTOMER_CREATE');
  const canUpdate = hasPermission(user, 'CUSTOMER_UPDATE');
  const canCancelReq = hasPermission(user, 'CUSTOMER_CANCEL_REQUEST');

  /** Yêu cầu hủy HÀNG LOẠT các khách đã tích: mỗi id gọi entityCancelRequest (backend re-check quyền + guard quan hệ
   *  sống từng ID). Tổng hợp thành công/thất bại từng cái — KHÔNG báo thành công toàn bộ sai sự thật. */
  async function doBulkCancel(): Promise<void> {
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    const okConfirm = await toast.confirm(
      `Yêu cầu hủy ${ids.length} khách hàng đã chọn? Mỗi khách sẽ tạo 1 yêu cầu hủy (chờ người có quyền duyệt). Khách đang giữ máy/TID/cọc sẽ bị từ chối.`,
      { title: 'Yêu cầu hủy hàng loạt', okLabel: `Tạo ${ids.length} yêu cầu`, cancelLabel: 'Hủy' }
    );
    if (!okConfirm) return;
    setBulkBusy(true);
    let done = 0;
    const failed: string[] = [];
    for (const id of ids) {
      const res = await window.api.entityCancelRequest('Customer', id, 'Yêu cầu hủy hàng loạt');
      if (res.ok) done++;
      else failed.push(`#${id}: ${res.message ?? res.error}`);
    }
    setBulkBusy(false);
    sel.clear();
    await reload();
    if (failed.length) toast.alert(`Đã tạo ${done} yêu cầu. Bỏ qua ${failed.length}:\n${failed.slice(0, 8).join('\n')}`, 'Kết quả hàng loạt');
    else toast.success(`Đã tạo ${done} yêu cầu hủy — chờ duyệt.`);
  }

  // FE-02 (Codex 15/7): nhận overrides để reset lọc truyền thẳng giá trị RỖNG (tránh setTimeout(reload) dùng
  // closure cũ → query bằng bộ lọc cũ trong khi ô nhập đã trống).
  async function reload(ov?: { search?: string; status?: string; fromDate?: string; toDate?: string }): Promise<void> {
    setLoading(true);
    sel.clear(); // audit 15/7 — dọn lựa chọn cũ khi lọc/tải lại để không yêu-cầu-hủy nhầm hàng đã ẩn
    try {
      const res = await window.api.customerList({
        search: (ov?.search ?? search) || undefined,
        status: (ov?.status ?? statusFilter) || undefined,
        fromDate: (ov?.fromDate ?? fromDate) || undefined,
        toDate: (ov?.toDate ?? toDate) || undefined
      });
      if (res.ok && res.data) { setRows(res.data); setTongDs(res.total ?? null); }
      else if (res.message) toast.alert(res.message);
      // Bộ đếm TOÀN CỤC — nạp độc lập bộ lọc để "Đã khóa"/"Đã hủy"/đại lý luôn đúng số.
      const cres = await window.api.customerCounts();
      if (cres.ok && cres.data) setCounts(cres.data);
    } catch (e) {
      // FE-03 (Codex 15/7): IPC reject (mất kết nối Postgres LAN) không được để spinner treo mãi.
      toast.alert(e instanceof Error ? e.message : 'Không tải được dữ liệu (mất kết nối máy chủ?).', 'Lỗi tải dữ liệu');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    void window.api.customerCounts().then((r) => r.ok && r.data && setCounts(r.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetFilters(): void {
    setSearch('');
    setStatusFilter('');
    setFromDate('');
    setToDate('');
    void reload({ search: '', status: '', fromDate: '', toDate: '' }); // FE-02: query ngay với bộ lọc rỗng (không dùng closure cũ)
  }

  // SỐ CỘT THẬT (§1): 7 cột cố định + ô tích khi có quyền yêu cầu hủy.
  const soCot = 7 + (canCancelReq ? 1 : 0);

  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Quản Lý Khách Hàng</h2>
          <p className="text-sm text-slate-500">Mã khách hàng tự sinh · biệt danh dễ gọi · tên thật · Số điện thoại.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('khach_hang', ['Mã khách hàng', 'Biệt danh', 'Tên thật', 'Số điện thoại', 'Địa chỉ'], rows.map((c) => [c.code, c.nickname, c.fullName, c.phone ?? '', c.address ?? '']))}>
            Xuất Excel
          </Button>
          {canCreate && <ImportButton entityKey="customer" label="Khách hàng" onImported={reload} />}
          {canCreate && (
            <Button variant="confirm" data-nut="them" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Thêm khách hàng
            </Button>
          )}
        </div>
      </div>

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Tìm mã khách hàng, biệt danh, tên thật, Số điện thoại…"
        fromDate={fromDate}
        toDate={toDate}
        onFromDate={setFromDate}
        onToDate={setToDate}
        selects={[
          {
            key: 'status',
            placeholder: 'Tất cả trạng thái',
            value: statusFilter,
            options: statusOptions.filter((o) => o.active).map((o) => ({ value: o.code, label: o.label })),
            onChange: setStatusFilter
          }
        ]}
        onApply={reload}
        onReset={resetFilters}
        coChuNho
        locPhai
      />

      {/* Dash bộ đếm TOÀN CỤC (countCustomers ở main, độc lập bộ lọc): tổng + trạng thái (hoạt động/khóa/hủy).
          "Đã khóa"/"Đã hủy" LUÔN hiện (kể cả =0) — Admin Demo yêu cầu không được ẩn. */}
      <StatBar
        items={[
          { label: 'Tổng khách', value: counts?.total ?? rows.length, tone: 'bg-brand-tint text-brand' },
          ...statusOptions
            .filter((o) => o.active)
            .map((o) => {
              // Đếm TOÀN CỤC cho 3 builtin từ counts; trạng thái tùy chỉnh mới → đếm client theo rows.
              const value =
                o.code === 'ACTIVE'
                  ? counts?.active ?? 0
                  : o.code === 'LOCKED'
                    ? counts?.locked ?? 0
                    : o.code === 'CANCELLED'
                      ? counts?.cancelled ?? 0
                      : rows.filter((c) => c.status === o.code).length;
              return { label: o.label, value, tone: toneCls(o.tone) };
            })
        ]}
      />

      <StaleBanner domain="Customer" onReload={reload} className="mb-2" />
      <CanhBaoCatDanhSach soHienThi={rows.length} tong={tongDs} className="mb-2" />

      {/* Admin Demo 15/7 — thanh thao tác hàng loạt: hiện khi có tích chọn; chỉ khi có quyền yêu cầu hủy. */}
      {canCancelReq && sel.count > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-tint px-4 py-2.5">
          <span className="text-sm font-medium text-brand">Đã chọn {sel.count} khách hàng</span>
          <div className="flex-1" />
          <Button variant="neutral" onClick={sel.clear}>Bỏ chọn tất cả</Button>
          <Button variant="danger" disabled={bulkBusy} onClick={doBulkCancel}>Yêu cầu hủy đã chọn ({sel.count})</Button>
        </div>
      )}
      {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên. Không cột tiền ⇒ không hàng TỔNG. */}
      <KhungBang>
        <table className="h-full w-full min-w-[1240px] text-xs">
          <thead className="sticky top-0 z-20 bg-slate-200">
            <tr>
              {canCancelReq && <SelectAllCell ids={rows.map((r) => r.id)} sel={sel} />}
              <th className={thChuan + ' w-[130px]'}>Mã khách hàng</th>
              <th className={thChuan + ' w-[230px]'}>Khách hàng</th>
              <th className={thChuan + ' w-[230px]'}>Nhóm chat SigMa</th>
              <th className={thChuan + ' w-[160px]'}>Trạng thái</th>
              <th className={thChuan + ' w-[130px]'}>Số điện thoại</th>
              <th className={thChuan + ' w-[260px]'}>Địa chỉ</th>
              <th className={thChuan + ' w-[100px]'}>Thao tác</th>
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
                <td colSpan={soCot} className="px-4 py-10 text-center text-slate-400">
                  <UserRound className="mx-auto mb-2 h-6 w-6" />
                  Chưa có khách hàng.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((c, i) => (
                <tr key={c.id} className={trChuan(i, sel.isSelected(c.id))}>
                  {canCancelReq && <SelectCell id={c.id} sel={sel} />}
                  <td className={tdChuan + ' font-mono font-semibold text-brand'}>{c.code}</td>
                  <td className={tdChuan + ' whitespace-normal'}>
                    <div className="font-medium text-slate-800">{c.nickname}</div>
                    <div className="text-slate-400">{c.fullName}</div>
                  </td>
                  <td className={tdChuan}>
                    {c.hasChatGroup ? (
                      <span className="font-medium text-slate-700">{c.chatGroupNames.join(', ')}</span>
                    ) : (
                      <span className="font-semibold text-red-600">Chưa liên kết</span>
                    )}
                  </td>
                  <td className={tdChuan}>
                    <div className="flex items-center justify-center gap-2">
                      {/* Chấm liên kết nhóm chat SigMa (Admin Demo 11/8): xanh = đã liên kết, đỏ = chưa — đặt TRƯỚC badge trạng thái. */}
                      <span
                        title={c.hasChatGroup ? 'Đã liên kết nhóm chat SigMa' : 'Chưa liên kết nhóm chat SigMa'}
                        className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${c.hasChatGroup ? 'bg-emerald-500' : 'bg-red-500'}`}
                      />
                      <StatusBadge entity="CUSTOMER" code={c.status} />
                    </div>
                  </td>
                  {/* Cột SỐ (điện thoại) — tabular-nums, cùng cỡ chữ 12px (§2). */}
                  <td className={tdChuan + ' text-center tabular-nums text-slate-600'}>{c.phone ?? '—'}</td>
                  <td className={tdChuan + ' text-slate-500'}>{c.address ?? '—'}</td>
                  <td className={tdChuan}>
                    <div className="flex justify-center gap-1">
                      {canUpdate && (
                        <IconButton title="Sửa" tone="edit" onClick={() => setEditing(c)}>
                          <Pencil className="h-4 w-4" />
                        </IconButton>
                      )}
                      {canCancelReq && (
                        <IconButton
                          title="Yêu cầu hủy"
                          tone="danger"
                          onClick={() =>
                            setCancelTarget({
                              entityType: 'Customer',
                              entityId: c.id,
                              entityLabel: `${c.code} · ${c.fullName}`,
                              typeLabel: 'khách hàng'
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            {/* HÀNG ĐỆM (§1). */}
            <tr aria-hidden className="h-full"><td colSpan={soCot} className="h-9" /></tr>
          </tbody>
        </table>
      </KhungBang>

      {(creating || editing) && (
        <CustomerForm
          target={editing}
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
    </div>
  );
}


function CustomerForm({ target, onClose, onSaved }: { target: CustomerDto | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const { options: statusOptions } = useStatusOptions('CUSTOMER');
  const editing = !!target;
  const [fullName, setFullName] = useState(target?.fullName ?? '');
  const [nickname, setNickname] = useState(target?.nickname ?? '');
  const [phone, setPhone] = useState(target?.phone ?? '');
  const [email, setEmail] = useState(target?.email ?? '');
  const [address, setAddress] = useState(target?.address ?? '');
  const [note, setNote] = useState(target?.note ?? '');
  const [status, setStatus] = useState(target?.status ?? 'ACTIVE');
  const [busy, setBusy] = useState(false);

  // ── Nhóm chat theo loại phí (Admin Demo 5/8) — cấu hình DÙNG CHUNG Thêm mới + Sửa (cross-cutting). ──
  const [feeTypes, setFeeTypes] = useState<{ id: number; name: string }[]>([]);
  const [chatRows, setChatRows] = useState<ChatGroupRow[]>([]);
  // Khi SỬA: chỉ cho phép lưu lại nhóm chat SAU KHI đã tải xong cấu hình hiện tại — tránh race "state rỗng lúc mở"
  // khiến setCustomerChatGroups HỦY GÁN nhầm toàn bộ nhóm đang có (reconcile theo danh sách gửi lên).
  const [cgLoaded, setCgLoaded] = useState(!editing);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const fr = await window.api.feeTypeList();
      if (alive && fr.ok && fr.data) setFeeTypes(fr.data.map((f) => ({ id: f.id, name: f.name })));
      if (editing) {
        const cr = await window.api.customerChatGroupsList(target!.id);
        if (alive && cr.ok && cr.data) {
          setChatRows(cr.data.map((g) => ({ key: `db-${g.id}`, feeTypeId: g.feeTypeId, roomId: g.roomId, roomName: g.roomName, link: g.link ?? '', qr: g.qr ?? '', zaloGroupId: g.zaloGroupId ?? '' })));
          setCgLoaded(true);
        } else if (alive) {
          // Không tải được cấu hình cũ → KHÔNG cho lưu nhóm chat (giữ nguyên bản DB, tránh xóa nhầm).
          setCgLoaded(false);
        }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(): Promise<void> {
    if (!fullName.trim()) return toast.alert('Tên thật khách hàng bắt buộc.', 'Thiếu thông tin');
    if (!nickname.trim()) return toast.alert('Biệt danh (tên dễ gọi) là bắt buộc.', 'Thiếu thông tin');
    // Mỗi dòng nhóm chat PHẢI chọn loại phí; KHÔNG được trùng loại phí (server cũng chặn, nhưng báo sớm cho gọn).
    const activeRows = chatRows.filter((r) => r.feeTypeId > 0 || r.roomId || r.link || r.qr || r.zaloGroupId);
    if (activeRows.some((r) => r.feeTypeId <= 0)) return toast.alert('Mỗi dòng nhóm chat phải chọn "Loại phí". Vui lòng chọn hoặc xóa dòng trống.', 'Thiếu loại phí');
    const feeSeen = new Set<number>();
    for (const r of activeRows) {
      if (feeSeen.has(r.feeTypeId)) return toast.alert('Mỗi loại phí chỉ được cấu hình 1 nhóm chat. Vui lòng bỏ loại phí bị trùng.', 'Trùng loại phí');
      feeSeen.add(r.feeTypeId);
    }
    setBusy(true);
    const payload = {
      fullName: fullName.trim(),
      nickname: nickname.trim(),
      phone: phone || null,
      email: email || null,
      address: address || null,
      note: note || null,
      status,
      expectedUpdatedAt: target?.updatedAt // R48 #2 optimistic-lock: mốc lúc mở form (undefined khi Thêm mới → bỏ qua)
    };
    const res = editing ? await window.api.customerUpdate(target!.id, payload) : await window.api.customerCreate(payload);
    if (res.ok) {
      // Lưu nhóm chat SAU khi khách đã lưu OK (create → lấy id mới). Chỉ reconcile khi state đã phản ánh đúng bản DB.
      const custId = editing ? target!.id : (res as { id?: number }).id;
      if (custId != null && cgLoaded) {
        const cgRes = await window.api.customerChatGroupsSet(custId, activeRows.map((r) => ({
          feeTypeId: r.feeTypeId,
          roomId: r.roomId,
          link: r.link.trim() || null,
          qr: r.qr.trim() || null,
          zaloGroupId: r.zaloGroupId.trim() || null
        })));
        if (!cgRes.ok) {
          setBusy(false);
          toast.alert(cgRes.message ?? 'Lưu cấu hình nhóm chat thất bại. Thông tin khách hàng đã được lưu.', 'Lưu nhóm chat lỗi');
          onSaved();
          return;
        }
      }
    }
    setBusy(false);
    if (res.ok) {
      toast.success(editing ? `Đã cập nhật ${nickname}` : `Đã tạo khách hàng ${nickname}`);
      onSaved();
    } else if (isStaleWrite(res)) {
      // R48 #2 — người khác vừa sửa bản ghi này → báo + đóng form, tải lại để lấy bản mới nhất.
      toast.alert(res.message ?? 'Bản ghi đã được người khác cập nhật, vui lòng mở lại.', STALE_TITLE);
      onSaved();
    } else {
      // Thao tác sai (trùng mã/Số điện thoại, dữ liệu đã tồn tại…) → dialog TO, RÕ.
      toast.alert(res.message ?? 'Lưu khách hàng thất bại', 'Không lưu được');
    }
  }

  return (
    <Modal title={editing ? `Sửa khách hàng ${target!.code}` : 'Thêm khách hàng mới'} onClose={onClose} width="max-w-3xl" onSubmit={() => void save()}>
      {editing && (
        <div className="mb-3 rounded-md bg-brand-tint px-3 py-2 text-sm text-brand">
          Mã khách hàng: <span className="font-mono font-semibold">{target!.code}</span> (không đổi)
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Biệt danh (dễ gọi)" required hint='Ví dụ: "Anh Thanh Hải Phòng"'>
          <input className={inputCls} value={nickname} onChange={(e) => setNickname(e.target.value)} autoFocus />
        </Field>
        <Field label="Tên thật" required hint='Ví dụ: "Nguyễn Văn Thanh"'>
          <input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Số điện thoại">
          <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Email">
          <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Địa chỉ">
          <input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="Ghi chú">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field label="Trạng thái" hint="Đã khóa = chặn giao dịch mới · Đã hủy = ẩn khỏi danh sách">
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            {statusSelectOptions(statusOptions, target?.status).map((o) => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
          </select>
        </Field>
      </div>

      <ChatGroupsSection
        feeTypes={feeTypes}
        rows={chatRows}
        onChange={setChatRows}
        disabled={editing && !cgLoaded}
      />

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button
          variant="confirm"
          onClick={save}
          disabled={busy}
          icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
        >
          {editing ? 'Lưu thay đổi' : 'Tạo khách hàng'}
        </Button>
      </div>
    </Modal>
  );
}
