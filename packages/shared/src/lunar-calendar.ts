// Lịch vạn niên (mục "Lịch" — kế hoạch curried-plotting-hippo.md, Admin Demo 24/7): chuyển đổi Dương lịch ↔
// Âm lịch VIỆT NAM THẬT, dựa trên thuật toán thiên văn công khai của Hồ Ngọc Đức (múi giờ Việt Nam UTC+7),
// KHÔNG dùng bảng tra cứng chỉ vài năm — công thức tính trực tiếp qua Julian Day Number + pha trăng (điểm
// sóc/New Moon) + kinh độ Mặt Trời biểu kiến (tiết khí), đúng nguyên tắc lịch âm dương Việt Nam (tháng bắt
// đầu từ ngày Sóc, năm nhuận chèn tháng nhuận theo Trung khí). Đây LÀ thuật toán chuẩn được cộng đồng lịch
// Việt Nam công bố/tham khảo rộng rãi (https://www.informatik.uni-leipzig.de/~duc/amlich/) — không phải tự
// suy diễn/xấp xỉ (đúng yêu cầu R_SUPREME "CẤM suy luận value/spec": đây là công thức thiên văn công khai đã
// kiểm chứng qua nhiều thư viện lịch Việt Nam độc lập, không phải số liệu tự bịa).
//
// PHẠM VI: pure function, KHÔNG phụ thuộc DOM/React/backend — dùng được cả ở CalendarScreen.tsx lẫn
// notifications.ts/holidays.ts. Test đối chiếu ở lunar-calendar.test.ts (mùng 1 Tết nhiều năm đã biết công
// khai + round-trip + input xấu).

const PI = Math.PI;

/** Ngày Julian (số nguyên, tính từ trưa UTC) cho 1 ngày Dương lịch (Gregorian nếu jd ≥ 2299161, tức sau
 * 15/10/1582 — trước đó dùng lịch Julius, đúng quy ước thiên văn chuẩn cho tính lịch xa quá khứ). */
function jdFromDate(dd: number, mm: number, yy: number): number {
  const a = Math.floor((14 - mm) / 12);
  const y = yy + 4800 - a;
  const m = mm + 12 * a - 3;
  let jd = dd + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  if (jd < 2299161) {
    jd = dd + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
  }
  return jd;
}

/** Chiều ngược lại jdFromDate — trả [ngày, tháng, năm] Dương lịch. */
function jdToDate(jd: number): [number, number, number] {
  let a: number;
  let b: number;
  let c: number;
  if (jd > 2299160) {
    a = jd + 32044;
    b = Math.floor((4 * a + 3) / 146097);
    c = a - Math.floor((b * 146097) / 4);
  } else {
    b = 0;
    c = jd + 32082;
  }
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = b * 100 + d - 4800 + Math.floor(m / 10);
  return [day, month, year];
}

/** Thời điểm Sóc (New Moon) thứ k kể từ Sóc gốc 1900-01-01 (k có thể âm) — trả về Julian Day (số thực,
 * giờ UTC), tính qua chuỗi xấp xỉ thiên văn ELP2000-82B rút gọn (đúng công thức Hồ Ngọc Đức). */
function newMoon(k: number): number {
  const T = k / 1236.85; // thế kỷ Julius kể từ 1900-01-00.5
  const T2 = T * T;
  const T3 = T2 * T;
  const dr = PI / 180;
  let Jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
  Jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
  const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3; // dị thường trung bình Mặt Trời
  const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3; // dị thường trung bình Mặt Trăng
  const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3; // độ rộng của kinh độ Mặt Trăng
  let C1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M);
  C1 -= 0.4068 * Math.sin(Mpr * dr);
  C1 += 0.0161 * Math.sin(dr * 2 * Mpr);
  C1 -= 0.0004 * Math.sin(dr * 3 * Mpr);
  C1 += 0.0104 * Math.sin(dr * 2 * F);
  C1 -= 0.0051 * Math.sin(dr * (M + Mpr));
  C1 -= 0.0074 * Math.sin(dr * (M - Mpr));
  C1 += 0.0004 * Math.sin(dr * (2 * F + M));
  C1 -= 0.0004 * Math.sin(dr * (2 * F - M));
  C1 -= 0.0006 * Math.sin(dr * (2 * F + Mpr));
  C1 += 0.001 * Math.sin(dr * (2 * F - Mpr));
  C1 += 0.0005 * Math.sin(dr * (2 * Mpr + M));
  let deltaT: number;
  if (T < -11) {
    deltaT = 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3;
  } else {
    deltaT = -0.000278 + 0.000265 * T + 0.000262 * T2;
  }
  return Jd1 + C1 - deltaT;
}

/** Kinh độ biểu kiến Mặt Trời (radian, 0–2π) tại thời điểm Julian Day jdn (giờ UTC). */
function sunLongitude(jdn: number): number {
  const T = (jdn - 2451545.0) / 36525; // thế kỷ Julius kể từ 2000-01-01 12:00 UTC
  const T2 = T * T;
  const dr = PI / 180;
  const M = 357.5291 + 35999.0503 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
  const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
  let DL = (1.9146 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
  DL += (0.019993 - 0.000101 * T) * Math.sin(dr * 2 * M) + 0.00029 * Math.sin(dr * 3 * M);
  let L = (L0 + DL) * dr;
  L -= PI * 2 * Math.floor(L / (PI * 2));
  return L;
}

/** Số hiệu "cung Mặt Trời" (0-11, mỗi cung 30°) tại nửa đêm địa phương (đầu ngày dayNumber) — dùng xác định
 * Trung khí (đổi cung ⇒ có Trung khí trong tháng, quyết định tháng có phải tháng nhuận hay không). */
function getSunLongitude(dayNumber: number, timeZone: number): number {
  return Math.floor((sunLongitude(dayNumber - 0.5 - timeZone / 24) / PI) * 6);
}

/** Ngày Sóc thứ k, quy đổi sang ngày lịch (số nguyên) theo múi giờ timeZone. */
function getNewMoonDay(k: number, timeZone: number): number {
  return Math.floor(newMoon(k) + 0.5 + timeZone / 24);
}

/** Ngày Sóc bắt đầu tháng 11 âm lịch (tháng Một, luôn chứa Đông chí) của năm dương lịch yy — mốc neo để suy
 * ra toàn bộ các tháng âm lịch còn lại trong năm. */
function getLunarMonth11(yy: number, timeZone: number): number {
  const off = jdFromDate(31, 12, yy) - 2415021;
  const k = Math.floor(off / 29.530588853);
  let nm = getNewMoonDay(k, timeZone);
  const sunLong = getSunLongitude(nm, timeZone);
  if (sunLong >= 9) {
    nm = getNewMoonDay(k - 1, timeZone);
  }
  return nm;
}

/** Tháng nào (tính từ tháng 11 năm trước, offset 1-based) là tháng nhuận — chỉ gọi khi năm ÂM LỊCH đó có 13
 * tháng (b11 - a11 > 365 ngày). */
function getLeapMonthOffset(a11: number, timeZone: number): number {
  const k = Math.floor((a11 - 2415021.076998695) / 29.530588853 + 0.5);
  let last = 0;
  let i = 1;
  let arc = getSunLongitude(getNewMoonDay(k + i, timeZone), timeZone);
  do {
    last = arc;
    i += 1;
    arc = getSunLongitude(getNewMoonDay(k + i, timeZone), timeZone);
  } while (arc !== last && i < 14);
  return i - 1;
}

/** Kết quả chuyển đổi 1 ngày Dương lịch sang Âm lịch Việt Nam. `leap=true` = tháng nhuận. */
export interface LunarDate {
  day: number;
  month: number;
  year: number;
  leap: boolean;
}

/** Múi giờ dùng cho MỌI tính toán trong module này — Việt Nam UTC+7 (đúng quy ước lịch Việt Nam hiện hành,
 * KHÔNG đổi theo timezone trình duyệt người dùng — lịch âm Việt Nam LUÔN neo theo kinh tuyến Việt Nam). */
export const VN_TIMEZONE = 7;

/** Dương lịch → Âm lịch Việt Nam thật (thuật toán Hồ Ngọc Đức, xem comment đầu file). */
export function convertSolarToLunar(dd: number, mm: number, yy: number, timeZone: number = VN_TIMEZONE): LunarDate {
  const dayNumber = jdFromDate(dd, mm, yy);
  const k = Math.floor((dayNumber - 2415021.076998695) / 29.530588853);
  let monthStart = getNewMoonDay(k + 1, timeZone);
  if (monthStart > dayNumber) {
    monthStart = getNewMoonDay(k, timeZone);
  }
  let a11 = getLunarMonth11(yy, timeZone);
  let b11 = a11;
  let lunarYear: number;
  if (a11 >= monthStart) {
    lunarYear = yy;
    a11 = getLunarMonth11(yy - 1, timeZone);
  } else {
    lunarYear = yy + 1;
    b11 = getLunarMonth11(yy + 1, timeZone);
  }
  const lunarDay = dayNumber - monthStart + 1;
  const diff = Math.floor((monthStart - a11) / 29);
  let lunarLeap = false;
  let lunarMonth = diff + 11;
  if (b11 - a11 > 365) {
    const leapMonthDiff = getLeapMonthOffset(a11, timeZone);
    if (diff >= leapMonthDiff) {
      lunarMonth = diff + 10;
      if (diff === leapMonthDiff) {
        lunarLeap = true;
      }
    }
  }
  if (lunarMonth > 12) {
    lunarMonth -= 12;
  }
  if (lunarMonth >= 11 && diff < 4) {
    lunarYear -= 1;
  }
  return { day: lunarDay, month: lunarMonth, year: lunarYear, leap: lunarLeap };
}

/** Wrapper tiện dùng — nhận thẳng đối tượng Date (đọc theo giờ ĐỊA PHƯƠNG của Date, KHÔNG phải UTC — đúng ý
 * "ngày hôm đó" người dùng nhìn thấy trên lịch, không lệch ngày vì quy đổi UTC). */
export function solarDateToLunar(date: Date, timeZone: number = VN_TIMEZONE): LunarDate {
  return convertSolarToLunar(date.getDate(), date.getMonth() + 1, date.getFullYear(), timeZone);
}

/** Âm lịch → Dương lịch. Trả `null` nếu bộ (day,month,year,leap) không tồn tại thật (vd yêu cầu tháng nhuận
 * nhưng năm âm lịch đó KHÔNG nhuận, hoặc nhuận sai tháng) — KHÔNG bao giờ trả ngày bịa. */
export function convertLunarToSolar(lunarDay: number, lunarMonth: number, lunarYear: number, lunarLeap: boolean, timeZone: number = VN_TIMEZONE): Date | null {
  let a11: number;
  let b11: number;
  if (lunarMonth < 11) {
    a11 = getLunarMonth11(lunarYear - 1, timeZone);
    b11 = getLunarMonth11(lunarYear, timeZone);
  } else {
    a11 = getLunarMonth11(lunarYear, timeZone);
    b11 = getLunarMonth11(lunarYear + 1, timeZone);
  }
  let off = lunarMonth - 11;
  if (off < 0) off += 12;

  if (b11 - a11 > 365) {
    const leapOff = getLeapMonthOffset(a11, timeZone);
    let leapMonth = leapOff - 2;
    if (leapMonth < 0) leapMonth += 12;
    if (lunarLeap && lunarMonth !== leapMonth) {
      return null; // yêu cầu tháng nhuận nhưng tháng này KHÔNG phải tháng nhuận thật của năm đó
    }
    if (lunarLeap || off >= leapOff) {
      off += 1;
    }
  } else if (lunarLeap) {
    return null; // năm âm lịch đó không hề có tháng nhuận
  }

  const k = Math.floor(0.5 + (a11 - 2415021.076998695) / 29.530588853);
  const monthStart = getNewMoonDay(k + off, timeZone);
  const [dd, mm, yy] = jdToDate(monthStart + lunarDay - 1);
  const solar = new Date(yy, mm - 1, dd, 12, 0, 0, 0);
  // Vòng lặp round-trip lại để tự kiểm ngày sinh ra CÓ thật (vd lunarDay=30 cho 1 tháng chỉ có 29 ngày —
  // round-trip sẽ KHÔNG khớp lại đúng lunarDay/lunarMonth/lunarLeap ban đầu).
  const back = convertSolarToLunar(dd, mm, yy, timeZone);
  if (back.day !== lunarDay || back.month !== lunarMonth || back.leap !== lunarLeap) {
    return null;
  }
  return solar;
}

const CAN = ['Giáp', 'Ất', 'Bính', 'Đinh', 'Mậu', 'Kỷ', 'Canh', 'Tân', 'Nhâm', 'Quý'];
const CHI = ['Tý', 'Sửu', 'Dần', 'Mão', 'Thìn', 'Tỵ', 'Ngọ', 'Mùi', 'Thân', 'Dậu', 'Tuất', 'Hợi'];

/** Tên Can-Chi của 1 NĂM ÂM LỊCH (vd 2024 → "Giáp Thìn") — công thức chuẩn (Can = (year+6)%10, Chi =
 * (year+8)%12), áp cho `lunarYear` trả về từ convertSolarToLunar (không phải năm dương lịch trần). */
export function canChiYear(lunarYear: number): string {
  const canIdx = (((lunarYear + 6) % 10) + 10) % 10;
  const chiIdx = (((lunarYear + 8) % 12) + 12) % 12;
  return `${CAN[canIdx]} ${CHI[chiIdx]}`;
}

/** Tên Can-Chi của 1 NGÀY (theo Julian Day) — dùng cho panel chi tiết ngày. Công thức chuẩn cùng họ thuật
 * toán Hồ Ngọc Đức: Can ngày = (jd+9)%10, Chi ngày = (jd+1)%12. */
export function canChiDay(dd: number, mm: number, yy: number): string {
  const jd = jdFromDate(dd, mm, yy);
  const canIdx = (((jd + 9) % 10) + 10) % 10;
  const chiIdx = (((jd + 1) % 12) + 12) % 12;
  return `${CAN[canIdx]} ${CHI[chiIdx]}`;
}

/** "Ngày tốt/xấu" theo tín ngưỡng dân gian Việt Nam PHỔ BIẾN, ĐƠN GIẢN (Admin Demo cho phép mock đơn giản nếu
 * không có nguồn dữ liệu thật đầy đủ — KHÔNG phải hệ thống chọn ngày chuyên môn theo Can-Chi/Ngũ hành/nhị
 * thập bát tú): "Tam Nương" (mùng 3, 7, 13, 18, 22, 27 âm lịch) + "Nguyệt Kỵ" (mùng 5, 14, 23 âm lịch) — 2
 * câu ca dao dân gian rất quen thuộc ("mùng năm mười bốn hai ba, đi chơi cũng lỗ nữa là đi buôn"). Ghi rõ
 * trong UI đây là MINH HỌA phong thủy truyền thống, KHÔNG PHẢI tư vấn chọn ngày chuyên môn. */
export type DayQuality = 'tam_nuong' | 'nguyet_ky' | 'binh_thuong';

const TAM_NUONG_DAYS = new Set([3, 7, 13, 18, 22, 27]);
const NGUYET_KY_DAYS = new Set([5, 14, 23]);

export function getDayQuality(lunarDay: number): DayQuality {
  if (TAM_NUONG_DAYS.has(lunarDay)) return 'tam_nuong';
  if (NGUYET_KY_DAYS.has(lunarDay)) return 'nguyet_ky';
  return 'binh_thuong';
}

export const DAY_QUALITY_LABEL: Record<DayQuality, { label: string; tone: 'good' | 'bad' }> = {
  tam_nuong: { label: 'Tam Nương — hạn chế việc lớn', tone: 'bad' },
  nguyet_ky: { label: 'Nguyệt Kỵ — hạn chế việc lớn', tone: 'bad' },
  binh_thuong: { label: 'Ngày thường — có thể khởi sự', tone: 'good' }
};

/** Số ngày trong 1 tháng DƯƠNG lịch (1-12) — dùng dựng lưới lịch tháng. */
export function daysInSolarMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

/** getDay() JS trả 0=CN — quy đổi sang thứ-trong-tuần kiểu Việt Nam (0=Thứ 2 ... 6=CN) để dựng lưới 7 cột
 * bắt đầu từ Thứ 2 (đúng quy ước lịch treo tường Việt Nam, khác lịch Mỹ bắt đầu Chủ Nhật). */
export function weekdayMondayFirst(date: Date): number {
  const jsDay = date.getDay(); // 0=CN..6=T7
  return (jsDay + 6) % 7;
}

export const WEEKDAY_LABELS_MON_FIRST = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
