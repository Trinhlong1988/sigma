// SIGMA (VIỆC #31, Admin Demo 6/8 CHỐT triển khai đầy đủ) — thông báo ĐẨY (FCM) + chuông cho 3 loại sự kiện,
// gửi mỗi sáng 08:00 (giờ máy chủ = giờ VN), nội dung/emoji theo BRAND SigMa:
//   1. NGÀY LỄ / TẾT  → GỬI HỆ THỐNG cho MỌI đại lý còn sống (broadcast). Dùng HẾT 19 lễ trong @sigma/shared/
//      holidays.ts (đã promote từ web-demo sang shared để CẢ web-demo lẫn bot-api dùng 1 nguồn, chống drift).
//   2. SINH NHẬT      → GỬI CHO BẠN BÈ ACCEPTED của người có sinh nhật hôm nay (khớp ngày/tháng date_of_birth).
//   3. KỶ NIỆM KẾT BẠN → GỬI CHO CẢ 2 người khi tròn N năm kể từ acceptedAt của quan hệ bạn bè.
//
// NGUYÊN TẮC (đọc kỹ):
//  - TÁI DÙNG hạ tầng: FCM qua sendPushToAgent() (push-notification-service.ts, best-effort/no-throw/dọn token
//    chết); chuông trong-app qua createEventNotification() (notification-service.ts, model AgentNotification).
//    Module này chỉ QUYẾT ĐỊNH gửi-GÌ/KHI-NÀO/cho-AI.
//  - THUẦN + Dependency Injection: mọi truy vấn DB/gửi tách thành THAM SỐ (deps) → orchestration test được bằng
//    stub, 0 I/O trong hàm thuần. `buildDailyEventPushDeps(db)` là adapter DB thật (glue mỏng), wire ở index.ts.
//  - Best-effort THUẦN TÚY: KHÔNG BAO GIỜ throw ra ngoài; lỗi 1 agent/1 sự kiện KHÔNG chặn phần còn lại; mọi
//    lỗi log console.error rõ ràng (R198: KHÔNG nuốt câm lặng).
//  - Lịch trình = worker nền TRONG process bot-api (CÙNG khuôn startDeletionSweepWorker — index.ts), unref().
//  - Chống gửi trùng: ledger in-memory theo (loại + dateKey). Đánh đổi (chấp nhận, Admin Demo chốt "greeting"):
//    restart process trong ngày CÓ THỂ gửi lại 1 lần loại đã gửi hôm đó — tác hại thấp (lời chúc lặp). Interface
//    HolidaySendLedger cho phép thay bản bền (file/DB) mà không đổi worker.

import type { Db } from '@sigma/database';
import { getHolidaysForDate } from '@sigma/shared/holidays';
import { sendPushToAgent, type PushMessagingClient, type PushPayload } from './push-notification-service.js';
import { createEventNotification } from './notification-service.js';

/** Hình dạng 1 ngày lễ/Tết — TRÙNG shape `HolidayHit` (@sigma/shared/holidays.ts). Chỉ giữ field cần cho push. */
export interface HolidayInfo {
  name: string;
  emoji: string;
  isTet: boolean;
  greeting: string;
}

/** Hàm tra lễ/Tết của 1 ngày Dương lịch — CÙNG chữ ký `getHolidaysForDate(date)`. Inject để test + tái dùng
 * đúng nguồn lịch chung, KHÔNG tự bịa danh sách. */
export type HolidayResolver = (date: Date) => HolidayInfo[];

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 1 — HÀM THUẦN (không I/O). Test 100% không cần Firebase/DB/thời gian thật.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** THUẦN — hôm nay (theo `resolve`) có phải ngày lễ/Tết không. */
export function isHolidayToday(date: Date, resolve: HolidayResolver): boolean {
  return resolve(date).length > 0;
}

/** THUẦN — lễ ĐẠI DIỆN của 1 ngày: ưu tiên Tết Nguyên Đán (isTet) nếu trúng nhiều lễ, ngược lại lễ đầu tiên.
 * `null` nếu KHÔNG phải ngày lễ. Chọn 1 lễ đại diện để CHỈ gửi 1 push/ngày (chống spam). */
export function getHolidayFor(date: Date, resolve: HolidayResolver): HolidayInfo | null {
  const hits = resolve(date);
  if (hits.length === 0) return null;
  return hits.find((h) => h.isTet) ?? hits[0];
}

/** THUẦN — nội dung push NGÀY LỄ theo brand. title="<emoji> <tên>", body=lời chúc (đã soạn giọng brand trong
 * holidays.ts). data điều hướng màn Lịch. KHÔNG priority:'high' + KHÔNG dataOnly Ở HÀM THUẦN NÀY (adapter thật
 * sẽ tự thêm priority:'high' — xem buildDailyEventPushDeps). */
export function buildHolidayPushPayload(holiday: HolidayInfo): PushPayload {
  return {
    title: `${holiday.emoji} ${holiday.name}`,
    body: holiday.greeting,
    data: { kind: 'holiday_greeting', screen: 'calendar', holidayName: holiday.name, isTet: holiday.isTet ? '1' : '0' }
  };
}

/** THUẦN — tên gọi thân mật (từ cuối của họ tên đầy đủ, kiểu "Nguyễn Văn An" → "An"). */
function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName.trim() || 'bạn';
}

/** THUẦN — dob (từ Prisma @db.Date, neo UTC-midnight) có trùng NGÀY-THÁNG với `today` (giờ địa phương) không.
 * KHÔNG cần trùng năm. Mirror birthday-notify.ts isBirthdayToday (dùng getUTC* cho dob vì @db.Date lưu UTC). */
export function isBirthdayToday(dob: Date, today: Date): boolean {
  if (Number.isNaN(dob.getTime())) return false;
  return dob.getUTCMonth() === today.getMonth() && dob.getUTCDate() === today.getDate();
}

/** THUẦN — nội dung push SINH NHẬT (gửi CHO BẠN BÈ của người có sinh nhật). */
export function buildBirthdayPushPayload(celebrantName: string): PushPayload {
  const who = shortName(celebrantName);
  return {
    title: '🎂 Sinh nhật bạn bè',
    body: `Hôm nay là sinh nhật ${who}! Gửi lời chúc mừng tới ${who} nhé 🎉`,
    data: { kind: 'birthday', screen: 'calendar', celebrantName }
  };
}

/** THUẦN — số năm tròn kể từ acceptedAt tới `today` NẾU hôm nay đúng ngày-tháng kỷ niệm và đã ≥1 năm; ngược
 * lại `null`. So sánh theo giờ ĐỊA PHƯƠNG cả 2 mốc cho nhất quán. */
export function anniversaryYears(acceptedAt: Date, today: Date): number | null {
  if (Number.isNaN(acceptedAt.getTime())) return null;
  if (acceptedAt.getMonth() !== today.getMonth() || acceptedAt.getDate() !== today.getDate()) return null;
  const years = today.getFullYear() - acceptedAt.getFullYear();
  return years >= 1 ? years : null;
}

/** THUẦN — nội dung push KỶ NIỆM (gửi cho cả 2 người; `otherName` là người còn lại của cặp). */
export function buildAnniversaryPushPayload(otherName: string, years: number): PushPayload {
  return {
    title: '💛 Kỷ niệm kết bạn',
    body: `Hôm nay tròn ${years} năm bạn kết bạn với ${otherName} trên SigMa 🎉`,
    data: { kind: 'anniversary', screen: 'calendar', years: String(years) }
  };
}

/** THUẦN — khóa 1 ngày theo GIỜ ĐỊA PHƯƠNG máy chủ (YYYY-MM-DD). Máy chủ SigMa chạy giờ VN. */
export function holidayDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 2 — LEDGER chống gửi trùng (theo loại + ngày). Interface để thay bản bền không đổi worker.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HolidaySendLedger {
  hasSent(key: string): boolean;
  markSent(key: string): void;
}

/** Bản in-memory MẶC ĐỊNH — đủ cho MVP (worker chạy liên tục 1 process). HẠN CHẾ: reset khi RESTART → có thể
 * gửi lại 1 lần/loại trong ngày sau restart (tác hại thấp). Thay bằng bản ghi đĩa/DB nếu cần "tuyệt đối 1 lần". */
export function createInMemoryHolidayLedger(): HolidaySendLedger {
  const sent = new Set<string>();
  return { hasSent: (k) => sent.has(k), markSent: (k) => void sent.add(k) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 3 — ORCHESTRATION (best-effort, no-throw). Structural-type deps → test bằng stub.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type EventNotificationType = 'BIRTHDAY' | 'ANNIVERSARY';

/** Deps cho push NGÀY LỄ (broadcast hệ thống). */
export interface HolidayPushDeps {
  resolveHolidays: HolidayResolver;
  /** Mọi agent ĐƯỢC nhận push lễ (mặc định: mọi agent còn sống, deletedAt null). */
  listRecipientAgentIds: () => Promise<number[]>;
  sendPush: (agentId: number, payload: PushPayload) => Promise<void>;
}

export interface BirthdayPushDeps {
  /** Mọi agent còn sống CÓ date_of_birth (id/name/dateOfBirth) — orchestration tự lọc trùng hôm nay. */
  listAgentsWithBirthday: () => Promise<Array<{ id: number; name: string; dateOfBirth: Date }>>;
  listAcceptedFriendIds: (agentId: number) => Promise<number[]>;
  sendPush: (agentId: number, payload: PushPayload) => Promise<void>;
  /** Ghi chuông trong-app (AgentNotification). recipient=người nhận, actor=người liên quan (celebrant/other). */
  recordNotification: (recipientAgentId: number, actorAgentId: number, type: EventNotificationType) => Promise<void>;
}

export interface AnniversaryPushDeps {
  /** Mọi quan hệ bạn bè ACCEPTED CÓ acceptedAt (2 tên + mốc). acceptedAt null (bạn cũ trước khi có cột) → adapter
   * đã loại ở query, KHÔNG tính kỷ niệm cho họ (không bịa mốc). */
  listAcceptedFriendships: () => Promise<Array<{ aId: number; aName: string; bId: number; bName: string; acceptedAt: Date }>>;
  sendPush: (agentId: number, payload: PushPayload) => Promise<void>;
  recordNotification: (recipientAgentId: number, actorAgentId: number, type: EventNotificationType) => Promise<void>;
}

export interface DailyEventPushDeps extends HolidayPushDeps, BirthdayPushDeps, AnniversaryPushDeps {}

export interface HolidayPushRunResult {
  holiday: HolidayInfo | null;
  sentToAgents: number;
  skipped?: 'not_holiday' | 'already_sent_today';
}

/** GỬI PUSH LỄ (broadcast). Best-effort no-throw. Chống trùng theo ledger key `holiday:<dateKey>`. */
export async function runHolidayPushForDate(date: Date, deps: HolidayPushDeps, ledger: HolidaySendLedger): Promise<HolidayPushRunResult> {
  const holiday = getHolidayFor(date, deps.resolveHolidays);
  if (!holiday) return { holiday: null, sentToAgents: 0, skipped: 'not_holiday' };

  const key = `holiday:${holidayDateKey(date)}`;
  if (ledger.hasSent(key)) return { holiday, sentToAgents: 0, skipped: 'already_sent_today' };
  ledger.markSent(key); // đánh dấu TRƯỚC vòng gửi — chống 2 tick chồng nhau gửi 2 lần.

  const payload = buildHolidayPushPayload(holiday);
  let agentIds: number[];
  try {
    agentIds = await deps.listRecipientAgentIds();
  } catch (err) {
    console.error('[bot-api] holiday-push: lấy danh sách agent nhận push lễ THẤT BẠI (best-effort):', err);
    return { holiday, sentToAgents: 0 };
  }
  let sentToAgents = 0;
  for (const agentId of agentIds) {
    try {
      await deps.sendPush(agentId, payload);
      sentToAgents += 1;
    } catch (err) {
      console.error(`[bot-api] holiday-push: gửi push lễ cho agentId=${agentId} THẤT BẠI (best-effort, tiếp tục):`, err);
    }
  }
  return { holiday, sentToAgents };
}

export interface BirthdayPushRunResult {
  celebrants: number;
  pushesSent: number;
  skipped?: 'already_sent_today';
}

/** GỬI PUSH SINH NHẬT tới BẠN BÈ. Best-effort no-throw. Chống trùng theo ledger key `bday:<dateKey>`. */
export async function runBirthdayPushForDate(date: Date, deps: BirthdayPushDeps, ledger: HolidaySendLedger): Promise<BirthdayPushRunResult> {
  const key = `bday:${holidayDateKey(date)}`;
  if (ledger.hasSent(key)) return { celebrants: 0, pushesSent: 0, skipped: 'already_sent_today' };
  ledger.markSent(key);

  let agents: Array<{ id: number; name: string; dateOfBirth: Date }>;
  try {
    agents = await deps.listAgentsWithBirthday();
  } catch (err) {
    console.error('[bot-api] holiday-push: lấy danh sách agent có sinh nhật THẤT BẠI (best-effort):', err);
    return { celebrants: 0, pushesSent: 0 };
  }
  const celebrants = agents.filter((a) => isBirthdayToday(a.dateOfBirth, date));
  let pushesSent = 0;
  for (const celebrant of celebrants) {
    let friendIds: number[];
    try {
      friendIds = await deps.listAcceptedFriendIds(celebrant.id);
    } catch (err) {
      console.error(`[bot-api] holiday-push: lấy bạn bè của celebrant=${celebrant.id} THẤT BẠI (best-effort, bỏ qua người này):`, err);
      continue;
    }
    const payload = buildBirthdayPushPayload(celebrant.name);
    for (const friendId of friendIds) {
      try {
        await deps.sendPush(friendId, payload);
        await deps.recordNotification(friendId, celebrant.id, 'BIRTHDAY');
        pushesSent += 1;
      } catch (err) {
        console.error(`[bot-api] holiday-push: báo sinh nhật celebrant=${celebrant.id} cho friend=${friendId} THẤT BẠI (best-effort, tiếp tục):`, err);
      }
    }
  }
  return { celebrants: celebrants.length, pushesSent };
}

export interface AnniversaryPushRunResult {
  pairs: number;
  pushesSent: number;
  skipped?: 'already_sent_today';
}

/** GỬI PUSH KỶ NIỆM KẾT BẠN tới CẢ 2 người. Best-effort no-throw. Chống trùng theo ledger key `anniv:<dateKey>`. */
export async function runAnniversaryPushForDate(date: Date, deps: AnniversaryPushDeps, ledger: HolidaySendLedger): Promise<AnniversaryPushRunResult> {
  const key = `anniv:${holidayDateKey(date)}`;
  if (ledger.hasSent(key)) return { pairs: 0, pushesSent: 0, skipped: 'already_sent_today' };
  ledger.markSent(key);

  let friendships: Array<{ aId: number; aName: string; bId: number; bName: string; acceptedAt: Date }>;
  try {
    friendships = await deps.listAcceptedFriendships();
  } catch (err) {
    console.error('[bot-api] holiday-push: lấy quan hệ bạn bè cho kỷ niệm THẤT BẠI (best-effort):', err);
    return { pairs: 0, pushesSent: 0 };
  }
  let pairs = 0;
  let pushesSent = 0;
  for (const fs of friendships) {
    const years = anniversaryYears(fs.acceptedAt, date);
    if (years === null) continue;
    pairs += 1;
    // Gửi cho A (nói về B) và B (nói về A). Mỗi phía độc lập best-effort.
    const sides: Array<{ to: number; other: number; otherName: string }> = [
      { to: fs.aId, other: fs.bId, otherName: fs.bName },
      { to: fs.bId, other: fs.aId, otherName: fs.aName }
    ];
    for (const s of sides) {
      try {
        await deps.sendPush(s.to, buildAnniversaryPushPayload(s.otherName, years));
        await deps.recordNotification(s.to, s.other, 'ANNIVERSARY');
        pushesSent += 1;
      } catch (err) {
        console.error(`[bot-api] holiday-push: báo kỷ niệm cho agent=${s.to} (với ${s.other}) THẤT BẠI (best-effort, tiếp tục):`, err);
      }
    }
  }
  return { pairs, pushesSent };
}

/** Chạy CẢ 3 loại cho 1 ngày (dùng chung 1 ledger). Mỗi loại tự best-effort/no-throw + tự chống trùng. */
export async function runDailyEventPush(
  date: Date,
  deps: DailyEventPushDeps,
  ledger: HolidaySendLedger
): Promise<{ holiday: HolidayPushRunResult; birthday: BirthdayPushRunResult; anniversary: AnniversaryPushRunResult }> {
  const holiday = await runHolidayPushForDate(date, deps, ledger);
  const birthday = await runBirthdayPushForDate(date, deps, ledger);
  const anniversary = await runAnniversaryPushForDate(date, deps, ledger);
  return { holiday, birthday, anniversary };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 4 — WORKER NỀN (hour-gated). CÙNG khuôn startDeletionSweepWorker: tick-lúc-start + setInterval + unref().
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const HOLIDAY_PUSH_CHECK_INTERVAL_MS = 30 * 60 * 1000; // kiểm mỗi 30 phút.
export const DEFAULT_HOLIDAY_PUSH_HOUR = 8; // 08:00 (Admin Demo chốt).

export interface HolidayPushWorkerOptions {
  intervalMs?: number;
  sendAtOrAfterHour?: number;
  ledger?: HolidaySendLedger;
  now?: () => Date;
}

/** Bắt đầu 1 worker hour-gated: chạy `run(now)` mỗi tick khi giờ địa phương >= giờ đích. Trả { stop }. No-throw. */
function startHourGatedWorker(run: (now: Date) => Promise<void>, options: HolidayPushWorkerOptions): { stop: () => void } {
  const intervalMs = options.intervalMs ?? HOLIDAY_PUSH_CHECK_INTERVAL_MS;
  const sendAtOrAfterHour = options.sendAtOrAfterHour ?? DEFAULT_HOLIDAY_PUSH_HOUR;
  const now = options.now ?? ((): Date => new Date());

  async function tick(): Promise<void> {
    const current = now();
    if (current.getHours() < sendAtOrAfterHour) return; // chưa tới giờ đích — chờ lượt sau.
    await run(current);
  }
  tick().catch((err) => console.error('[bot-api] holiday-push: tick lần chạy đầu lỗi:', err));
  const timer = setInterval(() => {
    tick().catch((err) => console.error('[bot-api] holiday-push: tick lỗi:', err));
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** Worker CHỈ ngày lễ (giữ cho tương thích/test cũ). */
export function startHolidayPushWorker(deps: HolidayPushDeps, options: HolidayPushWorkerOptions = {}): { stop: () => void } {
  const ledger = options.ledger ?? createInMemoryHolidayLedger();
  return startHourGatedWorker((current) => runHolidayPushForDate(current, deps, ledger).then(() => undefined), options);
}

/**
 * Worker CHÍNH (wire ở index.ts): mỗi ngày, sau giờ đích, gửi push+chuông cho lễ (broadcast) + sinh nhật (bạn
 * bè) + kỷ niệm (2 người). CỐ Ý dùng 1 ledger chung (chống trùng theo loại+ngày). No-throw.
 */
export function startDailyEventPushWorker(deps: DailyEventPushDeps, options: HolidayPushWorkerOptions = {}): { stop: () => void } {
  const ledger = options.ledger ?? createInMemoryHolidayLedger();
  return startHourGatedWorker((current) => runDailyEventPush(current, deps, ledger).then(() => undefined), options);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PHẦN 5 — ADAPTER DB THẬT (glue mỏng, không thuần). Wire ở index.ts.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Dựng deps THẬT từ Db production: resolveHolidays = nguồn lịch chung; danh sách agent/bạn bè từ Prisma; gửi
 * FCM qua sendPushToAgent (priority:'high' để máy nền/khóa màn vẫn nhận kịp); chuông qua createEventNotification.
 * `messagingClient` optional cho test/inject; production để trống (Firebase Admin SDK thật). */
export function buildDailyEventPushDeps(db: Db, messagingClient?: PushMessagingClient): DailyEventPushDeps {
  const sendPush = (agentId: number, payload: PushPayload): Promise<void> =>
    // priority:'high' — sự kiện 1 lần/ngày, cần tới nơi kịp lúc kể cả máy nền/khóa màn (giống notifyFriendsOfNewPost).
    sendPushToAgent(db, agentId, { ...payload, priority: 'high' }, messagingClient);

  const recordNotification = (recipientAgentId: number, actorAgentId: number, type: EventNotificationType): Promise<void> =>
    createEventNotification(db, recipientAgentId, actorAgentId, type);

  return {
    resolveHolidays: getHolidaysForDate,
    sendPush,
    recordNotification,
    listRecipientAgentIds: async () => {
      const rows = await db.agent.findMany({ where: { deletedAt: null }, select: { id: true } });
      return rows.map((r) => r.id);
    },
    listAgentsWithBirthday: async () => {
      const rows = await db.agent.findMany({ where: { deletedAt: null, dateOfBirth: { not: null } }, select: { id: true, name: true, dateOfBirth: true } });
      // dateOfBirth non-null đã lọc ở where — ép kiểu bỏ null cho khớp interface.
      return rows.map((r) => ({ id: r.id, name: r.name, dateOfBirth: r.dateOfBirth as Date }));
    },
    listAcceptedFriendIds: async (agentId: number) => {
      const rows = await db.friendRequest.findMany({
        where: { status: 'ACCEPTED', OR: [{ fromAgentId: agentId }, { toAgentId: agentId }] },
        select: { fromAgentId: true, toAgentId: true }
      });
      return rows.map((r) => (r.fromAgentId === agentId ? r.toAgentId : r.fromAgentId));
    },
    listAcceptedFriendships: async () => {
      const rows = await db.friendRequest.findMany({
        where: { status: 'ACCEPTED', acceptedAt: { not: null } },
        select: { fromAgentId: true, toAgentId: true, acceptedAt: true }
      });
      if (rows.length === 0) return [];
      const ids = new Set<number>();
      for (const r of rows) {
        ids.add(r.fromAgentId);
        ids.add(r.toAgentId);
      }
      const agents = await db.agent.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
      const nameById = new Map(agents.map((a) => [a.id, a.name]));
      return rows.map((r) => ({
        aId: r.fromAgentId,
        aName: nameById.get(r.fromAgentId) ?? '(đại lý)',
        bId: r.toAgentId,
        bName: nameById.get(r.toAgentId) ?? '(đại lý)',
        acceptedAt: r.acceptedAt as Date
      }));
    }
  };
}
