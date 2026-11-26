// SỬA THAM SỐ BILL POS trên card (Admin Demo 1/9 "card phải có nút sửa tiền/lô/số hóa đơn do OCR sai; kể cả đã gửi;
// sửa 1 phòng phòng kia tự đồng nhất; PHẢI nhập mật khẩu; báo sửa thành công"). Server: /v1/ocr-send/edit-bill-params
// (bill-edit-client.ts) — password-gate + đồng bộ chéo đại lý↔NĐT + recompute doanh thu. Card đọc caption mới → tự
// đổi qua realtime message-edited (ConversationScreen upsert). CHỈ POS (CK params khác — làm sau).
import { useEffect, useState, type JSX } from 'react';
import { Modal } from './Modal';
import { editBillParams, fetchTidList } from '../lib/bill-edit-client';
import { useGroupedMoneyField, parseGroupedMoneyValue } from '../lib/grouped-money-input';
import type { ParsedPosBill } from './PosBillCard';

const INPUT = 'w-full rounded-lg-mac border border-line bg-appbg px-3 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand/40';
const LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-slate-400';

export function BillParamEditModal({ messageId, parsed, onClose }: {
  messageId: string; parsed: ParsedPosBill; onClose: () => void;
}): JSX.Element {
  const amountField = useGroupedMoneyField(String(parsed.amount));
  const [lo, setLo] = useState(parsed.lo ?? '');
  const [tid, setTid] = useState(parsed.tid ?? '');
  const [billDate, setBillDate] = useState(''); // rỗng = KHÔNG đổi ngày (caption POS không mang ngày để prefill).
  // [Admin Demo 25/9 "thêm số tiền hủy điền tay — chưa thấy tab hủy giao dịch đâu"] Màn REVIEW OCR đã có ô hủy, nhưng
  // MODAL SỬA BILL (mở từ thẻ chat / báo cáo lô) thì KHÔNG — nên bill OCR đọc hụt dòng HỦY là không có chỗ nào nhập.
  // Doanh số = quẹt − hủy, thiếu ô này là ghi THỪA đúng phần đã hủy. Prefill từ chính bill (nếu card đã biết).
  const huyField = useGroupedMoneyField(String(parsed.voidAmount ?? 0));
  const [soGdHuy, setSoGdHuy] = useState<number>(parsed.voidCount ?? 0);
  const [pw, setPw] = useState('');
  const huyTien = Math.max(0, parseGroupedMoneyValue(huyField.value) ?? 0);
  // [Admin Demo 18/9 "gợi ý trong màn sửa chưa?"] Bill OCR mù cả TID lẫn tên → màn sửa trước đây chỉ có Ô TID TRẦN,
  // không biết gõ gì. Nay tải danh sách máy → dropdown chọn TÊN HKD tự điền TID (server vẫn xác thực lại khi lưu).
  const [dsMay, setDsMay] = useState<{ tid: string; hkdName: string }[]>([]);
  useEffect(() => { void fetchTidList().then(setDsMay); }, []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<null | { revenueUpdated: boolean; chuaGhi: boolean; lyDo?: string }>(null);

  async function submit(): Promise<void> {
    setErr(null);
    const amt = parseGroupedMoneyValue(amountField.value);
    if (!pw.trim()) { setErr('Nhập mật khẩu sửa.'); return; }
    if (amt == null || amt <= 0) { setErr('Số tiền không hợp lệ.'); return; }
    if (tid.trim() && !/^\d+$/.test(tid.trim())) { setErr('Mã bill (TID) chỉ gồm chữ số.'); return; }
    const patch: { amount?: number; lo?: string | null; tid?: string; billDate?: string; voidAmount?: number; voidCount?: number } = {};
    const huyMoi = Math.max(0, parseGroupedMoneyValue(huyField.value) ?? 0);
    if (huyMoi !== (parsed.voidAmount ?? 0)) patch.voidAmount = huyMoi;
    if (soGdHuy !== (parsed.voidCount ?? 0)) patch.voidCount = soGdHuy;
    if (huyMoi > (amt ?? 0)) { setErr('Tiền hủy không thể lớn hơn số tiền bill.'); return; }
    if (amt !== parsed.amount) patch.amount = amt;
    if ((lo.trim() || null) !== (parsed.lo || null)) patch.lo = lo.trim() || null;
    if (tid.trim() && tid.trim() !== parsed.tid) patch.tid = tid.trim();
    if (billDate) patch.billDate = billDate; // đổi ngày doanh thu (chỉ gửi khi user chọn)
    if (Object.keys(patch).length === 0) { setErr('Chưa thay đổi tham số nào.'); return; }
    setSaving(true);
    const r = await editBillParams({ messageId, editPassword: pw.trim(), patch });
    setSaving(false);
    if (!r.ok) {
      setErr(
        r.error === 'BAD_PASSWORD' ? 'Sai mật khẩu sửa.'
        : r.error === 'LOCKED' ? 'Sai mật khẩu quá nhiều lần — tạm khóa sửa bill ~10 phút, thử lại sau.'
        : r.error === 'FORBIDDEN' ? 'Bạn không có quyền sửa bill này (chỉ thành viên phòng chứa bill mới sửa được).'
        : r.error === 'NON_PENDING_LO' ? 'Lô này đã tất toán — không sửa được (tránh lệch doanh thu đã chốt).'
        : r.error === 'NOT_POS_BILL' ? 'Bill này không sửa được qua đây.'
        : (r.message ?? 'Sửa thất bại — thử lại.')
      );
      return;
    }
    // [Admin Demo 25/9 "sửa bill mà không ghi nhận doanh số"] TRƯỚC ĐÂY báo "Đã sửa thành công" y hệt nhau dù doanh số
    // KHÔNG được ghi (revenueUpdated=false) ⇒ người sửa tưởng xong, tiền đứng im, không ai biết. Nay hỏng là BÁO ĐỎ
    // và KHÔNG tự đóng (bắt người sửa đọc), thành công mới tự đóng như cũ.
    const chuaGhi = r.moneyEditNotApplied === true || (r.revenueUpdated !== true && r.oldAmount !== r.newAmount);
    setDone({ revenueUpdated: r.revenueUpdated, chuaGhi, lyDo: r.revenueError });
    if (!chuaGhi) window.setTimeout(onClose, 1500); // card tự đổi qua realtime.
  }

  return (
    <Modal title="Sửa tham số bill" onClose={onClose} width="max-w-sm">
      {done ? (
        done.chuaGhi ? (
          <div className="flex flex-col items-center gap-2 py-5 text-center" data-testid="sua-bill-chua-ghi-doanh-so">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-2xl">⚠</div>
            <div className="text-sm font-extrabold text-danger">ĐÃ SỬA HIỂN THỊ — NHƯNG DOANH SỐ CHƯA ĐƯỢC GHI</div>
            <div className="text-xs font-semibold text-slate-600">Thẻ bill đã đổi, còn số liệu doanh số/lô thì CHƯA cập nhật. Phải kiểm tay rồi sửa lại, đừng coi là xong.</div>
            {done.lyDo && <div className="rounded-lg bg-slate-50 px-2 py-1 text-[11px] font-mono text-slate-500">lý do: {done.lyDo}</div>}
            <button type="button" onClick={onClose} className="mt-1 rounded-lg bg-danger px-3 py-1.5 text-xs font-bold text-white">Tôi đã đọc</button>
          </div>
        ) : (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-2xl">✓</div>
          <div className="text-sm font-semibold text-emerald-700">Đã sửa bill thành công</div>
          <div className="text-xs text-slate-500">{done.revenueUpdated ? 'Doanh thu đã cập nhật + đồng bộ phòng NĐT.' : 'Đã cập nhật + đồng bộ phòng NĐT.'}</div>
        </div>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg-mac bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
            Sửa khi OCR đọc sai. Đổi <b>số tiền</b> sẽ cập nhật lại doanh thu. Phòng NĐT tự đồng bộ theo.
          </div>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Số tiền</span>
            <input ref={amountField.inputRef} className={INPUT + ' text-lg font-bold'} inputMode="numeric" value={amountField.value} onChange={amountField.onChange} placeholder="Số tiền" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Lô</span>
              <input className={INPUT} value={lo} onChange={(e) => setLo(e.target.value.replace(/\D/g, ''))} placeholder="Số lô" />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Mã bill (TID)</span>
              <input className={INPUT} value={tid} onChange={(e) => setTid(e.target.value.replace(/\D/g, ''))} placeholder="TID" />
              {dsMay.length > 0 && (
                <select data-testid="sua-chon-ten-hkd" className={`${INPUT} mt-1 text-[12px]`}
                  value={dsMay.some((m) => m.tid === tid.trim()) ? tid.trim() : ''}
                  onChange={(e) => { if (e.target.value) setTid(e.target.value); }}
                  title="Chọn TÊN HKD (máy) — tự điền TID; vẫn sửa tay ở ô trên">
                  <option value="">🔎 Chọn tên HKD ({dsMay.length} máy)…</option>
                  {dsMay.map((m) => <option key={m.tid} value={m.tid}>{m.hkdName} · {m.tid}</option>)}
                </select>
              )}
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Ngày bill <span className="text-slate-400 normal-case">(đổi ngày doanh thu — bỏ trống nếu giữ nguyên)</span></span>
            {/* Admin Demo 2/9 "ngày phải VN dd/mm/yyyy": ẩn chữ US của <input date> (.date-vn-icon) + đọc VN bên phải. */}
            <div className="flex items-center gap-2">
              <input className={INPUT + ' date-vn-icon flex-1'} type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
              <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-700">{billDate ? billDate.split('-').reverse().join('/') : '—'}</span>
            </div>
          </label>
          {/* [Admin Demo 25/9] KHỐI HỦY GIAO DỊCH — điền tay khi OCR đọc hụt dòng HỦY trên bill tổng kết.
              Doanh số ghi nhận = tiền bill − tiền hủy; thiếu ô này là ghi THỪA đúng phần đã hủy. */}
          <div className={`rounded-lg-mac border-2 p-2 ${huyTien > 0 ? 'border-amber-400 bg-amber-50' : 'border-line bg-slate-50/60'}`} data-testid="khoi-huy-modal-sua">
            <div className={LABEL + ' mb-1'}>Giao dịch HỦY trên bill <span className="normal-case text-slate-400">(điền tay nếu OCR đọc hụt)</span></div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-0.5">
                <span className={LABEL}>Tiền hủy</span>
                <input ref={huyField.inputRef} inputMode="numeric" data-testid="o-tien-huy-modal"
                  className={INPUT + ' !py-1.5 text-right font-bold tabular-nums ' + (huyTien > 0 ? 'text-danger' : 'text-slate-500')}
                  value={huyField.value} onChange={huyField.onChange} />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className={LABEL}>Số GD hủy</span>
                <input inputMode="numeric" data-testid="o-so-gd-huy-modal"
                  className={INPUT + ' !py-1.5 text-center font-bold tabular-nums text-slate-600'}
                  value={String(soGdHuy)} onChange={(e) => setSoGdHuy(Math.max(0, Number(e.target.value.replace(/[^\d]/g, '')) || 0))} />
              </label>
            </div>
            <div className="mt-1.5 flex items-center justify-between rounded-lg border border-line bg-white px-2 py-1">
              <span className={LABEL}>Ghi nhận doanh số</span>
              <b className="text-sm font-extrabold tabular-nums text-emerald-700" data-testid="ghi-nhan-modal">{(Math.max(0, (parseGroupedMoneyValue(amountField.value) ?? 0) - huyTien)).toLocaleString('vi-VN')}đ</b>
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Mật khẩu sửa</span>
            <input className={INPUT} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Mật khẩu sửa (mặc định 1111)" autoComplete="off" />
          </label>
          {err && <div className="rounded-lg-mac bg-red-50 border border-red-200 px-3 py-2 text-xs font-medium text-red-700">{err}</div>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 rounded-full border border-line py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Hủy</button>
            <button type="button" onClick={submit} disabled={saving} className="btn-primary flex-1 rounded-full py-2 text-sm font-bold text-white disabled:opacity-60">{saving ? 'Đang lưu…' : 'Xác nhận sửa'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
