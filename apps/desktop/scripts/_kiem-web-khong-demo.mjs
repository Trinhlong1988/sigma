// [B308 24/11 — agent cổng chứng minh bản cũ XANH RỖNG] Bản cũ: giả /v1/auth/me, mọi API khác 401
// ⇒ bảng LUÔN rỗng ⇒ khẳng định "soDongBill === 0" LUÔN xanh (0 = 0 không chứng minh gì — L8), lại
// trỏ CỨNG 57913 (web nối SỔ THẬT). Bản mới: đăng nhập THẬT vào WEB THỬ, đòi bảng CÓ ≥1 dòng THẬT
// từ máy chủ, và KHÔNG còn số bịa/chữ demo nào. Đếm phép kiểm động (R198).
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) { console.error('[khong-demo] DUNG: chi chay DB THU, dang "' + DB_TEN + '".'); process.exit(3); }
let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-b308';
let b = null;
try {
  const tho = randomUUID();
  await db.query(
    'INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)'
    + " VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),$2)",
    [createHash('sha256').update(tho).digest('hex'), NHAN]);
  // Ngày có dữ liệu THẬT trong sổ thử — đặt kỳ xem vào đúng ngày đó (L2: tự dựng điều kiện).
  const ky = await db.query(
    "SELECT to_char((COALESCE(bill_txn_date, created_at)) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS d, count(*)::int AS n"
    + " FROM los WHERE status <> 'CANCELLED' GROUP BY 1 ORDER BY n DESC LIMIT 1");
  const ngayCo = ky.rows[0]?.d;
  chot(!!ngayCo && ky.rows[0].n > 0, 'sổ thử CÓ ngày có bill để đối chứng (' + ngayCo + ' · ' + (ky.rows[0]?.n ?? 0) + ' lô — L8 cấm xanh rỗng)');

  b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1700, height: 950 } });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  const p = await ctx.newPage();
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p);
  await dongHopThoaiChe(p);
  const menu = p.locator("[data-kiem='nut-menu']");
  if (await menu.count()) { await menu.first().click(); await p.waitForTimeout(500); }
  const link = p.getByText('Doanh Số', { exact: false }).filter({ visible: true }).first();
  if (await link.count()) await link.click({ timeout: 10000 }).catch(() => {});
  await p.waitForFunction(() => document.body.innerText.includes('Doanh số trước phí'), null, { timeout: 15000 });
  // đặt kỳ về ngày có dữ liệu rồi tải lại danh sách
  await p.evaluate(() => { /* màn tự tải theo kỳ mặc định; đặt kỳ qua ô ngày */ });
  const oTu = p.locator('input[type="date"]').first();
  const oDen = p.locator('input[type="date"]').nth(1);
  if (await oTu.count()) { await oTu.fill(ngayCo); await oDen.fill(ngayCo); await p.waitForTimeout(2500); }
  await dongHopThoaiChe(p);
  const d = await p.evaluate(() => {
    const dong = [...document.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length > 5).length;
    const t2 = document.body.innerText;
    return { soDong: dong, coChuChuaNoi: /chưa nối đường ghi|DEMO|bản dựng thử/i.test(t2), coSoBia: /538\.500\.000/.test(t2) };
  });
  console.log('      màn Doanh Số (web thử, đăng nhập thật):', JSON.stringify(d));
  chot(d.soDong > 0, 'bảng có ≥1 dòng THẬT từ máy chủ (' + d.soDong + ' dòng — đăng nhập thật, không mock)');
  chot(!d.coSoBia && !d.coChuChuaNoi, 'KHÔNG còn số bịa 538.500.000 / chữ demo trên màn');
  await p.screenshot({ path: resolve(GOC, 'apps/desktop/_anh-kiem/b308-khong-demo.png') });
} catch (e) {
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
} finally {
  await b?.close().catch(() => {});
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.end();
}
const CAN = 3;
console.log('\n[khong-demo] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM ' + so + '/' + CAN); }
console.log(loi.length ? '[khong-demo] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[khong-demo] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
