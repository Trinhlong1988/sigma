// CỌC KẸT TAY (Admin Demo 11/8) — WIRING màn hoàn cọc kẹt. Cọc OPEN còn giữ mà máy đã BÁN/THANH LÝ (SOLD/RETIRED):
// recall (đường hoàn tự động) KHÔNG gọi được nữa → cọc mất đường về. Trang này liệt kê danh sách cọc kẹt
// (REVENUE_VIEW, core gate) + nút "Hoàn tay" mỗi dòng (POS_MANAGE, core gate) mở modal chọn QUỸ CHI + phương thức +
// ngày + ghi chú → gọi refundDepositManual (cùng bút toán như recall). Nghiệp vụ THUẦN ở @sigma/services (deposit.ts).
import { useCallback, useEffect, useState } from 'react';
import { HandCoins, Loader2, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate } from '@sigma/shared';
import type { DepositManualRefundRow, FundDto, RefundDepositManualInput } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { Modal } from '../components/Modal.js';
import { Field, inputCls } from '../components/Field.js';
import { Button } from '../components/Button.js';
// MẪU CHỐT 6/11 — kiểu bảng lấy TỪ MODULE DÙNG CHUNG, cấm chép chuỗi class vào trang.
import { thChuan, tdChuan, tdTongChuan, tdTien, trChuan, KhungBang } from '../components/BangChuan.js';

/** VND nguyên → chuỗi có phân nhóm nghìn + hậu tố đ (đồng bộ helper các trang tiền). */
function money(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '−' : '') + s + 'đ';
}
/** Tiền TRONG BẢNG: bỏ ký tự "đ" (MẪU CHỐT 6/11 §2). */
function tienBang(n: number): string {
  return money(n).replace('đ', '');
}
/** SỐ CỘT của bảng — dùng chung cho hàng rỗng / hàng đệm / tổng colSpan của tfoot (§1). */
const SO_COT = 11;

/** Nhãn trạng thái máy kẹt cọc. */
function deviceStatusLabel(st: string | null): string {
  if (st === 'SOLD') return 'Đã bán';
  if (st === 'RETIRED') return 'Đã thanh lý';
  return 'Máy đã xóa';
}

export function DepositRefundPage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const canManage = hasPermission(user, 'POS_MANAGE'); // nút Hoàn tay chỉ hiện/enabled khi có POS_MANAGE
  const [rows, setRows] = useState<DepositManualRefundRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refundRow, setRefundRow] = useState<DepositManualRefundRow | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const r = await window.api.depositsNeedingManualRefund();
    setLoading(false);
    if (r.ok && r.data) setRows(r.data);
    else toast.alert(r.message ?? 'Không tải được danh sách cọc kẹt', 'Lỗi tải dữ liệu');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(); }, [load]);

  const totalRemaining = rows.reduce((s, r) => s + r.remaining, 0);

  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-800">Hoàn cọc kẹt tay</h3>
          <p className="text-sm text-slate-500">
            Cọc còn giữ mà máy đã bán / thanh lý — không thu hồi tự động được. Hoàn tay khi có bill chuyển khoản.
          </p>
        </div>
        <Button data-nut="lammoi" variant="soft" size="sm" onClick={() => void load()} icon={<RefreshCw className="h-4 w-4" />}>Làm mới</Button>
      </div>

      {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên, hàng TỔNG ghim đáy; không ẩn cột theo
          breakpoint (thiếu chỗ thì cuộn ngang bằng min-w trên <table>). */}
      <KhungBang>
        <table className="h-full w-full min-w-[1420px] text-xs">
          <thead className="sticky top-0 z-20 bg-slate-200">
            <tr>
              <th className={thChuan + ' w-[100px]'}>Mã cọc</th>
              <th className={thChuan + ' w-[150px]'}>Khách</th>
              <th className={thChuan + ' w-[130px]'}>Serial máy</th>
              <th className={thChuan + ' w-[110px]'}>TID</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Số cọc</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Đã hoàn</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Còn lại</th>
              <th className={thChuan + ' w-[128px]'}>Trạng thái máy</th>
              <th className={thChuan + ' w-[92px]'}>Ngày</th>
              <th className={thChuan + ' w-[220px]'}>Ghi chú</th>
              <th className={thChuan + ' w-[112px]'}>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={SO_COT} className="px-4 py-10 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={SO_COT} className="px-4 py-10 text-center text-slate-400">Không có cọc kẹt cần hoàn tay.</td></tr>
            )}
            {!loading && rows.map((r, i) => (
              <tr key={r.depositId} className={trChuan(i)}>
                <td className={tdChuan + ' font-medium text-slate-700'}>{r.code ?? r.depositId}</td>
                <td className={tdChuan + ' text-slate-700'}>{r.customerName ?? `#${r.customerId}`}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{r.deviceSerial ?? '—'}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{r.tid ?? '—'}</td>
                {/* 3 cột tiền: căn phải · tabular-nums · text-slate-800 · KHÔNG in đậm (§2). */}
                <td className={tdTien}>{tienBang(r.amount)}</td>
                <td className={tdTien}>{tienBang(r.refunded)}</td>
                <td className={tdTien}>{tienBang(r.remaining)}</td>
                <td className={tdChuan + ' text-center'}>
                  <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-600">{deviceStatusLabel(r.deviceStatus)}</span>
                </td>
                <td className={tdChuan + ' text-center text-slate-600'}>{fmtDate(r.occurredAt)}</td>
                <td className={tdChuan + ' max-w-[220px] truncate text-slate-500'} title={r.note ?? ''}>{r.note ?? '—'}</td>
                <td className={tdChuan + ' text-center'}>
                  {canManage && (
                    <Button variant="confirm" size="xs" onClick={() => setRefundRow(r)} icon={<HandCoins className="h-3.5 w-3.5" />}>Hoàn tay</Button>
                  )}
                </td>
              </tr>
            ))}
            {/* HÀNG ĐỆM — chừa chỗ cho hàng TỔNG ghim đáy. */}
            <tr aria-hidden className="h-full"><td colSpan={SO_COT} className="h-9" /></tr>
          </tbody>
          <tfoot className="sticky bottom-0 z-10">
            <tr className="border-t-2 border-brand">
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={4}>TỔNG {rows.length} cọc kẹt</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(rows.reduce((s, r) => s + r.amount, 0))}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(rows.reduce((s, r) => s + r.refunded, 0))}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-danger'}>{tienBang(totalRemaining)}</td>
              <td className={tdTongChuan} colSpan={4} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>

      {refundRow && (
        <RefundManualModal
          row={refundRow}
          onClose={() => setRefundRow(null)}
          onDone={() => { setRefundRow(null); void load(); }}
        />
      )}
    </div>
  );
}

/** Ngày hôm nay YYYY-MM-DD (local) cho input[type=date]. */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function RefundManualModal({ row, onClose, onDone }: { row: DepositManualRefundRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const toast = useToast();
  const [funds, setFunds] = useState<FundDto[]>([]);
  const [fundId, setFundId] = useState('');
  const [method, setMethod] = useState<'CK' | 'CASH'>('CK'); // mặc định CK (hoàn theo bill chuyển khoản)
  const [occurredAt, setOccurredAt] = useState(todayStr());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Tái dùng ĐÚNG fund-picker của recall/CashEntry: fundList lọc active.
  useEffect(() => {
    void window.api.fundList({}).then((r) => { if (r.ok && r.data) setFunds(r.data.filter((f) => f.active)); });
  }, []);

  async function save(): Promise<void> {
    if (!fundId) return toast.alert('Phải chọn quỹ CHI để hoàn cọc (theo bill chuyển khoản).', 'Thiếu quỹ');
    setBusy(true);
    const input: RefundDepositManualInput = {
      fundId: Number(fundId),
      method,
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
      note: note.trim() || null
    };
    const res = await window.api.refundDepositManual(row.depositId, input);
    setBusy(false);
    if (res.ok) { toast.success(res.message ?? 'Đã hoàn cọc'); onDone(); }
    else toast.alert(res.message ?? 'Hoàn cọc thất bại', 'Không hoàn được cọc');
  }

  return (
    <Modal title={`Hoàn cọc tay — ${row.code ?? row.depositId}`} onClose={onClose} width="max-w-md" onSubmit={() => void save()}>
      <div className="mb-3 rounded-md bg-appbg px-3 py-2 text-sm text-slate-600">
        Khách <b>{row.customerName ?? `#${row.customerId}`}</b> · máy <b>{row.deviceSerial ?? '—'}</b> ({deviceStatusLabel(row.deviceStatus)}) ·
        còn lại <b className="text-danger">{money(row.remaining)}</b>. Sẽ tạo phiếu chi hoàn cọc vào quỹ đã chọn.
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quỹ chi hoàn" required hint="Theo bill chuyển khoản.">
          <select className={inputCls} value={fundId} onChange={(e) => setFundId(e.target.value)}>
            <option value="">— Chọn quỹ —</option>
            {funds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
        <Field label="Hình thức" required>
          <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value === 'CASH' ? 'CASH' : 'CK')}>
            <option value="CK">Chuyển khoản</option>
            <option value="CASH">Tiền mặt</option>
          </select>
        </Field>
        <Field label="Ngày" required><input className={inputCls} type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} /></Field>
      </div>
      <Field label="Ghi chú"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: hoàn theo bill CK ngày…" /></Field>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={save} disabled={busy || !fundId} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />}>Hoàn {money(row.remaining)}</Button>
      </div>
    </Modal>
  );
}
