// VIỆC #4 (6/8, Admin Demo) — ô nhập SĐT có CHỌN MÃ VÙNG QUỐC GIA. Mặc định +84 (Việt Nam), cờ nước (flag-icons
// CSS sprite — KHÔNG emoji cờ vì Windows/EXE không render), xuất giá trị E.164 + trạng thái hợp lệ.
//
// Dùng chung cho: đăng ký (OtpScreen bước 'profile') + ProfileScreen (thêm/đổi SĐT). Logic thuần tách sang
// lib/phone-format.ts (đã có unit test). Component này chỉ lo phần UI/tương tác (dropdown + tìm kiếm).
//
// Style theo brand hiện hành: cùng khung `rounded-xl border border-line bg-white` + focus ring brand như
// components/Field.tsx `inputCls`, KHÔNG dùng nút raw bg-brand/gradient (tránh vi phạm GATE ĐỒNG NHẤT UI — đây
// là control kiểu <select>, cùng nhóm allowlist với ô select giới tính đã có).
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';
import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  findCountry,
  isValidPhone,
  splitPhone,
  toE164,
  type CountryCode
} from '../lib/phone-format';

export interface PhoneChangeMeta {
  valid: boolean;
  country: CountryCode;
  nationalNumber: string;
}

interface Props {
  /** Giá trị E.164 ban đầu (hoặc dạng cũ '0912...'/rỗng) để nạp editor. Chỉ dùng SEED lúc mount. */
  value?: string | null;
  /** Emit MỖI lần đổi số/quốc gia: e164 = '' nếu rỗng, kèm meta {valid,country,nationalNumber}. */
  onChange: (e164: string, meta: PhoneChangeMeta) => void;
  defaultCountry?: CountryCode;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

function flagClass(iso: CountryCode): string {
  return `fi fi-${iso.toLowerCase()}`;
}

export function CountryCodePhoneInput({
  value,
  onChange,
  defaultCountry = DEFAULT_COUNTRY,
  placeholder = 'Số điện thoại',
  disabled = false,
  autoFocus = false
}: Props): JSX.Element {
  // SEED 1 lần từ `value` (controlled-ish): quốc gia + số nội địa là nguồn thật nội bộ sau khi mount, emit E.164
  // lên trên. KHÔNG phản chiếu lại `value` mỗi render để tránh nhảy con trỏ khi gõ.
  const seed = useMemo(() => splitPhone(value ?? '', defaultCountry), [/* seed once */]); // eslint-disable-line react-hooks/exhaustive-deps
  const [country, setCountry] = useState<CountryCode>(seed.country);
  const [national, setNational] = useState<string>(seed.nationalNumber);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selected = findCountry(country) ?? findCountry(defaultCountry) ?? COUNTRIES[0];

  // Đóng dropdown khi click ra ngoài.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  // Tự focus ô tìm kiếm khi mở dropdown.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  function emit(nextCountry: CountryCode, nextNational: string): void {
    const e164 = toE164(nextCountry, nextNational);
    onChange(e164 ?? '', {
      valid: isValidPhone(nextCountry, nextNational),
      country: nextCountry,
      nationalNumber: nextNational.replace(/\D/g, '')
    });
  }

  function handleNationalChange(raw: string): void {
    // Chỉ cho chữ số + vài ký tự ngăn cách người dùng hay gõ; chuẩn hoá E.164 xử lý phần còn lại.
    const cleaned = raw.replace(/[^\d\s.\-()]/g, '');
    setNational(cleaned);
    emit(country, cleaned);
  }

  function handleSelectCountry(iso: CountryCode): void {
    setCountry(iso);
    setOpen(false);
    setQuery('');
    emit(iso, national);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    // Bỏ dấu tiếng Việt nhẹ để tìm "viet" ra "Việt Nam"; khớp cả tên, mã ISO, mã gọi.
    const noDiacritics = (s: string): string =>
      s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const qn = noDiacritics(q);
    return COUNTRIES.filter(
      (c) =>
        noDiacritics(c.name).includes(qn) ||
        c.iso2.toLowerCase().includes(q) ||
        c.dialCode.includes(q.replace(/^\+/, ''))
    );
  }, [query]);

  return (
    <div ref={rootRef} className="relative">
      <div
        className={
          'flex items-stretch rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)] ' +
          'transition focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20 ' +
          (disabled ? 'opacity-60' : '')
        }
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="flex shrink-0 items-center gap-1.5 rounded-l-xl border-r border-line px-3 py-2.5 text-sm text-slate-800 outline-none hover:bg-appbg disabled:cursor-not-allowed"
          aria-label="Chọn mã vùng quốc gia"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className={flagClass(selected.iso2)} style={{ width: '1.25rem', height: '0.9375rem', borderRadius: 2 }} />
          <span className="tabular-nums text-slate-700">+{selected.dialCode}</span>
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </button>
        <input
          value={national}
          onChange={(e) => handleNationalChange(e.target.value)}
          placeholder={placeholder}
          inputMode="tel"
          autoComplete="tel"
          disabled={disabled}
          autoFocus={autoFocus}
          className="w-full min-w-0 rounded-r-xl bg-transparent px-3 py-2.5 text-sm text-slate-800 outline-none placeholder:text-slate-400"
        />
      </div>

      {open && (
        <div
          className="absolute left-0 z-30 mt-1 w-full min-w-[16rem] overflow-hidden rounded-xl border border-line bg-white shadow-lg"
          role="listbox"
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm quốc gia hoặc mã (+84, Việt Nam...)"
              className="w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-sm text-slate-400">Không tìm thấy quốc gia phù hợp.</div>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.iso2}
                  type="button"
                  onClick={() => handleSelectCountry(c.iso2)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-slate-800 hover:bg-appbg"
                  role="option"
                  aria-selected={c.iso2 === country}
                >
                  <span className={flagClass(c.iso2)} style={{ width: '1.25rem', height: '0.9375rem', borderRadius: 2 }} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">+{c.dialCode}</span>
                  {c.iso2 === country && <Check className="h-4 w-4 shrink-0 text-brand" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
