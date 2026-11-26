import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { inputCls } from './Field.js';

export interface SearchSelectOption {
  value: string;
  label: string;
}

/**
 * Ô CHỌN CÓ TÌM KIẾM (combobox thuần React, không thư viện ngoài).
 * - Gõ 1–2–3 ký tự → lọc gợi ý theo `label.includes(query)`, ưu tiên `startsWith` lên đầu.
 * - Chọn 1 dòng → set value + hiện label đã chọn; nút ✕ để xóa lựa chọn.
 * - Style đồng bộ `inputCls` (Catppuccin/hiện có). Dùng cho Ngân hàng / HKD / TID.
 *
 * [PHÍM TẮT 24/11] 3 prop TÙY CHỌN (mặc định undefined → KHÔNG đổi hành vi chỗ dùng cũ):
 *   • leading(value)  — node đứng TRƯỚC label trong danh sách + ô đã chọn (logo loại thẻ).
 *   • badgeOf(value)  — node nhỏ đứng SAU label (badge phím số đã gán cho người hoàn).
 *   • digitMap        — { '0'..'9' → value }: khi dropdown MỞ và ô tìm RỖNG, bấm phím số = chọn đúng
 *                       option đã map (bất kể vị trí). Gõ số vào ô tìm (query khác rỗng) thì số vào ô tìm.
 */
export function SearchSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  leading,
  badgeOf,
  digitMap
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  leading?: (value: string) => ReactNode;
  badgeOf?: (value: string) => ReactNode;
  digitMap?: Record<string, string>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // [B263 24/11 — Admin Demo "phần chọn người hoàn sổ xuống dưới làm tràn phải cuộn, để cho xổ NỔI LÊN TRÊN"]
  // Ô nằm gần đáy bảng nhập bill thì danh sách xổ XUỐNG bị tràn khỏi khung, người dùng phải cuộn mới
  // thấy. Nay ĐO chỗ trống thật: dưới không đủ mà trên rộng hơn thì xổ NGƯỢC LÊN.
  const [xoLen, setXoLen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setXoLen(false); return; }
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const CAO_HOP = 232; // max-h-56 (224px) + lề
    const duoi = window.innerHeight - r.bottom;
    setXoLen(duoi < CAO_HOP && r.top > duoi);
  }, [open, query]);

  const selectedLabel = useMemo(() => options.find((o) => o.value === value)?.label ?? '', [options, value]);

  // Đóng dropdown khi bấm ra ngoài.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent): void {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options
      .filter((o) => o.label.toLowerCase().includes(q))
      .sort((a, b) => {
        const as = a.label.toLowerCase().startsWith(q) ? 0 : 1;
        const bs = b.label.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs; // ưu tiên khớp đầu chuỗi; giữ thứ tự gốc trong cùng nhóm
      });
  }, [options, query]);

  function pick(v: string): void {
    onChange(v);
    setOpen(false);
    setQuery('');
  }

  // [PHÍM TẮT 24/11] Phím số chọn người hoàn — CHỈ khi dropdown MỞ + ô tìm RỖNG (chống nuốt số đang gõ lọc).
  // Dùng listener gắn CHÍNH Ô INPUT (context-scoped, KHÔNG global) + nhả khi đóng. Không modifier mới bắt.
  useEffect(() => {
    if (!open || !digitMap || Object.keys(digitMap).length === 0) return;
    const inp = boxRef.current?.querySelector<HTMLInputElement>('input[data-kiem="searchselect-input"]');
    if (!inp) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (query.trim() !== '') return; // đang gõ lọc → để số vào ô tìm
      const v = digitMap[e.key];
      if (v == null) return;
      e.preventDefault();
      e.stopPropagation();
      pick(v);
    };
    inp.addEventListener('keydown', onKey);
    return () => inp.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, digitMap, query]);

  const leadSel = !open && value && leading ? leading(value) : null;

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        {/* Khi ĐÃ CHỌN + có logo (loại thẻ) hiện logo bên trái thay kính lúp; còn lại giữ kính lúp. */}
        {leadSel ? (
          <span className="pointer-events-none absolute left-2 top-1/2 flex -translate-y-1/2 items-center">{leadSel}</span>
        ) : (
          <svg viewBox="0 0 20 20" className={'pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 ' + (disabled ? 'text-slate-300' : 'text-slate-400')} fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="9" cy="9" r="6" /><path d="M14 14l3.5 3.5" strokeLinecap="round" />
          </svg>
        )}
        <input
          data-kiem="searchselect-input"
          className={inputCls + ' w-full pr-8' + (leadSel ? ' pl-11' : ' pl-9') + (disabled ? ' cursor-not-allowed bg-slate-50 text-slate-400' : '')}
          value={open ? query : selectedLabel}
          placeholder={disabled ? placeholder : (placeholder ? placeholder + ' — gõ để tìm' : 'Gõ để tìm…')}
          disabled={disabled}
          onFocus={() => { if (!disabled) { setOpen(true); setQuery(''); } }}
          onClick={() => { if (!disabled && !open) { setOpen(true); setQuery(''); } }}
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
        />
        {value && !disabled ? (
          <button
            type="button"
            title="Xóa lựa chọn"
            tabIndex={-1}
            onMouseDown={(e) => { e.preventDefault(); pick(''); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}><path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" /></svg>
          </button>
        ) : (
          !disabled && <svg viewBox="0 0 20 20" className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2}><path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        )}
      </div>
      {open && (
        <ul
          data-kiem={xoLen ? 'so-len' : 'so-xuong'}
          className={'absolute z-30 max-h-56 w-full overflow-auto rounded-md border border-line bg-white py-1 shadow-lg '
            + (xoLen ? 'bottom-full mb-1' : 'mt-1')}
        >
          {filtered.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">Không có kết quả phù hợp.</li>}
          {/* [B219 20/11 — Admin Demo "1 dòng xanh 1 dòng trắng khi sổ lọc ra như brand"] dải xen kẽ theo thứ tự
              dòng ĐANG HIỆN (sau khi gõ lọc), không theo thứ tự gốc. Dòng đang chọn vẫn đậm hơn dải nền. */}
          {filtered.map((o, i) => {
            const lead = leading ? leading(o.value) : null;
            const badge = badgeOf ? badgeOf(o.value) : null;
            return (
              <li
                key={o.value}
                onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}
                className={
                  // ĐO 20/11: độ mờ 30% làm dải ra rgb(250,252,253) — không phân biệt nổi với nền trắng.
                  // Dải = NGUYÊN brand-tint; di chuột/đang chọn đậm hơn hẳn để không chìm vào dải.
                  'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition hover:bg-brand/25 hover:text-brand ' +
                  (o.value === value ? 'bg-brand/35 font-medium text-brand' : i % 2 === 1 ? 'bg-brand-tint text-slate-700' : 'text-slate-700')
                }
              >
                {lead && <span className="shrink-0">{lead}</span>}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {badge && <span className="shrink-0">{badge}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
