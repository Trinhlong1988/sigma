// BUG NGHIÊM TRỌNG (5/8, Admin Demo báo nguyên văn): "tài khoản NGƯỜI DÙNG 'Nam' đã bị XÓA nhưng VẪN hiện 'đang
// hoạt động' + VẪN GỬI ĐƯỢC tin nhắn." GỐC: tính năng xóa tài khoản có 48h ân hạn (deletion-service.ts) — trong
// 48h `deletedAt=null`, chỉ `deletionRequestedAt` được set → auth (deletedAt:null) VẪN pass, sendMessage() chỉ
// kiểm assertActiveMember (hàng thành viên phòng) chứ KHÔNG kiểm trạng thái xóa của người gửi → gửi được + hiện
// active bình thường. Admin Demo chốt: 48h ân hạn CHỈ để UNDO purge dữ liệu, KHÔNG cho phép HOẠT ĐỘNG.
//
// Regression này khóa 3 tầng fix (tất cả đọc CHUNG isAccountDeactivated(): deletedAt!=null || deletionRequestedAt!=null):
//   (1) sendMessage() throw ACCOUNT_DEACTIVATED (route → 403) — chặn GỬI TIN.
//   (2) chat-realtime-proxy resolveAgentId từ chối WS (SESSION_EXPIRED_CLOSE_CODE) — chặn REALTIME.
//   (3) listFriends()/GET .../members trả cờ `deactivated` + tên "Tài khoản đã bị vô hiệu hóa" — chặn HIỂN THỊ.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent, makeFriends } from './fixtures.js';
import {
  sendMessage,
  listMessages
} from '../src/services/chat-message-service.js';
import { findOrCreateDirectRoom, createGroupRoom, ChatServiceError } from '../src/services/chat-room-service.js';
import { listFriends } from '../src/friend-service.js';
import { isAccountDeactivated, DEACTIVATED_DISPLAY_NAME } from '../src/deletion-service.js';
import { attachChatRealtimeProxy, resetChatRealtimeConnectionCountForTest } from '../src/chat-realtime-proxy.js';
import { resetChatRealtimeHubForTest } from '../src/chat-realtime-hub.js';
import { SESSION_EXPIRED_CLOSE_CODE } from '../src/ws-cookie-session.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-deactivated-test-${Date.now()}-${rcCounter}`;
}

async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string>; rcUserId: string; sessionId: string }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }, rcUserId, sessionId: ws.id };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ChatServiceError code=${code} nhưng KHÔNG throw.`);
  } catch (err) {
    expect(err).toBeInstanceOf(ChatServiceError);
    expect((err as ChatServiceError).code).toBe(code);
  }
}

describe('isAccountDeactivated — nguồn điều kiện duy nhất', () => {
  it('deletedAt HOẶC deletionRequestedAt khác null = vô hiệu hóa; cả 2 null = còn hoạt động', () => {
    expect(isAccountDeactivated({ deletedAt: null, deletionRequestedAt: null })).toBe(false);
    expect(isAccountDeactivated({ deletedAt: null, deletionRequestedAt: new Date() })).toBe(true); // 48h ân hạn
    expect(isAccountDeactivated({ deletedAt: new Date(), deletionRequestedAt: null })).toBe(true); // đã xóa thật
    expect(isAccountDeactivated({ deletedAt: new Date(), deletionRequestedAt: new Date() })).toBe(true);
  });
});

describe('sendMessage — CHẶN gửi tin khi tài khoản đã vô hiệu hóa (BUG "Nam đã xóa vẫn gửi được")', () => {
  it('người gửi có deletionRequestedAt (trong 48h ân hạn) → ACCOUNT_DEACTIVATED, KHÔNG tạo tin nhắn', async () => {
    const db = getBotDb();
    const nam = await makeAgent(undefined, { name: 'Nam' });
    const b = await makeAgent();
    await makeFriends(nam.id, b.id);
    const room = await findOrCreateDirectRoom(db, nam.id, b.id);

    // TRẠNG THÁI TRƯỚC (đối chứng): còn hoạt động → gửi được BÌNH THƯỜNG.
    const ok = await sendMessage(db, { roomId: room.id, senderId: nam.id, kind: 'TEXT', body: 'còn sống nè' });
    expect(ok.id).toBeTruthy();

    // Nam bấm "Xóa tài khoản" → set deletionRequestedAt (48h ân hạn, deletedAt VẪN null).
    await db.agent.update({ where: { id: nam.id }, data: { deletionRequestedAt: new Date() } });

    // SAU FIX: gửi bị chặn dù deletedAt vẫn null (đây chính là bug cũ để lọt).
    await expectCode(sendMessage(db, { roomId: room.id, senderId: nam.id, kind: 'TEXT', body: 'vẫn gửi được?' }), 'ACCOUNT_DEACTIVATED');
    const count = await db.chatMessage.count({ where: { roomId: room.id } });
    expect(count).toBe(1); // chỉ tin lúc còn sống, KHÔNG có tin sau khi vô hiệu hóa.
  });

  it('người gửi đã xóa thật (deletedAt set) → ACCOUNT_DEACTIVATED (member row DIRECT chưa bị dọn nên vẫn qua assertActiveMember)', async () => {
    const db = getBotDb();
    const nam = await makeAgent();
    const b = await makeAgent();
    await makeFriends(nam.id, b.id);
    const room = await findOrCreateDirectRoom(db, nam.id, b.id);
    await db.agent.update({ where: { id: nam.id }, data: { deletedAt: new Date(), deletedBy: nam.id } });
    await expectCode(sendMessage(db, { roomId: room.id, senderId: nam.id, kind: 'TEXT', body: 'ma gửi tin' }), 'ACCOUNT_DEACTIVATED');
  });

  it('HỦY yêu cầu xóa (cancel-deletion, còn trong 48h) → gửi lại được BÌNH THƯỜNG (ân hạn cho undo hoạt động lại)', async () => {
    const db = getBotDb();
    const nam = await makeAgent();
    const b = await makeAgent();
    await makeFriends(nam.id, b.id);
    const room = await findOrCreateDirectRoom(db, nam.id, b.id);
    await db.agent.update({ where: { id: nam.id }, data: { deletionRequestedAt: new Date() } });
    await expectCode(sendMessage(db, { roomId: room.id, senderId: nam.id, kind: 'TEXT', body: 'x' }), 'ACCOUNT_DEACTIVATED');
    // hủy xóa
    await db.agent.update({ where: { id: nam.id }, data: { deletionRequestedAt: null } });
    const ok = await sendMessage(db, { roomId: room.id, senderId: nam.id, kind: 'TEXT', body: 'sống lại rồi' });
    expect(ok.body).toBe('sống lại rồi');
  });

  it('người nhận đã vô hiệu hóa KHÔNG chặn người GỬI còn sống (chỉ chặn theo NGƯỜI GỬI)', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const nam = await makeAgent();
    await makeFriends(a.id, nam.id);
    const room = await findOrCreateDirectRoom(db, a.id, nam.id);
    await db.agent.update({ where: { id: nam.id }, data: { deletionRequestedAt: new Date() } });
    // a (còn sống) vẫn gửi được vào phòng dù nam (đối phương) đã vô hiệu hóa — enforcement theo người gửi.
    const ok = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'chào Nam' });
    expect(ok.id).toBeTruthy();
  });
});

describe('POST /v1/chat/rooms/:roomId/messages — 403 ACCOUNT_DEACTIVATED qua HTTP', () => {
  const app = createApp();
  it('gửi tin qua HTTP khi đã vô hiệu hóa → 403 ACCOUNT_DEACTIVATED', async () => {
    const db = getBotDb();
    const nam = await makeAgent();
    const b = await makeAgent();
    await makeFriends(nam.id, b.id);
    const room = await findOrCreateDirectRoom(db, nam.id, b.id);
    const { headers } = await linkAgentToRc(nam.id);
    await db.agent.update({ where: { id: nam.id }, data: { deletionRequestedAt: new Date() } });

    const res = await request(app).post(`/v1/chat/rooms/${room.id}/messages`).set(headers).send({ kind: 'TEXT', body: 'hack' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ACCOUNT_DEACTIVATED');
  });
});

describe('Hiển thị — cờ deactivated + tên thay thế (BUG "vẫn hiện đang hoạt động")', () => {
  const app = createApp();

  it('GET /v1/me/friends → friend đã vô hiệu hóa có deactivated:true; bạn còn sống deactivated:false', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const alive = await makeAgent();
    const dead = await makeAgent();
    await makeFriends(me.id, alive.id);
    await makeFriends(me.id, dead.id);
    await db.agent.update({ where: { id: dead.id }, data: { deletionRequestedAt: new Date() } });

    const result = await listFriends(db, me.id);
    const byId = new Map(result.friends.map((f) => [f.agentId, f]));
    expect(byId.get(alive.id)?.deactivated).toBe(false);
    expect(byId.get(dead.id)?.deactivated).toBe(true);
    // BUG#10 (6/8) — presence GIỜ đã THẬT (agentPresenceOnline, chat-realtime-hub.ts). Tài khoản đã vô hiệu hóa
    // PHẢI hiện OFFLINE tường minh (false), KHÔNG phải null/"chưa biết" và tuyệt đối KHÔNG true (Admin Demo "tài
    // khoản đã xóa không được hiện đang hoạt động"). friend-service trả `false` cho nhánh deactivated.
    expect(byId.get(dead.id)?.online).toBe(false);
  });

  it('GET /v1/chat/rooms/:roomId/members → thành viên vô hiệu hóa có deactivated:true + name = "Tài khoản đã bị vô hiệu hóa"', async () => {
    const db = getBotDb();
    const owner = await makeAgent(undefined, { name: 'Chủ nhóm' });
    const nam = await makeAgent(undefined, { name: 'Nam' });
    const other = await makeAgent(undefined, { name: 'Khác' });
    await makeFriends(owner.id, nam.id);
    await makeFriends(owner.id, other.id);
    const room = await createGroupRoom(db, owner.id, 'Nhóm test', [nam.id, other.id]);
    await db.agent.update({ where: { id: nam.id }, data: { deletionRequestedAt: new Date() } });

    const { headers } = await linkAgentToRc(owner.id);
    const res = await request(app).get(`/v1/chat/rooms/${room.id}/members`).set(headers);
    expect(res.status).toBe(200);
    const members: Array<{ agentId: number; deactivated: boolean; name: string }> = res.body.data;
    const namRow = members.find((m) => m.agentId === nam.id)!;
    const otherRow = members.find((m) => m.agentId === other.id)!;
    expect(namRow.deactivated).toBe(true);
    expect(namRow.name).toBe(DEACTIVATED_DISPLAY_NAME);
    expect(otherRow.deactivated).toBe(false);
    expect(otherRow.name).toBe('Khác');
  });
});

describe('Realtime — WS bị từ chối khi tài khoản đã vô hiệu hóa (BUG "vẫn nhận/gửi realtime")', () => {
  let server: http.Server;
  let port: number;

  async function startServer(): Promise<void> {
    resetChatRealtimeHubForTest();
    resetChatRealtimeConnectionCountForTest();
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachChatRealtimeProxy(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  }
  async function stopServer(): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  it('session hợp lệ NHƯNG agent có deletionRequestedAt → đóng NGAY (SESSION_EXPIRED_CLOSE_CODE)', async () => {
    await startServer();
    try {
      const db = getBotDb();
      const nam = await makeAgent();
      const rcUserId = nextRcUserId();
      await db.agent.update({ where: { id: nam.id }, data: { rcUserId, deletionRequestedAt: new Date() } });
      const session = await createWebSession(db, { rcUserId, rcAuthToken: 'tok', agentId: nam.id });

      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, {
        headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` }
      });
      const closeCode = await new Promise<number>((resolve, reject) => {
        ws.on('close', (code) => resolve(code));
        ws.on('error', reject);
      });
      expect(closeCode).toBe(SESSION_EXPIRED_CLOSE_CODE);
    } finally {
      await stopServer();
    }
  });

  it('agent còn sống → WS mở được BÌNH THƯỜNG (đối chứng, fix KHÔNG chặn nhầm người còn hoạt động)', async () => {
    await startServer();
    try {
      const db = getBotDb();
      const alive = await makeAgent();
      const rcUserId = nextRcUserId();
      await db.agent.update({ where: { id: alive.id }, data: { rcUserId } });
      const session = await createWebSession(db, { rcUserId, rcAuthToken: 'tok', agentId: alive.id });

      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, {
        headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` }
      });
      const opened = await new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true));
        ws.on('close', () => resolve(false));
        ws.on('error', () => resolve(false));
      });
      expect(opened).toBe(true);
      ws.terminate();
    } finally {
      await stopServer();
    }
  });
});
