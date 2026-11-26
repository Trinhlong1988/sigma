// Công nợ mua thiết bị (Admin Demo 12/7): khách mua máy/TID còn nợ → thu tiền dần.
// Nguồn: deviceSaleReceivables (tổng theo khách) + deviceSaleList (chi tiết từng đơn) + deviceSaleCollect (thu).
import { Fragment, useEffect, useState } from 'react';
import { Loader2, Banknote, ChevronDown, ChevronRight, HardDrive, CreditCard, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, groupDigits } from '@sigma/shared';
import type { CustomerDeviceReceivable, DeviceSaleDto, FundDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { Modal } from '../components/Modal.js';
import { Field, inputCls } from '../components/Field.js';
import { StatBar } from '../components/StatBar.js';
import { Button } from '../components/Button.js';
// MẪU CHỐT 6/11 — kiểu bảng lấy TỪ MODULE DÙNG CHUNG, cấm chép chuỗi class vào trang.
import { thChuan, tdChuan, tdTongChuan, tdTien, trChuan, KhungBang } from '../components/BangChuan.js';

function money(n: number): string {
  const sign = n < 0 ? '−' : '';
  return sign + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
/** SỐ CỘT của bảng — dùng chung cho hàng rỗng / hàng mở rộng / hàng đệm / tfoot (§1). */
const SO_COT = 5;

export function DeviceReceivablePage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const canCollect = hasPermission(user, 'DEVICE_SALE_MANAGE'); // thu tiền = thao tác tiền
  const [rows, setRows] = useState<CustomerDeviceReceivable[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCust, setOpenCust] = useState<number | null>(null);
  const [sales, setSales] = useState<DeviceSaleDto[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [collectSale, setCollectSale] = useState<DeviceSaleDto | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.deviceSaleReceivables();
    if (res.ok && res.data) setRows(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleCust(customerId: number): Promise<void> {
    if (openCust === customerId) {
      setOpenCust(null);
      return;
    }
    setOpenCust(customerId);
    setSalesLoading(true);
    const res = await window.api.deviceSaleList({ customerId, onlyDebt: true });
    if (res.ok && res.data) setSales(res.data);
    else if (res.message) toast.alert(res.message);
    setSalesLoading(false);
  }

  const totalRemaining = rows.reduce((s, r) => s + r.remaining, 0);
  const totalSale = rows.reduce((s, r) => s + r.totalSale, 0);

  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-800">Công nợ mua thiết bị</h3>
          <p className="text-sm text-slate-500">Khách mua máy POS / TID còn nợ. Thu dần vào quỹ; doanh thu đã ghi nhận đủ lúc bán.</p>
        </div>
        <Button data-nut="lammoi" variant="soft" title="Tải lại" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reload()}>Làm mới</Button>
      </div>

      <StatBar
        items={[
          { label: 'Khách còn nợ', value: rows.length },
          { label: 'Tổng đã bán (còn nợ)', value: money(totalSale) + ' đ', tone: 'bg-brand/10 text-brand' },
          { label: 'Còn phải thu', value: money(totalRemaining) + ' đ', tone: 'bg-amber-500/10 text-amber-600', icon: <Banknote className="h-4 w-4" /> }
        ]}
      />

      {/* MẪU CHỐT 6/11 — KhungBang dùng chung. Trạng thái "đang tải" / "rỗng" nay là DÒNG TRONG BẢNG
          (trước đây thay cả bảng ⇒ bài kiểm cột không có gì để đo và tiêu đề biến mất). */}
      <KhungBang>
        <table className="h-full w-full min-w-[780px] text-xs">
            <thead className="sticky top-0 z-20 bg-slate-200">
              <tr>
                <th className={thChuan + ' w-[300px]'}>Khách hàng</th>
                <th className={thChuan + ' w-[90px]'}>Số đơn</th>
                <th className={thChuan + ' w-[126px] min-w-[126px]'}>Tổng bán</th>
                <th className={thChuan + ' w-[126px] min-w-[126px]'}>Đã thu</th>
                <th className={thChuan + ' w-[126px] min-w-[126px]'}>Còn nợ</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={SO_COT} className="px-4 py-10 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={SO_COT} className="px-4 py-10 text-center text-slate-400">Không có khách nào còn nợ mua thiết bị.</td></tr>}
              {!loading && rows.map((r, i) => (
                <Fragment key={r.customerId}>
                  <tr className={trChuan(i) + ' cursor-pointer'} onClick={() => void toggleCust(r.customerId)}>
                    <td className={tdChuan + ' font-medium text-slate-700'}>
                      <span className="inline-flex items-center gap-1.5">
                        {openCust === r.customerId ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                        {r.customerName ?? `#${r.customerId}`}
                      </span>
                    </td>
                    <td className={tdChuan + ' text-center tabular-nums text-slate-600'}>{r.saleCount}</td>
                    {/* 3 cột tiền: căn phải · tabular-nums · text-slate-800 · KHÔNG in đậm (§2). */}
                    <td className={tdTien}>{money(r.totalSale)}</td>
                    <td className={tdTien}>{money(r.totalPaid)}</td>
                    <td className={tdTien}>{money(r.remaining)}</td>
                  </tr>
                  {openCust === r.customerId && (
                    <tr>
                      <td colSpan={SO_COT} className="bg-appbg/40 px-4 py-3">
                        {salesLoading ? (
                          <div className="flex items-center gap-2 py-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải chi tiết…</div>
                        ) : sales.length === 0 ? (
                          <div className="py-2 text-sm text-slate-400">Không có đơn còn nợ.</div>
                        ) : (
                          <div className="space-y-2">
                            {sales.map((s) => (
                              <div key={s.id} className="flex items-center justify-between rounded-md border border-line bg-white px-3 py-2">
                                <div className="flex items-center gap-2 text-sm">
                                  {s.saleKind === 'TID' ? <CreditCard className="h-4 w-4 text-brand" /> : <HardDrive className="h-4 w-4 text-amber-600" />}
                                  <span className="font-medium text-slate-700">{s.code ?? '—'}</span>
                                  <span className="text-slate-500">{s.saleKind === 'TID' ? `TID ${s.tid ?? ''}` : `Máy ${s.deviceSerial ?? ''}`}</span>
                                </div>
                                <div className="flex items-center gap-4 text-sm tabular-nums">
                                  <span className="text-slate-500">Bán <b className="text-slate-700">{money(s.salePrice)}</b></span>
                                  <span className="text-emerald-600">Thu {money(s.paid)}</span>
                                  <span className="font-semibold text-amber-600">Nợ {money(s.remaining)}</span>
                                  {canCollect && (
                                    <Button variant="confirm" size="xs" icon={<Banknote className="h-3.5 w-3.5" />} onClick={() => setCollectSale(s)}>Thu tiền</Button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {/* HÀNG ĐỆM — chừa chỗ cho hàng TỔNG ghim đáy. */}
              <tr aria-hidden className="h-full"><td colSpan={SO_COT} className="h-9" /></tr>
            </tbody>
            <tfoot className="sticky bottom-0 z-10">
              <tr className="border-t-2 border-brand">
                <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={2}>TỔNG {rows.length} khách còn nợ</td>
                <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{money(totalSale)}</td>
                <td className={tdTongChuan + ' text-right font-bold tabular-nums text-emerald-600'}>{money(rows.reduce((s, r) => s + r.totalPaid, 0))}</td>
                <td className={tdTongChuan + ' text-right font-bold tabular-nums text-amber-600'}>{money(totalRemaining)}</td>
              </tr>
            </tfoot>
          </table>
      </KhungBang>

      {collectSale && (
        <CollectModal
          sale={collectSale}
          onClose={() => setCollectSale(null)}
          onDone={async () => {
            const cust = collectSale.customerId;
            setCollectSale(null);
            await reload();
            // Cập nhật lại chi tiết đang mở (nếu cùng khách).
            if (openCust === cust) {
              setSalesLoading(true);
              const res = await window.api.deviceSaleList({ customerId: cust, onlyDebt: true });
              if (res.ok && res.data) setSales(res.data);
              setSalesLoading(false);
            }
          }}
        />
      )}
    </div>
  );
}

/** Thu tiền cho 1 đơn bán thiết bị còn nợ. */
function CollectModal({ sale, onClose, onDone }: { sale: DeviceSaleDto; onClose: () => void; onDone: () => void }): JSX.Element {
  const toast = useToast();
  const [funds, setFunds] = useState<FundDto[]>([]);
  const [amount, setAmount] = useState(String(sale.remaining));
  const [fundId, setFundId] = useState('');
  const [method, setMethod] = useState('CASH');
  const [entryDate, setEntryDate] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.fundList({ active: true }).then((r) => r.ok && r.data && setFunds(r.data));
  }, []);

  const amt = Number(amount) || 0;

  async function submit(): Promise<void> {
    if (!(amt > 0)) return toast.alert('Số tiền thu phải > 0.', 'Số tiền không hợp lệ');
    if (amt > sale.remaining) return toast.alert(`Chỉ còn nợ ${money(sale.remaining)} đ. Không thu vượt.`, 'Vượt công nợ');
    if (!fundId) return toast.alert('Phải chọn quỹ nhận tiền.', 'Thiếu quỹ');
    setBusy(true);
    const res = await window.api.deviceSaleCollect({
      deviceSaleId: sale.id, amount: amt, fundId: Number(fundId), method,
      entryDate: entryDate ? new Date(entryDate).toISOString() : null
    });
    setBusy(false);
    if (res.ok) { toast.success(`Đã thu ${money(amt)} đ cho đơn ${sale.code ?? sale.id}`); onDone(); }
    else toast.alert(res.message ?? 'Thu tiền thất bại', 'Không thu được');
  }

  return (
    <Modal title={`Thu tiền · ${sale.code ?? ''}`} onClose={onClose} width="max-w-md">
      <div className="mb-3 rounded-md bg-appbg px-3 py-2 text-sm text-slate-600">
        {sale.saleKind === 'TID' ? `TID ${sale.tid ?? ''}` : `Máy ${sale.deviceSerial ?? ''}`} · {sale.customerName ?? ''}
        <div className="mt-1 flex gap-4 text-xs tabular-nums">
          <span>Giá bán: <b>{money(sale.salePrice)}</b></span>
          <span className="text-emerald-600">Đã thu: {money(sale.paid)}</span>
          <span className="font-semibold text-amber-600">Còn nợ: {money(sale.remaining)}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Số tiền thu (VND)" required>
          <input className={inputCls + ' text-right tabular-nums'} inputMode="numeric" value={groupDigits(amount)} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} autoFocus />
        </Field>
        <Field label="Quỹ nhận" required>
          <select className={inputCls} value={fundId} onChange={(e) => setFundId(e.target.value)}>
            <option value="">— Chọn quỹ —</option>
            {funds.map((f) => <option key={f.id} value={f.id}>{f.code} · {f.name}</option>)}
          </select>
        </Field>
        <Field label="Hình thức">
          <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="CASH">Tiền mặt</option>
            <option value="CK">Chuyển khoản</option>
          </select>
        </Field>
        <Field label="Ngày thu" hint="Bỏ trống = hiện tại">
          <input type="datetime-local" className={inputCls} value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
        </Field>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="soft" onClick={onClose}>Hủy</Button>
        <Button variant="confirm" onClick={submit} disabled={busy} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Thu tiền</Button>
      </div>
    </Modal>
  );
}
