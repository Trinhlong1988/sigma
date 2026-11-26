// Báo cáo doanh thu & lãi Nhà đầu tư theo kỳ (Phase C-1). CHỈ ĐỌC: chọn kỳ (từ/đến, mặc định hôm nay) → bảng NĐT |
// Doanh thu | Số bill | Lãi | Đã hoàn (dt/lãi) | Chưa hoàn (dt/lãi). Gọi window.api.investorReport (REST /v1/investors/report).
// Tiền nhóm 3 số bằng dấu chấm (KHÔNG toLocaleString — R_UI QA gate). Xuất Excel qua exportCsv sẵn có.
import { useCallback, useEffect, useState } from 'react';
import { TrendingUp, Download, Loader2, RefreshCw } from 'lucide-react';
import type { InvestorReportRow } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { Button } from '../components/Button.js';
import { FilterBar } from '../components/FilterBar.js';
import { StatBar } from '../components/StatBar.js';
import { exportCsv } from '../lib/exportCsv.js';
// MẪU CHỐT 6/11 — kiểu bảng lấy TỪ MODULE DÙNG CHUNG, cấm chép chuỗi class vào trang.
import { thChuan, tdChuan, tdTongChuan, tdTien, trChuan, KhungBang } from '../components/BangChuan.js';

/** VND, nhóm 3 số bằng dấu chấm (KHÔNG toLocaleString — R_UI QA gate). Giữ dấu âm. */
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
const SO_COT = 9;
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 1 lựa chọn dropdown (id + nhãn). */
interface Opt { id: number; label: string; }

export function InvestorReportPage(): JSX.Element {
  const toast = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  // BỘ LỌC (Admin Demo 11/8): TK nhận tiền / ngân hàng / TID / tên HKD. '' = không lọc (undefined khi gọi API).
  const [rcvAcct, setRcvAcct] = useState('');
  const [bankId, setBankId] = useState('');
  const [tidId, setTidId] = useState('');
  const [hkdName, setHkdName] = useState('');
  const [rcvOpts, setRcvOpts] = useState<Opt[]>([]);
  const [bankOpts, setBankOpts] = useState<Opt[]>([]);
  const [tidOpts, setTidOpts] = useState<Opt[]>([]);
  const [rows, setRows] = useState<InvestorReportRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await window.api.investorReport({
        from, to,
        receiveAccountId: rcvAcct ? Number(rcvAcct) : undefined,
        bankId: bankId ? Number(bankId) : undefined,
        tidId: tidId ? Number(tidId) : undefined,
        hkdName: hkdName.trim() || undefined
      });
      if (r.ok && r.data) setRows(r.data);
      else {
        setRows([]);
        toast.alert(r.message ?? 'Không tải được báo cáo nhà đầu tư.', 'Lỗi');
      }
    } finally {
      setLoading(false);
    }
  }, [from, to, rcvAcct, bankId, tidId, hkdName, toast]);

  useEffect(() => { void load(); }, []); // tải lần đầu (kỳ = hôm nay)

  // Nạp danh mục dropdown 1 lần (TK nhận tiền / ngân hàng / TID).
  useEffect(() => {
    void window.api.rcvAccountList({}).then((r) => {
      if (r.ok && r.data) setRcvOpts(r.data.map((a) => ({ id: a.id, label: `${a.accountName} · ${a.accountNumber}${a.bankName ? ' · ' + a.bankName : ''}` })));
    });
    void window.api.bankList({}).then((r) => {
      if (r.ok && r.data) setBankOpts(r.data.map((b) => ({ id: b.id, label: b.name })));
    });
    void window.api.tidList({}).then((r) => {
      if (r.ok && r.data) setTidOpts(r.data.map((t) => ({ id: t.id, label: t.tid })));
    });
  }, []);

  const clearFilters = useCallback((): void => {
    setRcvAcct(''); setBankId(''); setTidId(''); setHkdName('');
  }, []);
  const hasFilter = rcvAcct !== '' || bankId !== '' || tidId !== '' || hkdName.trim() !== '';

  const totalDoanhThu = rows.reduce((s, r) => s + r.doanhThu, 0);
  const totalLai = rows.reduce((s, r) => s + r.laiNDT, 0);
  const totalBill = rows.reduce((s, r) => s + r.soBill, 0);

  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      {/* THANH LỌC (MẪU CHỐT §4): MỘT HÀNG, cỡ chữ nhỏ, nút Lọc căn mép phải — trước đây 2 hàng Field
          rời (ngày+nút ở hàng 1, 4 ô lọc ở hàng 2) nên cao gấp đôi và lệch mọi màn khác. */}
      <FilterBar
        search={hkdName}
        onSearch={setHkdName}
        searchPlaceholder="Tên HKD chứa chữ…"
        fromDate={from}
        toDate={to}
        onFromDate={setFrom}
        onToDate={setTo}
        selects={[
          { key: 'rcv', placeholder: 'Tất cả TK nhận tiền', value: rcvAcct, options: rcvOpts.map((o) => ({ value: String(o.id), label: o.label })), onChange: setRcvAcct },
          { key: 'bank', placeholder: 'Tất cả ngân hàng', value: bankId, options: bankOpts.map((o) => ({ value: String(o.id), label: o.label })), onChange: setBankId },
          { key: 'tid', placeholder: 'Tất cả TID', value: tidId, options: tidOpts.map((o) => ({ value: String(o.id), label: o.label })), onChange: setTidId }
        ]}
        onApply={() => void load()}
        onReset={() => { clearFilters(); setTimeout(() => void load(), 0); }}
        onRefresh={() => void load()}
        coChuNho
        locPhai
        extraActions={
          <>
            <Button variant="soft" icon={loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} disabled={loading} onClick={() => void load()} title="Xem báo cáo theo kỳ đang chọn">Xem báo cáo</Button>
            <Button variant="confirm" data-nut="excel" icon={<Download className="h-4 w-4" />} disabled={rows.length === 0} onClick={() => void exportRows(rows)}>Xuất Excel</Button>
          </>
        }
      />
      {hasFilter && <div className="mb-1 shrink-0 text-xs text-slate-500">Đang lọc theo TK nhận tiền / ngân hàng / TID / tên HKD — bấm &quot;Xóa lọc&quot; để bỏ.</div>}

      <StatBar items={[
        { label: 'Doanh thu (kỳ)', value: money(totalDoanhThu), icon: <TrendingUp className="h-4 w-4" /> },
        { label: 'Lãi nhà đầu tư (kỳ)', value: money(totalLai) },
        { label: 'Số bill', value: totalBill },
        { label: 'Số nhà đầu tư', value: rows.length }
      ]} />

      {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên, hàng TỔNG ghim đáy (bảng này TRƯỚC ĐÂY
          KHÔNG có hàng tổng dù 7 cột tiền — phải cộng tay). Không ẩn cột theo breakpoint. */}
      <KhungBang>
        <table className="h-full w-full min-w-[1320px] text-xs">
          <thead className="sticky top-0 z-20 bg-slate-200">
            <tr>
              <th className={thChuan + ' w-[200px]'}>Nhà đầu tư</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Doanh thu</th>
              <th className={thChuan + ' w-[84px]'}>Số bill</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Lãi (0.1%)</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Đã hoàn — DT</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Đã hoàn — Lãi</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Chưa hoàn — DT</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Chưa hoàn — Lãi</th>
              <th className={thChuan + ' w-[100px]'}>Báo cáo</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={SO_COT} className="px-3 py-8 text-center text-slate-400">{loading ? 'Đang tải…' : 'Không có dữ liệu trong kỳ.'}</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.investorId} className={trChuan(i)}>
                <td className={tdChuan + ' font-medium text-slate-700'}>{r.investorName}<span className="ml-1 text-slate-400">· {r.code}</span></td>
                {/* 6 cột tiền + 1 cột đếm: cùng cỡ chữ 12px, căn phải, KHÔNG in đậm (§2). */}
                <td className={tdTien}>{tienBang(r.doanhThu)}</td>
                <td className={tdChuan + ' text-right tabular-nums text-slate-600'}>{r.soBill}</td>
                <td className={tdTien}>{tienBang(r.laiNDT)}</td>
                <td className={tdTien}>{tienBang(r.daHoan.doanhThu)}</td>
                <td className={tdTien}>{tienBang(r.daHoan.laiNDT)}</td>
                <td className={tdTien}>{tienBang(r.chuaHoan.doanhThu)}</td>
                <td className={tdTien}>{tienBang(r.chuaHoan.laiNDT)}</td>
                <td className={tdChuan + ' text-center'}>
                  <button title="Tải Excel chi tiết (theo TID, bảo mật đại lý)" className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50" onClick={() => void downloadDetail(r.investorId, r.investorName, from, to, { bankId: bankId ? Number(bankId) : undefined, tidId: tidId ? Number(tidId) : undefined, hkdName: hkdName.trim() || undefined }, toast)}>
                    <Download className="h-3.5 w-3.5" /> Tải
                  </button>
                </td>
              </tr>
            ))}
            {/* HÀNG ĐỆM — chừa chỗ cho hàng TỔNG ghim đáy. */}
            <tr aria-hidden className="h-full"><td colSpan={SO_COT} className="h-9" /></tr>
          </tbody>
          <tfoot className="sticky bottom-0 z-10">
            <tr className="border-t-2 border-brand">
              <td className={tdTongChuan + ' font-semibold text-brand-deep'}>TỔNG {rows.length} NĐT</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(totalDoanhThu)}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{totalBill}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-brand'}>{tienBang(totalLai)}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(rows.reduce((s, r) => s + r.daHoan.doanhThu, 0))}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(rows.reduce((s, r) => s + r.daHoan.laiNDT, 0))}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(rows.reduce((s, r) => s + r.chuaHoan.doanhThu, 0))}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(rows.reduce((s, r) => s + r.chuaHoan.laiNDT, 0))}</td>
              <td className={tdTongChuan} />
            </tr>
          </tfoot>
        </table>
      </KhungBang>
    </div>
  );
}

// Liệt kê từng NGÀY (local) trong kỳ from→to (bao gồm 2 đầu). Kỳ 1 ngày → 1 phần tử. Range không hợp lệ → rỗng.
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const e = new Date(`${to}T00:00:00`);
  const start = new Date(`${from}T00:00:00`);
  if (isNaN(start.getTime()) || isNaN(e.getTime())) return days;
  for (const d = start; d <= e; d.setDate(d.getDate() + 1)) {
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return days;
}

// Tải BÁO CÁO CHI TIẾT 1 NĐT: lấy data từ server (report-detail) → main dựng Excel + lưu (dialog). Bảo mật: không tên đại lý.
// Admin Demo 27/8: kỳ NHIỀU ngày → gọi report-detail THEO TỪNG NGÀY (đúng biên SQL, không cắt JS lệch múi giờ) → MẢNG
// data-mỗi-ngày → workbook nhiều sheet (mỗi ngày 1 sheet). Kỳ 1 ngày = 1 sheet như cũ. Lọc bank/TID/HKD truyền theo.
async function downloadDetail(
  investorId: number,
  investorName: string,
  from: string,
  to: string,
  filters: { bankId?: number; tidId?: number; hkdName?: string },
  toast: ReturnType<typeof useToast>
): Promise<void> {
  try {
    const days = enumerateDays(from, to);
    if (days.length === 0) { toast.alert('Khoảng thời gian không hợp lệ.', 'Lỗi'); return; }
    type DetailData = NonNullable<Awaited<ReturnType<typeof window.api.investorReportDetail>>['data']>;
    const perDay: DetailData[] = [];
    for (const day of days) {
      const r = await window.api.investorReportDetail({ investorId, from: day, to: day, ...filters });
      if (!r.ok) { toast.alert(r.message ?? 'Không tải được báo cáo chi tiết.', 'Lỗi'); return; }
      if (r.data) perDay.push(r.data);
    }
    const totalBills = perDay.reduce((s, d) => s + d.bills.length, 0);
    if (totalBills === 0) { toast.info('Nhà đầu tư không có giao dịch trong kỳ.'); return; }
    const fileName = `BaoCaoNDT_${investorName.replace(/[^\p{L}\d]+/gu, '')}_${from.replace(/-/g, '')}.xlsx`;
    // 1 ngày → truyền object đơn (1 sheet); nhiều ngày → truyền mảng (mỗi phần tử 1 sheet).
    const data = perDay.length === 1 ? perDay[0] : perDay;
    const res = await window.api.investorDetailExport({ fileName, data });
    if (res.ok && !res.canceled && res.path) toast.success('Đã lưu: ' + res.path);
    else if (!res.ok) toast.alert(res.message ?? 'Không lưu được file.', 'Lỗi');
  } catch (e) {
    toast.alert('Lỗi tải báo cáo: ' + (e instanceof Error ? e.message : String(e)), 'Lỗi');
  }
}

// Xuất Excel — số tiền để dạng SỐ THÔ (không định dạng dấu chấm) để Excel tính được.
function exportRows(rows: InvestorReportRow[]): Promise<void> {
  return exportCsv(
    'lai_nha_dau_tu',
    ['Mã NĐT', 'Nhà đầu tư', 'Doanh thu', 'Số bill', 'Lãi NĐT', 'Đã hoàn DT', 'Đã hoàn Lãi', 'Đã hoàn Bill', 'Chưa hoàn DT', 'Chưa hoàn Lãi', 'Chưa hoàn Bill'],
    rows.map((r) => [
      r.code, r.investorName, Number(r.doanhThu), Number(r.soBill), Number(r.laiNDT),
      Number(r.daHoan.doanhThu), Number(r.daHoan.laiNDT), Number(r.daHoan.soBill),
      Number(r.chuaHoan.doanhThu), Number(r.chuaHoan.laiNDT), Number(r.chuaHoan.soBill)
    ]),
    undefined, undefined,
    { cotTien: ['Doanh thu', 'Lãi NĐT', 'Đã hoàn DT', 'Đã hoàn Lãi', 'Chưa hoàn DT', 'Chưa hoàn Lãi'] } // [B299]
  );
}
