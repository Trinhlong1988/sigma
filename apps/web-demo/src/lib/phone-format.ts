// VIỆC #4 (6/8, Admin Demo) — chọn MÃ VÙNG QUỐC GIA cho ô nhập SĐT, mặc định +84 (Việt Nam), chuẩn hoá E.164.
//
// Đây là TẦNG LOGIC THUẦN (không DOM/React) dùng chung bởi:
//   - components/CountryCodePhoneInput.tsx (UI dropdown cờ + ô nhập số → xuất E.164 + trạng thái hợp lệ)
//   - screens/OtpScreen.tsx (ô SĐT bước đăng ký) và screens/ProfileScreen.tsx (thêm/đổi SĐT)
//   - screens/LoginScreen.tsx (đăng nhập bằng SĐT — phoneLoginCandidates, xem chú thích ở dưới)
//
// Dùng `libphonenumber-js/min` (metadata rút gọn — đủ để parse/format E.164 + kiểm độ dài hợp lệ, nhẹ hơn
// bản /max cho web/APK) theo đúng gợi ý brief. Cờ quốc gia hiển thị bằng CSS sprite `flag-icons` (KHÔNG dùng
// emoji cờ — Windows/EXE KHÔNG render emoji cờ, xem memory reference_brand_studio + main.tsx import CSS).
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode
} from 'libphonenumber-js/min';

export type { CountryCode };

// Mặc định Việt Nam theo yêu cầu Admin Demo ("mặc định +84 (Việt Nam)").
export const DEFAULT_COUNTRY: CountryCode = 'VN';

export interface CountryOption {
  iso2: CountryCode; // 'VN' — cũng là lớp cờ flag-icons `fi fi-vn` (lowercase)
  dialCode: string; // '84' (KHÔNG kèm dấu +)
  name: string; // tên tiếng Việt (Intl.DisplayNames 'vi'), fallback mã ISO
}

// Nhóm nước phổ biến đưa lên ĐẦU danh sách (VN đầu tiên) — phần còn lại xếp theo tên tiếng Việt A→Z.
const POPULAR: CountryCode[] = [
  'VN', 'US', 'GB', 'AU', 'CA', 'JP', 'KR', 'CN', 'SG', 'TH',
  'KH', 'LA', 'MY', 'PH', 'ID', 'IN', 'FR', 'DE', 'RU', 'TW', 'HK'
];

// Tên quốc gia tiếng Việt qua Intl.DisplayNames (ICU đầy đủ có sẵn ở trình duyệt/WebView/Electron/Node ≥ 13).
// Bọc try/catch: nếu môi trường thiếu dữ liệu vùng → fallback mã ISO (KHÔNG ném lỗi làm hỏng dựng danh sách).
let regionNames: Intl.DisplayNames | null = null;
try {
  regionNames = new Intl.DisplayNames(['vi'], { type: 'region' });
} catch {
  regionNames = null;
}

function countryName(iso: CountryCode): string {
  if (!regionNames) return iso;
  try {
    return regionNames.of(iso) ?? iso;
  } catch {
    return iso;
  }
}

function toOption(iso: CountryCode): CountryOption {
  return { iso2: iso, dialCode: getCountryCallingCode(iso), name: countryName(iso) };
}

function buildCountries(): CountryOption[] {
  const all = getCountries();
  const allSet = new Set(all);
  const popular = POPULAR.filter((c) => allSet.has(c)).map(toOption);
  const popularSet = new Set(popular.map((o) => o.iso2));
  const rest = all
    .filter((c) => !popularSet.has(c))
    .map(toOption)
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return [...popular, ...rest];
}

// Danh sách quốc gia (đủ mọi mã libphonenumber cấp) — popular trước, còn lại A→Z tiếng Việt.
export const COUNTRIES: CountryOption[] = buildCountries();

export function findCountry(iso: CountryCode): CountryOption | undefined {
  return COUNTRIES.find((c) => c.iso2 === iso);
}

/** Chuẩn hoá (quốc gia + số nội địa người dùng gõ) → chuỗi E.164 ('+84912345678') hoặc null nếu rỗng/không
 * parse được. Chỉ giữ chữ số ở phần số nội địa trước khi parse (bỏ khoảng trắng/gạch/ngoặc người dùng gõ). */
export function toE164(country: CountryCode, nationalNumber: string): string | null {
  const digits = (nationalNumber || '').replace(/\D/g, '');
  if (!digits) return null;
  const pn = parsePhoneNumberFromString(digits, country);
  if (!pn) return null;
  return pn.number; // luôn là E.164
}

/** SĐT (quốc gia + số nội địa) có hợp lệ không (đúng độ dài/khuôn theo metadata min). Rỗng → false. */
export function isValidPhone(country: CountryCode, nationalNumber: string): boolean {
  const digits = (nationalNumber || '').replace(/\D/g, '');
  if (!digits) return false;
  const pn = parsePhoneNumberFromString(digits, country);
  return !!pn && pn.isValid();
}

/** Tách 1 giá trị đã lưu (E.164 '+84...' HOẶC dạng nội địa cũ '0912...') thành {country, nationalNumber} để
 * nạp vào editor. Không parse được → trả fallbackCountry + chuỗi rỗng (an toàn cho UI seed). */
export function splitPhone(
  value: string | null | undefined,
  fallbackCountry: CountryCode = DEFAULT_COUNTRY
): { country: CountryCode; nationalNumber: string } {
  const raw = (value ?? '').trim();
  if (!raw) return { country: fallbackCountry, nationalNumber: '' };
  const pn = parsePhoneNumberFromString(raw, fallbackCountry);
  if (pn && pn.country) {
    return { country: pn.country, nationalNumber: pn.nationalNumber };
  }
  // Không nhận diện được quốc gia (vd chuỗi lạ) — giữ số thô (chỉ chữ số) dưới quốc gia fallback.
  return { country: fallbackCountry, nationalNumber: raw.replace(/\D/g, '') };
}

// Nhận diện chuỗi "trông giống SĐT" ở màn đăng nhập (không phải email): tùy chọn dấu +, bắt đầu bằng chữ số,
// tổng ≥ 8 ký tự số/ngăn cách. Dùng để quyết định có đi nhánh tra-SĐT hay báo "nhập email/SĐT hợp lệ".
export const PHONE_LIKE_RE = /^\+?[0-9][0-9\s.\-()]{7,}$/;

/** ĐĂNG NHẬP BẰNG SĐT — sinh danh sách chuỗi ứng viên để thử khớp CHÍNH XÁC với Agent.phone qua
 * GET /v1/auth/resolve-phone (server so khớp EXACT sau khi bỏ khoảng trắng — routes/auth.ts, KHÔNG đổi server).
 *
 * BỐI CẢNH TƯƠNG THÍCH (quan trọng): tài khoản CŨ lưu SĐT theo dạng người dùng tự gõ ('0912345678'); tài khoản
 * MỚI (sau việc #4) lưu E.164 ('+84912345678'). Server chỉ so khớp CHÍNH XÁC 1 chuỗi. Để KHÔNG phá luồng
 * đăng-nhập-bằng-SĐT cho CẢ hai lớp tài khoản mà KHÔNG đụng server/DB, client thử nhiều dạng ứng viên:
 *   1) chuỗi người dùng gõ (đã trim/bỏ khoảng trắng) — khớp tài khoản CŨ dạng '0912...'
 *   2) dạng E.164 ('+84912...') — khớp tài khoản MỚI
 *   3) dạng nội địa 0-đầu ('0' + số nội địa, chỉ VN) — phòng trường hợp người dùng gõ E.164 mà tài khoản cũ
 * Loại trùng, giữ THỨ TỰ ưu tiên (dạng gõ trước để tài khoản cũ khớp sớm, giảm số lần gọi server). */
export function phoneLoginCandidates(raw: string): string[] {
  const trimmed = (raw || '').trim().replace(/\s/g, '');
  const out: string[] = [];
  const add = (v: string | null | undefined): void => {
    if (v && !out.includes(v)) out.push(v);
  };
  if (!trimmed) return out;
  add(trimmed);
  const pn = parsePhoneNumberFromString(trimmed, DEFAULT_COUNTRY);
  if (pn) {
    add(pn.number); // E.164
    if (pn.country === 'VN') add('0' + pn.nationalNumber); // dạng nội địa VN
  }
  return out;
}
