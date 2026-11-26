// DOANH SỐ NHÀ ĐẦU TƯ trong SigMa (Admin Demo 26/8) — nối bot-api THẬT (GET /v1/me/investor-report).
// Ai là thành viên nhóm chat NĐT (kể cả đại lý) đều xem được NĐT đó. Mỗi NĐT 1 thẻ: doanh số trước phí / thực
// nhận / lãi + nút "Tải Excel" (chi tiết theo TID, cùng file với desktop). Server tự kiểm quyền theo nhóm.
import { useEffect, useState, type JSX } from 'react';
import { fetchMyInvestorReport, investorReportExportXlsxUrl, fetchFilterOptions, fetchInvestorReportDetail, fetchMyInvestorSettlement, fetchInvestorAdvances, fetchInvestorAdvanceBills, editInvestorAdvance, type MyInvestorReport, type InvestorRow, type InvestorFilterOptions, type InvestorFilters, type InvestorReportDetail, type InvestorSettlementRow, type InvestorAdvanceItem, type InvestorAdvanceBillReport } from '../lib/investor-report-client';
import { InvestorBaocoCheck } from '../components/InvestorBaocoCheck';
import { downloadAttachment } from '../lib/attachment-blob';
import { DotsLoader } from '../components/DotsLoader';
import { InvestorDetailLots } from '../components/InvestorDetailLots';
import { InvestorAdvanceBillTable } from '../components/InvestorAdvanceBillTable';
import { useDownloadDialog } from '../components/DownloadDoneDialog';

import { isoToLocalParts, ymdToDmy } from '../lib/revenue-lot-xls';
const fmtVnd = (n: number): string => Math.round(n).toLocaleString('vi-VN');
const fmtTrieu = (n: number): string => `${(n / 1_000_000).toFixed(1)} triệu`;
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function today(): string {
  return ymd(new Date());
}
/** Hôm qua (local) — cho nút nhanh "Hôm qua" (Admin Demo 27/8). */
function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return ymd(d);
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: MyInvestorReport };
type DlState = 'idle' | 'busy' | 'ok' | 'err';

export function InvestorRevenueScreen(): JSX.Element {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [dl, setDl] = useState<Record<number, DlState>>({});
  // Bộ lọc (Admin Demo 27/8): ngân hàng / TID / tên HKD (tên POS).
  const [bankId, setBankId] = useState('');
  const [tidId, setTidId] = useState('');
  const [hkdName, setHkdName] = useState('');
  // [Admin Demo — CA TIỀN] '' = mọi ca; '1'/'2'/'3' theo giờ tổng kết bill (bảng mốc MB/MBB/ABB/MBV — ca-tien.ts).
  const [ca, setCa] = useState('');
  const [opts, setOpts] = useState<InvestorFilterOptions>({ tids: [], banks: [] });
  // CHI TIẾT theo Lô (Admin Demo 31/8 "NĐT cũng phải hiện chi tiết đồng nhất như đại lý") — mở/ẩn per NĐT, tải khi mở.
  const [detail, setDetail] = useState<Record<number, { status: 'loading' | 'error' | 'ready'; data?: InvestorReportDetail | null; message?: string }>>({});
  // ĐỐI SOÁT TẠM ỨNG NĐT (Admin Demo 31/8) — map theo investorId, tải cùng kỳ. NĐT chỉ thấy của MÌNH (route scoped).
  const [settle, setSettle] = useState<Record<number, InvestorSettlementRow>>({});
  // [Admin Demo 4/9] DANH SÁCH từng giao dịch tạm ứng NĐT (như list bill hoàn đại lý) — tải khi mở chi tiết 1 NĐT.
  const [advances, setAdvances] = useState<Record<number, { status: 'loading' | 'error' | 'ready'; data?: InvestorAdvanceItem[]; message?: string }>>({});
  // [Phản biện 17/9] ĐỐI SOÁT bill CK ⇄ tạm ứng: tải NGAY khi mở màn (không đợi bấm "Xem chi tiết") — tiền rơi mà
  // phải mở chi tiết mới thấy thì vẫn rơi im. Chip cảnh báo hiện thẳng trên thẻ NĐT; bảng chi tiết dùng lại data này.
  const [billRecon, setBillRecon] = useState<Record<number, InvestorAdvanceBillReport>>({});
  // [Nợ C3 11/9] SỬA tạm ứng NĐT: modal mật khẩu + ngày/giờ/tiền (khuôn sửa bill hoàn — nhập pass ra form).
  const [suaUng, setSuaUng] = useState<{ item: InvestorAdvanceItem; invId: number; pass: string; ngay: string; gio: string; tien: string; dangLuu: boolean; loi: string | null } | null>(null);
  function moSuaUng(invId: number, a: InvestorAdvanceItem): void {
    const { date, time } = isoToLocalParts(a.advanceDate);
    setSuaUng({ item: a, invId, pass: '', ngay: date, gio: time || '00:00', tien: String(a.amount), dangLuu: false, loi: null });
  }
  async function luuSuaUng(): Promise<void> {
    if (!suaUng) return;
    const tien = Number(suaUng.tien.replace(/[^\d]/g, ''));
    setSuaUng({ ...suaUng, dangLuu: true, loi: null });
    const r = await editInvestorAdvance({ advanceId: suaUng.item.id, editPassword: suaUng.pass, advanceDate: suaUng.ngay, advanceTime: suaUng.gio.slice(0, 5), amount: tien });
    if (!r.ok) { setSuaUng((s0) => (s0 ? { ...s0, dangLuu: false, loi: r.message } : s0)); return; }
    const invId = suaUng.invId;
    setSuaUng(null);
    // reload đúng nguồn: list ứng + settle + report (số phải-trả đổi theo).
    fetchInvestorAdvances(invId, from, to).then((res) => { setAdvances((s0) => ({ ...s0, [invId]: res.ok ? { status: 'ready', data: res.data.advances } : { status: 'error', message: res.message } })); });
    fetchMyInvestorSettlement(from, to, filters).then((res) => { if (res.ok) setSettle(Object.fromEntries(res.data.rows.map((x) => [x.investorId, x]))); });
    fetchMyInvestorReport(from, to, filters).then((res) => { if (res.ok) setState({ status: 'ready', data: res.data }); });
  }

  const { showDownloadDone, downloadDialog } = useDownloadDialog();
  const filters: InvestorFilters = { bankId: bankId ? Number(bankId) : undefined, tidId: tidId ? Number(tidId) : undefined, hkdName: hkdName.trim() || undefined, ca: ca === '1' || ca === '2' || ca === '3' ? (Number(ca) as 1 | 2 | 3) : undefined };

  function load(f: string, t: string): void {
    setState({ status: 'loading' });
    setDetail({}); // đổi kỳ/lọc → bỏ chi tiết cũ (tránh hiện số kỳ khác).
    setSettle({});
    setAdvances({});
    setBillRecon({});
    fetchMyInvestorReport(f, t, filters).then((res) => {
      if (!res.ok) { setState({ status: 'error', message: res.message }); return; }
      setState({ status: 'ready', data: res.data });
      // Đối soát bill CK cho TỪNG NĐT xem được (thường 2-4 nhà) — lỗi 1 nhà KHÔNG chặn nhà khác (R198: im lặng
      // là điều duy nhất bị cấm; nhà nào lỗi thì chip không hiện, bảng chi tiết sẽ tự gọi lại và báo lỗi rõ).
      for (const inv of res.data.investors) {
        fetchInvestorAdvanceBills(inv.investorId, f, t).then((rb) => {
          if (rb.ok) setBillRecon((s0) => ({ ...s0, [inv.investorId]: rb.data }));
          else console.error(`[ndt-bill-recon] NĐT ${inv.investorId}: không tải được đối soát bill CK — ${rb.message}`);
        });
      }
    });
    fetchMyInvestorSettlement(f, t, filters).then((res) => {
      if (res.ok) setSettle(Object.fromEntries(res.data.rows.map((r) => [r.investorId, r])));
    });
  }
  /** Mở/ẩn chi tiết theo Lô của 1 NĐT — tải khi mở lần đầu (đúng kỳ + bộ lọc đang chọn). */
  function toggleDetail(investorId: number): void {
    const cur = detail[investorId];
    if (cur) { setDetail((s) => { const n = { ...s }; delete n[investorId]; return n; }); setAdvances((s) => { const n = { ...s }; delete n[investorId]; return n; }); return; }
    setDetail((s) => ({ ...s, [investorId]: { status: 'loading' } }));
    fetchInvestorReportDetail(investorId, from, to, filters).then((res) => {
      setDetail((s) => ({ ...s, [investorId]: res.ok ? { status: 'ready', data: res.data } : { status: 'error', message: res.message } }));
    });
    // [Admin Demo 4/9] tải song song DANH SÁCH tạm ứng NĐT (từng giao dịch) — như list bill hoàn đại lý.
    setAdvances((s) => ({ ...s, [investorId]: { status: 'loading' } }));
    fetchInvestorAdvances(investorId, from, to).then((res) => {
      setAdvances((s) => ({ ...s, [investorId]: res.ok ? { status: 'ready', data: res.data.advances } : { status: 'error', message: res.message } }));
    });
  }
  /** Nút nhanh Hôm nay / Hôm qua — đặt from=to = ngày đó rồi tải lại (Admin Demo 27/8 "thêm nút hôm qua cho ... ngoài"). */
  function quickDay(d: string): void {
    setFrom(d);
    setTo(d);
    load(d, d);
  }
  useEffect(() => { load(today(), today()); fetchFilterOptions().then((r) => { if (r.ok) setOpts(r.data); }); }, []);
  // TID hiển thị theo ngân hàng đang chọn (nếu có).
  const tidOptions = bankId ? opts.tids.filter((t) => String(t.bankId) === bankId) : opts.tids;

  async function handleDownload(inv: InvestorRow): Promise<void> {
    setDl((s) => ({ ...s, [inv.investorId]: 'busy' }));
    try {
      const url = investorReportExportXlsxUrl(inv.investorId, from, to, filters);
      const tag = to.replace(/-/g, '');
      const safe = inv.investorName.replace(/[^\p{L}\d]+/gu, '') || `NDT${inv.investorId}`;
      const fileName = `BaoCaoNDT_${safe}_${tag}.xlsx`;
      const result = await downloadAttachment(url, fileName);
      setDl((s) => ({ ...s, [inv.investorId]: 'ok' }));
      setTimeout(() => setDl((s) => ({ ...s, [inv.investorId]: 'idle' })), 2500);
      showDownloadDone(result, fileName); // hộp thoại "Đã tải xong. Mở file?".
    } catch {
      setDl((s) => ({ ...s, [inv.investorId]: 'err' }));
      setTimeout(() => setDl((s) => ({ ...s, [inv.investorId]: 'idle' })), 4000);
    }
  }

  return (
    <div className="h-full overflow-auto bg-white px-4 pt-0 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {/* GHIM header + bộ lọc (Admin Demo 31/8 "ghim chống cuộn bị mất trôi lên trên") — pin đầu vùng cuộn, danh sách NĐT cuộn dưới. */}
      <div className="sticky top-0 z-20 -mx-4 mb-3 border-b border-line bg-white px-4 pt-3 pb-2 shadow-sm">
      <h1 className="mb-1 text-base font-bold text-slate-800">Doanh số nhà đầu tư</h1>
      <p className="mb-3 text-xs text-slate-400">Doanh số các nhà đầu tư trong nhóm chat của bạn.</p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-slate-500">Từ ngày
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="mt-1 rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm text-slate-700" />
        </label>
        <label className="flex flex-col text-xs text-slate-500">Đến ngày
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="mt-1 rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm text-slate-700" />
        </label>
        <label className="flex flex-col text-xs text-slate-500">Ngân hàng
          <select value={bankId} onChange={(e) => { setBankId(e.target.value); setTidId(''); }} className="mt-1 rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm text-slate-700">
            <option value="">Tất cả</option>
            {opts.banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">TID
          <select value={tidId} onChange={(e) => setTidId(e.target.value)} className="mt-1 rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm text-slate-700">
            <option value="">Tất cả</option>
            {tidOptions.map((t) => <option key={t.id} value={t.id}>{t.tid}{t.hkdName ? ` · ${t.hkdName}` : ''}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">Ca tiền
          <select value={ca} onChange={(e) => setCa(e.target.value)} className="mt-1 rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm text-slate-700">
            <option value="">Tất cả</option>
            <option value="1">Ca 1</option>
            <option value="2">Ca 2</option>
            <option value="3">Ca 3</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">Tên HKD (POS)
          <input type="text" value={hkdName} placeholder="Chứa chữ…" onChange={(e) => setHkdName(e.target.value)} className="mt-1 rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm text-slate-700" />
        </label>
        <button type="button" onClick={() => load(from, to)} className="rounded-lg-mac border border-brand/40 bg-brand-tint px-3 py-2 text-xs font-semibold text-brand hover:bg-brand/10">Xem</button>
        <button type="button" onClick={() => quickDay(today())} className="rounded-lg-mac border border-line bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand">Hôm nay</button>
        <button type="button" onClick={() => quickDay(yesterday())} className="rounded-lg-mac border border-line bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand">Hôm qua</button>
      </div>
      </div>

      {state.status === 'loading' && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-slate-400"><DotsLoader /> Đang tải…</div>
      )}
      {state.status === 'error' && (
        <div className="rounded-lg-mac border border-danger/40 bg-danger/10 p-4 text-center text-sm text-danger">Không tải được: {state.message}</div>
      )}
      {state.status === 'ready' && state.data.investors.length === 0 && (
        <div className="rounded-lg-mac border border-line p-8 text-center text-sm text-slate-400">Bạn không ở nhóm nhà đầu tư nào (hoặc không có doanh số trong kỳ).</div>
      )}
      {state.status === 'ready' && state.data.investors.length > 0 && (
        <div className="flex flex-col gap-3">
          {state.data.investors.map((inv) => {
            const d = dl[inv.investorId] ?? 'idle';
            return (
              <div key={inv.investorId} className="rounded-lg-mac border border-line bg-appbg p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold text-slate-800">{inv.investorName}</div>
                    <div className="text-[11px] text-slate-400">{inv.code} · {inv.soBill} bill</div>
                    {/* [Phản biện 17/9] CHIP CẢNH BÁO ngay trên thẻ — KHÔNG bắt mở chi tiết mới thấy tiền rơi.
                        Đỏ = bill CK đã OCR mà chưa vào tạm ứng (ca nuốt 1,2 tỷ); hổ phách = ghi lệch số tiền. */}
                    {(() => {
                      const br = billRecon[inv.investorId];
                      if (!br) return null;
                      return (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {br.soBillChuaGhi > 0 && (
                            <span data-testid="chip-bill-chua-ghi" className="rounded-full bg-danger px-2 py-0.5 text-[10.5px] font-bold text-white">
                              ⚠ {br.soBillChuaGhi} bill CK CHƯA vào tạm ứng · {fmtVnd(br.tienChuaGhi)}đ
                            </span>
                          )}
                          {br.soBillLechTien > 0 && (
                            <span data-testid="chip-bill-lech-tien" className="rounded-full bg-amber-500 px-2 py-0.5 text-[10.5px] font-bold text-white">
                              ≠ {br.soBillLechTien} bill lệch tiền · {br.tienLechGhi > 0 ? '+' : ''}{fmtVnd(br.tienLechGhi)}đ
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDownload(inv)}
                    disabled={d === 'busy'}
                    className={
                      'flex shrink-0 items-center gap-1.5 rounded-lg-mac border px-3 py-2 text-xs font-semibold transition ' +
                      (d === 'err' ? 'border-danger/50 bg-danger/10 text-danger'
                        : d === 'ok' ? 'border-success/50 bg-success/10 text-success'
                          : 'border-brand/40 bg-brand-tint text-brand hover:bg-brand/10 disabled:opacity-60')
                    }
                  >
                    {d === 'busy' ? 'Đang tạo…' : d === 'ok' ? '✓ Đã tải' : d === 'err' ? 'Lỗi, thử lại' : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Tải Excel
                      </>
                    )}
                  </button>
                  {/* [Admin Demo 13/9 "nút check phải đồng bộ màn doanh số và phòng chat"] — CÙNG component với phòng chat. */}
                  <InvestorBaocoCheck investorId={inv.investorId} from={from} to={to} />
                </div>
                {/* ĐÃ HOÀN + PHẢI TRẢ LÊN ĐẦU (Admin Demo 1/9 "đã hoàn, thừa thiếu lên đầu phần ghim") — đọc ngay,
                    canh phải tabular-nums, màu ngữ nghĩa (SigMa còn nợ=xanh · NĐT nợ lại=đỏ). Breakdown đầy đủ ở dưới. */}
                {settle[inv.investorId] && (() => {
                  const s = settle[inv.investorId]!;
                  const pos = s.phaiTra >= 0;
                  return (
                    <div className="mb-3 grid grid-cols-2 gap-2">
                      <div className="rounded-lg-mac border border-amber-200 bg-amber-50 p-2.5">
                        <div className="text-[10px] font-semibold uppercase text-amber-600/90">↻ Đã hoàn</div>
                        <div className="mt-0.5 text-base font-extrabold tabular-nums text-amber-600">{fmtVnd(s.daHoan)}đ</div>
                      </div>
                      <div className={`rounded-lg-mac border p-2.5 ${pos ? 'border-success/30 bg-success/10' : 'border-danger/30 bg-danger/10'}`}>
                        <div className={`text-[10px] font-semibold uppercase ${pos ? 'text-success' : 'text-danger'}`}>{pos ? 'SigMa phải trả' : 'NĐT nợ lại'}</div>
                        <div className={`mt-0.5 text-base font-extrabold tabular-nums ${pos ? 'text-success' : 'text-danger'}`}>{pos ? '+' : ''}{fmtVnd(s.phaiTra)}đ</div>
                      </div>
                    </div>
                  );
                })()}
                {/* [Admin Demo 12/9 "số phải hoàn về phải hiện trong danh sách doanh số ở NĐT"] thêm ô PHẢI HOÀN VỀ
                    = tiền về (sau phí cài máy) + lãi NĐT — cùng công thức khối đối chiếu số dư ở Tra soát. */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Doanh số (trước phí)</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-700">{fmtTrieu(inv.doanhThu)}</div>
                    <div className="text-[10px] text-slate-400">{fmtVnd(inv.doanhThu)}đ</div>
                  </div>
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Tiền về (sau phí)</div>
                    <div className="mt-0.5 text-sm font-bold text-brand">{fmtTrieu(inv.tienVe)}</div>
                    <div className="text-[10px] text-slate-400">{fmtVnd(inv.tienVe)}đ</div>
                  </div>
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Lãi NĐT (0,1%)</div>
                    <div className="mt-0.5 text-sm font-bold text-success">{fmtVnd(inv.laiNDT)}đ</div>
                  </div>
                  {/* [Admin Demo 13/9 "là số đã tạm ứng − sau phí cm + lãi chứ"] SỬA CÔNG THỨC: phải hoàn về
                      = TẠM ỨNG − tiền về (sau phí cài máy) + lãi. Giữ dấu: âm = NĐT nhận dư/chưa ứng đủ. */}
                  {/* [Admin Demo 13/9 "phải có ô đã tạm ứng, đã hoàn về"] 2 ô LUÔN hiện (0 nếu chưa có). */}
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Đã tạm ứng</div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-700">{fmtVnd(settle[inv.investorId]?.tamUng ?? 0)}đ</div>
                  </div>
                  <div className="rounded-lg-mac bg-white p-2.5">
                    <div className="text-[11px] text-slate-500">Đã hoàn về NĐT</div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums text-emerald-700">{fmtVnd(settle[inv.investorId]?.daHoan ?? 0)}đ</div>
                  </div>
                  {/* [Admin Demo 13/9 "tách riêng QR — trả theo phí mua, không tạm ứng"] Ô tạm ứng CHỈ POS (trừ QR
                      per-GD); NĐT có QR thêm ô tím "trả SigMa theo phí mua". NĐT THUẦN QR → chỉ ô tím. */}
                  {(() => {
                    const q = inv.qr ?? null;
                    const tvPos = inv.tienVe - (q?.tvTrongReport ?? 0);
                    const laiPos = inv.laiNDT - (q?.laiTrongReport ?? 0);
                    const thuanQr = q != null && tvPos === 0 && (settle[inv.investorId]?.tamUng ?? 0) === 0;
                    const phv = (settle[inv.investorId]?.tamUng ?? 0) - tvPos + laiPos;
                    return (
                      <>
                        {!thuanQr && (
                          <div className="rounded-lg-mac border border-amber-300/60 bg-amber-50 p-2.5" data-testid={`phai-hoan-ve-${inv.investorId}`}>
                            <div className="text-[11px] font-semibold text-amber-700">Phải hoàn về (ứng − sau phí + lãi{q ? ', POS' : ''})</div>
                            <div className={`mt-0.5 text-sm font-extrabold tabular-nums ${phv < 0 ? 'text-danger' : 'text-amber-700'}`}>{phv < 0 ? '−' : ''}{fmtTrieu(Math.abs(phv))}</div>
                            <div className="text-[10px] text-amber-600/80">{phv < 0 ? '−' : ''}{fmtVnd(Math.abs(phv))}đ · ứng {fmtVnd(settle[inv.investorId]?.tamUng ?? 0)}đ</div>
                          </div>
                        )}
                        {q && (
                          <div className="rounded-lg-mac border border-violet-300/60 bg-violet-50 p-2.5" data-testid={`qr-tra-alpha-${inv.investorId}`}>
                            <div className="text-[11px] font-semibold text-violet-700">NĐT trả SigMa (QR, sau phí mua)</div>
                            <div className="mt-0.5 text-sm font-extrabold tabular-nums text-violet-700">{fmtTrieu(q.traAlpha)}</div>
                            <div className="text-[10px] text-violet-600/80">{fmtVnd(q.traAlpha)}đ · giữ phí mua {fmtVnd(q.phiMuaGiu)}đ · {q.soBill} GD</div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
                {/* ĐỐI SOÁT TẠM ỨNG (Admin Demo 31/8) — phải trả = tạm ứng − tiền về + lãi (giữ dấu). Dương = SigMa còn
                    nợ NĐT (SigMa phải trả); Âm = NĐT nhận dư, nợ lại SigMa. Icon/màu đồng bộ màn khác. */}
                {settle[inv.investorId] && (
                  <div className="mt-3 rounded-lg-mac border border-brand/20 bg-brand/5 p-2.5">
                    <div className="mb-1.5 text-[11px] font-bold uppercase text-brand">↻ Đối soát tạm ứng (kỳ)</div>
                    {/* grid-cols-2 mobile → 4 desktop: số tiền lớn KHÔNG bị cắt ở 390px (Admin Demo 1/9 "không tràn ngang mobile"). */}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div className="rounded-lg-mac bg-white p-2">
                        <div className="text-[10px] text-slate-500">Tạm ứng</div>
                        <div className="mt-0.5 text-xs font-bold tabular-nums text-slate-700">{fmtVnd(settle[inv.investorId]!.tamUng)}đ</div>
                      </div>
                      <div className="rounded-lg-mac bg-white p-2">
                        <div className="text-[10px] text-slate-500">Tiền về (sau phí cài máy)</div>
                        <div className="mt-0.5 text-xs font-bold tabular-nums text-brand">{fmtVnd(settle[inv.investorId]!.tienVe)}đ</div>
                      </div>
                      <div className="rounded-lg-mac bg-white p-2">
                        <div className="text-[10px] text-slate-500">Lãi 0,1%</div>
                        <div className="mt-0.5 text-xs font-bold tabular-nums text-success">{fmtVnd(settle[inv.investorId]!.laiNDT)}đ</div>
                      </div>
                      <div className="rounded-lg-mac bg-white p-2">
                        <div className="text-[10px] text-slate-500">Đã hoàn</div>
                        <div className="mt-0.5 text-xs font-bold tabular-nums text-amber-600">{fmtVnd(settle[inv.investorId]!.daHoan)}đ</div>
                      </div>
                    </div>
                    {(() => {
                      const st2 = settle[inv.investorId]!;
                      // [Admin Demo 12/9] PHẢI HOÀN NĐT (gốc, CHƯA trừ đã hoàn) = tạm ứng − tiền về (sau phí cài máy) + lãi NĐT.
                      const phaiHoan = st2.tamUng - st2.tienVe + st2.laiNDT;
                      const pt = st2.phaiTra;
                      const pos = pt >= 0;
                      return (
                        <>
                          <div className="mt-2 flex items-center justify-between rounded-lg-mac bg-brand/10 px-2.5 py-1.5" data-testid="phai-hoan-ndt">
                            <span className="text-[11px] font-semibold text-slate-600">Phải hoàn NĐT <span className="text-slate-400">(tạm ứng − tiền về + lãi)</span></span>
                            <span className="text-sm font-extrabold tabular-nums text-brand-deep">{phaiHoan >= 0 ? '' : '−'}{fmtVnd(Math.abs(phaiHoan))}đ</span>
                          </div>
                          <div className={`mt-1.5 flex items-center justify-between rounded-lg-mac px-2.5 py-1.5 ${pos ? 'bg-success/10' : 'bg-danger/10'}`}>
                            <span className="text-[11px] font-semibold text-slate-600">{pos ? 'Còn phải trả (đã trừ đã hoàn)' : 'NĐT nhận dư — nợ lại SigMa'}</span>
                            <span className={`text-sm font-extrabold tabular-nums ${pos ? 'text-success' : 'text-danger'}`}>{pos ? '+' : ''}{fmtVnd(pt)}đ</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
                {/* Chi tiết theo Lô (đồng nhất đại lý) — mở/ẩn, tải khi mở. */}
                <button
                  type="button"
                  onClick={() => toggleDetail(inv.investorId)}
                  className="mt-3 w-full rounded-lg-mac border border-line bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-brand hover:text-brand"
                >
                  {detail[inv.investorId] ? '▲ Ẩn chi tiết theo Lô' : '▼ Xem chi tiết theo Lô'}
                </button>
                {detail[inv.investorId] && (
                  <div className="mt-2">
                    {detail[inv.investorId].status === 'loading' && (
                      <div className="flex items-center justify-center gap-2 py-4 text-xs text-slate-400"><DotsLoader /> Đang tải chi tiết…</div>
                    )}
                    {detail[inv.investorId].status === 'error' && (
                      <p className="py-3 text-center text-xs text-danger">Không tải được chi tiết: {detail[inv.investorId].message}</p>
                    )}
                    {detail[inv.investorId].status === 'ready' && (
                      <InvestorDetailLots bills={detail[inv.investorId].data?.bills ?? []} investorName={inv.investorName} />
                    )}
                    {/* [Admin Demo 4/9] DANH SÁCH TẠM ỨNG NĐT — từng giao dịch (ngày·giờ·số tiền·người ứng→nhận·nội dung), như list bill hoàn đại lý. */}
                    {advances[inv.investorId] && (
                      <div className="mt-3">
                        <div className="mb-1 px-0.5 text-[10.5px] font-bold uppercase tracking-wide text-slate-400">Danh sách tạm ứng {advances[inv.investorId].status === 'ready' ? `(${advances[inv.investorId].data?.length ?? 0})` : ''}</div>
                        {advances[inv.investorId].status === 'loading' && <div className="py-2 text-center text-xs text-slate-400">Đang tải tạm ứng…</div>}
                        {advances[inv.investorId].status === 'error' && <p className="py-2 text-center text-xs text-danger">Không tải được tạm ứng: {advances[inv.investorId].message}</p>}
                        {advances[inv.investorId].status === 'ready' && ((advances[inv.investorId].data?.length ?? 0) === 0
                          ? <div className="rounded-lg border border-dashed border-line py-2 text-center text-xs text-slate-400">Chưa có giao dịch tạm ứng trong kỳ.</div>
                          : <div className="overflow-x-auto rounded-lg border border-line">
                              <table className="w-full text-xs">
                                <thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr>
                                  <th className="px-2 py-1 text-left font-semibold">Ngày</th><th className="px-2 py-1 text-left font-semibold">Giờ</th>
                                  <th className="px-2 py-1 text-right font-semibold">Số tiền ứng</th><th className="px-2 py-1 text-left font-semibold">Người ứng → nhận</th>
                                  <th className="px-2 py-1 text-left font-semibold">Nội dung</th>
                                  <th className="px-2 py-1 text-center font-semibold">Sửa</th>
                                </tr></thead>
                                <tbody>
                                  {advances[inv.investorId].data!.map((a) => { const { date, time } = isoToLocalParts(a.advanceDate); return (
                                    <tr key={a.id} className="border-t border-line/60 odd:bg-white even:bg-slate-50/40">
                                      <td className="whitespace-nowrap px-2 py-1 tabular-nums">{ymdToDmy(date)}</td>
                                      <td className="whitespace-nowrap px-2 py-1 tabular-nums text-slate-500">{time || '—'}</td>
                                      <td className="whitespace-nowrap px-2 py-1 text-right font-bold tabular-nums text-brand">{fmtVnd(a.amount)}đ</td>
                                      <td className="px-2 py-1">{a.senderName ?? '—'} → {a.receiverName ?? '—'}</td>
                                      <td className="px-2 py-1 text-slate-500">{a.note ?? '—'}</td>
                                      <td className="px-2 py-1 text-center">
                                        <button type="button" onClick={() => moSuaUng(inv.investorId, a)} title="Sửa ngày/giờ/số tiền (cần mật khẩu sửa)"
                                          className="rounded-full border border-brand/30 bg-brand/5 px-1.5 py-0.5 text-[10px] font-bold text-brand hover:bg-brand/10">✏ Sửa</button>
                                      </td>
                                    </tr>
                                  ); })}
                                </tbody>
                              </table>
                            </div>
                        )}
                      </div>
                    )}
                    {/* [Admin Demo 17/9] BẢNG BILL CK ĐÃ OCR ⇄ tạm ứng đã ghi — bill không ghép được dòng tiền hiện ĐỎ
                        + banner LỆCH (ca thật: 1,2 tỷ nhà Trung bị lưới chống-trùng nuốt câm, không đâu nhìn thấy). */}
                    <InvestorAdvanceBillTable investorId={inv.investorId} from={from} to={to} report={billRecon[inv.investorId] ?? null} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {suaUng && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" onClick={() => !suaUng.dangLuu && setSuaUng(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 text-sm font-extrabold text-slate-800">✏ Sửa tạm ứng/hoàn NĐT · <span className="text-brand">{fmtVnd(suaUng.item.amount)}đ</span></div>
            <p className="mb-3 text-[11px] text-slate-400">{suaUng.item.senderName ?? '—'} → {suaUng.item.receiverName ?? '—'} · sửa xong số liệu tất toán đổi theo NGAY.</p>
            <label className="mb-2 block text-xs font-semibold text-slate-500">Mật khẩu sửa
              <input type="password" value={suaUng.pass} autoFocus onChange={(e) => setSuaUng({ ...suaUng, pass: e.target.value })}
                className="mt-1 w-full rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm" placeholder="Mặc định 1111" />
            </label>
            <div className="mb-2 grid grid-cols-2 gap-2">
              <label className="block text-xs font-semibold text-slate-500">Ngày
                <input type="date" value={suaUng.ngay} onChange={(e) => setSuaUng({ ...suaUng, ngay: e.target.value })} className="mt-1 w-full rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm" />
              </label>
              <label className="block text-xs font-semibold text-slate-500">Giờ
                <input type="time" value={suaUng.gio} onChange={(e) => setSuaUng({ ...suaUng, gio: e.target.value })} className="mt-1 w-full rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm" />
              </label>
            </div>
            <label className="mb-3 block text-xs font-semibold text-slate-500">Số tiền (VND)
              <input type="text" inputMode="numeric" value={Number(suaUng.tien.replace(/[^\d]/g, '') || '0').toLocaleString('vi-VN')}
                onChange={(e) => setSuaUng({ ...suaUng, tien: e.target.value.replace(/[^\d]/g, '') })}
                className="mt-1 w-full rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-right text-sm font-bold tabular-nums" />
            </label>
            {suaUng.loi && <p className="mb-2 rounded-lg border border-danger/40 bg-danger/10 px-2 py-1 text-xs font-semibold text-danger">{suaUng.loi}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={suaUng.dangLuu} onClick={() => void luuSuaUng()}
                className="flex-1 rounded-lg-mac bg-brand px-3 py-2 text-sm font-bold text-white disabled:opacity-50">{suaUng.dangLuu ? 'Đang lưu…' : '✓ Xác nhận sửa — ghi nhận giá trị mới'}</button>
              <button type="button" disabled={suaUng.dangLuu} onClick={() => setSuaUng(null)} className="rounded-lg-mac border border-line px-3 py-2 text-sm font-semibold text-slate-500">Huỷ</button>
            </div>
          </div>
        </div>
      )}
      {downloadDialog}
    </div>
  );
}
