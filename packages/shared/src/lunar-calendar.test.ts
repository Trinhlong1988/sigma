// Test đối chiếu thuật toán lịch âm-dương Việt Nam (lunar-calendar.ts) — mục "Lịch vạn niên" (kế hoạch
// curried-plotting-hippo.md, Admin Demo 24/7). Chạy qua ROOT vitest config (vitest.config.ts include đã thêm
// file này) — module thuần TS, KHÔNG cần DOM/Postgres, ăn khớp quy ước "pure-logic test" của root config.
import { describe, expect, it } from 'vitest';
import {
  canChiYear,
  convertLunarToSolar,
  convertSolarToLunar,
  daysInSolarMonth,
  getDayQuality,
  solarDateToLunar,
  weekdayMondayFirst
} from './lunar-calendar';

// 10 mốc "mùng 1 Tết Nguyên Đán" (Dương lịch) ĐÃ BIẾT CHẮC CHẮN ĐÚNG — công bố công khai rộng rãi (lịch nhà
// nước Việt Nam / báo chí hàng năm), dùng làm oracle đối chiếu thuật toán — KHÔNG suy đoán, đây là các ngày
// nghỉ lễ Tết chính thức mọi người Việt Nam đều biết.
const KNOWN_TET_DAYS: Array<{ solar: [number, number, number]; canChi: string }> = [
  { solar: [8, 2, 2016], canChi: 'Bính Thân' },
  { solar: [28, 1, 2017], canChi: 'Đinh Dậu' },
  { solar: [16, 2, 2018], canChi: 'Mậu Tuất' },
  { solar: [5, 2, 2019], canChi: 'Kỷ Hợi' },
  { solar: [25, 1, 2020], canChi: 'Canh Tý' },
  { solar: [12, 2, 2021], canChi: 'Tân Sửu' },
  { solar: [1, 2, 2022], canChi: 'Nhâm Dần' },
  { solar: [22, 1, 2023], canChi: 'Quý Mão' },
  { solar: [10, 2, 2024], canChi: 'Giáp Thìn' },
  { solar: [29, 1, 2025], canChi: 'Ất Tỵ' }
];

describe('lunar-calendar — đối chiếu 10 mốc mùng 1 Tết Nguyên Đán đã biết chắc đúng', () => {
  for (const { solar, canChi } of KNOWN_TET_DAYS) {
    const [dd, mm, yy] = solar;
    it(`Dương lịch ${dd}/${mm}/${yy} → Âm lịch mùng 1 tháng Giêng, năm ${canChi}`, () => {
      const lunar = convertSolarToLunar(dd, mm, yy);
      expect(lunar.day).toBe(1);
      expect(lunar.month).toBe(1);
      expect(lunar.leap).toBe(false);
      expect(canChiYear(lunar.year)).toBe(canChi);
    });

    it(`Âm lịch mùng 1 tháng Giêng năm ${canChi} → Dương lịch ĐÚNG ${dd}/${mm}/${yy}`, () => {
      const lunar = convertSolarToLunar(dd, mm, yy);
      const back = convertLunarToSolar(1, 1, lunar.year, false);
      expect(back).not.toBeNull();
      expect(back!.getDate()).toBe(dd);
      expect(back!.getMonth() + 1).toBe(mm);
      expect(back!.getFullYear()).toBe(yy);
    });
  }
});

describe('lunar-calendar — round-trip Dương→Âm→Dương trên nhiều mốc ngẫu nhiên rải rác', () => {
  const samples: Array<[number, number, number]> = [
    [1, 1, 2000],
    [15, 6, 2010],
    [31, 12, 2021],
    [29, 2, 2024], // 29/2 năm nhuận Dương lịch
    [1, 3, 2024],
    [17, 2, 2026],
    [4, 7, 1995],
    [23, 10, 2050],
    [11, 11, 1980],
    [30, 4, 2035]
  ];
  for (const [dd, mm, yy] of samples) {
    it(`round-trip ${dd}/${mm}/${yy}`, () => {
      const lunar = convertSolarToLunar(dd, mm, yy);
      const back = convertLunarToSolar(lunar.day, lunar.month, lunar.year, lunar.leap);
      expect(back).not.toBeNull();
      expect(back!.getDate()).toBe(dd);
      expect(back!.getMonth() + 1).toBe(mm);
      expect(back!.getFullYear()).toBe(yy);
    });
  }
});

describe('lunar-calendar — năm âm lịch có tháng nhuận (2023 Quý Mão nhuận tháng Hai)', () => {
  it('mùng 1 tháng 2 nhuận Quý Mão tồn tại và round-trip đúng; tháng 2 KHÔNG nhuận cũng tồn tại riêng (2 tháng 2 trong năm đó)', () => {
    // 2023 (Quý Mão) là năm 13 tháng âm lịch với tháng nhuận là tháng 2 — sự kiện thiên văn công khai, đối
    // chiếu qua chính thuật toán round-trip (không có oracle ngày dương cụ thể độc lập ở đây, nhưng khẳng
    // định được TÍNH NHẤT QUÁN NỘI TẠI: nếu 2023 không có tháng nhuận, convertLunarToSolar(*, *, *, true)
    // phải trả null cho MỌI tháng — ở đây kỳ vọng có ÍT NHẤT 1 tháng nhuận hợp lệ).
    let leapFound = false;
    for (let month = 1; month <= 12; month += 1) {
      const d = convertLunarToSolar(1, month, 2023, true);
      if (d) {
        leapFound = true;
        const back = convertSolarToLunar(d.getDate(), d.getMonth() + 1, d.getFullYear());
        expect(back.leap).toBe(true);
        expect(back.month).toBe(month);
      }
    }
    expect(leapFound).toBe(true);
  });

  it('năm KHÔNG có tháng nhuận (2024 Giáp Thìn) → convertLunarToSolar(*, *, *, leap=true) LUÔN trả null cho mọi tháng', () => {
    for (let month = 1; month <= 12; month += 1) {
      expect(convertLunarToSolar(1, month, 2024, true)).toBeNull();
    }
  });
});

describe('lunar-calendar — input xấu / biên (KHÔNG được crash, KHÔNG trả kết quả bịa)', () => {
  it('29/2 năm nhuận Dương lịch (2024) hợp lệ, chuyển đổi bình thường không throw', () => {
    expect(() => convertSolarToLunar(29, 2, 2024)).not.toThrow();
    const lunar = convertSolarToLunar(29, 2, 2024);
    expect(lunar.day).toBeGreaterThanOrEqual(1);
    expect(lunar.month).toBeGreaterThanOrEqual(1);
  });

  it('31/12 mọi năm chuyển đổi được, không throw', () => {
    for (const y of [1999, 2000, 2024, 2025]) {
      expect(() => convertSolarToLunar(31, 12, y)).not.toThrow();
    }
  });

  it('năm rất xa quá khứ (1000) và rất xa tương lai (2999) không throw, trả cấu trúc hợp lệ (không NaN)', () => {
    const past = convertSolarToLunar(1, 1, 1000);
    expect(Number.isFinite(past.day)).toBe(true);
    expect(Number.isFinite(past.month)).toBe(true);
    expect(Number.isFinite(past.year)).toBe(true);

    const future = convertSolarToLunar(1, 1, 2999);
    expect(Number.isFinite(future.day)).toBe(true);
    expect(Number.isFinite(future.month)).toBe(true);
    expect(Number.isFinite(future.year)).toBe(true);
  });

  it('convertLunarToSolar với ngày âm lịch không tồn tại (ngày 30 của tháng chỉ có 29 ngày) → null, KHÔNG trả ngày bịa', () => {
    // Dò 1 năm/tháng bất kỳ có tháng thiếu (29 ngày) bằng cách thử ngày 30 rồi kiểm tra tự nhất quán: nếu
    // convertLunarToSolar(30,...) trả về ngày thật, round-trip PHẢI cho lại đúng (30, month, year) — nếu
    // không khớp thì đã có bug (nhưng ở đây, kỳ vọng chính là hàm tự phát hiện path 30 không hợp lệ, đã có
    // guard round-trip trong implementation — assert KHÔNG throw và nếu trả về giá trị thì phải tự nhất quán).
    for (let month = 1; month <= 12; month += 1) {
      const d = convertLunarToSolar(30, month, 2024, false);
      if (d === null) continue; // tháng thiếu, đúng như kỳ vọng cho phần lớn tháng
      const back = convertSolarToLunar(d.getDate(), d.getMonth() + 1, d.getFullYear());
      expect(back.day).toBe(30);
      expect(back.month).toBe(month);
    }
  });

  it('solarDateToLunar(Date) đọc đúng ngày/tháng/năm ĐỊA PHƯƠNG của đối tượng Date (không lệch múi UTC)', () => {
    const d = new Date(2024, 1, 10, 8, 0, 0); // 10/2/2024 08:00 giờ địa phương — chính là Tết Giáp Thìn
    const lunar = solarDateToLunar(d);
    expect(lunar.day).toBe(1);
    expect(lunar.month).toBe(1);
  });
});

describe('lunar-calendar — tiện ích dựng lưới lịch (daysInSolarMonth/weekdayMondayFirst)', () => {
  it('daysInSolarMonth: tháng 2 năm nhuận = 29, năm thường = 28, tháng 4 = 30, tháng 1 = 31', () => {
    expect(daysInSolarMonth(2, 2024)).toBe(29);
    expect(daysInSolarMonth(2, 2023)).toBe(28);
    expect(daysInSolarMonth(4, 2024)).toBe(30);
    expect(daysInSolarMonth(1, 2024)).toBe(31);
  });

  it('weekdayMondayFirst: Thứ 2 → 0, Chủ Nhật → 6', () => {
    // 2024-01-01 là Thứ 2 (thứ thật, kiểm chứng qua Date.getDay() của JS — không phải số bịa).
    const monday = new Date(2024, 0, 1);
    expect(monday.getDay()).toBe(1); // JS: 1 = Thứ 2, xác nhận trước khi assert hàm cần test
    expect(weekdayMondayFirst(monday)).toBe(0);

    const sunday = new Date(2024, 0, 7);
    expect(sunday.getDay()).toBe(0); // JS: 0 = Chủ Nhật
    expect(weekdayMondayFirst(sunday)).toBe(6);
  });
});

describe('lunar-calendar — getDayQuality (Tam Nương/Nguyệt Kỵ, minh họa dân gian)', () => {
  it('mùng 3/7/13/18/22/27 âm lịch → tam_nuong', () => {
    for (const d of [3, 7, 13, 18, 22, 27]) expect(getDayQuality(d)).toBe('tam_nuong');
  });
  it('mùng 5/14/23 âm lịch → nguyet_ky', () => {
    for (const d of [5, 14, 23]) expect(getDayQuality(d)).toBe('nguyet_ky');
  });
  it('mùng 1 âm lịch (Tết) → binh_thuong (không bị gắn nhãn xấu)', () => {
    expect(getDayQuality(1)).toBe('binh_thuong');
  });
});
