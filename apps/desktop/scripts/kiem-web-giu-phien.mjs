// KIỂM "F5 KHÔNG được đá về màn đăng nhập" (Admin Demo 7/11).
// Không có tài khoản thật thì KHÔNG thể chứng minh trọn vẹn. Cái kiểm được ở đây là:
//   (1) lúc khởi động, bản web CÓ hỏi máy chủ `/v1/auth/me` TRƯỚC khi quyết định hiện màn đăng nhập;
//   (2) khi máy chủ trả về user (ta giả lập bằng cách chặn đúng lượt gọi đó), app vào THẲNG app, KHÔNG
//       hiện màn đăng nhập — tức nhánh giữ phiên có chạy thật.
import { chromium } from 'playwright';

const DIA_CHI = process.env.QLWEB_URL || 'http://127.0.0.1:57913/';
let datHet = true;
const chot = (ok, ten) => { if (!ok) { datHet = false; console.log('  >>> PHÉP KIỂM ĐỎ — ' + ten); } };

const browser = await chromium.launch();
try {
  // ── A. Chưa đăng nhập: phải CÓ gọi /v1/auth/me rồi mới hiện màn đăng nhập ──
  let ctx = await browser.newContext();
  let page = await ctx.newPage();
  const goi = [];
  page.on('request', (r) => { if (r.url().includes('/v1/auth/me')) goi.push(r.method() + ' ' + r.url()); });
  await page.goto(DIA_CHI, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const coManDangNhap = await page.evaluate(() => /Tên đăng nhập/.test(document.body.innerText));
  console.log('  [chưa đăng nhập] số lượt gọi /v1/auth/me =', goi.length, '· hiện màn đăng nhập =', coManDangNhap);
  chot(goi.length >= 1, 'khởi động có hỏi máy chủ /v1/auth/me trước khi quyết định');
  chot(coManDangNhap === true, 'chưa có phiên thì hiện màn đăng nhập');
  await ctx.close();

  // ── B. Giả lập CÒN PHIÊN: chặn đúng lượt /v1/auth/me, trả user → phải vào THẲNG app ──
  ctx = await browser.newContext();
  page = await ctx.newPage();
  const goc = new URL(DIA_CHI).origin;
  const cors = {
    'access-control-allow-origin': goc,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  };
  // Chặn CẢ preflight OPTIONS — thiếu nhánh này là route handler ném lỗi, kịch bản chết giữa chừng.
  // PHẢI giả lập CẢ nhịp tim + realtime: chúng chỉ chạy KHI ĐÃ có user, và nếu để chúng 401 thật thì
  // App gọi handleSessionExpired() → ĐÁ NGAY về màn đăng nhập ⇒ nhìn vào tưởng "giữ phiên hỏng".
  await page.route('**/v1/**', async (route) => {
    const req = route.request();
    const u = req.url();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    if (u.includes('/v1/auth/heartbeat')) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
    if (u.includes('/v1/realtime') || u.includes('/v1/notifications')) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true,"data":[]}' });
    if (!u.includes('/v1/auth/me')) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: cors,
      body: JSON.stringify({
        ok: true,
        user: { id: 2, username: 'admin', fullName: 'Admin Demo (giả lập phiên)', status: 'ACTIVE', roles: ['ADMIN'], permissions: ['DASHBOARD_VIEW', 'REVENUE_VIEW', 'TXN_MANAGE'], forceChangePassword: false }
      })
    });
  });
  await page.goto(DIA_CHI, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const sau = await page.evaluate(() => ({
    conManDangNhap: /Tên đăng nhập/.test(document.body.innerText),
    vaoApp: /DOANH SỐ|Trang chủ/.test(document.body.innerText)
  }));
  console.log('  [còn phiên → F5]', JSON.stringify(sau));
  chot(sau.conManDangNhap === false, 'còn phiên thì KHÔNG hiện lại màn đăng nhập');
  chot(sau.vaoApp === true, 'còn phiên thì vào THẲNG app');
  await page.screenshot({ path: 'screenshots/web-dangnhap/giu-phien-sau-f5.png' });
  await ctx.close();
} catch (e) {
  console.error('[giu-phien] LỖI:', e.message);
  datHet = false;
} finally {
  console.log('[giu-phien] KẾT LUẬN:', datHet ? 'không phép kiểm nào đỏ' : '*** CÒN PHÉP KIỂM ĐỎ ***');
  await browser.close();
  process.exitCode = datHet ? 0 : 1;
}
