// BÁO CÁO BÁO-CÓ DIGISTORE (Admin Demo 5/9) — đối soát "báo có" ngân hàng (BVBank Digistore) theo kỳ.
// Bảng: STT · Ngày · Giờ · HKD · Số tiền · Mô tả (người quẹt) · Mã hóa đơn · Sau phí bán · Sau phí mua · Lợi nhuận
// SigMa · Đại lý · Trạng thái. Lọc: kỳ (Hôm nay/Hôm qua/Chọn chu kỳ, giờ HCM như AlphaAggregateScreen) + trạng thái
// (Tất cả / Đã đối soát / CHƯA đối soát) + HKD + đại lý. Dòng CHƯA đối soát (báo-có chưa có bill OCR khớp) tô nổi bật.
// Quyền: tạm MỌI user (LEAD chốt owner-gate sau) — server SẼ là lớp chặn thật. Số căn phải, tabular-nums.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { AlertTriangle, Loader2, Landmark, RefreshCw, CloudDownload, CheckCircle2, QrCode, Save, Gauge, FileImage, Undo2, X, Search, Eraser, FileSpreadsheet } from 'lucide-react';
// Khối lọc sao y cổng SmartPay (Admin Demo chốt 14/10) — số đo thật ghi ở đầu file css.
import './baoco-loc-smartpay.css';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { RefundQrModal, nhomHoanTuDong, type NhomHoan } from '../components/RefundQrModal';
import {
  fetchBaoCoReport,
  urlBaoCoXlsx, refreshBaoCo, listQrMa, getQrDailyLimit, setQrDailyLimit, setBaocoRecon, setBaocoDealer, listDealerNames,
  getDealerRefundAccount, getDealerRefundAccounts, setDealerRefundAccount, postRefundDone, postRefundUndo, setBaocoFeeType, fetchVietQrPngUrl, fetchNdtVietQrPngUrl, getNdtQrAccount, taoYchtNdt, lamTronNghinXuong, noiDungChuyenKhoanQr,
  type BaoCoReport, type BaoCoReportRow, type BaoCoReportFilter, type BaoCoRefreshResult, type QrMaItem, type QrMaLite,
  type DealerRefundAccount
} from '../lib/digistore-client';
import { getCachedAuthenticatedAgent } from '../lib/bot-api-client';
import { downloadAttachment, openDownloadedFile, type DownloadResult } from '../lib/attachment-blob';
import { isAlphaOwnerCode, isQrReconViewerCode } from '../lib/alpha-aggregate-client';

const money = (n: number | null): string => (n != null ? Math.round(n).toLocaleString('vi-VN') : '—');
/** Bỏ dấu tiếng Việt + lowercase (cho tìm tên người gửi không phụ thuộc dấu). */
const normVi = (s: string | null | undefined): string =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
/** Chỉ giữ chữ số (cho tìm theo số tiền — khớp chuỗi con). */
const digitsOnly = (s: string | number | null | undefined): string => String(s ?? '').replace(/\D/g, '');
const pad = (n: number): string => String(n).padStart(2, '0');
/** YYYY-MM-DD giờ Asia/Ho_Chi_Minh (UTC+7) của NGÀY = hôm nay + offsetDays. Preset dùng ngày HCM (chống lệch máy). */
function hcmDayStr(offsetDays: number): string {
  const d = new Date(Date.now() + 7 * 3600_000 + offsetDays * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** YYYY-MM-DD (giờ máy — cho ô <input type=date>). */
function ymd(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** Ngày kế (YYYY-MM-DD) — chặn trên nửa-mở [from, to). */
function nextDayStr(s: string): string { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + 1); return ymd(d); }
/** Ngày (dd/mm/yyyy) + Giờ (HH:mm) HCM của 1 ISO instant — 2 cột tách. */
// [Admin Demo 11/9] Màu theo NGUỒN mã QR để phân biệt trong danh sách báo-có. SmartPay (DEMOMAY/PaySmart) = HỔ PHÁCH;
// Bản Việt (DigiStore/BVBank) = LAM; khác/không rõ = TÍM với tên thật (KHÔNG chế nhãn — Admin Demo 11/9 "bản việt mà
// có phải acb đâu": trước đây gộp nhầm ACB vào nhánh này; gốc là 3 mã QR gán sai bank ACB trong DB, đã sửa về Ban Viet).
function nguonBadge(nguon: string | null): { label: string; cls: string } {
  const n = (nguon ?? '').trim().toUpperCase();
  if (!n) return { label: '—', cls: 'bg-slate-100 text-slate-500 border-slate-200' };
  if (n.includes('SMART')) return { label: 'SmartPay', cls: 'bg-amber-100 text-amber-800 border-amber-300' };
  if (n.includes('BVB') || n.includes('BAN VIET') || n.includes('BẢN VIỆT')) return { label: 'Bản Việt', cls: 'bg-sky-100 text-sky-800 border-sky-300' };
  return { label: nguon!, cls: 'bg-violet-100 text-violet-800 border-violet-300' };
}
function hcmParts(iso: string): { day: string; time: string } {
  const d = new Date(new Date(iso).getTime() + 7 * 3600_000);
  return { day: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}
/** "YYYY-MM-DD" (ngày HCM từ server byDay) → "dd/mm/yyyy". Không parse Date (né lệch múi giờ) — tách chuỗi thẳng. */
function dayLabel(ymdStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymdStr);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymdStr;
}

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

/** Thẻ tổng nhỏ. */
function StatCard({ label, value, accent, danger }: { label: string; value: string; accent?: boolean; danger?: boolean }): JSX.Element {
  return (
    <div className={`glass-panel rounded-xl border p-3 ${danger ? 'border-danger/40 bg-danger/5' : accent ? 'border-brand/30 bg-brand-tint' : 'border-line'}`}>
      <div className="text-[11px] uppercase text-slate-400">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${danger ? 'text-danger' : accent ? 'text-brand-deep' : 'text-slate-700'}`}>{value}</div>
    </div>
  );
}

function ReportTable({ rows, tick, onTick, onTickAll, dealerNames, onSetDealer, onRefundUndo, onSetFeeType, hideProfit = false }: {
  hideProfit?: boolean; // [22/9] viewer DL65: ẩn Sau phí mua + Lợi nhuận (server cũng đã tước data)
  rows: BaoCoReportRow[];
  tick: Set<string>;
  onTick: (billId: string) => void;
  onTickAll: () => void;
  dealerNames: string[];
  onSetDealer: (billId: string, dealer: string | null) => void;
  /** [16/9] Bỏ đánh dấu ĐÃ HOÀN 1 GD (đánh nhầm — có confirm ở nút). */
  onRefundUndo: (billId: string) => void;
  /** [16/9 tối] Đổi loại phí bán CHỜ/NHANH cho bill chưa khớp GD. */
  onSetFeeType: (billId: string, feeType: 'cho' | 'nhanh') => void;
}): JSX.Element {
  // [Admin Demo 6/9] Click 1 dòng → NỔI 3D + đổi màu để dễ theo dõi (bấm lại bỏ chọn).
  const [sel, setSel] = useState<string | null>(null);
  // [Admin Demo 16/9] GD đã đối soát → dropdown đại lý KHOÁ; bấm ✏ + xác nhận mở tạm 1 GD, đổi xong tự khoá lại.
  const [dealerMo, setDealerMo] = useState<Set<string>>(new Set());
  // [Admin Demo 16/9 "sai brand xấu"] hỏi xác nhận bằng ConfirmModal brand (thay window.confirm hệ thống).
  const [hoi, setHoi] = useState<{ loai: 'undo-refund' | 'edit-dealer'; billId: string } | null>(null);
  return (
    <div className="glass-panel shadow-soft rounded-2xl border border-line overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate-400">
              <th className="px-2 py-2 text-center font-semibold">
                <input type="checkbox" checked={rows.length > 0 && rows.every((r) => tick.has(r.billId))} onChange={onTickAll} data-testid="baoco-tick-all" />
              </th>
              <th className="px-2 py-2 text-right font-semibold">STT</th>
              <th className="px-2 py-2 text-left font-semibold">Ngày</th>
              <th className="px-2 py-2 text-left font-semibold">Giờ</th>
              <th className="px-2 py-2 text-left font-semibold">HKD</th>
              <th className="px-2 py-2 text-center font-semibold">Nguồn</th>
              <th className="px-2 py-2 text-right font-semibold">Số tiền</th>
              <th className="px-2 py-2 text-left font-semibold">Mô tả (người quẹt)</th>
              <th className="px-2 py-2 text-right font-semibold">Phí bán</th>
              <th className="px-2 py-2 text-right font-semibold">Sau phí bán</th>
              {!hideProfit && <th className="px-2 py-2 text-right font-semibold">Sau phí mua</th>}
              {!hideProfit && <th className="px-2 py-2 text-right font-semibold">Lợi nhuận SigMa</th>}
              <th className="px-2 py-2 text-left font-semibold">Đại lý</th>
              <th className="px-2 py-2 text-center font-semibold">Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={14} className="px-2 py-4 text-center text-slate-400">Không có báo-có trong kỳ.</td></tr>
            ) : rows.map((r) => {
              const { day, time } = hcmParts(r.dateIso);
              // [Admin Demo 8/9 — "chặn gửi mà vẫn báo đã đối soát"] CHỈ 'MATCHED' mới là ĐÃ đối soát. Trước đây
              // coi mọi trạng thái ≠ 'UNRECONCILED' là đã xong → bản ghi VỪA KÉO VỀ (chưa xét, status rỗng/null)
              // hiện "Đã đối soát" dù chưa khớp bill nào = báo xanh GIẢ. Fail-safe: chưa chắc thì coi là CHƯA.
              // [Admin Demo 14/9 — CQR] XANH = OCR-khớp (MATCHED) HOẶC đối soát TAY (manualDs). ĐỎ = chưa cả 2.
              const un = r.reconcileStatus !== 'MATCHED' && r.manualDs !== true;
              const key = `${r.billId}-${r.stt}`;
              const on = sel === key;
              return (
                <tr key={key} onClick={() => setSel(on ? null : key)}
                  className={`cursor-pointer border-b border-line/60 transition ${on ? 'relative z-10 bg-brand-tint ring-2 ring-brand shadow-[0_4px_14px_-2px_rgba(5,121,204,0.45)] font-semibold' : un ? 'bg-danger/5 hover:bg-danger/10' : 'hover:bg-brand-tint/40'}`}>
                  <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={tick.has(r.billId)} onChange={() => onTick(r.billId)} data-testid="baoco-tick-row" />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-400">{r.stt}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-slate-600">{day}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-slate-600">{time}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-slate-700">{r.hkdName || '—'}</td>
                  <td className="px-2 py-1.5 text-center">{(() => { const b = nguonBadge(r.nguon); return <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${b.cls}`}>{b.label}</span>; })()}</td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-brand-deep">{money(r.amount)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-slate-600">{r.payerName || '—'}</td>
                  {/* [Admin Demo 15/9 "sao không hiện phí bán QR"] PHÍ BÁN = số tiền − sau-phí-bán (server đã tính cả
                      bill chưa khớp theo giá mã) + % thực tế trong ngoặc. */}
                  {/* [16/9] chỉ %, bỏ thành tiền phí (Admin Demo). */}
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-amber-700" onClick={(e) => e.stopPropagation()}>
                    {/* [Admin Demo 16/9 tối] Bill CHƯA khớp GD + mã CÓ giá nhanh → dropdown CHỜ (mặc định) / NHANH
                        (vd SmartPay 1.15%) — đổi là server tính lại sauPhiBan theo loại. Bill khớp GD thật giữ %. */}
                    {un && r.coPhiNhanh ? (
                      <span className="inline-flex items-center gap-1">
                        <span>{r.sauPhiBan != null ? `${((r.amount - r.sauPhiBan) / r.amount * 100).toFixed(2)}%` : '—'}</span>
                        <select value={r.feeType ?? 'cho'} data-testid="baoco-fee-type"
                          onChange={(e) => onSetFeeType(r.billId, e.target.value === 'nhanh' ? 'nhanh' : 'cho')}
                          className="rounded border border-line bg-white px-0.5 py-0.5 text-[10px] font-bold text-slate-600">
                          <option value="cho">Chờ</option>
                          <option value="nhanh">Nhanh</option>
                        </select>
                      </span>
                    ) : (
                      r.sauPhiBan != null ? `${((r.amount - r.sauPhiBan) / r.amount * 100).toFixed(2)}%` : '—'
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right font-bold tabular-nums text-brand-deep">{money(r.sauPhiBan)}</td>
                  {!hideProfit && <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{money(r.sauPhiMua)}</td>}
                  {!hideProfit && <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600">{money(r.loiNhuanAlpha)}</td>}
                  <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                    {/* [14/9 — CQR] Dropdown gán đại lý per GD — mặc định: đại lý gán tay ?? phòng đại lý ?? CHỦ MÃ.
                        [Admin Demo 16/9] ĐÃ ĐỐI SOÁT → KHOÁ dropdown (tiền hoàn tính theo đại lý này); sửa phải bấm ✏
                        + xác nhận, đổi xong tự khoá lại. */}
                    {(() => {
                      const cur = r.manualDealer ?? r.dealerName ?? r.maChuName ?? '';
                      const opts = Array.from(new Set([...(cur ? [cur] : []), ...dealerNames]));
                      const daDS = !un;
                      const khoa = daDS && !dealerMo.has(r.billId);
                      return (
                        <span className="inline-flex items-center gap-1">
                          <select value={cur} disabled={khoa}
                            onChange={(e) => { onSetDealer(r.billId, e.target.value || null); setDealerMo((m) => { const x = new Set(m); x.delete(r.billId); return x; }); }}
                            className={'min-w-[96px] max-w-[140px] rounded-lg border border-line px-1 py-1 text-[11px] font-semibold ' + (khoa ? 'bg-slate-100 text-slate-400' : 'bg-white text-slate-700')}
                            data-testid="baoco-row-dealer">
                            <option value="">—</option>
                            {opts.map((d) => <option key={d} value={d}>{d}</option>)}
                          </select>
                          {khoa && (
                            <button type="button" data-testid="baoco-dealer-edit"
                              onClick={() => setHoi({ loai: 'edit-dealer', billId: r.billId })}
                              className="rounded px-1 text-[12px] text-slate-400 hover:text-brand" title="Sửa đại lý (cần xác nhận)">✏</button>
                          )}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {/* [Admin Demo 16/9] TRẠNG THÁI 3 MỨC — XANH CHỈ khi đủ 2 xác nhận (đối soát + ĐÃ HOÀN tiền):
                        đỏ = chưa đối soát · vàng = đã đối soát, CHỜ HOÀN · xanh = ĐÃ HOÀN TIỀN. Server là nguồn sự
                        thật (refund_done ghi qua nút Xác nhận ĐÃ HOÀN, fail-closed bill chưa đối soát). */}
                    {un ? (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-bold text-danger bg-danger/10 border border-danger/30" title="Chưa có bill OCR khớp và chưa xác nhận đối soát tay">
                        <AlertTriangle className="h-3 w-3" /> Chưa đối soát
                      </span>
                    ) : r.refundDone === true ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-bold text-emerald-700 bg-emerald-100" title="Đã đối soát + ĐÃ HOÀN tiền (đủ 2 xác nhận)">✓ Đã hoàn tiền</span>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setHoi({ loai: 'undo-refund', billId: r.billId }); }}
                          className="rounded px-1 text-[11px] text-slate-400 hover:text-danger" title="Bỏ đánh dấu đã hoàn (đánh nhầm)">↩</button>
                      </span>
                    ) : (
                      <span className="whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-bold text-amber-700 bg-amber-100 border border-amber-300" title={(r.manualDs === true && r.reconcileStatus !== 'MATCHED' ? 'Đối soát TAY. ' : 'Bill OCR khớp. ') + 'Chưa xác nhận HOÀN tiền — xanh chỉ khi đủ 2 bước.'}>
                        ⏳ Chờ hoàn{r.manualDs === true && r.reconcileStatus !== 'MATCHED' ? ' ✓tay' : ''}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmModal open={hoi?.loai === 'undo-refund'} title="Bỏ đánh dấu ĐÃ HOÀN" danger
        message={<>Bỏ đánh dấu <b>ĐÃ HOÀN</b> của GD này (đánh nhầm)? Trạng thái quay về "⏳ Chờ hoàn".</>}
        confirmLabel="Bỏ đánh dấu" onConfirm={() => { if (hoi) { onRefundUndo(hoi.billId); setHoi(null); } }} onClose={() => setHoi(null)} />
      <ConfirmModal open={hoi?.loai === 'edit-dealer'} title="Sửa đại lý GD đã đối soát" danger
        message={<>GD <b>ĐÃ đối soát</b> — tiền hoàn tính theo đại lý. Chắc chắn mở khoá để SỬA đại lý?</>}
        confirmLabel="Mở khoá sửa" onConfirm={() => { if (hoi) { setDealerMo((m) => new Set(m).add(hoi.billId)); setHoi(null); } }} onClose={() => setHoi(null)} />
    </div>
  );
}

/** Bảng KPI THEO NGÀY — Ngày · Doanh số · Số GD · Chưa đối soát · Lợi nhuận. Số căn phải tabular. */
function KpiByDayTable({ rows, hideProfit = false }: { rows: BaoCoReport['byDay']; hideProfit?: boolean }): JSX.Element {
  const tot = rows.reduce((a, r) => {
    a.doanhSo += r.doanhSo; a.count += r.count; a.countUnreconciled += r.countUnreconciled; a.loiNhuan += r.loiNhuan; return a;
  }, { doanhSo: 0, count: 0, countUnreconciled: 0, loiNhuan: 0 });
  return (
    <div className="glass-panel shadow-soft rounded-2xl border border-line overflow-hidden">
      <div className="border-b border-line bg-brand-tint px-4 py-2 text-sm font-bold text-brand-deep">KPI theo ngày</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm" data-testid="baoco-kpi-byday">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2 text-left font-semibold">Ngày</th>
              <th className="px-3 py-2 text-right font-semibold">Doanh số</th>
              <th className="px-3 py-2 text-right font-semibold">Số GD</th>
              <th className="px-3 py-2 text-right font-semibold">Chưa đối soát</th>
              {!hideProfit && <th className="px-3 py-2 text-right font-semibold">Lợi nhuận</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-4 text-center text-slate-400">Không có dữ liệu theo ngày trong kỳ.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.day} className="border-b border-line/60 hover:bg-brand-tint/40">
                <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">{dayLabel(r.day)}</td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-brand-deep">{money(r.doanhSo)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{r.count}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${r.countUnreconciled > 0 ? 'font-semibold text-danger' : 'text-slate-500'}`}>{r.countUnreconciled}</td>
                {!hideProfit && <td className="px-3 py-1.5 text-right tabular-nums text-emerald-600">{money(r.loiNhuan)}</td>}
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-brand/40 bg-brand-tint font-bold text-brand-deep">
                <td className="px-3 py-2">TỔNG</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(tot.doanhSo)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{tot.count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{tot.countUnreconciled}</td>
                {!hideProfit && <td className="px-3 py-2 text-right tabular-nums">{money(tot.loiNhuan)}</td>}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// [Admin Demo 6/9] THIẾT LẬP HẠN MỨC QR/ngày theo mã (collapsible). Set → app_settings (bot-api /v1/qr-daily-limit, chủ SigMa);
// bot-api cảnh báo khi doanh số QR trong ngày của mã (gồm bill đang gửi) gần/vượt hạn mức → đổi mã khác.
function QrDailyLimitSection(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ma, setMa] = useState<QrMaLite[]>([]);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [edit, setEdit] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fmt = (n: number): string => n.toLocaleString('vi-VN');
  async function load(): Promise<void> {
    setLoading(true); const r = await getQrDailyLimit(); setLoading(false);
    if (r.ok) { setMa(r.data.ma); setLimits(r.data.limits); } else setMsg(r.message);
  }
  useEffect(() => { if (open && ma.length === 0) void load(); /* eslint-disable-next-line */ }, [open]);
  async function save(tidId: number): Promise<void> {
    const raw = (edit[tidId] ?? '').replace(/\D/g, ''); const limit = raw ? Number(raw) : 0;
    setSaving(tidId); const r = await setQrDailyLimit(tidId, limit); setSaving(null);
    if (r.ok) { setLimits(r.data.limits); setEdit((e) => { const n = { ...e }; delete n[tidId]; return n; }); setMsg(`✓ Đã lưu hạn mức (mã ${tidId}).`); } else setMsg(r.message);
  }
  return (
    <div className="glass-panel shadow-soft rounded-2xl border border-line">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-brand-deep">
        <Gauge className="h-4 w-4" /> Thiết lập HẠN MỨC QR/ngày theo mã <span className="text-xs">{open ? '▲' : '▼'}</span>
        <span className="ml-2 text-xs font-normal text-slate-400">quẹt gần/vượt hạn mức → cảnh báo đổi mã khác</span>
      </button>
      {open && (
        <div className="border-t border-line p-4">
          {msg && <div className="mb-2 text-xs text-slate-500">{msg}</div>}
          {loading ? <div className="py-4 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="px-3 py-2">Mã QR (HKD)</th><th className="px-3 py-2 text-right">Hạn mức/ngày (đ)</th><th className="px-3 py-2" /></tr></thead>
                <tbody className="divide-y divide-line/60">
                  {ma.map((m) => {
                    const cur = limits[String(m.tidId)];
                    const val = edit[m.tidId] ?? (cur != null ? fmt(cur) : '');
                    return (
                      <tr key={m.tidId} className="hover:bg-appbg/50">
                        <td className="px-3 py-2"><span className="font-mono text-xs text-brand">{m.tid}</span> <span className="text-slate-700">{m.hkdName || '—'}</span></td>
                        <td className="px-3 py-2 text-right"><input inputMode="numeric" value={val} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setEdit((x) => ({ ...x, [m.tidId]: d ? fmt(Number(d)) : '' })); }} placeholder="(không giới hạn)" className="w-40 rounded-lg border border-line bg-white px-2 py-1 text-right text-sm" /></td>
                        <td className="px-3 py-2"><Button variant="soft" size="sm" icon={saving === m.tidId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} onClick={() => void save(m.tidId)} disabled={saving === m.tidId}>Lưu</Button></td>
                      </tr>
                    );
                  })}
                  {ma.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400"><QrCode className="mx-auto mb-1 h-5 w-5" /> Chưa có mã QR.</td></tr>}
                </tbody>
              </table>
              <div className="mt-2 text-[11px] text-slate-400">Để trống = không giới hạn. Doanh số QR trong ngày của mã (gồm bill đang gửi) ≥ hạn mức → cảnh báo ĐỎ "đổi mã khác"; ≥ 90% → cảnh báo vàng.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── [Admin Demo 14/9 — CQR] BÁO CÁO ẢNH HOÀN SAU PHÍ: preview lọc đúng GD đã tick → tải PNG (brand SigMa) ──
interface HoanQrCanvas { img: HTMLImageElement; acc: DealerRefundAccount; tien: number; dealer: string }
// [Admin Demo 22/9] che='ndt' → bảng tính theo GIÁ MUA (sauPhiMua) + QR TK SIGMA để NĐT quét hoàn (chiều NĐT→SigMa).
function veCanvasBaoCaoQr(rows: BaoCoReportRow[], hoan?: HoanQrCanvas, che: 'dl' | 'ndt' = 'dl', maYcht?: string | null): HTMLCanvasElement {
  const ndt = che === 'ndt';
  const soSauPhi = (r: BaoCoReportRow): number | null => ndt ? r.sauPhiMua : r.sauPhiBan;
  // [Admin Demo 22/9] Bản YC NĐT hoàn: BỎ cột ĐẠI LÝ + NGƯỜI QUẸT (ảnh gửi NĐT không cần lộ tên nhà/người quẹt)
  // + bảng TO RÕ hơn 10% (font + hàng cao hơn). fz() chỉ tác động chế độ ndt — báo cáo đại lý giữ nguyên.
  const fz = (px: number): number => ndt ? Math.round(px * 1.1) : px;
  // [Admin Demo 23/9] +cột TÊN HKD (mã QR) cho bản NĐT → 6 cột, nới khổ ảnh 1150 → 1400 cho khỏi chật.
  const W = ndt ? 1400 : 1150, S = 2, padX = 34, rowH = ndt ? 57 : 52;
  const H = 150 + 118 + rows.length * rowH + 96 + 46 + (ndt ? 32 : 0) + (hoan ? 500 : 0); // [16/9] QR x2; [23/9] dòng tổng NĐT 2 hàng
  const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
  const c = cv.getContext('2d')!; c.scale(S, S);
  c.fillStyle = '#f2f7fc'; c.fillRect(0, 0, W, H);
  const gr = c.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0, '#0f1a24'); gr.addColorStop(0.6, '#1877d6'); gr.addColorStop(1, '#3bc3d0');
  c.fillStyle = gr; c.fillRect(0, 0, W, 96);
  c.fillStyle = '#fff'; c.font = '800 30px Segoe UI';
  c.fillText(ndt ? `SIGMA — YÊU CẦU NĐT HOÀN${maYcht ? ` · ${maYcht}` : ''}` : 'SIGMA — BÁO CÁO HOÀN SAU PHÍ (QR)', padX, 44);
  c.font = '500 15px Segoe UI'; c.fillStyle = 'rgba(255,255,255,.85)';
  c.fillText('Báo có QR · lập lúc ' + new Date().toLocaleString('vi-VN', { hour12: false }), padX, 74);
  // ndt: chỉ 4 cột THỜI GIAN | SỐ TIỀN | GIÁ MUA | NĐT HOÀN — nới rộng hết khổ. cols[1]/cols[2] không dùng ở ndt.
  // [Admin Demo 23/9] ndt có LẠI cột NGƯỜI QUẸT (bỏ mỗi ĐẠI LÝ): THỜI GIAN | NGƯỜI QUẸT | SỐ TIỀN | GIÁ MUA | NĐT HOÀN.
  // ndt: THỜI GIAN | TÊN HKD | NGƯỜI QUẸT | SỐ TIỀN | GIÁ MUA | NĐT HOÀN (cols[1] giờ là HKD, không phải đại lý).
  const cols = ndt ? [padX, 250, 560, 900, 1080, W - padX] : [padX, 196, 340, 700, 856, W - padX]; // [16/9] nới NGƯỜI QUẸT (340→700 thay 646)
  const money2 = (n: number): string => Math.round(n).toLocaleString('vi-VN');
  const ptext = (txt: string, x: number, y: number, align: CanvasTextAlign): void => { const a = c.textAlign; c.textAlign = align; c.fillText(txt, x, y); c.textAlign = a; };
  // [Admin Demo 16/9 "ảnh báo cáo QR bị tràn xấu"] Cắt text theo BỀ RỘNG PIXEL THẬT (measureText) + "…" — trước đây
  // slice() theo SỐ KÝ TỰ nên tên 23 ký tự "KHACH HANG 04" lọt qua slice(0,24) rồi tràn đè cột SỐ TIỀN.
  // GỌI SAU KHI đã set đúng c.font của đoạn text đó (measureText đo theo font hiện hành).
  const fitText = (txt: string, maxW: number): string => {
    if (c.measureText(txt).width <= maxW) return txt;
    let t = txt;
    while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  };
  const rr = (x: number, y: number, w: number, h: number, r0: number): void => { c.beginPath(); c.arcTo(x + w, y, x + w, y + h, r0); c.arcTo(x + w, y + h, x, y + h, r0); c.arcTo(x, y + h, x, y, r0); c.arcTo(x, y, x + w, y, r0); c.closePath(); };
  let y = 96 + 34;
  c.fillStyle = '#1763a5'; c.font = '800 19px Segoe UI';
  c.fillText('Giao dịch được chọn', padX, y);
  y += 26;
  c.fillStyle = '#1763a5'; rr(padX - 10, y, W - 2 * padX + 20, 40, 10); c.fill();
  c.fillStyle = '#fff'; c.font = `800 ${fz(13)}px Segoe UI`;
  c.fillText('THỜI GIAN', cols[0] + 6, y + 26);
  c.fillText(ndt ? 'TÊN HKD (MÃ QR)' : 'ĐẠI LÝ', cols[1], y + 26);
  c.fillText('NGƯỜI QUẸT', cols[2], y + 26);
  ptext('SỐ TIỀN', cols[3], y + 26, 'right');
  ptext(ndt ? 'GIÁ MUA' : 'PHÍ BÁN', cols[4], y + 26, 'right');
  ptext(ndt ? 'NĐT HOÀN' : 'HOÀN SAU PHÍ', cols[5], y + 26, 'right');
  y += 40;
  let tongTien = 0, tongHoan = 0, coHoan = false, i = 0;
  for (const r of rows) {
    i += 1; tongTien += r.amount;
    const hoan = soSauPhi(r);
    if (hoan != null) { tongHoan += hoan; coHoan = true; }
    c.fillStyle = (i % 2) ? '#ffffff' : '#eff6fd';
    c.fillRect(padX - 10, y, W - 2 * padX + 20, rowH);
    c.fillStyle = '#0f1a24'; c.font = `500 ${fz(15)}px Segoe UI`;
    c.fillText(fitText(r.dateIso ? new Date(r.dateIso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : '', cols[1] - cols[0] - 16), cols[0] + 6, y + 32);
    const amtText = '+' + money2(r.amount) + 'đ';
    c.fillStyle = '#1877d6'; c.font = ndt ? `700 ${fz(14)}px Segoe UI` : '700 14px Segoe UI';
    c.fillText(fitText(ndt ? (r.hkdName || '—') : ((r.manualDealer ?? r.dealerName ?? r.maChuName) || '—'), cols[2] - cols[1] - 14), cols[1], y + 32);
    // NGƯỜI QUẸT (cả 2 chế độ): chừa đúng chỗ cho SỐ TIỀN (đo bề rộng THẬT của số tiền theo font của nó) rồi mới fit tên.
    {
      c.font = `800 ${fz(16)}px Segoe UI`;
      const amtW = c.measureText(amtText).width;
      c.fillStyle = '#0f1a24'; c.font = `700 ${fz(15)}px Segoe UI`;
      c.fillText(fitText(r.payerName || '', cols[3] - amtW - 14 - cols[2]), cols[2], y + 32);
    }
    c.fillStyle = '#059669'; c.font = `800 ${fz(16)}px Segoe UI`;
    ptext(amtText, cols[3], y + 32, 'right');
    c.fillStyle = '#b45309'; c.font = `700 ${fz(14)}px Segoe UI`;
    ptext(hoan != null ? `${(((r.amount - hoan) / r.amount) * 100).toFixed(2)}%` : '—', cols[4], y + 32, 'right');
    c.fillStyle = '#1763a5'; c.font = `800 ${fz(16)}px Segoe UI`;
    ptext(hoan != null ? money2(hoan) + 'đ' : '—', cols[5], y + 32, 'right');
    y += rowH;
  }
  y += 20;
  // [Admin Demo 23/9 "nhìn lộn xộn không?" — CÓ, đã sửa] Dòng TỔNG bản NĐT trước đây nhồi 3 cụm số trên MỘT hàng:
  // cụm "giá mua −…" và "HOÀN: …" ĐÈ DÍNH vào nhau (font +10% làm chữ HOÀN rộng ra, tràn qua cột giá mua).
  // Nay bản NĐT tách 2 HÀNG: hàng trên = tổng quẹt · hàng dưới = trừ giá mua + PHẢI HOÀN (số ĐÃ TRÒN XUỐNG,
  // khớp đúng số in trên QR — trước hiện số lẻ 157.733.768 trong khi QR ghi 157.733.000, dễ chuyển nhầm).
  const tongHoanTron = ndt ? Math.floor(tongHoan / 1000) * 1000 : tongHoan;
  const hTong = ndt ? 104 : 72;
  const gr2 = c.createLinearGradient(0, y, 0, y + hTong);
  gr2.addColorStop(0, '#1877d6'); gr2.addColorStop(1, '#1763a5');
  c.fillStyle = gr2; rr(padX - 10, y, W - 2 * padX + 20, hTong, 14); c.fill();
  if (ndt) {
    c.fillStyle = 'rgba(255,255,255,.92)'; c.font = `700 ${fz(15)}px Segoe UI`;
    c.fillText('TỔNG ' + rows.length + ' GIAO DỊCH', padX + 8, y + 34);
    c.font = `800 ${fz(19)}px Segoe UI`; c.fillStyle = '#fff';
    ptext('+' + money2(tongTien) + 'đ', cols[5], y + 34, 'right');
    c.fillStyle = 'rgba(255,255,255,.85)'; c.font = `600 ${fz(14)}px Segoe UI`;
    c.fillText(`trừ giá mua −${money2(tongTien - tongHoan)}đ · làm tròn xuống nghìn`, padX + 8, y + 76);
    c.fillStyle = '#fff'; c.font = `800 ${fz(26)}px Segoe UI`;
    ptext('PHẢI HOÀN: ' + money2(tongHoanTron) + 'đ', cols[5], y + 80, 'right');
  } else {
    c.fillStyle = '#fff'; c.font = `800 ${fz(17)}px Segoe UI`;
    c.fillText('TỔNG ' + rows.length + ' GIAO DỊCH', padX + 8, y + 44);
    c.font = `800 ${fz(20)}px Segoe UI`;
    ptext('+' + money2(tongTien) + 'đ', cols[3], y + 45, 'right');
    if (coHoan) { c.font = `700 ${fz(15)}px Segoe UI`; ptext('phí −' + money2(tongTien - tongHoan) + 'đ', cols[4], y + 45, 'right'); }
    c.font = coHoan ? `800 ${fz(22)}px Segoe UI` : `800 ${fz(16)}px Segoe UI`;
    ptext(coHoan ? 'HOÀN: ' + money2(tongHoan) + 'đ' : 'HOÀN: — (GD chưa khớp phí)', cols[5], y + 45, 'right');
  }
  y += hTong;
  // [Admin Demo 16/9] KHỐI VIETQR HOÀN: QR trái + STK/tên/bank/tiền phải + note — khách quét thẳng từ ảnh.
  if (hoan) {
    // [Admin Demo 16/9 tối "ảnh gen mã QR bé — tăng x2"] QR 180→360px (khách quét từ xa/màn nhỏ vẫn bắt được).
    const yQ = y + 16;
    const QR = 432, KHOI = 462; // [Admin Demo 16/9 khuya] QR x2.4 bản gốc (540 −20% cho khỏi phải cuộn lên xuống khi xem ảnh)
    c.fillStyle = '#ffffff'; rr(padX - 10, yQ, W - 2 * padX + 20, KHOI, 14); c.fill();
    c.strokeStyle = '#1877d6'; c.lineWidth = 2; rr(padX - 10, yQ, W - 2 * padX + 20, KHOI, 14); c.stroke();
    c.drawImage(hoan.img, padX + 10, yQ + 15, QR, QR);
    const tx = padX + QR + 34;
    const wR = W - padX - tx - 10; // bề rộng cột phải
    c.fillStyle = '#1763a5'; c.font = '800 22px Segoe UI';
    c.fillText(fitText(ndt ? 'NĐT CHUYỂN HOÀN VỀ SIGMA' : `HOÀN CHO ĐẠI LÝ: ${hoan.dealer}`, wR), tx, yQ + 92);
    c.fillStyle = '#0f1a24'; c.font = '700 19px Segoe UI';
    c.fillText(fitText(`${hoan.acc.accountName} · ${hoan.acc.bankCode} · ${hoan.acc.accountNo}`, wR), tx, yQ + 138);
    c.fillStyle = '#059669'; c.font = '800 44px Segoe UI';
    c.fillText(hoan.tien.toLocaleString('vi-VN') + 'đ', tx, yQ + 210);
    if (ndt) {
      // [23/9] Ô MÃ YCHT nổi bật thay cho khoảng trắng trống hoác nửa dưới cột phải — người nhận nhìn là biết
      // phải ghi nội dung gì, khỏi phải dò dòng chữ nhỏ.
      const bw = Math.min(wR, 420), bh = 76, byy = yQ + 248;
      c.fillStyle = '#eaf3fd'; rr(tx, byy, bw, bh, 12); c.fill();
      c.strokeStyle = '#1877d6'; c.lineWidth = 2; rr(tx, byy, bw, bh, 12); c.stroke();
      c.fillStyle = '#5b7484'; c.font = '700 14px Segoe UI';
      c.fillText('NỘI DUNG CHUYỂN KHOẢN', tx + 16, byy + 26);
      c.fillStyle = '#1763a5'; c.font = '800 32px Segoe UI';
      c.fillText(fitText(hoan.dealer, bw - 32), tx + 16, byy + 60);
      c.fillStyle = '#5b7484'; c.font = '500 14px Segoe UI';
      c.fillText(fitText('Quét QR là tự điền đúng số tiền + nội dung.', wR), tx, byy + bh + 30);
      c.fillText(fitText('Số tiền đã làm tròn XUỐNG nghìn (bỏ lẻ dưới 1.000đ).', wR), tx, byy + bh + 56);
      c.fillText(fitText('Chuyển xong gửi lại bill để SigMa đối soát.', wR), tx, byy + bh + 82);
    } else {
      c.fillStyle = '#5b7484'; c.font = '500 14px Segoe UI';
      c.fillText(fitText('Quét QR để chuyển ĐÚNG số tiền trên', wR), tx, yQ + 274);
      c.fillText(fitText('(đã làm tròn XUỐNG nghìn — bỏ phần lẻ dưới 1.000đ).', wR), tx, yQ + 300);
      c.fillText(fitText(`Nội dung: SigMa hoan QR ${hoan.dealer}`, wR), tx, yQ + 326);
    }
    y = yQ + KHOI;
  }
  c.fillStyle = '#5b7484'; c.font = '500 12px Segoe UI';
  c.fillText(ndt ? 'SigMa · Yêu cầu NĐT hoàn · số hoàn = số tiền − giá mua · liên hệ SigMa để đối soát' : 'SigMa · Báo cáo QR · số hoàn = số tiền − phí bán · liên hệ SigMa để đối soát', padX, y + 30);
  return cv;
}

function tenFileBaoCaoQr(rows: BaoCoReportRow[]): string {
  const dls = Array.from(new Set(rows.map((r) => r.manualDealer ?? r.dealerName ?? r.maChuName).filter((x): x is string => !!x)));
  const ten = Array.from(new Set(rows.map((r) => (r.payerName || '').trim()).filter(Boolean)));
  const phan: string[] = [];
  if (dls.length) phan.push(dls.slice(0, 2).join(', '));
  if (ten.length) phan.push(ten.slice(0, 3).join(', ') + (ten.length > 3 ? '…' : ''));
  const d = new Date();
  const base = ('SigMa QR ' + (phan.join(' — ') || 'báo cáo')).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 140);
  return `${base} ${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}.png`;
}

// [16/9] RefundQrModal + nhomHoanTuDong đã TÁCH ra components/RefundQrModal.tsx (dùng chung với Doanh số phòng).
function nhomHoanTuRows(rows: BaoCoReportRow[]): NhomHoan[] {
  return nhomHoanTuDong(rows.map((r) => ({ dealer: r.manualDealer ?? r.dealerName ?? r.maChuName ?? null, id: r.billId, sauPhi: r.sauPhiBan })));
}

function BaoCoImageReportModal({ rows, onClose }: { rows: BaoCoReportRow[]; onClose: () => void }): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  // [Admin Demo 16/9] Ảnh báo cáo KÈM mã VietQR (đủ STK/tên/bank/tiền + note) khi các GD cùng 1 đại lý có TK cấu
  // hình — quét thẳng từ ảnh gửi khách. Nhiều đại lý/thiếu TK → ảnh như cũ (không bịa QR).
  useEffect(() => {
    let huy = false;
    (async () => {
      const dealers = [...new Set(rows.map((r) => (r.manualDealer ?? r.dealerName ?? r.maChuName ?? '').trim()).filter(Boolean))];
      let hoan: HoanQrCanvas | undefined;
      if (dealers.length === 1) {
        const tien = lamTronNghinXuong(rows.reduce((s, r) => s + (r.sauPhiBan ?? 0), 0));
        if (tien > 0) {
          const a = await getDealerRefundAccount(dealers[0]);
          if (a.ok && a.data) {
            const q = await fetchVietQrPngUrl(dealers[0], tien, noiDungChuyenKhoanQr('QR', dealers[0]));
            if (q.ok) {
              const img = new Image();
              await new Promise<void>((rs, rj) => { img.onload = () => rs(); img.onerror = () => rj(new Error('QR load')); img.src = q.data; });
              hoan = { img, acc: a.data, tien, dealer: dealers[0] };
            }
          }
        }
      }
      if (!huy) setDataUrl(veCanvasBaoCaoQr(rows, hoan).toDataURL('image/png'));
    })().catch(() => { if (!huy) setDataUrl(veCanvasBaoCaoQr(rows).toDataURL('image/png')); });
    return () => { huy = true; };
  }, [rows]);
  function taiAnh(): void {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl; a.download = tenFileBaoCaoQr(rows); a.click();
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose} data-testid="baoco-rpt-modal">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-0 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-line bg-white px-4 py-3">
          <Button variant="confirm" icon={<FileImage className="h-4 w-4" />} onClick={taiAnh}>📷 Tải ảnh báo cáo</Button>
          <Button variant="soft" onClick={onClose}>Đóng</Button>
        </div>
        <div className="p-4">
          {dataUrl ? <img src={dataUrl} alt="Báo cáo hoàn sau phí" className="w-full rounded-xl border border-line" /> : <Loader2 className="mx-auto my-8 h-6 w-6 animate-spin" />}
        </div>
      </div>
    </div>
  );
}

// [Admin Demo 22/9 — YÊU CẦU NĐT HOÀN] Tick nhiều bill → BẢNG TÍNH theo GIÁ MUA + QR TK SIGMA (NĐT quét chuyển về).
// Số tiền = Σ sauPhiMua (server tính per-bill theo giá mua đã set, kể cả giá cuối tuần) TRÒN XUỐNG NGHÌN.
// Bill CHƯA có giá mua (sauPhiMua null) KHÔNG cộng vào QR — báo rõ số bill bị loại (R198, không nuốt câm).
function NdtRefundReportModal({ rows, onClose }: { rows: BaoCoReportRow[]; onClose: () => void }): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [canhBao, setCanhBao] = useState<string | null>(null);
  // [Admin Demo 23/9] MÃ YCHT của đợt — sinh Ở SERVER (mỗi lần tạo = 1 mã; khoá 1-bill-1-YCHT chống đòi NĐT 2 lần).
  // Dùng cho: NỘI DUNG CK trên VietQR + TIÊU ĐỀ ảnh + TÊN FILE tải về.
  const [maYcht, setMaYcht] = useState<string | null>(null);
  // [Admin Demo 23/9] "chèn 5 mã bị mất mã QR" = 4/5 GD đã nằm YCHT001 nên bản đầu CHẶN tạo ⇒ mất mã + mất QR.
  // Anh CHỐT: "trùng rồi vẫn cho tạo YC, mã QR vẫn phải có" → server không chặn nữa; ở đây chỉ hiện CẢNH BÁO
  // (GD nào đang nằm YCHT cũ) còn ảnh + QR vẫn dựng bình thường. `loi` chỉ còn cho lỗi thật (mất mạng, 0đ…).
  const [loi, setLoi] = useState<string | null>(null);
  // [23/9 — harness bắt được] React chạy effect 2 LƯỢT (StrictMode dev / re-render) → gọi tạo YCHT 2 lần ⇒ đẻ 2 mã
  // cho cùng đợt, lần 2 dính khoá 1-bill-1-YCHT rồi hiện cảnh báo đỏ OAN. Ref chốt: 1 lần mở modal = ĐÚNG 1 YCHT.
  const daChayRef = useRef(false);
  useEffect(() => {
    if (daChayRef.current) return;
    daChayRef.current = true;
    // KHÔNG dùng cờ huỷ (cleanup): StrictMode huỷ lượt 1 → lượt 2 bị ref chặn → KHÔNG ai set ảnh, modal treo
    // spinner vĩnh viễn (harness 23/9 bắt được). Ref đã chốt chạy-1-lần nên set state thẳng là đúng và đủ.
    (async () => {
      const thieu = rows.filter((r) => r.sauPhiMua == null).length;
      if (thieu > 0) setCanhBao(`⚠ ${thieu}/${rows.length} GD CHƯA có giá mua (chưa khớp/chưa set giá) — KHÔNG tính vào số tiền QR. Set giá mua cho mã rồi tạo lại.`);
      const tien = lamTronNghinXuong(rows.reduce((sum, r) => sum + (r.sauPhiMua ?? 0), 0));
      let hoan: HoanQrCanvas | undefined;
      let code: string | null = null;
      if (tien > 0) {
        const a = await getNdtQrAccount();
        if (a.ok) {
          // TẠO YCHT TRƯỚC khi dựng QR: server chặn bill đã nằm YCHT khác (409) → không sinh QR đòi tiền trùng.
          const yc = await taoYchtNdt({
            billIds: rows.filter((r) => r.sauPhiMua != null).map((r) => r.billId), amount: tien,
            bankCode: a.data.bankCode, accountNo: a.data.accountNo, accountName: a.data.accountName
          });
          if (!yc.ok) {
            setLoi(yc.message);
            return; // lỗi thật (không tạo được YC) → không dựng ảnh cụt.
          }
          const trung = yc.data.trungYchtCu ?? [];
          if (trung.length > 0) {
            const ds = [...new Set(trung.map((x) => x.code))].join(', ');
            setCanhBao((c) => (c ? c + ' · ' : '') + `⚠ ${trung.length} GD đã nằm trong yêu cầu cũ (${ds}) — VẪN tạo yêu cầu mới theo lệnh, kiểm tra kỹ kẻo đòi NĐT 2 lần.`);
          }
          code = yc.data.code;
          setMaYcht(code);
          const q = await fetchNdtVietQrPngUrl(tien, code); // nội dung CK = ĐÚNG mã YCHT
          if (q.ok) {
            const img = new Image();
            await new Promise<void>((rs, rj) => { img.onload = () => rs(); img.onerror = () => rj(new Error('QR load')); img.src = q.data; });
            hoan = { img, acc: { bankCode: a.data.bankCode, accountNo: a.data.accountNo, accountName: a.data.accountName } as DealerRefundAccount, tien, dealer: code };
          } else setCanhBao((c) => (c ? c + ' · ' : '') + q.message);
        } else setCanhBao((c) => (c ? c + ' · ' : '') + a.message);
      }
      setDataUrl(veCanvasBaoCaoQr(rows, hoan, 'ndt', code).toDataURL('image/png'));
    })().catch(() => setDataUrl(veCanvasBaoCaoQr(rows, undefined, 'ndt').toDataURL('image/png')));
  }, [rows]);
  function taiAnh(): void {
    if (!dataUrl) return;
    const d = new Date();
    const a = document.createElement('a');
    // [Admin Demo 23/9] TÊN FILE = MÃ YCHT (chưa có mã → fallback theo ngày).
    a.href = dataUrl;
    a.download = maYcht ? `${maYcht}.png` : `SigMa YC NDT hoan ${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}.png`;
    a.click();
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose} data-testid="ndt-rpt-modal">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-0 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-line bg-white px-4 py-3">
          {!loi && <Button variant="confirm" icon={<FileImage className="h-4 w-4" />} onClick={taiAnh} disabled={!dataUrl}>📷 Tải ảnh yêu cầu</Button>}
          <Button variant="soft" onClick={onClose}>Đóng</Button>
        </div>
        {loi && (
          <div className="mx-4 mt-3 rounded-xl border-2 border-danger/40 bg-danger/5 px-4 py-3 text-sm" data-testid="ycht-loi">
            <div className="font-bold text-danger">⛔ CHƯA tạo được yêu cầu</div>
            <div className="mt-1 text-slate-700">{loi}</div>
          </div>
        )}
        {canhBao && !loi && <div className="mx-4 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{canhBao}</div>}
        <div className="p-4">
          {loi ? null : dataUrl ? <img src={dataUrl} alt="Yêu cầu NĐT hoàn" className="w-full rounded-xl border border-line" /> : <Loader2 className="mx-auto my-8 h-6 w-6 animate-spin" />}
        </div>
      </div>
    </div>
  );
}

export function BaoCoReportScreen(): JSX.Element {
  const [preset, setPreset] = useState<Preset>('today');
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
  const [cFrom, setCFrom] = useState(ymd(weekAgo));
  const [cTo, setCTo] = useState(ymd(today));
  const [filter, setFilter] = useState<BaoCoReportFilter>('all');
  const [dealer, setDealer] = useState('');
  // Tìm client-side (Admin Demo 6/9): theo SỐ TIỀN (khớp chuỗi chữ-số) + TÊN NGƯỜI GỬI (bỏ dấu, chứa). Bỏ dropdown HKD.
  const [searchAmount, setSearchAmount] = useState('');
  const [searchPayer, setSearchPayer] = useState('');
  // Lọc theo MÃ QR (server-side theo source_tid_id — như dropdown TID POS). '' = tất cả mã.
  // [Admin Demo 24/9 "tích chọn nhiều mã HKD để lọc và kéo báo có riêng"] Trước chỉ chọn ĐƯỢC 1 mã (dropdown).
  // Nay: TẬP mã đã tích (rỗng = tất cả). maTid giữ lại để client/harness cũ không vỡ (= mã duy nhất nếu chọn 1).
  const [maChon, setMaChon] = useState<number[]>([]);
  const [moChonMa, setMoChonMa] = useState(false);
  const maTid: number | '' = maChon.length === 1 ? maChon[0]! : '';
  const [maList, setMaList] = useState<QrMaItem[]>([]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [report, setReport] = useState<BaoCoReport | null>(null);
  // Tải lại giao dịch mới nhất (kéo từ cổng ngân hàng) — trạng thái riêng + banner kết quả.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<BaoCoRefreshResult | null>(null);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  // Xuất Excel báo-có (Admin Demo 14/10): trạng thái riêng để nút không khoá cả màn + báo lỗi tường minh.
  const [xuatBusy, setXuatBusy] = useState(false);
  const [xuatLoi, setXuatLoi] = useState<string | null>(null);
  const [xuatXong, setXuatXong] = useState<DownloadResult | null>(null);

  // [Admin Demo 14/9 — full chức năng CQR] tick chọn GD + danh mục đại lý + thông báo đối soát + modal báo cáo ảnh.
  const [tick, setTick] = useState<Set<string>>(new Set());
  const [dealerNames, setDealerNames] = useState<string[]>([]);
  const [selDealer, setSelDealer] = useState('');
  const [reconBusy, setReconBusy] = useState(false);
  const [reconMsg, setReconMsg] = useState<string | null>(null);
  const [rptOpen, setRptOpen] = useState(false);
  const [ndtRptOpen, setNdtRptOpen] = useState(false); // [22/9] modal YC NĐT hoàn
  // [Admin Demo 16/9 — VietQR] Nhóm hoàn hiện modal QR sau "Xác nhận đã đối soát" (null = đóng).
  const [refundGroups, setRefundGroups] = useState<NhomHoan[] | null>(null);

  // OWNER-GATE (lớp UI; server VẪN chặn 403). [22/9] + VIEWER (DL65 Khach Demo F): XEM được bảng/KPI,
  // các nút GHI (đối soát/hoàn/YC NĐT/tải QR) chỉ owner — server route ghi vẫn 403 làm lớp chặn thật.
  const isOwner = isAlphaOwnerCode(getCachedAuthenticatedAgent()?.code);
  const isViewer = isQrReconViewerCode(getCachedAuthenticatedAgent()?.code);

  /** Khoảng [from, to) nửa-mở theo preset (server hiểu YYYY-MM-DD = nửa đêm HCM). */
  function periodBounds(): { from: string; to: string } {
    if (preset === 'today') return { from: hcmDayStr(0), to: hcmDayStr(1) };
    if (preset === 'yesterday') return { from: hcmDayStr(-1), to: hcmDayStr(0) };
    if (preset === 'week') { // Tuần này = từ THỨ HAI (HCM) → mai
      const h = new Date(Date.now() + 7 * 3600_000);
      const dow = (h.getUTCDay() + 6) % 7; // 0 = thứ 2
      return { from: hcmDayStr(-dow), to: hcmDayStr(1) };
    }
    if (preset === 'month') { // Tháng này = từ NGÀY 1 (HCM) → mai
      const h = new Date(Date.now() + 7 * 3600_000);
      return { from: `${h.getUTCFullYear()}-${pad(h.getUTCMonth() + 1)}-01`, to: hcmDayStr(1) };
    }
    return { from: cFrom, to: nextDayStr(cTo) }; // custom: gồm cả ngày đến
  }

  /** Nhãn khoảng ngày hiện ra ô "Ngày báo có" (ô solid, chỉ đọc) — dd/MM/yyyy - dd/MM/yyyy, ngày ĐẾN tính
   *  INCLUSIVE (periodBounds trả `to` nửa-mở = hôm sau; hiển thị phải lùi 1 ngày kẻo người xem tưởng lố 1 ngày). */
  function nhanKhoangNgay(): string {
    const { from, to } = periodBounds();
    const d = (iso: string): string => { const [y, m, dd] = iso.split('-'); return `${dd}/${m}/${y}`; };
    const denIn = new Date(`${to}T00:00:00Z`);
    denIn.setUTCDate(denIn.getUTCDate() - 1);
    const denIso = `${denIn.getUTCFullYear()}-${pad(denIn.getUTCMonth() + 1)}-${pad(denIn.getUTCDate())}`;
    return from === denIso ? d(from) : `${d(from)} - ${d(denIso)}`;
  }

  /**
   * [Admin Demo 14/10 "thêm xuất excel báo có của phần này"] TẢI .xlsx của ĐÚNG bảng đang xem — cùng kỳ, cùng bộ
   * lọc mã/trạng thái/đại lý. File do SERVER dựng từ cùng `buildBaoCoReport` nên số liệu không thể lệch với
   * bảng. Tải qua `downloadAttachment` (đường dùng chung: web `<a download>` · EXE bridge lưu Downloads · APK
   * ghi Documents) chứ không gắn thẻ <a> thô — gắn thô là 403 vì thiếu credentials/CSRF (bug B49 cũ).
   */
  async function xuatExcel(): Promise<void> {
    if (xuatBusy) return;
    setXuatBusy(true); setXuatLoi(null);
    try {
      const { from, to } = periodBounds();
      const url = urlBaoCoXlsx(from, to, { filter, dealer: dealer || undefined, tidIds: maChon.length ? maChon : null });
      const ten = `bao-co-qr_${from}_${to}.xlsx`;
      const kq = await downloadAttachment(url, ten);
      setXuatXong(kq);
    } catch (e) {
      // R198: tải hỏng phải NÓI, không im lặng để người dùng tưởng đã có file.
      setXuatLoi(e instanceof Error ? e.message : String(e));
    } finally {
      setXuatBusy(false);
    }
  }

  /** Nút "Clear" của cổng: trả MỌI ô lọc về mặc định (kỳ = hôm nay). Không tự gọi load — bấm "Tìm kiếm" mới tải,
   *  đúng nếp cổng SmartPay (Clear chỉ xoá ô). */
  function xoaLoc(): void {
    setPreset('today');
    setFilter('all');
    setDealer('');
    setSearchAmount('');
    setSearchPayer('');
    setMaChon([]);
    setMoChonMa(false);
  }


  async function load(): Promise<void> {
    setLoading(true); setErr(null);
    const { from, to } = periodBounds();
    // Gửi kèm hkd/dealer để backend có thể lọc (contract), nhưng LỌC HIỂN THỊ + dropdown làm CLIENT-side trên tập đầy
    // đủ (chỉ kỳ + trạng thái) → dropdown HKD/đại lý KHÔNG bị co về 1 lựa chọn khi đã chọn, tổng khớp bảng hiển thị.
    const r = await fetchBaoCoReport(from, to, { filter, tidIds: maChon.length ? maChon : null });
    setLoading(false);
    if (!r.ok) {
      if (r.error === 'FORBIDDEN') { setForbidden(true); return; } // server chặn không-phải-chủ
      setErr(r.message); return;
    }
    setReport(r.data);
  }

  /** Tải lại giao dịch mới nhất: kéo từ cổng ngân hàng → hiện banner {fetched,matched,unreconciled,errors} → nạp lại báo cáo. */
  async function doRefresh(): Promise<void> {
    setRefreshing(true); setRefreshErr(null); setRefreshResult(null);
    const r = await refreshBaoCo(maChon.length ? maChon : undefined); // [24/9] chỉ kéo mã đã tích (nếu có)
    setRefreshing(false);
    if (!r.ok) {
      if (r.error === 'FORBIDDEN') { setForbidden(true); return; }
      setRefreshErr(r.message); return;
    }
    setRefreshResult(r.data);
    await load(); // đối soát xong → làm mới bảng + KPI theo dữ liệu vừa kéo
  }

  // Nạp lại khi đổi kỳ/lọc-trạng-thái/ngày-custom/MÃ QR (mã = server-side). HKD/đại lý lọc CLIENT-side (không refetch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isViewer) void load(); }, [preset, filter, cFrom, cTo, maChon.join(',')]);
  // Đổ dropdown mã QR (owner-gated /creds) 1 lần khi vào màn — lỗi thì để rỗng, không chặn báo cáo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isOwner) void (async () => { const r = await listQrMa(); if (r.ok) setMaList(r.data); })(); }, []); // creds — CHỈ owner (viewer: dropdown mã rỗng)
  // Danh mục đại lý (khách SigMa) cho dropdown gán + thanh đối soát — 1 lần khi vào màn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isViewer) void (async () => { const r = await listDealerNames(); if (r.ok) setDealerNames(r.data); })(); }, []);

  function toggleTick(billId: string): void {
    setTick((t) => { const n = new Set(t); if (n.has(billId)) n.delete(billId); else n.add(billId); return n; });
  }
  function toggleTickAll(rowsShown: BaoCoReportRow[]): void {
    setTick((t) => {
      const all = rowsShown.length > 0 && rowsShown.every((r) => t.has(r.billId));
      const n = new Set(t);
      for (const r of rowsShown) { if (all) n.delete(r.billId); else n.add(r.billId); }
      return n;
    });
  }
  /** Xác nhận/bỏ đối soát các GD đã tick → server ghi qr_baoco_recon → nạp lại báo cáo. */
  async function doRecon(daDoiSoat: boolean): Promise<void> {
    if (tick.size === 0) return;
    // [Admin Demo 16/9 — VietQR] Chụp các dòng tick TRƯỚC khi clear để dựng nhóm hoàn (đại lý → tổng sau phí).
    const dongTick = daDoiSoat ? displayedRows.filter((x) => tick.has(x.billId)) : [];
    setReconBusy(true); setReconMsg(null);
    const r = await setBaocoRecon([...tick], daDoiSoat, daDoiSoat ? (selDealer || undefined) : undefined);
    setReconBusy(false);
    if (!r.ok) { setReconMsg(r.message); return; }
    setReconMsg(r.data.message);
    setTick(new Set());
    await load();
    // Xác nhận đối soát xong → hiện QR hoàn (đại lý action-bar đã chọn thì gán đè cho cả đợt).
    if (daDoiSoat && dongTick.length > 0) {
      const rowsHoan = selDealer ? dongTick.map((x) => ({ ...x, manualDealer: selDealer })) : dongTick;
      setRefundGroups(nhomHoanTuRows(rowsHoan));
    }
  }
  /** Gán đại lý 1 GD (dropdown trong bảng) — cập nhật lạc quan local rồi ghi server. */
  async function doSetDealer(billId: string, dealer: string | null): Promise<void> {
    setReport((rep) => rep ? { ...rep, rows: rep.rows.map((r) => r.billId === billId ? { ...r, manualDealer: dealer } : r) } : rep);
    const r = await setBaocoDealer(billId, dealer);
    if (!r.ok) { setReconMsg(r.message); await load(); }
  }

  // Danh sách đại lý cho dropdown lọc — suy từ TẬP ĐẦY ĐỦ đã tải (không co khi đang lọc).
  // [Admin Demo 22/9 "báo cáo QR chưa lọc được theo đại lý"] Tên đại lý của 1 GD = ĐÚNG tên đang hiện trên bảng
  // (gán tay ?? dealerName ?? chủ mã) — trước đây lọc + dropdown chỉ nhìn dealerName gốc (đa số GD null vì gán
  // tay/theo chủ mã) → dropdown thiếu tên, chọn cũng lọc trượt. MỘT nguồn tên dùng chung cho options + filter.
  const tenDaiLyCuaRow = (r: BaoCoReportRow): string | null => (r.manualDealer ?? r.dealerName ?? r.maChuName) || null;
  const dealerOptions = useMemo(() => Array.from(new Set((report?.rows ?? []).map(tenDaiLyCuaRow).filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b, 'vi')), [report]);

  // Dòng HIỂN THỊ = lọc client-side theo đại lý + số tiền + tên người gửi. STT giữ theo thứ tự hiển thị (đánh lại cho gọn).
  const displayedRows: BaoCoReportRow[] = useMemo(() => {
    const src = report?.rows ?? [];
    const qAmt = digitsOnly(searchAmount);
    const qPayer = normVi(searchPayer);
    return src
      .filter((r) => (!dealer || tenDaiLyCuaRow(r) === dealer)
        && (!qAmt || digitsOnly(r.amount).includes(qAmt))
        && (!qPayer || normVi(r.payerName).includes(qPayer)))
      .map((r, i) => ({ ...r, stt: i + 1 }));
  }, [report, dealer, searchAmount, searchPayer]);

  // Tổng theo ĐÚNG dòng đang hiển thị (khớp bảng) — khi có lọc client sẽ khác totals toàn kỳ của server.
  const t = useMemo(() => {
    if (!report) return null;
    if (!dealer && !searchAmount && !searchPayer) return report.totals; // không lọc → dùng totals server (toàn kỳ)
    return displayedRows.reduce((a, r) => {
      a.amount += r.amount; a.loiNhuanAlpha += r.loiNhuanAlpha ?? 0; a.count += 1;
      if (r.reconcileStatus !== 'MATCHED') a.countUnreconciled += 1; // đếm cả bản ghi chưa xét (status rỗng)
      return a;
    }, { amount: 0, loiNhuanAlpha: 0, count: 0, countUnreconciled: 0 });
  }, [report, dealer, searchAmount, searchPayer, displayedRows]);
  // OWNER-GATE: không phải chủ SigMa (client) HOẶC server trả 403 → chặn, không hiện dữ liệu.
  if (!isViewer || forbidden) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-4 p-4 pb-24">
          <div className="flex items-center gap-2 text-lg font-bold text-brand-deep"><Landmark className="h-5 w-5" /> Báo cáo Báo-có (Digistore)</div>
          <div className="glass-panel shadow-soft flex flex-col items-center gap-3 rounded-2xl border border-danger/30 p-8 text-center">
            <AlertTriangle className="h-8 w-8 text-danger" />
            <div className="text-sm font-semibold text-slate-600">Chỉ chủ SigMa mới xem được Báo cáo Báo-có.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    // [Admin Demo 6/9] FIX CUỘN KẸT: AppShell bọc Outlet trong overflow-hidden → màn con PHẢI tự cuộn (như Kpi/Investor).
    <div className="h-full overflow-y-auto">
    {/* [Admin Demo 6/9] Lề 2 bên 1.5cm full-width như OCR/Quét QR (bỏ max-w-6xl) → bảng rộng, cột HKD/mô tả không tràn 2 dòng. */}
    <div className="w-full space-y-4 px-[1.5cm] py-4 pb-24">
      <div className="flex items-center gap-2 text-lg font-bold text-brand-deep"><Landmark className="h-5 w-5" /> Báo cáo Báo-có (Digistore)</div>

      {/* [Admin Demo 6/9] THIẾT LẬP HẠN MỨC QR/ngày theo mã. */}
      {isOwner && <QrDailyLimitSection />}

      {/* LỌC — SAO Y GIAO DIỆN PHẦN LỌC CỔNG SmartPay (Admin Demo chốt phương án B, 14/10).
          Mọi px/màu lấy từ computed style ĐO THẬT trên sem.paysmart.com.vn (xem đầu baoco-loc-smartpay.css),
          không ước lượng bằng mắt. Cổng có 14 ô lọc; bên mình chỉ dựng những ô CÓ DỮ LIỆU THẬT — không bày ô
          chết (Mã chi nhánh / Số chuẩn chi / Lô quyết toán / PC ID… mình không có nguồn để lọc). */}
      <div className="sp-loc" data-testid="baoco-loc-smartpay">
        <div className="sp-loc__luoi">
          <div className="sp-loc__o">
            <label className="sp-loc__nhan" htmlFor="sp-ky">Kỳ báo cáo</label>
            <select id="sp-ky" className="sp-loc__chon" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} data-testid="baoco-loc-ky">
              <option value="today">Hôm nay</option>
              <option value="yesterday">Hôm qua</option>
              <option value="week">Tuần này</option>
              <option value="month">Tháng này</option>
              <option value="custom">Chọn chu kỳ</option>
            </select>
          </div>

          <div className="sp-loc__o">
            <label className="sp-loc__nhan">Ngày báo có</label>
            {preset === 'custom'
              ? (
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input type="date" className="sp-loc__nhap" value={cFrom} max={cTo} onChange={(e) => setCFrom(e.target.value)} data-testid="baoco-loc-tu" />
                  <input type="date" className="sp-loc__nhap" value={cTo} min={cFrom} onChange={(e) => setCTo(e.target.value)} data-testid="baoco-loc-den" />
                </div>
              )
              /* Ô "solid" xám y như ô Ngày giao dịch của cổng: chỉ hiện khoảng ngày, muốn sửa thì chọn "Chọn chu kỳ". */
              : <input className="sp-loc__nhap sp-loc__nhap--solid" readOnly value={nhanKhoangNgay()} data-testid="baoco-loc-ngay" />}
          </div>

          <div className="sp-loc__o" style={{ position: 'relative' }}>
            <label className="sp-loc__nhan">Mã QR</label>
            <button type="button" className="sp-loc__chonnhieu" onClick={() => setMoChonMa((v) => !v)} data-testid="baoco-filter-ma">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {maChon.length === 0 ? 'Tất cả mã'
                  : maChon.length === 1 ? (maList.find((m) => m.tidId === maChon[0])?.hkdName || `Mã #${maChon[0]}`)
                    : `${maChon.length} mã đã chọn`}
              </span>
              <span className="sp-loc__chonnhieu-caret">{moChonMa ? '▲' : '▼'}</span>
            </button>
            {moChonMa && (
              <div className="sp-loc__panel" data-testid="baoco-ma-panel">
                <div className="sp-loc__panel-dau">
                  <button type="button" className="sp-loc__panel-nut" onClick={() => setMaChon(maList.map((m) => m.tidId))}>Chọn tất cả</button>
                  <button type="button" className="sp-loc__panel-nut sp-loc__panel-nut--xam" onClick={() => setMaChon([])} data-testid="baoco-ma-bochon">Bỏ chọn</button>
                  <button type="button" className="sp-loc__panel-nut sp-loc__panel-nut--xam" style={{ marginLeft: 'auto' }} onClick={() => setMoChonMa(false)}>Đóng</button>
                </div>
                {maList.length === 0 && <div style={{ padding: '10px 8px', color: '#a1a5b7' }}>Chưa có mã QR nào.</div>}
                {maList.map((m) => (
                  <label key={m.tidId} className="sp-loc__panel-hang" data-testid="baoco-ma-item">
                    <input type="checkbox" checked={maChon.includes(m.tidId)} data-testid={`baoco-ma-tick-${m.tidId}`}
                      onChange={() => setMaChon((truoc) => truoc.includes(m.tidId) ? truoc.filter((x) => x !== m.tidId) : [...truoc, m.tidId])} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.hkdName || m.tid}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="sp-loc__o">
            <label className="sp-loc__nhan" htmlFor="sp-tt">Trạng thái giao dịch</label>
            <select id="sp-tt" className="sp-loc__chon" value={filter} onChange={(e) => setFilter(e.target.value as BaoCoReportFilter)} data-testid="baoco-filter-status">
              <option value="all">Tất cả</option>
              <option value="reconciled">Đã đối soát</option>
              <option value="unreconciled">Chưa đối soát</option>
            </select>
          </div>

          <div className="sp-loc__o">
            <label className="sp-loc__nhan" htmlFor="sp-tien">Số tiền</label>
            <input id="sp-tien" type="text" inputMode="numeric" className="sp-loc__nhap" value={searchAmount}
              onChange={(e) => setSearchAmount(e.target.value)} data-testid="baoco-search-amount" />
          </div>

          <div className="sp-loc__o">
            <label className="sp-loc__nhan" htmlFor="sp-nguoi">Tên người gửi</label>
            <input id="sp-nguoi" type="text" className="sp-loc__nhap" value={searchPayer}
              onChange={(e) => setSearchPayer(e.target.value)} data-testid="baoco-search-payer" />
          </div>

          <div className="sp-loc__o">
            <label className="sp-loc__nhan" htmlFor="sp-dl">Đại lý</label>
            <select id="sp-dl" className="sp-loc__chon" value={dealer} onChange={(e) => setDealer(e.target.value)} data-testid="baoco-filter-dealer">
              <option value="">Tất cả đại lý</option>
              {dealerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>

        <div className="sp-loc__hangnut">
          <button type="button" className="sp-loc__nut sp-loc__nut--tim" onClick={() => void load()} disabled={loading} data-testid="baoco-nut-tim">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} {loading ? 'Đang tải…' : 'Tìm kiếm'}
          </button>
          <button type="button" className="sp-loc__nut sp-loc__nut--clear" onClick={xoaLoc} data-testid="baoco-nut-clear">
            <Eraser className="h-4 w-4" /> Clear
          </button>
          {/* XUẤT EXCEL — cổng SmartPay cũng có nút Export ở đúng chỗ này; dùng kiểu nút ĐẶC giống bên đó. */}
          <button type="button" className="sp-loc__nut sp-loc__nut--dac" onClick={() => void xuatExcel()} disabled={xuatBusy || loading} data-testid="baoco-nut-xuat">
            {xuatBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} {xuatBusy ? 'Đang xuất…' : 'Xuất Excel'}
          </button>
          {/* TẢI LẠI giao dịch mới nhất: kéo từ cổng ngân hàng (DigiStore + PaySmart) rồi đối soát — khác "Tìm kiếm"
              (chỉ đọc lại DB). Dùng kiểu nút ĐẶC giống nút Export của cổng để tách bạch hành động nặng. */}
          {isOwner && (
            <button type="button" className="sp-loc__nut sp-loc__nut--dac" onClick={() => void doRefresh()} disabled={refreshing || loading} data-testid="baoco-nut-taila">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />} {refreshing ? 'Đang kéo…' : 'Tải lại giao dịch mới nhất'}
            </button>
          )}
        </div>
      </div>

      {/* Kết quả XUẤT EXCEL: xong thì cho bấm "Mở file" (EXE/APK có đường dẫn thật); lỗi thì nói thẳng. */}
      {xuatLoi && (
        <div className="flex items-center gap-2 rounded-xl border border-danger/20 bg-danger/10 p-3 text-sm text-danger" data-testid="baoco-xuat-loi">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Không xuất được Excel: {xuatLoi}
        </div>
      )}
      {xuatXong && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700" data-testid="baoco-xuat-xong">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> Đã xuất file Excel báo-có.
          {xuatXong.uri && (
            <button type="button" className="ml-1 rounded-lg border border-emerald-400 px-2 py-0.5 text-xs font-bold hover:bg-emerald-100"
              onClick={() => void openDownloadedFile(xuatXong)} data-testid="baoco-xuat-mo">Mở file</button>
          )}
          <button type="button" className="ml-auto text-xs font-bold text-emerald-600 hover:underline" onClick={() => setXuatXong(null)}>Đóng</button>
        </div>
      )}

      {/* BANNER kết quả tải lại: kéo N, khớp M, còn K chưa đối soát; nếu có lỗi → liệt kê mã + lý do. */}
      {refreshErr && <div className="flex items-center gap-2 rounded-xl bg-danger/10 border border-danger/20 p-3 text-sm text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {refreshErr}</div>}
      {refreshResult && (
        <div className={`rounded-xl border p-3 text-sm ${refreshResult.errors.length > 0 || refreshResult.paysmart?.ok === false ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}`} data-testid="baoco-refresh-banner">
          <div className="flex items-center gap-2 font-semibold">
            {refreshResult.errors.length > 0
              ? <><AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> <span className="text-amber-700">Đã kéo {refreshResult.fetched} giao dịch · khớp {refreshResult.matched} · còn {refreshResult.unreconciled} chưa đối soát — {refreshResult.errors.length} cổng lỗi</span></>
              : <><CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> <span className="text-emerald-700">Đã kéo {refreshResult.fetched} giao dịch · khớp {refreshResult.matched} · còn {refreshResult.unreconciled} chưa đối soát</span></>}
          </div>
          {/* [Agent-3 11/9 — R198] PaySmart chết không được im: dòng riêng amber khi lỗi, xám nhẹ khi ok.
              [14/10] Nhiều mã PaySmart → gọi ĐÚNG TÊN từng mã lỗi (chữ "DEMOMAY" viết cứng cũ sẽ nói sai nhà khi
              mã thứ hai hỏng), và nói rõ mấy/mấy mã chạy được. */}
          {refreshResult.paysmart != null && (
            refreshResult.paysmart.ok
              ? <div className="mt-1 text-[13px] text-slate-500" data-testid="baoco-paysmart-ok">PaySmart: nạp {refreshResult.paysmart.naped} báo có{refreshResult.paysmart.soMa ? ` · ${refreshResult.paysmart.soOk ?? refreshResult.paysmart.soMa}/${refreshResult.paysmart.soMa} mã` : ''}</div>
              : <div className="mt-1 flex items-start gap-2 text-[13px] font-semibold text-amber-800" data-testid="baoco-paysmart-loi"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>
                  PaySmart {refreshResult.paysmart.soMa ? `chỉ kéo được ${refreshResult.paysmart.soOk ?? 0}/${refreshResult.paysmart.soMa} mã` : 'KHÔNG kéo được'} — các mã sau đang THIẾU dữ liệu mới:
                  {(refreshResult.paysmart.loiMa ?? []).length > 0
                    ? <ul className="mt-1 ml-1 list-disc space-y-0.5 pl-4 font-normal">
                        {(refreshResult.paysmart.loiMa ?? []).map((x) => (
                          <li key={x.tidId}><b>{x.tenHkd ?? `mã ${x.tidId}`}</b> — {x.ly}</li>
                        ))}
                      </ul>
                    : <span className="font-normal">{refreshResult.paysmart.error ? ` ${refreshResult.paysmart.error}` : ''}</span>}
                </span></div>
          )}
          {refreshResult.errors.length > 0 && (
            <ul className="mt-2 space-y-1">
              {refreshResult.errors.map((e, i) => (
                <li key={`${e.tid}-${i}`} className="flex items-start gap-2 text-[13px] text-amber-800">
                  <span className="mt-0.5 shrink-0 rounded bg-amber-200 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-800">{e.code}</span>
                  <span><b>{e.tid}</b> — {e.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {err && <div className="flex items-center gap-2 rounded-xl bg-danger/10 border border-danger/20 p-3 text-sm text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {err}</div>}

      {report && t && (
        <>
          {/* KPI THEO NGÀY — trên đầu, cạnh 4 thẻ tổng. */}
          <KpiByDayTable hideProfit={!isOwner} rows={report.byDay} />

          {/* THẺ TỔNG */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Số giao dịch" value={String(t.count)} />
            <StatCard label="Tổng số tiền" value={money(t.amount)} accent />
            {isOwner && <StatCard label="Lợi nhuận SigMa" value={money(t.loiNhuanAlpha)} />}
            <StatCard label="Chưa đối soát" value={String(t.countUnreconciled)} danger />
          </div>

          {/* [14/9 — CQR] CẢNH BÁO ĐỎ: mã vượt HẠN MỨC/ngày trong kỳ. */}
          {report.limitWarnings.length > 0 && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm" data-testid="baoco-limit-warnings">
              {report.limitWarnings.map((w) => (
                <div key={`${w.tidId}-${w.day}`} className="flex items-center gap-2 font-semibold text-danger">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  🔴 {dayLabel(w.day)} — <b>{w.hkdName || `mã ${w.tidId}`}</b> doanh số {money(w.doanhSo)}đ ĐÃ ĐẠT/VƯỢT hạn mức {money(w.limit)}đ — đổi mã khác.
                </div>
              ))}
            </div>
          )}

          {reconMsg && <div className="rounded-xl border border-line bg-white p-2.5 text-sm text-slate-600">{reconMsg}</div>}

          <ReportTable hideProfit={!isOwner} rows={displayedRows} tick={tick} onTick={toggleTick} onTickAll={() => toggleTickAll(displayedRows)}
            dealerNames={dealerNames} onSetDealer={(id, d) => void doSetDealer(id, d)}
            onRefundUndo={(id) => void (async () => { const r = await postRefundUndo([id]); setReconMsg(r.ok ? r.data.message : r.message); await load(); })()}
            onSetFeeType={(id, ft) => void (async () => { const r = await setBaocoFeeType(id, ft); setReconMsg(r.ok ? r.data.message : r.message); await load(); })()} />

          {/* [14/9 — CQR] THANH ĐỐI SOÁT khi có GD được tick: chọn đại lý → xác nhận (xanh) / bỏ / bỏ chọn / xuất ảnh. */}
          {tick.size > 0 && (
            <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-brand/30 p-3 text-white shadow-xl" style={{ background: 'linear-gradient(120deg, #0f1a24 0%, #1877d6 55%, #3bc3d0 100%)' }} data-testid="baoco-action-bar">
              <b>☑ {tick.size} giao dịch</b>
              <select value={selDealer} onChange={(e) => setSelDealer(e.target.value)} className="rounded-lg border-0 px-2.5 py-1.5 text-sm text-slate-700">
                <option value="">— chọn đại lý —</option>
                {dealerNames.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {isOwner && <Button variant="confirm" icon={reconBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} onClick={() => void doRecon(true)} disabled={reconBusy}>Xác nhận đã đối soát</Button>}
              {isOwner && <Button variant="soft" icon={<Undo2 className="h-4 w-4" />} onClick={() => void doRecon(false)} disabled={reconBusy}>Bỏ đối soát</Button>}
              <Button variant="soft" icon={<X className="h-4 w-4" />} onClick={() => setTick(new Set())}>Bỏ chọn</Button>
              {isOwner && <Button variant="soft" icon={<FileImage className="h-4 w-4" />} onClick={() => setRptOpen(true)}>🧾 Tạo báo cáo ảnh</Button>}
              {isOwner && <Button variant="soft" icon={<QrCode className="h-4 w-4" />} onClick={() => setNdtRptOpen(true)} data-testid="btn-yc-ndt-hoan">💰 YC NĐT hoàn</Button>}
            </div>
          )}

          {rptOpen && <BaoCoImageReportModal rows={displayedRows.filter((r) => tick.has(r.billId))} onClose={() => setRptOpen(false)} />}
          {ndtRptOpen && <NdtRefundReportModal rows={displayedRows.filter((r) => tick.has(r.billId))} onClose={() => setNdtRptOpen(false)} />}
          {refundGroups && <RefundQrModal groups={refundGroups} onClose={() => setRefundGroups(null)} onDone={() => void load()} onXacNhanHoan={async (g, tien) => { const r = await postRefundDone(g.billIds, g.dealer, tien); return { ok: r.ok, message: r.ok ? r.data.message : r.message }; }} />}
        </>
      )}
    </div>
    </div>
  );
}
