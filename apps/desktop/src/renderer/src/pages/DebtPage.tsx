import { useEffect, useState } from 'react';
import { Loader2, Coins, Handshake, Users, CheckCircle2, Download, FilterX, RefreshCw, HandCoins, Tag, ShieldAlert, ThumbsUp, AlertTriangle } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate, groupDigits } from '@sigma/shared';
import type { DebtSummary, DebtOpenTxnDto, ConfigTidDto, CustomerDto, LiteRef, FundDto, EntryCategoryLite, CreateDebtReceiptInput, DebtByQualityResult } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { inputCls, Field } from '../components/Field.js';
import { Button } from '../components/Button.js';
import { Modal } from '../components/Modal.js';
import { StatBar } from '../components/StatBar.js';
import { thChuan, tdChuan, tdTongChuan, tdTien, trChuan, KhungBang } from '../components/BangChuan.js';
import { exportCsv } from '../lib/exportCsv.js';

/** Nhóm 3 chữ số, KHÔNG ký hiệu tiền — dùng TRONG BẢNG (mẫu chốt 6/11 §2 bỏ ký tự đ).
 *  Dùng `groupDigits` của @sigma/shared (nguồn duy nhất), KHÔNG toLocaleString. */
function soTien(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? '−' : '') + groupDigits(Math.abs(v).toString());
}
/** VND có ký hiệu đ — dùng NGOÀI bảng (thẻ KPI, cảnh báo, bảng nổi). */
function money(n: number): string {
  return soTien(n) + 'đ';
}

/** MẪU CHỐT 6/11: trang nằm trong `<main overflow-auto>` nên khung bảng phải KHÓA chiều cao để
 *  `overflow-auto` tạo khung cuộn thật — nhờ đó tiêu đề `sticky top-0` và hàng TỔNG `sticky bottom-0`
 *  ghim TRONG bảng. Trang này có 2 hàng KPI + thanh lọc nên khóa 24rem. */
const CAO_KHUNG = 'max-h-[calc(100vh-24rem)] bg-white shadow-sm';

const emptyDebt: DebtSummary = { count: 0, debtPartner: 0, debtSell: 0, debtTotal: 0 };
const emptyByQuality: DebtByQualityResult = {
  GOOD: { count: 0, debtPartner: 0, debtSell: 0, debtTotal: 0 },
  HARD: { count: 0, debtPartner: 0, debtSell: 0, debtTotal: 0 },
  BAD: { count: 0, debtPartner: 0, debtSell: 0, debtTotal: 0 },
  UNCLASSIFIED: { count: 0, debtPartner: 0, debtSell: 0, debtTotal: 0 }
};

/** Badge màu cho 3 mức chất lượng công nợ (BAD = ĐỎ cảnh báo). */
function qualityBadge(q: string | null): JSX.Element {
  if (q === 'GOOD') return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600">Dễ thu hồi</span>;
  if (q === 'HARD') return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600">Khó thu hồi</span>;
  if (q === 'BAD') return <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700"><AlertTriangle className="h-3 w-3" /> Không thu hồi</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-400">Chưa phân loại</span>;
}

export function DebtPage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  // H5 — KHÔNG còn toggle "đã thu" thủ công; thu công nợ = lập phiếu Thu công nợ (CASHENTRY_CREATE).
  const canReceipt = hasPermission(user, 'CASHENTRY_CREATE');
  // H2b — phân loại chất lượng công nợ + ghi giảm nợ xấu.
  const canClassify = hasPermission(user, 'DEBT_CLASSIFY');
  const canWriteOff = hasPermission(user, 'DEBT_WRITEOFF');
  const [rows, setRows] = useState<DebtOpenTxnDto[]>([]);
  const [debt, setDebt] = useState<DebtSummary>(emptyDebt);
  const [byQuality, setByQuality] = useState<DebtByQualityResult>(emptyByQuality);
  const [loading, setLoading] = useState(true);

  const [fBank, setFBank] = useState('');
  const [fPartner, setFPartner] = useState('');
  const [fCustomer, setFCustomer] = useState('');
  const [fTid, setFTid] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [fQuality, setFQuality] = useState(''); // '' | GOOD | HARD | BAD | NONE(chưa phân loại)

  // Modal phân loại / ghi giảm.
  const [classifyGd, setClassifyGd] = useState<DebtOpenTxnDto | null>(null);
  const [writeOffGd, setWriteOffGd] = useState<DebtOpenTxnDto | null>(null);

  const [tids, setTids] = useState<ConfigTidDto[]>([]);
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [banks, setBanks] = useState<LiteRef[]>([]);
  const [partners, setPartners] = useState<{ id: number; name: string }[]>([]);

  // Dữ liệu form Thu công nợ.
  const [funds, setFunds] = useState<FundDto[]>([]);
  const [debtCats, setDebtCats] = useState<EntryCategoryLite[]>([]);
  const [receiptGd, setReceiptGd] = useState<DebtOpenTxnDto | null>(null);

  function baseFilter(): Record<string, unknown> {
    return {
      bankId: fBank ? Number(fBank) : undefined,
      partnerId: fPartner ? Number(fPartner) : undefined,
      customerId: fCustomer ? Number(fCustomer) : undefined,
      tidId: fTid ? Number(fTid) : undefined,
      dateFrom: fFrom ? new Date(fFrom + 'T00:00:00').toISOString() : undefined,
      dateTo: fTo ? new Date(fTo + 'T23:59:59.999').toISOString() : undefined
    };
  }

  async function loadRefs(): Promise<void> {
    const [t, c, b, p] = await Promise.all([
      window.api.tidConfigList({}),
      window.api.customerList({}),
      window.api.bankLite(),
      window.api.partnerList({})
    ]);
    if (t.ok && t.data) setTids(t.data);
    if (c.ok && c.data) setCustomers(c.data);
    if (b.ok && b.data) setBanks(b.data);
    if (p.ok && p.data) setPartners(p.data.map((x: { id: number; name: string }) => ({ id: x.id, name: x.name })));
    // Dữ liệu form Thu công nợ chỉ cần khi có quyền lập phiếu.
    if (canReceipt) {
      const [f, cat] = await Promise.all([window.api.fundList({ active: true }), window.api.cashEntryCategoryLite()]);
      if (f.ok && f.data) setFunds(f.data);
      if (cat.ok && cat.data) setDebtCats(cat.data.filter((x) => x.sourceKind === 'DEBT_CUSTOMER' || x.sourceKind === 'DEBT_PARTNER'));
    }
  }

  async function reload(): Promise<void> {
    setLoading(true);
    try {
      const [list, ds, bq] = await Promise.all([
        window.api.debtOpenTransactions(baseFilter()),
        window.api.debtSummary(baseFilter()),
        window.api.debtByQuality(baseFilter())
      ]);
      if (list.ok) setRows(list.data ?? []);
      else if (list.message) toast.alert(list.message);
      if (ds.ok && ds.data) setDebt(ds.data);
      else if (ds.message) toast.alert(ds.message);
      if (bq.ok && bq.data) setByQuality(bq.data);
    } catch (e) {
      // FE-03 (Codex 15/7): 1 IPC reject không được để spinner treo mãi.
      toast.alert(e instanceof Error ? e.message : 'Không tải được dữ liệu (mất kết nối máy chủ?).', 'Lỗi tải dữ liệu');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadRefs(); }, []);
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  function resetFilter(): void {
    setFBank(''); setFPartner(''); setFCustomer(''); setFTid(''); setFFrom(''); setFTo(''); setFQuality('');
    setTimeout(() => void reload(), 0);
  }

  // Lọc client-side theo mức chất lượng (backend đã tính StatBar/summary theo các bộ lọc khác).
  const visibleRows = fQuality === ''
    ? rows
    : fQuality === 'NONE'
      ? rows.filter((r) => r.debtQuality == null)
      : rows.filter((r) => r.debtQuality === fQuality);
  const hasActions = canReceipt || canClassify || canWriteOff;
  const colSpan = 9 + (hasActions ? 1 : 0); // 8 cột gốc + Chất lượng (+ Thao tác)

  return (
    // MẪU CHỐT 6/11: `data-nut-vuong` ở thẻ bọc NGOÀI CÙNG để trang ăn luật nút/thanh cuộn/màu của mau-moi.css.
    <div data-nut-vuong data-trang-full>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-800">Quản Lý Công Nợ</h2>
        <p className="text-sm text-slate-500">Công nợ CÒN LẠI = 2 khoản chênh (đối tác + bán) trừ đi phần đã thu qua phiếu Thu công nợ. Số liệu tính net theo từng khoản — không đếm trùng.</p>
      </div>

      {/* KPI công nợ — GIÁ TRỊ NET TỪ debtSummary (đếm ở MAIN trên toàn bộ theo bộ lọc). StatBar dùng CHUNG mọi trang. */}
      <StatBar
        items={[
          { icon: <Coins className="h-4 w-4" />, tone: 'bg-brand-tint text-brand', label: 'Tổng công nợ còn lại', value: money(debt.debtTotal), sub: `${debt.count} giao dịch còn nợ` },
          { icon: <Handshake className="h-4 w-4" />, tone: 'bg-indigo-50 text-indigo-500', label: 'Nợ đối tác (còn lại)', value: money(debt.debtPartner) },
          { icon: <Users className="h-4 w-4" />, tone: 'bg-emerald-50 text-emerald-500', label: 'Nợ khách/bán (còn lại)', value: money(debt.debtSell) },
          { icon: <HandCoins className="h-4 w-4" />, tone: 'bg-slate-100 text-slate-500', label: 'Thu công nợ', value: canReceipt ? 'Lập phiếu' : 'Chỉ xem', sub: canReceipt ? 'Bấm “Thu” ở từng dòng' : undefined }
        ]}
      />

      {/* H2b — StatBar chất lượng công nợ (đếm net theo mức). BAD = cảnh báo ĐỎ. */}
      <StatBar
        items={[
          { icon: <ThumbsUp className="h-4 w-4" />, tone: 'bg-emerald-50 text-emerald-500', label: 'Dễ thu hồi', value: money(byQuality.GOOD.debtTotal), sub: `${byQuality.GOOD.count} GD` },
          { icon: <Tag className="h-4 w-4" />, tone: 'bg-amber-50 text-amber-500', label: 'Khó thu hồi', value: money(byQuality.HARD.debtTotal), sub: `${byQuality.HARD.count} GD` },
          { icon: <ShieldAlert className="h-4 w-4" />, tone: 'bg-rose-100 text-rose-600', label: 'Không thu hồi (BAD)', value: money(byQuality.BAD.debtTotal), sub: `${byQuality.BAD.count} GD` },
          { icon: <Coins className="h-4 w-4" />, tone: 'bg-slate-100 text-slate-500', label: 'Chưa phân loại', value: money(byQuality.UNCLASSIFIED.debtTotal), sub: `${byQuality.UNCLASSIFIED.count} GD` }
        ]}
      />

      {/* Dashboard cảnh báo: nợ BAD phồng lợi nhuận accrual (M1). */}
      {byQuality.BAD.debtTotal > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <b>Cảnh báo nợ xấu: {money(byQuality.BAD.debtTotal)}</b> ({byQuality.BAD.count} giao dịch “Không thu hồi”).
            Lợi nhuận accrual ĐÃ gồm doanh thu các khoản này (ghi nhận theo ngày GD, chưa trích lập){canWriteOff ? ' — có thể “Ghi giảm nợ xấu” để trừ thẳng lợi nhuận (không hoàn tác)' : ''}.
          </div>
        </div>
      )}

      {/* THANH LỌC — MỘT HÀNG, không xuống dòng, cỡ chữ nhỏ (text-xs = "coChuNho"), nút Lọc đẩy sang MÉP PHẢI
          bằng ô đệm flex-1 ("locPhai"). Chưa chuyển sang FilterBar dùng chung được vì FilterBar BẮT BUỘC có ô
          tìm kiếm, mà công nợ KHÔNG có trường tìm kiếm nào ở API (debtOpenTransactions chỉ nhận bank/đối tác/
          khách/TID/ngày) — thêm ô tìm kiếm là THÊM LOGIC, đợt này chỉ đồng bộ giao diện. Đề xuất bổ sung prop
          `hideSearch` cho FilterBar đã ghi trong báo cáo.
          Hàng dài hơn cửa sổ thì CUỘN NGANG tại chỗ (overflow-x-auto), KHÔNG xuống dòng, KHÔNG ẩn ô lọc nào. */}
      <div className="mb-3 overflow-x-auto rounded-xl border border-line bg-white p-3 shadow-sm">
        <div className="flex flex-nowrap items-center gap-1.5 text-xs">
          <select className={inputCls + ' w-40 text-xs'} title="TID" aria-label="TID" value={fTid} onChange={(e) => setFTid(e.target.value)}><option value="">Tất cả TID</option>{tids.map((t) => <option key={t.id} value={t.id}>{t.tid}{t.hkdName ? ` · ${t.hkdName}` : ''}</option>)}</select>
          <select className={inputCls + ' w-36 text-xs'} title="Ngân hàng" aria-label="Ngân hàng" value={fBank} onChange={(e) => setFBank(e.target.value)}><option value="">Tất cả ngân hàng</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select>
          <select className={inputCls + ' w-36 text-xs'} title="Đối tác" aria-label="Đối tác" value={fPartner} onChange={(e) => setFPartner(e.target.value)}><option value="">Tất cả đối tác</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <select className={inputCls + ' w-40 text-xs'} title="Khách hàng" aria-label="Khách hàng" value={fCustomer} onChange={(e) => setFCustomer(e.target.value)}><option value="">Tất cả khách hàng</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.nickname} ({c.fullName})</option>)}</select>
          <span className="shrink-0 text-slate-500">Từ</span>
          <input type="date" className={inputCls + ' text-xs'} aria-label="Từ ngày" value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
          <span className="shrink-0 text-slate-500">đến</span>
          <input type="date" className={inputCls + ' text-xs'} aria-label="Đến ngày" value={fTo} onChange={(e) => setFTo(e.target.value)} />
          <select className={inputCls + ' w-40 text-xs'} title="Chất lượng công nợ" aria-label="Chất lượng" value={fQuality} onChange={(e) => setFQuality(e.target.value)}>
            <option value="">Tất cả mức</option>
            <option value="GOOD">Dễ thu hồi</option>
            <option value="HARD">Khó thu hồi</option>
            <option value="BAD">Không thu hồi (BAD)</option>
            <option value="NONE">Chưa phân loại</option>
          </select>
          <div className="flex-1" />
          {/* Cụm nút cùng thanh: ép CÙNG BỀ NGANG bằng grid auto-cols-fr (mỗi cột = nút rộng nhất) ⇒ bằng
              nhau TUYỆT ĐỐI mà KHÔNG cắt chữ như cách khoá cứng 119px. `data-kiem` để bài kiểm đo được. */}
          <div data-kiem="thanh-cong-cu" className="grid shrink-0 grid-flow-col auto-cols-fr gap-1.5">
            <Button data-nut="loc" variant="confirm" size="sm" onClick={() => void reload()}>Lọc</Button>
            <Button data-nut="xoaloc" variant="soft" size="sm" onClick={resetFilter} title="Xóa toàn bộ bộ lọc, đưa về mặc định" icon={<FilterX className="h-4 w-4" />}>Xóa lọc</Button>
            <Button data-nut="lammoi" variant="soft" size="sm" onClick={() => void reload()} title="Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc)" icon={<RefreshCw className="h-4 w-4" />}>Làm mới</Button>
            <Button data-nut="excel" variant="confirm" size="sm" icon={<Download className="h-4 w-4" />} onClick={() => /* [B299] tiền = SỐ + thêm Tổng còn lại cho khớp màn */ exportCsv('cong_no', ['Mã GD', 'Ngày', 'TID', 'HKD', 'Khách', 'Nợ đối tác còn lại', 'Nợ bán còn lại', 'Tổng còn lại'], rows.map((r) => [r.code ?? '', fmtDate(r.txnDate), r.tid ?? '', r.hkdName ?? '', r.customerName ?? '', Number(r.remainingPartner), Number(r.remainingSell), Number(r.remainingPartner) + Number(r.remainingSell)]), undefined, undefined, { cotTien: ['Nợ đối tác còn lại', 'Nợ bán còn lại', 'Tổng còn lại'] })}>Xuất Excel</Button>
          </div>
        </div>
      </div>

      <KhungBang className={CAO_KHUNG}>
        {/* 9-10 cột, 3 cột tiền dài ⇒ chật ở màn hẹp: CUỘN NGANG bằng min-w, KHÔNG ẩn cột theo breakpoint. */}
        <table className="w-full min-w-[1560px] text-xs">
          <thead className="sticky top-0 z-20 text-xs uppercase tracking-wide shadow-sm">
            <tr>
              <th className={thChuan + ' w-[120px]'}>Mã GD</th>
              <th className={thChuan + ' w-[96px]'}>Ngày</th>
              <th className={thChuan + ' w-[150px]'}>TID · MID</th>
              <th className={thChuan + ' w-[260px]'}>Hộ Kinh Doanh</th>
              <th className={thChuan + ' w-[190px]'}>Khách hàng</th>
              <th className={thChuan + ' w-[170px]'}>Nợ đối tác còn lại</th>
              <th className={thChuan + ' w-[180px]'}>Nợ khách/bán còn lại</th>
              <th className={thChuan + ' w-[160px]'}>Tổng còn lại</th>
              <th className={thChuan + ' w-[150px]'}>Chất lượng</th>
              {hasActions && <th className={thChuan + ' w-[230px]'}>Thao tác</th>}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
            {!loading && visibleRows.length === 0 && <tr><td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-slate-400"><CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-emerald-400" /> Không còn công nợ nào — đã thu hết.</td></tr>}
            {!loading && visibleRows.map((r, i) => (
              // SỌC NGỰA VẰN dùng chung `trChuan(i)`. Dòng nợ XẤU giữ nền ĐỎ NHẠT (ý nghĩa cảnh báo) — đè nền
              // sọc bằng `!bg-rose-50`; đề xuất bổ sung biến thể "cảnh báo" cho `nenDong` đã ghi trong báo cáo.
              <tr key={r.id} className={trChuan(i) + (r.debtQuality === 'BAD' ? ' !bg-rose-50' : '')}>
                <td className={tdChuan + ' text-center font-mono font-medium text-slate-700'}>{r.code ?? '—'}</td>
                <td className={tdChuan + ' text-center tabular-nums text-slate-500'}>{fmtDate(r.txnDate)}</td>
                <td className={tdChuan + ' text-center text-slate-700'}>{r.tid ?? '—'}{r.mid ? <span className="block tabular-nums text-slate-400">{r.mid}</span> : null}</td>
                <td className={tdChuan + ' text-slate-600'} title={r.hkdName ?? ''}>{r.hkdName ?? '—'}</td>
                <td className={tdChuan + ' text-center text-slate-600'}>{r.customerName ?? <span className="text-slate-400">—</span>}</td>
                {/* 3 cột TIỀN: căn phải, tabular-nums, KHÔNG in đậm, bỏ ký tự đ (mẫu chốt 6/11 §2).
                    Giữ màu nghĩa (tím = nợ đối tác, xanh = nợ bán) bằng cách đè màu sau tdTien. */}
                <td className={tdTien + ' !text-indigo-600'}>{soTien(r.remainingPartner)}</td>
                <td className={tdTien + ' !text-emerald-600'}>{soTien(r.remainingSell)}</td>
                <td className={tdTien}>{soTien(r.remainingPartner + r.remainingSell)}</td>
                <td className={tdChuan + ' text-center'}>{qualityBadge(r.debtQuality)}</td>
                {hasActions && (
                  <td className={tdChuan}>
                    <div className="flex items-center justify-center gap-1.5">
                      {canReceipt && (
                        <Button variant="soft" size="xs" onClick={() => setReceiptGd(r)} icon={<HandCoins className="h-3.5 w-3.5" />}>Thu</Button>
                      )}
                      {canClassify && (
                        <Button variant="soft" size="xs" onClick={() => setClassifyGd(r)} icon={<Tag className="h-3.5 w-3.5" />}>Phân loại</Button>
                      )}
                      {canWriteOff && r.debtQuality === 'BAD' && (
                        <Button variant="danger" size="xs" onClick={() => setWriteOffGd(r)} icon={<ShieldAlert className="h-3.5 w-3.5" />}>Ghi giảm</Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {/* HÀNG ĐỆM: chừa 1 hàng để dòng cuối không bị hàng TỔNG ghim đáy che khi cuộn tới đáy. */}
            <tr aria-hidden><td colSpan={colSpan} className="h-9" /></tr>
          </tbody>
          {/* HÀNG TỔNG ghim ĐÁY khung cuộn, LUÔN hiện (kể cả danh sách rỗng → 0) để số tổng không biến mất.
              Nền đặt trên TỪNG <td> (tdTongChuan), KHÔNG trên <tr> — đặt trên <tr> thì sticky hở nền phải. */}
          <tfoot className="sticky bottom-0 z-10">
            <tr className="border-t-2 border-brand">
              <td className={tdTongChuan + ' font-semibold text-brand-deep'} colSpan={5}>TỔNG {debt.count} giao dịch</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-indigo-700'}>{soTien(debt.debtPartner)}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-emerald-700'}>{soTien(debt.debtSell)}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{soTien(debt.debtTotal)}</td>
              <td className={tdTongChuan} colSpan={hasActions ? 2 : 1} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>

      {receiptGd && (
        <DebtReceiptModal
          gd={receiptGd}
          funds={funds}
          debtCats={debtCats}
          onClose={() => setReceiptGd(null)}
          onDone={() => { setReceiptGd(null); void reload(); }}
        />
      )}

      {classifyGd && (
        <ClassifyModal
          gd={classifyGd}
          onClose={() => setClassifyGd(null)}
          onDone={() => { setClassifyGd(null); void reload(); }}
        />
      )}

      {writeOffGd && (
        <WriteOffModal
          gd={writeOffGd}
          onClose={() => setWriteOffGd(null)}
          onDone={() => { setWriteOffGd(null); void reload(); }}
        />
      )}
    </div>
  );
}

/** H2b — Modal phân loại chất lượng công nợ (Dễ / Khó / Không thu hồi) + lý do. */
function ClassifyModal({ gd, onClose, onDone }: { gd: DebtOpenTxnDto; onClose: () => void; onDone: () => void }): JSX.Element {
  const toast = useToast();
  const [quality, setQuality] = useState(gd.debtQuality ?? 'GOOD');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const res = await window.api.debtClassify(gd.id, quality, reason.trim() || undefined);
    setBusy(false);
    if (res.ok) { toast.success('Đã cập nhật phân loại công nợ'); onDone(); }
    else toast.alert(res.message ?? 'Phân loại thất bại', 'Không phân loại được');
  }

  return (
    <Modal title={`Phân loại công nợ · GD ${gd.code ?? '#' + gd.id}`} onClose={onClose} onSubmit={() => void submit()}>
      <div className="space-y-4">
        <div className="rounded-lg bg-appbg/60 px-3 py-2 text-sm text-slate-600">
          Đối tượng: <b>{gd.customerName ?? gd.partnerName ?? '—'}</b> · Tổng còn nợ: <b>{money(gd.remainingPartner + gd.remainingSell)}</b>
        </div>
        <Field label="Mức chất lượng" required>
          <select className={inputCls} value={quality} onChange={(e) => setQuality(e.target.value)}>
            <option value="GOOD">Dễ thu hồi</option>
            <option value="HARD">Khó thu hồi</option>
            <option value="BAD">Không thu hồi (BAD — cảnh báo đỏ)</option>
          </select>
        </Field>
        <Field label="Lý do" hint="Vì sao xếp mức này (khuyến nghị)">
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="VD: khách mất liên lạc, hẹn trả chậm…" />
        </Field>
        {quality === 'BAD' && (
          <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Đánh dấu “Không thu hồi” chỉ gắn CỜ ĐỎ, KHÔNG tự ghi giảm. Muốn trừ vào lợi nhuận, dùng nút “Ghi giảm nợ xấu”.
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="neutral" onClick={onClose}>Hủy</Button>
          <Button variant="confirm" icon={<Tag className="h-4 w-4" />} onClick={submit} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu phân loại'}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** H2b — Modal ghi giảm nợ xấu (write-off): xác nhận mật khẩu + cảnh báo trừ thẳng lợi nhuận, không hoàn tác. */
function WriteOffModal({ gd, onClose, onDone }: { gd: DebtOpenTxnDto; onClose: () => void; onDone: () => void }): JSX.Element {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const netTotal = gd.remainingPartner + gd.remainingSell;

  async function submit(): Promise<void> {
    if (busy) return; // chống ghi giảm nợ xấu 2 lần
    if (!password) { toast.alert('Nhập mật khẩu đăng nhập của bạn để xác nhận.'); return; }
    setBusy(true);
    const res = await window.api.debtWriteOff(gd.id, password);
    setBusy(false);
    if (res.ok) { toast.success('Đã ghi giảm nợ xấu — trừ vào lợi nhuận'); onDone(); }
    else toast.alert(res.message ?? 'Ghi giảm thất bại', 'Không ghi giảm được');
  }

  return (
    <Modal title={`Ghi giảm nợ xấu · GD ${gd.code ?? '#' + gd.id}`} onClose={onClose} onSubmit={() => void submit()}>
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            Ghi giảm <b>{money(netTotal)}</b> công nợ “Không thu hồi” của <b>{gd.customerName ?? gd.partnerName ?? '—'}</b>.
            Hệ thống sinh 1 phiếu chi “Chi phí nợ xấu” và <b>TRỪ THẲNG vào lợi nhuận</b>. Giao dịch sẽ rớt khỏi công nợ.
            <b> Thao tác KHÔNG hoàn tác.</b>
          </div>
        </div>
        <Field label="Mật khẩu đăng nhập (xác nhận)" required>
          <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Nhập mật khẩu của bạn" autoComplete="off" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="neutral" onClick={onClose}>Hủy</Button>
          <Button variant="danger" icon={<ShieldAlert className="h-4 w-4" />} onClick={submit} disabled={busy}>{busy ? 'Đang xử lý…' : 'Xác nhận ghi giảm'}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Modal lập phiếu Thu công nợ cho 1 GD: nhập số thu từng khoản (≤ còn lại) + quỹ/hình thức/ngày. */
function DebtReceiptModal({
  gd, funds, debtCats, onClose, onDone
}: {
  gd: DebtOpenTxnDto;
  funds: FundDto[];
  debtCats: EntryCategoryLite[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const toast = useToast();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const [amtPartner, setAmtPartner] = useState('');
  const [amtSell, setAmtSell] = useState('');
  const [fundId, setFundId] = useState(funds[0]?.id ? String(funds[0].id) : '');
  const [method, setMethod] = useState('CASH');
  const [entryDate, setEntryDate] = useState(todayStr);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  function money(n: number): string {
    return Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ';
  }
  // FIX 3 — side ↔ danh mục PHẢI khớp: SELL ↔ Công nợ khách hàng (DEBT_CUSTOMER, đối tượng = KH);
  // PARTNER ↔ Công nợ đối tác (DEBT_PARTNER, đối tượng = đối tác). 1 phiếu = 1 danh mục nên khi thu CẢ
  // 2 khoản của 1 GD → TÁCH thành 2 phiếu đúng danh mục/đối tượng (nhãn dòng tiền không lệch).
  const customerCat = debtCats.find((c) => c.sourceKind === 'DEBT_CUSTOMER');
  const partnerCat = debtCats.find((c) => c.sourceKind === 'DEBT_PARTNER');

  async function submit(): Promise<void> {
    if (busy) return; // F5 (Admin Demo 11/8) — chống THU NỢ 2 lần khi API chậm >600ms (Modal latch không đủ cho luồng tiền)
    const p = Number(amtPartner), s = Number(amtSell);
    const partnerAmt = amtPartner.trim() && Number.isFinite(p) && p > 0 ? Math.round(p) : 0;
    const sellAmt = amtSell.trim() && Number.isFinite(s) && s > 0 ? Math.round(s) : 0;
    if (partnerAmt === 0 && sellAmt === 0) { toast.alert('Nhập số tiền thu ít nhất 1 khoản (> 0).'); return; }
    if (partnerAmt > gd.remainingPartner) { toast.alert(`Nợ đối tác còn lại chỉ ${money(gd.remainingPartner)}.`); return; }
    if (sellAmt > gd.remainingSell) { toast.alert(`Nợ khách/bán còn lại chỉ ${money(gd.remainingSell)}.`); return; }
    if (!fundId) { toast.alert('Chọn quỹ nhận tiền.'); return; }

    // Dựng tối đa 2 phiếu (mỗi phiếu 1 side ↔ danh mục ↔ đối tượng).
    const receipts: CreateDebtReceiptInput[] = [];
    if (partnerAmt > 0) {
      if (!partnerCat) { toast.alert('Thiếu danh mục Công nợ đối tác hệ thống.'); return; }
      if (gd.partnerId == null) { toast.alert('Giao dịch này không có đối tác để thu công nợ đối tác.'); return; }
      receipts.push({ categoryId: partnerCat.id, fundId: Number(fundId), method, entryDate, partnerId: gd.partnerId, note: note.trim() || undefined, lines: [{ transactionId: gd.id, side: 'PARTNER', amount: partnerAmt }] });
    }
    if (sellAmt > 0) {
      if (!customerCat) { toast.alert('Thiếu danh mục Công nợ khách hàng hệ thống.'); return; }
      if (gd.customerId == null) { toast.alert('Giao dịch này không có khách hàng để thu công nợ khách/bán.'); return; }
      receipts.push({ categoryId: customerCat.id, fundId: Number(fundId), method, entryDate, customerId: gd.customerId, note: note.trim() || undefined, lines: [{ transactionId: gd.id, side: 'SELL', amount: sellAmt }] });
    }

    setBusy(true);
    let done = 0; let failMsg = '';
    for (const r of receipts) {
      const res = await window.api.cashEntryCreateDebtReceipt(r);
      if (res.ok) done++; else { failMsg = res.message ?? 'Lập phiếu thất bại'; break; }
    }
    setBusy(false);
    if (done === receipts.length) { toast.success(receipts.length > 1 ? 'Đã lập 2 phiếu Thu công nợ (đối tác + khách/bán)' : 'Đã lập phiếu Thu công nợ'); onDone(); }
    else { toast.alert(failMsg + (done > 0 ? ` (đã lập ${done} phiếu trước đó)` : ''), 'Không thu được công nợ'); if (done > 0) onDone(); }
  }

  return (
    <Modal title={`Thu công nợ · GD ${gd.code ?? '#' + gd.id}`} onClose={onClose} onSubmit={() => void submit()}>
      <div className="space-y-4">
        <div className="rounded-lg bg-appbg/60 px-3 py-2 text-sm text-slate-600">
          <div>Đối tượng: <b>{gd.customerName ?? gd.partnerName ?? '—'}</b></div>
          <div className="mt-1 flex gap-4 text-xs">
            <span>Nợ đối tác còn lại: <b className="text-indigo-600">{money(gd.remainingPartner)}</b></span>
            <span>Nợ khách/bán còn lại: <b className="text-emerald-600">{money(gd.remainingSell)}</b></span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Thu khoản đối tác" hint={`≤ ${money(gd.remainingPartner)}`}>
            <input className={inputCls} inputMode="numeric" value={groupDigits(amtPartner)} onChange={(e) => setAmtPartner(e.target.value.replace(/[^\d]/g, ''))} disabled={gd.remainingPartner <= 0} placeholder="0" />
          </Field>
          <Field label="Thu khoản khách/bán" hint={`≤ ${money(gd.remainingSell)}`}>
            <input className={inputCls} inputMode="numeric" value={groupDigits(amtSell)} onChange={(e) => setAmtSell(e.target.value.replace(/[^\d]/g, ''))} disabled={gd.remainingSell <= 0} placeholder="0" />
          </Field>
          <Field label="Quỹ nhận tiền" required>
            <select className={inputCls} value={fundId} onChange={(e) => setFundId(e.target.value)}>
              <option value="">— Chọn quỹ —</option>
              {funds.map((f) => <option key={f.id} value={f.id}>{f.code} · {f.name}</option>)}
            </select>
          </Field>
          <Field label="Hình thức" required>
            <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="CASH">Tiền mặt</option>
              <option value="CK">Chuyển khoản</option>
            </select>
          </Field>
          <Field label="Ngày thu" required>
            <input type="date" className={inputCls} value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </Field>
          <Field label="Ghi chú">
            <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tùy chọn" />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="neutral" onClick={onClose}>Hủy</Button>
          <Button variant="confirm" icon={<HandCoins className="h-4 w-4" />} onClick={submit} disabled={busy}>{busy ? 'Đang lưu…' : 'Lập phiếu thu'}</Button>
        </div>
      </div>
    </Modal>
  );
}
