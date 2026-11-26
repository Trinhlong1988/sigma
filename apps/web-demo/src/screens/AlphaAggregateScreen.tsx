// BÁO CÁO TỔNG GỘP SIGMA (Admin Demo 5/9 — v2) — CHỈ 3 chủ SigMa (server chặn 403; menu đã ẩn với người khác).
// 2 TAB (Theo NĐT / Theo Đại lý) · nút ngày nhanh (Hôm nay/Hôm qua/Chọn chu kỳ, giờ HCM) · dropdown lọc entity
// (Tất cả = bảng tóm tắt sắp doanh số giảm dần; chọn 1 = CHI TIẾT từng GD) · thẻ LÃI (Công ty + NĐT).
import { useEffect, useState, type JSX } from 'react';
import { AlertTriangle, Loader2, Coins, RefreshCw, ArrowLeft } from 'lucide-react';
import { Button } from '../components/Button';
import {
  fetchAlphaAggregate,
  type AlphaAggregateReport, type AlphaAggInvestorRow, type AlphaAggDealerRow, type AlphaAggregateDetail
} from '../lib/alpha-aggregate-client';

const money = (n: number): string => Math.round(n).toLocaleString('vi-VN');
const pad = (n: number): string => String(n).padStart(2, '0');
/** YYYY-MM-DD giờ Asia/Ho_Chi_Minh (UTC+7) của NGÀY = hôm nay + offsetDays. Preset dùng ngày HCM (chống lệch máy). */
function hcmDayStr(offsetDays: number): string {
  const d = new Date(Date.now() + 7 * 3600_000 + offsetDays * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** YYYY-MM-DD (giờ máy — cho ô <input type=date>). */
function ymd(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** Ngày kế (YYYY-MM-DD) — chặn trên nửa-mở [from, to). */
function nextDayStr(s: string): string {
  const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + 1); return ymd(d);
}
/** Giờ:phút ngày (HCM) của 1 ISO instant — hiển thị chi tiết GD. */
function fmtHcm(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 7 * 3600_000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

type TabKey = 'investor' | 'dealer';
type Preset = 'today' | 'yesterday' | 'custom';

/** Thẻ tổng nhỏ. */
function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }): JSX.Element {
  return (
    <div className={`glass-panel rounded-xl border p-3 ${accent ? 'border-brand/30 bg-brand-tint' : 'border-line'}`}>
      <div className="text-[11px] uppercase text-slate-400">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${accent ? 'text-brand-deep' : 'text-slate-700'}`}>{money(value)}</div>
    </div>
  );
}

/** Bảng TÓM TẮT (Tất cả) — click dòng để mở chi tiết entity. */
function SummaryTable({ tab, rows, onPick }: {
  tab: TabKey;
  rows: (AlphaAggInvestorRow | AlphaAggDealerRow)[];
  onPick: (id: string) => void;
}): JSX.Element {
  const isInv = tab === 'investor';
  const tot = rows.reduce((a, r) => {
    a.pos += r.doanhSoPos; a.qr += r.doanhSoQr; a.tong += r.tong; a.hoan += r.hoan;
    if (isInv) a.lai += (r as AlphaAggInvestorRow).laiNdt;
    return a;
  }, { pos: 0, qr: 0, tong: 0, hoan: 0, lai: 0 });
  return (
    <div className="glass-panel shadow-soft rounded-2xl border border-line overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2 text-left font-semibold">Tên</th>
              <th className="px-3 py-2 text-right font-semibold">Doanh số POS</th>
              <th className="px-3 py-2 text-right font-semibold">Doanh số QR</th>
              <th className="px-3 py-2 text-right font-semibold">Tổng</th>
              {isInv && <th className="px-3 py-2 text-right font-semibold">Lãi NĐT</th>}
              <th className="px-3 py-2 text-right font-semibold">{isInv ? 'NĐT trả SigMa' : 'Hoàn đại lý'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={isInv ? 6 : 5} className="px-3 py-4 text-center text-slate-400">Không có dữ liệu trong kỳ.</td></tr>
            ) : rows.map((r) => {
              const id = isInv ? String((r as AlphaAggInvestorRow).investorId) : (r as AlphaAggDealerRow).dealerId;
              return (
                <tr key={id} onClick={() => onPick(id)} className="cursor-pointer border-b border-line/60 hover:bg-brand-tint/50">
                  <td className="px-3 py-1.5 font-medium text-brand-deep underline decoration-dotted break-words">{r.name}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{money(r.doanhSoPos)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{money(r.doanhSoQr)}</td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-brand-deep">{money(r.tong)}</td>
                  {isInv && <td className="px-3 py-1.5 text-right tabular-nums text-emerald-600">{money((r as AlphaAggInvestorRow).laiNdt)}</td>}
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{money(r.hoan)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-brand/40 bg-brand-tint font-bold text-brand-deep">
              <td className="px-3 py-2">TỔNG</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(tot.pos)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(tot.qr)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(tot.tong)}</td>
              {isInv && <td className="px-3 py-2 text-right tabular-nums">{money(tot.lai)}</td>}
              <td className="px-3 py-2 text-right tabular-nums">{money(tot.hoan)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** Bảng CHI TIẾT 1 entity — từng GD trong kỳ. */
function DetailTable({ detail }: { detail: AlphaAggregateDetail }): JSX.Element {
  const isInv = detail.entityKind === 'investor';
  const cols = isInv ? 6 : 6;
  return (
    <div className="space-y-3">
      <div className="glass-panel shadow-soft rounded-2xl border border-line overflow-hidden">
        <div className="border-b border-line bg-brand-tint px-4 py-2 text-sm font-bold text-brand-deep">Chi tiết: {detail.name}</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2 text-left font-semibold">Ngày</th>
                <th className="px-3 py-2 text-left font-semibold">HKD</th>
                <th className="px-3 py-2 text-center font-semibold">Loại</th>
                <th className="px-3 py-2 text-right font-semibold">Số tiền</th>
                {isInv ? <>
                  <th className="px-3 py-2 text-right font-semibold">Giá mua</th>
                  <th className="px-3 py-2 text-right font-semibold">Lãi NĐT</th>
                </> : <>
                  <th className="px-3 py-2 text-right font-semibold">Phí bán</th>
                  <th className="px-3 py-2 text-right font-semibold">Đại lý hoàn</th>
                </>}
              </tr>
            </thead>
            <tbody>
              {detail.rows.length === 0 ? (
                <tr><td colSpan={cols} className="px-3 py-4 text-center text-slate-400">Không có giao dịch trong kỳ.</td></tr>
              ) : detail.rows.map((r, i) => (
                <tr key={i} className="border-b border-line/60 hover:bg-white/40">
                  <td className="px-3 py-1.5 text-slate-600 whitespace-nowrap">{fmtHcm(r.txnDateIso)}</td>
                  <td className="px-3 py-1.5 text-slate-700 break-words">{r.hkdName || '—'}</td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${r.kind === 'QR' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>{r.kind}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium text-slate-700">{money(r.amount)}</td>
                  {isInv ? <>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{r.giaMua != null ? money(r.giaMua) : '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-emerald-600">{r.laiNdt != null ? money(r.laiNdt) : '—'}</td>
                  </> : <>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{r.phiBan != null ? money(r.phiBan) : '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{r.daiLyHoan != null ? money(r.daiLyHoan) : '—'}</td>
                  </>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-brand/40 bg-brand-tint font-bold text-brand-deep">
                <td className="px-3 py-2" colSpan={3}>TỔNG (POS {money(detail.totals.amountPos)} · QR {money(detail.totals.amountQr)})</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(detail.totals.amount)}</td>
                {isInv ? <>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right tabular-nums">{money(detail.totals.laiNdt)}</td>
                </> : <>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right tabular-nums">{money(detail.totals.hoan)}</td>
                </>}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      {/* Hoàn POS/CK theo tin chat (đại lý) — không suy được per-GD nên liệt kê riêng để tổng hoàn khớp. */}
      {!isInv && detail.refunds.length > 0 && (
        <div className="glass-panel shadow-soft rounded-2xl border border-line overflow-hidden">
          <div className="border-b border-line bg-brand-tint px-4 py-2 text-xs font-bold text-brand-deep">Hoàn POS/CK (theo tin chuyển khoản)</div>
          <div className="divide-y divide-line/60">
            {detail.refunds.map((f, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-1.5 text-sm">
                <span className="text-slate-500">Bill ngày {f.billDate}</span>
                <span className="tabular-nums font-medium text-slate-700">{money(f.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AlphaAggregateScreen(): JSX.Element {
  const [tab, setTab] = useState<TabKey>('investor');
  const [preset, setPreset] = useState<Preset>('today');
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 86_400_000);
  const [cFrom, setCFrom] = useState(ymd(monthAgo));
  const [cTo, setCTo] = useState(ymd(today));
  const [selId, setSelId] = useState<string>(''); // '' = Tất cả; investorId | roomId

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [report, setReport] = useState<AlphaAggregateReport | null>(null);

  /** Khoảng [from, to) nửa-mở theo preset (server hiểu YYYY-MM-DD = nửa đêm HCM). */
  function periodBounds(): { from: string; to: string } {
    if (preset === 'today') return { from: hcmDayStr(0), to: hcmDayStr(1) };
    if (preset === 'yesterday') return { from: hcmDayStr(-1), to: hcmDayStr(0) };
    return { from: cFrom, to: nextDayStr(cTo) }; // custom: gồm cả ngày đến
  }

  async function load(overrideSel?: string): Promise<void> {
    setLoading(true); setErr(null); setForbidden(false);
    const { from, to } = periodBounds();
    const sid = overrideSel !== undefined ? overrideSel : selId;
    const sel = sid === '' ? undefined
      : tab === 'investor' ? { investorId: Number(sid) } : { dealerId: sid };
    const r = await fetchAlphaAggregate(from, to, sel);
    setLoading(false);
    if (!r.ok) {
      if (r.error === 'FORBIDDEN') { setForbidden(true); return; }
      setErr(r.message); return;
    }
    setReport(r.data);
  }
  // Nạp lại khi đổi tab/preset/entity/ngày-custom.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [tab, preset, selId, cFrom, cTo]);
  // Đổi tab → reset lựa chọn entity (id đại lý ≠ id NĐT).
  function switchTab(t: TabKey): void { if (t !== tab) { setSelId(''); setTab(t); } }

  const t = report?.totals;
  const entityOptions = report ? (tab === 'investor'
    ? report.byInvestor.map((r) => ({ id: String(r.investorId), name: r.name }))
    : report.byDealer.map((r) => ({ id: r.dealerId, name: r.name }))) : [];
  const summaryRows: (AlphaAggInvestorRow | AlphaAggDealerRow)[] = report ? (tab === 'investor' ? report.byInvestor : report.byDealer) : [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 pb-24">
      <div className="flex items-center gap-2 text-lg font-bold text-brand-deep"><Coins className="h-5 w-5" /> Tổng gộp SigMa</div>

      {forbidden ? (
        <div className="glass-panel shadow-soft flex flex-col items-center gap-3 rounded-2xl border border-danger/30 p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-danger" />
          <div className="text-sm font-semibold text-slate-600">Chỉ chủ SigMa mới xem được báo cáo tổng gộp.</div>
        </div>
      ) : (
        <>
          {/* TAB */}
          <div className="flex gap-1 rounded-xl border border-line bg-white/60 p-1">
            {([['investor', 'Theo Nhà đầu tư'], ['dealer', 'Theo Đại lý']] as [TabKey, string][]).map(([k, label]) => (
              <button key={k} onClick={() => switchTab(k)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${tab === k ? 'bg-brand text-white shadow-soft' : 'text-slate-500 hover:bg-brand-tint'}`}>{label}</button>
            ))}
          </div>

          {/* LỌC NGÀY + ENTITY */}
          <div className="glass-panel shadow-soft flex flex-wrap items-end gap-3 rounded-2xl border border-line p-4">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">Kỳ báo cáo</span>
              <div className="flex gap-1 rounded-lg border border-line bg-white p-0.5">
                {([['today', 'Hôm nay'], ['yesterday', 'Hôm qua'], ['custom', 'Chọn chu kỳ']] as [Preset, string][]).map(([k, label]) => (
                  <button key={k} onClick={() => setPreset(k)}
                    className={`rounded-md px-2.5 py-1 text-sm font-medium transition ${preset === k ? 'bg-brand text-white' : 'text-slate-500 hover:bg-brand-tint'}`}>{label}</button>
                ))}
              </div>
            </div>
            {preset === 'custom' && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-slate-400">Từ ngày</span>
                  <input type="date" value={cFrom} max={cTo} onChange={(e) => setCFrom(e.target.value)} className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-slate-400">Đến ngày</span>
                  <input type="date" value={cTo} min={cFrom} onChange={(e) => setCTo(e.target.value)} className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm" />
                </label>
              </>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">{tab === 'investor' ? 'Nhà đầu tư' : 'Đại lý'}</span>
              <select value={selId} onChange={(e) => setSelId(e.target.value)} className="max-w-[220px] rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm">
                <option value="">Tất cả</option>
                {entityOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
            <Button variant="confirm" icon={loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} onClick={() => void load()} disabled={loading}>{loading ? 'Đang tải…' : 'Làm mới'}</Button>
          </div>

          {err && <div className="flex items-center gap-2 rounded-xl bg-danger/10 border border-danger/20 p-3 text-sm text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {err}</div>}

          {report && t && (
            <>
              {/* THẺ TỔNG (toàn kỳ — không đổi theo entity đã chọn) */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <StatCard label="Doanh số POS" value={t.doanhSoPos} />
                <StatCard label="Doanh số QR" value={t.doanhSoQr} />
                <StatCard label="Tổng doanh số" value={t.tongDoanhSo} accent />
                <StatCard label="Lãi Công ty" value={t.laiCongTy} />
                {tab === 'investor'
                  ? <StatCard label="Lãi NĐT" value={t.laiNdt} />
                  : <StatCard label="Hoàn đại lý" value={t.tongHoanDaiLy} />}
              </div>

              {selId !== '' && report.detail ? (
                <>
                  <button onClick={() => setSelId('')} className="flex items-center gap-1 text-sm font-medium text-brand hover:underline"><ArrowLeft className="h-4 w-4" /> Về danh sách</button>
                  <DetailTable detail={report.detail} />
                </>
              ) : (
                <SummaryTable tab={tab} rows={summaryRows} onPick={(id) => setSelId(id)} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
