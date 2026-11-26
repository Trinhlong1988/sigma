// TẤT TOÁN NGÀY cho Nhà đầu tư (Phase C-2b). CHỈ ĐỌC: chọn kỳ (từ/đến, mặc định hôm nay) → bảng NĐT | Doanh thu |
// Lãi | Đã ứng | Tiền về | PHẢI TRẢ (bôi đậm, âm=đỏ). Gọi window.api.investorSettlement (REST /v1/investors/settlement).
// tiềnVề = doanhThu×(1−%phí cài máy). phảiTrả = (đã ứng − tiền về) + lãi (giữ dấu, có thể ÂM). Tiền nhóm 3 số bằng
// dấu chấm (KHÔNG toLocaleString — R_UI QA gate). Xuất Excel qua exportCsv (số THÔ để Excel tính).
import { useCallback, useEffect, useState } from 'react';
import { Wallet, Download, Loader2, RefreshCw, TrendingUp, Coins, Banknote, PiggyBank } from 'lucide-react';
import type { InvestorSettlementRow } from '../../../preload/index.d';
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
const SO_COT = 6;
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 1 lựa chọn dropdown (id + nhãn). */
interface Opt { id: number; label: string; }

export function InvestorSettlementPage(): JSX.Element {
  const toast = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  // BỘ LỌC (Admin Demo 11/8): TK nhận tiền / ngân hàng / TID / tên HKD — chỉ thu hẹp doanhThu/lãi/tiền về/phải-trả.
  // "Đã ứng" (vốn theo NĐT) KHÔNG bị lọc theo TID (backend cố ý bỏ qua filter cho tạm ứng).
  const [rcvAcct, setRcvAcct] = useState('');
  const [bankId, setBankId] = useState('');
  const [tidId, setTidId] = useState('');
  const [hkdName, setHkdName] = useState('');
  const [rcvOpts, setRcvOpts] = useState<Opt[]>([]);
  const [bankOpts, setBankOpts] = useState<Opt[]>([]);
  const [tidOpts, setTidOpts] = useState<Opt[]>([]);
  const [rows, setRows] = useState<InvestorSettlementRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await window.api.investorSettlement({
        from, to,
        receiveAccountId: rcvAcct ? Number(rcvAcct) : undefined,
        bankId: bankId ? Number(bankId) : undefined,
        tidId: tidId ? Number(tidId) : undefined,
        hkdName: hkdName.trim() || undefined
      });
      if (r.ok && r.data) setRows(r.data);
      else {
        setRows([]);
        toast.alert(r.message ?? 'Không tải được tất toán nhà đầu tư.', 'Lỗi');
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
  const totalTienVe = rows.reduce((s, r) => s + r.tienVe, 0);
  const totalUng = rows.reduce((s, r) => s + r.tamUng, 0);
  const totalPhaiTra = rows.reduce((s, r) => s + r.phaiTra, 0);

  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      {/* THANH LỌC (MẪU CHỐT §4): MỘT HÀNG, cỡ chữ nhỏ, nút Lọc căn mép phải — gộp 2 hàng Field cũ. */}
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
            <Button variant="soft" icon={loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} disabled={loading} onClick={() => void load()} title="Xem tất toán theo kỳ đang chọn">Xem tất toán</Button>
            <Button variant="confirm" data-nut="excel" icon={<Download className="h-4 w-4" />} disabled={rows.length === 0} onClick={() => void exportRows(rows)}>Xuất Excel</Button>
          </>
        }
      />
      {hasFilter && <div className="mb-1 shrink-0 text-xs text-slate-500">Đang lọc theo TK nhận tiền / ngân hàng / TID / tên HKD — bấm &quot;Xóa lọc&quot; để bỏ. Lưu ý: &quot;Đã ứng&quot; KHÔNG bị lọc theo TID.</div>}

      <StatBar items={[
        { label: 'Doanh thu (kỳ)', value: money(totalDoanhThu), icon: <Wallet className="h-4 w-4" />, tone: 'bg-blue-100 text-blue-700' },
        { label: 'Lãi NĐT (kỳ)', value: money(totalLai), icon: <TrendingUp className="h-4 w-4" />, tone: 'bg-violet-100 text-violet-700' },
        { label: 'Đã ứng (kỳ)', value: money(totalUng), icon: <Coins className="h-4 w-4" />, tone: 'bg-amber-100 text-amber-700' },
        { label: 'Tiền về (kỳ)', value: money(totalTienVe), icon: <Banknote className="h-4 w-4" />, tone: 'bg-emerald-100 text-emerald-700' },
        { label: 'Phải trả NĐT (kỳ)', value: money(totalPhaiTra), icon: <PiggyBank className="h-4 w-4" />, tone: 'bg-rose-100 text-rose-700' }
      ]} />

      {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên, hàng TỔNG ghim đáy (bảng này TRƯỚC ĐÂY
          KHÔNG có hàng tổng dù 5 cột tiền). Không ẩn cột theo breakpoint. */}
      <KhungBang>
        <table className="h-full w-full min-w-[880px] text-xs">
          <thead className="sticky top-0 z-20 bg-slate-200">
            <tr>
              <th className={thChuan + ' w-[230px]'}>Nhà đầu tư</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Doanh thu</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Lãi</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Đã ứng</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Tiền về</th>
              <th className={thChuan + ' w-[126px] min-w-[126px]'}>Phải trả</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={SO_COT} className="px-3 py-8 text-center text-slate-400">{loading ? 'Đang tải…' : 'Không có dữ liệu trong kỳ.'}</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.investorId} className={trChuan(i)}>
                <td className={tdChuan + ' font-medium text-slate-700'}>{r.investorName}<span className="ml-1 text-slate-400">· {r.code}</span></td>
                {/* 5 cột tiền: căn phải · tabular-nums · text-slate-800 · KHÔNG in đậm (§2).
                    "Phải trả" ÂM vẫn tô đỏ vì đó là dấu hiệu phải thu lại NĐT. */}
                <td className={tdTien}>{tienBang(r.doanhThu)}</td>
                <td className={tdTien}>{tienBang(r.laiNDT)}</td>
                <td className={tdTien}>{tienBang(r.tamUng)}</td>
                <td className={tdTien}>{tienBang(r.tienVe)}</td>
                <td className={tdChuan + ' text-right tabular-nums ' + (r.phaiTra < 0 ? 'text-red-600' : 'text-slate-800')}>{tienBang(r.phaiTra)}</td>
              </tr>
            ))}
            {/* HÀNG ĐỆM — chừa chỗ cho hàng TỔNG ghim đáy. */}
            <tr aria-hidden className="h-full"><td colSpan={SO_COT} className="h-9" /></tr>
          </tbody>
          <tfoot className="sticky bottom-0 z-10">
            <tr className="border-t-2 border-brand">
              <td className={tdTongChuan + ' font-semibold text-brand-deep'}>TỔNG {rows.length} NĐT</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(totalDoanhThu)}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(totalLai)}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(totalUng)}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums text-slate-800'}>{tienBang(totalTienVe)}</td>
              <td className={tdTongChuan + ' text-right font-bold tabular-nums ' + (totalPhaiTra < 0 ? 'text-red-600' : 'text-brand')}>{tienBang(totalPhaiTra)}</td>
            </tr>
          </tfoot>
        </table>
      </KhungBang>
    </div>
  );
}

// Xuất Excel — số tiền dạng SỐ THÔ (không dấu chấm) để Excel tính được.
function exportRows(rows: InvestorSettlementRow[]): Promise<void> {
  return exportCsv(
    'tat_toan_nha_dau_tu',
    ['Mã NĐT', 'Nhà đầu tư', 'Doanh thu', 'Lãi NĐT', 'Đã ứng', 'Tiền về', 'Phải trả'],
    rows.map((r) => [
      r.code, r.investorName,
      String(r.doanhThu), String(r.laiNDT), String(r.tamUng), String(r.tienVe), String(r.phaiTra)
    ])
  );
}
