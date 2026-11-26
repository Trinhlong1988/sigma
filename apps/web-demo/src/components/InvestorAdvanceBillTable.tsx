// BẢNG BILL CK TẠM ỨNG NĐT (Admin Demo 17/9: "DANH SÁCH BILL CK CỦA NĐT OCR RA ĐÂU? SAO THIẾU? GIỐNG SỐ TIỀN ĐÃ
// HOÀN ĐẠI LÝ KHI OCR BILL CÓ BÁO CÁO, BẢNG NÀY ĐÂU?"). Đối chiếu 2 vế: BILL ĐÃ OCR (ảnh trong nhóm NĐT) ⇄ DÒNG
// TIỀN ĐÃ GHI (investor_advances). Bill nào không ghép được dòng tiền = ĐỎ + cộng vào banner "LỆCH" — đúng loại
// lỗi vừa nuốt 1,2 tỷ nhà Trung mà hệ im lặng (lưới chống-trùng chặn nhầm, không ai thấy).
// Ảnh bill tải qua proxyFetch → objectURL (gate CSRF chặn <img src> trực tiếp — xem attachment-blob.ts).
import { useEffect, useState, type JSX } from 'react';
import { fetchInvestorAdvanceBills, type InvestorAdvanceBillReport, type InvestorAdvanceBillItem } from '../lib/investor-report-client';
import { fetchAttachmentObjectUrl } from '../lib/attachment-blob';
import { botApiBaseUrl } from '../lib/diary-api';
import { DotsLoader } from './DotsLoader';

const fmtVnd = (n: number): string => Math.round(n).toLocaleString('vi-VN');
/** Lý do kỹ thuật → câu tiếng Việt cho người vận hành đọc. */
function lyDoBoQua(reason: string): string {
  if (reason === 'NGUOI_NHAN_KHONG_PHAI_TK_ALPHA') return 'Người nhận không nằm trong danh sách TK SigMa';
  if (reason === 'SO_TIEN_KHONG_DOC_DUOC') return 'Không đọc được số tiền trên bill';
  if (reason === 'KHONG_DOC_DUOC_NGAY') return 'Không đọc được ngày giao dịch';
  return reason;
}

const dmy = (ymd: string | null): string => (ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : '—');

/** Ảnh bill: tải blob (kèm cookie + header CSRF) rồi mới gắn vào <img>. Bấm để mở to. */
function AnhBill({ attachmentId, onMoTo }: { attachmentId: string | null; onMoTo: (url: string) => void }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [loi, setLoi] = useState(false);
  useEffect(() => {
    if (!attachmentId) return;
    let huy = false;
    fetchAttachmentObjectUrl(`${botApiBaseUrl()}/v1/chat/attachments/${attachmentId}`)
      .then((u) => { if (!huy) setUrl(u); })
      .catch(() => { if (!huy) setLoi(true); });
    return () => { huy = true; };
  }, [attachmentId]);
  if (!attachmentId) return <span className="text-[10px] text-slate-400">—</span>;
  if (loi) return <span className="text-[10px] text-danger" title="Không tải được ảnh bill">lỗi ảnh</span>;
  if (!url) return <span className="inline-block h-10 w-8 animate-pulse rounded bg-slate-200" />;
  return (
    <button type="button" onClick={() => onMoTo(url)} title="Bấm để xem ảnh bill to">
      <img src={url} alt="Ảnh bill chuyển khoản" className="h-10 w-8 rounded border border-line object-cover transition hover:scale-110" />
    </button>
  );
}

export function InvestorAdvanceBillTable(
  { investorId, from, to, report }: { investorId: number; from: string; to: string; report?: InvestorAdvanceBillReport | null }
): JSX.Element {
  const [st, setSt] = useState<{ status: 'loading' | 'error' | 'ready'; data?: InvestorAdvanceBillReport; message?: string }>({ status: 'loading' });
  const [anhTo, setAnhTo] = useState<string | null>(null);

  useEffect(() => {
    // Thẻ NĐT đã tải báo cáo này để hiện CHIP cảnh báo → dùng lại, KHÔNG gọi API lần hai cho cùng dữ liệu.
    if (report) { setSt({ status: 'ready', data: report }); return; }
    let huy = false;
    setSt({ status: 'loading' });
    fetchInvestorAdvanceBills(investorId, from, to).then((r) => {
      if (huy) return;
      setSt(r.ok ? { status: 'ready', data: r.data } : { status: 'error', message: r.message });
    });
    return () => { huy = true; };
  }, [investorId, from, to, report]);

  const d = st.data;
  const lech = (d?.soBillChuaGhi ?? 0) > 0;
  return (
    <div className="mt-3" data-testid="bang-bill-ck-ndt">
      <div className="mb-1 flex items-center justify-between px-0.5">
        <div className="text-[10.5px] font-bold uppercase tracking-wide text-slate-400">
          Bill CK đã OCR {st.status === 'ready' ? `(${d?.bills.length ?? 0})` : ''}
        </div>
        {st.status === 'ready' && d && (
          <div className="text-[10.5px] font-semibold text-slate-500">
            Σ bill <span className="tabular-nums text-slate-700">{fmtVnd(d.tongBillUng)}đ</span>
            {' · '}đã ghi <span className="tabular-nums text-emerald-600">{fmtVnd(d.tongDaGhiUng)}đ</span>
          </div>
        )}
      </div>

      {st.status === 'loading' && <div className="flex items-center justify-center gap-2 py-3 text-xs text-slate-400"><DotsLoader /> Đang tải bill CK…</div>}
      {st.status === 'error' && <p className="py-2 text-center text-xs text-danger">Không tải được bill CK: {st.message}</p>}

      {st.status === 'ready' && d && (
        <>
          {/* CỜ ĐỎ: bill OCR được nhưng KHÔNG có dòng tiền nào → tiền đang rơi, phải xử ngay. */}
          {/* [Phản biện 17/9] GHÉP ĐƯỢC ≠ ĐÚNG SỐ: ghép theo hash ảnh/mã GD vẫn "khớp" dù tiền dòng ≠ tiền bill
              (OCR lệch, hoặc sửa bill mà quên sửa dòng tiền) → quỹ sai mà bảng xanh. Báo riêng, màu hổ phách. */}
          {d.soBillLechTien > 0 && (
            <div className="mb-1.5 rounded-lg border-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-xs font-bold text-amber-700" data-testid="canh-bao-lech-tien-ndt">
              ⚠ {d.soBillLechTien} bill ghép được nhưng SỐ TIỀN LỆCH: đã ghi {d.tienLechGhi > 0 ? 'THỪA' : 'THIẾU'} {fmtVnd(Math.abs(d.tienLechGhi))}đ so với bill — sửa lại dòng tạm ứng cho khớp.
            </div>
          )}
          {lech ? (
            <div className="mb-1.5 rounded-lg border-2 border-danger bg-danger/10 px-2.5 py-2 text-xs font-bold text-danger" data-testid="canh-bao-lech-bill-ndt">
              ⚠ LỆCH: {d.soBillChuaGhi} bill đã OCR nhưng CHƯA vào tạm ứng = {fmtVnd(d.tienChuaGhi)}đ — báo SigMa kiểm tra ngay (đừng cộng tay).
            </div>
          ) : (
            <div className="mb-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700">
              ✓ Khớp: mọi bill CK đã OCR đều có trong tạm ứng ({d.bills.length} bill).
            </div>
          )}

          {d.bills.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line py-2 text-center text-xs text-slate-400">Chưa có bill CK nào được OCR trong kỳ.</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr>
                  <th className="px-2 py-1 text-left font-semibold">Ảnh</th>
                  <th className="px-2 py-1 text-left font-semibold">Ngày bill</th>
                  <th className="px-2 py-1 text-left font-semibold">Chiều</th>
                  <th className="px-2 py-1 text-right font-semibold">Số tiền</th>
                  <th className="px-2 py-1 text-left font-semibold">Mã GD</th>
                  <th className="px-2 py-1 text-left font-semibold">Người gửi → nhận</th>
                  <th className="px-2 py-1 text-center font-semibold">Ghi nhận</th>
                </tr></thead>
                <tbody>
                  {d.bills.map((b: InvestorAdvanceBillItem) => (
                    <tr key={b.messageId} className={`border-t border-line/60 ${!b.recorded ? 'bg-danger/10' : b.lechTien !== 0 ? 'bg-amber-50' : 'odd:bg-white even:bg-slate-50/40'}`}>
                      <td className="px-2 py-1"><AnhBill attachmentId={b.attachmentId} onMoTo={setAnhTo} /></td>
                      <td className="whitespace-nowrap px-2 py-1 tabular-nums">{dmy(b.billDate)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-[10.5px] font-semibold text-slate-600">{b.kind === 'REPAYMENT' ? 'SigMa hoàn' : 'NĐT ứng'}</td>
                      <td className={`whitespace-nowrap px-2 py-1 text-right font-bold tabular-nums ${b.recorded ? 'text-brand' : 'text-danger'}`}>{fmtVnd(b.amount)}đ</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-slate-500">{b.ref ?? '—'}</td>
                      <td className="px-2 py-1">{b.senderName ?? '—'} → {b.receiverName ?? '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-center">
                        {!b.recorded
                          ? <span className="rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white">✕ CHƯA GHI</span>
                          : b.lechTien !== 0
                            ? <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white" title={`Dòng tạm ứng #${b.advanceId} đang ghi ${fmtVnd(b.amountRecorded ?? 0)}đ — lệch ${b.lechTien > 0 ? '+' : ''}${fmtVnd(b.lechTien)}đ so với bill`}>≠ LỆCH TIỀN</span>
                            : <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700" title={`Khớp dòng tạm ứng #${b.advanceId} theo ${b.matchedBy === 'HASH' ? 'ảnh' : b.matchedBy === 'REF' ? 'mã GD' : 'tiền + ngày'}`}>✓ đã ghi</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* [Admin Demo 17/9 "đào sâu fix lỗi"] BILL CK BỊ HỆ BỎ QUA — trước đây loại CÂM, không màn nào thấy. Không cộng
          vào tổng (chưa chắc là tạm ứng) nhưng PHẢI hiện để người thật phán xử: đa số là bill SigMa hoàn đại lý lọt
          nhóm, nhưng cũng có thể là tạm ứng thật chuyển vào TK SigMa chưa khai báo. */}
      {st.status === 'ready' && d && d.skipped.length > 0 && (
        <div className="mt-2" data-testid="bang-bill-bo-qua">
          <div className="mb-1 px-0.5 text-[10.5px] font-bold uppercase tracking-wide text-slate-400">
            Bill CK hệ BỎ QUA ({d.skipped.length}) — xem có phải tạm ứng bị sót không
          </div>
          <div className="overflow-x-auto rounded-lg border border-dashed border-slate-300">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr>
                <th className="px-2 py-1 text-left font-semibold">Lúc</th>
                <th className="px-2 py-1 text-right font-semibold">Số tiền</th>
                <th className="px-2 py-1 text-left font-semibold">Người gửi → nhận</th>
                <th className="px-2 py-1 text-left font-semibold">Lý do bỏ qua</th>
              </tr></thead>
              <tbody>
                {d.skipped.map((k) => (
                  <tr key={k.id} className="border-t border-line/60 bg-slate-50/60">
                    <td className="whitespace-nowrap px-2 py-1 tabular-nums text-slate-500">{new Date(k.createdAtIso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-bold tabular-nums text-slate-600">{k.amount == null ? '—' : `${fmtVnd(k.amount)}đ`}</td>
                    <td className="px-2 py-1 text-slate-600">{k.senderName ?? '—'} → {k.receiverName ?? '—'}</td>
                    <td className="px-2 py-1 text-[10.5px] font-semibold text-slate-500">{lyDoBoQua(k.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {anhTo && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 p-4" onClick={() => setAnhTo(null)}>
          <img src={anhTo} alt="Ảnh bill chuyển khoản (phóng to)" className="max-h-[90vh] max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}
