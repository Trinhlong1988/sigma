import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import { inputCls } from './Field.js';

/**
 * Ô lọc CHỌN NHIỀU (Admin Demo 6/11) — dropdown có ô tìm + checkbox từng dòng, bỏ tích được, "Chọn tất cả"
 * và "Bỏ chọn". Dùng cho đại lý / TID / HKD / ngân hàng ở màn Doanh Số; viết chung ở components để màn
 * khác tái dùng được (KHÔNG chép lại mỗi nơi một bản).
 *  value = [] nghĩa là KHÔNG lọc (hiện "Tất cả …").
 */
export function MultiSelect({
  value,
  onChange,
  options,
  nhan,
  mauTheoGiaTri,
  coChuNho,
  khoa,
  khiRong,
  rong
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options: { value: string; label: string }[];
  /** Nhãn khi chưa chọn gì, vd "Tất cả đại lý". */
  nhan: string;
  /** Màu chữ riêng cho từng giá trị (optional), vd { '95': 'text-danger' }. */
  mauTheoGiaTri?: Record<string, string>;
  coChuNho?: boolean;
  /** [B251 22/11] Câu giải thích khi danh sách RỖNG (vd "chưa tải được danh mục NĐT: 403").
   *  Ô lọc rỗng mà không nói gì là người dùng đứng hình — không biết lỗi hay thật sự không có. */
  khiRong?: string;
  /** Khóa nhận dạng ô lọc để cổng tự kiểm bám vào (data-loc) — nhãn nút ĐỔI theo lựa chọn nên
   *  cổng không thể tìm theo chữ trên nút (đã cắn 22/11: chọn "NĐT 1" xong là tìm theo "NĐT" trượt). */
  khoa?: string;
  /** [B253 22/11 — Admin Demo "dãn rộng ô lọc ra"] Bề ngang nút lọc (mặc định w-[118px] — tên NĐT dài
   *  như "Hòa Linh Đàm" bị cắt cụt). Truyền lớp Tailwind, vd 'w-[190px]'. */
  rong?: string;
}): JSX.Element {
  const [mo, setMo] = useState(false);
  const [tim, setTim] = useState('');
  const hopRef = useRef<HTMLDivElement>(null);
  const bangRef = useRef<HTMLDivElement>(null);
  // [B254 22/11 — Admin Demo "KO THẤY DANH SÁCH"] Hộp xổ phải VẼ RA NGOÀI cây DOM của thanh lọc.
  // GỐC: thanh lọc nằm trong khung `overflow-x-auto` (để 10 ô lọc không làm tràn trang). Khung cuộn
  // CẮT luôn phần tử `absolute` bên trong theo CHIỀU DỌC ⇒ danh sách VẪN CÓ trong DOM (cổng đọc DOM
  // thấy đủ, báo xanh) nhưng MẮT KHÔNG THẤY — đúng ảnh Admin Demo gửi 22/11.
  // Cách sửa: dựng hộp bằng portal ra <body> + `position: fixed` theo toạ độ nút.
  const [viTri, setViTri] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!mo) { setViTri(null); return undefined; }
    const tinh = (): void => {
      const el = hopRef.current?.querySelector('button');
      if (!el) return;
      const r = el.getBoundingClientRect();
      const rongHop = rong ? 320 : 256; // w-80 / w-64
      // Không để hộp tràn mép phải màn hình.
      const left = Math.max(8, Math.min(r.left, window.innerWidth - rongHop - 8));
      setViTri({ top: r.bottom + 4, left, width: rongHop });
    };
    tinh();
    window.addEventListener('scroll', tinh, true);
    window.addEventListener('resize', tinh);
    return () => {
      window.removeEventListener('scroll', tinh, true);
      window.removeEventListener('resize', tinh);
    };
  }, [mo, rong]);

  useEffect(() => {
    if (!mo) return;
    function ngoai(e: MouseEvent): void {
      const trongNut = hopRef.current?.contains(e.target as Node);
      const trongHop = bangRef.current?.contains(e.target as Node);
      if (!trongNut && !trongHop) {
        setMo(false);
        setTim('');
      }
    }
    document.addEventListener('mousedown', ngoai);
    return () => document.removeEventListener('mousedown', ngoai);
  }, [mo]);

  const loc = useMemo(() => {
    const q = tim.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, tim]);

  const doi = (v: string): void => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const chu = coChuNho ? ' text-xs' : '';

  return (
    <div className="relative" ref={hopRef} data-loc={khoa}>
      <button
        type="button"
        onClick={() => setMo((x) => !x)}
        className={inputCls + chu + ' flex items-center gap-1 px-2 text-left ' + (rong ?? 'w-[118px]') + (coChuNho ? ' !py-1.5' : '')}
        title={value.length ? value.map((v) => options.find((o) => o.value === v)?.label ?? v).join(', ') : nhan}
      >
        <span className={'flex-1 truncate ' + (value.length ? 'font-medium ' + (value.length === 1 ? mauTheoGiaTri?.[value[0]] ?? 'text-brand' : 'text-brand') : 'text-slate-500')}>
          {value.length === 0 ? nhan : value.length === 1 ? options.find((o) => o.value === value[0])?.label ?? value[0] : nhan.replace('Tất cả ', '') + ': ' + value.length}
        </span>
        {value.length > 0 && (
          <span
            role="button"
            aria-label="Bỏ chọn"
            title="Bỏ chọn tất cả"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-danger"
          >
            <X className="h-3 w-3" />
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      </button>

      {mo && viTri && createPortal(
        <div
          ref={bangRef}
          data-loc-hop={khoa}
          style={{ position: 'fixed', top: viTri.top, left: viTri.left, width: viTri.width }}
          className="z-[200] rounded-lg border border-line bg-white p-1.5 shadow-xl"
        >
          <input
            autoFocus
            value={tim}
            onChange={(e) => setTim(e.target.value)}
            placeholder="Gõ để tìm…"
            className={inputCls + ' mb-1 w-full !py-1 text-xs'}
          />
          <div className="flex items-center gap-2 border-b border-line px-1 pb-1 text-[11px]">
            <button type="button" className="text-brand hover:underline" onClick={() => onChange(loc.map((o) => o.value))}>
              Chọn tất cả{tim ? ' (đang lọc)' : ''}
            </button>
            <button type="button" className="text-danger hover:underline" onClick={() => onChange([])}>
              Bỏ chọn
            </button>
            <span className="ml-auto text-slate-400">{value.length} đã chọn</span>
          </div>
          <div className="max-h-56 overflow-auto py-1">
            {loc.length === 0 && (
              <p data-kiem="loc-rong" className="px-2 py-2 text-center text-xs text-slate-500">
                {options.length === 0 ? (khiRong ?? 'Danh sách trống.') : 'Không có mục nào khớp.'}
              </p>
            )}
            {/* [B219 20/11 — Admin Demo "1 dòng xanh 1 dòng trắng khi sổ lọc ra như brand để dễ nhìn"]
                Dải xen kẽ theo thứ tự dòng ĐANG HIỆN (sau khi lọc), KHÔNG theo thứ tự gốc — nếu theo gốc thì
                gõ tìm xong dải nhảy loạn. Dòng ĐÃ CHỌN vẫn đậm hơn để phân biệt với dải nền. */}
            {loc.map((o, i) => {
              const on = value.includes(o.value);
              const soc = i % 2 === 1; // dòng chẵn trắng, dòng lẻ xanh nhạt
              return (
                <button
                  type="button"
                  key={o.value}
                  onClick={() => doi(o.value)}
                  className={
                    // ĐO 20/11: `bg-brand-tint/30` ra rgb(250,252,253) — chênh nền trắng 2-3/255, MẮT KHÔNG THẤY.
                    // Dùng NGUYÊN brand-tint (#eaf4fb) cho dải, và di chuột/đã chọn phải ĐẬM HƠN dải thì mới
                    // phân biệt được, nếu không di chuột vào dòng xanh sẽ không thấy đổi gì.
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-brand/25 ' +
                    (on ? 'bg-brand/35 font-medium' : soc ? 'bg-brand-tint' : '')
                  }
                >
                  <span className={'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ' + (on ? 'border-brand bg-brand text-white' : 'border-slate-300')}>
                    {on && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className={'truncate ' + (mauTheoGiaTri?.[o.value] ?? '')}>{o.label}</span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
