// TEMP harness (5/8) — before/after bằng chứng cho 4 bug ProfileScreen/ContactsScreen (giới tính nháy, menu
// đổi ảnh không đóng/bị cắt, avatar load giật, gửi/thu hồi kết bạn giật). Spawn vite dev, set session
// localStorage, MOCK /v1/** (có DELAY để lộ khoảng async gây nháy) rồi chụp ảnh các thời điểm then chốt.
// Chạy: PHASE=before|after node apps/web-demo/scripts/bugfix-harness.mjs   (từ ROOT repo)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const WEB_DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHASE = process.env.PHASE || 'after';
const OUT = process.env.OUT_DIR || 'C:/Users/ADMINI~1/AppData/Local/Temp/claude/C--Users-Administrator/856721ce-5805-477f-a72d-115f7114c8d0/scratchpad';
const PORT = 5321;
const BASE = `http://localhost:${PORT}`;
const IMG = readFileSync(resolve(WEB_DEMO_DIR, 'public/icon-192.png'));

const D = { profile: 1100, authMe: 1100, friends: 1100, media: 1100, mutate: 600 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cors(origin) {
  return { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Credentials': 'true' };
}

const AGENT = { id: 42, code: 'DL001', name: 'Nguyễn Văn Long', rcUserId: 'u1', rcUsername: 'long.nguyen' };
const PROFILE = { name: 'Nguyễn Văn Long', email: 'user10@example.com', gender: 'FEMALE', dateOfBirth: '1995-03-08', phone: '0912345678' };
const FRIENDS = {
  friends: [
    { requestId: 1, agentId: 101, agentCode: 'DL101', agentName: 'Trần Thị B', acceptedAt: null, online: null, dateOfBirth: null, gender: null, rcUsername: 'b', nickname: null, blockedByMe: false, blockedThem: false, category: null }
  ],
  incomingRequests: [],
  outgoingRequests: [
    { requestId: 2, agentId: 202, agentCode: 'DL202', agentName: 'Lê Văn C', createdAt: '2026-08-01T00:00:00Z' }
  ]
};

async function installMocks(context) {
  await context.route('**/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const origin = req.headers()['origin'];
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { ...cors(origin), 'Access-Control-Allow-Headers': 'content-type,x-sigma-client', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' } });
      return;
    }
    const json = async (obj, delay) => {
      if (delay) await sleep(delay);
      await route.fulfill({ status: 200, contentType: 'application/json', headers: cors(origin), body: JSON.stringify(obj) });
    };
    // Endpoints AppShell/Sidebar gọi lúc boot — PHẢI đúng shape kẻo crash app (categories.map / rooms.reduce).
    if (path === '/v1/me/categories' && method === 'GET') return json([], 0);
    if (path === '/v1/me/notifications' && method === 'GET') return json({ notifications: [], unreadCount: 0 }, 0);
    if (path === '/v1/chat/rooms' && method === 'GET') return json([], 0);
    if (path === '/v1/auth/me') return json({ agent: AGENT }, D.authMe);
    if (path === '/v1/me/profile' && method === 'GET') return json(PROFILE, D.profile);
    if (path === '/v1/me/friends' && method === 'GET') return json(FRIENDS, D.friends);
    if (/^\/v1\/agents\/\d+\/(avatar|cover)$/.test(path)) {
      await sleep(D.media);
      await route.fulfill({ status: 200, contentType: 'image/png', headers: cors(origin), body: IMG });
      return;
    }
    if (/^\/v1\/me\/friends\/\d+\/unfriend$/.test(path)) return json({ id: 2, status: 'REMOVED' }, D.mutate);
    if (path === '/v1/me/friends/request') return json({ autoAccepted: false }, D.mutate);
    // fallback
    return json({ ok: true }, 0);
  });
  await context.addInitScript(() => {
    localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u1', agentName: 'Nguyễn Văn Long' }));
    // Stub WebSocket: chat-realtime mở kết nối notify toàn cục lúc boot AppShell; không có server thật, nó đóng
    // với mã hết-phiên → handleSessionExpired → đá về /login TRƯỚC khi màn render. Stub "mãi mãi connecting/open,
    // không bao giờ close/error" để realtime nằm im, không đụng session (không ảnh hưởng logic 4 bug đang test).
    class FakeWS {
      constructor() {
        this.readyState = 0;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen && this.onopen({});
          this._openFns && this._openFns.forEach((f) => f({}));
        }, 0);
      }
      send() {}
      close() {}
      addEventListener(t, fn) {
        if (t === 'open') {
          (this._openFns = this._openFns || []).push(fn);
        }
      }
      removeEventListener() {}
    }
    FakeWS.CONNECTING = 0;
    FakeWS.OPEN = 1;
    FakeWS.CLOSING = 2;
    FakeWS.CLOSED = 3;
    // @ts-ignore
    window.WebSocket = FakeWS;
  });
}

function shot(page, name) {
  return page.screenshot({ path: `${OUT}/${PHASE}_${name}.png`, fullPage: true });
}

let browser, vite;
const results = [];
function note(msg) {
  console.log(msg);
  results.push(msg);
}

try {
  vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: WEB_DEMO_DIR, stdio: 'ignore', shell: process.platform === 'win32' });
  // wait server
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE); if (r.ok) { up = true; break; } } catch {}
    await sleep(400);
  }
  if (!up) throw new Error('vite dev không lên');

  browser = await chromium.launch();

  // ---------- SCENARIO A: profile (bug1 nháy field, bug2 menu, bug3 avatar cache) ----------
  {
    // Viewport RỘNG (≥lg) để Sidebar hiện → điều hướng SPA (KHÔNG reload) mô phỏng đúng "Settings↔Profile↔quay
    // lại" mà Admin Demo báo (cache module-level chỉ sống qua điều hướng SPA, không sống qua full reload/goto).
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installMocks(ctx);
    const page = await ctx.newPage();
    if (process.env.DEBUG) {
      page.on('console', (m) => console.log('  [console]', m.type(), m.text().slice(0, 200)));
      page.on('response', (r) => { if (r.url().includes('/v1/')) console.log('  [resp]', r.status(), r.request().method(), new URL(r.url()).pathname); });
      page.on('requestfailed', (r) => { if (r.url().includes('/v1/')) console.log('  [reqFAIL]', r.request().method(), new URL(r.url()).pathname, r.failure()?.errorText); });
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('  [nav]', f.url()); });
      page.on('pageerror', (e) => console.log('  [PAGEERROR]', e.message.slice(0, 300)));
    }
    await page.goto(`${BASE}/app/profile`, { waitUntil: 'domcontentloaded' });
    // chờ màn Profile mount (label "Giới tính")
    await page.waitForSelector('text=Giới tính', { timeout: 15000 });
    if (process.env.DEBUG) console.log('  [D0]', JSON.stringify(await page.evaluate(() => ({ sel: document.querySelectorAll('select').length, pulse: document.querySelectorAll('.animate-pulse').length, txt: document.body.innerText.slice(0, 120) }))));
    // (bug1) chụp NGAY trong lúc profile còn delay → after: skeleton; before: "-- Chưa chọn --"/rỗng
    await page.waitForTimeout(300);
    await shot(page, 'bug1_loading');
    // Phân biệt chuẩn: trong lúc profile CHƯA về, AFTER hiện skeleton (KHÔNG có <select>, KHÔNG hiện input
    // "Chưa có email"); BEFORE hiện NGAY <select> value rỗng ("-- Chưa chọn --") + input placeholder "Chưa có
    // email" = chính cái NHÁY. (Avatar skeleton có ở CẢ 2 nên KHÔNG dùng .animate-pulse làm căn cứ.)
    const g = await page.evaluate(() => ({
      hasFieldSelect: !!document.querySelector('select'),
      hasEmptyEmailInput: [...document.querySelectorAll('input')].some((i) => i.placeholder === 'Chưa có email'),
      hasPhoneInput: [...document.querySelectorAll('input')].some((i) => i.placeholder === 'Chưa có số điện thoại')
    }));
    note(`[A bug1] trong lúc tải: ${JSON.stringify(g)}  (after: hasFieldSelect false & hasEmptyEmailInput false = skeleton; before: true & true = field rỗng nháy)`);
    // chờ data về
    await page.waitForTimeout(1600);
    await shot(page, 'bug1_loaded');
    if (process.env.DEBUG) {
      const dump = await page.evaluate(() => ({
        url: location.href,
        bodyTextHead: document.body.innerText.slice(0, 300),
        selects: document.querySelectorAll('select').length,
        pulses: document.querySelectorAll('.animate-pulse').length,
        avatarBtn: !!document.querySelector('button[title="Đổi ảnh đại diện"]'),
        hasGioiTinh: document.body.innerText.includes('Giới tính'),
        cardCount: document.querySelectorAll('.rounded-lg-mac').length
      }));
      console.log('  [DUMP]', JSON.stringify(dump));
    }
    const genderVal = await page.$eval('select', (s) => s.value).catch(() => 'NO_SELECT');
    note(`[A bug1] sau khi tải xong select.value=${genderVal} (mong đợi FEMALE)`);

    // (bug2) mở menu avatar
    await page.click('button[title="Đổi ảnh đại diện"]');
    await page.waitForTimeout(250);
    await shot(page, 'bug2_menuopen');
    const menuItemBox = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Chụp ảnh mới'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const card = el.closest('.rounded-lg-mac');
      const cr = card ? card.getBoundingClientRect() : null;
      return { menuBottom: Math.round(r.bottom), menuVisible: r.width > 0 && r.height > 0, cardBottom: cr ? Math.round(cr.bottom) : -1 };
    });
    note(`[A bug2] menu item "Chụp ảnh mới": ${JSON.stringify(menuItemBox)} (after: menuVisible true & không bị cắt)`);
    // click ra NGOÀI menu — điểm nằm TRÊN backdrop overlay (dưới menu) → after: đóng; before: vẫn mở
    const bpt = await page.evaluate(() => {
      const menu = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Chụp ảnh mới'))?.closest('div');
      const bd = document.querySelector('.fixed.inset-0.z-40');
      if (!bd) return null;
      const br = bd.getBoundingClientRect();
      const mr = menu ? menu.getBoundingClientRect() : { bottom: br.top };
      return { x: Math.round(br.left + br.width / 2), y: Math.round(Math.min(mr.bottom + 120, br.bottom - 20)) };
    });
    note(`[A bug2] backdrop tồn tại? ${bpt ? 'CÓ, click tại ' + JSON.stringify(bpt) : 'KHÔNG (before: không có backdrop)'}`);
    if (bpt) await page.mouse.click(bpt.x, bpt.y);
    else await page.mouse.click(Math.round(page.viewportSize().width / 2), page.viewportSize().height - 60); // before: không có backdrop → click nền
    await page.waitForTimeout(250);
    await shot(page, 'bug2_afteroutsideclick');
    const menuStillOpen = await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Chụp ảnh mới')));
    note(`[A bug2] sau click ra ngoài, menu còn mở? ${menuStillOpen} (after mong đợi false; before mong đợi true — không đóng)`);

    // (bug3) đảm bảo avatar THẬT đã tải xong ở lần thăm đầu (cache module được nạp)
    await page.waitForSelector('img[src^="blob:"]', { timeout: 8000 }).catch(() => {});
    // Điều hướng SPA sang Danh bạ (Sidebar, KHÔNG reload) rồi goBack (popstate SPA) về Profile → cache còn nguyên.
    await page.getByText('Danh bạ', { exact: true }).first().click();
    await page.waitForSelector('text=Thu hồi', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(200);
    await page.goBack(); // popstate → React Router render lại Profile KHÔNG reload → module cache còn.
    await page.waitForSelector('text=Giới tính', { timeout: 15000 });
    await page.waitForTimeout(120); // rất ngắn — bắt "frame đầu" khi quay lại
    await shot(page, 'bug3_return');
    const avatarState = await page.evaluate(() => {
      const img = document.querySelector('img[src^="blob:"]');
      const pulse = document.querySelector('.h-24.animate-pulse');
      return { hasAvatarImg: !!img, hasAvatarSkeleton: !!pulse };
    });
    note(`[A bug3] quay lại Profile (SPA): ${JSON.stringify(avatarState)} (after: hasAvatarImg true & hasAvatarSkeleton false; before: hasAvatarSkeleton true)`);
    await ctx.close();
  }

  // ---------- SCENARIO B: contacts (bug4 thu hồi giật) ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await installMocks(ctx);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/app/contacts`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Thu hồi', { timeout: 15000 });
    await shot(page, 'bug4_before_click');
    const snapState = () => page.evaluate(() => ({
      fullSpinner: document.body.innerText.includes('Đang tải danh bạ'),
      outgoingGone: !document.body.innerText.includes('Lê Văn C'),
      friendsStillVisible: document.body.innerText.includes('Trần Thị B')
    }));
    await page.click('button:has-text("Thu hồi")');
    // (i) NGAY 120ms — after: optimistic đã bỏ item; before: chưa gì đổi (đang chờ API 600ms).
    await page.waitForTimeout(120);
    await shot(page, 'bug4_instant');
    const stInstant = await snapState();
    note(`[B bug4] +120ms: ${JSON.stringify(stInstant)} (after: outgoingGone true tức thì; before: outgoingGone false — chưa đổi)`);
    // (ii) +850ms — sau khi API mutate (600ms) xong: before bật spinner TOÀN MÀN + list biến mất; after vẫn mượt.
    await page.waitForTimeout(730);
    await shot(page, 'bug4_afterclick');
    const stDelayed = await snapState();
    note(`[B bug4] +850ms: ${JSON.stringify(stDelayed)} (after: fullSpinner false & friendsStillVisible true; before: fullSpinner true — giật)`);
    await ctx.close();
  }
} catch (e) {
  console.error('HARNESS ERROR:', e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (vite) vite.kill();
}
console.log(`\n=== PHASE=${PHASE} DONE ===`);
