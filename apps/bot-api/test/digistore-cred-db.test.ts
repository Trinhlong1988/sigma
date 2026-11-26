// CREDS DIGISTORE PER-MÃ — test ĐƯỜNG PROD trên throwaway Postgres (R198: khẳng định TỪNG câu raw SQL chạy được):
//  (a) setDigistoreCred + digistoreCredForTid round-trip (mã hoá/giải mã, base NULL → resolver để null cho default);
//  (b) chưa cấu hình → null;
//  (c) listQrTidsForPoll: mã có creds giải mã đúng; mã không creds → creds:null; password_enc hỏng → decryptError;
//  (d) resolveQrTidForBill: theo tidId, theo tên HKD (đơn nhất), mơ hồ → null;
//  (e) buildBaoCoPollDeps end-to-end (mock fetch per base): duyệt MỌI mã QR có creds → fetch per-mã → upsert kèm
//      source_tid_id; mã chưa cấu hình BỎ QUA (không fetch).
import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import {
  setDigistoreCred,
  digistoreCredForTid,
  listQrTidsForPoll,
  resolveQrTidForBill,
  buildBaoCoPollDeps,
  runBaoCoPoll
} from '../src/digistore-reconcile.js';
import { makePartner, makeTid } from './fixtures.js';

beforeAll(async () => {
  process.env.DIGISTORE_ENC_KEY = randomBytes(32).toString('base64');
  await ensureAlphaExtraSchema(getBotDb());
});
afterEach(() => { vi.unstubAllGlobals(); });

async function makeQrTid(hkdName: string) {
  const partner = await makePartner();
  const t = await makeTid({ partnerId: partner.id, hkdName });
  await getBotDb().$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, t.id);
  return t;
}

describe('setDigistoreCred / digistoreCredForTid — round-trip mã hoá', () => {
  it('(a) lưu (base rỗng) → resolve trả creds đã giải mã, base null, label = mã TID', async () => {
    const db = getBotDb();
    const t = await makeQrTid('HKD DEMO 40');
    await setDigistoreCred(db, { tidId: t.id, base: null, username: 'user@bv', password: 'secret-pw-123' });
    const c = await digistoreCredForTid(db, t.id);
    expect(c).not.toBeNull();
    expect(c!.email).toBe('user@bv');
    expect(c!.password).toBe('secret-pw-123');
    expect(c!.base).toBeNull(); // base rỗng → resolver để null → adapter dùng default chung
    expect(c!.label).toBe(t.tid);
    // password KHÔNG lưu plaintext trong bảng
    const rows = (await db.$queryRawUnsafe(`SELECT password_enc AS "pe" FROM qr_digistore_cred WHERE tid_id = $1`, t.id)) as Array<{ pe: string }>;
    expect(rows[0].pe).not.toContain('secret-pw-123');
    expect(rows[0].pe.split('.')).toHaveLength(3);
  });

  it('(a2) UPSERT: set lại đổi username/password/base (idempotent theo tid_id)', async () => {
    const db = getBotDb();
    const t = await makeQrTid('HKD DEMO 16');
    await setDigistoreCred(db, { tidId: t.id, username: 'u1', password: 'p1' });
    await setDigistoreCred(db, { tidId: t.id, base: 'https://custom.bv', username: 'u2', password: 'p2' });
    const c = await digistoreCredForTid(db, t.id);
    expect(c!.email).toBe('u2');
    expect(c!.password).toBe('p2');
    expect(c!.base).toBe('https://custom.bv');
    const cnt = (await db.$queryRawUnsafe(`SELECT count(*)::int AS "n" FROM qr_digistore_cred WHERE tid_id = $1`, t.id)) as Array<{ n: number }>;
    expect(cnt[0].n).toBe(1); // không nhân đôi
  });

  it('(b) chưa cấu hình → digistoreCredForTid trả null', async () => {
    const t = await makeQrTid('HKD CHUA CAU HINH');
    expect(await digistoreCredForTid(getBotDb(), t.id)).toBeNull();
  });
});

describe('listQrTidsForPoll — duyệt mã QR + creds', () => {
  it('(c) mã có creds giải mã; mã không creds → null; password_enc hỏng → decryptError', async () => {
    const db = getBotDb();
    const withCred = await makeQrTid('HKD CO CRED');
    const noCred = await makeQrTid('HKD KHONG CRED');
    const broken = await makeQrTid('HKD HONG CRED');
    await setDigistoreCred(db, { tidId: withCred.id, username: 'ok', password: 'okpw' });
    // Nhét thẳng password_enc RÁC (không đúng iv.tag.cipher) → giải mã phải ném → decryptError, KHÔNG chết cả lượt.
    await db.$executeRawUnsafe(
      `INSERT INTO qr_digistore_cred (tid_id, base, username, password_enc, updated_at) VALUES ($1, NULL, $2, $3, now())`,
      broken.id, 'u', 'rac-khong-hop-le'
    );
    const all = await listQrTidsForPoll(db);
    const m = new Map(all.map((r) => [r.tidId, r]));
    expect(m.get(withCred.id)!.creds!.email).toBe('ok');
    expect(m.get(noCred.id)!.creds).toBeNull();
    expect(m.get(noCred.id)!.decryptError).toBeUndefined();
    expect(m.get(broken.id)!.creds).toBeNull();
    expect(m.get(broken.id)!.decryptError).toBeTruthy();
  });
});

describe('resolveQrTidForBill', () => {
  it('(d) theo tidId', async () => {
    const t = await makeQrTid('HKD BY ID');
    const r = await resolveQrTidForBill(getBotDb(), { tidId: t.id });
    expect(r!.tidId).toBe(t.id);
  });
  it('(d) theo tên HKD đơn nhất', async () => {
    const t = await makeQrTid('HKD DUY NHAT ' + Date.now());
    const r = await resolveQrTidForBill(getBotDb(), { hkdName: t.hkdName });
    expect(r!.tidId).toBe(t.id);
  });
  it('(d) tên HKD trùng >1 mã → null (mơ hồ, không đoán)', async () => {
    const name = 'HKD TRUNG TEN ' + Date.now();
    await makeQrTid(name);
    await makeQrTid(name);
    expect(await resolveQrTidForBill(getBotDb(), { hkdName: name })).toBeNull();
  });
  // [Admin Demo 8/9] Bill QR bị app CẮT tên ("HKD DEMO 40 Ha..." thay vì "... Ha Noi") — trước đây so BẰNG nên
  // trượt → không check được báo-có. Nay khớp TIỀN TỐ khi duy nhất 1 mã.
  it('(d) tên HKD BỊ CẮT → khớp tiền tố khi duy nhất 1 mã', async () => {
    const suffix = Date.now();
    const t = await makeQrTid(`HKD DEMO 40 ${suffix} HA NOI`);
    const r = await resolveQrTidForBill(getBotDb(), { hkdName: `HKD DEMO 40 ${suffix} HA` });
    expect(r!.tidId).toBe(t.id);
  });
  it('(d) tên bị cắt mà NHIỀU mã cùng tiền tố → null (thà không đoán, đây là TIỀN)', async () => {
    const suffix = Date.now();
    await makeQrTid(`HKD CUNG TIEN TO ${suffix} HA NOI`);
    await makeQrTid(`HKD CUNG TIEN TO ${suffix} SAI GON`);
    expect(await resolveQrTidForBill(getBotDb(), { hkdName: `HKD CUNG TIEN TO ${suffix}` })).toBeNull();
  });
  it('(d) tên cắt QUÁ NGẮN (<10 ký tự) → null (không đủ căn cứ)', async () => {
    await makeQrTid('HKD ABCDEFGHIJK ' + Date.now());
    expect(await resolveQrTidForBill(getBotDb(), { hkdName: 'HKD AB' })).toBeNull();
  });
});

describe('buildBaoCoPollDeps — poll per-mã end-to-end (mock fetch per base)', () => {
  it('(e) duyệt mã có creds → fetch per-mã → upsert kèm source_tid_id; mã chưa cấu hình BỎ QUA', async () => {
    const db = getBotDb();
    const m1 = await makeQrTid('HKD MERCHANT 1');
    const m2 = await makeQrTid('HKD MERCHANT 2');
    const skipped = await makeQrTid('HKD SKIP NO CRED'); // KHÔNG set creds → bỏ qua
    const bill1 = 'POLL-M1-' + Date.now();
    const bill2 = 'POLL-M2-' + Date.now();
    await setDigistoreCred(db, { tidId: m1.id, base: 'https://m1.poll.test', username: 'u1', password: 'p1' });
    await setDigistoreCred(db, { tidId: m2.id, base: 'https://m2.poll.test', username: 'u2', password: 'p2' });

    // Mock fetch: login luôn OK; transaction/va trả bill khác nhau theo BASE (host) → không lẫn mã.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const s = String(url);
      const res = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as unknown as Response);
      if (s.includes('/user/login')) return res({ data: { access_token: 'tok.tok.tok' } });
      if (s.includes('m1.poll.test')) return res({ data: [{ bill_id: bill1, amount: 1000000, store_name: 'HKD MERCHANT 1', created_at: '2026-09-05 10:00:00', status: 'success' }] });
      if (s.includes('m2.poll.test')) return res({ data: [{ bill_id: bill2, amount: 2000000, store_name: 'HKD MERCHANT 2', created_at: '2026-09-05 11:00:00', status: 'success' }] });
      return res({ data: [] }); // mã lạ (nếu có) → rỗng, không ném
    }));

    const r = await runBaoCoPoll(buildBaoCoPollDeps(db));
    expect(r.ok).toBe(true);
    // DB dùng CHUNG toàn suite (fileParallelism:false) → có thể còn mã hỏng cred từ test khác → errors KHÔNG rỗng
    // tuyệt đối; chỉ khẳng định 2 merchant hợp lệ của test này KHÔNG nằm trong errors.
    expect(r.errors.some((e) => e.tid === m1.tid || e.tid === m2.tid)).toBe(false);

    const rows = (await db.$queryRawUnsafe(
      `SELECT bill_id AS "id", source_tid_id AS "src" FROM digistore_baoco WHERE bill_id IN ($1, $2)`,
      bill1, bill2
    )) as Array<{ id: string; src: number | null }>;
    const byId = new Map(rows.map((x) => [x.id, Number(x.src)]));
    expect(byId.get(bill1)).toBe(m1.id); // source_tid_id = mã QR nguồn
    expect(byId.get(bill2)).toBe(m2.id);
    // mã skipped không có creds → KHÔNG có báo-có nào gắn source = skipped.id
    const skc = (await db.$queryRawUnsafe(`SELECT count(*)::int AS "n" FROM digistore_baoco WHERE source_tid_id = $1`, skipped.id)) as Array<{ n: number }>;
    expect(skc[0].n).toBe(0);
  });
});
