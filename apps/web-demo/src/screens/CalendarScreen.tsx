// Màn "Lịch" (Admin Demo 24/7 — "thêm tính năng lịch vào menu ví dụ lịch năm, có âm lịch và dương lịch theo
// lịch vạn niên, thiết kế đẹp phong thủy phù hợp alpha, có nhắc thông báo lịch ngày lễ, ngày tết kèm thông
// báo chúc mừng hiện đại"). Lịch vạn niên THẬT (lunar-calendar.ts — thuật toán Hồ Ngọc Đức, KHÔNG bảng tra
// cứng), thiết kế "phong thủy" = phối đỏ-vàng truyền thống Tết (accent) TRÊN nền brand SigMa xanh (#0579cc),
// bo góc lớn/kính mờ đồng bộ style macOS đã dùng toàn app.
//
// DEMO "xem trước bất kỳ ngày nào" (yêu cầu rõ trong nhiệm vụ, để LEAD kiểm tra không cần chờ đúng ngày
// thật): input ngày + nút "Xem trước thông báo" — set `previewDate` độc lập với "hôm nay thật", hiện banner
// chúc mừng NẾU ngày đó trúng lễ/Tết, KHÔNG phụ thuộc đồng hồ máy.
import { useEffect, useMemo, useState, type JSX } from 'react';
import { ChevronLeft, ChevronRight, PartyPopper, Sparkles, X } from 'lucide-react';
import {
  WEEKDAY_LABELS_MON_FIRST,
  canChiDay,
  canChiYear,
  daysInSolarMonth,
  DAY_QUALITY_LABEL,
  getDayQuality,
  solarDateToLunar,
  weekdayMondayFirst,
  type LunarDate
} from '@sigma/shared/lunar-calendar';
import { getHolidaysForDate, isGiaoThua, type HolidayHit } from '@sigma/shared/holidays';

const MONTH_LABELS = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];

function sameDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Năm Âm lịch đại diện cho 1 tháng Dương lịch — dùng số ĐÔNG NHẤT trong các ngày CÓ THẬT của tháng đó (KHÔNG
 * cố định "ngày 15", vì tháng chứa Tết (thường Tháng 1-2 Dương) có thể bị ngày 15 rơi vào lunar year SAI — vd
 * Tháng 2/2026: Tết Bính Ngọ rơi ngày 17/2, nên ngày 15/2 vẫn còn thuộc năm Ất Tỵ cũ dù phần lớn Tháng 2 đã
 * sang năm Bính Ngọ. Phát hiện tự phản biện khi xem ảnh chụp demo — sửa ngay để nhãn tiêu đề luôn khớp với
 * phần lớn số ngày người dùng thực sự thấy trong lưới tháng đó (thay vì chỉ đúng cho ĐA SỐ tháng trong năm
 * nhưng SAI RIÊNG cho tháng chứa Tết). */
function representativeLunarYear(cells: DayCellData[]): number {
  const counts = new Map<number, number>();
  for (const c of cells) {
    if (!c.inCurrentMonth) continue;
    counts.set(c.lunar.year, (counts.get(c.lunar.year) ?? 0) + 1);
  }
  let best = cells[0]?.lunar.year ?? 0;
  let bestCount = -1;
  for (const [year, n] of counts) {
    if (n > bestCount) {
      best = year;
      bestCount = n;
    }
  }
  return best;
}

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

interface DayCellData {
  date: Date;
  lunar: LunarDate;
  holidays: HolidayHit[];
  giaoThua: boolean;
  inCurrentMonth: boolean;
}

function buildMonthGrid(year: number, month1to12: number): DayCellData[] {
  const first = new Date(year, month1to12 - 1, 1);
  const leadingBlanks = weekdayMondayFirst(first);
  const totalDaysInMonth = daysInSolarMonth(month1to12, year);
  const cells: DayCellData[] = [];

  // Ngày cuối tháng trước (ô mờ, giữ đúng lưới 7 cột — vẫn tính lịch âm thật cho ngày đó, không để trống).
  for (let i = leadingBlanks; i > 0; i -= 1) {
    const d = new Date(year, month1to12 - 1, 1 - i);
    cells.push({ date: d, lunar: solarDateToLunar(d), holidays: getHolidaysForDate(d), giaoThua: isGiaoThua(d), inCurrentMonth: false });
  }
  for (let d = 1; d <= totalDaysInMonth; d += 1) {
    const date = new Date(year, month1to12 - 1, d);
    cells.push({ date, lunar: solarDateToLunar(date), holidays: getHolidaysForDate(date), giaoThua: isGiaoThua(date), inCurrentMonth: true });
  }
  // Ngày đầu tháng sau, lấp nốt hàng cuối cho đủ bội số 7.
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1].date;
    const d = new Date(last);
    d.setDate(d.getDate() + 1);
    cells.push({ date: d, lunar: solarDateToLunar(d), holidays: getHolidaysForDate(d), giaoThua: isGiaoThua(d), inCurrentMonth: false });
  }
  return cells;
}

function MiniMonth({
  year,
  month1to12,
  today,
  onOpenMonth
}: {
  year: number;
  month1to12: number;
  today: Date;
  onOpenMonth: () => void;
}): JSX.Element {
  const grid = useMemo(() => buildMonthGrid(year, month1to12), [year, month1to12]);
  return (
    <button
      onClick={onOpenMonth}
      className="flex flex-col rounded-lg-mac border border-line bg-white p-2.5 text-left shadow-soft transition hover:-translate-y-0.5 hover:shadow-card"
    >
      <div className="mb-1.5 text-xs font-bold text-brand">{MONTH_LABELS[month1to12 - 1]}</div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-[9px]">
        {grid.map((c, i) => {
          const isToday = sameDate(c.date, today);
          const isTet = c.holidays.some((h) => h.isTet);
          return (
            <div
              key={i}
              className={
                'flex h-4 items-center justify-center rounded-sm ' +
                (!c.inCurrentMonth ? 'text-slate-300' : isTet ? 'bg-danger/15 font-semibold text-danger' : isToday ? 'bg-brand font-semibold text-white' : 'text-slate-600')
              }
            >
              {c.date.getDate()}
            </div>
          );
        })}
      </div>
    </button>
  );
}

export function CalendarScreen(): JSX.Element {
  const realToday = useMemo(() => new Date(), []);
  const [year, setYear] = useState(realToday.getFullYear());
  const [month, setMonth] = useState(realToday.getMonth() + 1); // 1-12
  const [view, setView] = useState<'year' | 'month'>('month');
  const [selectedDate, setSelectedDate] = useState<Date>(realToday);

  // Demo "xem trước bất kỳ ngày" — độc lập với đồng hồ máy, cho phép LEAD kiểm tra thông báo chúc mừng của
  // BẤT KỲ ngày lễ/Tết nào mà không cần chờ tới đúng ngày thật.
  const [previewInput, setPreviewInput] = useState(toDateInputValue(realToday));
  const [previewToast, setPreviewToast] = useState<{ date: Date; holiday: HolidayHit } | null>(null);

  // Tự phản biện qua Playwright thật (25/7): toast trước đây KHÔNG tự đóng — nằm `fixed top-4 right-4` đè
  // ĐÚNG lên vùng nút chuyển tháng (< >) trên banner, khiến người dùng "kẹt" không bấm được nút đó cho tới
  // khi tự tay đóng toast (X). Tự đóng sau 6s để không chặn thao tác vô thời hạn — vẫn giữ nút X đóng ngay
  // nếu người dùng muốn đóng sớm hơn.
  useEffect(() => {
    if (!previewToast) return;
    const timer = setTimeout(() => setPreviewToast(null), 6000);
    return () => clearTimeout(timer);
  }, [previewToast]);

  const selectedLunar = useMemo(() => solarDateToLunar(selectedDate), [selectedDate]);
  const selectedHolidays = useMemo(() => getHolidaysForDate(selectedDate), [selectedDate]);
  const selectedQuality = getDayQuality(selectedLunar.day);
  const qualityInfo = DAY_QUALITY_LABEL[selectedQuality];

  const monthGrid = useMemo(() => buildMonthGrid(year, month), [year, month]);

  function goPrevMonth(): void {
    if (month === 1) {
      setMonth(12);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  }
  function goNextMonth(): void {
    if (month === 12) {
      setMonth(1);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  }

  function runPreview(): void {
    const d = new Date(`${previewInput}T12:00:00`);
    if (Number.isNaN(d.getTime())) return;
    const hits = getHolidaysForDate(d);
    if (hits.length > 0) {
      setPreviewToast({ date: d, holiday: hits[0] });
    } else {
      setPreviewToast({ date: d, holiday: { name: 'Không phải ngày lễ/Tết', emoji: '📅', isTet: false, greeting: 'Ngày này không rơi vào lễ/Tết nào trong danh sách.' } });
    }
    // Đồng thời nhảy lịch tới đúng ngày xem trước để LEAD thấy vị trí ô trên lưới.
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setSelectedDate(d);
  }

  return (
    // 7/8 (Fold cover): overflow-y-auto (KHÔNG cuộn NGANG — nội dung tự fit).
    <div className="relative h-full overflow-y-auto overflow-x-hidden bg-appbg">
      {/* Banner "phong thủy" đầu trang — gradient đỏ-vàng Tết truyền thống pha brand xanh SigMa, kiểu lịch
          treo tường hiện đại. */}
      <div
        className="relative overflow-hidden px-5 py-5 text-white"
        style={{ background: 'linear-gradient(120deg, var(--color-brand) 0%, var(--color-brand-hover) 55%, var(--color-brand-teal) 100%)' }}
      >
        <div className="pointer-events-none absolute -right-6 -top-10 h-40 w-40 rounded-full bg-warning/20 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-8 left-10 h-28 w-28 rounded-full bg-danger/25 blur-2xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-white/70">
              <Sparkles className="h-3.5 w-3.5" /> Lịch vạn niên SigMa
            </div>
            <div className="mt-0.5 text-2xl font-bold">
              {MONTH_LABELS[month - 1]}, {year}
            </div>
            <div className="text-sm text-white/80">Năm Âm lịch: {canChiYear(representativeLunarYear(monthGrid))}</div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center overflow-hidden rounded-lg-mac border border-white/25 bg-white/10">
              <button onClick={() => setView('month')} className={'px-3 py-1.5 text-xs font-semibold ' + (view === 'month' ? 'bg-white text-brand' : 'text-white/85')}>
                Tháng
              </button>
              <button onClick={() => setView('year')} className={'px-3 py-1.5 text-xs font-semibold ' + (view === 'year' ? 'bg-white text-brand' : 'text-white/85')}>
                Năm
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={goPrevMonth} className="rounded-full bg-white/15 p-1.5 hover:bg-white/25">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button onClick={goNextMonth} className="rounded-full bg-white/15 p-1.5 hover:bg-white/25">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
      {/* 7/8 (Fold cover): grid-cols-1 (= minmax(0,1fr)) dưới lg — KHÔNG để track `auto` phình theo max-content
          của thẻ lịch (gây tràn 328>312 trên 344). Cột phụ 300px chỉ bật ở lg (desktop/EXE). */}
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div>
          {view === 'month' ? (
            <div className="rounded-lg-mac border border-line bg-white p-3 shadow-soft">
              <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs font-semibold text-slate-500">
                {WEEKDAY_LABELS_MON_FIRST.map((w) => (
                  <div key={w} className={w === 'CN' ? 'text-danger' : ''}>
                    {w}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {monthGrid.map((c, i) => {
                  const isToday = sameDate(c.date, realToday);
                  const isSelected = sameDate(c.date, selectedDate);
                  const isTet = c.holidays.some((h) => h.isTet);
                  const hasHoliday = c.holidays.length > 0;
                  const quality = getDayQuality(c.lunar.day);
                  return (
                    <button
                      key={i}
                      onClick={() => setSelectedDate(c.date)}
                      className={
                        'relative flex aspect-square flex-col items-center justify-center rounded-lg-mac border text-sm transition ' +
                        (!c.inCurrentMonth
                          ? 'border-transparent text-slate-300'
                          : isSelected
                            ? 'border-brand bg-brand text-white shadow-soft'
                            : isTet
                              ? 'border-danger/30 bg-gradient-to-br from-danger/10 to-warning/10 text-danger hover:brightness-95'
                              : isToday
                                ? 'border-brand/50 bg-brand-tint text-brand'
                                : 'border-line bg-white text-slate-700 hover:bg-appbg')
                      }
                    >
                      <span className="text-base font-semibold leading-none">{c.date.getDate()}</span>
                      <span className={'mt-0.5 text-[10px] leading-none ' + (isSelected ? 'text-white/85' : 'text-slate-400')}>
                        {c.lunar.day === 1 ? `${c.lunar.day}/${c.lunar.month}${c.lunar.leap ? 'N' : ''} ÂL` : c.lunar.day}
                      </span>
                      {hasHoliday && <span className="absolute right-1 top-1 text-[10px]">{c.holidays[0].emoji}</span>}
                      {!hasHoliday && quality !== 'binh_thuong' && (
                        <span
                          className={'absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ' + (isSelected ? 'bg-white/70' : 'bg-warning')}
                          title={DAY_QUALITY_LABEL[quality].label}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {MONTH_LABELS.map((_, idx) => (
                <MiniMonth
                  key={idx}
                  year={year}
                  month1to12={idx + 1}
                  today={realToday}
                  onOpenMonth={() => {
                    setMonth(idx + 1);
                    setView('month');
                  }}
                />
              ))}
            </div>
          )}

          {/* Chú giải màu — thiết kế "phong thủy" giải thích rõ ý nghĩa ký hiệu. */}
          <div className="mt-3 flex flex-wrap items-center gap-4 rounded-lg-mac border border-line bg-white px-3.5 py-2.5 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-brand" /> Hôm nay
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-danger" /> Ngày Tết
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-warning" /> Tam Nương/Nguyệt Kỵ (dân gian)
            </span>
            <span className="text-slate-400">Số nhỏ dưới ngày Dương = ngày Âm lịch tương ứng.</span>
          </div>
        </div>

        {/* Panel chi tiết ngày đang chọn + demo "xem trước bất kỳ ngày". */}
        <div className="flex flex-col gap-3">
          <div className="rounded-lg-mac border border-line bg-white p-4 shadow-soft">
            <div className="text-xs font-semibold text-slate-500">Ngày đang chọn</div>
            <div className="mt-1 text-lg font-bold text-slate-800">
              {selectedDate.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
            </div>
            <div className="mt-1 text-sm text-brand">
              Âm lịch: {selectedLunar.day}/{selectedLunar.month}
              {selectedLunar.leap ? ' (nhuận)' : ''}/{selectedLunar.year} · {canChiYear(selectedLunar.year)}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">Ngày (Can-Chi, minh họa): {canChiDay(selectedDate.getDate(), selectedDate.getMonth() + 1, selectedDate.getFullYear())}</div>

            <div
              className={
                'mt-3 rounded-lg-mac px-3 py-2 text-xs font-medium ' +
                (qualityInfo.tone === 'good' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning')
              }
            >
              {qualityInfo.label}
            </div>

            {selectedHolidays.length > 0 ? (
              <div className="mt-3 space-y-2">
                {selectedHolidays.map((h, i) => (
                  <div key={i} className={'rounded-lg-mac border px-3 py-2 text-xs ' + (h.isTet ? 'border-danger/30 bg-danger/5' : 'border-brand/20 bg-brand-tint')}>
                    <div className="font-semibold text-slate-800">
                      {h.emoji} {h.name}
                    </div>
                    <div className="mt-0.5 text-slate-500">{h.greeting}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 text-xs text-slate-400">Không phải ngày lễ/Tết nào trong danh sách.</div>
            )}
          </div>

          {/* Demo "xem trước bất kỳ ngày" — yêu cầu rõ trong nhiệm vụ, để kiểm tra không cần chờ đúng ngày thật. */}
          <div className="rounded-lg-mac border border-dashed border-brand/40 bg-brand-tint/50 p-4">
            <div className="mb-2 text-xs font-semibold text-brand">Xem trước thông báo chúc mừng (demo)</div>
            <div className="flex gap-2">
              <input
                type="date"
                value={previewInput}
                onChange={(e) => setPreviewInput(e.target.value)}
                className="flex-1 rounded-md border border-line bg-white px-2 py-1.5 text-xs outline-none focus:border-brand"
              />
              <button onClick={runPreview} className="btn-primary px-3 py-1.5 text-xs font-semibold text-white">
                Xem trước
              </button>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500">Chọn bất kỳ ngày nào (không cần đúng hôm nay) để xem trước thông báo/chúc mừng của ngày đó.</div>
          </div>
        </div>
      </div>
      {/* Toast chúc mừng "hiện đại" — demo theo ngày xem trước, KHÔNG phụ thuộc đồng hồ máy thật. */}
      {previewToast && (
        // top-24 (không phải top-4) — tránh đè lên nút chuyển tháng (‹ ›)/Tháng-Năm trên banner tiêu đề của
        // chính CalendarScreen (xem comment useEffect tự-đóng ở trên, cùng 1 phát hiện tự phản biện).
        (<div className="fixed right-4 top-24 z-50 w-80 overflow-hidden rounded-lg-mac border border-line bg-white p-3.5 shadow-card glass-panel">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-teal text-lg text-white">
              {previewToast.holiday.emoji}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-800">{previewToast.holiday.name}</span>
                <button onClick={() => setPreviewToast(null)} aria-label="Đóng" className="shrink-0 text-slate-400 hover:text-slate-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-400">
                {previewToast.date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}
              </div>
              <p className="mt-1.5 text-sm text-slate-600">{previewToast.holiday.greeting}</p>
              {previewToast.holiday.isTet && (
                <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-danger">
                  <PartyPopper className="h-3.5 w-3.5" /> Chúc Mừng Năm Mới!
                </div>
              )}
            </div>
          </div>
        </div>)
      )}
    </div>
  );
}
