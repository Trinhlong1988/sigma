import { useEffect, useState } from 'react';
import { Check, X, Loader2, ClipboardCheck, Download, RefreshCw, Trash2 } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { fmtDate, fmtDateTime, groupDigits, hasPermission } from '@sigma/shared';
import type { CancelRequestDto, EntityCancelRequestDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { Modal } from '../components/Modal.js';
import { Field, inputCls } from '../components/Field.js';
import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { StatBar } from '../components/StatBar.js';
import { statusTone } from '../components/StatusPill.js';
import { useRowSelection } from '../components/Selection.js';
import { thChuan, tdChuan, tdTongChuan, tdTien, trChuan, KhungBang } from '../components/BangChuan.js';
import { exportCsv } from '../lib/exportCsv.js';

const ENTITY_APPROVE_PERMS = ['TID_CANCEL_APPROVE', 'POS_CANCEL_APPROVE', 'CUSTOMER_CANCEL_APPROVE', 'USER_CANCEL_APPROVE'];

/** Nhóm 3 chữ số, KHÔNG ký hiệu tiền — dùng TRONG BẢNG (mẫu chốt 6/11 §2 bỏ ký tự đ).
 *  Dùng `groupDigits` của @sigma/shared (nguồn duy nhất), KHÔNG toLocaleString. */
function soTien(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? '−' : '') + groupDigits(Math.abs(v).toString());
}
/** VND có ký hiệu đ — dùng NGOÀI bảng (câu hỏi xác nhận trong bảng nổi). */
function money(n: number): string {
  return soTien(n) + 'đ';
}

/** MẪU CHỐT 6/11: trang nằm trong `<main overflow-auto>` nên khung bảng phải KHÓA chiều cao để
 *  `overflow-auto` tạo khung cuộn thật — nhờ đó tiêu đề `sticky top-0` và hàng TỔNG `sticky bottom-0`
 *  ghim TRONG bảng. Trang này có 3 bảng xếp dọc nên khóa thấp hơn (22rem) để không phải cuộn trang quá dài. */
const CAO_KHUNG = 'max-h-[calc(100vh-22rem)] bg-white shadow-sm';

/** Ô tích CHỌN TẤT CẢ / 1 dòng theo KIỂU CHUẨN. Không dùng SelectAllCell/SelectCell vì 2 component dùng
 *  chung đó còn mang chuỗi class tự chế (px-4 py-3, không nền) ⇒ hở nền giữa hàng tiêu đề xám. Đợt này
 *  không được sửa file ngoài nhóm B; đề xuất bổ sung prop class đã ghi trong báo cáo. */
function ThTich({ ids, sel }: { ids: number[]; sel: ReturnType<typeof useRowSelection> }): JSX.Element {
  const allOn = ids.length > 0 && ids.every((id) => sel.isSelected(id));
  return (
    <th className={thChuan + ' !px-1.5'}>
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

type Dialog =
  | { kind: 'approve'; row: CancelRequestDto }
  | { kind: 'reject'; row: CancelRequestDto }
  | { kind: 'approveBulk' }
  | { kind: 'rejectBulk' }
  | { kind: 'approveEntity'; row: EntityCancelRequestDto }
  | { kind: 'rejectEntity'; row: EntityCancelRequestDto }
  | { kind: 'approveEntityBulk' }
  | null;

/**
 * Trang "Duyệt hủy bill" (P1.2 §5). Chỉ hiển thị yêu cầu PENDING mà người đang đăng nhập ĐƯỢC PHÉP
 * duyệt (đã lọc theo phân vai ở service qua cờ canApprove). Duyệt / Từ chối từng cái hoặc hàng loạt
 * ("chọn tất cả" → Duyệt/Từ chối đã chọn). Cái không được phép → service tự bỏ qua kèm lý do.
 */
export function ApprovalPage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const canBill = hasPermission(user, 'BILL_CANCEL_APPROVE');
  const canEntity = ENTITY_APPROVE_PERMS.some((p) => hasPermission(user, p));
  const [rows, setRows] = useState<CancelRequestDto[]>([]);
  const [stats, setStats] = useState({ total: 0, pending: 0, approved: 0, rejected: 0 });
  const [entityRows, setEntityRows] = useState<EntityCancelRequestDto[]>([]);
  // Admin Demo 14/7 — "danh sách lệnh duyệt đã xóa": các yêu cầu ĐÃ DUYỆT (bill CANCELLED / entity xóa mềm).
  const [approvedBills, setApprovedBills] = useState<CancelRequestDto[]>([]);
  const [approvedEntities, setApprovedEntities] = useState<EntityCancelRequestDto[]>([]);
  const [showApproved, setShowApproved] = useState(false);
  // Admin Demo 15/7 — xem thêm yêu cầu ĐÃ TỪ CHỐI.
  const [rejectedBills, setRejectedBills] = useState<CancelRequestDto[]>([]);
  const [rejectedEntities, setRejectedEntities] = useState<EntityCancelRequestDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<Dialog>(null);
  const sel = useRowSelection();
  const selEnt = useRowSelection(); // R34 — chọn nhiều phiếu hủy DỮ LIỆU (TID/POS/Khách/NS) để duyệt hàng loạt

  async function reload(): Promise<void> {
    setLoading(true);
    // Bảng chỉ hiển thị PENDING mà bạn được duyệt; nhưng bộ đếm là TOÀN HỆ THỐNG theo trạng thái.
    // Đếm CLIENT từ 3 danh sách đầy đủ (cancelRequestList trả full, KHÔNG phân trang) — không cần API mới.
    if (canBill) {
      const [pend, appr, rej] = await Promise.all([
        window.api.cancelRequestList('PENDING'),
        window.api.cancelRequestList('APPROVED'),
        window.api.cancelRequestList('REJECTED')
      ]);
      // Hiện phiếu bạn ĐƯỢC duyệt HOẶC do CHÍNH bạn tạo (để bạn biết đang chờ người khác duyệt — chống "tạo xong biến mất").
      if (pend.ok && pend.data) setRows(pend.data.filter((r) => r.canApprove || r.isSelf));
      else if (pend.message) toast.alert(pend.message);
      const pc = pend.ok && pend.data ? pend.data.length : 0;
      const ac = appr.ok && appr.data ? appr.data.length : 0;
      const rc = rej.ok && rej.data ? rej.data.length : 0;
      setStats({ total: pc + ac + rc, pending: pc, approved: ac, rejected: rc });
      setApprovedBills(appr.ok && appr.data ? appr.data : []);
      setRejectedBills(rej.ok && rej.data ? rej.data : []);
    }
    // R34 — yêu cầu hủy dữ liệu (TID/POS/Khách/Nhân sự) đang chờ bạn duyệt.
    if (canEntity) {
      const [ent, entAppr, entRej] = await Promise.all([
        window.api.entityCancelList('PENDING'),
        window.api.entityCancelList('APPROVED'),
        window.api.entityCancelList('REJECTED')
      ]);
      if (ent.ok && ent.data) setEntityRows(ent.data.filter((r) => r.canApprove || r.isSelf));
      else if (ent.message) toast.alert(ent.message);
      setApprovedEntities(entAppr.ok && entAppr.data ? entAppr.data : []);
      setRejectedEntities(entRej.ok && entRej.data ? entRej.data : []);
    }
    sel.clear();
    selEnt.clear();
    setLoading(false);
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  /** Tóm tắt kết quả bulk: "Đã duyệt N · Bỏ qua M (lý do…)". */
  function summarize(verb: string, done: number, skipped?: { id: number; reason: string; message?: string }[]): void {
    if (skipped && skipped.length > 0) {
      const detail = skipped.map((s) => `#${s.id}: ${s.message ?? s.reason}`).join('\n');
      toast.alert(`${verb} ${done} yêu cầu. Bỏ qua ${skipped.length}:\n${detail}`, 'Kết quả xử lý hàng loạt');
    } else {
      toast.success(`${verb} ${done} yêu cầu.`);
    }
  }

  async function doApprove(row: CancelRequestDto, password: string, note?: string): Promise<void> {
    const res = await window.api.cancelApprove(row.id, password, note);
    if (res.ok) toast.success(`Đã duyệt hủy bill ${row.billCode ?? row.transactionId}.`);
    else toast.alert(res.message ?? 'Không duyệt được yêu cầu.', 'Duyệt thất bại');
    setDialog(null);
    await reload();
  }
  async function doReject(row: CancelRequestDto, note: string): Promise<void> {
    const res = await window.api.cancelReject(row.id, note);
    if (res.ok) toast.success(`Đã từ chối yêu cầu hủy bill ${row.billCode ?? row.transactionId}.`);
    else toast.alert(res.message ?? 'Không từ chối được yêu cầu.', 'Từ chối thất bại');
    setDialog(null);
    await reload();
  }
  async function doApproveBulk(password: string): Promise<void> {
    const res = await window.api.cancelApproveBulk([...sel.selected], password);
    if (res.ok) summarize('Đã duyệt', res.done ?? 0, res.skipped);
    else toast.alert(res.message ?? 'Duyệt hàng loạt thất bại.', 'Duyệt thất bại');
    setDialog(null);
    await reload();
  }
  async function doRejectBulk(note: string): Promise<void> {
    const res = await window.api.cancelRejectBulk([...sel.selected], note);
    if (res.ok) summarize('Đã từ chối', res.done ?? 0, res.skipped);
    else toast.alert(res.message ?? 'Từ chối hàng loạt thất bại.', 'Từ chối thất bại');
    setDialog(null);
    await reload();
  }
  // R34 — duyệt / từ chối yêu cầu hủy dữ liệu (TID/POS/Khách/Nhân sự). Duyệt BẮT BUỘC nhập mật khẩu (Q2).
  async function doApproveEntity(row: EntityCancelRequestDto, password: string, note?: string): Promise<void> {
    const res = await window.api.entityCancelApprove(row.entityType, row.id, password, note);
    if (res.ok) toast.success(`Đã duyệt hủy ${row.entityTypeLabel} ${row.entityLabel ?? ''}.`);
    else toast.alert(res.message ?? 'Không duyệt được yêu cầu.', 'Duyệt thất bại');
    setDialog(null);
    await reload();
  }
  async function doRejectEntity(row: EntityCancelRequestDto, note: string): Promise<void> {
    const res = await window.api.entityCancelReject(row.entityType, row.id, note);
    if (res.ok) toast.success(`Đã từ chối yêu cầu hủy ${row.entityTypeLabel} ${row.entityLabel ?? ''}.`);
    else toast.alert(res.message ?? 'Không từ chối được yêu cầu.', 'Từ chối thất bại');
    setDialog(null);
    await reload();
  }
  // R34 — duyệt HÀNG LOẠT phiếu hủy dữ liệu đã chọn: mật khẩu nhập 1 lần và gửi ĐÚNG 1 LƯỢT cho cả lô.
  // (13/11) Trước đây lặp 1 request/phiếu ⇒ quá 5 phiếu/phút là dính trần chống dò mật khẩu (B152), và rớt mạng
  // giữa chừng thì duyệt dở dang. Backend bỏ qua TỪNG phiếu không đủ quyền và trả về danh sách bỏ qua.
  async function doApproveEntityBulk(password: string): Promise<void> {
    const chosen = entityRows.filter((r) => selEnt.selected.has(r.id) && r.canApprove);
    const res = await window.api.entityCancelApproveBulk(chosen.map((r) => ({ entityType: r.entityType, id: r.id })), password);
    if (res.ok) summarize('Đã duyệt', res.done ?? 0, res.skipped);
    else toast.alert(res.message ?? 'Duyệt hàng loạt thất bại.', 'Duyệt thất bại');
    setDialog(null);
    await reload();
  }

  // Số cột THẬT của 3 bảng trang này (đều 7 cột, cố định ở mọi bề ngang — không ẩn cột theo breakpoint).
  const soCotLichSu = 7;
  const soCotBill = 7;
  const soCotDuLieu = 7;
  // Tổng SỐ TIỀN của đúng danh sách đang hiện (mẫu chốt 6/11 §5: cộng từ cùng mảng đã lọc).
  const tongTienBill = rows.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0);

  return (
    // MẪU CHỐT 6/11: `data-nut-vuong` ở thẻ bọc NGOÀI CÙNG để trang ăn luật nút/thanh cuộn/màu của mau-moi.css.
    <div data-nut-vuong data-trang-full>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Quản lý dữ liệu yêu cầu duyệt hủy</h2>
          <p className="text-sm text-slate-500">Yêu cầu hủy (bill, TID, máy POS, khách hàng, nhân sự) đang chờ bạn duyệt — người tạo yêu cầu khác người duyệt (phân vai theo cấp).</p>
        </div>
        <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
          <Button data-nut="lammoi" variant="soft" icon={<RefreshCw className="h-4 w-4" />} onClick={reload}>Làm mới</Button>
          {canBill && (
            <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('duyet_huy_bill', ['Mã bill', 'Số tiền', 'Lý do hủy', 'Người tạo yêu cầu', 'Thời gian'], rows.map((r) => [r.billCode ?? `#${r.transactionId}`, r.amount, r.reason, r.requestedByName ?? `#${r.requestedBy}`, fmtDate(r.requestedAt)]))}>
              Xuất Excel
            </Button>
          )}
        </div>
      </div>

      {/* Admin Demo 14-15/7 — lịch sử yêu cầu ĐÃ XỬ LÝ: đã duyệt (bill hủy / dữ liệu xóa mềm) + đã TỪ CHỐI. */}
      <div className="mb-3 flex items-center gap-2">
        <Button data-nut="xem" variant={showApproved ? 'confirm' : 'neutral'} onClick={() => setShowApproved((v) => !v)}>
          {showApproved ? 'Ẩn lịch sử đã xử lý' : `Xem lịch sử đã duyệt / từ chối (${approvedBills.length + approvedEntities.length + rejectedBills.length + rejectedEntities.length})`}
        </Button>
      </div>

      {showApproved && (
        <div className="mb-5">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Lịch sử đã xử lý — {approvedBills.length + approvedEntities.length + rejectedBills.length + rejectedEntities.length} bản ghi (chỉ xem)
          </div>
          <KhungBang className={CAO_KHUNG}>
            {/* min-w: thiếu chỗ thì CUỘN NGANG, tuyệt đối KHÔNG ẩn cột theo breakpoint (mẫu chốt 6/11 §1). */}
            <table className="w-full min-w-[1180px] text-xs">
              <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
                <tr>
                  <th className={thChuan + ' w-[120px]'}>Kết quả</th>
                  <th className={thChuan + ' w-[130px]'}>Loại</th>
                  <th className={thChuan + ' w-[200px]'}>Đối tượng</th>
                  <th className={thChuan}>Lý do</th>
                  <th className={thChuan + ' w-[170px]'}>Người yêu cầu</th>
                  <th className={thChuan + ' w-[170px]'}>Người xử lý</th>
                  <th className={thChuan + ' w-[150px]'}>Thời điểm</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...approvedBills.map((r) => ({ r, kind: 'bill' as const, ok: true })),
                  ...rejectedBills.map((r) => ({ r, kind: 'bill' as const, ok: false })),
                  ...approvedEntities.map((r) => ({ r, kind: 'entity' as const, ok: true })),
                  ...rejectedEntities.map((r) => ({ r, kind: 'entity' as const, ok: false }))
                ].map(({ r, kind, ok }, i) => (
                  // SỌC NGỰA VẰN dùng chung `trChuan(i)` — bảng lịch sử trước đây không có sọc, dò ngang 7 cột rất khó.
                  <tr key={`${kind}-${ok ? 'a' : 'r'}-${(r as { id: number }).id}`} className={trChuan(i)}>
                    <td className={tdChuan + ' text-center'}>
                      <span className={'rounded-full px-2 py-0.5 font-medium ' + (ok ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-700')}>{ok ? 'Đã duyệt' : 'Đã từ chối'}</span>
                    </td>
                    {kind === 'bill' ? (
                      <>
                        <td className={tdChuan + ' text-center'}><span className="rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-600">Bill hủy</span></td>
                        <td className={tdChuan + ' text-center font-mono font-semibold text-slate-700'}>{(r as CancelRequestDto).billCode ?? `#${(r as CancelRequestDto).transactionId}`}</td>
                      </>
                    ) : (
                      <>
                        <td className={tdChuan + ' text-center'}><span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{(r as EntityCancelRequestDto).entityTypeLabel}</span></td>
                        <td className={tdChuan + ' truncate text-center font-medium text-slate-700'} title={(r as EntityCancelRequestDto).entityLabel ?? ''}>{(r as EntityCancelRequestDto).entityLabel ?? `#${(r as EntityCancelRequestDto).entityId}`}</td>
                      </>
                    )}
                    <td className={tdChuan + ' truncate text-slate-600'} title={r.reason}>{r.reason}</td>
                    <td className={tdChuan + ' truncate text-center text-slate-600'} title={r.requestedByName ?? ''}>{r.requestedByName ?? '—'}</td>
                    <td className={tdChuan + ' truncate text-center text-slate-600'} title={r.decidedByName ?? ''}>{r.decidedByName ?? '—'}</td>
                    {/* CẤM toLocaleString (lệ thuộc locale máy) → dùng `fmtDateTime` của @sigma/shared (dd/mm/yyyy HH:mm). */}
                    <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{r.decidedAt ? fmtDateTime(r.decidedAt) : '—'}</td>
                  </tr>
                ))}
                {approvedBills.length + approvedEntities.length + rejectedBills.length + rejectedEntities.length === 0 && (
                  <tr><td colSpan={soCotLichSu} className="px-3 py-4 text-center text-sm text-slate-400">Chưa có yêu cầu nào được xử lý.</td></tr>
                )}
                {/* HÀNG ĐỆM (mẫu chốt 6/11 §1): chừa 1 hàng để dòng cuối không bị che khi cuộn tới đáy. */}
                <tr aria-hidden><td colSpan={soCotLichSu} className="h-9" /></tr>
              </tbody>
            </table>
          </KhungBang>
        </div>
      )}

      {canBill && (
      <StatBar
        items={[
          { label: 'Tổng yêu cầu bill', value: stats.total, tone: 'bg-brand-tint text-brand' },
          { label: 'Chờ duyệt', value: stats.pending, tone: statusTone('PENDING') },
          { label: 'Đã duyệt', value: stats.approved, tone: statusTone('ACTIVE') },
          { label: 'Từ chối', value: stats.rejected, tone: statusTone('LOCKED') }
        ]}
      />
      )}

      {canBill && <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Yêu cầu hủy bill</div>}

      {canBill && (
      <>
      {/* Thanh thao tác hàng loạt */}
      {sel.count > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-tint px-4 py-2.5">
          <span className="text-sm font-medium text-brand">Đã chọn {sel.count} yêu cầu</span>
          <div className="flex-1" />
          <Button variant="neutral" onClick={sel.clear}>Bỏ tích</Button>
          <Button variant="danger" onClick={() => setDialog({ kind: 'rejectBulk' })}>Từ chối đã chọn</Button>
          <Button variant="confirm" onClick={() => setDialog({ kind: 'approveBulk' })}>Duyệt đã chọn</Button>
        </div>
      )}

      <KhungBang className={CAO_KHUNG}>
        {/* Admin Demo 12/7 — table-fixed + colgroup: cột trước "Lý do hủy" (chọn+Mã bill+Số tiền = 21rem) khớp
            đúng cột trước của bảng "Yêu cầu hủy dữ liệu" (Loại+Đối tượng = 21rem) → 4 cột chung THẲNG HÀNG 2 bảng.
            min-w: thiếu chỗ thì CUỘN NGANG, KHÔNG ẩn cột theo breakpoint (mẫu chốt 6/11 §1). */}
        <table className="w-full min-w-[1180px] table-fixed text-xs">
          <colgroup>
            <col className="w-12" />
            <col className="w-32" />
            <col className="w-40" />
            <col />
            <col className="w-44" />
            <col className="w-40" />
            <col className="w-44" />
          </colgroup>
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              <ThTich ids={rows.map((r) => r.id)} sel={sel} />
              <th className={thChuan}>Mã bill</th>
              <th className={thChuan}>Số tiền</th>
              <th className={thChuan}>Lý do hủy</th>
              <th className={thChuan}>Người tạo yêu cầu</th>
              <th className={thChuan}>Thời gian</th>
              <th className={thChuan}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={soCotBill} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={soCotBill} className="px-4 py-10 text-center text-sm text-slate-400"><ClipboardCheck className="mx-auto mb-2 h-6 w-6" /> Không có yêu cầu hủy nào chờ bạn duyệt.</td></tr>
            )}
            {!loading && rows.map((r, i) => (
              // SỌC NGỰA VẰN dùng chung `trChuan(i)`; dòng ĐANG TÍCH tô sáng (tham số noiBat).
              <tr key={r.id} className={trChuan(i, sel.isSelected(r.id))}>
                <TdTich id={r.id} sel={sel} />
                <td className={tdChuan + ' text-center font-mono font-medium text-slate-700'}>{r.billCode ?? `#${r.transactionId}`}</td>
                {/* Cột TIỀN: căn phải, tabular-nums, text-slate-800, KHÔNG in đậm, bỏ ký tự đ (mẫu chốt §2). */}
                <td className={tdTien}>{soTien(r.amount)}</td>
                <td className={tdChuan + ' truncate text-slate-600'} title={r.reason}>{r.reason}</td>
                <td className={tdChuan + ' truncate text-center text-slate-600'} title={r.requestedByName ?? ''}>{r.requestedByName ?? `#${r.requestedBy}`}</td>
                <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{fmtDate(r.requestedAt)}</td>
                <td className={tdChuan}>
                  {r.canApprove ? (
                    <div className="flex justify-center gap-1">
                      <IconButton title="Duyệt hủy" tone="success" onClick={() => setDialog({ kind: 'approve', row: r })}><Check className="h-4 w-4" /></IconButton>
                      <IconButton title="Từ chối" tone="danger" onClick={() => setDialog({ kind: 'reject', row: r })}><X className="h-4 w-4" /></IconButton>
                    </div>
                  ) : (
                    <div className="truncate text-center font-semibold text-amber-600" title="Bạn là người tạo yêu cầu này — cần NGƯỜI KHÁC (có quyền) duyệt.">Chờ người khác duyệt</div>
                  )}
                </td>
              </tr>
            ))}
            {/* HÀNG ĐỆM: chừa 1 hàng để dòng cuối không bị hàng TỔNG ghim đáy che khi cuộn tới đáy. */}
            <tr aria-hidden><td colSpan={soCotBill} className="h-9" /></tr>
          </tbody>
          {/* HÀNG TỔNG ghim ĐÁY: nền đặt trên TỪNG <td> (tdTongChuan), KHÔNG trên <tr>. */}
          <tfoot className="sticky bottom-0 z-10">
            <tr className="border-t-2 border-brand">
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={2}>TỔNG {rows.length} yêu cầu</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{soTien(tongTienBill)}</td>
              <td className={tdTongChuan} colSpan={4} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>
      </>
      )}

      {/* R34 — Yêu cầu hủy dữ liệu (TID / POS / Khách hàng / Nhân sự) */}
      {canEntity && (
        <div className={canBill ? 'mt-6' : ''}>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Yêu cầu hủy dữ liệu (TID · Máy POS · Khách hàng · Nhân sự)</div>
            {selEnt.count > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Đã chọn {selEnt.count}</span>
                <Button variant="soft" onClick={() => selEnt.clear()}>Bỏ chọn</Button>
                <Button variant="confirm" onClick={() => setDialog({ kind: 'approveEntityBulk' })}>Duyệt đã chọn ({selEnt.count})</Button>
              </div>
            )}
          </div>
          <KhungBang className={CAO_KHUNG}>
            <table className="w-full min-w-[1180px] table-fixed text-xs">
              <colgroup>
                <col className="w-12" />
                <col className="w-24" />
                <col className="w-56" />
                <col />
                <col className="w-44" />
                <col className="w-40" />
                <col className="w-44" />
              </colgroup>
              <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
                <tr>
                  <ThTich ids={entityRows.filter((r) => r.canApprove).map((r) => r.id)} sel={selEnt} />
                  <th className={thChuan}>Loại</th>
                  <th className={thChuan}>Đối tượng</th>
                  <th className={thChuan}>Lý do hủy</th>
                  <th className={thChuan}>Người tạo yêu cầu</th>
                  <th className={thChuan}>Thời gian</th>
                  <th className={thChuan}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={soCotDuLieu} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
                {!loading && entityRows.length === 0 && (
                  <tr><td colSpan={soCotDuLieu} className="px-4 py-10 text-center text-sm text-slate-400"><Trash2 className="mx-auto mb-2 h-6 w-6" /> Không có yêu cầu hủy dữ liệu nào chờ bạn duyệt.</td></tr>
                )}
                {!loading && entityRows.map((r, i) => (
                  <tr key={`${r.entityType}-${r.id}`} className={trChuan(i, selEnt.isSelected(r.id))}>
                    {r.canApprove ? <TdTich id={r.id} sel={selEnt} /> : <td className={tdChuan + ' !px-1.5'} />}
                    <td className={tdChuan + ' text-center'}><span className="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{r.entityTypeLabel}</span></td>
                    <td className={tdChuan + ' truncate text-center text-slate-700'} title={r.entityLabel ?? ''}>{r.entityLabel ?? `#${r.entityId}`}</td>
                    <td className={tdChuan + ' truncate text-slate-600'} title={r.reason}>{r.reason}</td>
                    <td className={tdChuan + ' truncate text-center text-slate-600'} title={r.requestedByName ?? ''}>{r.requestedByName ?? `#${r.requestedBy}`}</td>
                    <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{fmtDate(r.requestedAt)}</td>
                    <td className={tdChuan}>
                      {r.canApprove ? (
                        <div className="flex justify-center gap-1">
                          <IconButton title="Duyệt hủy" tone="success" onClick={() => setDialog({ kind: 'approveEntity', row: r })}><Check className="h-4 w-4" /></IconButton>
                          <IconButton title="Từ chối" tone="danger" onClick={() => setDialog({ kind: 'rejectEntity', row: r })}><X className="h-4 w-4" /></IconButton>
                        </div>
                      ) : (
                        <div className="truncate text-center font-semibold text-amber-600" title="Bạn là người tạo yêu cầu này — cần NGƯỜI KHÁC (có quyền) duyệt, không tự duyệt được.">Chờ người khác duyệt</div>
                      )}
                    </td>
                  </tr>
                ))}
                {/* HÀNG ĐỆM (mẫu chốt 6/11 §1): chừa 1 hàng để dòng cuối không bị che khi cuộn tới đáy. */}
                <tr aria-hidden><td colSpan={soCotDuLieu} className="h-9" /></tr>
              </tbody>
            </table>
          </KhungBang>
        </div>
      )}

      {dialog?.kind === 'approve' && (
        <ApprovePasswordModal
          title="Duyệt hủy bill"
          message={`Duyệt yêu cầu hủy bill "${dialog.row.billCode ?? dialog.row.transactionId}" (${money(dialog.row.amount)})? Bill sẽ chuyển sang Đã hủy và không còn tính vào doanh thu. Nhập mật khẩu của bạn để xác nhận.`}
          onClose={() => setDialog(null)}
          onSubmit={(password, note) => doApprove(dialog.row, password, note)}
        />
      )}
      {dialog?.kind === 'approveBulk' && (
        <ApprovePasswordModal
          title="Duyệt các yêu cầu đã chọn"
          message={`Duyệt ${sel.count} yêu cầu hủy đã chọn? Yêu cầu nào bạn không đủ thẩm quyền sẽ được bỏ qua kèm lý do. Nhập mật khẩu của bạn để xác nhận.`}
          onClose={() => setDialog(null)}
          onSubmit={(password) => doApproveBulk(password)}
        />
      )}
      {dialog?.kind === 'reject' && (
        <NoteModal
          title={`Từ chối yêu cầu hủy bill ${dialog.row.billCode ?? dialog.row.transactionId}`}
          onClose={() => setDialog(null)}
          onSubmit={(note) => doReject(dialog.row, note)}
        />
      )}
      {dialog?.kind === 'rejectBulk' && (
        <NoteModal
          title={`Từ chối ${sel.count} yêu cầu đã chọn`}
          hint="Lý do áp dụng cho tất cả yêu cầu được chọn. Yêu cầu nào bạn không đủ thẩm quyền sẽ được bỏ qua."
          onClose={() => setDialog(null)}
          onSubmit={(note) => doRejectBulk(note)}
        />
      )}
      {dialog?.kind === 'approveEntity' && (
        <ApprovePasswordModal
          title={`Duyệt hủy ${dialog.row.entityTypeLabel}`}
          message={`Duyệt hủy ${dialog.row.entityTypeLabel} "${dialog.row.entityLabel ?? '#' + dialog.row.entityId}"? Dữ liệu sẽ bị XÓA khỏi hệ thống (xóa mềm, có thể phục hồi ở Thùng rác). Nhập mật khẩu của bạn để xác nhận.`}
          onClose={() => setDialog(null)}
          onSubmit={(password, note) => doApproveEntity(dialog.row, password, note)}
        />
      )}
      {dialog?.kind === 'approveEntityBulk' && (
        <ApprovePasswordModal
          title={`Duyệt ${selEnt.count} yêu cầu hủy dữ liệu đã chọn`}
          message={`Duyệt hủy ${selEnt.count} mục đã chọn? Dữ liệu tương ứng sẽ bị XÓA (xóa mềm, phục hồi được ở Thùng rác). Yêu cầu nào bạn không đủ thẩm quyền sẽ được bỏ qua kèm lý do. Nhập mật khẩu của bạn để xác nhận.`}
          onClose={() => setDialog(null)}
          onSubmit={(password) => doApproveEntityBulk(password)}
        />
      )}
      {dialog?.kind === 'rejectEntity' && (
        <NoteModal
          title={`Từ chối yêu cầu hủy ${dialog.row.entityTypeLabel} ${dialog.row.entityLabel ?? ''}`}
          onClose={() => setDialog(null)}
          onSubmit={(note) => doRejectEntity(dialog.row, note)}
        />
      )}
    </div>
  );
}

/** R34 — Ô duyệt hủy dữ liệu: BẮT BUỘC nhập mật khẩu người duyệt (Q2) + ghi chú tùy chọn. */
function ApprovePasswordModal({ title, message, onClose, onSubmit }: { title: string; message: string; onClose: () => void; onSubmit: (password: string, note?: string) => Promise<void> }): JSX.Element {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(): Promise<void> {
    if (!password) return toast.alert('Vui lòng nhập mật khẩu để xác nhận.', 'Thiếu mật khẩu');
    setBusy(true);
    try {
      await onSubmit(password, note.trim() || undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose} width="max-w-md">
      <p className="mb-3 text-sm text-slate-600">{message}</p>
      <Field label="Mật khẩu của bạn" required>
        <input type="password" className={inputCls} value={password} autoFocus onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
      </Field>
      <div className="mt-3">
        <Field label="Ghi chú (tùy chọn)">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú khi duyệt…" />
        </Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={submit} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Duyệt hủy</Button>
      </div>
    </Modal>
  );
}

/** Ô nhập lý do từ chối (bắt buộc). */
function NoteModal({ title, hint, onClose, onSubmit }: { title: string; hint?: string; onClose: () => void; onSubmit: (note: string) => Promise<void> }): JSX.Element {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(): Promise<void> {
    if (!note.trim()) return toast.alert('Vui lòng nhập lý do từ chối.', 'Thiếu lý do');
    setBusy(true);
    try { await onSubmit(note.trim()); } finally { setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose} width="max-w-md">
      {hint && <p className="mb-3 text-sm text-slate-500">{hint}</p>}
      <Field label="Lý do từ chối" required>
        <textarea className={inputCls + ' min-h-[80px] resize-y'} value={note} autoFocus onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: bill hợp lệ, không cần hủy…" />
      </Field>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="danger" onClick={submit} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Từ chối</Button>
      </div>
    </Modal>
  );
}
