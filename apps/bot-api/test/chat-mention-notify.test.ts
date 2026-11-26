// Tag @ mention kiểu Zalo (13/8) — regression cho luồng thông báo MENTION khi gửi tin nhắn nhóm có
// `metadataJson.mentions`. Verify: (1) người ĐƯỢC NHẮC + là thành viên phòng nhận 1 thông báo MENTION (chuông
// agent_notifications, postId=roomId) + FCM push "… đã nhắc bạn trong <phòng>"; (2) người KHÔNG được nhắc KHÔNG
// nhận MENTION; (3) tự-nhắc-mình (người gửi) + nhắc người NGOÀI phòng bị BỎ QUA (validate server-side); (4)
// parseMentionAgentIds() thuần lọc đúng shape. CÙNG khuôn chat-notify-e2e.test.ts (mock sendPushToAgent vì FCM
// cần Firebase thật — verify FCM thật đã có ở push-notification-service.test.ts).
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Mock CHỈ sendPushToAgent (giữ mọi export thuần khác) — KHÔNG gọi Firebase trong test.
vi.mock('../src/push-notification-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/push-notification-service.js')>('../src/push-notification-service.js');
  return { ...actual, sendPushToAgent: vi.fn().mockResolvedValue(undefined) };
});

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { createGroupRoom } from '../src/services/chat-room-service.js';
import { parseMentionAgentIds, parseMentionAll } from '../src/services/chat-message-service.js';
import { sendPushToAgent } from '../src/push-notification-service.js';

let uniqCounter = 0;
async function authedAgent(name?: string) {
  uniqCounter += 1;
  const rcUserId = `rc-mention-${Date.now()}-${uniqCounter}`;
  const db = getBotDb();
  const agent = await makeAgent(undefined, { name });
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId, rcUsername: `mention${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `dummy-tok-${uniqCounter}`, agentId: agent.id });
  return { agent, sessionId: ws.id };
}

function authed(app: ReturnType<typeof createApp>, sessionId: string) {
  return {
    post: (path: string) =>
      request(app).post(path).set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
  };
}

describe('parseMentionAgentIds — hàm thuần', () => {
  it('trích mảng agentId hợp lệ, dedupe, bỏ giá trị sai', () => {
    expect(parseMentionAgentIds('{"mentions":[3,5,3,0,-1,"x",2.5]}')).toEqual([3, 5]);
  });
  it('parseMentionAll — mentionAll:true → true; thiếu/hỏng/false → false (@all, 24/8)', () => {
    expect(parseMentionAll('{"mentionAll":true}')).toBe(true);
    expect(parseMentionAll('{"mentions":[2],"mentionAll":true}')).toBe(true);
    expect(parseMentionAll('{"mentions":[2]}')).toBe(false);
    expect(parseMentionAll('{"mentionAll":false}')).toBe(false);
    expect(parseMentionAll('{"mentionAll":1}')).toBe(false); // chỉ boolean true mới tính
    expect(parseMentionAll(null)).toBe(false);
    expect(parseMentionAll('{broken')).toBe(false);
  });
  it('không có / hỏng / sai shape → []', () => {
    expect(parseMentionAgentIds(null)).toEqual([]);
    expect(parseMentionAgentIds('{broken')).toEqual([]);
    expect(parseMentionAgentIds('{"foo":1}')).toEqual([]);
    expect(parseMentionAgentIds('{"mentions":"x"}')).toEqual([]);
  });
});

describe('Tag @ mention — thông báo MENTION khi gửi tin nhóm', () => {
  const app = createApp();

  it('nhắc B (thành viên) → B nhận MENTION + push; C (không nhắc) KHÔNG nhận MENTION; người gửi KHÔNG tự nhận', async () => {
    const { agent: owner, sessionId: sOwner } = await authedAgent('Chủ Nhóm');
    const { agent: b } = await authedAgent('Trần Thị B');
    const { agent: c } = await authedAgent('Lê Văn C');
    await makeFriends(owner.id, b.id);
    await makeFriends(owner.id, c.id);
    const room = await createGroupRoom(getBotDb(), owner.id, 'Nhóm SigMa', [b.id, c.id]);

    vi.mocked(sendPushToAgent).mockClear();

    const res = await authed(app, sOwner)
      .post(`/v1/chat/rooms/${room.id}/messages`)
      .send({ kind: 'TEXT', body: `Chào @Trần Thị B nhé`, metadataJson: JSON.stringify({ mentions: [b.id], mentionNames: ['Trần Thị B'] }) });
    expect(res.status).toBe(201);

    const db = getBotDb();
    const bMention = await db.agentNotification.findMany({ where: { recipientAgentId: b.id, type: 'MENTION' } });
    expect(bMention).toHaveLength(1);
    expect(bMention[0].actorAgentId).toBe(owner.id);
    expect(bMention[0].postId).toBe(room.id);
    expect(bMention[0].readAt).toBeNull();

    const cMention = await db.agentNotification.findMany({ where: { recipientAgentId: c.id, type: 'MENTION' } });
    expect(cMention).toHaveLength(0);

    const ownerMention = await db.agentNotification.findMany({ where: { recipientAgentId: owner.id, type: 'MENTION' } });
    expect(ownerMention).toHaveLength(0);

    // FCM push mention gửi cho B với nội dung "… đã nhắc bạn trong <phòng>".
    const pushCalls = vi.mocked(sendPushToAgent).mock.calls;
    const bMentionPush = pushCalls.find(
      ([, agentId, payload]) => agentId === b.id && typeof payload?.body === 'string' && payload.body.includes('đã nhắc bạn trong')
    );
    expect(bMentionPush).toBeDefined();
    expect(bMentionPush?.[2]?.body).toBe('Chủ Nhóm đã nhắc bạn trong Nhóm SigMa');
    expect(bMentionPush?.[2]?.data?.kind).toBe('chat_mention');
    expect(bMentionPush?.[2]?.data?.roomId).toBe(room.id);
  });

  it('tự-nhắc-mình + nhắc người NGOÀI phòng bị BỎ QUA; chỉ thành viên hợp lệ nhận MENTION', async () => {
    const { agent: owner, sessionId: sOwner } = await authedAgent('Chủ 2');
    const { agent: b } = await authedAgent('Thành viên B2');
    const { agent: c } = await authedAgent('Thành viên C2');
    const { agent: stranger } = await authedAgent('Người ngoài');
    await makeFriends(owner.id, b.id);
    await makeFriends(owner.id, c.id);
    const room = await createGroupRoom(getBotDb(), owner.id, 'Nhóm Beta', [b.id, c.id]);

    const res = await authed(app, sOwner)
      .post(`/v1/chat/rooms/${room.id}/messages`)
      .send({
        kind: 'TEXT',
        body: 'test @self @stranger @B2',
        metadataJson: JSON.stringify({ mentions: [owner.id, stranger.id, b.id] })
      });
    expect(res.status).toBe(201);

    const db = getBotDb();
    // owner tự nhắc mình → KHÔNG có MENTION.
    expect(await db.agentNotification.count({ where: { recipientAgentId: owner.id, type: 'MENTION' } })).toBe(0);
    // stranger ngoài phòng → KHÔNG có MENTION.
    expect(await db.agentNotification.count({ where: { recipientAgentId: stranger.id, type: 'MENTION' } })).toBe(0);
    // B2 thành viên hợp lệ được nhắc → đúng 1 MENTION.
    expect(await db.agentNotification.count({ where: { recipientAgentId: b.id, type: 'MENTION' } })).toBe(1);
  });

  it('@all (mentionAll:true) → MỌI thành viên (B,C) nhận MENTION; người gửi KHÔNG; không cần liệt kê agentId', async () => {
    const { agent: owner, sessionId: sOwner } = await authedAgent('Chủ All');
    const { agent: b } = await authedAgent('TV B-all');
    const { agent: c } = await authedAgent('TV C-all');
    await makeFriends(owner.id, b.id);
    await makeFriends(owner.id, c.id);
    const room = await createGroupRoom(getBotDb(), owner.id, 'Nhóm All', [b.id, c.id]);

    // @all: mentions RỖNG (client KHÔNG liệt kê id), chỉ mentionAll:true → backend tự resolve toàn bộ thành viên.
    const res = await authed(app, sOwner)
      .post(`/v1/chat/rooms/${room.id}/messages`)
      .send({ kind: 'TEXT', body: 'Thông báo @Tất cả nhé', metadataJson: JSON.stringify({ mentions: [], mentionNames: ['Tất cả'], mentionAll: true }) });
    expect(res.status).toBe(201);

    const db = getBotDb();
    expect(await db.agentNotification.count({ where: { recipientAgentId: b.id, type: 'MENTION' } })).toBe(1);
    expect(await db.agentNotification.count({ where: { recipientAgentId: c.id, type: 'MENTION' } })).toBe(1);
    expect(await db.agentNotification.count({ where: { recipientAgentId: owner.id, type: 'MENTION' } })).toBe(0); // người gửi không tự nhận
  });

  it('tin nhóm KHÔNG có mentions → KHÔNG tạo MENTION nào', async () => {
    const { agent: owner, sessionId: sOwner } = await authedAgent('Chủ 3');
    const { agent: b } = await authedAgent('TV B3');
    const { agent: c } = await authedAgent('TV C3');
    await makeFriends(owner.id, b.id);
    await makeFriends(owner.id, c.id);
    const room = await createGroupRoom(getBotDb(), owner.id, 'Nhóm Gamma', [b.id, c.id]);

    const res = await authed(app, sOwner).post(`/v1/chat/rooms/${room.id}/messages`).send({ kind: 'TEXT', body: 'không nhắc ai cả' });
    expect(res.status).toBe(201);

    const db = getBotDb();
    expect(await db.agentNotification.count({ where: { recipientAgentId: b.id, type: 'MENTION' } })).toBe(0);
    expect(await db.agentNotification.count({ where: { recipientAgentId: c.id, type: 'MENTION' } })).toBe(0);
  });
});
