// Ô CHỌN MÁY POS — gõ để tìm, danh sách hiện dạng BẢNG CÓ CỘT, dòng so le theo brand.
//
// Admin Demo 16/11: "có gợi ý tìm kiếm để tìm máy POS khi gán" + "danh sách máy POS khó phân biệt, chia bảng,
// cột ngay ngắn, mỗi dòng 1 màu theo brand". <select>/<datalist> KHÔNG kẻ cột được (chỉ 1 dòng chữ dài dính
// nhau) ⇒ phải tự dựng danh sách. Dựng tối giản: input + panel bảng, bấm ra ngoài thì đóng.
import { useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { HopNoi } from './HopNoi.js';
import { nenDong } from './BangChuan.js';

export interface MayPos {
  serial: string;
  dongMay: string | null;   // chủng loại (A920, D210…)
  app: string | null;       // app ngân hàng đã cài (MB, MBV…) — null = máy trắng
  kho: string | null;       // kho đang chứa
}

const O_NHAP = 'w-full rounded-md border border-line px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand';

/** Bỏ dấu + hạ chữ thường để tìm "a920" ra "A920", "minh huy" ra "MINH HUY". */
function chuan(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

export function PosPicker({
  items,
  value,
  onChange,
  disabled,
  placeholder = 'Gõ serial / dòng máy / app để tìm…'
}: {
  items: MayPos[];
  /** serial đang chọn ('' = chưa chọn) */
  value: string;
  onChange: (serial: string) => void;
  disabled?: boolean;
  placeholder?: string;
}): JSX.Element {
  const [mo, setMo] = useState(false);
  const [tuKhoa, setTuKhoa] = useState('');
  const boc = useRef<HTMLDivElement>(null);

  const loc = useMemo(() => {
    const k = chuan(tuKhoa);
    const ds = k
      ? items.filter((m) => chuan(`${m.serial} ${m.dongMay ?? ''} ${m.app ?? ''} ${m.kho ?? ''}`).includes(k))
      : items;
    return ds.slice(0, 200); // trần hiển thị — gõ thêm để thu hẹp (nêu rõ ở chân danh sách)
  }, [items, tuKhoa]);

  const dangChon = items.find((m) => m.serial === value);

  return (
    <div className="relative" ref={boc}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className={O_NHAP + ' pl-8'}
          value={mo ? tuKhoa : dangChon ? `${dangChon.serial}${dangChon.dongMay ? ' · ' + dangChon.dongMay : ''}` : ''}
          placeholder={placeholder}
          disabled={disabled}
          data-kiem="o-chon-may-pos"
          onFocus={() => { setMo(true); setTuKhoa(''); }}
          onChange={(e) => { setTuKhoa(e.target.value); setMo(true); }}
        />
      </div>
      {/* Danh sách vẽ NGOÀI hộp thoại (HopNoi) — đặt trong hộp thì khung `overflow-auto` của Modal cắt cụt. */}
      <HopNoi neoRef={boc} mo={mo && !disabled} onDong={() => setMo(false)}>
        <div>
          <div>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-200 text-slate-700">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">SERIAL</th>
                  <th className="px-3 py-2 text-left font-semibold">DÒNG MÁY</th>
                  <th className="px-3 py-2 text-center font-semibold">APP</th>
                  <th className="px-3 py-2 text-left font-semibold">KHO</th>
                </tr>
              </thead>
              <tbody>
                {loc.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-500">Không có máy nào khớp.</td></tr>
                )}
                {loc.map((m, i) => (
                  <tr
                    key={m.serial}
                    // Dòng SO LE theo BẢNG CHUẨN (nenDong) — y hệt các bảng khác; dòng đang chọn tô vàng.
                    className={(m.serial === value ? 'bg-amber-100 ' : nenDong(i) + ' ') + 'cursor-pointer hover:bg-brand-tint'}
                    onMouseDown={(e) => { e.preventDefault(); onChange(m.serial); setMo(false); }}
                  >
                    <td className="px-3 py-2 font-mono font-semibold text-slate-700">
                      {m.serial === value && <Check className="mr-1 inline h-3.5 w-3.5 text-brand" />}
                      {m.serial}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{m.dongMay ?? '—'}</td>
                    <td className="px-3 py-2 text-center">
                      {m.app
                        ? <span className="rounded-full bg-brand-tint/60 px-2 py-0.5 font-semibold text-brand">{m.app}</span>
                        : <span className="text-slate-400">Máy trắng</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{m.kho ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
            {loc.length} / {items.length} máy{items.length > loc.length ? ' — gõ thêm để thu hẹp' : ''}
          </div>
        </div>
      </HopNoi>
    </div>
  );
}
