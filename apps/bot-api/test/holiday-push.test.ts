// SIGMA (VIỆC #31) — test holiday-push.ts. TOÀN BỘ THUẦN (không DB/Firebase): mọi dependency inject qua
// stub. Chạy trong suite apps/bot-api (globalSetup dựng throwaway Postgres cho các file khác — file này KHÔNG
// chạm DB). Phủ: LỄ (broadcast, ưu tiên Tết, nội dung brand, chống trùng, 08:00 gate), SINH NHẬT (khớp ngày →
// gửi bạn bè + ghi chuông), KỶ NIỆM (tròn năm → gửi 2 người), best-effort (lỗi 1 người KHÔNG chặn người khác).
import { describe, expect, it, vi } from 'vitest';
import {
  anniversaryYears,
  buildAnniversaryPushPayload,
  buildBirthdayPushPayload,
  buildHolidayPushPayload,
  createInMemoryHolidayLedger,
  getHolidayFor,
  holidayDateKey,
  isBirthdayToday,
  isHolidayToday,
  runAnniversaryPushForDate,
  runBirthdayPushForDate,
  runDailyEventPush,
  runHolidayPushForDate,
  startDailyEventPushWorker,
  type HolidayInfo,
  type HolidayResolver
} from '../src/holiday-push.js';

// Mẫu lễ THẬT (đối chiếu nguyên văn @sigma/shared/holidays.ts — dùng làm TEST DATA) để khẳng định nội dung brand.
const TET_MUNG_1: HolidayInfo = { name: 'Mùng 1 Tết Nguyên Đán', emoji: '🧧', isTet: true, greeting: 'Chúc mừng năm mới! An khang thịnh vượng, vạn sự như ý! 🧧🎊' };
const TET_DUONG: HolidayInfo = { name: 'Tết Dương lịch', emoji: '🎉', isTet: false, greeting: 'Chúc mừng năm mới! Chúc bạn và gia đình một năm an khang, thịnh vượng!' };
const TRUNG_THU: HolidayInfo = { name: 'Tết Trung Thu', emoji: '🥮', isTet: false, greeting: 'Chúc mừng Tết Trung Thu — trăng tròn, đoàn viên hạnh phúc! 🥮🏮' };

function makeResolver(byKey: Record<string, HolidayInfo[]>): HolidayResolver {
  return (date: Date) => byKey[holidayDateKey(date)] ?? [];
}

// ── LỄ ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('isHolidayToday / getHolidayFor (thuần)', () => {
  const resolve = makeResolver({ '2026-02-17': [TET_MUNG_1], '2026-01-01': [TET_DUONG], '2026-09-25': [TRUNG_THU] });

  it('ngày lễ → true, ngày thường → false', () => {
    expect(isHolidayToday(new Date(2026, 1, 17), resolve)).toBe(true);
    expect(isHolidayToday(new Date(2026, 5, 10), resolve)).toBe(false);
  });
  it('getHolidayFor trả lễ, null khi ngày thường', () => {
    expect(getHolidayFor(new Date(2026, 8, 25), resolve)?.name).toBe('Tết Trung Thu');
    expect(getHolidayFor(new Date(2026, 5, 10), resolve)).toBeNull();
  });
  it('ngày trúng NHIỀU lễ → ưu tiên Tết Nguyên Đán (isTet), không phải lễ đầu mảng', () => {
    const r = makeResolver({ '2026-02-17': [TET_DUONG, TET_MUNG_1] });
    const hit = getHolidayFor(new Date(2026, 1, 17), r);
    expect(hit?.name).toBe('Mùng 1 Tết Nguyên Đán');
    expect(hit?.isTet).toBe(true);
  });
});

describe('buildHolidayPushPayload (thuần, brand)', () => {
  it('title="<emoji> <tên>", body=lời chúc, data điều hướng màn Lịch', () => {
    const p = buildHolidayPushPayload(TET_MUNG_1);
    expect(p.title).toBe('🧧 Mùng 1 Tết Nguyên Đán');
    expect(p.body).toBe('Chúc mừng năm mới! An khang thịnh vượng, vạn sự như ý! 🧧🎊');
    expect(p.data).toEqual({ kind: 'holiday_greeting', screen: 'calendar', holidayName: 'Mùng 1 Tết Nguyên Đán', isTet: '1' });
  });
  it('lễ thường → isTet="0"', () => {
    expect(buildHolidayPushPayload(TRUNG_THU).data?.isTet).toBe('0');
  });
});

describe('holidayDateKey (thuần)', () => {
  it('YYYY-MM-DD theo giờ ĐỊA PHƯƠNG, zero-pad', () => {
    expect(holidayDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(holidayDateKey(new Date(2026, 11, 25))).toBe('2026-12-25');
  });
});

describe('runHolidayPushForDate (broadcast, best-effort)', () => {
  const resolve = makeResolver({ '2026-02-17': [TET_MUNG_1] });

  it('ngày lễ → gửi cho MỌI agent đúng 1 lần với payload lễ', async () => {
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const deps = { resolveHolidays: resolve, listRecipientAgentIds: vi.fn().mockResolvedValue([1, 2, 3]), sendPush };
    const res = await runHolidayPushForDate(new Date(2026, 1, 17), deps, createInMemoryHolidayLedger());
    expect(res.sentToAgents).toBe(3);
    expect(sendPush.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
    expect(sendPush.mock.calls[0][1].title).toBe('🧧 Mùng 1 Tết Nguyên Đán');
  });
  it('ngày thường → không gửi, skipped=not_holiday, KHÔNG query agent', async () => {
    const sendPush = vi.fn();
    const deps = { resolveHolidays: resolve, listRecipientAgentIds: vi.fn().mockResolvedValue([1]), sendPush };
    const res = await runHolidayPushForDate(new Date(2026, 5, 10), deps, createInMemoryHolidayLedger());
    expect(res.skipped).toBe('not_holiday');
    expect(deps.listRecipientAgentIds).not.toHaveBeenCalled();
  });
  it('gọi 2 lần cùng ngày (cùng ledger) → lần 2 already_sent_today', async () => {
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const ledger = createInMemoryHolidayLedger();
    const deps = { resolveHolidays: resolve, listRecipientAgentIds: vi.fn().mockResolvedValue([1, 2]), sendPush };
    await runHolidayPushForDate(new Date(2026, 1, 17), deps, ledger);
    const second = await runHolidayPushForDate(new Date(2026, 1, 17), deps, ledger);
    expect(second.skipped).toBe('already_sent_today');
    expect(sendPush).toHaveBeenCalledTimes(2);
  });
  it('sendPush THROW 1 agent → không chặn agent khác', async () => {
    const sendPush = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(undefined);
    const deps = { resolveHolidays: resolve, listRecipientAgentIds: vi.fn().mockResolvedValue([10, 20, 30]), sendPush };
    const res = await runHolidayPushForDate(new Date(2026, 1, 17), deps, createInMemoryHolidayLedger());
    expect(sendPush).toHaveBeenCalledTimes(3);
    expect(res.sentToAgents).toBe(2);
  });
  it('listRecipientAgentIds THROW → no-throw, sentToAgents=0', async () => {
    const sendPush = vi.fn();
    const deps = { resolveHolidays: resolve, listRecipientAgentIds: vi.fn().mockRejectedValue(new Error('db')), sendPush };
    const res = await runHolidayPushForDate(new Date(2026, 1, 17), deps, createInMemoryHolidayLedger());
    expect(res.sentToAgents).toBe(0);
    expect(sendPush).not.toHaveBeenCalled();
  });
});

// ── SINH NHẬT ───────────────────────────────────────────────────────────────────────────────────────────
describe('isBirthdayToday (thuần)', () => {
  it('khớp ngày/tháng (không cần năm) → true; lệch → false; dob invalid → false', () => {
    // dob dùng UTC (Prisma @db.Date lưu UTC-midnight); today dùng local.
    expect(isBirthdayToday(new Date(Date.UTC(1990, 1, 17)), new Date(2026, 1, 17))).toBe(true); // 17/2
    expect(isBirthdayToday(new Date(Date.UTC(1990, 1, 18)), new Date(2026, 1, 17))).toBe(false);
    expect(isBirthdayToday(new Date(NaN), new Date(2026, 1, 17))).toBe(false);
  });
});

describe('buildBirthdayPushPayload (thuần)', () => {
  it('title/body dùng tên gọi ngắn (từ cuối), data kind=birthday', () => {
    const p = buildBirthdayPushPayload('Nguyễn Văn An');
    expect(p.title).toBe('🎂 Sinh nhật bạn bè');
    expect(p.body).toContain('sinh nhật An');
    expect(p.data).toEqual({ kind: 'birthday', screen: 'calendar', celebrantName: 'Nguyễn Văn An' });
  });
});

describe('runBirthdayPushForDate (gửi bạn bè + ghi chuông)', () => {
  const today = new Date(2026, 1, 17); // 17/2
  function deps(agents: Array<{ id: number; name: string; dateOfBirth: Date }>, friendsByAgent: Record<number, number[]>) {
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const recordNotification = vi.fn().mockResolvedValue(undefined);
    return {
      d: {
        listAgentsWithBirthday: vi.fn().mockResolvedValue(agents),
        listAcceptedFriendIds: vi.fn((id: number) => Promise.resolve(friendsByAgent[id] ?? [])),
        sendPush,
        recordNotification
      },
      sendPush,
      recordNotification
    };
  }

  it('celebrant có sinh nhật hôm nay → gửi push + ghi chuông cho TỪNG bạn bè (recipient=bạn, actor=celebrant)', async () => {
    const { d, sendPush, recordNotification } = deps([{ id: 5, name: 'An', dateOfBirth: new Date(Date.UTC(1990, 1, 17)) }], { 5: [7, 9] });
    const res = await runBirthdayPushForDate(today, d, createInMemoryHolidayLedger());
    expect(res.celebrants).toBe(1);
    expect(res.pushesSent).toBe(2);
    expect(sendPush.mock.calls.map((c) => c[0])).toEqual([7, 9]); // gửi cho BẠN BÈ, không phải celebrant
    expect(recordNotification.mock.calls).toEqual([
      [7, 5, 'BIRTHDAY'],
      [9, 5, 'BIRTHDAY']
    ]);
  });
  it('không ai sinh nhật hôm nay → 0 push', async () => {
    const { d, sendPush } = deps([{ id: 5, name: 'An', dateOfBirth: new Date(Date.UTC(1990, 5, 1)) }], { 5: [7] });
    const res = await runBirthdayPushForDate(today, d, createInMemoryHolidayLedger());
    expect(res.celebrants).toBe(0);
    expect(sendPush).not.toHaveBeenCalled();
  });
  it('celebrant KHÔNG có bạn bè → không gửi cho ai', async () => {
    const { d, sendPush } = deps([{ id: 5, name: 'An', dateOfBirth: new Date(Date.UTC(1990, 1, 17)) }], { 5: [] });
    const res = await runBirthdayPushForDate(today, d, createInMemoryHolidayLedger());
    expect(res.celebrants).toBe(1);
    expect(sendPush).not.toHaveBeenCalled();
  });
  it('chống trùng: gọi 2 lần cùng ngày → lần 2 skipped', async () => {
    const { d, sendPush } = deps([{ id: 5, name: 'An', dateOfBirth: new Date(Date.UTC(1990, 1, 17)) }], { 5: [7] });
    const ledger = createInMemoryHolidayLedger();
    await runBirthdayPushForDate(today, d, ledger);
    const second = await runBirthdayPushForDate(today, d, ledger);
    expect(second.skipped).toBe('already_sent_today');
    expect(sendPush).toHaveBeenCalledTimes(1);
  });
});

// ── KỶ NIỆM ─────────────────────────────────────────────────────────────────────────────────────────────
describe('anniversaryYears (thuần)', () => {
  it('đúng ngày-tháng + ≥1 năm → số năm; lệch ngày → null; <1 năm → null', () => {
    expect(anniversaryYears(new Date(2023, 1, 17), new Date(2026, 1, 17))).toBe(3);
    expect(anniversaryYears(new Date(2025, 1, 17), new Date(2026, 1, 18))).toBeNull(); // lệch ngày
    expect(anniversaryYears(new Date(2026, 1, 17), new Date(2026, 1, 17))).toBeNull(); // 0 năm
  });
});

describe('buildAnniversaryPushPayload (thuần)', () => {
  it('body nêu số năm + tên người kia, data kind=anniversary', () => {
    const p = buildAnniversaryPushPayload('Bình', 3);
    expect(p.title).toBe('💛 Kỷ niệm kết bạn');
    expect(p.body).toContain('tròn 3 năm');
    expect(p.body).toContain('Bình');
    expect(p.data).toEqual({ kind: 'anniversary', screen: 'calendar', years: '3' });
  });
});

describe('runAnniversaryPushForDate (gửi CẢ 2 người)', () => {
  const today = new Date(2026, 1, 17);
  it('cặp tròn năm hôm nay → gửi 2 người, mỗi người nói về người kia + ghi chuông đối xứng', async () => {
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const recordNotification = vi.fn().mockResolvedValue(undefined);
    const d = {
      listAcceptedFriendships: vi.fn().mockResolvedValue([{ aId: 1, aName: 'An', bId: 2, bName: 'Bình', acceptedAt: new Date(2023, 1, 17) }]),
      sendPush,
      recordNotification
    };
    const res = await runAnniversaryPushForDate(today, d, createInMemoryHolidayLedger());
    expect(res.pairs).toBe(1);
    expect(res.pushesSent).toBe(2);
    expect(sendPush.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(sendPush.mock.calls[0][1].body).toContain('Bình'); // gửi cho An, nói về Bình
    expect(sendPush.mock.calls[1][1].body).toContain('An'); // gửi cho Bình, nói về An
    expect(recordNotification.mock.calls).toEqual([
      [1, 2, 'ANNIVERSARY'],
      [2, 1, 'ANNIVERSARY']
    ]);
  });
  it('cặp KHÔNG tròn năm hôm nay → bỏ qua', async () => {
    const sendPush = vi.fn();
    const d = {
      listAcceptedFriendships: vi.fn().mockResolvedValue([{ aId: 1, aName: 'An', bId: 2, bName: 'Bình', acceptedAt: new Date(2023, 5, 1) }]),
      sendPush,
      recordNotification: vi.fn()
    };
    const res = await runAnniversaryPushForDate(today, d, createInMemoryHolidayLedger());
    expect(res.pairs).toBe(0);
    expect(sendPush).not.toHaveBeenCalled();
  });
});

// ── WORKER GỘP ──────────────────────────────────────────────────────────────────────────────────────────
describe('startDailyEventPushWorker (08:00 gate)', () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  function fullDeps(now: Date) {
    const sendPush = vi.fn().mockResolvedValue(undefined);
    return {
      deps: {
        resolveHolidays: makeResolver({ '2026-02-17': [TET_MUNG_1] }),
        listRecipientAgentIds: vi.fn().mockResolvedValue([1, 2]),
        listAgentsWithBirthday: vi.fn().mockResolvedValue([]),
        listAcceptedFriendIds: vi.fn().mockResolvedValue([]),
        listAcceptedFriendships: vi.fn().mockResolvedValue([]),
        sendPush,
        recordNotification: vi.fn().mockResolvedValue(undefined)
      },
      sendPush,
      now: () => now
    };
  }

  it('start SAU 08:00 ngày lễ → gửi lễ ngay; stop() dừng', async () => {
    const { deps, sendPush, now } = fullDeps(new Date(2026, 1, 17, 9, 0, 0));
    const worker = startDailyEventPushWorker(deps, { now, sendAtOrAfterHour: 8 });
    await vi.waitFor(() => expect(sendPush).toHaveBeenCalledTimes(2));
    worker.stop();
  });
  it('start TRƯỚC 08:00 → không gửi', async () => {
    const { deps, sendPush, now } = fullDeps(new Date(2026, 1, 17, 6, 0, 0));
    const worker = startDailyEventPushWorker(deps, { now, sendAtOrAfterHour: 8 });
    await flush();
    expect(sendPush).not.toHaveBeenCalled();
    worker.stop();
  });
});

describe('runDailyEventPush (gộp 3 loại, ledger chung)', () => {
  it('chạy cả 3 loại; ngày thường + 0 sinh nhật + 0 kỷ niệm → không gửi gì', async () => {
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const deps = {
      resolveHolidays: makeResolver({}),
      listRecipientAgentIds: vi.fn().mockResolvedValue([1]),
      listAgentsWithBirthday: vi.fn().mockResolvedValue([]),
      listAcceptedFriendIds: vi.fn().mockResolvedValue([]),
      listAcceptedFriendships: vi.fn().mockResolvedValue([]),
      sendPush,
      recordNotification: vi.fn().mockResolvedValue(undefined)
    };
    const res = await runDailyEventPush(new Date(2026, 5, 10), deps, createInMemoryHolidayLedger());
    expect(res.holiday.skipped).toBe('not_holiday');
    expect(res.birthday.pushesSent).toBe(0);
    expect(res.anniversary.pushesSent).toBe(0);
    expect(sendPush).not.toHaveBeenCalled();
  });
});
