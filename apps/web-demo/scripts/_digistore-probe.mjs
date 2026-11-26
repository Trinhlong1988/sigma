// PROBE (đọc-only) — soi cơ chế đăng nhập DigiStore Merchant + API /tx-va để thiết kế "check báo có".
// Credentials QUA ENV (DIGI_EMAIL/DIGI_PASS) — KHÔNG hardcode. Dump network (login + tx-va) ra scratch để LEAD đọc shape.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const EMAIL = process.env.DIGI_EMAIL, PASS = process.env.DIGI_PASS;
const OUT = process.env.PROBE_OUT || 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\claude\\C--Users-Administrator\\856721ce-5805-477f-a72d-115f7114c8d0\\scratchpad';
if (!EMAIL || !PASS) { console.error('THIẾU DIGI_EMAIL/DIGI_PASS env'); process.exit(1); }

const captured = [];
const KEEP = /tx-va|login|auth|signin|token|session|api\b|graphql/i;
const isPost = (m) => m === 'POST' || m === 'PUT';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('request', (r) => { const u = r.url(); if (KEEP.test(u) || (isPost(r.method()) && !/\.(png|jpg|css|js|woff|svg)/i.test(u))) captured.push({ dir: 'REQ', url: u, method: r.method(), headers: r.headers(), post: (r.postData() || '').slice(0, 400) }); });
  page.on('response', async (r) => { const u = r.url(); if ((KEEP.test(u) || isPost(r.request().method())) && !/\.(png|jpg|css|js|woff|svg)/i.test(u)) { let body = ''; try { body = (await r.text()).slice(0, 1500); } catch { /* */ } captured.push({ dir: 'RES', url: u, status: r.status(), body }); } });

  try {
    await page.goto('https://digistore-merchant.bvbank.net.vn/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    // Liệt kê input/button để biết form login (KHÔNG log giá trị nhập).
    const formInfo = await page.evaluate(() => ({
      inputs: Array.from(document.querySelectorAll('input')).map((i) => ({ type: i.type, name: i.name, id: i.id, ph: i.placeholder })),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 10),
      url: location.href
    }));
    console.log('FORM=' + JSON.stringify(formInfo));
    await page.screenshot({ path: OUT + '\\digi-1-login.png', fullPage: true });

    // Điền robust: email field (type=email / name/placeholder chứa email/tài khoản/số điện thoại), password.
    const emailSel = 'input[type="email"], input[name*="email" i], input[name*="user" i], input[placeholder*="mail" i], input[placeholder*="tài khoản" i], input[placeholder*="đăng nhập" i]';
    const passSel = 'input[type="password"]';
    if (await page.locator(emailSel).count()) await page.locator(emailSel).first().fill(EMAIL);
    if (await page.locator(passSel).count()) await page.locator(passSel).first().fill(PASS);
    // Tick checkbox (điều khoản/nhớ đăng nhập) nếu có — nút Đăng nhập có thể disabled tới khi tick.
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.count()) await cb.check().catch(() => {});
    await page.waitForTimeout(500);
    const btnState = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /Đăng nhập$/.test((x.textContent || '').trim())); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; });
    console.log('BTN_STATE=' + JSON.stringify(btnState));
    // Submit: nút chứa "Đăng nhập" / type submit.
    const btn = page.locator('button:has-text("Đăng nhập"), button[type="submit"], button:has-text("Login")').first();
    if (await btn.count()) await btn.click().catch(() => {});
    await page.waitForTimeout(6000);
    await page.screenshot({ path: OUT + '\\digi-2-afterlogin.png', fullPage: true });
    console.log('AFTER_LOGIN_URL=' + page.url());

    // Gọi thẳng endpoint tx-va TRONG NGỮ CẢNH trang (kèm cookie/token phiên) để xem auth + shape.
    const txUrl = 'https://digistore-merchant.bvbank.net.vn/tx-va?page=1&page_size=80&status=success&bill_id=&customer_id=&start_time=1788541201&end_time=1788601094';
    const txProbe = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        const txt = await res.text();
        return { status: res.status, ct: res.headers.get('content-type'), body: txt.slice(0, 2500) };
      } catch (e) { return { error: String(e) }; }
    }, txUrl);
    console.log('TXVA_FETCH=' + JSON.stringify(txProbe).slice(0, 2600));
  } catch (e) {
    console.error('PROBE LỖI:', e.message);
  } finally {
    writeFileSync(OUT + '\\digi-network.json', JSON.stringify(captured, null, 2));
    console.log('CAPTURED ' + captured.length + ' network events → digi-network.json');
    await browser.close();
  }
})();
