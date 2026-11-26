// Login (OTP env) → CÙNG PHIÊN đi thẳng "Quản lý giao dịch" → bắt endpoint + payload + response. Chỉ ĐỌC.
import { chromium } from 'playwright';
const USER = process.env.PS_USER ?? '', PASS = process.env.PS_PASS ?? '', OTP = process.env.PS_OTP ?? '';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
const seen = new Set<string>();
page.on('response', async (r) => {
  const u = r.url();
  if (!u.includes('sem-backend')) return;
  const req = r.request();
  const key = `${req.method()} ${u.split('?')[0]}`;
  let body = '';
  try { body = (await r.text()).slice(0, 800); } catch { /* stream */ }
  console.log(`\n[${r.status()}] ${req.method()} ${u.slice(0, 150)}`);
  const pd = req.postData();
  if (pd && !seen.has(key)) console.log('  REQ:', pd.slice(0, 500));
  if (body && !seen.has(key)) console.log('  RESP:', body);
  seen.add(key);
});
await page.goto('https://sem.paysmart.com.vn/auth/login', { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('input').first().fill(USER);
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('input[name="twoFactorCode"]').fill(OTP);
await page.locator('button[type="submit"], button:has-text("Đăng nhập")').first().click();
await page.waitForTimeout(8000);
console.log('\n== SAU LOGIN:', page.url().slice(0, 100));
if (page.url().includes('/auth/login')) { console.log('LOGIN FAIL'); await browser.close(); process.exit(1); }
const mch = new URL(page.url()).searchParams.get('mch') ?? '';
await page.goto(`https://sem.paysmart.com.vn/merchant/management-transaction/list?mch=${mch}&merchantType=REFERRAL`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.screenshot({ path: 'screenshots/paysmart-txn-list.png' });
console.log('\n== TRANG GIAO DỊCH:', page.url().slice(0, 100));
await browser.close();
