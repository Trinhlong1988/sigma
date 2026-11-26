// GHIM TIÊU ĐỀ CỘT (Admin Demo 13/11 "ghim tiêu đề") — cuộn sâu vẫn phải thấy tên cột.
// Bất biến mỗi màn: (1) khung bảng là ô cuộn thật; (2) sau khi cuộn sâu, hàng tiêu đề VẪN nằm trong
// tầm nhìn của khung bảng; (3) vẫn chỉ 1 ô cuộn dọc; (4) không cắt mất nội dung.
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { doMotMan, chupAnh } from './_do-ghim-tieu-de.mjs';
import pg from 'pg';
const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/ghim-tieu-de');
mkdirSync(RA, { recursive: true });
const MENU = (process.env.MAN || 'Quản Lý Doanh Thu & Công Nợ|Quản Lý TID|Quản Lý Máy POS|Quản Lý Nhân Sự|Quản Lý Hồ Sơ HKD').split('|');
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/sigma_thu';
const db = new pg.Client({ connectionString: u.toString() }); await db.connect();
const NHAN = 'kiem-ghim-tieu-de'; const tho = randomUUID();
await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
  VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]);
let soKiem = 0; const loi = []; const bang = [];
const chot = (ok, ten) => { soKiem++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
for (const ten of MENU) {
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) { const v = await p.locator('aside').first().isVisible().catch(() => false); if (!v) { await nm.first().click(); await p.waitForTimeout(700); } }
  const m = p.locator('aside button', { hasText: ten }).first();
  if (!(await m.count())) { chot(false, 'KHÔNG vào được màn "' + ten + '"'); continue; }
  await m.click(); await p.waitForTimeout(3500);
  console.log('\n== ' + ten);
  bang.push(...(await doMotMan(p, ten, chot)));
  await chupAnh(p, resolve(RA, ten.replace(/[^A-Za-zÀ-ỹ0-9]+/g, '-').toLowerCase() + '.png'), ten, chot);
}
chot(loiTrang.length === 0, 'không lỗi runtime: ' + loiTrang.slice(0, 2).join(' | '));
console.log('\n[ghim-tieu-de] SỐ PHÉP KIỂM (đếm động) = ' + soKiem);
console.log('[ghim-tieu-de] ảnh: ' + RA);
console.log(loi.length ? '[ghim-tieu-de] KẾT LUẬN: ' + loi.length + ' ĐỎ' : '[ghim-tieu-de] KẾT LUẬN: không phép kiểm nào đỏ');
await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]); await db.end();
if (loi.length) process.exitCode = 1;
