// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// BÀI KIỂM — TÌM KIẾM KHÔNG PHÂN BIỆT HOA/THƯỜNG TRÊN MỌI MÀN DANH SÁCH
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// VÌ SAO phải có bài kiểm này (đừng xoá, đừng "tối ưu" về mode:'insensitive'):
//   Database `sigma` (và bản sao `sigma_thu`) có collation = "C". Với collation "C", `lower()` của
//   Postgres CHỈ gập được chữ ASCII; `ILIKE` = `lower() LIKE lower()` nên cũng vậy. Prisma
//   `{ contains, mode:'insensitive' }` sinh ra ĐÚNG `ILIKE` → gõ "nguyễn" ra 0 dòng trong khi "NGUYỄN" ra 10.
//   Cách chữa (src/tim-kiem-hoa-thuong.ts): ép `COLLATE "und-x-icu"` ở CẢ HAI VẾ của `lower()`.
//
// CHẠY TRÊN BẢN SAO `sigma_thu` qua API thử ở cổng 8795 — KHÔNG chạm sổ thật `sigma`.
// Phiên tạm được chèn thẳng vào `login_sessions` (id = SHA-256 của một UUID, cookie gửi UUID thô) theo đúng
// khuôn `apps/quanly-api/test/phien-bao-mat.test.ts`; `device_info` gắn nhãn riêng và CUỐI BÀI tự xoá + đếm lại.
//
// R198 — mọi phép kiểm được ĐẾM ĐỘNG (không hard-code con số): mỗi lần `ghi()` là một phép kiểm thật sự đã chạy;
// cuối bài in ra bảng kết quả + TỔNG SỐ. Phép kiểm ném lỗi vẫn bị tính là một phép kiểm ĐỎ, không bị nuốt.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const API = process.env['API_THU'] ?? 'http://127.0.0.1:8795';
const GOC = resolve(import.meta.dirname, '../../..');
const NHAN_PHIEN = 'kiem-tim-kiem-hoa-thuong';
const bam = (s: string): string => createHash('sha256').update(s).digest('hex');

let db: pg.Client;
let cookieTho = '';
const donDep: string[] = [];

// ── sổ ghi phép kiểm (ĐẾM ĐỘNG) ───────────────────────────────────────────────────────────────────────────────
interface PhepKiem { ten: string; dat: boolean; chiTiet: string }
const soKiem: PhepKiem[] = [];
function ghi(ten: string, dat: boolean, chiTiet: string): void {
  soKiem.push({ ten, dat, chiTiet });
}
/** Ghi phép kiểm RỒI khẳng định — thất bại vẫn nằm trong sổ (không "không có finding" vì chưa chạy). */
function ktra(ten: string, dat: boolean, chiTiet: string): void {
  ghi(ten, dat, chiTiet);
  expect(dat, `${ten} — ${chiTiet}`).toBe(true);
}

async function goiApi(duong: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(API + duong, { headers: { cookie: `ql_session=${cookieTho}`, 'X-SigMa-Client': '1' } });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, body };
}

/** Gọi 1 màn danh sách với từ khoá → trả SỐ bản ghi (dùng `total` nếu API có phân trang, không thì đếm `data`). */
async function demKetQua(duong: string, tuKhoa: string): Promise<number> {
  const { status, body } = await goiApi(`${duong}${duong.includes('?') ? '&' : '?'}search=${encodeURIComponent(tuKhoa)}`);
  if (status !== 200) throw new Error(`${duong} trả HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (body['ok'] !== true) throw new Error(`${duong} trả ok=false: ${JSON.stringify(body).slice(0, 300)}`);
  const data = body['data'];
  if (!Array.isArray(data)) throw new Error(`${duong} không trả mảng data`);
  return typeof body['total'] === 'number' ? (body['total'] as number) : data.length;
}

/** Đếm trực tiếp trên DB bằng ILIKE — để CHỨNG MINH cách cũ (mode:'insensitive') thật sự hỏng. */
async function demBangIlike(bang: string, cot: string[], tuKhoa: string): Promise<number> {
  const dk = cot.map((c) => `coalesce("${c}",'') ILIKE $1`).join(' OR ');
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${bang}" WHERE deleted_at IS NULL AND (${dk})`, [`%${tuKhoa}%`]);
  return r.rows[0]!.n;
}

// ── các màn kiểm: cùng một từ khoá gõ CHỮ THƯỜNG và gõ CHỮ HOA phải ra CÙNG số kết quả và > 0 ─────────────────
const MAN = [
  { ten: 'TID', duong: '/v1/tids', bang: 'tids', cot: ['tid', 'mid', 'hkd_name'], thuong: 'nguyễn', hoa: 'NGUYỄN' },
  { ten: 'Khách hàng', duong: '/v1/customers', bang: 'customers', cot: ['code', 'nickname', 'full_name', 'phone'], thuong: 'nguyễn', hoa: 'NGUYỄN' },
  { ten: 'Nhà đầu tư', duong: '/v1/investors', bang: 'investors', cot: ['code', 'full_name', 'nickname', 'phone'], thuong: 'thông', hoa: 'THÔNG' },
  { ten: 'Nhà đầu tư (chữ Đ)', duong: '/v1/investors', bang: 'investors', cot: ['code', 'full_name', 'nickname', 'phone'], thuong: 'đàm', hoa: 'ĐÀM' }
] as const;

describe('Tìm kiếm KHÔNG phân biệt hoa/thường (DB collation "C")', () => {
  beforeAll(async () => {
    const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
    const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)![1]!.replace(/^["']|["']$/g, ''));
    u.pathname = '/sigma_thu'; // BẢN SAO — tuyệt đối không ghi vào sổ thật
    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();

    // Máy chủ thử PHẢI đang chạy và PHẢI trỏ bản sao, nếu không mọi phép kiểm "xanh" đều vô nghĩa.
    const h = await fetch(API + '/v1/health', { headers: { 'X-SigMa-Client': '1' } });
    const j = (await h.json()) as { db?: string };
    expect(j.db, 'API thử phải trỏ BẢN SAO sigma_thu').toBe('sigma_thu');

    // Phiên tạm của 1 user ADMIN (đủ quyền xem mọi danh sách).
    const r = await db.query<{ id: number }>(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE u.deleted_at IS NULL AND u.status='ACTIVE' AND r.code='ADMIN' ORDER BY u.id LIMIT 1`
    );
    expect(r.rowCount, 'bản sao phải có ít nhất 1 user ADMIN đang hoạt động').toBeGreaterThan(0);
    cookieTho = randomUUID();
    const id = bam(cookieTho);
    await db.query(
      `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
       VALUES ($1,$2,now(),now()+interval '2 hours', now(), $3)`,
      [id, r.rows[0]!.id, NHAN_PHIEN]
    );
    donDep.push(id);
  }, 120_000);

  afterAll(async () => {
    // Tự dọn + ĐẾM LẠI xem còn sót phiên nào mang nhãn của bài kiểm không.
    if (donDep.length) await db.query('DELETE FROM login_sessions WHERE id = ANY($1)', [donDep]);
    const con = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM login_sessions WHERE device_info = $1', [NHAN_PHIEN]);
    const sot = con.rows[0]!.n;
    ghi('Dọn phiên tạm', sot === 0, `còn sót ${sot} phiên mang nhãn "${NHAN_PHIEN}" (phải = 0)`);
    await db.end();

    const dat = soKiem.filter((x) => x.dat).length;
    // eslint-disable-next-line no-console
    console.log(
      '\n──────── SỔ PHÉP KIỂM (đếm động) ────────\n' +
        soKiem.map((x, i) => `${String(i + 1).padStart(2)}. [${x.dat ? 'ĐẠT ' : 'HỎNG'}] ${x.ten} — ${x.chiTiet}`).join('\n') +
        `\n──────── TỔNG: ${soKiem.length} phép kiểm · ĐẠT ${dat} · HỎNG ${soKiem.length - dat} ────────\n`
    );
    if (sot !== 0) throw new Error(`CÒN SÓT ${sot} phiên tạm mang nhãn "${NHAN_PHIEN}" — phải xoá hết.`);
  }, 120_000);

  it('Chứng minh LẠI lỗi gốc: ILIKE (= mode:\'insensitive\') KHÔNG gập hoa/thường tiếng Việt', async () => {
    // Nếu một ngày nào đó ILIKE tự nhiên chạy đúng (đổi collation DB chẳng hạn) thì phép kiểm này ĐỎ —
    // đó là tín hiệu để xem lại cả hạ tầng tìm kiếm, KHÔNG phải lỗi vặt.
    let soCapLech = 0;
    for (const m of MAN) {
      const a = await demBangIlike(m.bang, [...m.cot], m.thuong);
      const b = await demBangIlike(m.bang, [...m.cot], m.hoa);
      if (a !== b) soCapLech++;
      ghi(`[nền] ILIKE "${m.thuong}" vs "${m.hoa}" trên ${m.bang}`, true, `thường=${a} · HOA=${b}${a === b ? '' : '  ← LỆCH (đúng như dự đoán)'}`);
    }
    ktra('ILIKE thật sự hỏng', soCapLech > 0, `${soCapLech}/${MAN.length} cặp từ khoá cho kết quả LỆCH khi dùng ILIKE`);
  }, 120_000);

  for (const m of MAN) {
    it(`${m.ten}: gõ "${m.thuong}" và "${m.hoa}" phải ra CÙNG số kết quả và > 0`, async () => {
      const a = await demKetQua(m.duong, m.thuong);
      const b = await demKetQua(m.duong, m.hoa);
      ktra(`${m.ten} — chữ thường ra kết quả`, a > 0, `"${m.thuong}" → ${a} bản ghi`);
      ktra(`${m.ten} — CHỮ HOA ra kết quả`, b > 0, `"${m.hoa}" → ${b} bản ghi`);
      ktra(`${m.ten} — hai cách gõ BẰNG NHAU`, a === b, `"${m.thuong}"=${a} vs "${m.hoa}"=${b}`);
    }, 120_000);
  }

  it('Gõ HOA/thường LẪN LỘN cũng ra đúng ngần ấy kết quả', async () => {
    // Trộn hoa/thường từng ký tự: bắt lỗi "chỉ gập được 1 chiều".
    for (const m of MAN) {
      const tron = [...m.thuong].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase())).join('');
      const chuan = await demKetQua(m.duong, m.thuong);
      const lan = await demKetQua(m.duong, tron);
      ktra(`${m.ten} — gõ lẫn lộn "${tron}"`, lan === chuan, `lẫn lộn=${lan} vs chuẩn=${chuan}`);
    }
  }, 120_000);

  it('Từ khoá chứa ký tự đại diện (% _ \\) KHÔNG làm vỡ truy vấn và KHÔNG biến thành "khớp mọi thứ"', async () => {
    for (const duong of ['/v1/tids', '/v1/customers', '/v1/investors']) {
      const tatCa = await demKetQua(duong, ''); // không từ khoá = toàn bộ danh sách
      for (const xau of ['%', '_', '%%', '\\', "100%", "a%b_c"]) {
        const n = await demKetQua(duong, xau); // ném lỗi ở đây = phép kiểm ĐỎ, không nuốt
        ktra(`${duong} — từ khoá "${xau}" được coi là CHỮ THƯỜNG`, n < tatCa || tatCa === 0, `"${xau}" → ${n} bản ghi (toàn bộ danh sách = ${tatCa})`);
      }
    }
  }, 120_000);

  it('KHÔNG có từ khoá → hành vi GIỮ NGUYÊN (trả toàn bộ danh sách, không bị bộ lọc rỗng quét sạch)', async () => {
    for (const duong of ['/v1/tids', '/v1/customers', '/v1/investors']) {
      const khongGoi = await goiApi(duong); // không truyền tham số search
      const rong = await demKetQua(duong, ''); // truyền search= rỗng
      const n = typeof khongGoi.body['total'] === 'number' ? (khongGoi.body['total'] as number) : (khongGoi.body['data'] as unknown[]).length;
      ktra(`${duong} — không có từ khoá vẫn ra dữ liệu`, n > 0, `${n} bản ghi`);
      ktra(`${duong} — search= rỗng tương đương không truyền`, rong === n, `rỗng=${rong} vs không truyền=${n}`);
    }
  }, 120_000);

  it('Kết quả từ API KHỚP ĐÚNG số đo trực tiếp trên DB (không phải trùng hợp)', async () => {
    for (const m of MAN) {
      const dk = m.cot.map((c) => `lower(coalesce("${c}",'') COLLATE "und-x-icu") LIKE lower($1::text COLLATE "und-x-icu")`).join(' OR ');
      const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${m.bang}" WHERE deleted_at IS NULL AND (${dk})`, [`%${m.thuong}%`]);
      const soDb = r.rows[0]!.n;
      const soApi = await demKetQua(m.duong, m.thuong);
      // API còn lọc thêm (vd khách CANCELLED bị ẩn) nên chỉ khẳng định API ⊆ DB và cả hai đều > 0.
      ktra(`${m.ten} — API khớp số đo DB`, soApi > 0 && soApi <= soDb, `API=${soApi} · DB(lower+ICU)=${soDb}`);
    }
  }, 120_000);

  it('Đã chạy ĐỦ phép kiểm (đếm động, không hard-code)', () => {
    const hong = soKiem.filter((x) => !x.dat);
    ktra('Mọi phép kiểm đều ĐẠT', hong.length === 0, `${soKiem.length} phép kiểm đã chạy, ${hong.length} hỏng${hong.length ? ': ' + hong.map((x) => x.ten).join(' | ') : ''}`);
    expect(soKiem.length, 'phải có phép kiểm thật sự chạy (0 = bài kiểm không chạy chứ không phải "không có lỗi")').toBeGreaterThan(20);
  });
});
