// CHỤP MÀN THẬT để LEAD tự nhìn (R200): danh sách Máy POS + hộp Gán máy POS của TID.
// Dùng ĐÚNG bản web đang phục vụ ở 57914 (dist-web vừa build), đăng nhập bằng phiên tạm rồi xoá.
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/pos-tid-16-11');
mkdirSync(RA, { recursive: true });
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'chup-pos-tid';
const tho = randomUUID();
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);

async function vaoMan(ten) {
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) {
    const v = await p.locator('aside').first().isVisible().catch(() => false);
    if (!v) { await nm.first().click(); await p.waitForTimeout(700); }
  }
  const m = p.locator('aside button', { hasText: ten }).first();
  if (!(await m.count())) throw new Error('không thấy menu: ' + ten);
  await m.click();
  await p.waitForTimeout(3500);
}

await vaoMan('Quản Lý Máy POS');
await p.screenshot({ path: resolve(RA, '01-danh-sach-pos.png') });
console.log('[chup] 01-danh-sach-pos.png');

// Đo nền thật của 6 dòng đầu + căn lề từng cột (số, không chỉ ảnh).
const do1 = await p.evaluate(() => {
  const tr = [...document.querySelectorAll('table tbody tr')].filter((r) => r.querySelector('td')).slice(0, 6);
  const nen = tr.map((r) => getComputedStyle(r).backgroundColor);
  const th = [...document.querySelectorAll('table thead tr:last-child th')].map((x) => ({
    ten: x.textContent.trim(), canh: getComputedStyle(x).textAlign, rong: Math.round(x.getBoundingClientRect().width)
  }));
  const td = tr[0] ? [...tr[0].querySelectorAll('td')].map((x) => getComputedStyle(x).textAlign) : [];
  return { nen, th, td, caoDong: tr.map((r) => Math.round(r.getBoundingClientRect().height)) };
});
console.log(JSON.stringify(do1, null, 1));

await vaoMan('Quản Lý TID');
await p.waitForTimeout(1500);
// Tab "Danh sách TID" (tab mặc định là KPI sau khi tách 15/11).
const tabDs = p.locator('button', { hasText: /^Danh sách TID$/ }).first();
if (await tabDs.count()) { await tabDs.click(); await p.waitForTimeout(2000); }
await p.screenshot({ path: resolve(RA, '02-tid.png') });

// Hộp GÁN MÁY POS — xem ô chọn máy dạng bảng + ô ngân hàng có gợi ý.
const nutGan = p.locator('[title="Gán máy POS"], button[aria-label="Gán máy POS"]').first();
if (await nutGan.count()) {
  await nutGan.click();
  await p.waitForTimeout(1800);
  await p.screenshot({ path: resolve(RA, '03-gan-may-dong.png') });
  const oMay = p.locator("[data-kiem='o-chon-may-pos']").first();
  if (await oMay.count()) {
    await oMay.click();
    await p.waitForTimeout(600);
    await p.screenshot({ path: resolve(RA, '04-gan-may-mo-bang.png') });
    const soDong = await p.locator("[data-kiem='o-chon-may-pos']").first().evaluate((el) => {
      const hop = el.closest('div.relative')?.parentElement;
      return hop ? hop.querySelectorAll('table tbody tr').length : -1;
    });
    console.log('[chup] bảng chọn máy POS: ' + soDong + ' dòng');
  } else console.log('[chup] ✗ KHÔNG thấy ô chọn máy POS (data-kiem)');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
} else console.log('[chup] (không có TID nào đang ở trạng thái gán được máy)');

await vaoMan('Doanh Số');
await p.waitForTimeout(3000);
await p.screenshot({ path: resolve(RA, '05-doanh-so.png') });
console.log('[chup] 02-tid.png · lỗi trang: ' + (loiTrang.length ? loiTrang.join(' | ') : 'không'));
await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
