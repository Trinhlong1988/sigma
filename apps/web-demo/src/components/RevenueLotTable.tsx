// BẢNG CHIA CỘT "chi tiết theo lô" kiểu Excel (Admin Demo 2/9) — CẤU HÌNH CỘT qua prop `columns`:
//   • NĐT (InvestorDetailLots, 4/9): GIỐNG đại lý — HKD · Bank · TID · Lô · Ngày · Giờ · Trước phí · % phí cài ·
//     Tiền về · % lợi nhuận (BỎ cột NĐT/Đại lý — đã mặc định NĐT). Bộ cột cũ INVESTOR_COLUMNS chỉ còn cho XLS cũ.
//   • ĐẠI LÝ (RoomRevenueScreen, Admin Demo 2/9 "phòng đại lý sao lại có NĐT"): KHÔNG NĐT/Đại lý mà là
//     Tên HKD · Ngân hàng · TID · Số lô · Ngày · Giờ · Trước phí · % phí · Sau phí (phải hoàn).
// Mỗi hàng ZEBRA (xen kẽ màu) + HOVER = ĐẬM NỀN nhẹ (Admin Demo 7/9: bỏ nhấc/phóng/đổ-bóng vì di chuột nháy nhảy khó
// chịu — chỉ nổi nhẹ đậm màu). Dùng grid theo hàng (không <table>) để zebra + click-cả-hàng áp đúng từng hàng.
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { bankColor } from '../lib/bank-visual';
import { COLUMN_META, INVESTOR_COLUMNS, cellText, ymdToDmy, type RevenueLotColumnKey, type RevenueLotRow } from '../lib/revenue-lot-xls';

function fmtVnd(n: number): string {
  return Math.round(n).toLocaleString('vi-VN');
}
function dash(s: string): string {
  return s && s.trim() !== '' ? s : '—';
}

export interface RevenueLotTableProps {
  rows: RevenueLotRow[];
  /** Bộ cột (mặc định NĐT). Báo cáo đại lý truyền AGENT_COLUMNS. */
  columns?: RevenueLotColumnKey[];
  /** Cột thao tác cuối hàng (vd nút "Sửa thẻ" cho đại lý). Có → thêm 1 cột. */
  renderAction?: (row: RevenueLotRow, index: number) => ReactNode;
  /** [Admin Demo 7/9] Click cả HÀNG → mở lại review sửa full OCR (gate mật khẩu ở màn cha). Có → hàng thành nút bấm. */
  onRowClick?: (row: RevenueLotRow, index: number) => void;
  /** [Admin Demo 8/9 — báo cáo folder] DÒNG GHI CHÚ dưới hàng, TRẢI HẾT chiều ngang (lỗi của lô: gate ngày/lô/máy).
   *  Trả null/undefined = hàng sạch, không thêm gì (không chiếm chỗ). */
  renderRowNote?: (row: RevenueLotRow, index: number) => ReactNode;
  /** Bề rộng cột thao tác (mặc định 84px — đủ 1 nút "Sửa thẻ"). */
  actionWidth?: string;
  /** [Admin Demo 9/9 — LỐI TẮT TỪ LOG] Lô cần TÔ SÁNG + tự cuộn tới (đến từ ?tid=&lo= khi bấm cảnh báo trên log). */
  highlight?: { tid: string; lo: string } | null;
  /** Nhãn override cho cột tiền trước/sau (vd "Tiền về (sau phí)", "Phải hoàn (sau phí)"). */
  labelTruoc?: string;
  labelSau?: string;
  /** [Admin Demo 21/9] Cột GHI CHÚ sửa được: có handler → ô input, blur lưu (pos_lot_recon.note — đồng nhất mọi
   *  bảng lô). Không có → hiện text tĩnh. Chỉ hàng có loId mới sửa được. */
  onNoteSave?: (loId: number, note: string) => void;
}

/** Track chiều rộng nhỏ nhất theo màn hình để bảng không quá hẹp (giữ cuộn ngang). */
function minWidthPx(columns: RevenueLotColumnKey[], hasAction: boolean): number {
  // xấp xỉ theo xlsWidth nhưng tối thiểu để đọc được; +84 cho cột thao tác.
  // [Admin Demo 17/9 "căn chỉnh màn này không tràn ko cuộn"] Bề rộng tối thiểu phải tính theo MIN THẬT của track grid
  // (minmax/px), KHÔNG theo xlsWidth (bề rộng cột EXCEL — luôn to hơn) — lấy xlsWidth làm bảng đòi rộng oan rồi sinh
  // cuộn ngang dù các cột hoàn toàn co được.
  const base = columns.reduce((s, k) => {
    const g = COLUMN_META[k].grid;
    const m = /minmax\((\d+)px/.exec(g) ?? /^(\d+)px$/.exec(g);
    return s + (m ? Number(m[1]) : 64) + 8; // +8 = gap-x-1.5
  }, 0);
  return Math.max(480, base);
}

export function RevenueLotTable({ rows, columns = INVESTOR_COLUMNS, renderAction, onRowClick, renderRowNote, actionWidth = '84px', highlight, labelTruoc, labelSau, onNoteSave }: RevenueLotTableProps): JSX.Element {
  const hlRef = useRef<HTMLDivElement | null>(null);
  // Cuộn tới lô được chỉ đích (1 lần khi có) — lối tắt từ log phải NHÌN THẤY ngay, không bắt người dùng tự dò.
  useEffect(() => { const el = hlRef.current; if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [highlight?.tid, highlight?.lo, rows.length]);
  const gridTracks = columns.map((k) => COLUMN_META[k].grid).join(' ');
  const grid = renderAction ? `${gridTracks} ${actionWidth}` : gridTracks;
  if (rows.length === 0) {
    return <p className="py-6 text-center text-xs text-slate-400">Không có lô nào trong kỳ.</p>;
  }
  const totalTruoc = rows.reduce((s, r) => s + r.truoc, 0);
  const totalSau = rows.reduce((s, r) => s + r.sau, 0);
  const headerLabel = (k: RevenueLotColumnKey): string =>
    k === 'truoc' && labelTruoc ? labelTruoc : k === 'sau' && labelSau ? labelSau : COLUMN_META[k].header;
  const alignClass = (k: RevenueLotColumnKey): string =>
    COLUMN_META[k].align === 'right' ? 'text-right' : COLUMN_META[k].align === 'center' ? 'text-center' : '';

  return (
    // overflow-x-auto: bảng rộng cuộn NGANG trong khung riêng, KHÔNG đẩy tràn trang (mobile).
    <div className="overflow-x-auto rounded-lg-mac border border-line bg-white">
      <div style={{ minWidth: minWidthPx(columns, !!renderAction) }}>
        {/* HÀNG TIÊU ĐỀ — brand. */}
        <div
          className="grid items-center gap-x-1.5 border-b border-line bg-brand/10 px-2.5 py-2 text-[12px] font-bold uppercase tracking-wide text-brand"
          style={{ gridTemplateColumns: grid }}
        >
          {columns.map((k) => (
            /* min-w-0: nhãn dài như "PHẢI HOÀN (SAU PHÍ)" không được ĐẨY track rộng ra (sinh cuộn ngang) — cho
               xuống dòng trong ô thay vì nong bảng. */
            <span key={k} className={`min-w-0 leading-tight ${alignClass(k)}`}>{headerLabel(k)}</span>
          ))}
          {renderAction && <span className="text-center">Sửa</span>}
        </div>
        {/* THÂN — zebra + hover-3D. */}
        <div>
          {rows.map((r, i) => {
            const bc = bankColor(r.bankName) ?? '#334155';
            const note = renderRowNote?.(r, i);
            const laHl = !!highlight && String(r.tid) === String(highlight.tid) && String(r.lo) === String(highlight.lo);
            return (
              <div
                key={`${r.tid}-${r.lo}-${i}`}
                ref={laHl ? hlRef : undefined}
                // [10/9] Mốc cho harness đọc ĐÚNG thứ tự lô hiển thị (trước đây harness dò chuỗi "· Lô N" của
                // layout thẻ cũ → đổi sang bảng là dò trượt mà KHÔNG ai biết). Không ảnh hưởng giao diện.
                data-testid="lot-row"
                data-lo={r.lo ?? ''}
                data-tid={r.tid ?? ''}
                onClick={onRowClick ? () => onRowClick(r, i) : undefined}
                title={onRowClick ? 'Bấm để mở review sửa thông tin bill (cần mật khẩu)' : undefined}
                className={
                  // [Admin Demo 7/9] BỎ hover nhấc/phóng/đổ-bóng (nháy nhảy khó chịu) → chỉ ĐẬM NỀN nhẹ (transition màu).
                  'group relative grid items-center gap-x-1.5 border-b border-line/70 px-2.5 py-2 text-[13px] text-slate-700 ' +
                  'transition-colors duration-150 ease-out ' +
                  (onRowClick ? 'cursor-pointer ' : '') +
                  (laHl ? 'ring-2 ring-inset ring-brand bg-brand/[0.12] ' : i % 2 === 0 ? 'bg-white hover:bg-brand/[0.06]' : 'bg-slate-50 hover:bg-brand/[0.08]')
                }
                style={{ gridTemplateColumns: grid }}
              >
                {columns.map((k) => renderCell(k, r, i, bc, onNoteSave))}
                {/* [Admin Demo 17/9 "không tràn không cuộn"] min-w-0: ô lưới mặc định là min-width:auto nên chip/nút
                    nowrap bên trong ĐẨY TRACK rộng ra quá bề rộng đã đặt ⇒ sinh cuộn ngang. Khoá lại + cho wrap. */}
                {renderAction && <span className="flex min-w-0 flex-wrap justify-center" onClick={(e) => e.stopPropagation()}>{renderAction(r, i)}</span>}
                {/* GHI CHÚ hàng (lỗi của lô) — TRẢI HẾT chiều ngang để đọc được, không nhét vào cột hẹp. */}
                {note && <span className="mt-1" style={{ gridColumn: '1 / -1' }} onClick={(e) => e.stopPropagation()}>{note}</span>}
              </div>
            );
          })}
        </div>
        {/* HÀNG TỔNG — nhãn "TỔNG · N lô" SPAN các cột đầu (tới cột tiền đầu tiên) để không bị cắt; cột money hiện tổng. */}
        {(() => {
          const firstMoney = Math.max(1, columns.findIndex((k) => COLUMN_META[k].kind === 'money'));
          return (
            <div
              className="grid items-center gap-x-1.5 border-t-2 border-brand/30 bg-brand/5 px-2.5 py-2 text-[13px] font-bold text-slate-700"
              style={{ gridTemplateColumns: grid }}
            >
              <span className="truncate text-slate-500" style={{ gridColumn: `span ${firstMoney}` }}>TỔNG · {rows.length} lô</span>
              {columns.slice(firstMoney).map((k) => {
                if (k === 'truoc') return <span key={k} className="text-right text-[16px] tabular-nums text-slate-800">{fmtVnd(totalTruoc)}</span>;
                if (k === 'sau') return <span key={k} className="text-right text-[16px] tabular-nums text-brand">{fmtVnd(totalSau)}</span>;
                return <span key={k} />;
              })}
              {renderAction && <span />}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/** 1 ô THÂN theo cột. money/pct căn phải; tid+bank tô màu ngân hàng; các cột chữ truncate + title. */
function renderCell(k: RevenueLotColumnKey, r: RevenueLotRow, i: number, bc: string, onNoteSave?: (loId: number, note: string) => void): JSX.Element {
  switch (k) {
    case 'stt':
      return <span key={k} className="text-center tabular-nums text-slate-400">{i + 1}</span>;
    case 'ndt':
      return <span key={k} className="truncate font-medium" title={r.ndt}>{dash(r.ndt)}</span>;
    case 'daiLy':
      return <span key={k} className="truncate font-medium" title={r.daiLy}>{dash(r.daiLy)}</span>;
    case 'hkd':
      // [Admin Demo 7/9] Lô MƯỢN TID → badge "Mượn của <chủ TID>" (doanh số về đại lý NÀY dù TID của người khác).
      return (
        <span key={k} className="flex min-w-0 flex-col gap-0.5" title={r.borrowed ? `MƯỢN TID của ${r.tidOwnerName ?? '?'}` : r.hkdName}>
          <span className="truncate font-medium">{dash(r.hkdName ?? '')}</span>
          {r.borrowed && (
            <span className="inline-flex w-fit items-center gap-0.5 rounded bg-amber-100 px-1 py-px text-[9px] font-bold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              🔗 Mượn của {r.tidOwnerName ?? '?'}
            </span>
          )}
        </span>
      );
    case 'bank':
      return <span key={k} className="truncate text-center font-semibold" style={{ color: bc }} title={r.bankName}>{dash(r.bankName ?? '')}</span>;
    case 'tid':
      return <span key={k} className="truncate text-center font-semibold tabular-nums" style={{ color: bc }} title={r.tid}>{dash(r.tid)}</span>;
    case 'lo':
      return <span key={k} className="truncate text-center tabular-nums" title={r.lo}>{dash(r.lo)}</span>;
    case 'ghiChu':
      // [Admin Demo 21/9] GHI CHÚ per-lô — sửa tại chỗ (blur lưu), nguồn pos_lot_recon.note dùng chung ĐL/NĐT/hoàn tiền.
      return onNoteSave && r.loId != null
        ? <input key={`${k}-${r.loId}-${r.note ?? ''}`} data-testid="o-ghi-chu" defaultValue={r.note ?? ''}
            placeholder="ghi chú…" title={r.note ?? 'Ghi chú lô (bấm để nhập)'}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (r.note ?? '')) onNoteSave(Number(r.loId), v); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-full min-w-0 rounded border border-line bg-white/70 px-1 py-0.5 text-[11px] text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-brand/40" />
        : <span key={k} className="truncate text-[11px] text-slate-600" title={r.note ?? ''}>{dash(r.note ?? '')}</span>;
    case 'maYc':
      // [Admin Demo 17/9] Mã yêu cầu hoàn gộp nhiều lô — chip gọn, 1 dòng; lô chưa gộp để "—" cho bảng sạch.
      return r.maYc
        ? <span key={k} className="truncate text-center" title={`Yêu cầu hoàn ${r.maYc}`}>
            <span className="whitespace-nowrap rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] font-extrabold text-brand">{r.maYc}</span>
          </span>
        : <span key={k} className="text-center text-slate-300">—</span>;
    case 'date':
      return <span key={k} className="text-center tabular-nums">{ymdToDmy(r.date)}</span>;
    case 'time':
      return <span key={k} className="text-center tabular-nums text-slate-500">{dash(r.time)}</span>;
    case 'pct':
      return <span key={k} className="text-right tabular-nums text-slate-500">{cellText('pct', r, i)}</span>;
    case 'truoc':
      return <span key={k} className="text-right text-[16px] font-bold tabular-nums text-slate-800">{fmtVnd(r.truoc)}</span>;
    case 'sau':
      return <span key={k} className="text-right text-[16px] font-bold tabular-nums text-brand">{fmtVnd(r.sau)}</span>;
    case 'laiTien':
      return <span key={k} className="text-right tabular-nums font-bold text-success">{fmtVnd(r.lai ?? 0)}</span>;
    case 'loiNhuan':
      return <span key={k} className="text-right tabular-nums font-semibold text-success">{cellText('loiNhuan', r, i)}</span>;
  }
}
