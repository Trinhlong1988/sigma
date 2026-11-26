// ĐO HỘP THOẠI có phải cuộn không (Admin Demo: "full view không cuộn") — đo THẬT trên bản web đang phục vụ.
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/pos-tid-16-11');
mkdirSync(RA, { recursive: true });
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/sigma_thu';
const db = new pg.Client({ connectionString: u.toString() }); await db.connect();
const NHAN = 'do-hop-thoai'; const tho = randomUUID();
await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
  VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]);
const b = await chromium.launch();
const W = Number(process.env.DO_W || 1600), H = Number(process.env.DO_H || 950);
console.log('[do-hop] khổ màn ' + W + '×' + H);
const ctx = await b.newContext({ viewport: { width: W, height: H } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
async function vaoMan(ten) {
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) { const v = await p.locator('aside').first().isVisible().catch(() => false); if (!v) { await nm.first().click(); await p.waitForTimeout(700); } }
  await p.locator('aside button', { hasText: ten }).first().click(); await p.waitForTimeout(3000);
}
async function doHop(ten) {
  const r = await p.evaluate(() => {
    // Thân hộp thoại = div có class max-h-[..vh] + overflow-auto, nằm trong lớp phủ .fixed.inset-0 (Modal.tsx).
    const phu = [...document.querySelectorAll('div.fixed.inset-0')].pop();
    if (!phu) return null;
    const than = [...phu.querySelectorAll('div')].find((d) => /overflow-auto/.test(d.className) && /max-h-/.test(d.className));
    if (!than) return null;
    const hop = than.parentElement;
    const luoi = than.querySelector(':scope > div');
    const khoi = luoi ? [...luoi.children].map((c) => ({
      cao: Math.round(c.getBoundingClientRect().height),
      chu: (c.textContent || '').trim().slice(0, 28)
    })).sort((a, b) => b.cao - a.cao).slice(0, 5) : [];
    return {
      khoi,
      cao: Math.round(than.clientHeight), noiDung: Math.round(than.scrollHeight),
      thua: Math.round(than.scrollHeight - than.clientHeight),
      rongHop: Math.round(hop.getBoundingClientRect().width), rongManh: window.innerWidth
    };
  });
  console.log('  ' + ten + ': ' + (r ? `hộp rộng ${r.rongHop}/${r.rongManh}px · khung ${r.cao}px · nội dung ${r.noiDung}px · ${r.thua > 2 ? 'PHẢI CUỘN ' + r.thua + 'px' : 'KHÔNG cuộn'}` : 'không thấy thân hộp'));
  if (r && r.khoi && r.khoi.length) for (const k of r.khoi) console.log('      ' + String(k.cao).padStart(4) + 'px  ' + k.chu);
  return r;
}
await vaoMan('Quản Lý TID');
const tabDs = p.locator('button', { hasText: /^Danh sách TID$/ }).first();
if (await tabDs.count()) { await tabDs.click(); await p.waitForTimeout(2000); }
for (const [tip, ten] of [['Gán máy POS', 'Gán máy POS'], ['Giao cho khách', 'Giao cho khách'], ['Sửa TID', 'Sửa TID'], ['Phí bán thực tế', 'Phí bán thực tế']]) {
  const nut = p.locator(`[title="${tip}"]`).first();
  if (!(await nut.count())) { console.log('  ' + ten + ': không có nút trên dòng nào'); continue; }
  await nut.click(); await p.waitForTimeout(1600);
  await doHop(ten);
  await p.screenshot({ path: resolve(RA, 'hop-' + ten.replace(/\s+/g, '-').toLowerCase() + '.png') });
  await p.keyboard.press('Escape'); await p.waitForTimeout(600);
}
await vaoMan('Quản Lý Máy POS');
for (const [tip, ten] of [['Sửa hồ sơ máy', 'Sửa hồ sơ máy'], ['Bán máy (kèm TID nếu có)', 'Bán máy']]) {
  const nut = p.locator(`[title="${tip}"]`).first();
  if (!(await nut.count())) { console.log('  ' + ten + ': không có nút'); continue; }
  await nut.click(); await p.waitForTimeout(1600);
  await doHop(ten);
  await p.screenshot({ path: resolve(RA, 'hop-pos-' + ten.replace(/\s+/g, '-').toLowerCase() + '.png') });
  await p.keyboard.press('Escape'); await p.waitForTimeout(600);
}
await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]); await db.end();
