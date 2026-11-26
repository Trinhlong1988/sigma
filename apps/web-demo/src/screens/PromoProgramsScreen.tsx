// [Admin Demo 12/9 "menu khuyến mại cho cả ở SigMa"] Màn CHƯƠNG TRÌNH KHUYẾN MẠI — chỉ chủ SigMa (menu ẩn theo
// isAlphaOwnerCode, server chặn 403). Cùng nghiệp vụ với tab desktop (bot-api /v1/promo-programs → services chung):
// bảng + bật/tắt tại chỗ + form tạo/sửa (kênh POS/QR, loại thẻ/ngân hàng, %, từ-đến, lịch cả-kỳ/T7CN/ngày-cụ-thể).
import { useEffect, useState, type JSX } from 'react';
import { BadgePercent, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { proxyFetch } from '../lib/proxy-fetch';
import { botApiBaseUrl } from '../lib/diary-api';
import { DotsLoader } from '../components/DotsLoader';

interface PromoRow {
  id: number; kenh: 'POS' | 'QR'; cardTypeId: number | null; cardTypeName: string | null;
  bankId: number | null; bankName: string | null; deltaPct: number; fromDate: string; toDate: string;
  lich: 'RANGE' | 'WEEKEND' | 'DATES'; ngayCuThe: string[] | null; enabled: boolean; note: string | null;
}
interface Refs { cards: { id: number; name: string; bankName: string | null }[]; banks: { id: number; name: string }[] }

/** to_date lưu nửa-mở (00:00 ngày sau) → hiển thị "đến hết ngày" lùi 1 ngày. */
const ngayDen = (toIso: string): string => new Date(new Date(toIso).getTime() - 86_400_000).toISOString();
const fmtNgay = (iso: string): string => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10).split('-').reverse().join('/');

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; message?: string }> {
  try {
    const r = await proxyFetch(`${botApiBaseUrl()}${path}`, init ?? { method: 'GET' });
    const j = (await r.json()) as { ok?: boolean; data?: T; message?: string };
    return { ok: !!r.ok && j.ok !== false, data: j.data, message: j.message };
  } catch { return { ok: false, message: 'Không kết nối được máy chủ.' }; }
}

export function PromoProgramsScreen(): JSX.Element {
  const [rows, setRows] = useState<PromoRow[]>([]);
  const [refs, setRefs] = useState<Refs>({ cards: [], banks: [] });
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<PromoRow | 'new' | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    const r = await api<PromoRow[]>('/v1/promo-programs');
    if (r.ok && r.data) setRows(r.data); else setMsg(r.message ?? 'Không tải được danh sách.');
    setLoading(false);
  }
  useEffect(() => { void reload(); void api<Refs>('/v1/promo-programs/refs').then((r) => { if (r.ok && r.data) setRefs(r.data); }); }, []);

  async function toggle(r: PromoRow): Promise<void> {
    const res = await api('/v1/promo-programs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      id: r.id, kenh: r.kenh, cardTypeId: r.cardTypeId, bankId: r.bankId, deltaPct: r.deltaPct,
      fromDate: r.fromDate, toDate: ngayDen(r.toDate), lich: r.lich, ngayCuThe: r.ngayCuThe ?? undefined, enabled: !r.enabled, note: r.note
    }) });
    if (!res.ok) setMsg(res.message ?? 'Không đổi được trạng thái.');
    await reload();
  }
  async function xoa(r: PromoRow): Promise<void> {
    if (!window.confirm(`Xóa chương trình ${r.kenh} · ${r.kenh === 'POS' ? r.cardTypeName : (r.bankName ?? 'mọi ngân hàng')}?`)) return;
    const res = await api(`/v1/promo-programs/${r.id}`, { method: 'DELETE' });
    if (!res.ok) setMsg(res.message ?? 'Xóa thất bại.');
    await reload();
  }
  const lichLabel = (r: PromoRow): string => r.lich === 'WEEKEND' ? 'Chỉ T7 + CN' : r.lich === 'DATES' ? `Ngày: ${(r.ngayCuThe ?? []).map((d) => d.slice(8, 10) + '/' + d.slice(5, 7)).join(', ')}` : 'Cả kỳ';

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-appbg p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-1.5 text-base font-bold text-slate-800"><BadgePercent className="h-5 w-5 text-brand" /> Chương trình khuyến mại</h1>
          <p className="text-xs text-slate-400">Giảm GIÁ BÁN theo kỳ — POS theo loại thẻ · QR theo ngân hàng. Áp NGAY khi lưu, tắt về giá thường ngay.</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={() => void reload()} className="flex items-center gap-1 rounded-lg-mac border border-line bg-white px-3 py-1.5 text-xs font-semibold text-slate-600"><RefreshCw className="h-3.5 w-3.5" /> Làm mới</button>
          <button type="button" onClick={() => setForm('new')} className="btn-primary flex items-center gap-1 rounded-lg-mac px-3 py-1.5 text-xs font-semibold"><Plus className="h-3.5 w-3.5" /> Thêm</button>
        </div>
      </div>
      {msg && <div className="rounded-lg-mac border border-danger/40 bg-danger/10 p-2.5 text-sm text-danger">{msg}</div>}
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-400"><DotsLoader /> Đang tải…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg-mac border border-line bg-white p-10 text-center text-sm text-slate-400">Chưa có chương trình khuyến mại nào.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className={`rounded-lg-mac border bg-white p-3 ${r.enabled ? 'border-line' : 'border-line opacity-55'}`} data-testid="promo-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.kenh === 'QR' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>{r.kenh}</span>
                <span className="font-semibold text-slate-800">{r.kenh === 'POS' ? (r.cardTypeName ?? (r.bankName ? `${r.bankName} (mọi loại thẻ)` : `Thẻ #${r.cardTypeId ?? '?'}`)) : (r.bankName ?? 'Mọi ngân hàng')}</span>
                <span className="ml-auto text-sm font-extrabold tabular-nums text-brand">−{r.deltaPct}%</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span>{fmtNgay(r.fromDate)} → {fmtNgay(ngayDen(r.toDate))}</span>
                <span>· {lichLabel(r)}</span>
                {r.note && <span>· {r.note}</span>}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => void toggle(r)} className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${r.enabled ? 'bg-success/15 text-success' : 'bg-slate-200 text-slate-500'}`} title={r.enabled ? 'Bấm để TẮT' : 'Bấm để BẬT'}>
                  {r.enabled ? 'ĐANG CHẠY · bấm để tắt' : 'ĐANG TẮT · bấm để bật'}
                </button>
                <button type="button" onClick={() => setForm(r)} className="ml-auto flex items-center gap-1 rounded-lg-mac border border-line px-2 py-1 text-[11px] font-semibold text-slate-600"><Pencil className="h-3 w-3" /> Sửa</button>
                <button type="button" onClick={() => void xoa(r)} className="flex items-center gap-1 rounded-lg-mac border border-danger/40 px-2 py-1 text-[11px] font-semibold text-danger"><Trash2 className="h-3 w-3" /> Xóa</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {form && <PromoForm refs={refs} init={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
    </div>
  );
}

function PromoForm({ refs, init, onClose, onSaved }: { refs: Refs; init: PromoRow | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [kenh, setKenh] = useState<'POS' | 'QR'>(init?.kenh ?? 'POS');
  const [cardTypeId, setCardTypeId] = useState(init?.cardTypeId != null ? String(init.cardTypeId) : '');
  const [bankId, setBankId] = useState(init?.bankId != null ? String(init.bankId) : '');
  const [deltaPct, setDeltaPct] = useState(init ? String(init.deltaPct) : '');
  const [fromDate, setFromDate] = useState(init ? new Date(new Date(init.fromDate).getTime() + 7 * 3600_000).toISOString().slice(0, 10) : '');
  const [toDate, setToDate] = useState(init ? new Date(new Date(init.toDate).getTime() + 7 * 3600_000 - 86_400_000).toISOString().slice(0, 10) : '');
  const [lich, setLich] = useState<'RANGE' | 'WEEKEND' | 'DATES'>(init?.lich ?? 'RANGE');
  const [ngayCuThe, setNgayCuThe] = useState((init?.ngayCuThe ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(): Promise<void> {
    setErr(null);
    if (kenh === 'POS' && !cardTypeId && !bankId) { setErr('Kênh POS: chọn NGÂN HÀNG (áp mọi loại thẻ) hoặc 1 loại thẻ.'); return; }
    const n = Number(deltaPct);
    if (!Number.isFinite(n) || n <= 0 || n > 100) { setErr('Mức giảm không hợp lệ (>0 – 100).'); return; }
    if (!fromDate || !toDate) { setErr('Chọn đủ Từ ngày / Đến ngày.'); return; }
    const ds = ngayCuThe.split(/[\s,;]+/).filter(Boolean);
    if (lich === 'DATES' && ds.length === 0) { setErr('Lịch "ngày cụ thể" phải nhập ≥1 ngày (YYYY-MM-DD).'); return; }
    setBusy(true);
    try {
      const r = await proxyFetch(`${botApiBaseUrl()}/v1/promo-programs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: init?.id, kenh, cardTypeId: kenh === 'POS' && cardTypeId ? Number(cardTypeId) : null, bankId: bankId ? Number(bankId) : null, deltaPct: n, fromDate, toDate, lich, ngayCuThe: lich === 'DATES' ? ds : undefined, enabled: init ? init.enabled : true, note: init?.note ?? null })
      });
      const j = (await r.json()) as { ok?: boolean; message?: string };
      if (!r.ok || j.ok === false) { setErr(j.message ?? `Lỗi máy chủ (HTTP ${r.status}).`); return; }
      onSaved();
    } catch { setErr('Không kết nối được máy chủ.'); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="promo-form">
        <div className="mb-2 text-sm font-bold text-slate-800">{init ? 'Sửa chương trình khuyến mại' : 'Thêm chương trình khuyến mại'}</div>
        <p className="mb-3 text-[11px] text-slate-400">POS: theo loại thẻ · QR: theo ngân hàng (bỏ trống = mọi ngân hàng, giảm cả bậc tiền chờ lẫn tiền nhanh).</p>
        {err && <div className="mb-2 rounded-lg-mac border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{err}</div>}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="col-span-2 flex gap-2">
            {(['POS', 'QR'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setKenh(k)} className={`rounded-lg-mac border px-4 py-1.5 text-sm font-semibold ${kenh === k ? 'border-brand bg-brand-tint text-brand' : 'border-line bg-white text-slate-500'}`}>{k}</button>
            ))}
          </div>
          {kenh === 'POS' ? (
            <>
              <select value={bankId} onChange={(e) => { setBankId(e.target.value); if (e.target.value) setCardTypeId(''); }} className="rounded-lg-mac border border-line px-2 py-2 text-sm text-slate-700">
                <option value="">— Chọn ngân hàng (áp mọi loại thẻ) —</option>
                {refs.banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <select value={cardTypeId} onChange={(e) => { setCardTypeId(e.target.value); if (e.target.value) setBankId(''); }} className="rounded-lg-mac border border-line px-2 py-2 text-sm text-slate-700">
                <option value="">Tất cả loại thẻ</option>
                {refs.cards.map((c) => <option key={c.id} value={c.id}>{c.name}{c.bankName ? ` · ${c.bankName}` : ''}</option>)}
              </select>
            </>
          ) : (
            <select value={bankId} onChange={(e) => setBankId(e.target.value)} className="col-span-2 rounded-lg-mac border border-line px-2 py-2 text-sm text-slate-700">
              <option value="">Mọi ngân hàng</option>
              {refs.banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-500">Mức giảm (%)
            <input value={deltaPct} onChange={(e) => setDeltaPct(e.target.value)} placeholder="0.02" className="rounded-lg-mac border border-line px-2 py-2 text-sm text-slate-700" /></label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-500">Lịch áp
            <select value={lich} onChange={(e) => setLich(e.target.value as 'RANGE' | 'WEEKEND' | 'DATES')} className="rounded-lg-mac border border-line px-2 py-2 text-sm text-slate-700">
              <option value="RANGE">Cả kỳ (mọi ngày)</option>
              <option value="WEEKEND">Chỉ Thứ 7 + Chủ nhật</option>
              <option value="DATES">Ngày cụ thể</option>
            </select></label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-500">Từ ngày
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg-mac border border-line px-2 py-2 text-sm text-slate-700" /></label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-500">Đến hết ngày
            <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} className="rounded-lg-mac border border-line px-2 py-2 text-sm text-slate-700" /></label>
          {lich === 'DATES' && (
            <label className="col-span-2 flex flex-col gap-1 text-[11px] font-medium text-slate-500">Ngày cụ thể (YYYY-MM-DD, phẩy)
              <input value={ngayCuThe} onChange={(e) => setNgayCuThe(e.target.value)} placeholder="2026-09-18, 2026-09-25" className="rounded-lg-mac border border-line px-2 py-2 font-mono text-sm text-slate-700" /></label>
          )}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg-mac border border-line px-3 py-1.5 text-xs font-semibold text-slate-600">Hủy</button>
          <button type="button" disabled={busy} onClick={() => void save()} className="btn-primary rounded-lg-mac px-4 py-1.5 text-xs font-semibold disabled:opacity-60">{busy ? 'Đang lưu…' : init ? 'Cập nhật' : 'Tạo chương trình'}</button>
        </div>
      </div>
    </div>
  );
}
