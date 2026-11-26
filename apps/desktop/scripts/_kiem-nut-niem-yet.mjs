// KIỂM NÚT "Dùng giá niêm yết làm giá bán" ở màn Thêm bill (DB thử): bấm THẬT, rồi soi DB + soi lại màn hình.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
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
const NHAN = 'kiem-nut-niem-yet'; const tho = randomUUID();
await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
  VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]);
let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

// TID thử: lấy TID ACTIVE của ngân hàng AB Bank (giống kịch bản trước) và XOÁ sạch giá bán thực tế để tái hiện
// đúng tình huống "chưa đặt giá bán".
const tid = (await db.query(
  "SELECT t.id, t.tid, t.bank_id, b.name AS bank_name, b.code AS bank_code FROM tids t JOIN banks b ON b.id=t.bank_id WHERE t.deleted_at IS NULL AND t.status='ACTIVE' ORDER BY t.id LIMIT 1")).rows[0];
const truoc = await db.query('SELECT count(*)::int AS n FROM tid_sell_fees WHERE tid_id = $1 AND deleted_at IS NULL', [tid.id]);
await db.query('UPDATE tid_sell_fees SET deleted_at = now() WHERE tid_id = $1 AND deleted_at IS NULL', [tid.id]);
console.log('  TID thử: ' + tid.tid + ' (' + tid.bank_name + ') · giá bán thực tế trước khi dọn: ' + truoc.rows[0].n + ' dòng');

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
const nm = p.locator("[data-kiem='nut-menu']");
if (await nm.count()) { const v = await p.locator('aside').first().isVisible().catch(() => false); if (!v) { await nm.first().click(); await p.waitForTimeout(700); } }
await p.locator('aside button', { hasText: 'Doanh Số' }).first().click(); await p.waitForTimeout(3000);
await p.locator('button', { hasText: 'Thêm bill mới' }).first().click(); await p.waitForTimeout(2500);
async function chon(goi, chu) {
  const o = p.locator(`input[placeholder*="${goi}"]`).first();
  await o.focus(); await o.fill(chu); await p.waitForTimeout(800);
  const muc = o.locator('xpath=ancestor::div[contains(@class,"relative")][2]').locator('ul li').filter({ hasText: chu }).first();
  if (await muc.count() === 0) return false;
  await muc.click({ force: true }); await p.waitForTimeout(2500); return true;
}
// [19/11] Ô chọn hiện MÃ VIẾT TẮT (B174), gõ tên đầy đủ không khớp — cổng đỏ câm từ 16/11 vì chưa nối cổng ship.
const nhanNH = tid.bank_code ?? tid.bank_name;
chot(await chon('ngân hàng', nhanNH), 'chọn ngân hàng ' + nhanNH);
chot(await chon('Gõ tên HKD', tid.tid), 'chọn TID ' + tid.tid);
// [24/11] Loại thẻ nay là SearchSelect (có logo), KHÔNG còn <select> — chọn thẻ ĐẦU TIÊN qua dropdown nếu
// chưa được tự điền (thẻ mặc định). Đọc data-gia-tri của wrapper data-kiem="o-loai-the".
const daChonThe = await p.evaluate(() => document.querySelector('[data-kiem="o-loai-the"]')?.getAttribute('data-gia-tri') || '');
if (!daChonThe) {
  const inpThe = p.locator('[data-kiem="o-loai-the"] input[data-kiem="searchselect-input"]').first();
  if (await inpThe.count()) {
    await inpThe.focus(); await p.waitForTimeout(500);
    const li1 = p.locator('[data-kiem="o-loai-the"] ul li').first();
    if (await li1.count()) { await li1.click({ force: true }); await p.waitForTimeout(1500); }
  }
}
const nut = p.locator("[data-kiem='nut-dat-gia-niem-yet']");
chot(await nut.count() > 0, 'hiện nút "Dùng giá niêm yết làm giá bán" khi TID chưa có giá bán');
await p.screenshot({ path: resolve(RA, '09-truoc-khi-bam-niem-yet.png') });
await nut.click(); await p.waitForTimeout(3500);
const sau = await db.query('SELECT count(*)::int AS n FROM tid_sell_fees WHERE tid_id = $1 AND deleted_at IS NULL', [tid.id]);
chot(sau.rows[0].n > 0, 'DB: đã ghi ' + sau.rows[0].n + ' dòng giá bán thực tế cho TID');
const conNut = await p.locator("[data-kiem='nut-dat-gia-niem-yet']").count();
// 16/11: ghi ĐÚNG nhưng máy chủ đọc mốc hiệu lực LỆCH +7h (Prisma đọc timestamptz theo giờ treo tường) ⇒ với bill
// giờ sớm, cảnh báo CÒN nguyên. Bài kiểm này KHÔNG ép "biến mất" (ép là ép màn nói dối); nó đòi: hoặc cảnh báo
// biến mất, hoặc app PHẢI báo rõ "ghi rồi nhưng chưa ăn" — cấm im lặng.
const coBaoLech = await p.locator('text=CHƯA ăn').count();
chot(conNut === 0 || coBaoLech > 0, 'sau khi đặt: hoặc hết cảnh báo, hoặc app BÁO RÕ "ghi rồi nhưng chưa ăn" (không im lặng)');
await p.screenshot({ path: resolve(RA, '10-sau-khi-bam-niem-yet.png') });
console.log('\n[nut-niem-yet] SỐ PHÉP KIỂM (đếm động) = ' + so);
console.log(loi.length ? '[nut-niem-yet] ' + loi.length + ' ĐỎ' : '[nut-niem-yet] KHÔNG phép kiểm nào đỏ');
await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]); await db.end();
if (loi.length) process.exitCode = 1;
