// TÁI HIỆN lỗi Admin Demo 16/11: "bảng tên khách khi GIAO TID mở lên bị khuất xuống dưới".
// Mở hộp Giao TID → bấm ô Khách hàng → ĐO xem ô nằm ở đâu so với đáy màn, danh sách gợi ý có đủ chỗ không.
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
const NHAN = 'kiem-o-chon-khach'; const tho = randomUUID();
await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
  VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]);
const W = Number(process.env.DO_W || 1920), H = Number(process.env.DO_H || 1040);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: H } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
const nm = p.locator("[data-kiem='nut-menu']");
if (await nm.count()) { const v = await p.locator('aside').first().isVisible().catch(() => false); if (!v) { await nm.first().click(); await p.waitForTimeout(700); } }
await p.locator('aside button', { hasText: 'Quản Lý TID' }).first().click(); await p.waitForTimeout(3000);
const tabDs = p.locator('button', { hasText: /^Danh sách TID$/ }).first();
if (await tabDs.count()) { await tabDs.click(); await p.waitForTimeout(2000); }
let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
console.log('[do] khổ màn ' + W + '×' + H);
for (const tip of ['Giao cho khách', 'Gán máy POS']) {
  const nut = p.locator(`[title="${tip}"]`).first();
  if (!(await nut.count())) { console.log('  ' + tip + ': không có nút'); continue; }
  await nut.click(); await p.waitForTimeout(1800);
  const o = p.locator("[data-kiem='o-chon-khach']").first();
  if (!(await o.count())) { console.log('  ' + tip + ': KHÔNG thấy ô chọn khách'); await p.keyboard.press('Escape'); continue; }
  const d = await o.evaluate((el, hh) => {
    const r = el.getBoundingClientRect();
    const phu = el.closest('div.fixed');
    const than = phu ? [...phu.querySelectorAll('div')].find((x) => /overflow-auto/.test(x.className) && /max-h-/.test(x.className)) : null;
    const rt = than ? than.getBoundingClientRect() : null;
    return {
      oTop: Math.round(r.top), oDay: Math.round(r.bottom),
      choConLai_duoiO_trongManh: Math.round(hh - r.bottom),
      choConLai_duoiO_trongThanHop: rt ? Math.round(rt.bottom - r.bottom) : null,
      hopTop: rt ? Math.round(rt.top) : null, hopDay: rt ? Math.round(rt.bottom) : null,
      hopCuon: rt && than ? Math.round(than.scrollHeight - than.clientHeight) : null
    };
  }, H);
  console.log('  ' + tip + ': ' + JSON.stringify(d));
  // ĐO CHIỀU CAO HỘP TRƯỚC khi chọn khách (Admin Demo: "khung bảng phải CỐ ĐỊNH, không chọn khách xong mới nhảy").
  const caoTruoc = await p.evaluate(() => {
    const phu = [...document.querySelectorAll('div.fixed.inset-0')].pop();
    const than = phu ? [...phu.querySelectorAll('div')].find((x) => /overflow-auto/.test(x.className) && /max-h-/.test(x.className)) : null;
    return than ? Math.round(than.getBoundingClientRect().height) : -1;
  });
  await o.focus(); await p.waitForTimeout(700);
  await p.screenshot({ path: resolve(RA, 'khach-' + tip.replace(/\s+/g, '-').toLowerCase() + '.png') });
  // Hộp gợi ý PHẢI hiện, PHẢI nằm TRỌN trong màn, và có ĐỦ 2 cột MÃ/TÊN + dòng so le.
  const hop = await p.evaluate((hh) => {
    const h = document.querySelector("[data-kiem='hop-goi-y']");
    if (!h) return null;
    const r = h.getBoundingClientRect();
    const th = [...h.querySelectorAll('thead th')].map((x) => x.textContent.trim());
    const tr = [...h.querySelectorAll('tbody tr')].slice(0, 4);
    return {
      top: Math.round(r.top), day: Math.round(r.bottom), cao: Math.round(r.height),
      lotRaKhoiManh: Math.round(r.bottom) > hh || Math.round(r.top) < 0,
      cot: th, soDong: h.querySelectorAll('tbody tr').length,
      nen: tr.map((x) => getComputedStyle(x).backgroundColor)
    };
  }, H);
  console.log('      hộp gợi ý: ' + JSON.stringify(hop));
  chot(!!hop, tip + ': bấm vào ô khách thì hộp gợi ý HIỆN');
  chot(!!hop && !hop.lotRaKhoiManh, tip + ': hộp gợi ý nằm TRỌN trong màn (không bị khuất xuống dưới)');
  chot(!!hop && hop.cot.length === 2 && /MÃ/.test(hop.cot[0]) && /TÊN/.test(hop.cot[1]), tip + ': có ĐÚNG 2 cột MÃ KHÁCH | TÊN KHÁCH');
  chot(!!hop && hop.nen.length >= 2 && hop.nen[0] !== hop.nen[1], tip + ': dòng so le 2 màu');
  // Chọn 1 khách rồi ĐO LẠI chiều cao hộp thoại.
  const dong1 = p.locator("[data-kiem='hop-goi-y'] tbody tr").first();
  if (await dong1.count()) { await dong1.click({ force: true }); await p.waitForTimeout(1800); }
  const caoSau = await p.evaluate(() => {
    const phu = [...document.querySelectorAll('div.fixed.inset-0')].pop();
    const than = phu ? [...phu.querySelectorAll('div')].find((x) => /overflow-auto/.test(x.className) && /max-h-/.test(x.className)) : null;
    return than ? Math.round(than.getBoundingClientRect().height) : -1;
  });
  console.log('      chiều cao thân hộp: trước ' + caoTruoc + 'px · sau khi chọn khách ' + caoSau + 'px');
  chot(caoTruoc > 0 && caoTruoc === caoSau, tip + ': khung KHÔNG nhảy kích thước khi chọn khách (' + caoTruoc + '→' + caoSau + ')');
  await p.screenshot({ path: resolve(RA, 'khach-sau-chon-' + tip.replace(/\s+/g, '-').toLowerCase() + '.png') });
  await p.keyboard.press('Escape'); await p.waitForTimeout(600);
}
console.log("\n[o-chon-khach] SO PHEP KIEM (dem dong) = " + so);
console.log(loi.length ? '[o-chon-khach] ' + loi.length + ' ĐỎ' : '[o-chon-khach] KHÔNG phép kiểm nào đỏ');
await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]); await db.end();
if (loi.length) process.exitCode = 1;
