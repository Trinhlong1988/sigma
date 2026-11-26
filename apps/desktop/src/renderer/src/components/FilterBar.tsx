import { useEffect, useRef, type ReactNode } from 'react';
import { Search, FilterX, RefreshCw } from 'lucide-react';
import { inputCls } from './Field.js';
import { Button } from './Button.js';
import { MultiSelect } from './MultiSelect.js';

/** Một ô lọc CHỌN NHIỀU (checkbox trong dropdown). */
export interface MultiFilter {
  key: string;
  nhan: string;
  value: string[];
  options: { value: string; label: string }[];
  onChange: (v: string[]) => void;
  mauTheoGiaTri?: Record<string, string>;
  khiRong?: string;
  rong?: string;
}
/** Một ô ĐIỀN SỐ để lọc (vd số lô / số hóa đơn). */
export interface SoFilter {
  key: string;
  nhan: string;
  value: string;
  onChange: (v: string) => void;
  rong?: string;
}
/** Một ô TÍCH đơn (vd "Chỉ lô đóng 95"). */
export interface TichFilter {
  key: string;
  nhan: string;
  value: boolean;
  onChange: (v: boolean) => void;
  mauChu?: string;
  title?: string;
}
/**
 * [24/11 — Admin Demo chốt thứ tự thanh lọc Doanh Số] MỘT mảng TRỘN thứ tự các loại ô lọc để TRANG
 * tự chốt thứ tự hiển thị (vd chen Số lô / Số HĐ vào GIỮA các dropdown). Khi truyền `items`,
 * FilterBar render CHÍNH NÓ theo đúng thứ tự mảng; các màn cũ (không truyền `items`) vẫn dùng
 * `multiSelects` / `oSo` / `oTich` như trước — hành vi KHÔNG đổi.
 */
export type FilterItem =
  | ({ loai: 'multi' } & MultiFilter)
  | ({ loai: 'so' } & SoFilter)
  | ({ loai: 'tich' } & TichFilter);

/** A dropdown dimension (đại lý, ngân hàng, trạng thái, vai trò…). */
export interface FilterSelect {
  key: string;
  placeholder: string; // e.g. "Tất cả trạng thái"
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

/**
 * Reusable filter bar (R_UX_FILTER): text search + từ ngày → đến ngày + N dimension selects
 * + Lọc + Xóa lọc. All filtering is server-side — this only collects params.
 */
export function FilterBar({
  search,
  onSearch,
  searchPlaceholder = 'Tìm kiếm…',
  fromDate,
  toDate,
  onFromDate,
  onToDate,
  selects = [],
  multiSelects = [],
  oSo = [],
  oTich = [],
  items = [],
  onApply,
  onReset,
  onRefresh,
  extraActions,
  hideReset,
  hideRefresh,
  hideApply,
  locPhai,
  coChuNho,
  debounceMs = 300
}: {
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder?: string;
  fromDate?: string;
  toDate?: string;
  onFromDate?: (v: string) => void;
  onToDate?: (v: string) => void;
  selects?: FilterSelect[];
  /** Ô lọc CHỌN NHIỀU (checkbox trong dropdown) — optional, render TRƯỚC các select đơn. */
  multiSelects?: { key: string; nhan: string; value: string[]; options: { value: string; label: string }[]; onChange: (v: string[]) => void; mauTheoGiaTri?: Record<string, string>; khiRong?: string; rong?: string }[];
  /** Ô ĐIỀN SỐ để lọc (Admin Demo 6/11): gõ số là lọc ngay, KHÔNG dropdown. Dùng cho số lô / số hóa đơn —
   *  2 trường này có hàng trăm giá trị nên dropdown vừa dài vừa chậm chọn. */
  oSo?: { key: string; nhan: string; value: string; onChange: (v: string) => void; rong?: string }[];
  /** Ô TÍCH đơn để lọc nhanh 1 điều kiện (vd "Chỉ lô đóng 95") — cũng thay cho dropdown 2 lựa chọn. */
  oTich?: { key: string; nhan: string; value: boolean; onChange: (v: boolean) => void; mauChu?: string; title?: string }[];
  /** [24/11] Mảng TRỘN thứ tự (multi/so/tich). Khi có, render theo đúng thứ tự mảng (xem type FilterItem). */
  items?: FilterItem[];
  onApply: () => void;
  onReset: () => void;
  /** Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc). Mặc định = onApply (re-query với filter hiện tại). */
  onRefresh?: () => void;
  /** Nút thao tác RIÊNG của trang, xếp CÙNG HÀNG sau Lọc/Xóa lọc/Làm mới (vd "Xóa đã chọn").
   *  Optional — màn không truyền thì thanh lọc giữ nguyên như cũ. */
  extraActions?: ReactNode;
  /** Ẩn nút "Xóa lọc"/"Làm mới" khi TRANG tự đặt 2 nút đó ở thanh công cụ trên (optional, mặc định hiện). */
  /** Giảm cỡ chữ ô lọc 2px (optional) — màn nhiều ô lọc cần gọn. */
  coChuNho?: boolean;
  /** Đẩy nút "Lọc" sang MÉP PHẢI hàng lọc (optional). */
  locPhai?: boolean;
  hideReset?: boolean;
  hideRefresh?: boolean;
  /** Độ trễ (ms) lọc realtime khi gõ ô tìm kiếm. 0 = tắt debounce (chỉ lọc khi Enter/bấm Lọc). */
  debounceMs?: number;
  /** [B202 19/11 — Admin Demo "bỏ nút lọc giả đi"] ẨN nút "Lọc". Dùng cho màn LỌC NGAY KHI ĐỔI Ô: ở đó
   *  `onApply` rỗng nên nút chỉ là đồ trang trí — bấm không làm gì, đúng loại NÚT GIẢ đã cấm (B181). */
  hideApply?: boolean;
}): JSX.Element {
  const showDates = !!onFromDate && !!onToDate;

  // Lọc realtime: gõ xong ~debounceMs mà không gõ tiếp → tự gọi onApply (không gọi mỗi ký tự).
  // Dùng ref để luôn gọi onApply mới nhất (đọc state hiện tại của trang) mà không cần thêm vào deps.
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleSearch = (v: string): void => {
    onSearch(v);
    if (debounceMs <= 0) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onApplyRef.current(), debounceMs);
  };
  return (
    // [B202 19/11 — Admin Demo "cho xuống dòng luôn"] TRƯỚC: `flex-nowrap` ⇒ màn hẹp thì thanh lọc dài hơn khung,
    // các ô hai đầu bị CẮT MẤT (đo 1366px: ô ngày chỉ còn "026", nút Lọc chạm đúng mép 1366 không còn lề).
    // NAY: cho xuống dòng, không ô nào bị cắt ở bất kỳ bề ngang nào.
    <div className={(coChuNho ? 'mb-1 ' : 'mb-2 ') + 'flex flex-wrap items-center gap-1.5'}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (timerRef.current) clearTimeout(timerRef.current);
              onApply();
            }
          }}
          placeholder={searchPlaceholder}
          className={inputCls + ' w-44 pl-8' + (coChuNho ? ' !py-1.5 text-xs' : '')}
        />
      </div>

      {showDates && (
        <div className="flex items-center gap-1 text-sm text-slate-500">
          <span className="text-xs">Từ</span>
          <input type="date" className={inputCls} value={fromDate ?? ''} onChange={(e) => onFromDate!(e.target.value)} />
          <span className="text-xs">đến</span>
          <input type="date" className={inputCls} value={toDate ?? ''} onChange={(e) => onToDate!(e.target.value)} />
        </div>
      )}

      {/* [24/11] Mảng TRỘN thứ tự: render đúng thứ tự TRANG khai, cho phép chen ô số vào giữa dropdown. */}
      {items.map((it) => {
        if (it.loai === 'so') {
          return (
            <input
              key={it.key}
              value={it.value}
              inputMode="numeric"
              onChange={(e) => it.onChange(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={it.nhan}
              title={it.nhan + ' — gõ số là lọc ngay'}
              className={inputCls + ' text-center tabular-nums ' + (it.rong ?? 'w-[88px]') + (coChuNho ? ' !py-1.5 text-xs' : '')}
            />
          );
        }
        if (it.loai === 'tich') {
          return (
            <label
              key={it.key}
              title={it.title ?? it.nhan}
              className={
                'flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2 ' +
                (coChuNho ? 'text-xs ' : 'text-sm ') +
                (it.value ? 'border-danger/50 bg-red-50 font-semibold ' + (it.mauChu ?? 'text-danger') : 'border-line bg-white text-slate-600')
              }
            >
              <input type="checkbox" className="accent-danger" checked={it.value} onChange={(e) => it.onChange(e.target.checked)} />
              {it.nhan}
            </label>
          );
        }
        return (
          <MultiSelect key={it.key} khoa={it.key} khiRong={it.khiRong} rong={it.rong} value={it.value} onChange={it.onChange} options={it.options} nhan={it.nhan} mauTheoGiaTri={it.mauTheoGiaTri} coChuNho={coChuNho} />
        );
      })}

      {oSo.map((o) => (
        <input
          key={o.key}
          value={o.value}
          inputMode="numeric"
          onChange={(e) => o.onChange(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder={o.nhan}
          title={o.nhan + ' — gõ số là lọc ngay'}
          className={inputCls + ' text-center tabular-nums ' + (o.rong ?? 'w-[88px]') + (coChuNho ? ' !py-1.5 text-xs' : '')}
        />
      ))}

      {oTich.map((o) => (
        <label
          key={o.key}
          title={o.title ?? o.nhan}
          className={
            'flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2 ' +
            (coChuNho ? 'text-xs ' : 'text-sm ') +
            (o.value ? 'border-danger/50 bg-red-50 font-semibold ' + (o.mauChu ?? 'text-danger') : 'border-line bg-white text-slate-600')
          }
        >
          <input type="checkbox" className="accent-danger" checked={o.value} onChange={(e) => o.onChange(e.target.checked)} />
          {o.nhan}
        </label>
      ))}

      {multiSelects.map((m) => (
        <MultiSelect key={m.key} khoa={m.key} khiRong={m.khiRong} rong={m.rong} value={m.value} onChange={m.onChange} options={m.options} nhan={m.nhan} mauTheoGiaTri={m.mauTheoGiaTri} coChuNho={coChuNho} />
      ))}

      {selects.map((s) => (
        <select key={s.key} className={inputCls + (coChuNho ? ' text-xs' : '')} value={s.value} onChange={(e) => s.onChange(e.target.value)}>
          <option value="">{s.placeholder}</option>
          {s.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ))}

      {locPhai && <div className="flex-1" />}
      {!hideApply && <Button variant="confirm" data-nut="loc" onClick={onApply}>Lọc</Button>}
      {!hideReset && (
        <Button variant="soft" data-nut="xoaloc" onClick={onReset} title="Xóa toàn bộ bộ lọc, đưa về mặc định" icon={<FilterX className="h-4 w-4" />}>
          Xóa lọc
        </Button>
      )}
      {!hideRefresh && (
        <Button variant="soft" data-nut="lammoi" onClick={onRefresh ?? onApply} title="Tải lại dữ liệu mới nhất (giữ nguyên bộ lọc)" icon={<RefreshCw className="h-4 w-4" />}>
          Làm mới
        </Button>
      )}
      {extraActions}
    </div>
  );
}
