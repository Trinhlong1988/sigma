// [Admin Demo 11/9] NGHIÊN CỨU PaySmart: login UI thật (recaptcha v3 tự chạy trong trang) + bắt network /api/*
// để lấy endpoint giao dịch/báo-có. Cred qua ENV. Chỉ ĐỌC.
import { chromium } from 'playwright';
const USER = process.env.PS_USER ?? '', PASS = process.env.PS_PASS ?? '';
const reqs: string[] = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 850 } })).newPage();
page.on('response', async (r) => {
  const u = r.url();
  if (u.includes('sem-backend') && !reqs.includes(`${r.request().method()} ${u}`)) {
    reqs.push(`${r.request().method()} ${u}`);
    console.log(`[net ${r.status()}] ${r.request().method()} ${u.slice(0, 150)}`);
    if (u.includes('authenticate')) { const b = await r.text().catch(() => ''); console.log('  auth resp FULL:', b); }
  }
});
await page.goto('https://sem.paysmart.com.vn/auth/login', { waitUntil: 'networkidle', timeout: 60000 });
await page.screenshot({ path: 'screenshots/paysmart-0-login.png' });
// dò input
const inputs = await page.locator('input').evaluateAll((els) => els.map((e) => ({ type: (e as HTMLInputElement).type, name: (e as HTMLInputElement).name, ph: (e as HTMLInputElement).placeholder })));
console.log('INPUTS:', JSON.stringify(inputs));
await page.locator('input').first().fill(USER);
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[name="twoFactorCode"]').fill(process.env.PS_OTP ?? ''); // OTP thật từ app Admin Demo
await page.screenshot({ path: 'screenshots/paysmart-1-filled.png' });
await page.locator('button[type="submit"], button:has-text("Đăng nhập"), button:has-text("Login")').first().click();
await page.waitForTimeout(9000);
await page.screenshot({ path: 'screenshots/paysmart-2-sau-login.png' });
console.log('URL sau login:', page.url());
// thử mở menu giao dịch nếu đã vào được
if (!page.url().includes('/auth/login')) {
  const links = await page.locator('a').evaluateAll((els) => els.map((e) => ({ t: (e.textContent || '').trim().slice(0, 40), h: (e as HTMLAnchorElement).getAttribute('href') })).filter((x) => x.t));
  console.log('MENU:', JSON.stringify(links.slice(0, 40)));
  // tự bấm vào các mục nghi là giao dịch/báo-có để lộ endpoint
  for (const kw of ['giao dịch', 'lịch sử', 'transaction', 'báo cáo', 'report', 'doanh thu']) {
    const l = page.locator(`a:has-text("${kw}")`).first();
    if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(3500); await page.screenshot({ path: `screenshots/paysmart-menu-${kw.replace(/[^a-z]/g, '')}.png` }).catch(() => {}); }
  }
  await page.waitForTimeout(2000);
}
await browser.close();
console.log('\nTẤT CẢ API:', JSON.stringify(reqs, null, 1));
