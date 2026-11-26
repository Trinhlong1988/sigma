// [Admin Demo 16/9 — VIETQR HOÀN ĐẠI LÝ] Modal QR hoàn dùng CHUNG: Báo cáo QR (báo-có) + Doanh số phòng (lô POS).
// Nhận onXacNhanHoan callback — mỗi màn tự quyết ghi sổ gì (refund-done báo-có / lô POS). UI: nhóm theo đại lý,
// tổng làm tròn XUỐNG nghìn, chips chọn TK (nhiều TK/đại lý), form thêm TK, ConfirmModal brand.
import { useEffect, useState, type JSX } from 'react';
import { Loader2, Save, CheckCircle2 } from 'lucide-react';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';
import {
  getDealerRefundAccounts, setDealerRefundAccount, fetchVietQrPngUrl, lamTronNghinXuong, noiDungChuyenKhoanQr, maYcHienThi,
  type DealerRefundAccount
} from '../lib/digistore-client';

// ═══ [Admin Demo 16/9 — VIETQR HOÀN ĐẠI LÝ] Modal QR hoàn sau "Xác nhận đã đối soát" ═══
/** 1 nhóm hoàn = 1 đại lý trong đợt tick: tổng hoàn = Σ sauPhiBan các GD CÓ PHÍ, làm tròn XUỐNG nghìn. */
export interface NhomHoan { dealer: string; billIds: string[]; tongGoc: number; thieuPhi: number }
/** Gom nhóm hoàn theo đại lý từ các dòng {dealer, id, sauPhi} bất kỳ (báo-có QR hoặc lô POS). */
export function nhomHoanTuDong(dong: Array<{ dealer: string | null; id: string; sauPhi: number | null }>): NhomHoan[] {
  const m = new Map<string, NhomHoan>();
  for (const r of dong) {
    const d = (r.dealer ?? '').trim() || '—';
    const g = m.get(d) ?? { dealer: d, billIds: [], tongGoc: 0, thieuPhi: 0 };
    g.billIds.push(r.id);
    if (r.sauPhi != null) g.tongGoc += r.sauPhi; else g.thieuPhi += 1;
    m.set(d, g);
  }
  return [...m.values()].sort((a, b) => b.tongGoc - a.tongGoc);
}

export function RefundQrModal(
  { groups, onClose, onDone, onXacNhanHoan, nguonTien = 'QR', maYc = null }: {
    groups: NhomHoan[]; onClose: () => void; onDone: () => void;
    onXacNhanHoan: (g: NhomHoan, tien: number) => Promise<{ ok: boolean; message: string }>;
    /** [Admin Demo 17/9] Nguồn tiền hoàn → quyết TIỀN TỐ nội dung CK: 'QR' (bill hoàn QR) | 'DL' (hoàn nhanh/lô POS). */
    nguonTien?: 'QR' | 'DL';
    /** [Admin Demo 17/9] MÃ YC (YC001) — có thì NỘI DUNG CK chỉ là mã đó ("YC 001"), bỏ tên đại lý: 1 lệnh chuyển gộp
     *  nhiều lô nên tên đại lý không đủ để truy, mã YC mới tra ra đúng nhóm lô + bill CK. */
    maYc?: string | null;
  }
): JSX.Element {
  // state per đại lý: DANH SÁCH TK (Admin Demo 16/9 tối "1 đại lý có nhiều TK") + TK đang chọn + QR + đã hoàn + form.
  const [accs, setAccs] = useState<Record<string, DealerRefundAccount[] | 'loading'>>({});
  const [chonTk, setChonTk] = useState<Record<string, string>>({}); // dealer → accountNo đang chọn (mặc định = TK default)
  const [qrs, setQrs] = useState<Record<string, string | null>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, { bankCode: string; accountNo: string; accountName: string } | null>>({});

  async function napQr(dealer: string, tien: number, accountNo: string): Promise<void> {
    if (tien <= 0) return;
    // [Admin Demo 17/9] nội dung CK = chỉ tên đại lý + nguồn tiền ("QR a Binh SG" / "DL a Binh SG").
    const noiDung = maYc ? maYcHienThi(maYc) : noiDungChuyenKhoanQr(nguonTien, dealer);
    const q = await fetchVietQrPngUrl(dealer, tien, noiDung, accountNo);
    setQrs((x) => { const cu = x[dealer]; if (cu) URL.revokeObjectURL(cu); return { ...x, [dealer]: q.ok ? q.data : null }; });
    if (!q.ok) setMsg(q.message);
  }
  async function napTkVaQr(dealer: string, tien: number): Promise<void> {
    setAccs((a) => ({ ...a, [dealer]: 'loading' }));
    const r = await getDealerRefundAccounts(dealer);
    const list = r.ok ? r.data : [];
    setAccs((a) => ({ ...a, [dealer]: list }));
    const macDinh = list[0]?.accountNo;
    if (macDinh) { setChonTk((c) => ({ ...c, [dealer]: macDinh })); await napQr(dealer, tien, macDinh); }
  }
  useEffect(() => {
    for (const g of groups) { if (g.dealer !== '—') void napTkVaQr(g.dealer, lamTronNghinXuong(g.tongGoc)); }
    return () => { setQrs((x) => { for (const u of Object.values(x)) if (u) URL.revokeObjectURL(u); return {}; }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function luuTk(dealer: string, tien: number): Promise<void> {
    const f = form[dealer]; if (!f) return;
    setBusy(dealer);
    const r = await setDealerRefundAccount({ dealer, bankCode: f.bankCode, accountNo: f.accountNo, accountName: f.accountName });
    setBusy(null); setMsg(r.ok ? r.data.message : r.message);
    if (r.ok) { setForm((x) => ({ ...x, [dealer]: null })); await napTkVaQr(dealer, tien); }
  }
  async function datMacDinh(dealer: string, accountNo: string): Promise<void> {
    const r = await setDealerRefundAccount({ dealer, setDefaultAccountNo: accountNo });
    setMsg(r.ok ? r.data.message : r.message);
    if (r.ok) setAccs((a) => { const l = a[dealer]; return l === 'loading' || !l ? a : { ...a, [dealer]: l.map((x) => ({ ...x, isDefault: x.accountNo === accountNo })) }; });
  }
  // [Admin Demo 16/9 "hiện log sai brand xấu"] window.confirm = hộp hệ thống → ConfirmModal brand SigMa.
  const [hoiHoan, setHoiHoan] = useState<{ g: NhomHoan; tien: number } | null>(null);
  async function xacNhanHoan(g: NhomHoan, tien: number): Promise<void> {
    setBusy(g.dealer);
    const r = await onXacNhanHoan(g, tien); // màn gọi tự quyết ghi sổ (báo-có QR / lô POS)
    setBusy(null); setMsg(r.message);
    if (r.ok) { setDone((d) => ({ ...d, [g.dealer]: true })); onDone(); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose} data-testid="refund-qr-modal">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-white px-4 py-3">
          <div className="text-sm font-extrabold text-brand-deep">💸 Hoàn tiền đại lý — quét QR chuyển đúng số đã làm tròn</div>
          <Button variant="soft" onClick={onClose}>Đóng</Button>
        </div>
        <div className="space-y-4 p-4">
          {msg && <div className="rounded-lg border border-line bg-slate-50 px-3 py-2 text-xs text-slate-600">{msg}</div>}
          {groups.map((g) => {
            const tien = lamTronNghinXuong(g.tongGoc);
            const acc = accs[g.dealer];
            const qr = qrs[g.dealer] ?? null;
            const f = form[g.dealer] ?? { bankCode: '', accountNo: '', accountName: '' };
            return (
              <div key={g.dealer} className="rounded-2xl border border-line p-4" data-testid="refund-group">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-base font-extrabold text-slate-800">{g.dealer} <span className="text-xs font-semibold text-slate-400">· {g.billIds.length} GD</span></div>
                  <div className="text-right">
                    <div className="text-[11px] text-slate-400">Σ hoàn sau phí {g.tongGoc.toLocaleString('vi-VN')}đ → làm tròn XUỐNG nghìn</div>
                    <div className="text-2xl font-extrabold tabular-nums text-brand-deep">{tien.toLocaleString('vi-VN')}đ</div>
                  </div>
                </div>
                {g.thieuPhi > 0 && <div className="mt-1 text-[11px] font-semibold text-amber-700">⚠ {g.thieuPhi} GD chưa có phí bán — KHÔNG nằm trong tổng. Set giá mã rồi đối soát lại nếu cần.</div>}
                {g.dealer === '—' ? (
                  <div className="mt-2 text-xs font-semibold text-danger">GD chưa gán đại lý — gán đại lý trước rồi đối soát lại để hoàn.</div>
                ) : acc === 'loading' || acc === undefined ? (
                  <div className="mt-3 flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải tài khoản…</div>
                ) : acc.length === 0 || form[g.dealer] ? (
                  <div className="mt-3 space-y-2 rounded-xl border border-dashed border-amber-300 bg-amber-50 p-3">
                    <div className="text-xs font-bold text-amber-800">{acc.length > 0 ? 'Thêm TK mới cho đại lý:' : 'Đại lý chưa có TK nhận hoàn — nhập 1 lần, các lần sau tự hiện QR:'}</div>
                    <div className="grid grid-cols-3 gap-2">
                      <input placeholder="Bank (MB, VCB…)" value={f.bankCode} onChange={(e) => setForm((x) => ({ ...x, [g.dealer]: { ...f, bankCode: e.target.value } }))} className="rounded-lg border border-line px-2 py-1.5 text-sm" data-testid="refund-acc-bank" />
                      <input placeholder="Số tài khoản" inputMode="numeric" value={f.accountNo} onChange={(e) => setForm((x) => ({ ...x, [g.dealer]: { ...f, accountNo: e.target.value } }))} className="rounded-lg border border-line px-2 py-1.5 text-sm" data-testid="refund-acc-no" />
                      <input placeholder="TÊN CHỦ TK" value={f.accountName} onChange={(e) => setForm((x) => ({ ...x, [g.dealer]: { ...f, accountName: e.target.value } }))} className="rounded-lg border border-line px-2 py-1.5 text-sm" data-testid="refund-acc-name" />
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="confirm" size="sm" icon={busy === g.dealer ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} onClick={() => void luuTk(g.dealer, tien)} disabled={busy === g.dealer}>Lưu TK nhận hoàn</Button>
                      {acc.length > 0 && <Button variant="soft" size="sm" onClick={() => setForm((x) => ({ ...x, [g.dealer]: null }))}>Huỷ</Button>}
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <div className="shrink-0">
                      {qr ? <img src={qr} alt={`VietQR ${g.dealer}`} className="h-[31rem] w-[31rem] max-w-full rounded-xl border border-line object-contain" data-testid="refund-qr-img" /> : <div className="flex h-[31rem] w-[31rem] max-w-full items-center justify-center rounded-xl border border-dashed border-line text-xs text-slate-400">{tien > 0 ? 'Đang tạo QR…' : 'Tổng = 0đ — không cần QR'}</div>}
                    </div>
                    <div className="min-w-[220px] flex-1 space-y-1 text-sm">
                      {/* [Admin Demo 16/9 tối "1 đại lý có nhiều TK"] chips CHỌN TK — QR gen theo TK đang chọn; ★ = mặc định. */}
                      <div className="flex flex-wrap items-center gap-1.5 pb-1">
                        {acc.map((a) => {
                          const on = (chonTk[g.dealer] ?? acc[0]?.accountNo) === a.accountNo;
                          return (
                            <button key={a.accountNo} type="button" data-testid="refund-acc-chip"
                              onClick={() => { setChonTk((c) => ({ ...c, [g.dealer]: a.accountNo })); void napQr(g.dealer, tien, a.accountNo); }}
                              className={`rounded-full border px-2 py-1 text-[11px] font-bold transition ${on ? 'border-brand bg-brand-tint text-brand-deep' : 'border-line bg-white text-slate-500 hover:text-slate-700'}`}
                              title={`${a.accountName} · ${a.bankCode} · ${a.accountNo}`}>
                              {a.isDefault ? '★ ' : ''}{a.bankCode} …{a.accountNo.slice(-4)}
                            </button>
                          );
                        })}
                        <button type="button" onClick={() => setForm((x) => ({ ...x, [g.dealer]: { bankCode: '', accountNo: '', accountName: '' } }))}
                          className="rounded-full border border-dashed border-line px-2 py-1 text-[11px] font-bold text-slate-400 hover:text-brand" title="Thêm TK mới cho đại lý">+ TK</button>
                      </div>
                      {(() => {
                        const dangChon = acc.find((a) => a.accountNo === (chonTk[g.dealer] ?? acc[0]?.accountNo)) ?? acc[0];
                        return (
                          <>
                            <div className="font-bold text-slate-800">{dangChon.accountName}</div>
                            <div className="tabular-nums text-slate-600">{dangChon.bankCode} · {dangChon.accountNo}
                              {!dangChon.isDefault && <button type="button" className="ml-2 text-[11px] text-slate-400 underline hover:text-brand" onClick={() => void datMacDinh(g.dealer, dangChon.accountNo)} title="TK mặc định hiện QR trước ở các lần sau + dùng cho ảnh báo cáo">đặt mặc định</button>}
                            </div>
                          </>
                        );
                      })()}
                      <div className="text-[11px] text-slate-400">Nội dung: SigMa hoan QR {g.dealer}</div>
                      <div className="pt-2">
                        {done[g.dealer] ? (
                          <span className="rounded-lg bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-700">✓ Đã ghi HOÀN</span>
                        ) : (
                          <Button variant="confirm" size="sm" icon={busy === g.dealer ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setHoiHoan({ g, tien })} disabled={busy === g.dealer || tien <= 0} data-testid="refund-confirm">Xác nhận ĐÃ HOÀN</Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <ConfirmModal open={hoiHoan != null} title="Xác nhận ĐÃ HOÀN tiền" danger
        message={hoiHoan ? <>Ghi nhận ĐÃ chuyển <b className="tabular-nums">{hoiHoan.tien.toLocaleString('vi-VN')}đ</b> cho đại lý <b>{hoiHoan.g.dealer}</b> ({hoiHoan.g.billIds.length} GD)?<br />Trạng thái các GD sẽ chuyển XANH "Đã hoàn tiền".</> : null}
        confirmLabel="ĐÃ HOÀN — ghi sổ" busy={busy != null}
        onConfirm={() => { if (hoiHoan) { const h = hoiHoan; setHoiHoan(null); void xacNhanHoan(h.g, h.tien); } }}
        onClose={() => setHoiHoan(null)} />
    </div>
  );
}
