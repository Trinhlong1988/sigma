// HARNESS R200 (Admin Demo 18/9) — "gợi ý trong màn sửa chưa?"
//
// Màn SỬA BILL (nút Sửa trên card POS trong chat, password-gate) trước đây chỉ có Ô TID TRẦN — bill OCR mù cả
// TID lẫn tên thì không biết gõ gì. Nay: GET /v1/ocr-send/tid-list → dropdown chọn TÊN HKD tự điền TID.
// Kiểm bằng ĐIỀU KHIỂN THẬT: mở phòng chat (mock tin bill POS) → bấm "Sửa" → modal mở → dropdown hiện đủ danh
// sách → chọn TÊN → ô TID đổi đúng.
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-sua-bill-chon-ten');
const BILL_IMG = 'C:/Users/ADMINI~1/AppData/Local/Temp/claude/C--Users-Administrator/deced379-aec3-4e56-a36a-8b4722d79f70/scratchpad/bill-lo75.jpg';
const ROOM_ID = 'room-demo';

const TID_LIST = [
  { tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45' },
  { tid: '53550080', hkdName: 'HKD DEMO 18' },
  { tid: '53590003', hkdName: 'HKD DEMO 5' },
  { tid: 'DEMO-TID-08', hkdName: 'HKD DEMO 49' }
];

// Tin bill POS (caption chuẩn bot gửi — parsePosBill đọc được tid/amount/lô/hkd)
const MESSAGES = { messages: [{
  id: 'm1', roomId: ROOM_ID, senderId: 99, senderName: 'Support SigMa', kind: 'IMAGE',
  body: '\u{1F9FE} Bill 53550080 · HKD DEMO 18 · 87.200.000đ · lô 92',
  attachmentId: 'att-1', metadataJson: JSON.stringify({ isBillImage: true }),
  replyToMessageId: null, forwardedFromMessageId: null, editedAt: null, deletedAt: null,
  createdAt: new Date().toISOString(), attachmentMimeType: 'image/jpeg', attachmentSizeBytes: 100000
}], hasMore: false };

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  console.log('[harness] build...');
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  const anh = await readFile(BILL_IMG);
  let goiTidList = 0;

  let browser: Browser | undefined;
  const ket: string[] = [];
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)));
    await page.addInitScript(`
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguyen Van A', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      function FakeWS(){ this.readyState = 0; }
      FakeWS.prototype.addEventListener = function(){};
      FakeWS.prototype.removeEventListener = function(){};
      FakeWS.prototype.send = function(){};
      FakeWS.prototype.close = function(){};
      window.WebSocket = FakeWS;
    `);
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.endsWith('/v1/ocr-send/tid-list')) { goiTidList++; return json(route, { ok: true, list: TID_LIST }); }
      if (p.includes('/v1/chat/attachments/')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: anh });
      // chatFetch() đòi envelope {ok:true, data:...} — shape mượn từ harness-chat-image-cls (đã chạy được thật).
      if (p.endsWith('/v1/me/friends')) return json(route, { ok: true, data: { friends: [] }, friends: [] });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/messages`) && method === 'GET') return json(route, { ok: true, data: MESSAGES });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/members`)) return json(route, { ok: true, data: [] });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/pins`)) return json(route, { ok: true, data: [] });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}`) && method === 'GET') return json(route, { ok: true, data: { id: ROOM_ID, type: 'GROUP', name: 'ĐL - Demo', avatarColor: '#0579cc', avatarUrl: null, directPairKey: null, pinnedMessageId: null, lastMessageAt: new Date().toISOString(), readOnly: false, requireApproval: false, maxMembers: null, createdBy: 99, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), members: [] } });
      if (p.endsWith('/v1/chat/rooms') && method === 'GET') return json(route, { ok: true, data: [{ id: ROOM_ID, type: 'GROUP', name: 'ĐL - Demo', otherAgentId: null, avatarColor: '#0579cc', avatarUrl: null, pinnedMessageId: null, lastMessageAt: new Date().toISOString(), lastMessage: null, unreadCount: 0, myRole: 'MEMBER' }] });
      if (p.includes('/reactions')) return json(route, { ok: true, data: {} });
      const listLike = /friends|categories|contacts|birthday|notifications|feed|comments|members|tids|list/i.test(p);
      return json(route, method === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/chat/${ROOM_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const cardCo = await page.getByText('HKD DEMO 18').first().isVisible().catch(() => false);
    ket.push(`card bill POS hiện=${cardCo}`);
    await page.screenshot({ path: path.join(OUT, '1-card.png') });

    // Bấm "Sửa" trên card → modal
    await page.getByRole('button', { name: 'Sửa' }).first().click().catch((e) => console.log('click Sửa lỗi:', e.message));
    await page.waitForTimeout(1200);
    const ddCo = await page.locator('[data-testid="sua-chon-ten-hkd"]').first().isVisible().catch(() => false);
    const soOption = await page.locator('[data-testid="sua-chon-ten-hkd"] option').count().catch(() => 0);
    ket.push(`modal Sửa: dropdown TÊN hiện=${ddCo} · số option=${soOption} (kỳ vọng ${TID_LIST.length + 1}) · API tid-list được gọi=${goiTidList} lần`);
    const dangChon = await page.locator('[data-testid="sua-chon-ten-hkd"]').first().inputValue().catch(() => '?');
    ket.push(`đang chọn theo TID của bill (53550080)=${dangChon}`);

    // Chọn "HKD DEMO 5" → ô TID phải thành 53590003 (đúng ca Admin Demo: lô 103 Thái Bình 1)
    await page.locator('[data-testid="sua-chon-ten-hkd"]').first().selectOption('53590003');
    await page.waitForTimeout(400);
    const oTid = await page.locator('input[placeholder="TID"]').first().inputValue().catch(() => '?');
    ket.push(`chọn "HKD DEMO 5" → ô TID = ${oTid} (kỳ vọng 53590003)`);
    await page.screenshot({ path: path.join(OUT, '2-modal-da-chon.png') });

    console.log('\n================ KẾT QUẢ ================');
    for (const d of ket) console.log(d);
    console.log('Ảnh ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
