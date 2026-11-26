// HARNESS R200 (Admin Demo 11/9 — "khi load phòng chat, tin nhắn OCR gửi vào cảm giác bị BÓP HẸP xong mới load về
// đúng kích thước làm giật giật"): dựng phòng chat mock có 6 tin ẢNH bill OCR (PosBillCard — đường render LIVE
// của bill POS trong chat), GIỮ response ảnh đính kèm lại (mô phỏng ảnh về chậm ~800ms) để LỘ rõ 2 thời điểm:
//   (1) TRƯỚC khi ảnh về — bubble chỉ có placeholder;
//   (2) SAU khi ảnh về — bubble phình ra kích thước thật.
// Đo: chiều cao TỪNG bubble ở (1) và (2) — SAU FIX 2 số này PHẢI BẰNG NHAU (đó là bằng chứng hết giật) — + tổng
// layout shift (PerformanceObserver 'layout-shift', CLS score) + độ trôi đáy khung cuộn + ảnh chụp 2 thời điểm.
// Chạy 2 LƯỢT: lượt 1 = lần đầu tiên thấy ảnh (nguội — chưa từng biết kích thước); lượt 2 = RELOAD lại phòng
// (đúng kịch bản Admin Demo tả "load phòng chat... như tin nhắn Zalo load lại") — kích thước đã biết từ lượt 1.
// Chạy: node --import tsx scripts/harness-chat-image-cls.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-chat-image-cls');
// Ảnh bill THẬT (portrait, chụp điện thoại) — cùng ảnh harness-bug1 dùng, KHÔNG vẽ mock lệch điều kiện.
const ANH_BILL = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');
const ROOM_ID = 'r-cls-test';
const SO_TIN = 7;

/** 7 tin IMAGE: 6 bill POS như bot Support SigMa gửi thật (caption chuẩn + metadataJson isBillImage — gate
 *  PosBillCard trong ChatBubble.tsx) + tin 7 = ảnh GHÉP HOÀN TIỀN (isRefundImage — đi nhánh ảnh w-260 trong
 *  ChatBubble, KHÔNG phải card — phủ nốt nhánh ảnh bill/refund còn lại). attachmentId att-1..att-7. */
function messagesBody(): unknown {
  const messages = Array.from({ length: SO_TIN }, (_, i) => {
    const n = i + 1;
    const laRefund = n === SO_TIN;
    return {
      id: `m${n}`,
      roomId: ROOM_ID,
      senderId: 99,
      senderName: 'Support SigMa',
      kind: 'IMAGE',
      body: laRefund
        ? 'Hoàn tiền lô 97 · 4.500.000đ'
        : `\u{1F9FE} Bill 5355007${n} · HKD DEMO 46 ${n} · ${n}.500.000đ · lô 9${n}`,
      attachmentId: `att-${n}`,
      metadataJson: JSON.stringify(laRefund ? { isRefundImage: true } : { isBillImage: true }),
      replyToMessageId: null,
      forwardedFromMessageId: null,
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(Date.UTC(2026, 8, 11, 2, 0, n)).toISOString(),
      attachmentMimeType: 'image/jpeg',
      attachmentSizeBytes: 537972
    };
  });
  // Server trả MỚI NHẤT TRƯỚC (client tự đảo) — giữ đúng contract listMessages().
  return { messages: messages.slice().reverse(), hasMore: false };
}

function roomSummary(): unknown {
  return {
    id: ROOM_ID, type: 'GROUP', name: 'ĐL- Test CLS', otherAgentId: null, avatarColor: '#0579cc',
    avatarUrl: null, pinnedMessageId: null, lastMessageAt: new Date().toISOString(), lastMessage: null,
    unreadCount: 0, myRole: 'MEMBER'
  };
}

function roomDetail(): unknown {
  return {
    id: ROOM_ID, type: 'GROUP', name: 'ĐL- Test CLS', avatarColor: '#0579cc', avatarUrl: null,
    directPairKey: null, pinnedMessageId: null, lastMessageAt: new Date().toISOString(), readOnly: false,
    requireApproval: false, maxMembers: null, createdBy: 99, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), members: []
  };
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface DoDac { id: string; w: number; h: number }

async function doKichThuoc(page: Page): Promise<DoDac[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[id^="msg-"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id, w: Math.round(r.width), h: Math.round(r.height) };
    })
  );
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const anh = await readFile(ANH_BILL);
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;

  // GIỮ ảnh lại tới khi harness thả (mô phỏng ảnh về chậm — lộ rõ trạng thái placeholder trước khi ảnh về).
  let giuAnh = true;
  let pendingAnh: Route[] = [];
  const thaAnh = async (): Promise<void> => {
    giuAnh = false;
    const ds = pendingAnh;
    pendingAnh = [];
    // ~800ms tổng độ trễ cảm nhận: harness đã giữ từ lúc tin render, thả rải 0-100ms cho giống mạng thật.
    await Promise.all(ds.map((r, i) => new Promise<void>((ok) => setTimeout(() => { void r.fulfill({ status: 200, contentType: 'image/jpeg', body: anh }).then(ok, () => ok()); }, i * 20))));
  };

  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/chat-realtime|AppShell|real-time|hết hạn|WebSocket/.test(m.text())) console.log('CONSOLE-ERR:', m.text()); });
    await page.addInitScript({
      content: [
        "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguyen Van A' }));",
        "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguyen Van A', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));",
        // Đo layout shift THẬT trong page (PerformanceObserver 'layout-shift') — KHÔNG suy luận từ ảnh chụp.
        'window.__cls = 0; window.__clsN = 0;',
        "new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) { window.__cls += e.value; window.__clsN += 1; } } }).observe({ type: 'layout-shift', buffered: true });",
        'function FakeWS(){ this.readyState = 0; }',
        'FakeWS.prototype.addEventListener = function(){};',
        'FakeWS.prototype.removeEventListener = function(){};',
        'FakeWS.prototype.send = function(){};',
        'FakeWS.prototype.close = function(){};',
        'window.WebSocket = FakeWS;'
      ].join(String.fromCharCode(10))
    });
    await page.routeWebSocket(/^ws/, () => { /* chặn realtime */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.includes('/v1/chat/attachments/att-')) {
        if (giuAnh) { pendingAnh.push(route); return; }
        return route.fulfill({ status: 200, contentType: 'image/jpeg', body: anh });
      }
      // chatFetch() đòi envelope {ok:true, data:...} (xem chat-client.ts) — mock PHẢI đúng shape thật.
      if (p.endsWith('/v1/me/friends')) return json(route, 200, { ok: true, data: { friends: [] }, friends: [] });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/messages`) && method === 'GET') return json(route, 200, { ok: true, data: messagesBody() });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/members`)) return json(route, 200, { ok: true, data: [] });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/pins`)) return json(route, 200, { ok: true, data: [] });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}`) && method === 'GET') return json(route, 200, { ok: true, data: roomDetail() });
      if (p.endsWith('/v1/chat/rooms') && method === 'GET') return json(route, 200, { ok: true, data: [roomSummary()] });
      if (p.includes('/reactions')) return json(route, 200, { ok: true, data: {} });
      const listLike = /friends|categories|contacts|birthday|notifications|feed|comments|members|tids|list/i.test(p);
      return json(route, 200, method === 'GET' && listLike ? [] : {});
    });

    const chayMotLuot = async (ten: string): Promise<{ truoc: DoDac[]; sau: DoDac[]; cls: number; clsN: number; troiDay: number }> => {
      giuAnh = true;
      pendingAnh = [];
      await page.goto(`${baseUrl}/app/chat/${ROOM_ID}`, { waitUntil: 'domcontentloaded' });
      // Chờ ĐỦ 6 bubble tin nhắn render (ảnh vẫn đang bị giữ — trạng thái placeholder).
      try {
        await page.waitForFunction((n) => document.querySelectorAll('[id^="msg-"]').length >= n, SO_TIN, { timeout: 20000 });
      } catch (err) {
        console.log('[debug] URL hiện tại:', page.url());
        console.log('[debug] body text:', (await page.evaluate(() => document.body.innerText.slice(0, 600))).replace(/\n+/g, ' | '));
        await page.screenshot({ path: path.join(OUT, `${ten}-debug-timeout.png`), fullPage: true });
        throw err;
      }
      await page.waitForTimeout(350); // settle layout placeholder
      const truoc = await doKichThuoc(page);
      const dayTruoc = await page.evaluate(() => {
        const el = document.querySelector('.overflow-auto.space-y-3') as HTMLElement | null;
        return el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : null;
      });
      await page.screenshot({ path: path.join(OUT, `${ten}-1-truoc-anh-ve.png`), fullPage: false });
      await page.evaluate(() => { (window as unknown as { __cls: number; __clsN: number }).__cls = 0; (window as unknown as { __cls: number; __clsN: number }).__clsN = 0; });
      // Thả ảnh về (sau ~800ms giữ) → đo lại.
      await thaAnh();
      await page.waitForFunction((n) => {
        const imgs = [...document.querySelectorAll('[id^="msg-"] img')] as HTMLImageElement[];
        return imgs.length >= n && imgs.every((im) => im.complete && im.naturalWidth > 0);
      }, SO_TIN, { timeout: 15000 });
      await page.waitForTimeout(700); // settle sau load (fade/scroll)
      const sau = await doKichThuoc(page);
      const clsInfo = await page.evaluate(() => ({ cls: (window as unknown as { __cls: number }).__cls, n: (window as unknown as { __clsN: number }).__clsN }));
      const daySau = await page.evaluate(() => {
        const el = document.querySelector('.overflow-auto.space-y-3') as HTMLElement | null;
        return el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : null;
      });
      await page.screenshot({ path: path.join(OUT, `${ten}-2-sau-anh-ve.png`), fullPage: false });
      // Độ trôi đáy: đang neo đáy trước khi ảnh về — sau khi ảnh về còn cách đáy bao nhiêu px (0 = giữ đáy chuẩn).
      const troiDay = daySau && dayTruoc ? Math.round(daySau.height - daySau.client - daySau.top) : -1;
      return { truoc, sau, cls: clsInfo.cls, clsN: clsInfo.n, troiDay };
    };

    const inKetQua = (ten: string, kq: { truoc: DoDac[]; sau: DoDac[]; cls: number; clsN: number; troiDay: number }): boolean => {
      console.log(`\n=== ${ten} ===`);
      console.log('bubble        | TRƯỚC (w×h)   | SAU (w×h)     | lệch cao');
      let lechTong = 0;
      for (const t of kq.truoc) {
        const s = kq.sau.find((x) => x.id === t.id);
        const dh = s ? s.h - t.h : NaN;
        lechTong += Math.abs(dh || 0);
        console.log(`${t.id.padEnd(13)} | ${String(t.w + '×' + t.h).padEnd(13)} | ${String(s ? s.w + '×' + s.h : '?').padEnd(13)} | ${dh >= 0 ? '+' : ''}${dh}px`);
      }
      console.log(`CLS score: ${kq.cls.toFixed(4)} (${kq.clsN} lần shift) · tổng lệch cao: ${lechTong}px · trôi đáy khung cuộn: ${kq.troiDay}px`);
      const on = lechTong === 0 && kq.cls < 0.02 && Math.abs(kq.troiDay) <= 2;
      console.log(on ? '  ✅ KHÔNG giật (kích thước trước=sau, CLS ~0, đáy giữ nguyên)' : '  ❌ CÒN GIẬT ở lượt này');
      return on;
    };

    const luot1 = await chayMotLuot('luot1-lan-dau');
    const luot2 = await chayMotLuot('luot2-reload');

    const ok1 = inKetQua('LƯỢT 1 — lần ĐẦU thấy ảnh (nguội, chưa biết kích thước)', luot1);
    const ok2 = inKetQua('LƯỢT 2 — RELOAD phòng (kịch bản Admin Demo tả)', luot2);
    // Chuẩn nghiệm thu: lượt 2 (kịch bản user tả) PHẢI sạch tuyệt đối; lượt 1 chưa từng biết kích thước —
    // chấp nhận còn 1 nhịp phình NHƯNG đáy phải được giữ (không trôi) để không giật màn hình.
    const luot1DayOn = Math.abs(luot1.troiDay) <= 2;
    console.log(`\nTỔNG KẾT: lượt2=${ok2 ? 'SẠCH' : 'CÒN GIẬT'} · lượt1 giữ đáy=${luot1DayOn ? 'CÓ' : 'KHÔNG'}${ok1 ? ' (lượt 1 cũng sạch hoàn toàn)' : ''}`);
    if (!ok2 || !luot1DayOn) process.exitCode = 1;
    console.log('[harness] Ảnh ->', OUT);
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
