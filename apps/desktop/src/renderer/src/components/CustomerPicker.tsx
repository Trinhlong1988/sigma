// Ô CHỌN KHÁCH HÀNG — gõ để tìm, danh sách xổ ra là BẢNG 2 CỘT (MÃ KHÁCH | TÊN KHÁCH), dòng so le theo brand.
//
// Admin Demo 15-16/11: "sắp xếp theo mã khách từ nhỏ đến lớn, thêm gợi ý tìm kiếm, không phân biệt hoa thường"
// → "bảng tên khách khi giao TID mở lên bị KHUẤT xuống dưới" → "mã khách 1 cột, tên khách 1 cột, mỗi dòng 1 màu".
//
// 2 bài học nằm trong file này:
//  1) BỎ `<datalist>`: trình duyệt tự vẽ, KHÔNG kẻ cột được và KHÔNG điều khiển được chỗ nó bung ra.
//  2) Danh sách tự dựng mà đặt `absolute` trong hộp thoại thì bị khung `overflow-auto` của Modal CẮT CỤT ⇒ phải
//     vẽ ra ngoài bằng `HopNoi` (portal + toạ độ fixed + tự lật lên khi dưới hết chỗ).
import { useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import type { CustomerDto } from '../../../preload/index.d';
import { HopNoi } from './HopNoi.js';
import { nenDong } from './BangChuan.js';

/** So MÃ khách theo kiểu người đọc: phần số so theo GIÁ TRỊ (KH2 < KH10), phần chữ so theo bảng chữ cái. */
function soSanhMa(a: string, b: string): number {
  return a.localeCompare(b, 'vi', { numeric: true, sensitivity: 'base' });
}

/** Bỏ dấu + hạ chữ thường — gõ "truong" ra "Trường", gõ "KH1" hay "kh1" đều ra. */
function chuan(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

export function tenKhach(c: CustomerDto): string {
  return c.nickname || c.fullName || '';
}

/** Nhãn 1 dòng (dùng khi chỉ có chỗ cho 1 dòng chữ, vd ô đang đóng). */
export function nhanKhach(c: CustomerDto): string {
  const ten = tenKhach(c);
  return c.code ? `${c.code} · ${ten}` : ten;
}

const O_NHAP = 'w-full rounded-md border border-line px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand';

export function CustomerPicker({
  customers,
  value,
  onChange,
  placeholder = 'Gõ mã hoặc tên khách…',
  disabled
}: {
  customers: CustomerDto[];
  /** id khách đang chọn, dạng chuỗi ('' = chưa chọn) — giữ nguyên kiểu của <select> cũ để thay thế 1-1. */
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
}): JSX.Element {
  const [mo, setMo] = useState(false);
  const [tuKhoa, setTuKhoa] = useState('');
  const oRef = useRef<HTMLDivElement>(null);

  const dsSapXep = useMemo(() => [...customers].sort((a, b) => soSanhMa(a.code ?? '', b.code ?? '')), [customers]);
  const loc = useMemo(() => {
    const k = chuan(tuKhoa);
    const ds = k ? dsSapXep.filter((c) => chuan(`${c.code ?? ''} ${tenKhach(c)}`).includes(k)) : dsSapXep;
    return ds.slice(0, 300); // trần hiển thị — gõ thêm để thu hẹp (ghi rõ ở chân danh sách)
  }, [dsSapXep, tuKhoa]);

  const dangChon = dsSapXep.find((c) => String(c.id) === value);

  return (
    <div className="relative" ref={oRef}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        className={O_NHAP + ' pl-8'}
        value={mo ? tuKhoa : dangChon ? nhanKhach(dangChon) : ''}
        placeholder={placeholder}
        disabled={disabled}
        data-kiem="o-chon-khach"
        onFocus={() => { setMo(true); setTuKhoa(''); }}
        onChange={(e) => { setTuKhoa(e.target.value); setMo(true); }}
      />
      <HopNoi neoRef={oRef} mo={mo && !disabled} onDong={() => setMo(false)}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-200 text-slate-700">
            <tr>
              <th className="w-[110px] px-3 py-2 text-left font-semibold">MÃ KHÁCH</th>
              <th className="px-3 py-2 text-left font-semibold">TÊN KHÁCH HÀNG</th>
            </tr>
          </thead>
          <tbody>
            {loc.length === 0 && (
              <tr><td colSpan={2} className="px-3 py-6 text-center text-slate-500">Không có khách nào khớp.</td></tr>
            )}
            {loc.map((c, i) => (
              <tr
                key={c.id}
                className={(String(c.id) === value ? 'bg-amber-100 ' : nenDong(i) + ' ') + 'cursor-pointer hover:bg-brand-tint'}
                onMouseDown={(e) => { e.preventDefault(); onChange(String(c.id)); setMo(false); }}
              >
                <td className="px-3 py-2 font-mono font-semibold text-slate-700">
                  {String(c.id) === value && <Check className="mr-1 inline h-3.5 w-3.5 text-brand" />}
                  {c.code ?? '—'}
                </td>
                <td className="px-3 py-2 text-slate-700">{tenKhach(c) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-line bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
          {loc.length} / {dsSapXep.length} khách{dsSapXep.length > loc.length ? ' — gõ thêm để thu hẹp' : ''}
        </div>
      </HopNoi>
    </div>
  );
}
