// SIGMA AUDIT-4 (3-4/8) — REGRESSION cho lỗ hổng "chặn/hủy kết bạn KHÔNG có hiệu lực trong phòng DIRECT ĐÃ
// TỒN TẠI". Tái hiện thật (2 phiên WebSession) qua route REST thật + kiểm CẢ realtime (WS: người bị chặn gửi
// KHÔNG được → đối phương KHÔNG nhận broadcast). Trước fix: block→send / unfriend→send trả 201 (rò quyền, đã
// chụp bằng chứng PROBE status=201). Sau fix (sendMessage() gate canMessageAgent cho phòng DIRECT): 403.
//
// PHÂN RÕ (đúng hợp đồng docstring findOrCreateDirectRoom):
//   - DIRECT + đã chặn/hủy kết bạn → KHÔNG gửi được tin MỚI (403 CANNOT_MESSAGE) NHƯNG VẪN xem lại lịch sử.
//   - GROUP → KHÔNG áp (block theo cặp, 1 cặp bị chặn vẫn chung nhóm — giống createGroupRoom chỉ gate lúc mời).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { WebSocket } from 'ws';

import { createApp } from '../src/app.js';
import { attachChatRealtimeProxy } from '../src/chat-realtime-proxy.js';
import { resetChatRealtimeHubForTest } from '../src/chat-realtime-hub.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { attachMessageBuffer, type WsMessageBuffer } from './_ws-test-helpers.js';

let server: http.Server;
let port: number;
let n = 0;
async function sessionFor(agentId: number): Promise<{ Cookie: string; [k: string]: string }> {
  n += 1;
  const db = getBotDb();
  const rcUserId = `rc-blockenf-${Date.now()}-${n}`;
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: `blockenf${n}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `t${n}`, agentId });
  return { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}
function connectRealtime(cookie: string): Promise<{ ws: WebSocket; buf: WsMessageBuffer }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: cookie } });
    const buf = attachMessageBuffer(ws);
    ws.on('open', () => resolve({ ws, buf }));
    ws.on('error', reject);
  });
}

beforeAll(async () => {
  resetChatRealtimeHubForTest();
  server = http.createServer(createApp());
  attachChatRealtimeProxy(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function directRoomBetween(headersOwner: { Cookie: string }, targetId: number): Promise<string> {
  const res = await request(server).post('/v1/chat/rooms/direct').set(headersOwner as Record<string, string>).send({ targetAgentId: targetId });
  expect(res.status).toBe(200);
  return res.body.data.id as string;
}

describe('DIRECT room — enforcement chặn/hủy kết bạn ở sendMessage() (lỗ hổng AUDIT-4)', () => {
  it('A chặn B (phòng DIRECT đã tồn tại) → B KHÔNG gửi được tin mới (403 CANNOT_MESSAGE); A vẫn gửi được; cả 2 VẪN xem lịch sử', async () => {
    const a = await makeAgent(undefined, { name: 'Block A' });
    const b = await makeAgent(undefined, { name: 'Block B' });
    const hA = await sessionFor(a.id);
    const hB = await sessionFor(b.id);
    await makeFriends(a.id, b.id);
    const roomId = await directRoomBetween(hA, b.id);
    // Có lịch sử trước khi chặn.
    expect((await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(hB).send({ kind: 'TEXT', body: 'trước khi bị chặn' })).status).toBe(201);

    expect((await request(server).post(`/v1/me/friends/${b.id}/block`).set(hA)).status).toBe(200);

    // B (bị chặn) KHÔNG gửi được tin mới.
    const blocked = await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(hB).send({ kind: 'TEXT', body: 'lén nhắn sau khi bị chặn' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('CANNOT_MESSAGE');
    // A (người chặn) CŨNG không gửi được (block = cấm 2 chiều, đúng canMessageAgent).
    expect((await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(hA).send({ kind: 'TEXT', body: 'A nhắn' })).status).toBe(403);
    // Nhưng CẢ 2 VẪN xem lại lịch sử (listMessages dùng assertActiveMember, KHÔNG canMessageAgent).
    expect((await request(server).get(`/v1/chat/rooms/${roomId}/messages`).set(hB)).status).toBe(200);
    expect((await request(server).get(`/v1/chat/rooms/${roomId}/messages`).set(hA)).status).toBe(200);

    // Bỏ chặn → gửi lại được (đối xứng, không kẹt vĩnh viễn).
    expect((await request(server).post(`/v1/me/friends/${b.id}/unblock`).set(hA)).status).toBe(200);
    expect((await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(hB).send({ kind: 'TEXT', body: 'sau khi bỏ chặn' })).status).toBe(201);
  });

  it('A hủy kết bạn B (phòng DIRECT đã tồn tại) → B KHÔNG gửi được tin mới (403)', async () => {
    const a = await makeAgent(undefined, { name: 'Unfriend A' });
    const b = await makeAgent(undefined, { name: 'Unfriend B' });
    const hA = await sessionFor(a.id);
    const hB = await sessionFor(b.id);
    await makeFriends(a.id, b.id);
    const roomId = await directRoomBetween(hA, b.id);
    expect((await request(server).post(`/v1/me/friends/${b.id}/unfriend`).set(hA)).status).toBe(200);
    const send = await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(hB).send({ kind: 'TEXT', body: 'nhắn sau khi hết bạn' });
    expect(send.status).toBe(403);
    expect(send.body.error).toBe('CANNOT_MESSAGE');
  });

  it('REALTIME: sau khi A chặn B, B gửi bị 403 → A KHÔNG nhận broadcast new-message nào (không rò tin qua WS)', async () => {
    const a = await makeAgent(undefined, { name: 'RT Block A' });
    const b = await makeAgent(undefined, { name: 'RT Block B' });
    const hA = await sessionFor(a.id);
    const hB = await sessionFor(b.id);
    await makeFriends(a.id, b.id);
    const roomId = await directRoomBetween(hA, b.id);
    expect((await request(server).post(`/v1/me/friends/${b.id}/block`).set(hA)).status).toBe(200);

    const { ws: wsA, buf: bufA } = await connectRealtime(hA.Cookie);
    await bufA.waitFor((d) => d.msg === 'ready');
    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    await bufA.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);
    try {
      const aReceivesNone = bufA.expectNone((d) => d.msg === 'new-message' && d.roomId === roomId);
      const send = await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(hB).send({ kind: 'TEXT', body: 'tin lén qua WS' });
      expect(send.status).toBe(403); // chặn Ở NGUỒN → không có broadcast.
      await aReceivesNone;
    } finally {
      wsA.terminate();
    }
  });

  it('GROUP KHÔNG áp: 2 thành viên chặn nhau trong nhóm VẪN gửi được (block theo cặp, không đá nhóm)', async () => {
    const owner = await makeAgent(undefined, { name: 'G Owner' });
    const b = await makeAgent(undefined, { name: 'G B' });
    const c = await makeAgent(undefined, { name: 'G C' });
    const hOwner = await sessionFor(owner.id);
    const hB = await sessionFor(b.id);
    await makeFriends(owner.id, b.id);
    await makeFriends(owner.id, c.id);
    const roomRes = await request(server).post('/v1/chat/rooms/group').set(hOwner).send({ name: 'Nhóm block-test', memberAgentIds: [b.id, c.id] });
    expect(roomRes.status).toBe(201);
    const roomId = roomRes.body.data.id as string;
    // Owner chặn B (họ là bạn) — nhưng trong NHÓM, B vẫn gửi được (không áp gate DIRECT).
    expect((await request(server).post(`/v1/me/friends/${b.id}/block`).set(hOwner)).status).toBe(200);
    const send = await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(hB).send({ kind: 'TEXT', body: 'B gửi trong nhóm dù bị owner chặn' });
    expect(send.status).toBe(201);
  });
});
