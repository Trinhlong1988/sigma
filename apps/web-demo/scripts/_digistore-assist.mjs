// ASSISTED LOGIN — em MỞ trình duyệt hiện trên màn hình, Admin Demo TỰ gõ mật khẩu (em KHÔNG chạm credential).
// Sau khi anh đăng nhập xong (URL rời /login), em: bắt API /tx-va (auth + shape), LƯU phiên (storageState) để tích hợp.
// Chạy: node --import tsx scripts/_digistore-assist.mjs   (cửa sổ Chromium bật lên — anh đăng nhập trong đó)
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const OUT = 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\claude\\C--Users-Administrator\\856721ce-5805-477f-a72d-115f7114c8d0\\scratchpad';
const captured = [];
const KEEP = /tx-va|login|auth|token|session|api\b|graphql/i;

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  page.on('request', (r) => { const u = r.url(); if (KEEP.test(u) && !/\.(png|jpg|css|js|woff|svg)/i.test(u)) captured.push({ dir: 'REQ', url: u, method: r.method(), headers: r.headers() }); });
  page.on('response', async (r) => { const u = r.url(); if (KEEP.test(u) && !/\.(png|jpg|css|js|woff|svg)/i.test(u)) { let b = ''; try { b = (await r.text()).slice(0, 3000); } catch { /* */ } captured.push({ dir: 'RES', url: u, status: r.status(), body: b }); } });

  await page.goto('https://digistore-merchant.bvbank.net.vn/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('>>> CỬA SỔ ĐÃ MỞ — QUAN TRI GÕ MẬT KHẨU + ĐĂNG NHẬP trong cửa sổ đó. Em chờ tới 4 phút...');

  // Chờ anh đăng nhập: URL rời /login (vào dashboard) — poll 2s, tối đa 240s.
  let loggedIn = false;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(2000);
    const url = page.url();
    if (!/\/login/i.test(url)) { loggedIn = true; console.log('>>> ĐĂNG NHẬP XONG, url=' + url); break; }
  }
  if (!loggedIn) { console.log('>>> HẾT GIỜ CHỜ — chưa thấy rời /login.'); }

  if (loggedIn) {
    await page.waitForTimeout(2500);
    try { await ctx.storageState({ path: OUT + '\\digi-session.json' }); console.log('>>> Đã lưu phiên'); } catch (e) { console.log('lưu phiên lỗi', e.message); }
    // Bắt request transaction/va THÀNH CÔNG (đủ header auth) + response shape — trong CÙNG phiên sống.
    const apiHit = { req: null, res: null };
    page.on('request', (r) => { if (/\/v1\/portal\/transaction\/va/.test(r.url())) apiHit.req = { url: r.url(), headers: r.headers() }; });
    page.on('response', async (r) => { if (/\/v1\/portal\/transaction\/va/.test(r.url())) { try { apiHit.res = { status: r.status(), body: (await r.text()).slice(0, 6000) }; } catch { /* */ } } });
    // ĐIỀU HƯỚNG trang giao dịch (SPA) → app tự gọi transaction/va với auth đúng.
    await page.goto('https://digistore-merchant.bvbank.net.vn/tx-va?page=1&page_size=80&status=success', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(7000);
    await page.screenshot({ path: OUT + '\\digi-txpage.png', fullPage: true }).catch(() => {});
    writeFileSync(OUT + '\\digi-txcontract.json', JSON.stringify(apiHit, null, 2));
    console.log('>>> transaction/va status=' + (apiHit.res && apiHit.res.status));
    console.log('>>> AUTH header keys=' + (apiHit.req ? Object.keys(apiHit.req.headers).filter((k) => /auth|token|key|wesap|device|x-/i.test(k)).join(',') : 'null'));
    console.log('>>> RES head=' + String(apiHit.res && apiHit.res.body).slice(0, 500));
  }
  writeFileSync(OUT + '\\digi-assist-net.json', JSON.stringify(captured, null, 2));
  console.log('>>> CAPTURED ' + captured.length + ' events → digi-assist-net.json. Đóng cửa sổ sau 3s.');
  await page.waitForTimeout(3000);
  await browser.close();
})();
