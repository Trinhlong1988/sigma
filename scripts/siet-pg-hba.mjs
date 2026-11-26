// SIẾT pg_hba.conf: loopback `trust` → `scram-sha-256` (Admin Demo duyệt 7/11 — nhóm 3).
//
// Vì sao: 3 dòng `local` / `127.0.0.1/32` / `::1/128` đang để `trust` = vào Postgres bằng SUPERUSER
// KHÔNG CẦN MẬT KHẨU. Cộng với tunnel `alpha-db.example.com → tcp://localhost:5432`, cloudflared nối vào
// bằng 127.0.0.1 nên rơi đúng vào dòng `trust`: ai qua được Cloudflare Access là superuser.
//
// Điều kiện đã KIỂM TRƯỚC (không đoán):
//   • vai trò `postgres` CÓ mật khẩu, lưu dạng SCRAM-SHA-256 → đổi sang scram-sha-256 là đăng nhập được.
//   • `password_encryption = scram-sha-256`.
//   • LAN 127.0.0.1/24 và Tailscale 100.64.0.0/10 VỐN ĐÃ dùng scram — chỉ loopback còn hở.
//
// An toàn: sao lưu file TRƯỚC; sau khi nạp lại cấu hình thì KIỂM 3 điều; hỏng bất kỳ điều nào → TỰ HOÀN NGUYÊN.
//   Chạy thử (không ghi):  node scripts/siet-pg-hba.mjs
//   Làm thật:              node scripts/siet-pg-hba.mjs --that
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '..');
const BIN = process.env.PG_BIN || '<PG_BIN>\\pgsql\\bin';
const HBA = process.env.PG_HBA || '<PG_BIN>\\data\\pg_hba.conf';
const THAT = process.argv.includes('--that');

const urlThat = (() => {
  const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
  const m = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t);
  if (!m) throw new Error('Không đọc được DATABASE_URL');
  return m[1].replace(/^["']|["']$/g, '');
})();

const noi = async () => {
  const c = new pg.Client({ connectionString: urlThat });
  await c.connect();
  return c;
};

/** Các dòng loopback đang để `trust` — chỉ đụng ĐÚNG những dòng này. */
function doiTrust(noiDung) {
  const dong = noiDung.split(/\r?\n/);
  const doi = [];
  const ra = dong.map((d, i) => {
    if (/^\s*#/.test(d) || !/\btrust\s*$/.test(d)) return d;
    const laLocal = /^\s*local\s+all\s/.test(d);
    const laV4 = /^\s*host\s+all\s+\S+\s+127\.0\.0\.1\/32\s/.test(d);
    const laV6 = /^\s*host\s+all\s+\S+\s+::1\/128\s/.test(d);
    if (!laLocal && !laV4 && !laV6) return d; // KHÔNG đụng dòng replication / dòng khác
    const moi = d.replace(/\btrust\s*$/, 'scram-sha-256');
    doi.push({ dong: i + 1, cu: d.trim(), moi: moi.trim() });
    return moi;
  });
  return { noiDung: ra.join('\n'), doi };
}

try {
  if (!existsSync(HBA)) {
    console.error('[siet-hba] KHÔNG thấy', HBA, '→ DỪNG.');
    process.exit(1);
  }
  const goc = readFileSync(HBA, 'utf8');
  const { noiDung: moi, doi } = doiTrust(goc);
  console.log(`[siet-hba] Sẽ đổi ${doi.length} dòng:`);
  for (const d of doi) console.log(`   dòng ${d.dong}:  ${d.cu}\n            →  ${d.moi}`);
  const conTrust = moi.split(/\r?\n/).filter((d) => !/^\s*#/.test(d) && /\btrust\s*$/.test(d));
  if (conTrust.length) {
    console.log('[siet-hba] (CỐ Ý giữ nguyên, không thuộc phạm vi đợt này):');
    for (const d of conTrust) console.log('   ', d.trim());
  }
  if (!THAT) {
    console.log('\n[siet-hba] ĐANG CHẠY THỬ — chưa ghi gì. Thêm --that để làm thật.');
    process.exit(0);
  }
  if (doi.length === 0) {
    console.log('[siet-hba] Không còn dòng loopback nào để siết — không ghi gì.');
    process.exit(0);
  }

  // ── SAO LƯU trước khi ghi ──
  const sao = HBA + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(HBA, sao);
  if (readFileSync(sao, 'utf8') !== goc) throw new Error('bản sao pg_hba không khớp bản gốc → DỪNG');
  console.log('[siet-hba] Đã sao lưu →', sao);

  writeFileSync(HBA, moi, 'utf8');
  let c = await noi();
  await c.query('SELECT pg_reload_conf()');
  await c.end();
  console.log('[siet-hba] Đã nạp lại cấu hình. Đang KIỂM…');

  const kiem = [];
  // (1) App VẪN nối được bằng chuỗi có mật khẩu
  try {
    const c2 = await noi();
    const r = await c2.query('SELECT 1 AS n');
    await c2.end();
    kiem.push({ muc: 'app nối DB bằng mật khẩu', dat: r.rows[0].n === 1 });
  } catch (e) {
    kiem.push({ muc: 'app nối DB bằng mật khẩu', dat: false, ghiChu: String(e.message).slice(0, 90) });
  }
  // (2) KHÔNG mật khẩu thì PHẢI bị từ chối
  // `-w` = TUYỆT ĐỐI không hỏi mật khẩu. Thiếu cờ này thì psql treo ở dấu nhắc "Password:" và cả kịch bản
  // đứng im vô hạn — đã dính thật 7/11, phải giết tiến trình bằng tay.
  const r2 = spawnSync(resolve(BIN, 'psql.exe'), ['-w', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PGPASSWORD: '', PGPASSFILE: 'KHONG-TON-TAI' }
  });
  const biTuChoi = r2.status !== 0;
  kiem.push({ muc: 'KHÔNG mật khẩu bị từ chối', dat: biTuChoi, ghiChu: (r2.stderr || '').split('\n')[0]?.slice(0, 80) });
  // (3) pg_dump (đường backup) vẫn chạy
  const r3 = spawnSync(resolve(BIN, 'pg_dump.exe'), ['-d', urlThat, '--schema-only', '-f', resolve(GOC, 'backup-phien', 'kiem-hba.sql')], { encoding: 'utf8' });
  kiem.push({ muc: 'pg_dump (đường backup) chạy được', dat: r3.status === 0, ghiChu: (r3.stderr || '').slice(0, 80) });

  console.table(kiem);
  const dat = kiem.every((k) => k.dat);
  if (!dat) {
    copyFileSync(sao, HBA);
    const c3 = await noi().catch(() => null);
    if (c3) {
      await c3.query('SELECT pg_reload_conf()');
      await c3.end();
    }
    console.error('[siet-hba] *** KIỂM KHÔNG ĐẠT → ĐÃ HOÀN NGUYÊN pg_hba.conf và nạp lại. ***');
    process.exit(1);
  }
  console.log('[siet-hba] ĐẠT. Loopback không còn vào được bằng superuser không mật khẩu.');
  console.log('[siet-hba] Muốn hoàn nguyên: chép', sao, '→', HBA, 'rồi chạy SELECT pg_reload_conf().');
} catch (e) {
  console.error('[siet-hba] LỖI:', e?.message ?? e);
  process.exitCode = 1;
}
