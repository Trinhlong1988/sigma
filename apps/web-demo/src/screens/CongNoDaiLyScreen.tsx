// SỔ TIỀN ĐẠI LÝ ĐANG CẦM (Admin Demo 17/9: "chưa có log hiện thị lô nào, ngày giờ, tên tid, hkd, số tiền đại lý
// cầm chưa đối soát, chờ hoàn tiền — cần log này theo dõi RIÊNG TỪNG ĐẠI LÝ").
//
// Trước đây muốn biết nhà nào còn cầm bao nhiêu phải mở TỪNG phòng doanh số rồi tự cộng. Màn này gom 1 chỗ:
// mỗi đại lý 1 khối (nhà nhiều tiền nhất lên đầu), bấm mở ra thấy từng lô — ngày giờ · TID · HKD · số lô · tiền.
import { useCallback, useEffect, useState, type JSX } from 'react';
import { getCongNoDaiLy, postLotNote, type CongNoDaiLy } from '../lib/digistore-client';
import { bankColor } from '../lib/bank-visual';
import { DotsLoader } from '../components/DotsLoader';

const fmtVnd = (n: number): string => Math.round(n).toLocaleString('vi-VN');
function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function CongNoDaiLyScreen(): JSX.Element {
  const homNay = ymdLocal(new Date());
  const truoc7 = ymdLocal(new Date(Date.now() - 6 * 86_400_000));
  const [from, setFrom] = useState(truoc7);
  const [to, setTo] = useState(homNay);
  const [st, setSt] = useState<{ status: 'loading' | 'error' | 'ready'; data?: { dealers: CongNoDaiLy[]; tongChuaDoiSoat: number; tongChoHoan: number }; message?: string }>({ status: 'loading' });
  const [mo, setMo] = useState<Record<number, boolean>>({});

  const nap = useCallback((f: string, t: string) => {
    setSt({ status: 'loading' });
    void getCongNoDaiLy(f, t).then((r) => setSt(r.ok ? { status: 'ready', data: r.data } : { status: 'error', message: r.message }));
  }, []);
  useEffect(() => { nap(from, to); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const d = st.data;
  return (
    <div className="h-full overflow-y-auto px-4 pt-3 pb-24 space-y-3" data-testid="man-cong-no">
      <div>
        <h1 className="text-lg font-extrabold text-slate-800">Tiền đại lý đang cầm</h1>
        <p className="text-xs text-slate-400">Lô CHƯA hoàn tiền, tách riêng từng đại lý — lô nào, ngày giờ, TID, HKD, số tiền.</p>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg-mac border border-line bg-white p-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold uppercase text-slate-400">Từ ngày</span>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm tabular-nums text-slate-700" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold uppercase text-slate-400">Đến ngày</span>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
            className="rounded-lg-mac border border-line bg-appbg px-2 py-1.5 text-sm tabular-nums text-slate-700" />
        </label>
        <button type="button" onClick={() => nap(from, to)} data-testid="cong-no-xem"
          className="rounded-lg-mac border border-brand/40 bg-brand-tint px-3 py-2 text-xs font-bold text-brand hover:bg-brand/10">Xem</button>
        {st.status === 'ready' && d && (
          <div className="ml-auto flex flex-wrap gap-2 text-sm">
            <span className="rounded-full bg-danger/10 px-3 py-1.5 font-bold text-danger" data-testid="tong-chua-ds">
              Chưa đối soát: {fmtVnd(d.tongChuaDoiSoat)}đ
            </span>
            <span className="rounded-full bg-amber-100 px-3 py-1.5 font-bold text-amber-700" data-testid="tong-cho-hoan">
              Chờ hoàn: {fmtVnd(d.tongChoHoan)}đ
            </span>
          </div>
        )}
      </div>

      {st.status === 'loading' && <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><DotsLoader /> Đang tải…</div>}
      {st.status === 'error' && <p className="py-6 text-center text-sm text-danger">Không tải được: {st.message}</p>}
      {st.status === 'ready' && d && d.dealers.length === 0 && (
        <div className="rounded-lg-mac border border-dashed border-line py-10 text-center text-sm text-slate-400">Không có lô nào đang chờ trong kỳ này.</div>
      )}

      {st.status === 'ready' && d?.dealers.map((x) => (
        <div key={x.customerId} className="rounded-lg-mac border border-line bg-white" data-testid="cong-no-dai-ly">
          <button type="button" onClick={() => setMo((m) => ({ ...m, [x.customerId]: !m[x.customerId] }))}
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-brand/[0.04]">
            <span className="text-base font-extrabold text-slate-800">{x.dealerName}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">{x.soLo} lô</span>
            {x.tongChuaDoiSoat > 0 && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger">Chưa đối soát {fmtVnd(x.tongChuaDoiSoat)}đ · {x.soLoChua} lô</span>}
            {x.tongChoHoan > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">Chờ hoàn {fmtVnd(x.tongChoHoan)}đ · {x.soLoChoHoan} lô</span>}
            <span className="ml-auto text-sm font-extrabold tabular-nums text-brand">Σ {fmtVnd(x.tongPhaiHoan)}đ</span>
            <span className="text-xs text-slate-400">{mo[x.customerId] ? '▲ Thu gọn' : '▼ Xem lô'}</span>
          </button>
          {mo[x.customerId] && (
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr>
                  <th className="px-2 py-1.5 text-left font-semibold">Ngày · Giờ</th>
                  <th className="px-2 py-1.5 text-left font-semibold">HKD</th>
                  <th className="px-2 py-1.5 text-center font-semibold">TID</th>
                  <th className="px-2 py-1.5 text-center font-semibold">Lô</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Doanh số</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Phải hoàn</th>
                  <th className="px-2 py-1.5 text-center font-semibold">Mã YC</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Ghi chú</th>
                  <th className="px-2 py-1.5 text-center font-semibold">Trạng thái</th>
                </tr></thead>
                <tbody>
                  {x.lots.map((l) => (
                    <tr key={l.loId} className="border-t border-line/60 odd:bg-white even:bg-slate-50/40">
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{l.ngay} {l.gio}</td>
                      <td className="px-2 py-1.5 font-semibold">{l.hkdName || '—'}{l.borrowed && <span className="ml-1 rounded bg-amber-100 px-1 text-[9px] font-bold text-amber-700">mượn</span>}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-center font-semibold tabular-nums" style={{ color: bankColor(l.bankName) ?? undefined }}>{l.tid}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-center tabular-nums">{l.soLo}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-slate-600">{fmtVnd(l.truocPhi)}đ</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-bold tabular-nums text-brand">{fmtVnd(l.phaiHoan)}đ</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-center">{l.maYc ? <span className="rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] font-extrabold text-brand">{l.maYc.replace(/^([A-Za-z]+)(\d+)$/, '$1 $2')}</span> : <span className="text-slate-300">—</span>}</td>
                      {/* [Admin Demo 21/9] GHI CHÚ per-lô — cùng nguồn pos_lot_recon.note với bảng lô ĐL/NĐT, sửa tại chỗ. */}
                      <td className="px-2 py-1.5">
                        <input data-testid="o-ghi-chu-congno" defaultValue={l.note ?? ''} placeholder="ghi chú…"
                          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (l.note ?? '')) { void postLotNote(l.loId, v).then(() => nap(from, to)); } }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          className="w-full min-w-[90px] rounded border border-line bg-white/70 px-1 py-0.5 text-[11px] text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-brand/40" />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-center">
                        {l.trangThai === 'chua'
                          ? <span className="rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] font-bold text-danger">Chưa đối soát</span>
                          : <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-700">Chờ hoàn</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
