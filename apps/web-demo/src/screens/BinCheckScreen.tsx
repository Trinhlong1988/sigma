// [Admin Demo 12/9] TRA BIN THẺ — "tra 6 số thẻ của mã BIN ra thẻ gì, ngân hàng gì như bincheck", SigMa dùng.
// Kết quả hiện CARD ĐẸP (brand màu theo hãng); BIN chưa có thư viện → form bổ sung (xây thư viện dần) + bảng
// thư viện bên dưới. OFFLINE (server tra bảng bin_library + quy tắc prefix) — không gọi dịch vụ ngoài.
import { useEffect, useState, type JSX } from 'react';
import { CreditCard, Landmark, Plus, Search } from 'lucide-react';
import { proxyFetch } from '../lib/proxy-fetch';
import { botApiBaseUrl } from '../lib/diary-api';
import { isAlphaOwnerCode } from '../lib/alpha-aggregate-client';
import { getCachedAuthenticatedAgent } from '../lib/bot-api-client';
import { DotsLoader } from '../components/DotsLoader';

interface BinInfo { bin: string; brand: string | null; bankName: string | null; cardType: string | null; note: string | null; source: 'LIBRARY' | 'RULE' | null }
interface BinRow { bin: string; bankName: string; cardBrand: string | null; cardType: string | null; note: string | null; source: string | null }

/** [Admin Demo 12/9] MÀU CARD theo NGÂN HÀNG phát hành (nhận diện brand ngân hàng); chưa nhận ra bank → màu theo hãng. */
function bankTheme(bank: string | null, brand: string | null): { grad: string; chip: string } {
  const b = (bank ?? '').toUpperCase();
  if (b.includes('MB BANK') || b === 'MB') return { grad: 'from-[#141b8f] to-[#2f3bd9]', chip: 'bg-indigo-100 text-indigo-800' };
  if (b.includes('VPBANK') || b.includes('CAKE') || b.includes('UBANK')) return { grad: 'from-[#007a33] to-[#00b74f]', chip: 'bg-green-100 text-green-800' };
  if (b.includes('VIETCOMBANK')) return { grad: 'from-[#006e51] to-[#00a651]', chip: 'bg-emerald-100 text-emerald-800' };
  if (b.includes('VIETINBANK')) return { grad: 'from-[#0f4c92] to-[#1b6ec2]', chip: 'bg-blue-100 text-blue-800' };
  if (b.includes('BIDV')) return { grad: 'from-[#006b68] to-[#00a19a]', chip: 'bg-teal-100 text-teal-800' };
  if (b.includes('TECHCOMBANK')) return { grad: 'from-[#c8102e] to-[#e8384f]', chip: 'bg-red-100 text-red-800' };
  if (b.includes('ACB')) return { grad: 'from-[#003da5] to-[#2b6cd4]', chip: 'bg-blue-100 text-blue-800' };
  if (b.includes('VIB')) return { grad: 'from-[#0066b3] to-[#00a0e3]', chip: 'bg-sky-100 text-sky-800' };
  if (b.includes('TPBANK')) return { grad: 'from-[#5c2d91] to-[#8a4fd0]', chip: 'bg-purple-100 text-purple-800' };
  if (b.includes('SACOMBANK')) return { grad: 'from-[#003da5] to-[#0072ce]', chip: 'bg-blue-100 text-blue-800' };
  if (b.includes('AGRIBANK')) return { grad: 'from-[#8a1538] to-[#b5205a]', chip: 'bg-rose-100 text-rose-800' };
  if (b.includes('HDBANK')) return { grad: 'from-[#d0021b] to-[#f2503f]', chip: 'bg-red-100 text-red-800' };
  if (b.includes('SHB')) return { grad: 'from-[#f47920] to-[#ffa14e]', chip: 'bg-orange-100 text-orange-800' };
  if (b.includes('MSB')) return { grad: 'from-[#e4592c] to-[#ff7f45]', chip: 'bg-orange-100 text-orange-800' };
  if (b.includes('OCB')) return { grad: 'from-[#00843d] to-[#2bb45a]', chip: 'bg-green-100 text-green-800' };
  if (b.includes('EXIMBANK')) return { grad: 'from-[#0072bc] to-[#2f9ee0]', chip: 'bg-sky-100 text-sky-800' };
  if (b.includes('SEABANK')) return { grad: 'from-[#d31145] to-[#f04d7d]', chip: 'bg-rose-100 text-rose-800' };
  if (b.includes('BVBANK') || b.includes('BAN VIET')) return { grad: 'from-[#0d9488] to-[#2dd4bf]', chip: 'bg-teal-100 text-teal-800' };
  if (b.includes('SMARTPAY')) return { grad: 'from-amber-600 to-amber-400', chip: 'bg-amber-100 text-amber-800' };
  const br = (brand ?? '').toUpperCase();
  if (br.includes('VISA')) return { grad: 'from-blue-700 to-blue-500', chip: 'bg-blue-100 text-blue-800' };
  if (br.includes('MASTER')) return { grad: 'from-orange-600 to-amber-500', chip: 'bg-orange-100 text-orange-800' };
  if (br.includes('JCB')) return { grad: 'from-emerald-700 to-teal-500', chip: 'bg-emerald-100 text-emerald-800' };
  if (br.includes('NAPAS')) return { grad: 'from-rose-600 to-pink-500', chip: 'bg-rose-100 text-rose-800' };
  return { grad: 'from-slate-600 to-slate-400', chip: 'bg-slate-100 text-slate-600' };
}

/** [Admin Demo 12/9 "dung logo brand moi to chuc"] Logo TO CHUC THE ve SVG noi bo (offline, khong tai ngoai). */
function BrandLogo({ brand }: { brand: string | null }): JSX.Element {
  const b = (brand ?? '').toUpperCase();
  if (b.includes('MASTER')) return (
    <svg viewBox="0 0 48 30" className="h-7 w-11" aria-label="Mastercard"><circle cx="19" cy="15" r="12" fill="#EB001B" /><circle cx="29" cy="15" r="12" fill="#F79E1B" fillOpacity="0.9" /><path d="M24 5.6a12 12 0 0 1 0 18.8 12 12 0 0 1 0-18.8z" fill="#FF5F00" /></svg>);
  if (b.includes('VISA')) return (
    <svg viewBox="0 0 48 30" className="h-7 w-11" aria-label="Visa"><rect width="48" height="30" rx="4" fill="#1A1F71" /><text x="24" y="20" textAnchor="middle" fontFamily="Arial, sans-serif" fontStyle="italic" fontWeight="bold" fontSize="13" fill="#fff">VISA</text></svg>);
  if (b.includes('JCB')) return (
    <svg viewBox="0 0 48 30" className="h-7 w-11" aria-label="JCB"><rect width="48" height="30" rx="4" fill="#fff" /><rect x="6" y="4" width="10" height="22" rx="4" fill="#0E4C96" /><rect x="19" y="4" width="10" height="22" rx="4" fill="#C8102E" /><rect x="32" y="4" width="10" height="22" rx="4" fill="#00843D" /><text x="11" y="19" textAnchor="middle" fontSize="9" fontWeight="bold" fill="#fff">J</text><text x="24" y="19" textAnchor="middle" fontSize="9" fontWeight="bold" fill="#fff">C</text><text x="37" y="19" textAnchor="middle" fontSize="9" fontWeight="bold" fill="#fff">B</text></svg>);
  if (b.includes('AMERICAN')) return (
    <svg viewBox="0 0 48 30" className="h-7 w-11" aria-label="Amex"><rect width="48" height="30" rx="4" fill="#016FD0" /><text x="24" y="19" textAnchor="middle" fontFamily="Arial" fontWeight="bold" fontSize="9" fill="#fff">AMEX</text></svg>);
  if (b.includes('UNIONPAY')) return (
    <svg viewBox="0 0 48 30" className="h-7 w-11" aria-label="UnionPay"><g transform="skewX(-8)"><rect x="6" y="3" width="13" height="24" rx="3" fill="#D10429" /><rect x="19" y="3" width="13" height="24" rx="3" fill="#022E64" /><rect x="32" y="3" width="13" height="24" rx="3" fill="#076F74" /></g></svg>);
  if (b.includes('NAPAS')) return (
    <svg viewBox="0 0 48 30" className="h-7 w-11" aria-label="NAPAS"><rect width="48" height="30" rx="4" fill="#fff" /><text x="24" y="19" textAnchor="middle" fontFamily="Arial" fontWeight="bold" fontSize="10" fill="#E8232A">napas</text></svg>);
  if (b.includes('DISCOVER')) return (
    <svg viewBox="0 0 48 30" className="h-7 w-11" aria-label="Discover"><rect width="48" height="30" rx="4" fill="#fff" /><circle cx="37" cy="15" r="7" fill="#F76F20" /><text x="16" y="19" textAnchor="middle" fontFamily="Arial" fontWeight="bold" fontSize="7" fill="#231F20">DISC</text></svg>);
  return <CreditCard className="h-8 w-8 opacity-80" />;
}

export function BinCheckScreen(): JSX.Element {
  const [bin, setBin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<BinInfo | null>(null);
  const [lib, setLib] = useState<BinRow[]>([]);
  const [formBank, setFormBank] = useState('');
  const [formType, setFormType] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function taiThuVien(): Promise<void> {
    try {
      const r = await proxyFetch(`${botApiBaseUrl()}/v1/bin-check/list`, { method: 'GET' });
      const j = (await r.json()) as { ok?: boolean; data?: BinRow[] };
      if (r.ok && j.data) setLib(j.data);
    } catch { /* bảng thư viện là phụ — lỗi tải không chặn tra cứu */ }
  }
  useEffect(() => { void taiThuVien(); }, []);

  async function tra(): Promise<void> {
    setBusy(true); setErr(null); setInfo(null); setSaved(false); setFormBank(''); setFormType('');
    try {
      const r = await proxyFetch(`${botApiBaseUrl()}/v1/bin-check?bin=${encodeURIComponent(bin)}`, { method: 'GET' });
      const j = (await r.json()) as { ok?: boolean; data?: BinInfo; message?: string };
      if (!r.ok || !j.data) { setErr(j.message ?? `Lỗi máy chủ (HTTP ${r.status}).`); return; }
      setInfo(j.data);
    } catch { setErr('Không kết nối được máy chủ.'); } finally { setBusy(false); }
  }

  async function boSung(): Promise<void> {
    if (!info || !formBank.trim()) return;
    setSaving(true);
    try {
      const r = await proxyFetch(`${botApiBaseUrl()}/v1/bin-check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bin: info.bin, bankName: formBank.trim(), cardType: formType.trim() || null })
      });
      if (r.ok) { setSaved(true); await taiThuVien(); await tra(); }
    } finally { setSaving(false); }
  }

  const theme = bankTheme(info?.bankName ?? null, info?.brand ?? null);
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-appbg p-3">
      <div>
        <h1 className="text-base font-bold text-slate-800">Tra BIN thẻ</h1>
        <p className="text-xs text-slate-400">Nhập 6-8 SỐ ĐẦU của thẻ — tra hãng thẻ + ngân hàng phát hành (thư viện nội bộ, không gửi số thẻ ra ngoài).</p>
      </div>
      <div className="flex items-center gap-2">
        <input
          inputMode="numeric" value={bin} placeholder="Ví dụ: 970422 hoặc 4238 01"
          onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 8); setBin(d.replace(/(\d{4})(?=\d)/g, '$1 ')); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void tra(); }}
          className="w-52 rounded-lg-mac border border-line bg-white px-3 py-2 font-mono text-lg tracking-widest text-slate-800"
          data-testid="bin-input"
        />
        <button type="button" disabled={busy} onClick={() => void tra()} className="btn-primary flex items-center gap-1.5 rounded-lg-mac px-4 py-2 text-sm font-semibold">
          {busy ? <DotsLoader /> : <Search className="h-4 w-4" />} Tra
        </button>
      </div>
      {err && <div className="rounded-lg-mac border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{err}</div>}

      {info && (
        <div className="max-w-md" data-testid="bin-card">
          {/* CARD ĐẸP (Admin Demo: "xây bảng tra cứu ra card review đẹp") — dáng thẻ ngân hàng, màu theo hãng. */}
          <div className={`rounded-2xl bg-gradient-to-br ${theme.grad} p-5 text-white shadow-lg`}>
            <div className="flex items-start justify-between">
              <BrandLogo brand={info.brand} />
              <span className="rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide">{info.brand ?? 'Không rõ hãng'}</span>
            </div>
            <div className="mt-5 font-mono text-2xl tracking-[0.25em]">{info.bin.replace(/(\d{4})(?=\d)/g, '$1 ')}<span className="opacity-50"> •• ••••</span></div>
            <div className="mt-4 flex items-end justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide opacity-70">Ngân hàng phát hành</div>
                <div className="flex items-center gap-1.5 text-lg font-bold"><Landmark className="h-4 w-4 opacity-80" />{info.bankName ?? 'Chưa có trong thư viện'}</div>
              </div>
              {info.cardType && <div className="text-right"><div className="text-[10px] uppercase tracking-wide opacity-70">Loại thẻ</div><div className="text-sm font-semibold">{info.cardType}</div></div>}
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
            <span className={`rounded-full px-2 py-0.5 font-semibold ${theme.chip}`}>{info.source === 'LIBRARY' ? 'Thư viện nội bộ' : info.source === 'RULE' ? 'Nhận theo quy tắc hãng thẻ' : 'Không nhận diện được'}</span>
            {info.note && <span>{info.note}</span>}
          </div>

          {info.bankName == null && isAlphaOwnerCode(getCachedAuthenticatedAgent()?.code) && (
            <div className="mt-3 rounded-lg-mac border border-amber-300 bg-amber-50 p-3">
              <div className="mb-2 text-xs font-semibold text-amber-800">BIN này chưa có trong thư viện — bổ sung để lần sau tra ra ngay:</div>
              <div className="flex flex-wrap items-center gap-2">
                <input value={formBank} placeholder="Ngân hàng (vd VIB)" onChange={(e) => setFormBank(e.target.value)} className="w-44 rounded-lg-mac border border-line bg-white px-2.5 py-1.5 text-sm" />
                <input value={formType} placeholder="Loại thẻ (vd Tín dụng)" onChange={(e) => setFormType(e.target.value)} className="w-40 rounded-lg-mac border border-line bg-white px-2.5 py-1.5 text-sm" />
                <button type="button" disabled={saving || !formBank.trim()} onClick={() => void boSung()} className="flex items-center gap-1 rounded-lg-mac border border-brand/50 bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-50">
                  <Plus className="h-3.5 w-3.5" /> {saving ? 'Đang lưu…' : saved ? '✓ Đã lưu' : 'Bổ sung thư viện'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-2 rounded-lg-mac border border-line bg-white">
        <div className="border-b border-line px-3 py-2 text-xs font-bold uppercase tracking-wide text-slate-400">Thư viện BIN ({lib.length} mục)</div>
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-3 py-1.5 text-left font-semibold">BIN</th>
                <th className="px-3 py-1.5 text-left font-semibold">Ngân hàng</th>
                <th className="px-3 py-1.5 text-left font-semibold">Hãng</th>
                <th className="px-3 py-1.5 text-left font-semibold">Loại</th>
                <th className="px-3 py-1.5 text-left font-semibold">Nguồn</th>
              </tr>
            </thead>
            <tbody>
              {lib.map((r) => (
                <tr key={r.bin} className="border-b border-line/60 hover:bg-brand-tint/40" onClick={() => { setBin(r.bin); }}>
                  <td className="cursor-pointer px-3 py-1.5 font-mono font-semibold text-brand">{r.bin}</td>
                  <td className="px-3 py-1.5 text-slate-700">{r.bankName}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.cardBrand ?? '—'}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.cardType ?? '—'}</td>
                  <td className="px-3 py-1.5 text-[11px] text-slate-400">{r.source === 'NAPAS_CONG_KHAI' ? 'NAPAS công khai' : r.source === 'SIGMA_NHAP' ? 'SigMa nhập' : r.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
