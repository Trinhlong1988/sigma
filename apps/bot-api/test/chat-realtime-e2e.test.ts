// SIGMA Phase 3 "real-time" (29/7) — E2E THẬT (BẮT BUỘC theo brief): 2+ client WebSocket THẬT (KHÔNG
// mock) subscribe cùng 1 phòng qua `/v1/chat-realtime`, agent A gửi tin nhắn qua ĐÚNG route REST thật
// (supertest, không gọi thẳng service) → xác nhận CẢ 2 client (A lẫn B) nhận `new-message` THẬT qua WebSocket
// (không phải chỉ response REST) → phủ đúng "cutover thật" đã yêu cầu, không phải 1 endpoint song song bỏ đó.
//
// Dựng 1 http.Server DUY NHẤT vừa phục vụ Express app (REST, qua supertest) vừa gắn attachChatRealtimeProxy()
// (WS) — CÙNG cách index.ts thật làm (2 tính năng share chung 1 http.Server qua sự kiện 'upgrade'), KHÁC
// createApp() trần (chat-routes.test.ts) vì file đó KHÔNG cần WS thật. supertest tự nhận ra server ĐÃ listen
// (gọi `.listen(0)` thủ công TRƯỚC ở beforeAll) và dùng lại đúng address đó, không tự mở listener khác.
//
// Dùng `attachMessageBuffer()` (_ws-test-helpers.ts, đăng ký 'message' NGAY lúc tạo ws) — xem comment đầu file
// đó cho BUG THẬT tự bắt được (race mất message nếu đăng ký listener SAU khi đợi 'open'/gửi request REST).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { attachChatRealtimeProxy } from '../src/chat-realtime-proxy.js';
import { resetChatRealtimeHubForTest, markAgentSeen, agentPresenceOnline } from '../src/chat-realtime-hub.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { attachMessageBuffer, type WsMessageBuffer } from './_ws-test-helpers.js';

let uniqCounter = 0;
async function authedAgent() {
  uniqCounter += 1;
  const rcUserId = `rc-chat-e2e-${Date.now()}-${uniqCounter}`;
  const db = getBotDb();
  const agent = await makeAgent();
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId, rcUsername: `chate2e${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `dummy-tok-${uniqCounter}`, agentId: agent.id });
  return { agent, sessionId: ws.id };
}

function connectRealtime(port: number, sessionId: string): Promise<{ ws: WebSocket; buf: WsMessageBuffer }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${sessionId}` } });
    const buf = attachMessageBuffer(ws); // ĐĂNG KÝ TRƯỚC 'open' — xem comment đầu file.
    ws.on('open', () => resolve({ ws, buf }));
    ws.on('error', reject);
  });
}

describe('chat-realtime E2E — 2 client WebSocket thật + gửi tin qua route REST thật', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    resetChatRealtimeHubForTest();
    const app = createApp();
    server = http.createServer(app);
    attachChatRealtimeProxy(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('A gửi tin qua POST /v1/chat/rooms/:roomId/messages → CẢ A lẫn B (đã subscribe) nhận new-message THẬT qua WebSocket', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent();
    const { agent: agentB, sessionId: sessionB } = await authedAgent();
    await makeFriends(agentA.id, agentB.id);

    const roomRes = await request(server)
      .post('/v1/chat/rooms/direct')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ targetAgentId: agentB.id });
    expect(roomRes.body.ok).toBe(true);
    const roomId = roomRes.body.data.id as string;

    const { ws: wsA, buf: bufA } = await connectRealtime(port, sessionA);
    const { ws: wsB, buf: bufB } = await connectRealtime(port, sessionB);
    await bufA.waitFor((d) => d.msg === 'ready');
    await bufB.waitFor((d) => d.msg === 'ready');

    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    wsB.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    await bufA.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);
    await bufB.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);

    const sendPromiseA = bufA.waitFor((d) => d.msg === 'new-message' && d.roomId === roomId);
    const sendPromiseB = bufB.waitFor((d) => d.msg === 'new-message' && d.roomId === roomId);

    const postRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'TEXT', body: 'Chào B, đây là tin nhắn real-time thật' });
    expect(postRes.status).toBe(201);
    expect(postRes.body.ok).toBe(true);

    const [msgAtA, msgAtB] = await Promise.all([sendPromiseA, sendPromiseB]);
    const messageA = msgAtA.message as { body: string; roomId: string };
    const messageB = msgAtB.message as { body: string; roomId: string };
    expect(messageA.body).toBe('Chào B, đây là tin nhắn real-time thật');
    expect(messageB.body).toBe('Chào B, đây là tin nhắn real-time thật');
    // Sender (A) CŨNG nhận lại broadcast của chính mình (đồng bộ nhiều tab/thiết bị) — CỐ Ý KHÔNG loại trừ
    // sender khỏi new-message (khác typing-indicator, xem chat-realtime-hub.test.ts excludeAgentId).
    expect(messageA.roomId).toBe(roomId);
    expect(messageB.roomId).toBe(roomId);

    wsA.terminate();
    wsB.terminate();
  });

  it('unsubscribe kịp thời → KHÔNG còn nhận broadcast phòng đó nữa (client khác vẫn nhận bình thường)', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent();
    const { agent: agentB, sessionId: sessionB } = await authedAgent();
    await makeFriends(agentA.id, agentB.id);

    const roomRes = await request(server)
      .post('/v1/chat/rooms/direct')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ targetAgentId: agentB.id });
    const roomId = roomRes.body.data.id as string;

    const { ws: wsA, buf: bufA } = await connectRealtime(port, sessionA);
    const { ws: wsB, buf: bufB } = await connectRealtime(port, sessionB);
    await bufA.waitFor((d) => d.msg === 'ready');
    await bufB.waitFor((d) => d.msg === 'ready');
    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    wsB.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    await bufA.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);
    await bufB.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);

    // B chủ động unsubscribe TRƯỚC khi A gửi tin.
    wsB.send(JSON.stringify({ type: 'unsubscribe-room', roomId }));
    await new Promise((resolve) => setTimeout(resolve, 200)); // đợi server xử lý xong unsubscribe.

    const bNoMessage = bufB.expectNone((d) => d.msg === 'new-message' && d.roomId === roomId);
    const aGetsMessage = bufA.waitFor((d) => d.msg === 'new-message' && d.roomId === roomId);

    const postRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'TEXT', body: 'Tin sau khi B đã unsubscribe' });
    expect(postRes.status).toBe(201);

    await Promise.all([bNoMessage, aGetsMessage]);

    wsA.terminate();
    wsB.terminate();
  });

  it('agent C KHÔNG phải thành viên phòng → dù cố subscribe cũng KHÔNG BAO GIỜ nhận broadcast tin nhắn thật của phòng đó (lớp lỗi B44 cũ)', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent();
    const { agent: agentB, sessionId: sessionB } = await authedAgent();
    const { sessionId: sessionC } = await authedAgent();
    await makeFriends(agentA.id, agentB.id);

    const roomRes = await request(server)
      .post('/v1/chat/rooms/direct')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ targetAgentId: agentB.id });
    const roomId = roomRes.body.data.id as string;
    void sessionB;

    const { ws: wsC, buf: bufC } = await connectRealtime(port, sessionC);
    await bufC.waitFor((d) => d.msg === 'ready');
    wsC.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    const errMsg = await bufC.waitFor((d) => d.msg === 'error' && d.roomId === roomId);
    expect(errMsg.code).toBe('NOT_MEMBER');

    const cNeverGetsMessage = bufC.expectNone((d) => d.msg === 'new-message' && d.roomId === roomId, 1000);

    const postRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'TEXT', body: 'Tin nhắn C không được thấy' });
    expect(postRes.status).toBe(201);

    await cNeverGetsMessage;
    wsC.terminate();
  });

  // TICK "đã nhận" (6/8, Admin Demo) — delivered = người nhận có WS mở (agentHasOpenConnection).
  it('B đang online lúc A gửi → A nhận delivery-receipt(agentId=B) NGAY (send-time delivered)', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent();
    const { agent: agentB, sessionId: sessionB } = await authedAgent();
    await makeFriends(agentA.id, agentB.id);
    const roomRes = await request(server)
      .post('/v1/chat/rooms/direct')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ targetAgentId: agentB.id });
    const roomId = roomRes.body.data.id as string;

    const { ws: wsA, buf: bufA } = await connectRealtime(port, sessionA);
    const { ws: wsB, buf: bufB } = await connectRealtime(port, sessionB);
    await bufA.waitFor((d) => d.msg === 'ready');
    await bufB.waitFor((d) => d.msg === 'ready');
    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    wsB.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    await bufA.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);
    await bufB.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);

    const deliveryPromise = bufA.waitFor((d) => d.msg === 'delivery-receipt' && d.roomId === roomId && d.agentId === agentB.id);
    const postRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'TEXT', body: 'Tin khi B online' });
    expect(postRes.status).toBe(201);

    const delivery = await deliveryPromise;
    expect(typeof delivery.deliveredAt).toBe('string');
    // Việc #25 (6/8) — KHÓA HỢP ĐỒNG deliveredAt = createdAt của ĐÚNG tin vừa gửi (client so sánh
    // `sentMs <= peerDeliveredAtMs` trong computeMineDisplayStatus — nếu deliveredAt < createdAt tin sẽ KẸT ✓).
    // Đây là ca người-nhận-ĐANG-online + tin MỚI (KHÁC delivered-on-connect): bắn NGAY, không chờ B reconnect.
    expect(new Date(delivery.deliveredAt as string).getTime()).toBe(new Date(postRes.body.data.createdAt as string).getTime());
    expect(delivery.agentId).toBe(agentB.id); // đúng agentId người NHẬN (không phải sender).
    wsA.terminate();
    wsB.terminate();
  });

  // Việc #25 (6/8, Admin Demo "đã nhận rồi vẫn treo ✓ vì app đang online") — REGRESSION cho GỐC BUG: gate delivery
  // trước đây là `agentHasOpenConnection` (chỉ WS) trong khi chấm online + seed-lúc-mở dùng `agentPresenceOnline`
  // (WS HOẶC nhịp sống gần đây) → LỆCH nhau. Mô phỏng B presence-online NHƯNG KHÔNG có WS trực tiếp (grace 10s
  // sau khi WS rớt / được FCM-ping giữ) bằng markAgentSeen(B) mà KHÔNG connect WS cho B. Tin MỚI của A PHẢI vẫn
  // bắn delivery-receipt (đồng bộ: chấm xanh ⇒ ✓✓). TRƯỚC FIX ca này KẸT ✓ (agentHasOpenConnection=false).
  it('việc #25 — B PRESENCE-online nhưng KHÔNG có WS trực tiếp + A gửi tin mới → A VẪN nhận delivery-receipt(agentId=B) (đồng bộ với chấm online)', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent();
    const { agent: agentB } = await authedAgent();
    await makeFriends(agentA.id, agentB.id);
    const roomRes = await request(server)
      .post('/v1/chat/rooms/direct')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ targetAgentId: agentB.id });
    const roomId = roomRes.body.data.id as string;

    // A online + subscribe. B KHÔNG connect WS — nhưng đánh dấu presence-online (agentPresenceOnline=true dù
    // agentHasOpenConnection=false): mô phỏng cửa sổ grace / FCM-ping keepalive.
    const { ws: wsA, buf: bufA } = await connectRealtime(port, sessionA);
    await bufA.waitFor((d) => d.msg === 'ready');
    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    await bufA.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);
    markAgentSeen(agentB.id); // presence-online, KHÔNG WS.

    const deliveryPromise = bufA.waitFor((d) => d.msg === 'delivery-receipt' && d.roomId === roomId && d.agentId === agentB.id);
    const postRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'TEXT', body: 'Tin khi B presence-online (không WS)' });
    expect(postRes.status).toBe(201);

    const delivery = await deliveryPromise;
    expect(new Date(delivery.deliveredAt as string).getTime()).toBe(new Date(postRes.body.data.createdAt as string).getTime());
    wsA.terminate();
  });

  it('B offline lúc A gửi → KHÔNG delivery-receipt; B connect sau → A nhận delivery-receipt(agentId=B) (delivered-on-connect)', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent();
    const { agent: agentB, sessionId: sessionB } = await authedAgent();
    await makeFriends(agentA.id, agentB.id);
    const roomRes = await request(server)
      .post('/v1/chat/rooms/direct')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ targetAgentId: agentB.id });
    const roomId = roomRes.body.data.id as string;

    // CHỈ A online + subscribe (B chưa connect → offline).
    const { ws: wsA, buf: bufA } = await connectRealtime(port, sessionA);
    await bufA.waitFor((d) => d.msg === 'ready');
    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    await bufA.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);

    // A gửi khi B offline → KHÔNG có delivery-receipt cho B trong cửa sổ chờ.
    const noDeliveryWhileOffline = bufA.expectNone((d) => d.msg === 'delivery-receipt' && d.agentId === agentB.id, 800);
    const postRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'TEXT', body: 'Tin khi B offline' });
    expect(postRes.status).toBe(201);
    await noDeliveryWhileOffline;

    // B VỪA online (connect) → server phát delivery-on-connect tới các phòng B tham gia → A (đang subscribe) nhận.
    const deliveryOnConnect = bufA.waitFor((d) => d.msg === 'delivery-receipt' && d.roomId === roomId && d.agentId === agentB.id);
    const { ws: wsB, buf: bufB } = await connectRealtime(port, sessionB);
    await bufB.waitFor((d) => d.msg === 'ready');
    const delivery = await deliveryOnConnect;
    expect(typeof delivery.deliveredAt).toBe('string');

    wsA.terminate();
    wsB.terminate();
  });

  // "CÓ ĐÃ NHẬN THÌ PHẢI XANH" (Admin Demo 15/8) — thiết bị B ở NỀN (KHÔNG WS) xác nhận nhận tin qua POST /delivered
  // ⇒ B phải thành ONLINE + người đang xem (A) nhận presence-update(B, online) chấm xanh ngay.
  it('B ở nền (không WS) POST /delivered → B thành ONLINE + A nhận presence-update(B, online)', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent();
    const { agent: agentB, sessionId: sessionB } = await authedAgent();
    await makeFriends(agentA.id, agentB.id);
    const roomRes = await request(server)
      .post('/v1/chat/rooms/direct')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ targetAgentId: agentB.id });
    const roomId = roomRes.body.data.id as string;

    // A online (đang xem B); B KHÔNG connect WS (ở nền) → offline.
    const { ws: wsA, buf: bufA } = await connectRealtime(port, sessionA);
    await bufA.waitFor((d) => d.msg === 'ready');
    expect(agentPresenceOnline(agentB.id)).toBe(false);

    // B (native FCM handler khi nhận tin lúc ở nền) POST /delivered.
    const presenceOnline = bufA.waitFor((d) => d.msg === 'presence-update' && d.agentId === agentB.id && d.online === true);
    const delRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/delivered`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionB}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({});
    expect(delRes.status).toBe(200);
    expect(agentPresenceOnline(agentB.id)).toBe(true); // đã nhận ⇒ XANH
    await presenceOnline; // A thấy B online realtime

    wsA.terminate();
  });
});
