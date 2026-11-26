// Dùng lại PHIÊN đã lưu (digi-session.json) → vào trang giao dịch (/tx-va) → bắt API giao dịch THẬT + shape.
// KHÔNG login lại (không chạm credential). Đọc-only.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const S = 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\claude\\C--Users-Administrator\\856721ce-5805-477f-a72d-115f7114c8d0\\scratchpad';
const captured = [];
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: S + '\\digi-session.json', viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('request', (r) => { const u = r.url(); if (/api-outscope-pos/.test(u)) captured.push({ dir: 'REQ', url: u, method: r.method(), auth: (r.headers()['authorization'] || '').slice(0, 24) + '…', post: (r.postData() || '').slice(0, 300) }); });
  page.on('response', async (r) => { const u = r.url(); if (/api-outscope-pos/.test(u) && /transaction|tx|payment|order|report|history|va\b|bill/i.test(u)) { let b = ''; try { b = (await r.text()).slice(0, 4000); } catch { /* */ } captured.push({ dir: 'RES', url: u, status: r.status(), body: b }); } });
  try {
    await page.goto('https://digistore-merchant.bvbank.net.vn/tx-va?page=1&page_size=80&status=success', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: S + '\\digi-txpage.png', fullPage: true });
  } catch (e) { console.log('LOI', e.message); }
  writeFileSync(S + '\\digi-txapi.json', JSON.stringify(captured, null, 2));
  console.log('CAPTURED ' + captured.length + ' api-outscope-pos events');
  for (const e of captured) if (e.dir === 'REQ') console.log('REQ', e.method, e.url.replace(/^https:\/\/[^/]+/, '').slice(0, 100));
  await browser.close();
})();
