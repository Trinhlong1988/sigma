// [23/11 — ĐÃ CHỮA BỆNH] Sổ thật đã dịch mốc +7h (scripts/sql/dich-moc-thoi-gian-ve-chuan.sql) và bật
// `SIGMA_GIO_UTC=1` ⇒ phiên Postgres = UTC ⇒ GHI và ĐỌC đều ĐÚNG INSTANT. Bộ test này TRƯỚC ĐÂY khẳng
// định "bệnh" (ghi −7h / đọc raw +7h) để mọi chỗ né bệnh dựa trên sự thật đo được; nay nó khẳng định
// CHIỀU NGƯỢC LẠI: lệch phải bằng 0. Giữ nguyên tên trục (W/W2/Rr/Ro/B/W4) để lần sau còn đối chiếu.
// Bệnh tái phát (ai đó tắt cờ, hoặc nâng cấp prisma/pg đổi ngữ nghĩa) ⇒ bộ này ĐỎ ngay.
//
// PROBE + GUARD (audit 11/9, Agent 4): ĐO chính xác ngữ nghĩa timestamptz của stack Prisma 7 + @prisma/adapter-pg
// + pg trên máy này — 3 trục: (W) Prisma create GHI lệch gì; (Rr) $queryRawUnsafe ĐỌC Date lệch gì; (Rt) to_char
// UTC text đọc đúng không; (B) Prisma where {gte,lt} bound lệch gì. Bệnh nền đã có bằng chứng prod 10-11/9:
// ghi −7h / đọc raw +7h. Test này KHẲNG ĐỊNH hành vi hiện tại để mọi fix khác dựa trên sự thật đo được,
// và ĐỔ VỠ TO nếu nâng cấp prisma/pg đổi ngữ nghĩa âm thầm (R198).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPrisma, type Db } from '@sigma/database';

let db: Db;
const INV_ID = 987_654; // fixture uniq — DB throwaway dùng chung nhiều suite

// Instant thật: 2026-09-07 13:59:55 giờ HCM (+07) = 06:59:55Z
const REAL = new Date('2026-09-07T06:59:55.000Z');

beforeAll(async () => {
  db = createPrisma(process.env.DATABASE_URL);
  await db.$executeRawUnsafe(`DELETE FROM investor_advances WHERE investor_id = ${INV_ID}`);
});
afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM investor_advances WHERE investor_id = ${INV_ID}`);
  await db.$disconnect();
});

/** Đọc sự thật tuyệt đối trong DB: text UTC qua to_char — không đi qua serializer Date nào. */
async function storedUtcText(id: number): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ t: string }[]>(
    `SELECT to_char(advance_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t FROM investor_advances WHERE id = ${id}`
  );
  return rows[0].t;
}

describe('tz-adapter-semantics (Prisma 7 + adapter-pg + pg — máy chủ TZ +07)', () => {
  it('(W) Prisma create ghi timestamptz ĐÚNG INSTANT (sau khi bật SIGMA_GIO_UTC — trước 23/11 lệch −7h)', async () => {
    const created = await db.investorAdvance.create({
      data: { investorId: INV_ID, amount: 1n, advanceDate: REAL, note: 'tz-probe-W' }
    });
    const stored = await storedUtcText(created.id);
    // ĐÃ CHỮA: stored == đúng instant. Nếu thấy '2026-09-06T23:59:55.000Z' là bệnh −7h TÁI PHÁT
    // (cờ SIGMA_GIO_UTC bị tắt / .env mất) — phải sửa cấu hình, KHÔNG sửa test này.
    expect(stored).toBe('2026-09-07T06:59:55.000Z');
  });

  it('(W2) raw SQL $N::timestamptz với ISO string ghi ĐÚNG instant (đường persistLoBillTxnDate)', async () => {
    const created = await db.investorAdvance.create({
      data: { investorId: INV_ID, amount: 2n, advanceDate: new Date(), note: 'tz-probe-W2' }
    });
    await db.$executeRawUnsafe('UPDATE investor_advances SET advance_date = $1::timestamptz WHERE id = $2', REAL.toISOString(), created.id);
    expect(await storedUtcText(created.id)).toBe('2026-09-07T06:59:55.000Z');
  });

  it('(Rr) $queryRawUnsafe đọc timestamptz thành JS Date ĐÚNG (trước 23/11 lệch +7h)', async () => {
    const created = await db.investorAdvance.create({
      data: { investorId: INV_ID, amount: 3n, advanceDate: new Date(), note: 'tz-probe-Rr' }
    });
    await db.$executeRawUnsafe('UPDATE investor_advances SET advance_date = $1::timestamptz WHERE id = $2', REAL.toISOString(), created.id);
    const rows = await db.$queryRawUnsafe<{ d: Date }[]>(`SELECT advance_date AS d FROM investor_advances WHERE id = ${created.id}`);
    const got = rows[0].d instanceof Date ? rows[0].d : new Date(String(rows[0].d));
    const skewH = (got.getTime() - REAL.getTime()) / 3_600_000;
    expect(skewH).toBe(0); // ĐÃ CHỮA: đọc raw không còn lệch (trước đây +7h)
  });

  it('(Ro) Prisma ORM findUnique đọc LẠI đúng giá trị đã create (2 bệnh triệt tiêu → app "tưởng" đúng)', async () => {
    const created = await db.investorAdvance.create({
      data: { investorId: INV_ID, amount: 4n, advanceDate: REAL, note: 'tz-probe-Ro' }
    });
    const back = await db.investorAdvance.findUnique({ where: { id: created.id } });
    expect(back!.advanceDate.toISOString()).toBe(REAL.toISOString()); // round-trip khớp DÙ stored lệch −7h
  });

  it('(B) Prisma where {gte,lt} và raw-ISO bound nay CÙNG đúng instant → cả hai đường lọc đều tìm thấy', async () => {
    const created = await db.investorAdvance.create({
      data: { investorId: INV_ID, amount: 5n, advanceDate: REAL, note: 'tz-probe-B' }
    });
    // Prisma bound quanh REAL ±1 phút → tìm thấy (bound và stored cùng lệch −7h)
    const viaPrisma = await db.investorAdvance.findMany({
      where: { investorId: INV_ID, note: 'tz-probe-B', advanceDate: { gte: new Date(REAL.getTime() - 60_000), lt: new Date(REAL.getTime() + 60_000) } }
    });
    expect(viaPrisma.map((r) => r.id)).toContain(created.id);
    // ĐÃ CHỮA: raw ISO bound cũng tìm thấy (stored = đúng REAL). Trước 23/11 dòng này KHÔNG thấy.
    const viaRaw = await db.$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM investor_advances WHERE note = 'tz-probe-B' AND advance_date >= $1::timestamptz AND advance_date < $2::timestamptz`,
      new Date(REAL.getTime() - 60_000).toISOString(), new Date(REAL.getTime() + 60_000).toISOString()
    );
    expect(viaRaw.map((r) => r.id)).toContain(created.id);
  });
});

describe('tz-adapter-semantics — cột @default(now())/@updatedAt', () => {
  it('(W4) created_at/updated_at trên create: đo lệch so với đồng hồ DB (0h = DB-side đúng; -7h = client-side dính bệnh)', async () => {
    const created = await db.investorAdvance.create({
      data: { investorId: INV_ID, amount: 6n, advanceDate: REAL, note: 'tz-probe-W4' }
    });
    const rows = await db.$queryRawUnsafe<{ ch: number; uh: number }[]>(
      `SELECT round(EXTRACT(EPOCH FROM (created_at - clock_timestamp()))/3600.0)::float8 AS ch,
              round(EXTRACT(EPOCH FROM (updated_at - clock_timestamp()))/3600.0)::float8 AS uh
       FROM investor_advances WHERE id = ${created.id}`
    );
    // ĐÃ CHỮA: mốc do Prisma client sinh nay trùng đồng hồ DB (lệch 0h). Thấy -7 là bệnh tái phát.
    expect(rows[0].ch).toBe(0);
    expect(rows[0].uh).toBe(0);
  });
});
