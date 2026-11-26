// KIỂM PHẦN C — BẢO MẬT PHIÊN ĐĂNG NHẬP (Admin Demo duyệt 12/11).
//
// Chạy trên BẢN SAO `sigma_thu` (gọi API thật ở cổng 8795). Không chạm sổ thật.
// Kiểm 4 điều, mỗi điều là một bất biến có thể vỡ âm thầm:
//   1. DB KHÔNG còn lưu mã phiên thô — chỉ lưu bản băm SHA-256.
//   2. Cookie thô vẫn dùng được (nếu không thì vá bảo mật = khoá cửa chính).
//   3. Phiên tạo kiểu CŨ (mã thô trong DB) vẫn nhận, và được NÂNG CẤP sang bản băm.
//   4. NGỒI KHÔNG quá hạn → phiên chết với mã lỗi SESSION_IDLE (không phải lỗi mơ hồ).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const API = process.env.API_THU ?? 'http://127.0.0.1:8795';
const GOC = resolve(import.meta.dirname, '../../..');
const bam = (s: string): string => createHash('sha256').update(s).digest('hex');

let db: pg.Client;
const donDep: string[] = [];

async function dungPhien(userId: number, idTho: string, kieu: 'bam' | 'tho', nghiPhut = 0): Promise<void> {
  const id = kieu === 'bam' ? bam(idTho) : idTho;
  await db.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,$2,now(),now()+interval '12 hours', now() - ($3 || ' minutes')::interval, 'kiem-thu-phien')`,
    [id, userId, String(nghiPhut)]
  );
  donDep.push(id);
}

const goi = (sid: string, duong = '/v1/auth/me'): Promise<Response> =>
  fetch(API + duong, { headers: { cookie: `ql_session=${sid}`, 'X-SigMa-Client': '1' } });

describe('Bảo mật phiên đăng nhập', () => {
  let userId = 0;

  beforeAll(async () => {
    const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
    const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)![1].replace(/^["']|["']$/g, ''));
    u.pathname = '/sigma_thu';
    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    const r = await db.query(`SELECT id FROM users WHERE deleted_at IS NULL AND status='ACTIVE' ORDER BY id LIMIT 1`);
    userId = r.rows[0].id;
    // Máy chủ thử PHẢI đang chạy, nếu không mọi phép kiểm "xanh" đều vô nghĩa.
    const h = await fetch(API + '/v1/health', { headers: { 'X-SigMa-Client': '1' } });
    const j = (await h.json()) as { db?: string };
    expect(j.db, 'API thử phải trỏ BẢN SAO sigma_thu').toBe('sigma_thu');
  }, 60_000);

  afterAll(async () => {
    if (donDep.length) await db.query('DELETE FROM login_sessions WHERE id = ANY($1)', [donDep]);
    await db?.end();
  });

  it('Phiên BĂM: cookie thô vào được, DB KHÔNG chứa mã thô', async () => {
    const sid = randomUUID();
    await dungPhien(userId, sid, 'bam');
    const r = await goi(sid);
    expect(r.status, 'cookie thô phải vào được').toBe(200);
    const coTho = await db.query('SELECT 1 FROM login_sessions WHERE id=$1', [sid]);
    expect(coTho.rowCount, 'DB KHÔNG được chứa mã phiên thô').toBe(0);
    const coBam = await db.query('SELECT 1 FROM login_sessions WHERE id=$1', [bam(sid)]);
    expect(coBam.rowCount, 'DB phải chứa BẢN BĂM').toBe(1);
  }, 60_000);

  it('Mã phiên SAI thì bị từ chối', async () => {
    const r = await goi(randomUUID());
    expect(r.status).toBe(401);
  }, 60_000);

  it('Phiên kiểu CŨ (mã thô trong DB) vẫn nhận, và được NÂNG CẤP sang bản băm', async () => {
    const sid = randomUUID();
    await dungPhien(userId, sid, 'tho');
    const r = await goi(sid);
    expect(r.status, 'phiên cũ KHÔNG được bị đá ra giữa chừng').toBe(200);
    const conTho = await db.query('SELECT 1 FROM login_sessions WHERE id=$1', [sid]);
    const daBam = await db.query('SELECT 1 FROM login_sessions WHERE id=$1', [bam(sid)]);
    expect(conTho.rowCount, 'sau 1 lần dùng, bản thô phải biến mất').toBe(0);
    expect(daBam.rowCount, 'phải được nâng cấp thành bản băm').toBe(1);
    donDep.push(bam(sid));
  }, 60_000);

  it('NGỒI KHÔNG quá hạn → phiên chết, báo đúng mã SESSION_IDLE', async () => {
    const sid = randomUUID();
    // Mốc "thấy lần cuối" lùi 10 tiếng — chắc chắn vượt mọi ngưỡng idle hợp lý.
    await dungPhien(userId, sid, 'bam', 600);
    const r = await goi(sid);
    expect(r.status).toBe(401);
    const j = (await r.json()) as { error?: string; message?: string };
    expect(j.error, 'phải nói RÕ là nghỉ quá lâu, không phải lỗi mơ hồ').toBe('SESSION_IDLE');
    expect(j.message ?? '').toMatch(/nghỉ quá/);
    const con = await db.query('SELECT 1 FROM login_sessions WHERE id=$1', [bam(sid)]);
    expect(con.rowCount, 'phiên nghỉ quá hạn phải bị xoá khỏi DB').toBe(0);
  }, 60_000);

  it('Mốc thấy-lần-cuối phải SÁT giờ máy chủ (chống lệch múi giờ 7 tiếng)', async () => {
    const sid = randomUUID();
    await dungPhien(userId, sid, 'bam', 0);
    await goi(sid, '/v1/bills/manual?from=2026-11-01&to=2026-11-02');
    // So với now() CỦA CHÍNH DB — phép so TUYỆT ĐỐI. Bài kiểm cũ so 2 mốc đều lệch như nhau nên không
    // thấy gì; lệch 7 tiếng vẫn "xanh". Đây là bài kiểm bắt đúng lớp lỗi đó.
    const r = await db.query(
      'SELECT ABS(EXTRACT(EPOCH FROM (now() - last_seen_at)))::int AS lech FROM login_sessions WHERE id=$1',
      [bam(sid)]
    );
    const lech = Number(r.rows[0].lech);
    expect(lech, `mốc lệch ${lech}s so với giờ máy chủ — phải < 60s`).toBeLessThan(60);
  }, 60_000);

  it('Còn thao tác THẬT thì phiên KHÔNG tự chết (mốc thấy-lần-cuối được trượt)', async () => {
    const sid = randomUUID();
    await dungPhien(userId, sid, 'bam', 0);
    // Dùng đường NGHIỆP VỤ (không phải /me hay nhịp tim) — đó mới là "người dùng đang làm việc".
    const duong = '/v1/bills/manual?from=2026-11-01&to=2026-11-02';
    expect((await goi(sid, duong)).status).toBe(200);
    const truoc = (await db.query('SELECT last_seen_at FROM login_sessions WHERE id=$1', [bam(sid)])).rows[0].last_seen_at;
    await new Promise((r) => setTimeout(r, 1200));
    expect((await goi(sid, duong)).status).toBe(200);
    const sau = (await db.query('SELECT last_seen_at FROM login_sessions WHERE id=$1', [bam(sid)])).rows[0].last_seen_at;
    expect(new Date(sau).getTime(), 'mốc thấy-lần-cuối phải được cập nhật').toBeGreaterThan(new Date(truoc).getTime());
  }, 60_000);

  it('Lượt gọi TỰ ĐỘNG của app KHÔNG được coi là thao tác (nếu không, timeout-ngồi-không vô dụng)', async () => {
    const sid = randomUUID();
    await dungPhien(userId, sid, 'bam', 0);
    const truoc = (await db.query('SELECT last_seen_at FROM login_sessions WHERE id=$1', [bam(sid)])).rows[0].last_seen_at;
    await new Promise((r) => setTimeout(r, 1200));
    // nhịp tim + realtime + /me — cả ba đều là app TỰ gọi theo nhịp
    await fetch(API + '/v1/auth/heartbeat', { method: 'POST', headers: { cookie: `ql_session=${sid}`, 'X-SigMa-Client': '1' } });
    await goi(sid, '/v1/realtime/tokens');
    await goi(sid, '/v1/auth/me');
    const sau = (await db.query('SELECT last_seen_at FROM login_sessions WHERE id=$1', [bam(sid)])).rows[0].last_seen_at;
    expect(new Date(sau).getTime(), 'nhịp tim/realtime/me KHÔNG được gia hạn phiên').toBe(new Date(truoc).getTime());
  }, 60_000);
});
