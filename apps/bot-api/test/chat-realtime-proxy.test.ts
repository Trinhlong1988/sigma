// SIGMA Phase 3 "real-time" (29/7) — test chat-realtime-proxy.ts. CÙNG khuôn rc-realtime-proxy.test.ts
// ("reject upgrade khi cookie thiếu/không hợp lệ") NHƯNG ở đây KHÔNG cần "KHÔNG chạm RC thật" (hệ chat lõi
// KHÔNG có phía trên nào để relay — mọi state là DB Postgres throwaway của chính suite này), nên test được
// ĐẦY ĐỦ HƠN rc-realtime-proxy.test.ts: cả reject lẫn round-trip subscribe hợp lệ + lỗi quyền KHÔNG đóng
// kết nối (dùng service/DB thật, KHÔNG mock).
//
// Dùng `attachMessageBuffer()` (_ws-test-helpers.ts) thay vì tự `ws.on('message', ...)` rời rạc — xem comment
// đầu file đó cho BUG THẬT đã tự bắt được (race mất message `ready` nếu đăng ký listener SAU khi await 'open').
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  attachChatRealtimeProxy,
  resetChatRealtimeConnectionCountForTest,
  getChatRealtimeConnectionCountForTest
} from '../src/chat-realtime-proxy.js';
import { SESSION_EXPIRED_CLOSE_CODE } from '../src/ws-cookie-session.js';
import { resetChatRealtimeHubForTest } from '../src/chat-realtime-hub.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { findOrCreateDirectRoom } from '../src/services/chat-room-service.js';
import { attachMessageBuffer } from './_ws-test-helpers.js';

async function expectRejectedWithSessionExpired(ws: WebSocket): Promise<void> {
  const buf = attachMessageBuffer(ws);
  const closeCode = await new Promise<number>((resolve, reject) => {
    ws.on('close', (code) => resolve(code));
    ws.on('error', reject);
  });
  expect(closeCode).toBe(SESSION_EXPIRED_CLOSE_CODE);
  await expect(buf.waitFor(() => true, 50)).rejects.toThrow(); // KHÔNG có bất kỳ message nào từng tới.
}

describe('chat-realtime-proxy — reject upgrade khi cookie thiếu/không hợp lệ/agent chưa liên kết', () => {
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

  it('KHÔNG có cookie nào → đóng NGAY với SESSION_EXPIRED_CLOSE_CODE', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`);
    await expectRejectedWithSessionExpired(ws);
  });

  it('cookie trỏ tới session KHÔNG tồn tại trong DB → đóng NGAY với SESSION_EXPIRED_CLOSE_CODE', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, {
      headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=session-khong-ton-tai-chat-realtime` }
    });
    await expectRejectedWithSessionExpired(ws);
  });

  it('cookie trỏ tới session ĐÃ HẾT HẠN → đóng NGAY với SESSION_EXPIRED_CLOSE_CODE', async () => {
    const db = getBotDb();
    const row = await db.webSession.create({
      data: { rcUserId: 'rc-chat-realtime-expired', rcAuthToken: 'tok-expired', expiresAt: new Date(Date.now() - 60_000) }
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, {
      headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${row.id}` }
    });
    await expectRejectedWithSessionExpired(ws);
  });

  it('session hợp lệ NHƯNG rcUserId KHÔNG khớp Agent nào còn sống (chưa liên kết) → đóng NGAY với SESSION_EXPIRED_CLOSE_CODE', async () => {
    const db = getBotDb();
    const session = await createWebSession(db, { rcUserId: 'rc-chat-realtime-khong-link-agent-nao', rcAuthToken: 'tok-x' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, {
      headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` }
    });
    await expectRejectedWithSessionExpired(ws);
  });

  it('vượt quá số kết nối đồng thời cho phép/session → kết nối thừa bị đóng thô (KHÔNG dùng SESSION_EXPIRED_CLOSE_CODE)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const rcUserId = 'rc-chat-realtime-cap-test';
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId } });
    const session = await createWebSession(db, { rcUserId, rcAuthToken: 'tok-cap-test' });

    const filler: WebSocket[] = [];
    for (let i = 0; i < 5; i++) {
      filler.push(new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` } }));
    }
    await Promise.all(filler.map((f) => new Promise<void>((resolve) => f.on('open', () => resolve()))));

    const ws6 = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` } });
    const outcome = await new Promise<'open' | 'error' | 'close'>((resolve) => {
      ws6.on('open', () => resolve('open'));
      ws6.on('error', () => resolve('error'));
      ws6.on('close', (code) => {
        expect(code).not.toBe(SESSION_EXPIRED_CLOSE_CODE);
        resolve('close');
      });
    });
    expect(outcome).not.toBe('open');
    filler.forEach((f) => f.terminate());
    ws6.terminate();
  });
});

describe('chat-realtime-proxy — round-trip subscribe hợp lệ + lỗi quyền KHÔNG đóng kết nối (DB thật)', () => {
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

  async function connectAuthed(rcUserId: string, sessionToken: string) {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId } });
    const session = await createWebSession(db, { rcUserId, rcAuthToken: sessionToken });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` } });
    const buf = attachMessageBuffer(ws); // ĐĂNG KÝ TRƯỚC khi đợi 'open' — xem comment _ws-test-helpers.ts.
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await buf.waitFor((d) => d.msg === 'ready');
    return { ws, agent, buf };
  }

  it('kết nối hợp lệ → nhận {msg:"ready"} ngay sau handshake', async () => {
    const { ws } = await connectAuthed('rc-chat-realtime-ready', 'tok-ready');
    ws.terminate();
  });

  it('subscribe-room ĐÚNG phòng mình là thành viên → nhận {msg:"subscribed",roomId}', async () => {
    const { ws: wsA, agent: a, buf: bufA } = await connectAuthed('rc-chat-realtime-sub-a', 'tok-sub-a');
    const { ws: wsBTmp, agent: b } = await connectAuthed('rc-chat-realtime-sub-b', 'tok-sub-b');
    wsBTmp.terminate();
    await makeFriends(a.id, b.id);
    const room = await findOrCreateDirectRoom(getBotDb(), a.id, b.id);

    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId: room.id }));
    const msg = await bufA.waitFor((d) => d.msg === 'subscribed' || d.msg === 'error');
    expect(msg).toEqual({ msg: 'subscribed', roomId: room.id });
    wsA.terminate();
  });

  it('subscribe-room phòng KHÔNG tồn tại/KHÔNG phải thành viên → nhận {msg:"error",code:"NOT_MEMBER",roomId} NHƯNG kết nối KHÔNG bị đóng (vẫn subscribe được phòng hợp lệ ngay sau đó)', async () => {
    const { ws: wsA, agent: a, buf: bufA } = await connectAuthed('rc-chat-realtime-forbid-a', 'tok-forbid-a');
    const { ws: wsB, agent: b } = await connectAuthed('rc-chat-realtime-forbid-b', 'tok-forbid-b');
    await makeFriends(a.id, b.id);
    const room = await findOrCreateDirectRoom(getBotDb(), a.id, b.id);

    let closed = false;
    wsA.on('close', () => {
      closed = true;
    });

    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId: 'phong-khong-ton-tai-hoac-khong-phai-thanh-vien' }));
    const errMsg = await bufA.waitFor((d) => d.msg === 'error');
    expect(errMsg).toEqual({ msg: 'error', code: 'NOT_MEMBER', roomId: 'phong-khong-ton-tai-hoac-khong-phai-thanh-vien' });
    expect(closed).toBe(false);

    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId: room.id }));
    const okMsg = await bufA.waitFor((d) => d.msg === 'subscribed');
    expect(okMsg).toEqual({ msg: 'subscribed', roomId: room.id });
    expect(closed).toBe(false);

    wsA.terminate();
    wsB.terminate();
  });

  it('agent C KHÔNG phải thành viên phòng THẬT (đã tạo, có 2 thành viên khác) cố subscribe → error NOT_MEMBER, KHÔNG đóng kết nối', async () => {
    const { ws: wsATmp, agent: a } = await connectAuthed('rc-chat-realtime-c44-a', 'tok-c44-a');
    wsATmp.terminate();
    const { ws: wsBTmp, agent: b } = await connectAuthed('rc-chat-realtime-c44-b', 'tok-c44-b');
    wsBTmp.terminate();
    await makeFriends(a.id, b.id);
    const room = await findOrCreateDirectRoom(getBotDb(), a.id, b.id);

    const { ws: wsC, buf: bufC } = await connectAuthed('rc-chat-realtime-c44-c', 'tok-c44-c');
    let closed = false;
    wsC.on('close', () => {
      closed = true;
    });
    wsC.send(JSON.stringify({ type: 'subscribe-room', roomId: room.id }));
    const errMsg = await bufC.waitFor((d) => d.msg === 'error');
    expect(errMsg).toEqual({ msg: 'error', code: 'NOT_MEMBER', roomId: room.id });
    expect(closed).toBe(false);
    wsC.terminate();
  });

  it('message JSON hỏng/không khớp giao thức → bỏ qua im lặng, KHÔNG đóng kết nối', async () => {
    const { ws } = await connectAuthed('rc-chat-realtime-garbage', 'tok-garbage');
    let closed = false;
    ws.on('close', () => {
      closed = true;
    });
    ws.send('{khong-phai-json-hop-le');
    ws.send(JSON.stringify({ type: 'khong-ton-tai-loai-nay' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(closed).toBe(false);
    ws.terminate();
  });
});

// B115-tiếp-đính-chính (2/8, review độc lập tìm ra) — TRƯỚC ĐÂY mỗi kết nối tự set 1 `setInterval` RIÊNG với
// `isAlive` khởi tạo `true`, cần 2 chu kỳ mới chắc chắn 1 kết nối "chết thô" (mất mạng/khóa máy đột ngột,
// không gửi 'close' TCP) — ĐÚNG đặc tính chuẩn của heartbeat ping/pong, nhưng đã đổi sang sweep TOÀN CỤC 1
// interval duy nhất (CÙNG mẫu ĐÃ KIỂM CHỨNG call-signaling-server.ts) để nhất quán hành vi + dễ audit hơn.
// Test này xác nhận: (a) kết nối "chết thô" (không bao giờ trả pong) BỊ dọn đúng sau 2 chu kỳ heartbeat —
// registry `agentHasOpenConnection()` không còn báo "còn sống" sai cho 1 kết nối đã chết thật; (b) kết nối
// BÌNH THƯỜNG (trả pong đều) KHÔNG bị dọn nhầm (false-positive).
// C2 (LANE A Vòng 2, 3/8) — RÒ COUNTER khi handshake fail giữa chừng. Mô phỏng bằng cách spy wss.handleUpgrade
// để KHÔNG BAO GIỜ gọi callback (giả lập handshake không hoàn tất) — flow đã incrementConnectionCount TRƯỚC đó.
// Sau khi client đóng kết nối thô, counter PHẢI về 0 (nếu decrement chỉ gắn trong callback như code cũ → kẹt ở
// 1, rò slot). Đây là red-test tái hiện đúng C2.
describe('chat-realtime-proxy — C2: counter KHÔNG rò khi handshake fail giữa chừng', () => {
  let server: http.Server;
  let port: number;
  let wss: ReturnType<typeof attachChatRealtimeProxy>;

  beforeEach(async () => {
    resetChatRealtimeHubForTest();
    resetChatRealtimeConnectionCountForTest();
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    wss = attachChatRealtimeProxy(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('handshake fail giữa chừng (wss.handleUpgrade THROW sau khi đã increment) → counter về 0, KHÔNG rò slot', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const rcUserId = 'rc-chat-realtime-c2-leak';
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId } });
    const session = await createWebSession(db, { rcUserId, rcAuthToken: 'tok-c2' });

    // Spy: handshake NÉM LỖI giữa chừng (mô phỏng socket chết/ws lỗi ngay lúc upgrade) — flow app ĐÃ
    // incrementConnectionCount TRƯỚC bước này. Lỗi được server.on('upgrade').catch() bắt → socket.destroy().
    // Nếu decrement CHỈ nằm trong callback (code cũ, C2) → callback không bao giờ chạy → counter kẹt ở 1 (rò
    // slot). Với fix (release gắn cả trên socket thô) → 'close' từ destroy() release counter về 0.
    const spy = vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {
      throw new Error('handshake fail giữa chừng (giả lập)');
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` } });
    ws.on('error', () => {
      /* client sẽ nhận lỗi vì server destroy socket — nuốt để không thành unhandled */
    });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // Sau khi handshake fail + socket.destroy() → 'close' → release() → counter PHẢI về 0 (không rò slot).
    await vi.waitFor(() => expect(getChatRealtimeConnectionCountForTest(session.id)).toBe(0));
    ws.terminate();
  });
});

describe('chat-realtime-proxy — heartbeat sweep dọn kết nối chết, không dọn nhầm kết nối sống', () => {
  const HEARTBEAT_TEST_INTERVAL_MS = 1000;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    resetChatRealtimeHubForTest();
    resetChatRealtimeConnectionCountForTest();
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('kết nối mất mạng đột ngột (không bao giờ trả pong) → sweep heartbeat terminate() trong tối đa 2 chu kỳ', async () => {
    // vi.useFakeTimers() PHẢI bật TRƯỚC attachChatRealtimeProxy() — setInterval bên trong chạy NGAY lúc gọi,
    // bật fake timer sau sẽ không "chụp lại" được interval thật đã tạo trước đó (CÙNG lưu ý call-signaling-
    // server.test.ts đã ghi).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const wss = attachChatRealtimeProxy(server, { heartbeatIntervalMs: HEARTBEAT_TEST_INTERVAL_MS });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;

    const db = getBotDb();
    const agent = await makeAgent();
    const rcUserId = 'rc-chat-realtime-heartbeat-dead';
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId } });
    const session = await createWebSession(db, { rcUserId, rcAuthToken: 'tok-heartbeat-dead' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` } });
    const buf = attachMessageBuffer(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await buf.waitFor((d) => d.msg === 'ready');
    // setTimeout THẬT (KHÔNG bị fake) để chắc chắn handleUpgrade() async (tra DB) đã hoàn tất trước khi lấy
    // socket server-side từ wss.clients — CÙNG lý do call-signaling-server.test.ts.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wss.clients.size).toBe(1);
    const serverSideWs = [...wss.clients][0];
    // Mô phỏng mất mạng KHÔNG SẠCH: chặn ping THẬT gửi ra dây nên client không bao giờ có cơ hội tự trả pong
    // (thư viện `ws` tự pong khi NHẬN được frame ping thật qua mạng — chặn tại nguồn, không phải "nhận nhưng
    // lờ đi").
    serverSideWs.ping = vi.fn();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TEST_INTERVAL_MS); // chu kỳ 1: isAlive true→false, gọi ping() (stub).
    expect(wss.clients.size).toBe(1); // CHƯA bị dọn ở chu kỳ 1 — đúng đặc tính "cần 2 chu kỳ".
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TEST_INTERVAL_MS); // chu kỳ 2: vẫn isAlive===false → terminate().
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve)); // flush sự kiện 'close' thật (EventEmitter, không fake).

    expect(wss.clients.size).toBe(0);
  });

  it('kết nối BÌNH THƯỜNG (trả pong đều qua mạng thật) → KHÔNG bị sweep dọn nhầm', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const wss = attachChatRealtimeProxy(server, { heartbeatIntervalMs: HEARTBEAT_TEST_INTERVAL_MS });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;

    const db = getBotDb();
    const agent = await makeAgent();
    const rcUserId = 'rc-chat-realtime-heartbeat-alive';
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId } });
    const session = await createWebSession(db, { rcUserId, rcAuthToken: 'tok-heartbeat-alive' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` } });
    const buf = attachMessageBuffer(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await buf.waitFor((d) => d.msg === 'ready');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // KHÔNG stub ping() — để thư viện `ws` thật gửi/nhận ping-pong qua socket TCP thật (localhost), đúng hành
    // vi 1 client sống thật đang trả lời.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TEST_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve)); // flush pong 'message' event thật (không fake).
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TEST_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    vi.useRealTimers();

    expect(wss.clients.size).toBe(1); // vẫn sống sau 2 chu kỳ vì đã tự trả pong thật mỗi lần.
    ws.terminate();
  });
});
