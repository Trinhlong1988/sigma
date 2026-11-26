// Bước 2: dùng JWT (env PS_JWT) vào thẳng "Quản lý giao dịch" — bắt endpoint + body mẫu. Chỉ ĐỌC.
import { chromium } from 'playwright';
const JWT = process.env.PS_JWT ?? '', MCH = process.env.PS_MCH ?? '';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
page.on('response', async (r) => {
  const u = r.url();
  if (!u.includes('sem-backend')) return;
  const req = r.request();
  let body = '';
  try { body = (await r.text()).slice(0, 700); } catch { /* stream */ }
  console.log(`\n[${r.status()}] ${req.method()} ${u.slice(0, 140)}`);
  const pd = req.postData();
  if (pd) console.log('  REQ:', pd.slice(0, 400));
  if (body) console.log('  RESP:', body);
});
await page.addInitScript(([jwt]) => {
  localStorage.setItem('auth1XLn1L1SWe', JSON.stringify({ jwtToken: jwt }));
}, [JWT]);
await page.goto(`https://sem.paysmart.com.vn/merchant/management-transaction/list?mch=${MCH}&merchantType=REFERRAL`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: 'screenshots/paysmart-txn-list.png', fullPage: false });
console.log('\nURL:', page.url());
await browser.close();
