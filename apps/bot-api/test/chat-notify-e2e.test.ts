// B115-tiếp (2/8, Admin Demo "phải thông báo push nổi màn hình bất kể trường hợp nào như zalo") — E2E THẬT
// (KHÔNG mock WS/DB, CHỈ mock push-notification-service.js CÙNG khuôn call-signaling-server.test.ts vì FCM cần
// Firebase thật): verify case #2 (app mở nhưng KHÔNG ở đúng phòng → banner qua WS agent-level, KHÔNG cần
// subscribe-room) + case #3/#4 (KHÔNG có kết nối WS nào → push FCM) cho CẢ phòng DIRECT lẫn GROUP, người gửi
// KHÔNG tự nhận thông báo tin của chính mình, người ngoài phòng KHÔNG nhận gì.
//
// CÙNG hạ tầng test chat-realtime-e2e.test.ts (1 http.Server vừa phục vụ Express (supertest) vừa gắn
// attachChatRealtimeProxy() WS thật) — B chỉ CONNECT WS, CỐ Ý KHÔNG gửi 'subscribe-room' để mô phỏng đúng "app
// đang mở nhưng đang ở màn khác (danh sách chat/Cài đặt...), KHÔNG đúng phòng vừa có tin mới".
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// CÙNG khuôn call-signaling-server.test.ts — mock CHỈ sendPushToAgent (giữ nguyên mọi export thuần khác của
// module), test FCM thật đã có riêng ở push-notification-service.test.ts, KHÔNG lặp lại ở đây.
vi.mock('../src/push-notification-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/push-notification-service.js')>('../src/push-notification-service.js');
  return { ...actual, sendPushToAgent: vi.fn().mockResolvedValue(undefined) };
});
import { sendPushToAgent } from '../src/push-notification-service.js';

let uniqCounter = 0;
async function authedAgent(name?: string) {
  uniqCounter += 1;
  const rcUserId = `rc-chat-notify-${Date.now()}-${uniqCounter}`;
  const db = getBotDb();
  const agent = await makeAgent(undefined, { name });
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId, rcUsername: `chatnotify${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `dummy-tok-${uniqCounter}`, agentId: agent.id });
  return { agent, sessionId: ws.id };
}

function connectRealtime(port: number, sessionId: string): Promise<{ ws: WebSocket; buf: WsMessageBuffer }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${sessionId}` } });
    const buf = attachMessageBuffer(ws);
    ws.on('open', () => resolve({ ws, buf }));
    ws.on('error', reject);
  });
}

describe('B115-tiếp — chat-notify (banner cấp-agent + push FCM khi gửi tin nhắn mới)', () => {
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

  beforeEach(() => {
    vi.mocked(sendPushToAgent).mockClear();
    vi.mocked(sendPushToAgent).mockResolvedValue(undefined);
  });

  it('phòng DIRECT — B mở app nhưng KHÔNG subscribe phòng đó → nhận chat-notify qua WS mà KHÔNG cần subscribe-room; A (sender) KHÔNG tự nhận; push VẪN gọi cho B (cụm #21 — mỗi thiết bị tự quyết, foreground suppress ở native)', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent('Nguyễn Văn A');
    const { agent: agentB, sessionId: sessionB } = await authedAgent('Trần Thị B');
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
    // CỐ Ý KHÔNG subscribe-room cho cả 2 — mô phỏng "app đang mở, đang ở màn khác" (case B115 #2).

    const bGetsNotify = bufB.waitFor((d) => d.msg === 'chat-notify' && d.roomId === roomId);
    const aNeverGetsNotify = bufA.expectNone((d) => d.msg === 'chat-notify' && d.roomId === roomId, 1000);

    const postRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'TEXT', body: 'Chào B, B đang ở màn khác' });
    expect(postRes.status).toBe(201);

    const notify = await bGetsNotify;
    expect(notify.roomId).toBe(roomId);
    expect(notify.senderAgentId).toBe(agentA.id);
    expect(notify.senderName).toBe('Nguyễn Văn A');
    expect(notify.roomType).toBe('DIRECT');
    expect(notify.preview).toBe('Chào B, B đang ở màn khác');
    await aNeverGetsNotify;

    // Cụm #21 (6/8) — LUÔN push cho người NHẬN (B), KỂ CẢ khi B có WS mở: gate cũ `!agentHasOpenConnection`
    // suppress toàn cục theo agent → PC mở WS làm ĐT (nền, không WS) mất push. Giờ mỗi thiết bị tự quyết hiển thị
    // (foreground suppress ở native). A (sender) KHÔNG bao giờ được push tin của chính mình.
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendPushToAgent).mock.calls[0];
    expect(call[1]).toBe(agentB.id);
    expect(call[2].priority).toBe('high'); // vượt Doze/khóa màn.
    expect(call[2].dataOnly).toBe(true);

    wsA.terminate();
    wsB.terminate();
  });

  it('phòng DIRECT — B KHÔNG có kết nối WS nào (app đóng/nền) → gọi sendPushToAgent đúng agentId + title=tên A + body=preview + data.roomId', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent('Người Gửi Offline Test');
    const { agent: agentB, sessionId: sessionB } = await authedAgent('Người Nhận Offline Test');
    await makeFriends(agentA.id, agentB.id);
    void sessionB; // B KHÔNG connect WS — mô phỏng app đã tắt/chạy nền không còn kết nối.

    const roomRes = await request(server)
      .post('/v1/chat/rooms/direct')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ targetAgentId: agentB.id });
    const roomId = roomRes.body.data.id as string;

    const postRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'TEXT', body: 'Tin nhắn khi B đang tắt app' });
    expect(postRes.status).toBe(201);

    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendPushToAgent).mock.calls[0];
    expect(call[1]).toBe(agentB.id);
    const payload = call[2];
    expect(payload.title).toBe('Người Gửi Offline Test');
    expect(payload.body).toBe('Tin nhắn khi B đang tắt app');
    // B115-tiếp (2/8) — dataOnly:true BẮT BUỘC cho push tin nhắn chat (native code tự xây notification kèm
    // action "Trả lời" RemoteInput, xem SigMaMessagingService.java + docstring PushPayload.dataOnly).
    expect(payload.dataOnly).toBe(true);
    // Cụm #21 (6/8) — priority:'high' để vượt Doze/khóa màn (gốc bug B: delay/khóa-màn mất push).
    expect(payload.priority).toBe('high');
    // Item 12 + đồng-nhất-badge (6-7/8) — data kèm roomType + avatarAgentId (native largeIcon) + senderName +
    // messageId + unreadCount (native MessagingStyle xếp chồng & setNumber theo server). messageId động → any(String).
    expect(payload.data).toEqual({
      roomId,
      kind: 'chat_message',
      roomType: 'DIRECT',
      avatarAgentId: String(agentA.id),
      senderName: 'Người Gửi Offline Test',
      messageId: expect.any(String),
      unreadCount: '1'
    });
  });

  it('tin nhắn IMAGE (bill đã ghép) → preview push = "[Bill]"; IMAGE thường → "[Hình ảnh]"', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent('A Bill Test');
    const { agent: agentB } = await authedAgent('B Bill Test');
    await makeFriends(agentA.id, agentB.id);

    const roomRes = await request(server)
      .post('/v1/chat/rooms/direct')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ targetAgentId: agentB.id });
    const roomId = roomRes.body.data.id as string;

    // Ảnh thường (KHÔNG metadataJson) — attachmentId bỏ qua (route KHÔNG bắt buộc cho kind IMAGE nếu test này
    // chỉ cần verify preview text, KHÔNG cần attachment thật — sendMessage() chỉ validate attachmentId NẾU có
    // truyền, xem chat-message-service.ts).
    await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'IMAGE' });
    expect(vi.mocked(sendPushToAgent).mock.calls.at(-1)?.[2].body).toBe('[Hình ảnh]');

    // Ảnh bill (metadataJson.isBillImage=true).
    await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'IMAGE', metadataJson: JSON.stringify({ isBillImage: true, billAmount: 100000 }) });
    expect(vi.mocked(sendPushToAgent).mock.calls.at(-1)?.[2].body).toBe('[Bill]');
  });

  it('phòng GROUP — A gửi tin, B/C KHÔNG subscribe phòng nào vẫn nhận chat-notify (title=tên nhóm, body="Người gửi: nội dung" nếu offline); người ngoài phòng D KHÔNG nhận gì', async () => {
    const { agent: agentA, sessionId: sessionA } = await authedAgent('A Nhóm');
    const { agent: agentB, sessionId: sessionB } = await authedAgent('B Nhóm');
    const { agent: agentC } = await authedAgent('C Nhóm'); // C offline — verify nhánh push cho GROUP.
    const { sessionId: sessionD } = await authedAgent('D Ngoài Nhóm');
    await makeFriends(agentA.id, agentB.id);
    await makeFriends(agentA.id, agentC.id);

    const groupRes = await request(server)
      .post('/v1/chat/rooms/group')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ name: 'Nhóm B115', memberAgentIds: [agentB.id, agentC.id] });
    expect(groupRes.body.ok).toBe(true);
    const roomId = groupRes.body.data.id as string;

    const { ws: wsB, buf: bufB } = await connectRealtime(port, sessionB);
    const { ws: wsD, buf: bufD } = await connectRealtime(port, sessionD);
    await bufB.waitFor((d) => d.msg === 'ready');
    await bufD.waitFor((d) => d.msg === 'ready');
    // C KHÔNG connect — mô phỏng offline, phải nhận push thay vì WS.

    const bGetsNotify = bufB.waitFor((d) => d.msg === 'chat-notify' && d.roomId === roomId);
    const dNeverGetsNotify = bufD.expectNone((d) => d.msg === 'chat-notify' && d.roomId === roomId, 1000);

    // Tạo nhóm cũng đẩy push "A đã thêm bạn vào nhóm" cho B+C (feature thông báo thêm-vào-nhóm) — reset mock ở đây
    // để phần assert bên dưới CHỈ đếm push của CHÍNH tin nhắn "Chào cả nhóm" (đúng ý định test gốc).
    vi.mocked(sendPushToAgent).mockClear();

    const postRes = await request(server)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionA}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ kind: 'TEXT', body: 'Chào cả nhóm' });
    expect(postRes.status).toBe(201);

    const notify = await bGetsNotify;
    expect(notify.roomType).toBe('GROUP');
    expect(notify.roomName).toBe('Nhóm B115');
    expect(notify.senderName).toBe('A Nhóm');
    expect(notify.preview).toBe('Chào cả nhóm');
    await dNeverGetsNotify; // D không phải thành viên → không nhận gì dù có kết nối mở.

    // Cụm #21 (6/8) — LUÔN push cho MỌI người nhận: B (có WS) LẪN C (offline) đều được push (2 lần), D (ngoài
    // nhóm) + A (sender) KHÔNG. Trước đây chỉ push C (gate cũ) → ĐT của B mất push khi PC của B đang mở.
    expect(sendPushToAgent).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(sendPushToAgent).mock.calls;
    const pushedAgentIds = calls.map((c) => c[1]).sort((a, b) => a - b);
    expect(pushedAgentIds).toEqual([agentB.id, agentC.id].sort((a, b) => a - b));
    for (const c of calls) {
      expect(c[2].title).toBe('Nhóm B115');
      expect(c[2].body).toBe('A Nhóm: Chào cả nhóm');
      expect(c[2].dataOnly).toBe(true);
      expect(c[2].priority).toBe('high');
    }

    wsB.terminate();
    wsD.terminate();
  });
});
