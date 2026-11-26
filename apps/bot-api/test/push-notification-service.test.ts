// SIGMA (26/7) — test push-notification-service.ts. Firebase Admin SDK thật KHÔNG gọi trong suite tự
// động (cần service account key thật + mạng ra ngoài tới Firebase — ngoài phạm vi unit test, xem báo cáo
// build cho phần verify thật trên emulator Android). `sendPushToAgent` nhận `messagingClient` injected —
// test dùng stub thuần để phủ ĐẦY ĐỦ logic: đọc token theo agentId/gọi đúng payload/dọn token chết/best-effort
// không throw khi Firebase lỗi.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent } from './fixtures.js';
import { pickTokensToRemove, sendPushToAgent, type PushMessagingClient } from '../src/push-notification-service.js';

describe('pickTokensToRemove (thuần, không I/O)', () => {
  it('chỉ chọn token có lỗi registration-token-not-registered/invalid-registration-token', () => {
    const tokens = ['t1', 't2', 't3', 't4'];
    const responses = [
      { success: true },
      { success: false, error: { code: 'messaging/registration-token-not-registered' } },
      { success: false, error: { code: 'messaging/internal-error' } }, // lỗi tạm — KHÔNG xóa
      { success: false, error: { code: 'messaging/invalid-registration-token' } }
    ];
    expect(pickTokensToRemove(tokens, responses)).toEqual(['t2', 't4']);
  });

  it('mọi response success:true → mảng rỗng', () => {
    expect(pickTokensToRemove(['t1', 't2'], [{ success: true }, { success: true }])).toEqual([]);
  });

  it('response thiếu error.code (fail nhưng không rõ mã) → KHÔNG xóa (tránh xóa nhầm token còn sống)', () => {
    expect(pickTokensToRemove(['t1'], [{ success: false }])).toEqual([]);
  });

  it('mảng tokens/responses lệch độ dài → chỉ xử lý phần chung, KHÔNG throw', () => {
    expect(pickTokensToRemove(['t1', 't2'], [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }])).toEqual(['t1']);
  });
});

describe('sendPushToAgent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('agent chưa có PushToken nào → KHÔNG gọi messagingClient (không có gì để gửi)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const client: PushMessagingClient = { sendEachForMulticast: vi.fn() };
    await sendPushToAgent(db, agent.id, { title: 'A', body: 'B' }, client);
    expect(client.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('agent có 2 token → gửi ĐÚNG 1 lần multicast với đủ 2 token + đúng title/body/data', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.pushToken.create({ data: { agentId: agent.id, token: `tok-a-${Date.now()}`, platform: 'android' } });
    await db.pushToken.create({ data: { agentId: agent.id, token: `tok-b-${Date.now()}`, platform: 'android' } });

    const sendMock = vi.fn().mockResolvedValue({ responses: [{ success: true }, { success: true }] });
    const client: PushMessagingClient = { sendEachForMulticast: sendMock };
    await sendPushToAgent(db, agent.id, { title: 'Người gửi', body: 'Nội dung tin nhắn', data: { roomId: 'room-1' } }, client);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.tokens).toHaveLength(2);
    expect(arg.notification).toEqual({ title: 'Người gửi', body: 'Nội dung tin nhắn' });
    expect(arg.data).toEqual({ roomId: 'room-1' });
  });

  it('chỉ gửi token CỦA ĐÚNG agent này — KHÔNG lẫn token agent khác', async () => {
    const db = getBotDb();
    const agentA = await makeAgent();
    const agentB = await makeAgent();
    const tokenA = `tok-a-${Date.now()}`;
    const tokenB = `tok-b-${Date.now()}`;
    await db.pushToken.create({ data: { agentId: agentA.id, token: tokenA, platform: 'android' } });
    await db.pushToken.create({ data: { agentId: agentB.id, token: tokenB, platform: 'android' } });

    const sendMock = vi.fn().mockResolvedValue({ responses: [{ success: true }] });
    const client: PushMessagingClient = { sendEachForMulticast: sendMock };
    await sendPushToAgent(db, agentA.id, { title: 'T', body: 'B' }, client);

    const arg = sendMock.mock.calls[0][0];
    expect(arg.tokens).toEqual([tokenA]);
  });

  it('FCM trả lỗi token-not-registered cho 1 token → tự XÓA token đó khỏi DB, giữ nguyên token còn lại', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const deadToken = `tok-dead-${Date.now()}`;
    const aliveToken = `tok-alive-${Date.now()}`;
    await db.pushToken.create({ data: { agentId: agent.id, token: deadToken, platform: 'android' } });
    await db.pushToken.create({ data: { agentId: agent.id, token: aliveToken, platform: 'android' } });

    // Thứ tự response PHẢI khớp thứ tự tokens gửi lên (findMany theo id — deadToken tạo trước → index 0).
    const sendMock = vi.fn().mockResolvedValue({
      responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }, { success: true }]
    });
    const client: PushMessagingClient = { sendEachForMulticast: sendMock };
    await sendPushToAgent(db, agent.id, { title: 'T', body: 'B' }, client);

    const remaining = await db.pushToken.findMany({ where: { agentId: agent.id } });
    expect(remaining.map((t) => t.token)).toEqual([aliveToken]);
  });

  it('messagingClient.sendEachForMulticast throw (Firebase down/mạng lỗi) → KHÔNG throw ra ngoài, best-effort', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.pushToken.create({ data: { agentId: agent.id, token: `tok-${Date.now()}`, platform: 'android' } });
    const client: PushMessagingClient = { sendEachForMulticast: vi.fn().mockRejectedValue(new Error('Firebase down')) };
    await expect(sendPushToAgent(db, agent.id, { title: 'T', body: 'B' }, client)).resolves.toBeUndefined();
  });

  it('gọi kèm priority:\'high\' (vd cuộc gọi đến) → truyền android:{priority:\'high\'} xuống messagingClient', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.pushToken.create({ data: { agentId: agent.id, token: `tok-call-${Date.now()}`, platform: 'android' } });

    const sendMock = vi.fn().mockResolvedValue({ responses: [{ success: true }] });
    const client: PushMessagingClient = { sendEachForMulticast: sendMock };
    await sendPushToAgent(
      db,
      agent.id,
      { title: 'Cuộc gọi đến', body: 'Người gọi', data: { kind: 'incoming_call' }, priority: 'high' },
      client
    );

    const arg = sendMock.mock.calls[0][0];
    expect(arg.android).toEqual({ priority: 'high' });
  });

  it('gọi NHƯ CŨ (không truyền priority, vd tin nhắn thường) → KHÔNG có field android trong payload gửi FCM', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.pushToken.create({ data: { agentId: agent.id, token: `tok-msg-${Date.now()}`, platform: 'android' } });

    const sendMock = vi.fn().mockResolvedValue({ responses: [{ success: true }] });
    const client: PushMessagingClient = { sendEachForMulticast: sendMock };
    await sendPushToAgent(db, agent.id, { title: 'Người gửi', body: 'Nội dung tin nhắn', data: { roomId: 'room-1' } }, client);

    const arg = sendMock.mock.calls[0][0];
    expect(arg.android).toBeUndefined();
  });

  it('B115-tiếp (2/8): dataOnly:true → KHÔNG có field `notification` trong payload gửi FCM, title/body chuyển vào `data`', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.pushToken.create({ data: { agentId: agent.id, token: `tok-dataonly-${Date.now()}`, platform: 'android' } });

    const sendMock = vi.fn().mockResolvedValue({ responses: [{ success: true }] });
    const client: PushMessagingClient = { sendEachForMulticast: sendMock };
    await sendPushToAgent(
      db,
      agent.id,
      { title: 'Người gửi', body: 'Nội dung tin nhắn', data: { roomId: 'room-1', kind: 'chat_message' }, dataOnly: true },
      client
    );

    const arg = sendMock.mock.calls[0][0];
    expect(arg.notification).toBeUndefined();
    expect(arg.data).toEqual({ roomId: 'room-1', kind: 'chat_message', title: 'Người gửi', body: 'Nội dung tin nhắn' });
  });

  it('cụm #21 (6/8): push TIN NHẮN = dataOnly:true + priority:\'high\' → android.priority high (vượt Doze/khóa màn) + KHÔNG notification + title/body vào data', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.pushToken.create({ data: { agentId: agent.id, token: `tok-msg-hp-${Date.now()}`, platform: 'android' } });

    const sendMock = vi.fn().mockResolvedValue({ responses: [{ success: true }] });
    const client: PushMessagingClient = { sendEachForMulticast: sendMock };
    await sendPushToAgent(
      db,
      agent.id,
      { title: 'Người gửi', body: 'Nội dung', data: { roomId: 'room-1', kind: 'chat_message', roomType: 'DIRECT', avatarAgentId: '3' }, dataOnly: true, priority: 'high' },
      client
    );

    const arg = sendMock.mock.calls[0][0];
    expect(arg.android).toEqual({ priority: 'high' }); // gốc bug B: high-priority để Doze giao ngay khi khóa màn.
    expect(arg.notification).toBeUndefined(); // dataOnly → native tự xây notification (không để hệ thống tự hiện).
    expect(arg.data).toEqual({ roomId: 'room-1', kind: 'chat_message', roomType: 'DIRECT', avatarAgentId: '3', title: 'Người gửi', body: 'Nội dung' });
  });

  it('gọi NHƯ CŨ (không truyền dataOnly, vd cuộc gọi đến) → VẪN có field `notification` như trước (KHÔNG đổi hành vi cũ)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.pushToken.create({ data: { agentId: agent.id, token: `tok-notdataonly-${Date.now()}`, platform: 'android' } });

    const sendMock = vi.fn().mockResolvedValue({ responses: [{ success: true }] });
    const client: PushMessagingClient = { sendEachForMulticast: sendMock };
    await sendPushToAgent(db, agent.id, { title: 'Cuộc gọi đến', body: 'Người gọi', data: { kind: 'incoming_call' } }, client);

    const arg = sendMock.mock.calls[0][0];
    expect(arg.notification).toEqual({ title: 'Cuộc gọi đến', body: 'Người gọi' });
    expect(arg.data).toEqual({ kind: 'incoming_call' }); // KHÔNG tự chèn thêm title/body vào data khi dataOnly=false.
  });

  it('db.pushToken.findMany throw (DB lỗi/pool cạn) → KHÔNG throw ra ngoài, best-effort (audit độc lập 30/7 MEDIUM — trước đây thiếu try/catch đúng câu query đầu tiên)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const findManySpy = vi.spyOn(db.pushToken, 'findMany').mockRejectedValueOnce(new Error('DB lỗi giả lập'));
    const client: PushMessagingClient = { sendEachForMulticast: vi.fn() };
    await expect(sendPushToAgent(db, agent.id, { title: 'T', body: 'B' }, client)).resolves.toBeUndefined();
    expect(client.sendEachForMulticast).not.toHaveBeenCalled();
    findManySpy.mockRestore();
  });

  it('KHÔNG truyền messagingClient + thiếu FIREBASE_SERVICE_ACCOUNT_PATH → KHÔNG throw ra ngoài (best-effort, chỉ log)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.pushToken.create({ data: { agentId: agent.id, token: `tok-${Date.now()}`, platform: 'android' } });
    const saved = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    try {
      await expect(sendPushToAgent(db, agent.id, { title: 'T', body: 'B' })).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT_PATH = saved;
    }
  });
});
