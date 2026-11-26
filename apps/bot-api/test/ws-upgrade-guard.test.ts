// LANE A Vòng 2 (3/8) — guard đóng upgrade path lạ (chống rò FD/DoS). Xem ws-upgrade-guard.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachChatRealtimeProxy, resetChatRealtimeConnectionCountForTest } from '../src/chat-realtime-proxy.js';
import { attachCallSignaling } from '../src/call-signaling-server.js';
import { attachUnknownUpgradeGuard } from '../src/ws-upgrade-guard.js';
import { resetChatRealtimeHubForTest } from '../src/chat-realtime-hub.js';
import { SESSION_EXPIRED_CLOSE_CODE } from '../src/ws-cookie-session.js';
import { WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';

const UNKNOWN_PATH = '/v1/khong-ton-tai-path-la-nao-do';

/** Kết quả trong `timeoutMs`: 'closed' nếu socket bị đóng/lỗi (guard đã diệt), 'hanging' nếu KHÔNG có sự kiện
 * gì (socket bị treo nửa-mở — chính là rò FD). KHÔNG bao giờ 'open' cho path lạ. */
function outcomeWithin(ws: WebSocket, timeoutMs: number): Promise<'open' | 'closed' | 'hanging'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('hanging'), timeoutMs);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve('open');
    });
    ws.on('close', () => {
      clearTimeout(timer);
      resolve('closed');
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve('closed');
    });
  });
}

// GHI CHÚ (LEAD review): CỐ Ý KHÔNG viết test "KHÔNG có guard thì path lạ bị treo" — 1 upgrade request không
// ai xử lý giữ 1 socket TCP nửa-mở vô thời hạn mà `server.close()`/`closeAllConnections()` KHÔNG dọn sạch được
// → hookTimeout 60s treo cả suite (đã tự chạy xác nhận, CÙNG lý do rc-realtime-proxy.test.ts đã ghi khi bỏ 1
// test tương tự). Giá trị regression của guard được đảm bảo bằng test dưới đây: nếu ai gỡ guard, test "path lạ
// → socket bị ĐÓNG NGAY" sẽ nhận 'hanging' thay vì 'closed' → ĐỎ ngay.

describe('ws-upgrade-guard — guard đóng NGAY upgrade path lạ, KHÔNG đụng path hợp lệ', () => {
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
    attachCallSignaling(server, { ringTimeoutMs: 500, signalingTimeoutMs: 500 });
    attachUnknownUpgradeGuard(server); // ĐĂNG KÝ CUỐI CÙNG (lưới an toàn sau cùng).
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('upgrade tới path lạ → socket bị ĐÓNG NGAY (không treo, không rò FD)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${UNKNOWN_PATH}`);
    const outcome = await outcomeWithin(ws, 2000);
    expect(outcome).toBe('closed');
    ws.terminate();
  });

  it('upgrade tới /v1/call-signaling (path HỢP LỆ) KHÔNG cookie → guard KHÔNG đụng, vẫn nhận SESSION_EXPIRED_CLOSE_CODE của endpoint', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/call-signaling`);
    const code = await new Promise<number>((resolve, reject) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', reject);
    });
    expect(code).toBe(SESSION_EXPIRED_CLOSE_CODE);
    ws.terminate();
  });

  it('upgrade tới /v1/chat-realtime (path HỢP LỆ) KHÔNG cookie → guard KHÔNG đụng, vẫn nhận SESSION_EXPIRED_CLOSE_CODE', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, {
      headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=` }
    });
    const code = await new Promise<number>((resolve, reject) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', reject);
    });
    expect(code).toBe(SESSION_EXPIRED_CLOSE_CODE);
    ws.terminate();
  });
});
