// ĐO SỐ THANH CUỘN DỌC trong vùng nội dung (Admin Demo 13/11: "có 2 thang cuộn… tối ưu full giao diện").
// Bất biến: mỗi màn CHỈ ĐƯỢC CÓ 1 ô cuộn dọc, và KHÔNG được cắt mất nội dung.
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/mot-thanh-cuon');
mkdirSync(RA, { recursive: true });
const MENU = (process.env.MAN || 'Quản Lý TID').split('|');
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/sigma_thu';
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-thanh-cuon';
const tho = randomUUID();
await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
  VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]);
let soKiem = 0; const loi = [];
const chot = (ok, ten) => { soKiem++; if (!ok) { loi.push(ten); console.log('  >>> ĐỎ — ' + ten); } };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
for (const ten of MENU) {
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) { const v = await p.locator('aside').first().isVisible().catch(() => false); if (!v) { await nm.first().click(); await p.waitForTimeout(700); } }
  const m = p.locator('aside button', { hasText: ten }).first();
  if (!(await m.count())) { chot(false, 'KHÔNG VÀO ĐƯỢC màn "' + ten + '"'); continue; }
  await m.click(); await p.waitForTimeout(2600); await p.mouse.move(1500, 930); await p.waitForTimeout(400);
  const d = await p.evaluate(() => {
    const cuon = [];
    const duyet = (e) => {
      const c = getComputedStyle(e);
      const coCuon = (c.overflowY === 'auto' || c.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2;
      if (coCuon) cuon.push({ the: e.tagName.toLowerCase(), lop: (e.className || '').toString().slice(0, 48),
                              dau: e.getAttribute('data-kiem') || '', du: e.scrollHeight - e.clientHeight });
      for (const x of e.children) duyet(x);
    };
    const main = document.querySelector('main');
    if (main) duyet(main);
    const tv = document.documentElement;
    // CẮT MẤT NỘI DUNG: con nào của trang full nhô xuống dưới đáy <main> mà bản thân nó không cuộn được.
    const cat = [];
    const trang = document.querySelector('[data-trang-full]');
    if (trang && main) {
      const dayMain = main.getBoundingClientRect().bottom;
      for (const x of trang.children) {
        const r = x.getBoundingClientRect();
        const c = getComputedStyle(x);
        const tuCuon = c.overflowY === 'auto' || c.overflowY === 'scroll';
        // <main> tự cuộn được thì nội dung vẫn tới được — KHÔNG phải "cắt mất".
        const mainCuonDuoc = main.scrollHeight > main.clientHeight + 2;
        if (!tuCuon && !mainCuonDuoc && r.bottom > dayMain + 2) {
          cat.push({ nhan: (x.textContent || '').trim().slice(0, 30), thua: Math.round(r.bottom - dayMain) });
        }
      }
    }
    return { cuon, cat, laTrangFull: !!trang, trangCuon: tv.scrollHeight > tv.clientHeight + 2,
             mainDu: main ? main.scrollHeight - main.clientHeight : -1 };
  });
  console.log('\n== ' + ten + ' — ' + d.cuon.length + ' ô cuộn dọc' + (d.trangCuon ? ' + TRANG cũng cuộn' : ''));
  for (const x of d.cuon) console.log('     · ' + (x.dau || x.the) + '  dư ' + x.du + 'px  [' + x.lop + ']');
  chot(d.cuon.length <= 1, `${ten}: có ${d.cuon.length} ô cuộn dọc (chỉ được 1)`);
  chot(!d.trangCuon, `${ten}: TRANG vẫn cuộn (dư ${d.mainDu}px) — thành thanh cuộn thứ hai`);
  chot(d.cat.length === 0, `${ten}: ${d.cat.length} khối BỊ CẮT MẤT dưới đáy màn — ` +
    d.cat.map((x) => `"${x.nhan}" thừa ${x.thua}px`).join(' · '));
  if (!d.laTrangFull) console.log('     (màn này CHƯA bật data-trang-full)');
  await p.screenshot({ path: resolve(RA, ten.replace(/[^A-Za-zÀ-ỹ0-9]+/g, '-').toLowerCase() + '.png'), timeout: 20000 })
    .catch((e) => chot(false, ten + ': không chụp được ảnh'));
}
console.log('\n[thanh-cuon] SỐ PHÉP KIỂM (đếm động) = ' + soKiem);
console.log('[thanh-cuon] ảnh: ' + RA);
console.log(loi.length ? '[thanh-cuon] KẾT LUẬN: ' + loi.length + ' ĐỎ' : '[thanh-cuon] KẾT LUẬN: không phép kiểm nào đỏ');
await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
if (loi.length) process.exitCode = 1;
