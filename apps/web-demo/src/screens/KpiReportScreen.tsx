// Báo cáo/KPI — nối bot-api THẬT (GET /v1/me/kpi, kpi-client.ts). THIẾT KẾ LẠI (Admin Demo 22/8):
//  • Headline: Doanh số TRƯỚC phí (gross) + Thực nhận SAU phí (net) + Đã hoàn (OCR bill CK) + Thừa/Thiếu.
//    ("vẫn có doanh số trước phí nhé" → giữ gross; "thực nhận = doanh số hoàn sau phí" → thêm net.)
//  • Biểu đồ VẼ LẠI: cột KÉP theo ngày — Cần hoàn (sau phí) vs Đã hoàn thực tế; ngày hoàn THỪA tô đỏ, hoàn
//    THIẾU tô vàng, khớp tô xanh (đúng "hoàn thừa thiếu theo ngày").
// Số liệu doanh số (gross/net) nguồn Lo/LoRow; số liệu hoàn tiền (cần hoàn/đã hoàn) nguồn ChatMessage bill —
// 2 nguồn khác nhau (xem refund-report-service.ts), frontend KHÔNG tự tính lại, chỉ trình bày.
import { useEffect, useState, type JSX } from 'react';
import { fetchKpiReport, kpiExportXlsxUrl, fetchAlphaKpi, type KpiReportData, type KpiRefundDailyBucket, type AlphaKpiData } from '../lib/kpi-client';
import { isAlphaOwnerCode } from '../lib/alpha-aggregate-client';
import { getCachedAuthenticatedAgent } from '../lib/bot-api-client';
import { downloadAttachment } from '../lib/attachment-blob';
import { DotsLoader } from '../components/DotsLoader';
import { useDownloadDialog } from '../components/DownloadDoneDialog';
import { GrowthChart3D } from '../components/GrowthChart3D';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: KpiReportData };

const fmtVnd = (n: number): string => Math.round(n).toLocaleString('vi-VN');
const fmtTrieu = (n: number): string => `${(n / 1_000_000).toFixed(1)} triệu`;

// Ngưỡng khớp hoàn tiền ±3.000đ — PHẢI khớp REFUND_MATCH_TOLERANCE_VND (bot-api/refund-service.ts) mà phần ĐẾM
// bill (overCount/partialCount/refundedCount) đã dùng. Fix audit #4 (25/8): trước đây dayRefundState/overUnder so
// chênh lệch TUYỆT ĐỐI (diff>0/<0) → ngày "hoàn đủ" (lệch ≤3.000đ) vẫn bị tô ĐỎ "thừa", MÂU THUẪN với ô đếm.
const REFUND_MATCH_TOLERANCE_VND = 3000;

/** Trạng thái hoàn của 1 ngày — dựa TRÊN SỐ ĐẾM bill (đã áp ngưỡng ±3.000đ ở backend), KHÔNG so chênh lệch tuyệt
 *  đối (tránh mâu thuẫn với ô "Hoàn đủ"). Ưu tiên: thừa (rủi ro) > thiếu > chưa hoàn > khớp. */
function dayRefundState(d: KpiRefundDailyBucket): { kind: 'over' | 'short' | 'match' | 'none'; diff: number } {
  const diff = d.refundedAmount - d.requiredAmount;
  if (d.overCount > 0) return { kind: 'over', diff };
  if (d.partialCount > 0) return { kind: 'short', diff };
  if (d.refundedAmount === 0 && d.requiredAmount > 0) return { kind: 'none', diff };
  return { kind: 'match', diff };
}

const REFUNDED_BAR_COLOR: Record<'over' | 'short' | 'match' | 'none', string> = {
  // Admin Demo 1/9 (áp TOÀN APP): THIẾU=ĐỎ (SigMa còn nợ, gấp) · THỪA=VÀNG (đại lý nợ lại, cảnh báo nhẹ).
  over: '#d97706', // vàng — hoàn thừa (đại lý nợ lại)
  short: '#dc2626', // đỏ — hoàn thiếu (SigMa còn nợ)
  match: '#16a34a', // xanh — khớp
  none: '#94a3b8' // xám — chưa hoàn
};

// Trạng thái nút Tải Excel — inline trên nút (không phụ thuộc toast-store) để tự chứa, báo lỗi rõ (R198 không nuốt lỗi câm).
type DlState = 'idle' | 'busy' | 'ok' | 'err';

// ── KPI SIGMA TOÀN CỤC (Admin Demo 11/9) — chủ SigMa thấy TOÀN BỘ doanh số + lợi nhuận + theo SẢN PHẨM (POS/QR)
// + theo ngày. Đại lý thường vẫn thấy KPI của chính mình (component cũ giữ nguyên bên dưới).
const KIND_LABEL: Record<string, string> = { POS: 'Máy POS', QR: 'Mã QR', CK: 'Chuyển khoản' };
const kindLabel = (k: string): string => KIND_LABEL[k] ?? k;
/** Tiền gọn: ≥1 tỷ → "40,4 tỷ" · ≥1 triệu → "116,1 tr" · nhỏ hơn → đồng đầy đủ. */
const fmtGon = (n: number): string => Math.abs(n) >= 1e9 ? `${(n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ` : Math.abs(n) >= 1e6 ? `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr` : `${Math.round(n).toLocaleString('vi-VN')} đ`;
const todayHcm = (): string => { const d = new Date(Date.now() + 7 * 3600_000); return d.toISOString().slice(0, 10); };
const daysAgoHcm = (n: number): string => { const d = new Date(Date.now() + 7 * 3600_000 - n * 86400_000); return d.toISOString().slice(0, 10); };

function AlphaKpiView(): JSX.Element {
  const [from, setFrom] = useState(daysAgoHcm(29));
  const [to, setTo] = useState(todayHcm());
  const [ky, setKy] = useState<'homnay' | 'homqua' | 'tuan' | 'thang' | '30' | 'tuychon'>('30');
  const [st, setSt] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: AlphaKpiData }>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setSt({ status: 'loading' });
    void fetchAlphaKpi(from, to).then((r) => {
      if (cancelled) return;
      setSt(r.ok ? { status: 'ready', data: r.data } : { status: 'error', message: r.message });
    });
    return () => { cancelled = true; };
  }, [from, to]);

  /** Kỳ nhanh — cùng ngôn ngữ các màn doanh số. */
  function chonKy(k: typeof ky): void {
    setKy(k);
    const hn = todayHcm();
    if (k === 'homnay') { setFrom(hn); setTo(hn); }
    else if (k === 'homqua') { const q = daysAgoHcm(1); setFrom(q); setTo(q); }
    else if (k === 'tuan') { const d = new Date(Date.now() + 7 * 3600_000); const thu = (d.getUTCDay() + 6) % 7; setFrom(daysAgoHcm(thu)); setTo(hn); }
    else if (k === 'thang') { setFrom(hn.slice(0, 8) + '01'); setTo(hn); }
    else if (k === '30') { setFrom(daysAgoHcm(29)); setTo(hn); }
  }
  const KY_TABS: Array<[typeof ky, string]> = [['homnay', 'Hôm nay'], ['homqua', 'Hôm qua'], ['tuan', 'Tuần này'], ['thang', 'Tháng này'], ['30', '30 ngày']];

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-appbg p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-slate-800">KPI SigMa</h1>
          <p className="text-xs text-slate-400">Toàn bộ doanh số + lợi nhuận, mọi sản phẩm (POS · QR)</p>
        </div>
      </div>
      {/* Kỳ nhanh — segmented glass như màn doanh số + Từ→Đến */}
      <div className="glass-panel shadow-soft flex flex-wrap items-center gap-1 rounded-2xl border border-line p-1">
        {KY_TABS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => chonKy(k)}
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition ${ky === k ? 'btn-primary' : 'text-slate-500 hover:text-brand'}`}>{label}</button>
        ))}
        <div className="ml-auto flex items-center gap-1.5 pr-1 text-xs">
          <input type="date" value={from} onChange={(e) => { setKy('tuychon'); setFrom(e.target.value); }} className="rounded-lg-mac border border-line bg-white px-2 py-1 text-xs text-slate-700" />
          <span className="text-slate-400">→</span>
          <input type="date" value={to} min={from} onChange={(e) => { setKy('tuychon'); setTo(e.target.value); }} className="rounded-lg-mac border border-line bg-white px-2 py-1 text-xs text-slate-700" />
        </div>
      </div>

      {st.status === 'loading' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-slate-400"><DotsLoader />Đang tải KPI SigMa...</div>
      ) : st.status === 'error' ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-danger">Không tải được KPI: {st.message}</div>
      ) : (() => {
        const d = st.data;
        const pos = d.byProduct.find((x) => x.kind === 'POS');
        const qr = d.byProduct.find((x) => x.kind === 'QR');
        const maxNgay = Math.max(1, ...d.byDay.map((x) => x.doanhSo));
        return (
          <>
            {/* HERO — 3 card gradient brand */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div className="rounded-2xl bg-gradient-to-br from-brand-deep to-brand p-4 text-white shadow-soft">
                <div className="text-[10px] font-bold uppercase tracking-wider opacity-75">Tổng doanh số</div>
                <div className="mt-1 text-2xl font-extrabold tabular-nums">{fmtGon(d.totals.doanhSo)}</div>
                <div className="mt-0.5 text-[11px] tabular-nums opacity-80">{d.totals.doanhSo.toLocaleString('vi-VN')}đ · {d.totals.count} giao dịch</div>
              </div>
              <div className="rounded-2xl bg-gradient-to-br from-emerald-700 to-emerald-500 p-4 text-white shadow-soft">
                <div className="text-[10px] font-bold uppercase tracking-wider opacity-75">Lợi nhuận GỘP SigMa</div>
                <div className="mt-1 text-2xl font-extrabold tabular-nums">{d.gop ? fmtGon(d.gop.loiNhuanGop) : '—'}</div>
                {/* [Admin Demo 12/9] công thức tường minh: (sau phí cài máy − sau phí bán) − lãi NĐT */}
                <div className="mt-0.5 text-[11px] tabular-nums opacity-80">{d.gop ? `= chênh phí ${fmtGon(d.gop.laiCongTy)} − lãi NĐT POS ${fmtGon(d.gop.laiNdtPos)}` : 'không tra được kỳ này'}</div>
              </div>
              <div className="rounded-2xl border border-line bg-white p-4 shadow-soft">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Bình quân / giao dịch</div>
                <div className="mt-1 text-2xl font-extrabold tabular-nums text-slate-800">{fmtGon(d.totals.count > 0 ? d.totals.doanhSo / d.totals.count : 0)}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">{d.byDay.length} ngày có doanh số trong kỳ</div>
              </div>
            </div>

            {/* SẢN PHẨM — card POS / QR với thanh tỉ trọng */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {[{ p: pos, tag: 'POS', ten: 'Máy POS', mau: '#0284c7', nen: 'bg-sky-100 text-sky-700' }, { p: qr, tag: 'QR', ten: 'Mã QR', mau: '#7c3aed', nen: 'bg-violet-100 text-violet-700' }].map(({ p, tag, ten, mau, nen }) => (
                <div key={tag} className="rounded-2xl border border-line bg-white p-3.5 shadow-soft">
                  <div className="flex items-center justify-between">
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${nen}`}>{ten}</span>
                    <span className="text-[11px] text-slate-400">{p?.count ?? 0} GD</span>
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-2">
                    <div><div className="text-[10px] uppercase tracking-wide text-slate-400">Doanh số</div><div className="text-lg font-extrabold tabular-nums text-slate-800">{fmtGon(p?.doanhSo ?? 0)}</div></div>
                    <div className="text-right"><div className="text-[10px] uppercase tracking-wide text-slate-400">Lợi nhuận</div><div className="text-lg font-extrabold tabular-nums" style={{ color: mau }}>{fmtGon(p?.loiNhuan ?? 0)}</div></div>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full" style={{ width: `${d.totals.doanhSo > 0 ? Math.round(((p?.doanhSo ?? 0) / d.totals.doanhSo) * 100) : 0}%`, background: mau }} />
                  </div>
                  <div className="mt-1 text-right text-[10px] text-slate-400">{d.totals.doanhSo > 0 ? `${(((p?.doanhSo ?? 0) / d.totals.doanhSo) * 100).toFixed(1)}% tổng doanh số` : '—'}</div>
                </div>
              ))}
            </div>

            {/* BIỂU ĐỒ cột chồng POS/QR theo ngày (SVG nội bộ, cuộn ngang khi kỳ dài) */}
            <div className="rounded-2xl border border-line bg-white p-3.5 shadow-soft">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700">Doanh số theo ngày</span>
                <span className="flex items-center gap-2.5 text-[10.5px] text-slate-400">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-sky-500" /> POS</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-violet-500" /> QR</span>
                </span>
              </div>
              {d.byDay.length === 0 ? (
                <div className="py-6 text-center text-sm text-slate-400">Không có giao dịch trong kỳ.</div>
              ) : (
                <div className="overflow-x-auto">
                  <svg width={Math.max(320, d.byDay.length * 34)} height={170} className="block">
                    {d.byDay.map((r, idx) => {
                      const x = idx * 34 + 8;
                      const hTong = Math.round((r.doanhSo / maxNgay) * 120);
                      const posDs = r.kinds['POS']?.doanhSo ?? 0;
                      const hPos = r.doanhSo > 0 ? Math.round((posDs / r.doanhSo) * hTong) : 0;
                      return (
                        <g key={r.day}>
                          <rect x={x} y={140 - hTong} width={20} height={Math.max(1, hTong - hPos)} rx={3} fill="#8b5cf6" />
                          <rect x={x} y={140 - hPos} width={20} height={Math.max(1, hPos)} rx={3} fill="#0ea5e9" />
                          <text x={x + 10} y={140 - hTong - 4} textAnchor="middle" fontSize={8.5} fill="#475569" fontWeight={700}>{fmtGon(r.doanhSo).replace(' ', '')}</text>
                          <text x={x + 10} y={156} textAnchor="middle" fontSize={9} fill="#94a3b8">{r.day.slice(8, 10)}/{r.day.slice(5, 7)}</text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              )}
            </div>

            {/* BẢNG NGÀY */}
            <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-soft">
              <table className="w-full min-w-[640px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-appbg/60 text-[10px] uppercase tracking-wider text-slate-400">
                    <th className="px-3 py-2.5 text-left font-bold">Ngày</th>
                    <th className="px-3 py-2.5 text-right font-bold">Doanh số</th>
                    <th className="px-3 py-2.5 text-right font-bold">Lợi nhuận</th>
                    <th className="px-3 py-2.5 text-right font-bold">Phải hoàn NĐT</th>
                    <th className="px-3 py-2.5 text-right font-bold">GD</th>
                    <th className="px-3 py-2.5 text-left font-bold">POS / QR</th>
                  </tr>
                </thead>
                <tbody>
                  {[...d.byDay].reverse().map((r) => (
                    <tr key={r.day} className="border-b border-line/60 transition hover:bg-brand-tint/40">
                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-slate-600">{r.day.slice(8, 10)}/{r.day.slice(5, 7)}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums text-brand-deep">{r.doanhSo.toLocaleString('vi-VN')}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-600">{r.loiNhuan.toLocaleString('vi-VN')}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-amber-700">{(r.phaiHoanNdt ?? 0).toLocaleString('vi-VN')}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.count}</td>
                      <td className="px-3 py-2 text-[12px] text-slate-500">
                        <span className="text-sky-600">{fmtGon(r.kinds['POS']?.doanhSo ?? 0)}</span>
                        <span className="mx-1 text-slate-300">·</span>
                        <span className="text-violet-600">{fmtGon(r.kinds['QR']?.doanhSo ?? 0)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        );
      })()}
    </div>
  );
}

export function KpiReportScreen(): JSX.Element {
  // [Admin Demo 11/9] Chủ SigMa → KPI TOÀN CỤC (mọi sản phẩm gồm QR); đại lý → KPI của chính mình (cũ).
  if (isAlphaOwnerCode(getCachedAuthenticatedAgent()?.code)) return <AlphaKpiView />;
  return <DealerKpiScreen />;
}

function DealerKpiScreen(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [dl, setDl] = useState<DlState>('idle');
  const { showDownloadDone, downloadDialog } = useDownloadDialog();

  // Tải Excel báo cáo doanh số của CHÍNH đại lý — dùng ĐÚNG khoảng thời gian đang hiện (data.from/to) để file khớp
  // màn hình. downloadAttachment tự xử Web (<a download>) và APK (ghi Documents), fetch kèm cookie+CSRF qua proxyFetch.
  async function handleDownload(data: KpiReportData): Promise<void> {
    setDl('busy');
    try {
      const url = kpiExportXlsxUrl(data.from, data.to);
      const dayTag = data.to.slice(0, 10).replace(/-/g, '');
      const fileName = `BaoCaoDoanhSo_${dayTag}.xlsx`;
      const result = await downloadAttachment(url, fileName);
      setDl('ok');
      setTimeout(() => setDl('idle'), 2500);
      showDownloadDone(result, fileName); // hộp thoại "Đã tải xong. Mở file?" (Admin Demo 27/8).
    } catch {
      setDl('err');
      setTimeout(() => setDl('idle'), 4000);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchKpiReport().then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setState({ status: 'error', message: res.message });
        return;
      }
      setState({ status: 'ready', data: res.data });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white text-sm text-slate-400">
        <DotsLoader />
        Đang tải báo cáo KPI...
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white p-4 text-center text-sm text-danger">
        <p>Không tải được báo cáo KPI: {state.message}</p>
      </div>
    );
  }

  const { data } = state;
  const r = data.refund;
  const overUnder = r.totalRefundedAmount - r.totalRequiredAmount; // >0 thừa, <0 thiếu
  // Fix audit #4 — nhãn/màu theo NGƯỠNG ±3.000đ (khớp phần đếm), KHÔNG so tuyệt đối (tránh +2.000đ bị gọi "thừa").
  const overUnderKind: 'over' | 'short' | 'match' = Math.abs(overUnder) <= REFUND_MATCH_TOLERANCE_VND ? 'match' : overUnder > 0 ? 'over' : 'short';

  // ── Biểu đồ cột KÉP: Cần hoàn (sau phí) vs Đã hoàn — theo ngày ──────────────────────────────────────────
  const rdaily = r.daily;
  const maxAmount = Math.max(1, ...rdaily.map((d) => Math.max(d.requiredAmount, d.refundedAmount)));
  const barW = 12;
  const groupGap = 26;
  const pairGap = 4;
  const chartH = 190;
  const groupW = barW * 2 + pairGap;
  const chartWidth = Math.max(rdaily.length * (groupW + groupGap), 1);

  return (
    <div className="h-full overflow-auto bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-base font-bold text-slate-800">Báo cáo / KPI</h1>
          <p className="text-xs text-slate-400">30 ngày gần nhất</p>
        </div>
        <button
          type="button"
          onClick={() => void handleDownload(data)}
          disabled={dl === 'busy'}
          className={
            'flex shrink-0 items-center gap-1.5 rounded-lg-mac border px-3 py-2 text-xs font-semibold transition ' +
            (dl === 'err'
              ? 'border-danger/50 bg-danger/10 text-danger'
              : dl === 'ok'
                ? 'border-success/50 bg-success/10 text-success'
                : 'border-brand/40 bg-brand-tint text-brand hover:bg-brand/10 disabled:opacity-60')
          }
        >
          {dl === 'busy' ? (
            <>Đang tạo Excel…</>
          ) : dl === 'ok' ? (
            <>✓ Đã tải</>
          ) : dl === 'err' ? (
            <>Tải lỗi, thử lại</>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Tải Excel
            </>
          )}
        </button>
      </div>

      {/* Headline: doanh số trước phí + thực nhận sau phí + đã hoàn + thừa/thiếu */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg-mac border border-line bg-appbg p-4">
          <div className="text-xs text-slate-500">Doanh số (trước phí)</div>
          <div className="mt-1 text-lg font-bold text-slate-700">{fmtTrieu(data.totalRevenue)}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">{fmtVnd(data.totalRevenue)}đ · {data.totalLoCount} lô</div>
        </div>
        <div className="rounded-lg-mac border border-brand/30 bg-brand-tint p-4">
          <div className="text-xs text-slate-500">Thực nhận (sau phí)</div>
          <div className="mt-1 text-lg font-bold text-brand">{fmtTrieu(data.totalRevenueNet)}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">phí {fmtVnd(data.totalFee)}đ</div>
        </div>
        <div className="rounded-lg-mac border border-success/40 bg-success/10 p-4">
          <div className="text-xs text-slate-500">Đã hoàn (bill chuyển khoản)</div>
          <div className="mt-1 text-lg font-bold text-success">{fmtTrieu(r.totalRefundedAmount)}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">cần hoàn {fmtVnd(r.totalRequiredAmount)}đ</div>
        </div>
        <div
          className={
            'rounded-lg-mac border p-4 ' +
            (overUnderKind === 'over' ? 'border-danger/50 bg-danger/10' : overUnderKind === 'short' ? 'border-amber-300 bg-amber-50' : 'border-success/40 bg-success/10')
          }
        >
          <div className="text-xs text-slate-500">{overUnderKind === 'over' ? 'Hoàn thừa' : overUnderKind === 'short' ? 'Hoàn thiếu' : 'Hoàn khớp'}</div>
          <div className={'mt-1 text-lg font-bold ' + (overUnderKind === 'over' ? 'text-danger' : overUnderKind === 'short' ? 'text-amber-700' : 'text-success')}>
            {overUnderKind === 'match' ? (overUnder === 0 ? '0đ' : `±${fmtVnd(Math.abs(overUnder))}đ`) : `${overUnder > 0 ? '+' : '−'}${fmtVnd(Math.abs(overUnder))}đ`}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">so cần hoàn</div>
        </div>
      </div>

      {/* Trạng thái hoàn theo bill (đếm) */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className="rounded-lg-mac border border-line bg-appbg p-3">
          <div className="text-xs text-slate-500">Tổng bill</div>
          <div className="mt-1 text-base font-bold text-slate-700">{r.totalBillCount}</div>
        </div>
        <div className="rounded-lg-mac border border-success/40 bg-success/10 p-3">
          <div className="text-xs text-slate-500">Hoàn đủ</div>
          <div className="mt-1 text-base font-bold text-success">{r.totalRefundedCount}</div>
        </div>
        <div className="rounded-lg-mac border border-danger/50 bg-danger/10 p-3">
          <div className="text-xs text-slate-500">Hoàn thừa</div>
          <div className="mt-1 text-base font-bold text-danger">{r.totalOverCount}</div>
        </div>
        <div className="rounded-lg-mac border border-amber-300 bg-amber-50 p-3">
          <div className="text-xs text-slate-500">Hoàn thiếu</div>
          <div className="mt-1 text-base font-bold text-amber-700">{r.totalPartialCount}</div>
        </div>
        <div className="rounded-lg-mac border border-line bg-appbg p-3">
          <div className="text-xs text-slate-500">Chưa hoàn</div>
          <div className="mt-1 text-base font-bold text-slate-700">{r.totalUnrefundedCount}</div>
        </div>
      </div>

      {/* Biểu đồ TĂNG TRƯỞNG 3D — doanh số theo ngày (dữ liệu THẬT data.daily gross/net) */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-800">Tăng trưởng doanh số theo ngày</h2>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: '#1877d6' }} /> Trước phí</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: '#16a34a' }} /> Sau phí</span>
        </div>
      </div>
      <div className="mb-6">
        <GrowthChart3D points={data.daily.map((d) => ({ date: d.date, gross: d.amount, net: d.amountNet }))} />
      </div>

      {/* Biểu đồ cột kép: Cần hoàn vs Đã hoàn theo ngày */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-800">Cần hoàn vs Đã hoàn theo ngày</h2>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-300" /> Cần hoàn</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: '#16a34a' }} /> Đã hoàn</span>
        </div>
      </div>
      {rdaily.length === 0 ? (
        <div className="mb-6 rounded-lg-mac border border-line p-6 text-center text-sm text-slate-400">Chưa có bill quét/hoàn tiền nào trong khoảng thời gian này.</div>
      ) : (
        <div className="mb-6 overflow-x-auto rounded-lg-mac border border-line p-4">
          <svg width={chartWidth} height={chartH + 34} role="img" aria-label="Biểu đồ cần hoàn và đã hoàn theo ngày">
            {rdaily.map((d, i) => {
              const st = dayRefundState(d);
              const x = i * (groupW + groupGap);
              const hReq = Math.round((d.requiredAmount / maxAmount) * chartH);
              const hRef = Math.round((d.refundedAmount / maxAmount) * chartH);
              return (
                <g key={d.date}>
                  {/* Cần hoàn (xám) */}
                  <rect x={x} y={chartH - hReq} width={barW} height={hReq} rx={3} fill="#cbd5e1">
                    <title>{`${d.date} — Cần hoàn: ${fmtVnd(d.requiredAmount)}đ`}</title>
                  </rect>
                  {/* Đã hoàn (màu theo trạng thái) */}
                  <rect x={x + barW + pairGap} y={chartH - hRef} width={barW} height={hRef} rx={3} fill={REFUNDED_BAR_COLOR[st.kind]}>
                    <title>{`${d.date} — Đã hoàn: ${fmtVnd(d.refundedAmount)}đ (${st.kind === 'over' ? 'thừa' : st.kind === 'short' ? 'thiếu' : st.kind === 'none' ? 'chưa hoàn' : 'khớp'})`}</title>
                  </rect>
                  <text x={x + groupW / 2} y={chartH + 16} textAnchor="middle" fontSize="10" fill="#64748b">
                    {d.date.slice(5)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Bảng chi tiết theo ngày (kèm Thừa/Thiếu) */}
      {rdaily.length > 0 && (
        <div className="overflow-x-auto rounded-lg-mac border border-line">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead className="bg-appbg text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Ngày</th>
                <th className="px-3 py-2 font-semibold">Bill</th>
                <th className="px-3 py-2 font-semibold">Đủ</th>
                <th className="px-3 py-2 font-semibold">Thừa</th>
                <th className="px-3 py-2 font-semibold">Thiếu</th>
                <th className="px-3 py-2 font-semibold">Chưa</th>
                <th className="px-3 py-2 text-right font-semibold">Cần hoàn (đ)</th>
                <th className="px-3 py-2 text-right font-semibold">Đã hoàn (đ)</th>
                <th className="px-3 py-2 text-right font-semibold">Thừa/Thiếu (đ)</th>
              </tr>
            </thead>
            <tbody>
              {rdaily.map((d) => {
                const diff = d.refundedAmount - d.requiredAmount;
                return (
                  <tr key={d.date} className="border-t border-line">
                    <td className="px-3 py-2 text-slate-700">{d.date}</td>
                    <td className="px-3 py-2 text-slate-700">{d.billCount}</td>
                    <td className="px-3 py-2 text-success">{d.refundedCount}</td>
                    <td className="px-3 py-2 text-danger">{d.overCount}</td>
                    <td className="px-3 py-2 text-amber-700">{d.partialCount}</td>
                    <td className="px-3 py-2 text-slate-500">{d.unrefundedCount}</td>
                    <td className="px-3 py-2 text-right text-slate-700">{fmtVnd(d.requiredAmount)}</td>
                    <td className="px-3 py-2 text-right text-success">{fmtVnd(d.refundedAmount)}</td>
                    <td className={'px-3 py-2 text-right font-medium ' + (diff > 0 ? 'text-danger' : diff < 0 ? 'text-amber-700' : 'text-slate-400')}>
                      {diff === 0 ? '0' : `${diff > 0 ? '+' : '−'}${fmtVnd(Math.abs(diff))}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {downloadDialog}
    </div>
  );
}
