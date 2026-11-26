// PHASE H2-core — Thu–Chi: Trang Báo cáo thu – chi (§F). FilterBar từ ngày → đến ngày + danh mục/quỹ;
// bảng phiếu POSTED + dòng tổng THU / tổng CHI / chênh lệch. (Đầy đủ hơn ở H6.)
import { useEffect, useState, useRef } from 'react';
import { Loader2, Download, BarChart3, ArrowDownCircle, ArrowUpCircle, Scale } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { fmtDate } from '@sigma/shared';
import type { CashEntryDto, CashflowSummary, EntryCategoryLite, FundDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { FilterBar } from '../components/FilterBar.js';
import { Button } from '../components/Button.js';
import { StatBar } from '../components/StatBar.js';
import { statusTone } from '../components/StatusPill.js';
import { exportCsv } from '../lib/exportCsv.js';
// MẪU CHỐT 6/11 — kiểu bảng lấy TỪ MODULE DÙNG CHUNG, cấm chép chuỗi class vào trang.
import { thChuan, tdChuan, tdTongChuan, tdTien, trChuan, KhungBang } from '../components/BangChuan.js';

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
const SO_COT = 7;

export function CashflowReportPage({ user: _user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<CashEntryDto[]>([]);
  const [summary, setSummary] = useState<CashflowSummary>({ count: 0, totalThu: 0, totalChi: 0, net: 0 });
  const [loading, setLoading] = useState(true);
  const [fKind, setFKind] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [fFund, setFFund] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [cats, setCats] = useState<EntryCategoryLite[]>([]);
  const [funds, setFunds] = useState<FundDto[]>([]);

  async function loadRefs(): Promise<void> {
    const [c, f] = await Promise.all([window.api.cashEntryCategoryLite(), window.api.fundList({})]);
    if (c.ok && c.data) setCats(c.data);
    if (f.ok && f.data) setFunds(f.data);
  }
  // [VÁ 6/11] "Xóa lọc" trước đây dùng setTimeout(reload, 0) ⇒ chạy đúng CLOSURE CŨ nên vẫn gửi bộ
  // lọc CŨ lên máy chủ (đo thật: gõ ZZZTEST, bấm Xóa lọc, máy chủ vẫn nhận search="ZZZTEST").
  // Giữ bản MỚI NHẤT của reload trong ref rồi gọi qua ref — state đã commit xong mới gọi.
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => void reload();

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.cashEntryReport({
      kind: fKind || undefined,
      categoryId: fCategory ? Number(fCategory) : undefined,
      fundId: fFund ? Number(fFund) : undefined,
      fromDate: fFrom || undefined,
      toDate: fTo || undefined
    });
    if (res.ok && res.data) { setRows(res.data); setSummary(res.summary ?? { count: 0, totalThu: 0, totalChi: 0, net: 0 }); }
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void loadRefs(); }, []);
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [fKind, fCategory, fFund]);

  const catOptions = cats.filter((c) => !fKind || c.kind === fKind);

  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      <div className="mb-4 shrink-0">
        <h2 className="text-lg font-semibold text-slate-800">Báo Cáo Thu – Chi</h2>
        <p className="text-sm text-slate-500">Dòng tiền theo khoảng ngày (chỉ tính phiếu đã ghi). Lọc theo danh mục / quỹ để đối chiếu.</p>
      </div>

      <StatBar items={[
        { label: 'Số phiếu', value: summary.count, icon: <BarChart3 className="h-4 w-4" /> },
        { label: 'Tổng thu', value: money(summary.totalThu), icon: <ArrowDownCircle className="h-4 w-4" />, tone: statusTone('ACTIVE') },
        { label: 'Tổng chi', value: money(summary.totalChi), icon: <ArrowUpCircle className="h-4 w-4" />, tone: 'bg-warning/10 text-warning' },
        { label: 'Chênh lệch (thu − chi)', value: money(summary.net), icon: <Scale className="h-4 w-4" />, tone: summary.net >= 0 ? statusTone('ACTIVE') : 'bg-danger/10 text-danger' }
      ]} />

      <FilterBar search="" onSearch={() => undefined} searchPlaceholder="—"
        fromDate={fFrom} toDate={fTo} onFromDate={setFFrom} onToDate={setFTo}
        selects={[
          { key: 'k', placeholder: 'Thu & Chi', value: fKind, options: [{ value: 'THU', label: 'Chỉ thu' }, { value: 'CHI', label: 'Chỉ chi' }], onChange: (v) => { setFKind(v); setFCategory(''); } },
          { key: 'c', placeholder: 'Tất cả danh mục', value: fCategory, options: catOptions.map((c) => ({ value: String(c.id), label: `${c.kind === 'THU' ? '[Thu] ' : '[Chi] '}${c.name}` })), onChange: setFCategory },
          { key: 'f', placeholder: 'Tất cả quỹ', value: fFund, options: funds.map((f) => ({ value: String(f.id), label: f.name })), onChange: setFFund }
        ]}
        onApply={reload} onReset={() => { setFKind(''); setFCategory(''); setFFund(''); setFFrom(''); setFTo(''); setTimeout(() => reloadRef.current(), 0); }}
        coChuNho locPhai />

      <div className="mb-3 flex shrink-0 items-center justify-between">
        <div className="text-sm text-slate-500">{rows.length} phiếu{fFrom || fTo ? ` · ${fFrom || '…'} → ${fTo || '…'}` : ''}</div>
        <Button data-nut="excel" variant="confirm" icon={<Download className="h-4 w-4" />} onClick={() => exportCsv('bao_cao_thu_chi', ['Mã', 'Ngày', 'Loại', 'Danh mục', 'Quỹ', 'Số tiền', 'Hình thức', 'Ghi chú'], rows.map((r) => [r.code ?? '', fmtDate(r.entryDate), r.kind === 'THU' ? 'Thu' : 'Chi', r.categoryName ?? '', r.fundName ?? '', Number(r.amount), r.method === 'CK' ? 'Chuyển khoản' : 'Tiền mặt', r.note ?? '']), undefined, undefined, { cotTien: ['Số tiền'] })} /* [B299] */>Xuất Excel</Button>
      </div>

      {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên, hàng TỔNG ghim đáy; không ẩn cột theo
          breakpoint (thiếu chỗ thì cuộn ngang bằng min-w trên <table>). */}
      <KhungBang>
        <table className="h-full w-full min-w-[920px] text-xs">
          <thead className="sticky top-0 z-20 bg-slate-200">
            <tr>
              <th className={thChuan + ' w-[104px]'}>Mã</th>
              <th className={thChuan + ' w-[92px]'}>Ngày</th>
              <th className={thChuan + ' w-[70px]'}>Loại</th>
              <th className={thChuan + ' w-[200px]'}>Danh mục</th>
              <th className={thChuan + ' w-[160px]'}>Quỹ</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Số tiền</th>
              <th className={thChuan + ' w-[120px]'}>Hình thức</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={SO_COT} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={SO_COT} className="px-4 py-10 text-center text-slate-400"><BarChart3 className="mx-auto mb-2 h-6 w-6" /> Không có phiếu trong khoảng lọc.</td></tr>}
            {!loading && rows.map((r, i) => (
              <tr key={r.id} className={trChuan(i)}>
                <td className={tdChuan + ' font-mono text-slate-500'}>{r.code}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{fmtDate(r.entryDate)}</td>
                <td className={tdChuan + ' text-center'}>{r.kind === 'THU' ? <span className="text-success">Thu</span> : <span className="text-warning">Chi</span>}</td>
                <td className={tdChuan + ' text-slate-700'}>{r.categoryName ?? '—'}</td>
                <td className={tdChuan + ' text-slate-600'}>{r.fundName ?? '—'}</td>
                {/* Cột tiền: căn phải · tabular-nums · text-slate-800 · KHÔNG in đậm (§2). Chi mang dấu −. */}
                <td className={tdTien}>{r.kind === 'THU' ? '' : '−'}{tienBang(r.amount)}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{r.method === 'CK' ? 'Chuyển khoản' : 'Tiền mặt'}</td>
              </tr>
            ))}
            {/* HÀNG ĐỆM — chừa chỗ cho hàng TỔNG ghim đáy, nếu không nó che mất dòng cuối. */}
            <tr aria-hidden className="h-full"><td colSpan={SO_COT} className="h-9" /></tr>
          </tbody>
          <tfoot className="sticky bottom-0 z-10">
            <tr className="border-t-2 border-brand">
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={3}>TỔNG {summary.count} phiếu</td>
              <td className={tdTongChuan + ' text-right tabular-nums text-success'} title="Tổng thu trong kỳ">Thu {tienBang(summary.totalThu)}</td>
              <td className={tdTongChuan + ' text-right tabular-nums text-warning'} title="Tổng chi trong kỳ">Chi {tienBang(summary.totalChi)}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums ' + (summary.net >= 0 ? 'text-brand' : 'text-danger')} title="Chênh lệch thu − chi">{tienBang(summary.net)}</td>
              <td className={tdTongChuan} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>
    </div>
  );
}
