// Ngày lễ/Tết (mục "Lịch" — kế hoạch curried-plotting-hippo.md, Admin Demo 24/7): danh sách lễ CỐ ĐỊNH Dương
// lịch + lễ tính theo Âm lịch (dùng lunar-calendar.ts thật, KHÔNG bảng tra cứng theo năm). Đây là danh sách
// ngày lễ/Tết PHỔ BIẾN, công khai rộng rãi ở Việt Nam — KHÔNG suy đoán, đúng lịch nghỉ lễ nhà nước + lễ dân
// gian quen thuộc mọi người biết.
import { convertSolarToLunar, daysInSolarMonth, solarDateToLunar } from './lunar-calendar';

export interface HolidayHit {
  name: string;
  emoji: string;
  /** true = 1 trong 3 ngày Tết Nguyên Đán (mùng 1/2/3) — CalendarScreen tô đậm khác biệt (đỏ-vàng nổi bật
   * nhất trên toàn lịch, đúng yêu cầu "ngày Tết kèm thông báo chúc mừng"). */
  isTet: boolean;
  greeting: string;
}

interface SolarHolidayDef {
  dd: number;
  mm: number;
  name: string;
  emoji: string;
  greeting: string;
}

const SOLAR_HOLIDAYS: SolarHolidayDef[] = [
  { dd: 1, mm: 1, name: 'Tết Dương lịch', emoji: '🎉', greeting: 'Chúc mừng năm mới! Chúc bạn và gia đình một năm an khang, thịnh vượng!' },
  { dd: 8, mm: 3, name: 'Quốc tế Phụ nữ', emoji: '🌷', greeting: 'Chúc mừng ngày Quốc tế Phụ nữ 8/3 — chúc luôn xinh đẹp, hạnh phúc!' },
  { dd: 30, mm: 4, name: 'Giải phóng miền Nam', emoji: '🇻🇳', greeting: 'Chào mừng ngày Giải phóng miền Nam, thống nhất đất nước 30/4!' },
  { dd: 1, mm: 5, name: 'Quốc tế Lao động', emoji: '🛠️', greeting: 'Chúc mừng ngày Quốc tế Lao động 1/5 — chúc một kỳ nghỉ trọn vẹn!' },
  { dd: 1, mm: 6, name: 'Quốc tế Thiếu nhi', emoji: '🎈', greeting: 'Chúc mừng ngày Quốc tế Thiếu nhi 1/6!' },
  { dd: 2, mm: 9, name: 'Quốc khánh', emoji: '🇻🇳', greeting: 'Chào mừng Quốc khánh 2/9 — chúc mừng ngày Tết Độc lập!' },
  { dd: 20, mm: 10, name: 'Phụ nữ Việt Nam', emoji: '🌸', greeting: 'Chúc mừng ngày Phụ nữ Việt Nam 20/10!' },
  { dd: 20, mm: 11, name: 'Nhà giáo Việt Nam', emoji: '📚', greeting: 'Chúc mừng ngày Nhà giáo Việt Nam 20/11!' },
  { dd: 24, mm: 12, name: 'Đêm Giáng sinh', emoji: '🎄', greeting: 'Chúc mừng Giáng sinh! Một mùa lễ an lành và ấm áp bên gia đình! 🎅' },
  { dd: 25, mm: 12, name: 'Giáng sinh', emoji: '🎄', greeting: 'Chúc mừng Giáng sinh! Một mùa lễ an lành và ấm áp bên gia đình! 🎅' }
];

interface LunarHolidayDef {
  month: number;
  day: number;
  name: string;
  emoji: string;
  greeting: string;
  isTet: boolean;
}

const LUNAR_HOLIDAYS: LunarHolidayDef[] = [
  { month: 1, day: 1, name: 'Mùng 1 Tết Nguyên Đán', emoji: '🧧', isTet: true, greeting: 'Chúc mừng năm mới! An khang thịnh vượng, vạn sự như ý! 🧧🎊' },
  { month: 1, day: 2, name: 'Mùng 2 Tết Nguyên Đán', emoji: '🧧', isTet: true, greeting: 'Chúc mừng năm mới! Chúc mọi điều tốt lành trong năm mới! 🧧' },
  { month: 1, day: 3, name: 'Mùng 3 Tết Nguyên Đán', emoji: '🧧', isTet: true, greeting: 'Chúc mừng năm mới! Vạn sự hanh thông, phát tài phát lộc! 🧧' },
  { month: 1, day: 15, name: 'Tết Nguyên Tiêu (Rằm tháng Giêng)', emoji: '🏮', isTet: false, greeting: 'Chúc mừng Tết Nguyên Tiêu — Rằm tháng Giêng an lành! 🏮' },
  { month: 3, day: 10, name: 'Giỗ Tổ Hùng Vương', emoji: '🙏', isTet: false, greeting: 'Chúc mừng ngày Giỗ Tổ Hùng Vương — nhớ ơn nguồn cội! 🙏' },
  { month: 5, day: 5, name: 'Tết Đoan Ngọ', emoji: '🌾', isTet: false, greeting: 'Chúc mừng Tết Đoan Ngọ — mùng 5 tháng 5 an lành! 🌾' },
  { month: 7, day: 15, name: 'Lễ Vu Lan', emoji: '🕯️', isTet: false, greeting: 'Mùa Vu Lan an lành, nhớ ơn cha mẹ, tổ tiên! 🕯️' },
  { month: 8, day: 15, name: 'Tết Trung Thu', emoji: '🥮', isTet: false, greeting: 'Chúc mừng Tết Trung Thu — trăng tròn, đoàn viên hạnh phúc! 🥮🏮' },
  { month: 12, day: 23, name: 'Tiễn ông Công ông Táo', emoji: '🐟', isTet: false, greeting: 'Tiễn ông Công ông Táo về trời — chúc năm mới an lành! 🐟' }
];

/** Tất cả ngày lễ/Tết rơi vào 1 ngày Dương lịch cụ thể — kiểm CẢ lễ cố định Dương lịch LẪN lễ tính theo
 * Âm lịch (dùng convertSolarToLunar thật, tự động khớp đúng theo NĂM, không cần bảng tra cứng theo năm).
 * `leap=true` (tháng nhuận) KHÔNG khớp lễ âm lịch nào (đúng phong tục — lễ luôn tính tháng thường). */
export function getHolidaysForDate(date: Date): HolidayHit[] {
  const hits: HolidayHit[] = [];
  const dd = date.getDate();
  const mm = date.getMonth() + 1;

  for (const h of SOLAR_HOLIDAYS) {
    if (h.dd === dd && h.mm === mm) {
      hits.push({ name: h.name, emoji: h.emoji, isTet: false, greeting: h.greeting });
    }
  }

  const lunar = solarDateToLunar(date);
  if (!lunar.leap) {
    for (const h of LUNAR_HOLIDAYS) {
      if (h.month === lunar.month && h.day === lunar.day) {
        hits.push({ name: h.name, emoji: h.emoji, isTet: h.isTet, greeting: h.greeting });
      }
    }
  }

  return hits;
}

/** Giao thừa (đêm 30 Tết, có thể là ngày 29 nếu tháng Chạp thiếu — tính ĐÚNG bằng cách lùi 1 ngày từ mùng 1
 * Tết năm sau, KHÔNG hard-code "ngày 30"). */
export function isGiaoThua(date: Date): boolean {
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);
  const lunarNext = solarDateToLunar(nextDay);
  return !lunarNext.leap && lunarNext.month === 1 && lunarNext.day === 1;
}

export interface UpcomingEvent {
  date: Date;
  daysUntil: number;
  kind: 'holiday' | 'tet';
  name: string;
  emoji: string;
}

/** Liệt kê lễ/Tết sắp tới trong `withinDays` ngày kể từ `fromDate` (bao gồm chính fromDate nếu trúng lễ hôm
 * đó, daysUntil=0). Dùng cho badge chuông thông báo + panel "sắp tới" trên CalendarScreen. */
export function getUpcomingHolidays(fromDate: Date, withinDays: number): UpcomingEvent[] {
  const events: UpcomingEvent[] = [];
  for (let i = 0; i <= withinDays; i += 1) {
    const d = new Date(fromDate);
    d.setDate(d.getDate() + i);
    const hits = getHolidaysForDate(d);
    for (const h of hits) {
      events.push({ date: d, daysUntil: i, kind: h.isTet ? 'tet' : 'holiday', name: h.name, emoji: h.emoji });
    }
  }
  return events;
}

/** Số ngày trong tháng Dương lịch hiện tại — re-export tiện dùng ở CalendarScreen (tránh import lặp 2 nơi). */
export { daysInSolarMonth };
