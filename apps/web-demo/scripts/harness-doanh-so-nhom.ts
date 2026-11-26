// HARNESS R200 (Admin Demo 10/9) — màn "Doanh số theo nhóm": số thứ tự 1..n · KPI xếp NGANG CÙNG HÀNG với tên ĐL/NĐT
// (hôm nay · hôm qua · sau phí · số lô · cần hoàn · đã hoàn · thừa-thiếu · đã ứng · hoàn ứng) · chia ô chia thẻ ·
// 2 bên cách lề 1,5 cm · hiệu ứng 3D khi rê/chọn. Chụp ảnh + ĐO bằng số (lề, cùng-hàng, đủ ô).
// Chạy: node --import tsx scripts/harness-doanh-so-nhom.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-doanh-so-nhom');
const VIEWPORT = { width: 1400, height: 950 };
const CM = 37.795275; // 1cm CSS ở 96dpi

const ROOMS = [
  { id: 'r-thong', name: 'Thông Thái Nguyên', isGroup: true },
  { id: 'r-trung', name: 'Trung CP', isGroup: true },
  { id: 'r-nguyen', name: 'ĐL- Mr Nguyễn SG', isGroup: true },
  { id: 'r-huy', name: 'ĐL- Huy DakLak', isGroup: true },
  { id: 'r-qr-bao', name: 'QR Bảo SG', isGroup: true }
];

const KPI = [
  { roomId: 'r-thong', grossHomNay: 1_248_500_000, netHomNay: 1_236_015_000, grossHomQua: 986_000_000, soLoHomNay: 42, laNdt: true, canHoan: null, daHoan: null, thuaThieu: null, daUng: null, hoanUng: null, ndtDaTamUng: 500_000_000, ndtDaHoanLai: 100_000_000, ndtLoiNhuan: 1_248_500 },
  { roomId: 'r-trung', grossHomNay: 0, netHomNay: 0, grossHomQua: 152_000_000, soLoHomNay: 0, laNdt: true, canHoan: null, daHoan: null, thuaThieu: null, daUng: null, hoanUng: null, ndtDaTamUng: 0, ndtDaHoanLai: 0, ndtLoiNhuan: 0 },
  { roomId: 'r-nguyen', grossHomNay: 212_889_000, netHomNay: 209_907_000, grossHomQua: 180_400_000, soLoHomNay: 11, laNdt: false, canHoan: 209_907_000, daHoan: 209_905_000, thuaThieu: -2_000, daUng: 0, hoanUng: 0, ndtDaTamUng: null, ndtDaHoanLai: null, ndtLoiNhuan: null },
  { roomId: 'r-huy', grossHomNay: 84_635_000, netHomNay: 83_581_832, grossHomQua: 96_120_000, soLoHomNay: 6, laNdt: false, canHoan: 83_581_832, daHoan: 50_000_000, thuaThieu: -13_581_832, daUng: 20_000_000, hoanUng: 5_000_000, ndtDaTamUng: null, ndtDaHoanLai: null, ndtLoiNhuan: null },
  { roomId: 'r-qr-bao', grossHomNay: 10_500_000, netHomNay: 10_389_750, grossHomQua: 0, soLoHomNay: 1, laNdt: false, canHoan: 10_389_750, daHoan: 0, thuaThieu: -10_389_750, daUng: 0, hoanUng: 0, ndtDaTamUng: null, ndtDaHoanLai: null, ndtLoiNhuan: null }
];

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/birthday|chat-realtime|AppShell|hết hạn/.test(m.text())) console.log('CONSOLE-ERR:', m.text().slice(0, 200)); });
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
    await page.addInitScript({
      content: [
        "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguyen Van A' }));",
        "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguyen Van A', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));",
        'function FakeWS(){ this.readyState = 0; }',
        'FakeWS.prototype.addEventListener = function(){};',
        'FakeWS.prototype.removeEventListener = function(){};',
        'FakeWS.prototype.send = function(){};',
        'FakeWS.prototype.close = function(){};',
        'window.WebSocket = FakeWS;'
      ].join(String.fromCharCode(10))
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.endsWith('/v1/chat/rooms-revenue-kpi')) return json(route, { ok: true, data: KPI });
      if (p.endsWith('/v1/chat/rooms')) return json(route, { ok: true, data: ROOMS.map((r) => ({ id: r.id, name: r.name, type: 'GROUP', memberCount: 3, unreadCount: 0, lastMessage: null, lastMessageAt: null, members: [] })) });
      if (/\/me\/friends$/.test(p)) return json(route, { friends: [], incomingRequests: [], outgoingRequests: [] });
      const listLike = /categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, method === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '1-danh-sach-kpi.png') });

    let dat = true;
    const hang = page.locator('ul > li > button');
    const soHang = await hang.count();
    console.log(`  Số dòng nhóm: ${soHang} (mong đợi ${ROOMS.length})`);
    if (soHang !== ROOMS.length) { dat = false; console.log('  ❌ thiếu/thừa dòng'); }

    // 1. Số thứ tự 1..n
    const stt = await hang.evaluateAll((els) => els.map((e) => (e.querySelector('span')?.textContent ?? '').trim()));
    const sttDung = stt.join(',') === ROOMS.map((_, i) => String(i + 1)).join(',');
    console.log(`  STT: ${stt.join(' ')} → ${sttDung ? '✅' : '❌'}`);
    if (!sttDung) dat = false;

    // 2. [11/9] SẮP THEO DOANH SỐ: NĐT ghim trên, đại lý cao→thấp (Nguyễn 212,9tr → Huy 84,6tr → QR Bảo 10,5tr).
    const tenThuTu = await hang.evaluateAll((els) => els.map((e) => (e.querySelector('[data-testid="cot-ten"] span')?.textContent ?? '').trim()));
    const mongDoi = ['Thông Thái Nguyên', 'Trung CP', 'ĐL- Mr Nguyễn SG', 'ĐL- Huy DakLak', 'QR Bảo SG'];
    const sapDung = tenThuTu.join('|') === mongDoi.join('|');
    console.log(`  Thứ tự: ${tenThuTu.join(' → ')} → ${sapDung ? '✅' : '❌'}`);
    if (!sapDung) dat = false;

    // 3. [11/9] ĐẠI LÝ đúng 4 ô Trước phí/Sau phí/Đã hoàn/Thừa-thiếu — SỐ ĐẦY ĐỦ, căn phải, rộng bằng nhau, thẳng cột.
    const dongNguyen = hang.nth(2);
    const oNguyen = dongNguyen.locator('div[title]');
    const soO = await oNguyen.count();
    const nhanO = await oNguyen.evaluateAll((els) => els.map((e) => (e.querySelector('div')?.textContent ?? '').trim()));
    const soDayDu = await oNguyen.evaluateAll((els) => els.map((e) => (e.querySelectorAll('div')[1]?.textContent ?? '').trim()));
    console.log(`  Đại lý Nguyễn: ${soO} ô [${nhanO.join(' · ')}] = [${soDayDu.join(' · ')}]`);
    const oDung = soO === 4 && nhanO.join(',').toUpperCase() === 'TRƯỚC PHÍ,SAU PHÍ,ĐÃ HOÀN,THỪA/THIẾU';
    if (!oDung) { dat = false; console.log('  ❌ phải đúng 4 ô'); }
    const daydu = soDayDu[0] === '212.889.000đ';
    console.log(`  Số ĐẦY ĐỦ (212.889.000đ): ${daydu ? '✅' : '❌ thấy ' + soDayDu[0]}`);
    if (!daydu) dat = false;
    const rong = await oNguyen.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    const rongBang = Math.max(...rong) - Math.min(...rong) <= 2;
    console.log(`  4 ô rộng bằng nhau: ${rongBang ? '✅' : '❌'} (${rong.join(', ')}px)`);
    if (!rongBang) dat = false;
    const xNguyen = await oNguyen.first().evaluate((e) => Math.round(e.getBoundingClientRect().x));
    const xHuy = await hang.nth(3).locator('div[title]').first().evaluate((e) => Math.round(e.getBoundingClientRect().x));
    const thangCot = Math.abs(xNguyen - xHuy) <= 2;
    console.log(`  Thẳng cột dọc: ${thangCot ? '✅' : '❌'} (x=${xNguyen} vs ${xHuy})`);
    if (!thangCot) dat = false;
    const canPhai = await oNguyen.first().evaluate((e) => getComputedStyle(e).textAlign === 'right');
    console.log(`  Căn phải: ${canPhai ? '✅' : '❌'}`);
    if (!canPhai) dat = false;

    // 4. [11/9] NĐT đủ 5 ô: Trước phí · Sau phí cài · Đã tạm ứng · Đã hoàn lại · Lợi nhuận.
    const oNdt = hang.nth(0).locator('div[title]');
    const soONdt = await oNdt.count();
    const nhanNdt = await oNdt.evaluateAll((els) => els.map((e) => (e.querySelector('div')?.textContent ?? '').trim()));
    const ndtDung = soONdt === 5 && nhanNdt.join(',').toUpperCase() === 'TRƯỚC PHÍ,SAU PHÍ CÀI,ĐÃ TẠM ỨNG,ĐÃ HOÀN LẠI,LỢI NHUẬN';
    console.log(`  NĐT: ${soONdt} ô [${nhanNdt.join(' · ')}] → ${ndtDung ? '✅' : '❌'}`);
    if (!ndtDung) dat = false;

    // 4b. [11/9] 2 MÉP THẲNG mọi dòng + ô hẹp lại (lưới 85% phần còn lại, dồn phải).
    const mepNdtPhai = await oNdt.nth(4).evaluate((e) => Math.round(e.getBoundingClientRect().right));
    const mepNguyenPhai = await oNguyen.nth(3).evaluate((e) => Math.round(e.getBoundingClientRect().right));
    const mepPhaiThang = Math.abs(mepNdtPhai - mepNguyenPhai) <= 2;
    const mepNdtTrai = await oNdt.first().evaluate((e) => Math.round(e.getBoundingClientRect().x));
    const mepNguyenTraiLuoi = await oNguyen.first().evaluate((e) => {
      const luoi = e.closest('.grid');
      return Math.round((luoi as HTMLElement).getBoundingClientRect().x);
    });
    const mepTraiThang = Math.abs(mepNdtTrai - mepNguyenTraiLuoi) <= 2;
    console.log(`  Mép phải thẳng mọi dòng: ${mepPhaiThang ? '✅' : '❌'} (${mepNdtPhai} vs ${mepNguyenPhai}) · mép trái lưới thẳng: ${mepTraiThang ? '✅' : '❌'} (${mepNdtTrai} vs ${mepNguyenTraiLuoi})`);
    if (!mepPhaiThang || !mepTraiThang) dat = false;

    // 5. Lề 1,5cm + kỳ đầu màn + cuộn + 3D (giữ từ đợt trước).
    const boxMan = await page.locator('[data-testid="man-doanh-so-nhom"]').boundingBox();
    const boxCard = await dongNguyen.boundingBox();
    const leTrai = (boxCard?.x ?? 0) - (boxMan?.x ?? 0);
    const lePhai = ((boxMan?.x ?? 0) + (boxMan?.width ?? 0)) - ((boxCard?.x ?? 0) + (boxCard?.width ?? 0));
    const leDung = Math.abs(leTrai - CM * 1.5) <= 2 && Math.abs(lePhai - CM * 1.5) <= 2;
    console.log(`  Lề ${leTrai.toFixed(1)}/${lePhai.toFixed(1)}px → ${leDung ? '✅' : '❌'}`);
    if (!leDung) dat = false;
    const boxKy = await page.locator('[data-testid="chon-ky"]').boundingBox();
    const boxDs = await page.locator('[data-testid="ds-nhom"]').boundingBox();
    const kyOTren = !!boxKy && !!boxDs && boxKy.y + boxKy.height <= boxDs.y + 2;
    console.log(`  Chọn kỳ đầu màn: ${kyOTren ? '✅' : '❌'}`);
    if (!kyOTren) dat = false;
    const truoc3d = await dongNguyen.evaluate((el) => getComputedStyle(el).transform);
    await dongNguyen.hover();
    await page.waitForTimeout(400);
    const sau3d = await dongNguyen.evaluate((el) => getComputedStyle(el).transform);
    console.log(`  3D khi rê: ${truoc3d !== sau3d && sau3d !== 'none' ? '✅' : '❌'}`);
    if (!(truoc3d !== sau3d && sau3d !== 'none')) dat = false;
    await page.locator('[data-testid="chon-ky"] button:has-text("Hôm qua")').click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, '3-ky-hom-qua.png') });

    // 6. [11/9 — bắt từ ảnh] SỐ KHÔNG BỊ CẮT: số tỷ của NĐT phải hiện TRỌN "1.248.500.000đ" (không "…").
    const soTyNdt = await hang.nth(0).locator('div[title]').first().evaluate((e) => {
      const el = e.querySelectorAll('div')[1] as HTMLElement;
      return { text: (el?.textContent ?? '').trim(), tran: el ? el.scrollWidth > el.clientWidth + 1 : true };
    });
    const soDu = soTyNdt.text === '1.248.500.000đ' && !soTyNdt.tran;
    console.log(`  Số tỷ hiện TRỌN không cắt: ${soDu ? '✅' : '❌'} ("${soTyNdt.text}", tràn=${soTyNdt.tran})`);
    if (!soDu) dat = false;

    console.log(dat ? '\n✅ ĐẠT' : '\n❌ CHƯA đạt');
    if (!dat) process.exitCode = 1;
    console.log('[harness] Ảnh ->', OUT);
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
