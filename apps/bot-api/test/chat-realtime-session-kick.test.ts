// #3 (6/8, Admin Demo "đăng nhập máy mới đá phiên CŨ CÙNG NỀN như Zalo") — test ĐÁ realtime: khi
// revokeOtherSessionsSamePlatform thu hồi 1 phiên, MỌI socket chat-realtime của phiên đó nhận
// {msg:'session-revoked',reason:'logged-in-elsewhere'} rồi bị đóng (SESSION_REVOKED_CLOSE_CODE); socket của
// phiên NỀN KHÁC KHÔNG bị đụng. Dùng WebSocket THẬT + DB throwaway (KHÔNG mock) — CÙNG khuôn
// chat-realtime-proxy.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachChatRealtimeProxy, resetChatRealtimeConnectionCountForTest, getSessionSocketCountForTest } from '../src/chat-realtime-proxy.js';
import { resetChatRealtimeHubForTest } from '../src/chat-realtime-hub.js';
import { SESSION_REVOKED_CLOSE_CODE } from '../src/ws-cookie-session.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, revokeOtherSessionsSamePlatform, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { makeAgent } from './fixtures.js';
import { attachMessageBuffer } from './_ws-test-helpers.js';

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

describe('chat-realtime — đá socket theo sessionId khi đăng nhập thiết bị khác CÙNG NỀN', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    resetChatRealtimeHubForTest();
    resetChatRealtimeConnectionCountForTest();
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachChatRealtimeProxy(server); // đăng ký setSessionKickHandler(kickSessions)
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connect(sessionId: string): Promise<{ ws: WebSocket; buf: ReturnType<typeof attachMessageBuffer> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${sessionId}` } });
    const buf = attachMessageBuffer(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await buf.waitFor((d) => d.msg === 'ready');
    return { ws, buf };
  }

  it('2 kết nối cùng sessionId apk bị đá → CẢ HAI nhận session-revoked + đóng; phiên web KHÔNG bị đụng', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const rcUserId = `rc-kick-${Date.now()}`;
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId } });

    // Phiên apk CŨ (sẽ bị đá) + phiên web (nền khác, GIỮ) + phiên apk MỚI (except, đại diện máy vừa đăng nhập).
    const apkOld = await createWebSession(db, { agentId: agent.id, rcUserId, rcAuthToken: 't-apk-old', platform: 'apk', userAgent: UA_ANDROID });
    const web = await createWebSession(db, { agentId: agent.id, rcUserId, rcAuthToken: 't-web', platform: 'web', userAgent: UA_BROWSER });
    const apkNew = await createWebSession(db, { agentId: agent.id, rcUserId, rcAuthToken: 't-apk-new', platform: 'apk', userAgent: UA_ANDROID });

    // 2 kết nối của phiên apk cũ (2 tab/2 socket) + 1 kết nối phiên web.
    const c1 = await connect(apkOld.id);
    const c2 = await connect(apkOld.id);
    const cWeb = await connect(web.id);

    const closes = new Map<WebSocket, number>();
    for (const ws of [c1.ws, c2.ws]) ws.on('close', (code) => closes.set(ws, code));
    let webClosed = false;
    cWeb.ws.on('close', () => { webClosed = true; });

    // registry đá-phiên đã có đúng 2 socket cho apkOld, 1 cho web.
    await new Promise((r) => setTimeout(r, 20));
    expect(getSessionSocketCountForTest(apkOld.id)).toBe(2);
    expect(getSessionSocketCountForTest(web.id)).toBe(1);

    // ĐÁ phiên cũ CÙNG NỀN (apk) — đại diện máy MỚI (apkNew) vừa đăng nhập apk.
    const kicked = await revokeOtherSessionsSamePlatform(db, agent.id, 'apk', apkNew.id);
    expect(kicked).toEqual([apkOld.id]);

    // CẢ 2 socket của apkOld nhận session-revoked + đóng đúng code.
    const m1 = await c1.buf.waitFor((d) => d.msg === 'session-revoked');
    const m2 = await c2.buf.waitFor((d) => d.msg === 'session-revoked');
    expect(m1).toEqual({ msg: 'session-revoked', reason: 'logged-in-elsewhere' });
    expect(m2).toEqual({ msg: 'session-revoked', reason: 'logged-in-elsewhere' });

    await new Promise((r) => setTimeout(r, 50));
    expect(closes.get(c1.ws)).toBe(SESSION_REVOKED_CLOSE_CODE);
    expect(closes.get(c2.ws)).toBe(SESSION_REVOKED_CLOSE_CODE);
    expect(getSessionSocketCountForTest(apkOld.id)).toBe(0); // registry dọn sạch sau close

    // Phiên WEB (nền khác) KHÔNG nhận session-revoked, KHÔNG bị đóng.
    await expect(cWeb.buf.waitFor((d) => d.msg === 'session-revoked', 100)).rejects.toThrow();
    expect(webClosed).toBe(false);
    expect(cWeb.ws.readyState).toBe(WebSocket.OPEN);

    cWeb.ws.terminate();
  });
});
