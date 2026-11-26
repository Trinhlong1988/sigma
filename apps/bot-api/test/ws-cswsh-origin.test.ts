// LANE A Vòng 2 (3/8) — CSWSH (Cross-Site WebSocket Hijacking): TRƯỚC ĐÂY 2 endpoint WebSocket
// (`/v1/chat-realtime`, `/v1/call-signaling`) KHÔNG kiểm `Origin` ở bước upgrade → bất kỳ trang web độc hại
// nào người dùng đã đăng nhập lỡ mở đều có thể `new WebSocket('wss://.../v1/chat-realtime')` — trình duyệt
// TỰ đính kèm cookie phiên (sigma_ws) nên kết nối XÁC THỰC THÀNH CÔNG, kẻ tấn công điều khiển được.
// Trình duyệt KHÔNG áp same-origin/CORS cho WebSocket (khác fetch/XHR) — server PHẢI tự kiểm Origin.
// Test dưới đây chứng minh: (1) origin lạ (https://evil.com) + phiên HỢP LỆ vẫn BỊ TỪ CHỐI (socket.destroy);
// (2) origin trong allowlist chung (CORS_ALLOWED_ORIGINS) → chấp nhận (mở được); (3) KHÔNG có Origin (app
// native/Capacitor/công cụ không phải trình duyệt — không phải vector CSWSH) → chấp nhận.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachChatRealtimeProxy, resetChatRealtimeConnectionCountForTest } from '../src/chat-realtime-proxy.js';
import { attachCallSignaling } from '../src/call-signaling-server.js';
import { resetChatRealtimeHubForTest } from '../src/chat-realtime-hub.js';
import { isAllowedWsOrigin } from '../src/ws-origin-check.js';
// Import allowlist từ module LÁ (cors-allowlist.js), KHÔNG từ app.js — tránh kéo đồ thị router của app vào
// cùng graph với các module WebSocket ở đây (gây circular import làm `new WebSocketServer` văng).
import { CORS_ALLOWED_ORIGINS } from '../src/cors-allowlist.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { makeAgent } from './fixtures.js';

const EVIL_ORIGIN = 'https://evil-cswsh-attacker.example.com';

/** Tạo 1 phiên WebSession HỢP LỆ đã link Agent (rcUserId khớp) — để test khẳng định lý do DUY NHẤT bị từ chối
 * là Origin, KHÔNG phải phiên hỏng. */
async function makeAuthedSession(tag: string): Promise<string> {
  const db = getBotDb();
  const agent = await makeAgent();
  const rcUserId = `rc-cswsh-${tag}-${agent.id}-${Date.now()}`;
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId } });
  const session = await createWebSession(db, { rcUserId, rcAuthToken: 'dummy-tok', agentId: agent.id });
  return session.id;
}

/** Kết quả đầu tiên của 1 kết nối WS: mở được ('open') hay bị đóng/lỗi ('rejected'). CSWSH đúng = KHÔNG BAO
 * GIỜ 'open' với origin lạ. */
function firstOutcome(ws: WebSocket): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('close', () => resolve('rejected'));
    ws.on('error', () => resolve('rejected'));
  });
}

function connect(port: number, path: string, sessionId: string, origin?: string): WebSocket {
  const headers: Record<string, string> = { Cookie: `${WEB_SESSION_COOKIE_NAME}=${sessionId}` };
  if (origin !== undefined) headers.Origin = origin;
  return new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
}

describe('isAllowedWsOrigin (thuần) — allowlist CHUNG với CORS (app.ts)', () => {
  it('origin trong CORS_ALLOWED_ORIGINS → cho phép', () => {
    for (const o of CORS_ALLOWED_ORIGINS) expect(isAllowedWsOrigin(o)).toBe(true);
  });

  it('origin native Capacitor https://localhost (đã có trong allowlist) → cho phép', () => {
    expect(isAllowedWsOrigin('https://localhost')).toBe(true);
  });

  it('origin RỖNG/undefined (app native/không phải trình duyệt) → cho phép (không phải vector CSWSH)', () => {
    expect(isAllowedWsOrigin(undefined)).toBe(true);
    expect(isAllowedWsOrigin('')).toBe(true);
  });

  it('origin lạ ngoài allowlist → TỪ CHỐI', () => {
    expect(isAllowedWsOrigin(EVIL_ORIGIN)).toBe(false);
    expect(isAllowedWsOrigin('http://evil.com')).toBe(false);
    // Không được "startsWith" hớ hênh: origin bắt đầu bằng 1 origin hợp lệ nhưng khác host thật → TỪ CHỐI.
    expect(isAllowedWsOrigin('http://localhost:5173.evil.com')).toBe(false);
  });
});

describe('CSWSH — /v1/chat-realtime kiểm Origin ở upgrade', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    resetChatRealtimeHubForTest();
    resetChatRealtimeConnectionCountForTest();
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachChatRealtimeProxy(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('origin lạ (https://evil.com) + phiên HỢP LỆ → BỊ TỪ CHỐI (KHÔNG mở được), dù cookie đúng', async () => {
    const sessionId = await makeAuthedSession('chat-evil');
    const ws = connect(port, '/v1/chat-realtime', sessionId, EVIL_ORIGIN);
    expect(await firstOutcome(ws)).toBe('rejected');
    ws.terminate();
  });

  it('origin trong allowlist (CORS_ALLOWED_ORIGINS[0]) + phiên hợp lệ → MỞ ĐƯỢC', async () => {
    const sessionId = await makeAuthedSession('chat-ok');
    const ws = connect(port, '/v1/chat-realtime', sessionId, CORS_ALLOWED_ORIGINS[0]);
    expect(await firstOutcome(ws)).toBe('open');
    ws.terminate();
  });

  it('KHÔNG có Origin (app native) + phiên hợp lệ → MỞ ĐƯỢC (không phá app thật)', async () => {
    const sessionId = await makeAuthedSession('chat-native');
    const ws = connect(port, '/v1/chat-realtime', sessionId, undefined);
    expect(await firstOutcome(ws)).toBe('open');
    ws.terminate();
  });
});

describe('CSWSH — /v1/call-signaling kiểm Origin ở upgrade', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachCallSignaling(server, { ringTimeoutMs: 200, signalingTimeoutMs: 200 });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('origin lạ (https://evil.com) + phiên HỢP LỆ → BỊ TỪ CHỐI (KHÔNG mở được), dù cookie đúng', async () => {
    const sessionId = await makeAuthedSession('call-evil');
    const ws = connect(port, '/v1/call-signaling', sessionId, EVIL_ORIGIN);
    expect(await firstOutcome(ws)).toBe('rejected');
    ws.terminate();
  });

  it('origin trong allowlist + phiên hợp lệ → MỞ ĐƯỢC', async () => {
    const sessionId = await makeAuthedSession('call-ok');
    const ws = connect(port, '/v1/call-signaling', sessionId, CORS_ALLOWED_ORIGINS[0]);
    expect(await firstOutcome(ws)).toBe('open');
    ws.terminate();
  });

  it('KHÔNG có Origin (app native) + phiên hợp lệ → MỞ ĐƯỢC', async () => {
    const sessionId = await makeAuthedSession('call-native');
    const ws = connect(port, '/v1/call-signaling', sessionId, undefined);
    expect(await firstOutcome(ws)).toBe('open');
    ws.terminate();
  });
});
