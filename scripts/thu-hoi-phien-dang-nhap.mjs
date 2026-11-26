// THU HỒI PHIÊN ĐĂNG NHẬP (Admin Demo duyệt 7/11 — phương án C).
//
// Mục đích: buộc TẤT CẢ máy (8 máy desktop + mọi phiên web) đăng nhập lại từ đầu, để chuẩn hoá.
// KHÔNG đụng một dòng dữ liệu nghiệp vụ nào — chỉ bảng `login_sessions`.
//
// 3 TẦNG BẮT BUỘC (luật R202 của Admin Demo cho mọi thao tác ghi vào dữ liệu dùng chung):
//   1) SAO LƯU toàn bộ vùng sắp đụng ra file timestamped TRƯỚC khi ghi — không sao lưu được thì CẤM ghi.
//   2) Chỉ XOÁ đúng bảng phiên, liệt kê từng dòng sắp xoá.
//   3) CỔNG QA SAU GHI: đọc lại, so pre/post, lệch là ERROR + exit ≠ 0 + chỉ đường file sao lưu.
//
// Mặc định là CHẠY THỬ (dry-run). Muốn xoá thật phải thêm cờ `--that`.
//   node scripts/thu-hoi-phien-dang-nhap.mjs            → chỉ xem, không ghi
//   node scripts/thu-hoi-phien-dang-nhap.mjs --that     → xoá thật (có sao lưu + cổng QA)
// Dùng `pg` + SQL thuần, KHÔNG dùng Prisma: client Prisma sinh ra nằm ở packages/database/generated
// và chạy `prisma generate` trên máy đang phục vụ đã từng làm CHẾT server đang chạy. Việc ở đây chỉ là
// đọc + xoá 1 bảng phiên nên SQL thuần là đủ và ít rủi ro nhất.
import pg from 'pg';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const GOC = resolve(import.meta.dirname, '..');
const THAT = process.argv.includes('--that');
const THU_MUC_SAO_LUU = resolve(GOC, 'backup-phien');

// .env của quanly-api là nguồn DATABASE_URL (lớp LIVE — xem R201).
if (!process.env.DATABASE_URL) {
  const f = resolve(GOC, 'apps/quanly-api/.env');
  if (existsSync(f)) {
    for (const d of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/.exec(d);
      if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '');
    }
  }
}
if (!process.env.DATABASE_URL) {
  console.error('[thu-hoi-phien] KHÔNG đọc được DATABASE_URL → DỪNG (cấm đoán chuỗi nối DB).');
  process.exit(1);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const gio = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

try {
  // ── Đọc hiện trạng ──────────────────────────────────────────────────────────
  const truoc = (
    await db.query(
      `SELECT s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.device_info, s.device_id,
              u.username, u.full_name
         FROM login_sessions s
         LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.last_seen_at DESC`
    )
  ).rows;
  console.log(`[thu-hoi-phien] ĐANG CÓ ${truoc.length} phiên:`);
  for (const p of truoc) {
    console.log(
      `   · ${p.username ?? '?'} (${p.full_name ?? '?'}) · máy "${p.device_info ?? '—'}"` +
        ` · deviceId ${p.device_id ?? '—'} · thấy lần cuối ${gio(p.last_seen_at)} · hết hạn ${gio(p.expires_at)}`
    );
  }
  const theoMay = new Map();
  for (const p of truoc) {
    const k = p.device_info ?? '(không ghi tên máy)';
    theoMay.set(k, (theoMay.get(k) ?? 0) + 1);
  }
  console.log('[thu-hoi-phien] Theo MÁY:', JSON.stringify(Object.fromEntries(theoMay)));

  if (!THAT) {
    console.log('\n[thu-hoi-phien] ĐANG CHẠY THỬ — chưa ghi gì. Thêm cờ --that để xoá thật.');
    process.exit(0);
  }

  if (truoc.length === 0) {
    console.log('[thu-hoi-phien] Không có phiên nào để thu hồi — không ghi gì.');
    process.exit(0);
  }

  // ── TẦNG 1: SAO LƯU trước khi ghi ───────────────────────────────────────────
  mkdirSync(THU_MUC_SAO_LUU, { recursive: true });
  const dau = new Date().toISOString().replace(/[:.]/g, '-');
  const fileSaoLuu = resolve(THU_MUC_SAO_LUU, `login_sessions-${dau}.json`);
  writeFileSync(fileSaoLuu, JSON.stringify(truoc, null, 2), 'utf8');
  const doLai = JSON.parse(readFileSync(fileSaoLuu, 'utf8'));
  if (!Array.isArray(doLai) || doLai.length !== truoc.length) {
    console.error('[thu-hoi-phien] SAO LƯU KHÔNG ĐỌC LẠI ĐƯỢC ĐÚNG → DỪNG, không xoá gì.');
    process.exit(1);
  }
  console.log(`[thu-hoi-phien] Đã sao lưu ${doLai.length} dòng → ${fileSaoLuu}`);

  // ── TẦNG 2: XOÁ đúng phạm vi ────────────────────────────────────────────────
  const kq = await db.query('DELETE FROM login_sessions');
  console.log(`[thu-hoi-phien] Đã xoá ${kq.rowCount} phiên.`);

  // ── TẦNG 3: CỔNG QA sau ghi ─────────────────────────────────────────────────
  const sau = Number((await db.query('SELECT COUNT(*)::int AS n FROM login_sessions')).rows[0].n);
  const dat = kq.rowCount === truoc.length && sau === 0;
  console.log(`[thu-hoi-phien] CỔNG QA: trước ${truoc.length} · đã xoá ${kq.rowCount} · còn lại ${sau}`);
  if (!dat) {
    console.error('[thu-hoi-phien] *** SỐ LIỆU KHÔNG KHỚP *** — xem lại file sao lưu:', fileSaoLuu);
    process.exit(1);
  }
  console.log('[thu-hoi-phien] ĐẠT. Mọi máy sẽ phải đăng nhập lại ở lần thao tác kế tiếp.');
  console.log('[thu-hoi-phien] Muốn khôi phục: nạp lại từ', fileSaoLuu);
} catch (e) {
  console.error('[thu-hoi-phien] LỖI:', e?.message ?? e);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => undefined);
}
