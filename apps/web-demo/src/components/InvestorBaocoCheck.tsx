// [Admin Demo 13/9] NÚT + PANEL "CHECK SAO KÊ" báo có NĐT — DÙNG CHUNG màn Doanh số NĐT (menu) + phòng chat NĐT
// ("nút check này phải hiển thị đồng bộ màn doanh số và phòng chat" — 1 component, cấm chép 2 nơi).
// MB = user + mật khẩu (kéo tự động qua server; đăng nhập lưu server, lần sau bỏ trống); MBV = tải file .xlsx.
// Đối chiếu: từng LÔ tiền về sau phí cài máy của máy NĐT ✅ đã thấy báo có / ❌ chưa về / 🟡 báo có không khớp lô.
import { useState } from 'react';
import { fetchInvestorBaoco, uploadInvestorBaoco, exportInvestorSaoke, type InvestorBaocoData } from '../lib/ocr-send-api';
import { downloadBlob } from '../lib/attachment-blob';
import { useDownloadDialog } from './DownloadDoneDialog';

function ymdLocal(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function InvestorBaocoCheck({ investorId, from, to }: { investorId: number; from: string; to: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'MB' | 'MBV' | 'LUU'>('MB');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [acct, setAcct] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<InvestorBaocoData | null>(null);
  const [moLo, setMoLo] = useState(false);
  /** Chạy lại theo TAB hiện tại với kỳ f→t (nút Hôm nay/Hôm qua bấm là CHẠY luôn — Admin Demo 13/9). */
  const chay = (f: string, t: string): void => {
    if (tab === 'MBV') { setErr('Chọn file .xlsx để đối chiếu kỳ này.'); return; }
    setBusy(true); setErr(null); setData(null);
    const cred = tab === 'MB'
      ? { username: user || undefined, password: pass || undefined, accountNumber: acct || undefined }
      : { source: 'CACHE' as const };
    void fetchInvestorBaoco(investorId, f, t, cred)
      .then((r) => { setBusy(false); if (r.ok) { setData(r.data); setPass(''); } else setErr(r.message ?? r.error); });
  };
  // [Admin Demo 13/9] KỲ chọn NGAY TRONG PANEL (từ-đến / Hôm qua / Hôm nay) + lọc CA hiển thị.
  const [fromD, setFromD] = useState(from);
  const [toD, setToD] = useState(to);
  const [caLoc, setCaLoc] = useState<0 | 1 | 2 | 3>(0);
  const [moNhom, setMoNhom] = useState<string | null>(null); // hàng ca đang xổ chi tiết lô
  const [taiSk, setTaiSk] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  // [Admin Demo 13/9 "không có nút mở khi tải xong à"] hộp thoại sau tải (nút MỞ FILE) — cùng khuôn màn Tra soát.
  const { showDownloadDone, downloadDialog } = useDownloadDialog();
  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setErr(null); }}
        className="flex shrink-0 items-center gap-1.5 rounded-lg-mac border border-violet-400/60 bg-white px-3 py-2 text-xs font-semibold text-violet-700 transition hover:bg-violet-50"
        data-testid="btn-check-saoke"
      >
        🏦 Check sao kê
      </button>
      {open && (
        <div className="order-last w-full rounded-lg-mac border border-violet-300/60 bg-white p-3" data-testid="panel-check-saoke">
          <div className="mb-2 flex items-center gap-1">
            <button type="button" onClick={() => setOpen(false)} className="mr-1 rounded-lg border border-line bg-white px-2 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-100" title="Thu gọn">▲ Thu gọn</button>
            {/* [Admin Demo 13/9 "thêm nút tải sao kê — đúng định dạng"] tải .xlsx bố cục SAO KÊ MB chuẩn theo kỳ chọn. */}
            <button type="button" disabled={taiSk === 'busy'}
              onClick={() => {
                setTaiSk('busy');
                void exportInvestorSaoke(investorId, fromD, toD, acct || undefined).then(async (r) => {
                  if (!r.ok) { setTaiSk('err'); setErr(r.message ?? 'Không tải được sao kê.'); setTimeout(() => setTaiSk('idle'), 3000); return; }
                  const fileName = `SaoKe_${fromD.replace(/-/g, '')}_${toD.replace(/-/g, '')}.xlsx`;
                  const result = await downloadBlob(r.data, fileName);
                  setTaiSk('ok'); setTimeout(() => setTaiSk('idle'), 2500);
                  showDownloadDone(result, fileName); // hộp thoại "Đã tải" + nút MỞ FILE
                });
              }}
              className={'mr-1 rounded-lg border px-2 py-1 text-[11px] font-bold ' + (taiSk === 'ok' ? 'border-success/40 bg-success/10 text-success' : taiSk === 'err' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-emerald-400/60 bg-white text-emerald-700 hover:bg-emerald-50')}>
              {taiSk === 'busy' ? 'Đang tạo…' : taiSk === 'ok' ? '✓ Đã tải' : taiSk === 'err' ? 'Lỗi tải' : '⬇ Tải sao kê'}
            </button>
            {(['MB', 'MBV', 'LUU'] as const).map((t) => (
              <button key={t} type="button" onClick={() => { setTab(t); setErr(null); }}
                className={'rounded-lg px-3 py-1 text-xs font-bold ' + (tab === t ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-500')}>
                {t === 'MB' ? 'MB — tự động' : t === 'MBV' ? 'MBV — tải file' : '📂 Đã lưu'}
              </button>
            ))}
          </div>
          {/* ── KỲ + LỌC CA (Admin Demo 13/9 "cho chọn theo kỳ ngày đến ngày, hôm qua, hôm nay, ca 1 ca 2") ── */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className="rounded-lg border border-line px-2 py-1 text-[13px]" />
            <span className="text-slate-400">→</span>
            <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className="rounded-lg border border-line px-2 py-1 text-[13px]" />
            <button type="button" disabled={busy} onClick={() => { const d = ymdLocal(0); setFromD(d); setToD(d); chay(d, d); }} className="rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Hôm nay</button>
            <button type="button" disabled={busy} onClick={() => { const d = ymdLocal(-1); setFromD(d); setToD(d); chay(d, d); }} className="rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Hôm qua</button>
            <span className="mx-1 h-4 w-px bg-line" />
            {([['Tất cả ca', 0], ['Ca 1', 1], ['Ca 2', 2], ['Ca 3', 3]] as const).map(([lb, v]) => (
              <button key={v} type="button" onClick={() => setCaLoc(v)}
                className={'rounded-full px-2.5 py-1 text-[11px] font-bold ' + (caLoc === v ? 'bg-brand text-white' : 'border border-line bg-white text-slate-600 hover:bg-slate-50')}>
                {lb}
              </button>
            ))}
          </div>
          {tab === 'MB' && (
            <div className="flex flex-wrap items-center gap-2">
              <input value={acct} onChange={(e) => setAcct(e.target.value.replace(/\D/g, ''))} placeholder="Số TK (trống = TK đã lưu)" className="w-44 rounded-lg border border-line px-2 py-1.5 text-sm" />
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="User MB (trống = đã lưu)" className="w-40 rounded-lg border border-line px-2 py-1.5 text-sm" autoComplete="off" />
              <input value={pass} onChange={(e) => setPass(e.target.value)} type="password" placeholder="Mật khẩu" className="w-36 rounded-lg border border-line px-2 py-1.5 text-sm" autoComplete="new-password" />
              <button type="button" disabled={busy}
                onClick={() => {
                  setBusy(true); setErr(null); setData(null);
                  void fetchInvestorBaoco(investorId, fromD, toD, { username: user || undefined, password: pass || undefined, accountNumber: acct || undefined })
                    .then((r) => { setBusy(false); if (r.ok) { setData(r.data); setPass(''); } else setErr(r.message ?? r.error); });
                }}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50">
                {busy ? 'Đang kéo… (có thể 1-2 phút)' : 'Kéo sao kê'}
              </button>
            </div>
          )}
          {tab === 'LUU' && (
            <div className="flex items-center gap-2">
              <button type="button" disabled={busy}
                onClick={() => {
                  setBusy(true); setErr(null); setData(null);
                  void fetchInvestorBaoco(investorId, fromD, toD, { source: 'CACHE' })
                    .then((r) => { setBusy(false); if (r.ok) setData(r.data); else setErr(r.message ?? r.error); });
                }}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50">
                {busy ? 'Đang đọc…' : 'Xem sao kê đã lưu (kỳ trên)'}
              </button>
              <span className="text-[11px] text-slate-400">sao kê đã kéo MB / tải file trước đó — chọn kỳ ở trên rồi bấm</span>
            </div>
          )}
          {tab === 'MBV' && (
            <div className="flex items-center gap-2">
              <input type="file" accept=".xlsx" disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setBusy(true); setErr(null); setData(null);
                  void uploadInvestorBaoco(investorId, fromD, toD, f)
                    .then((r) => { setBusy(false); if (r.ok) setData(r.data); else setErr(r.message ?? r.error); });
                  e.target.value = '';
                }}
                className="text-sm" />
              {busy && <span className="text-xs text-slate-400">đang đọc file…</span>}
            </div>
          )}
          {err && <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[13px] text-rose-700">{err}</p>}
          {data && (
            <div className="mt-2">
              {/* ── 4 Ô TỔNG ── */}
              {/* [Admin Demo 14/9 "sao về 4xx tr — thiếu à?"] TIỀN ĐÃ VỀ = TỔNG BÁO CÓ (đưa lên đầu, to). "Đã ghép
                  khớp" chỉ là phần máy tự ghép được — KHÔNG phải tiền về, tránh đọc nhầm thiếu tiền. */}
              <div className="mb-2 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-2 py-2"><div className="text-[10px] font-bold uppercase tracking-wide text-emerald-600">TIỀN ĐÃ VỀ (Σ báo có {data.baoco.length})</div><div className="text-base font-extrabold tabular-nums text-emerald-700">{data.tongBaoco.toLocaleString('vi-VN')}đ</div></div>
                <div className="rounded-xl border border-line bg-slate-50 px-2 py-2"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Kỳ vọng (DS sau phí)</div><div className="text-base font-extrabold tabular-nums text-slate-800">{data.tongTienVeKyVong.toLocaleString('vi-VN')}đ</div></div>
                {(() => { const lech = data.tongBaoco - data.tongTienVeKyVong; const du = lech >= 0; return (
                  <div className={`rounded-xl border px-2 py-2 ${du ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}><div className={`text-[10px] font-bold uppercase tracking-wide ${du ? 'text-emerald-600' : 'text-rose-600'}`}>{du ? 'VỀ ĐỦ · dư' : 'VỀ THIẾU'}</div><div className={`text-base font-extrabold tabular-nums ${du ? 'text-emerald-700' : 'text-rose-700'}`}>{lech > 0 ? '+' : ''}{lech.toLocaleString('vi-VN')}đ</div></div>
                ); })()}
                <div className="rounded-xl border border-violet-200 bg-violet-50 px-2 py-2"><div className="text-[10px] font-bold uppercase tracking-wide text-violet-500">Đã ghép khớp máy·ca</div><div className="text-base font-extrabold tabular-nums text-violet-700">{data.tongDaKhop.toLocaleString('vi-VN')}đ</div><div className="text-[9px] text-violet-400">phần chưa ghép vẫn ĐÃ VỀ — xem 🟡</div></div>
              </div>

              {/* ── KẾT CHUYỂN THEO CA — TỪNG MÁY (đủ cột: trước phí · sau phí · thực về · chênh lệch · khớp; kẻ rõ) ── */}
              {(() => {
                const rows = (data.nhomCa ?? []).filter((g) => caLoc === 0 || g.ca === caLoc);
                if (rows.length === 0) return null;
                const sum = (f: (g: typeof rows[number]) => number): number => rows.reduce((s2, g) => s2 + f(g), 0);
                return (
                  <div className="mb-2 overflow-x-auto rounded-xl border-2 border-slate-300">
                    <table className="w-full min-w-[760px] border-collapse text-[12px] [&_td]:border [&_td]:border-slate-200 [&_th]:border [&_th]:border-slate-300">
                      <thead>
                        <tr className="bg-slate-100 text-[10px] uppercase tracking-wide text-slate-500">
                          <th className="px-2 py-2 text-left font-bold">Ngày</th>
                          <th className="px-2 py-2 text-left font-bold">Bộ máy (HKD)</th>
                          <th className="px-2 py-2 text-center font-bold">Ca</th>
                          <th className="px-2 py-2 text-right font-bold">Số lô</th>
                          <th className="px-2 py-2 text-right font-bold">DS trước phí</th>
                          <th className="px-2 py-2 text-right font-bold">Sau phí (kỳ vọng)</th>
                          <th className="px-2 py-2 text-right font-bold">Thực về</th>
                          <th className="px-2 py-2 text-right font-bold">Chênh lệch</th>
                          <th className="px-2 py-2 text-center font-bold">Khớp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((g, i) => {
                          const key = `${g.bo}|${g.ngay}|${g.ca}`;
                          const loCon = (data.los ?? []).filter((l) => (l.hkdName ?? l.tid).replace(/\s*\d+\s*$/, '').trim() === g.bo && (l.billDate ?? '').slice(0, 10) === g.ngay && l.ca === g.ca);
                          return (<>
                          <tr key={i} onClick={() => setMoNhom((v) => (v === key ? null : key))} title="Bấm để xem từng lô trong nhóm"
                              className={'cursor-pointer ' + (g.matched ? (i % 2 === 1 ? 'bg-slate-50/60' : '') : g.choCaSau ? 'bg-amber-50/60' : 'bg-rose-50/70')}>
                            <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-500">{g.ngay.slice(8, 10)}/{g.ngay.slice(5, 7)}</td>
                            <td className="max-w-[190px] truncate px-2 py-1.5 font-semibold text-slate-700">{g.bo}<span className="ml-1 text-[10px] font-normal text-slate-400">{g.soMay > 1 ? `${g.soMay} máy` : g.tid}</span></td>
                            <td className="px-2 py-1.5 text-center"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${g.ca === 1 ? 'bg-sky-100 text-sky-700' : g.ca === 2 ? 'bg-amber-100 text-amber-700' : 'bg-violet-100 text-violet-700'}`}>Ca {g.ca}</span></td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{g.soLo}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{g.doanhSo.toLocaleString('vi-VN')}</td>
                            <td className="px-2 py-1.5 text-right font-bold tabular-nums text-slate-800">{g.tienVe.toLocaleString('vi-VN')}</td>
                            <td className="px-2 py-1.5 text-right font-bold tabular-nums text-emerald-700">{g.thucVe > 0 ? g.thucVe.toLocaleString('vi-VN') : '—'}</td>
                            <td className={`px-2 py-1.5 text-right font-bold tabular-nums ${g.thucVe === 0 ? 'text-slate-300' : Math.abs(g.chenh) <= 500 ? 'text-slate-400' : g.chenh > 0 ? 'text-amber-600' : 'text-rose-600'}`}>{g.thucVe === 0 ? '—' : `${g.chenh > 0 ? '+' : ''}${g.chenh.toLocaleString('vi-VN')}`}</td>
                            <td className="whitespace-nowrap px-2 py-1.5 text-center">{g.matched ? <span className="font-bold text-emerald-600">✓ khớp</span> : g.choCaSau ? <span className="font-bold text-amber-600">⏳ chờ ca sau</span> : <span className="font-bold text-rose-600">✗ chưa về</span>}</td>
                          </tr>
                          {moNhom === key && loCon.map((l) => (
                            <tr key={`lo${l.loId}`} className="bg-sky-50/50 text-[11px]">
                              <td className="px-2 py-1 text-right text-slate-400">↳</td>
                              <td colSpan={3} className="px-2 py-1 text-slate-600">{l.hkdName ?? l.tid} · lô {(/\|(\d+)\|/.exec(l.billKey) ?? [])[1] ?? '?'} · {l.billDate?.slice(11, 16) ?? ''}{l.matched ? '' : ' · CHƯA VỀ'}</td>
                              <td className="px-2 py-1 text-right tabular-nums text-slate-600">{l.amount.toLocaleString('vi-VN')}</td>
                              <td className="px-2 py-1 text-right tabular-nums font-semibold text-slate-700">{l.tienVe.toLocaleString('vi-VN')}</td>
                              <td className="px-2 py-1 text-right tabular-nums text-emerald-700">{(l.thucVe ?? 0) > 0 ? (l.thucVe ?? 0).toLocaleString('vi-VN') : '—'}</td>
                              <td className="px-2 py-1 text-right tabular-nums text-slate-400">{(l.thucVe ?? 0) > 0 ? `${((l.thucVe ?? 0) - l.tienVe) > 0 ? '+' : ''}${((l.thucVe ?? 0) - l.tienVe).toLocaleString('vi-VN')}` : '—'}</td>
                              <td className="px-2 py-1 text-center">{l.matched ? '✅' : '❌'}</td>
                            </tr>
                          ))}
                          </>);
                        })}
                        <tr className="bg-brand/10 font-extrabold">
                          <td colSpan={4} className="px-2 py-2 text-right text-[11px] uppercase tracking-wide text-slate-500">Tổng{caLoc !== 0 ? ` ca ${caLoc}` : ''}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-slate-800">{sum((g) => g.doanhSo).toLocaleString('vi-VN')}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-slate-800">{sum((g) => g.tienVe).toLocaleString('vi-VN')}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-emerald-700">{sum((g) => g.thucVe).toLocaleString('vi-VN')}</td>
                          <td className={`px-2 py-2 text-right tabular-nums ${sum((g) => g.chenh) < 0 ? 'text-rose-600' : 'text-amber-600'}`}>{sum((g) => g.chenh) > 0 ? '+' : ''}{sum((g) => g.chenh).toLocaleString('vi-VN')}</td>
                          <td className="px-2 py-2" />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                );
              })()}

              {/* ── BLOCK BÁO CÓ — Y MẪU SAO KÊ (Admin Demo 14/9): Thời gian | Phát sinh Có | Số dư | Nội dung | Khớp ── */}
              <div className="mb-2 overflow-x-auto rounded-xl border-2 border-violet-300">
                <table className="w-full min-w-[700px] border-collapse text-[12px] [&_td]:border [&_td]:border-violet-100 [&_th]:border [&_th]:border-violet-300">
                  <thead>
                    <tr className="bg-violet-600 text-[10px] uppercase tracking-wide text-white">
                      <th className="px-2 py-2 text-center font-bold">Thời gian giao dịch</th>
                      <th className="px-2 py-2 text-right font-bold">Phát sinh Có</th>
                      <th className="px-2 py-2 text-right font-bold">Số dư</th>
                      <th className="px-2 py-2 text-left font-bold">Nội dung</th>
                      <th className="px-2 py-2 text-center font-bold">Khớp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.baoco.map((b, i) => (
                      <tr key={`bc${i}`} className={b.matchedLo ? (i % 2 === 1 ? 'bg-violet-50/40' : '') : 'bg-amber-50/70'}>
                        <td className="whitespace-nowrap px-2 py-1.5 text-center tabular-nums text-slate-600">{b.dateTime?.slice(0, 16).replace('T', ' ') ?? ''}</td>
                        <td className="px-2 py-1.5 text-right font-bold tabular-nums text-emerald-700">{b.amount.toLocaleString('vi-VN')}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{b.balance != null ? b.balance.toLocaleString('vi-VN') : '—'}</td>
                        <td className="max-w-[300px] px-2 py-1.5 text-slate-600"><div className="truncate">{b.desc ?? ''}</div>{!b.matchedLo && b.goiY && <div className="mt-0.5 rounded bg-amber-100/80 px-1 py-0.5 text-[10px] text-amber-800">{b.goiY}</div>}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-center text-[11px]">{b.matchedLo ? <span className="font-bold text-emerald-600">✅ {b.matchedTid ?? ''}</span> : <span className="font-bold text-amber-700">🟡 chưa</span>}</td>
                      </tr>
                    ))}
                    {data.baoco.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-center text-slate-400">Không có báo có nào trong kỳ.</td></tr>}
                    {(data.baocoNgoaiKy ?? []).map((b, i) => (
                      <tr key={`nk${i}`} className="bg-slate-50/80 text-[11px] text-slate-400">
                        <td className="whitespace-nowrap px-2 py-1 text-center tabular-nums">{b.dateTime?.slice(0, 16).replace('T', ' ') ?? ''}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{b.amount.toLocaleString('vi-VN')}</td>
                        <td className="px-2 py-1" />
                        <td colSpan={2} className="px-2 py-1">→ tính cho ngày <b>{b.ngayDs.slice(8, 10)}/{b.ngayDs.slice(5, 7)}</b> (chu kỳ 11h00 → 10h30 hôm sau) — xem kỳ ngày đó</td>
                      </tr>
                    ))}
                    <tr className="bg-violet-100 font-extrabold">
                      <td className="px-2 py-2 text-right text-[11px] uppercase text-slate-500">Phát sinh trong kỳ</td>
                      <td className="px-2 py-2 text-right tabular-nums text-violet-800">{data.tongBaoco.toLocaleString('vi-VN')}</td>
                      <td className="px-2 py-2" />
                      <td colSpan={2} className="px-2 py-2 text-[11px] text-slate-500">{data.baoco.length} giao dịch báo có</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* ── CHI TIẾT TỪNG LÔ (mở/ẩn) ── */}
              <button type="button" onClick={() => setMoLo((v) => !v)} className="mb-1 text-[12px] font-semibold text-brand">
                {moLo ? '▲ Ẩn chi tiết từng lô' : `▼ Chi tiết từng lô (${data.los.length})`}
              </button>
              {moLo && (
                <div className="max-h-56 overflow-auto rounded-xl border border-line/60">
                  {data.los.map((l) => (
                    <div key={l.loId} className={`flex items-center justify-between gap-2 border-b border-line/40 px-2.5 py-1 text-[12px] ${l.matched ? '' : 'bg-rose-50/60'}`}>
                      <span className="min-w-0 truncate">{l.matched ? '✅' : '❌'} {l.hkdName ?? l.tid} · lô {(/\|(\d+)\|/.exec(l.billKey) ?? [])[1] ?? '?'} · {l.billDate?.slice(5, 16).replace('T', ' ') ?? ''}</span>
                      <span className="shrink-0 font-semibold tabular-nums">{l.tienVe.toLocaleString('vi-VN')}đ{l.matched ? '' : ' — CHƯA VỀ'}</span>
                    </div>
                  ))}
                  {data.los.length === 0 && <div className="px-2.5 py-2 text-center text-[12px] text-slate-400">Không có lô tiền về nào trong kỳ.</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {downloadDialog}
    </>
  );
}
