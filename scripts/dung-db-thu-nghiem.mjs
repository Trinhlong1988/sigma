// DỰNG DB THỬ NGHIỆM (Admin Demo chốt phương án B, 7/11).
//
// Mục đích: nối đường GHI của màn Doanh Số vào một BẢN SAO của sổ tiền, chạy đủ các ca (mượn TID,
// tách thẻ, trùng lô, bill hủy), đối chiếu từng con số, XONG mới dám chuyển sang DB thật.
//
// Nguyên tắc an toàn:
//   • Với DB THẬT: CHỈ ĐỌC (pg_dump). Không một câu lệnh ghi nào.
//   • DB thử có tên RIÊNG (mặc định `sigma_thu`) — không bao giờ trùng tên DB thật.
//   • Tạo lại là XOÁ SẠCH DB thử rồi dựng mới; có hỏi lại bằng cờ `--lam-lai` để không lỡ tay.
//   • Mọi bước in ra số thật (số bảng, số dòng) — không báo "xong" chung chung.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '..');
const BIN = process.env.PG_BIN || '<PG_BIN>\\pgsql\\bin';
const TEN_DB_THU = process.env.SIGMA_DB_THU || 'sigma_thu';
const LAM_LAI = process.argv.includes('--lam-lai');

function docEnv(ten) {
  if (process.env[ten]) return process.env[ten];
  const f = resolve(GOC, 'apps/quanly-api/.env');
  if (!existsSync(f)) return null;
  for (const d of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = new RegExp('^\\s*' + ten + '\\s*=\\s*(.+)\\s*$').exec(d);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

const URL_THAT = docEnv('DATABASE_URL');
if (!URL_THAT) {
  console.error('[db-thu] KHÔNG đọc được DATABASE_URL → DỪNG.');
  process.exit(1);
}
const u = new URL(URL_THAT);
const TEN_DB_THAT = u.pathname.replace(/^\//, '');
if (TEN_DB_THAT === TEN_DB_THU) {
  console.error('[db-thu] TÊN DB THỬ TRÙNG DB THẬT → DỪNG (chống tự bắn vào chân).');
  process.exit(1);
}
const urlThu = new URL(URL_THAT);
urlThu.pathname = '/' + TEN_DB_THU;

const moiTruong = { ...process.env, PGPASSWORD: decodeURIComponent(u.password || '') };
const chay = (file, args, ghiRa) =>
  new Promise((ok, loi) => {
    const c = spawn(resolve(BIN, file), args, { env: moiTruong, stdio: ghiRa ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let err = '';
    if (ghiRa) {
      c.stdout.pipe(ghiRa);
      c.stderr.on('data', (d) => (err += d.toString()));
    }
    c.on('error', loi);
    c.on('close', (ma) => (ma === 0 ? ok() : loi(new Error(file + ' thoát mã ' + ma + (err ? ' — ' + err.slice(0, 500) : '')))));
  });

const noi = async (url) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

try {
  if (!existsSync(resolve(BIN, 'pg_dump.exe'))) {
    console.error('[db-thu] KHÔNG thấy pg_dump ở', BIN, '→ DỪNG (cấm đoán đường dẫn).');
    process.exit(1);
  }

  // ── 1. Đọc hiện trạng DB THẬT (CHỈ ĐỌC) ──────────────────────────────────
  const dbThat = await noi(URL_THAT);
  const soBang = Number((await dbThat.query(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n);
  const co = Number((await dbThat.query(`SELECT pg_database_size($1)::bigint AS n`, [TEN_DB_THAT])).rows[0].n);
  console.log(`[db-thu] DB THẬT "${TEN_DB_THAT}": ${soBang} bảng · ${(co / 1024 / 1024).toFixed(1)} MB`);

  const daCo = Number(
    (await dbThat.query(`SELECT COUNT(*)::int n FROM pg_database WHERE datname=$1`, [TEN_DB_THU])).rows[0].n
  );
  if (daCo && !LAM_LAI) {
    console.log(`[db-thu] DB thử "${TEN_DB_THU}" ĐÃ CÓ. Muốn dựng lại từ đầu thì thêm cờ --lam-lai.`);
    await dbThat.end();
    process.exit(0);
  }
  if (daCo) {
    console.log(`[db-thu] Xoá DB thử cũ "${TEN_DB_THU}"…`);
    await dbThat.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [TEN_DB_THU]);
    await dbThat.query(`DROP DATABASE "${TEN_DB_THU}"`);
  }
  await dbThat.query(`CREATE DATABASE "${TEN_DB_THU}"`);
  console.log(`[db-thu] Đã tạo DB thử "${TEN_DB_THU}".`);
  await dbThat.end();

  // ── 2. Sao chép TOÀN BỘ (schema + dữ liệu) sang DB thử ───────────────────
  const thuMuc = resolve(GOC, 'backup-phien');
  mkdirSync(thuMuc, { recursive: true });
  const fileDump = resolve(thuMuc, `ban-sao-${TEN_DB_THAT}-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  console.log('[db-thu] Đang đổ bản sao (chỉ ĐỌC DB thật) →', fileDump);
  const { createWriteStream } = await import('node:fs');
  await chay('pg_dump.exe', ['-Fc', '-d', URL_THAT], createWriteStream(fileDump));
  console.log('[db-thu] Đang nạp vào DB thử…');
  await chay('pg_restore.exe', ['--no-owner', '--no-privileges', '-d', urlThu.toString(), fileDump]);

  // ── 3. CỔNG QA: so số bảng + số dòng vài bảng xương sống ─────────────────
  const dbThu = await noi(urlThu.toString());
  const dbThat2 = await noi(URL_THAT);
  const bangThu = Number((await dbThu.query(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n);
  const BANG_KIEM = ['users', 'customers', 'tids', 'pos_devices', 'transactions', 'los', 'fee_rates'];
  const sosanh = [];
  for (const b of BANG_KIEM) {
    try {
      const a = Number((await dbThat2.query(`SELECT COUNT(*)::int n FROM "${b}"`)).rows[0].n);
      const c = Number((await dbThu.query(`SELECT COUNT(*)::int n FROM "${b}"`)).rows[0].n);
      sosanh.push({ bang: b, that: a, thu: c, khop: a === c });
    } catch (e) {
      sosanh.push({ bang: b, loi: String(e.message).slice(0, 80) });
    }
  }
  console.log(`[db-thu] CỔNG QA: bảng thật ${soBang} · bảng thử ${bangThu}`);
  console.table(sosanh);
  const dat = bangThu === soBang && sosanh.every((x) => x.khop === true);
  await dbThu.end();
  await dbThat2.end();
  if (!dat) {
    console.error('[db-thu] *** BẢN SAO KHÔNG KHỚP *** — xem bảng trên, không dùng DB thử này.');
    process.exit(1);
  }
  console.log('[db-thu] ĐẠT. Chuỗi nối DB thử:');
  console.log('   ' + urlThu.toString().replace(/:[^:@/]+@/, ':***@'));
} catch (e) {
  console.error('[db-thu] LỖI:', e?.message ?? e);
  process.exitCode = 1;
}
