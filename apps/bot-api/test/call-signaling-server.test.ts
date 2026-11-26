// SIGMA Phase 4 (30/7) — test call-signaling-server.ts. 2 WebSocket client (caller/callee) chạy CHUNG 1
// process Node (cùng máy) nối vào CÙNG 1 http.Server test — VERIFY GIAO THỨC (invite→ring→accept/reject→
// offer/answer/ICE relay→end, mọi nhánh timeout rút gọn). KHÔNG chứng minh NAT traversal/TURN thật — cần 2
// thiết bị thật KHÁC MẠNG + coturn deploy thật (xem <REPO>\tools\sigma-coturn\docker-compose.yml +
// turnserver.conf mẫu), ngoài khả năng của 1 test tự động chạy trong CI/máy dev.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachCallSignaling } from '../src/call-signaling-server.js';
import { SESSION_EXPIRED_CLOSE_CODE } from '../src/ws-cookie-session.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { makeFriends } from './fixtures.js';

// Nợ độ tin cậy đánh thức cuộc gọi (30/7): call-signaling-server.ts giờ gọi sendPushToAgent() best-effort khi
// callee KHÔNG có kết nối WS nào đang mở. Mock CÙNG khuôn rc-events.test.ts (giữ nguyên mọi export thuần khác
// của module, chỉ thay sendPushToAgent bằng vi.fn() — test firebase THẬT đã có riêng ở
// push-notification-service.test.ts, KHÔNG lặp lại ở đây).
vi.mock('../src/push-notification-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/push-notification-service.js')>('../src/push-notification-service.js');
  return { ...actual, sendPushToAgent: vi.fn().mockResolvedValue(undefined) };
});
import { sendPushToAgent } from '../src/push-notification-service.js';

// Rút ngắn timeout ring/signaling cho test (KHÔNG chờ 45s/15s thật — attachCallSignaling nhận
// AttachCallSignalingOptions riêng cho việc này).
const RING_TIMEOUT_MS = 80;
const SIGNALING_TIMEOUT_MS = 80;

type SignalingMessage = Record<string, unknown>;

interface TestAgent {
  agentId: number;
  sessionId: string;
}

async function makeTestAgent(name: string): Promise<TestAgent> {
  const db = getBotDb();
  const agent = await db.agent.create({ data: { name } });
  // Ưu tiên rcUserId (session-middleware.ts requireSession() + handleUpgrade() ở đây tra Agent theo
  // rcUserId TRƯỚC agentId, xem comment call-signaling-server.ts) — PHẢI gán KHỚP rcUserId lên CHÍNH Agent
  // đó (không chỉ trên WebSession), giống hệt happy-path ở test/session-middleware.test.ts, nếu không
  // findFirst({where:{rcUserId}}) sẽ KHÔNG tìm thấy agent (rcUserId của Agent mặc định null) → bị coi là
  // phiên không hợp lệ dù agentId vẫn đúng.
  const rcUserId = `rc-call-${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId } });
  const session = await createWebSession(db, { rcUserId, rcAuthToken: 'dummy-tok', agentId: agent.id });
  return { agentId: agent.id, sessionId: session.id };
}

function connect(port: number, sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/call-signaling`, {
      headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${sessionId}` }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function send(ws: WebSocket, msg: SignalingMessage): void {
  ws.send(JSON.stringify(msg));
}

// [22/11] Hạn chờ 2 giây là QUÁ NGẮN khi chạy trong CẢ LÔ (250 tệp kiểm cùng lúc): chạy riêng cả bài xong
// trong 11 giây, chạy trong lô thì ngốn 62 giây rồi TRƯỢT ở đây — đỏ vì MÁY BẬN, không phải vì lỗi thật,
// và nó CHẶN SHIP. Nới lên 15 giây: vẫn bắt được treo thật (các nhánh timeout nghiệp vụ dùng mốc riêng,
// rút gọn còn vài trăm ms nên không bị hạn này che).
function waitForMessage(ws: WebSocket, predicate: (msg: SignalingMessage) => boolean, timeoutMs = 15000): Promise<SignalingMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`timeout (${timeoutMs}ms) chờ message khớp điều kiện`));
    }, timeoutMs);
    function handler(raw: Buffer | string): void {
      let msg: SignalingMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    }
    ws.on('message', handler);
  });
}

describe('call-signaling-server — xác thực upgrade (KHÔNG chạm giao thức nghiệp vụ)', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachCallSignaling(server, { ringTimeoutMs: RING_TIMEOUT_MS, signalingTimeoutMs: SIGNALING_TIMEOUT_MS });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('KHÔNG có cookie → đóng NGAY với SESSION_EXPIRED_CLOSE_CODE', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/call-signaling`);
    const code = await new Promise<number>((resolve, reject) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', reject);
    });
    expect(code).toBe(SESSION_EXPIRED_CLOSE_CODE);
  });

  it('cookie trỏ session không tồn tại → đóng NGAY với SESSION_EXPIRED_CLOSE_CODE', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/call-signaling`, {
      headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=khong-ton-tai-call-test` }
    });
    const code = await new Promise<number>((resolve, reject) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', reject);
    });
    expect(code).toBe(SESSION_EXPIRED_CLOSE_CODE);
  });

  it('session hợp lệ nhưng KHÔNG link agent nào → đóng NGAY với SESSION_EXPIRED_CLOSE_CODE', async () => {
    const db = getBotDb();
    const session = await createWebSession(db, { rcUserId: 'rc-no-agent-call-test', rcAuthToken: 'dummy-tok' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/call-signaling`, {
      headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${session.id}` }
    });
    const code = await new Promise<number>((resolve, reject) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', reject);
    });
    expect(code).toBe(SESSION_EXPIRED_CLOSE_CODE);
  });
});

describe('call-signaling-server — giao thức đầy đủ', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.mocked(sendPushToAgent).mockClear();
    vi.mocked(sendPushToAgent).mockResolvedValue(undefined);
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachCallSignaling(server, { ringTimeoutMs: RING_TIMEOUT_MS, signalingTimeoutMs: SIGNALING_TIMEOUT_MS });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('luồng đầy đủ: invite→ring→accept→offer→answer→ICE (2 chiều)→call_end, DB chuyển ENDED có durationSec', async () => {
    const db = getBotDb();
    const caller = await makeTestAgent('Signaling Caller A');
    const callee = await makeTestAgent('Signaling Callee A');
    await makeFriends(caller.agentId, callee.agentId); // audit 30/7 HIGH: call_invite giờ đòi bạn bè.
    const wsCaller = await connect(port, caller.sessionId);
    const wsCallee = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    const callId = ringing.callId as string;
    expect(typeof callId).toBe('string');

    const incoming = await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');
    expect(incoming.callId).toBe(callId);
    expect(incoming.callerAgentId).toBe(caller.agentId);
    expect(incoming.callerName).toBe('Signaling Caller A');
    expect(incoming.kind).toBe('VOICE');

    send(wsCallee, { type: 'call_accept', callId });
    const accepted = await waitForMessage(wsCaller, (m) => m.type === 'call_accepted');
    expect(accepted.callId).toBe(callId);

    send(wsCaller, { type: 'offer', callId, sdp: 'fake-sdp-offer' });
    const offerMsg = await waitForMessage(wsCallee, (m) => m.type === 'offer');
    expect(offerMsg.callId).toBe(callId);
    expect(offerMsg.sdp).toBe('fake-sdp-offer');

    send(wsCallee, { type: 'answer', callId, sdp: 'fake-sdp-answer' });
    const answerMsg = await waitForMessage(wsCaller, (m) => m.type === 'answer');
    expect(answerMsg.sdp).toBe('fake-sdp-answer');

    send(wsCaller, { type: 'ice_candidate', callId, candidate: { candidate: 'candidate-from-caller' } });
    const iceAtCallee = await waitForMessage(wsCallee, (m) => m.type === 'ice_candidate');
    expect(iceAtCallee.candidate).toEqual({ candidate: 'candidate-from-caller' });

    send(wsCallee, { type: 'ice_candidate', callId, candidate: { candidate: 'candidate-from-callee' } });
    const iceAtCaller = await waitForMessage(wsCaller, (m) => m.type === 'ice_candidate');
    expect(iceAtCaller.candidate).toEqual({ candidate: 'candidate-from-callee' });

    send(wsCaller, { type: 'call_end', callId, reason: 'HANGUP' });
    const endMsg = await waitForMessage(wsCallee, (m) => m.type === 'call_end');
    expect(endMsg.reason).toBe('HANGUP');

    const row = await db.callSession.findUniqueOrThrow({ where: { id: callId } });
    expect(row.status).toBe('ENDED');
    expect(row.endReason).toBe('HANGUP');
    expect(row.durationSec).not.toBeNull();

    wsCaller.close();
    wsCallee.close();
  });

  it('callee từ chối → caller nhận call_rejected, DB REJECTED', async () => {
    const db = getBotDb();
    const caller = await makeTestAgent('Signaling Caller B');
    const callee = await makeTestAgent('Signaling Callee B');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    const wsCallee = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VIDEO' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    const callId = ringing.callId as string;
    await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');

    send(wsCallee, { type: 'call_reject', callId, reason: 'BAN_KHONG_NGHE_MAY_DUOC' });
    const rejected = await waitForMessage(wsCaller, (m) => m.type === 'call_rejected');
    expect(rejected.callId).toBe(callId);
    expect(rejected.reason).toBe('BAN_KHONG_NGHE_MAY_DUOC');

    const row = await db.callSession.findUniqueOrThrow({ where: { id: callId } });
    expect(row.status).toBe('REJECTED');

    wsCaller.close();
    wsCallee.close();
  });

  it('caller tự hủy lúc còn RINGING (call_end trước accept) → CANCELLED, callee nhận call_end', async () => {
    const db = getBotDb();
    const caller = await makeTestAgent('Signaling Caller C');
    const callee = await makeTestAgent('Signaling Callee C');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    const wsCallee = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    const callId = ringing.callId as string;
    await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');

    send(wsCaller, { type: 'call_end', callId, reason: 'CALLER_HUNG_UP' });
    const endAtCallee = await waitForMessage(wsCallee, (m) => m.type === 'call_end');
    expect(endAtCallee.reason).toBe('CALLER_HUNG_UP');

    const row = await db.callSession.findUniqueOrThrow({ where: { id: callId } });
    expect(row.status).toBe('CANCELLED');

    wsCaller.close();
    wsCallee.close();
  });

  it('call_busy: callee đang RINGING với 1 caller → caller KHÁC mời gọi nhận call_busy (chống gọi chồng)', async () => {
    const caller1 = await makeTestAgent('Busy Caller 1');
    const callee = await makeTestAgent('Busy Callee');
    const caller2 = await makeTestAgent('Busy Caller 2');
    await makeFriends(caller1.agentId, callee.agentId);
    await makeFriends(caller2.agentId, callee.agentId);
    const wsCaller1 = await connect(port, caller1.sessionId);
    const wsCallee = await connect(port, callee.sessionId);
    const wsCaller2 = await connect(port, caller2.sessionId);

    send(wsCaller1, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    await waitForMessage(wsCaller1, (m) => m.type === 'call_ringing');
    await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');

    send(wsCaller2, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const busy = await waitForMessage(wsCaller2, (m) => m.type === 'call_busy');
    expect(busy.type).toBe('call_busy');

    wsCaller1.close();
    wsCallee.close();
    wsCaller2.close();
  });

  it('call_accept từ người KHÔNG PHẢI callee → call_error NOT_AUTHORIZED (caller tự accept cuộc gọi của mình)', async () => {
    const caller = await makeTestAgent('Auth Caller A');
    const callee = await makeTestAgent('Auth Callee A');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    const wsCallee = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');

    send(wsCaller, { type: 'call_accept', callId: ringing.callId });
    const err = await waitForMessage(wsCaller, (m) => m.type === 'call_error');
    expect(err.code).toBe('NOT_AUTHORIZED');

    wsCaller.close();
    wsCallee.close();
  });

  it('call_invite tự gọi chính mình → call_error VALIDATION, KHÔNG tạo CallSession mới', async () => {
    const db = getBotDb();
    const a = await makeTestAgent('Self Invite');
    const ws = await connect(port, a.sessionId);
    const before = await db.callSession.count({ where: { callerId: a.agentId } });

    send(ws, { type: 'call_invite', calleeAgentId: a.agentId, kind: 'VOICE' });
    const err = await waitForMessage(ws, (m) => m.type === 'call_error');
    expect(err.code).toBe('VALIDATION');

    const after = await db.callSession.count({ where: { callerId: a.agentId } });
    expect(after).toBe(before);

    ws.close();
  });

  it('nhiều thiết bị cùng agent (callee) — thiết bị KHÁC nhận call_answered_elsewhere khi 1 thiết bị accept', async () => {
    const caller = await makeTestAgent('MultiDevice Caller');
    const callee = await makeTestAgent('MultiDevice Callee');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    const wsCalleeDev1 = await connect(port, callee.sessionId);
    const wsCalleeDev2 = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    await waitForMessage(wsCalleeDev1, (m) => m.type === 'incoming_call');
    await waitForMessage(wsCalleeDev2, (m) => m.type === 'incoming_call');

    send(wsCalleeDev1, { type: 'call_accept', callId: ringing.callId });
    await waitForMessage(wsCaller, (m) => m.type === 'call_accepted');
    const elsewhere = await waitForMessage(wsCalleeDev2, (m) => m.type === 'call_answered_elsewhere');
    expect(elsewhere.callId).toBe(ringing.callId);

    wsCaller.close();
    wsCalleeDev1.close();
    wsCalleeDev2.close();
  });

  it('hết thời gian đổ chuông (rút gọn) không ai trả lời → cả 2 bên nhận call_timeout, DB MISSED', async () => {
    const db = getBotDb();
    const caller = await makeTestAgent('Timeout Caller A');
    const callee = await makeTestAgent('Timeout Callee A');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    const wsCallee = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    const callId = ringing.callId as string;
    await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');

    const timeoutAtCaller = await waitForMessage(wsCaller, (m) => m.type === 'call_timeout', RING_TIMEOUT_MS + 1000);
    expect(timeoutAtCaller.callId).toBe(callId);
    const timeoutAtCallee = await waitForMessage(wsCallee, (m) => m.type === 'call_timeout', RING_TIMEOUT_MS + 1000);
    expect(timeoutAtCallee.callId).toBe(callId);

    const row = await db.callSession.findUniqueOrThrow({ where: { id: callId } });
    expect(row.status).toBe('MISSED');
    expect(row.endReason).toBe('RING_TIMEOUT');

    wsCaller.close();
    wsCallee.close();
  });

  it('accept rồi KHÔNG ai gửi offer trong cửa sổ (rút gọn) → FAILED/SIGNALING_TIMEOUT, cả 2 bên nhận call_end', async () => {
    const db = getBotDb();
    const caller = await makeTestAgent('SigTimeout Caller A');
    const callee = await makeTestAgent('SigTimeout Callee A');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    const wsCallee = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    const callId = ringing.callId as string;
    await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');
    send(wsCallee, { type: 'call_accept', callId });
    await waitForMessage(wsCaller, (m) => m.type === 'call_accepted');

    const endAtCaller = await waitForMessage(wsCaller, (m) => m.type === 'call_end', SIGNALING_TIMEOUT_MS + 1000);
    expect(endAtCaller.reason).toBe('SIGNALING_TIMEOUT');
    const endAtCallee = await waitForMessage(wsCallee, (m) => m.type === 'call_end', SIGNALING_TIMEOUT_MS + 1000);
    expect(endAtCallee.reason).toBe('SIGNALING_TIMEOUT');

    const row = await db.callSession.findUniqueOrThrow({ where: { id: callId } });
    expect(row.status).toBe('FAILED');
    expect(row.endReason).toBe('SIGNALING_TIMEOUT');

    wsCaller.close();
    wsCallee.close();
  });

  it('accept + offer nhưng KHÔNG ai trả lời answer trong cửa sổ (rút gọn) → FAILED/SIGNALING_TIMEOUT', async () => {
    const db = getBotDb();
    const caller = await makeTestAgent('SigTimeout Caller B');
    const callee = await makeTestAgent('SigTimeout Callee B');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    const wsCallee = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    const callId = ringing.callId as string;
    await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');
    send(wsCallee, { type: 'call_accept', callId });
    await waitForMessage(wsCaller, (m) => m.type === 'call_accepted');

    send(wsCaller, { type: 'offer', callId, sdp: 'fake-sdp' });
    await waitForMessage(wsCallee, (m) => m.type === 'offer');
    // KHÔNG gửi answer — cửa sổ 15s(rút gọn) reset lúc offer relay giờ chờ answer, hết giờ → FAILED.

    const endAtCaller = await waitForMessage(wsCaller, (m) => m.type === 'call_end', SIGNALING_TIMEOUT_MS + 1000);
    expect(endAtCaller.reason).toBe('SIGNALING_TIMEOUT');

    const row = await db.callSession.findUniqueOrThrow({ where: { id: callId } });
    expect(row.status).toBe('FAILED');

    wsCaller.close();
    wsCallee.close();
  });

  it('WS rớt SAU KHI ACCEPTED KHÔNG tự kết thúc call (media coi như đã P2P/qua TURN)', async () => {
    const db = getBotDb();
    const caller = await makeTestAgent('DropAfterAccept Caller');
    const callee = await makeTestAgent('DropAfterAccept Callee');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    const wsCallee = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    const callId = ringing.callId as string;
    await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');
    send(wsCallee, { type: 'call_accept', callId });
    await waitForMessage(wsCaller, (m) => m.type === 'call_accepted');

    // Hoàn tất offer/answer trước khi rớt WS — test này verify RIÊNG "rớt WS không tự kết thúc call", KHÔNG
    // trộn với nhánh "thiếu offer/answer bị FAILED" (đã test riêng ở trên).
    send(wsCaller, { type: 'offer', callId, sdp: 'fake-sdp' });
    await waitForMessage(wsCallee, (m) => m.type === 'offer');
    send(wsCallee, { type: 'answer', callId, sdp: 'fake-sdp-answer' });
    await waitForMessage(wsCaller, (m) => m.type === 'answer');

    wsCaller.close();
    wsCallee.close();
    await new Promise((resolve) => setTimeout(resolve, SIGNALING_TIMEOUT_MS + 200));

    const row = await db.callSession.findUniqueOrThrow({ where: { id: callId } });
    expect(row.status).toBe('ACCEPTED'); // VẪN ACCEPTED — KHÔNG tự chuyển ENDED/FAILED chỉ vì WS đóng.
  });

  // Audit độc lập 30/7 (HIGH — đã fix): call_invite trước đây KHÔNG kiểm bạn bè/chặn — bất kỳ agent nào cũng
  // gọi được người lạ/người đã chặn mình. Test dưới đây chạy THẬT qua đúng WebSocket (không chỉ đọc code).
  it('call_invite tới agent CHƯA là bạn bè → call_error CANNOT_CALL, KHÔNG tạo CallSession', async () => {
    const db = getBotDb();
    const caller = await makeTestAgent('Stranger Caller');
    const callee = await makeTestAgent('Stranger Callee');
    const ws = await connect(port, caller.sessionId);

    send(ws, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const err = await waitForMessage(ws, (m) => m.type === 'call_error');
    expect(err.code).toBe('CANNOT_CALL');

    const count = await db.callSession.count({ where: { callerId: caller.agentId, calleeId: callee.agentId } });
    expect(count).toBe(0);
    ws.close();
  });

  it('call_invite tới agent ĐÃ CHẶN mình → call_error CANNOT_CALL (giống chặn nhắn tin)', async () => {
    const db = getBotDb();
    const caller = await makeTestAgent('Blocked Caller');
    const callee = await makeTestAgent('Blocker Callee');
    await db.friendRequest.create({
      data: { fromAgentId: callee.agentId, toAgentId: caller.agentId, status: 'ACCEPTED', acceptedAt: new Date(), blockedByFrom: true }
    });
    const ws = await connect(port, caller.sessionId);

    send(ws, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const err = await waitForMessage(ws, (m) => m.type === 'call_error');
    expect(err.code).toBe('CANNOT_CALL');
    ws.close();
  });

  // Audit độc lập 30/7 (HIGH — đã fix, race đã tự chạy thật xác nhận trước khi fix bị lặp lại): 2 lời mời gọi
  // ĐỒNG THỜI cho CÙNG 1 callee đang rảnh — CHỈ 1 cái được tạo CallSession/nhận call_ringing, cái còn lại phải
  // nhận call_busy NGAY (không phải cả 2 đều lọt qua do TOCTOU).
  it('2 caller mời gọi ĐỒNG THỜI cùng 1 callee đang rảnh → CHỈ 1 người thắng (call_ringing), người kia call_busy', async () => {
    const db = getBotDb();
    const caller1 = await makeTestAgent('Race Caller 1');
    const caller2 = await makeTestAgent('Race Caller 2');
    const callee = await makeTestAgent('Race Callee');
    await makeFriends(caller1.agentId, callee.agentId);
    await makeFriends(caller2.agentId, callee.agentId);
    const wsCaller1 = await connect(port, caller1.sessionId);
    const wsCaller2 = await connect(port, caller2.sessionId);

    // Gửi ĐỒNG THỜI, không await giữa 2 lần gửi — đúng kịch bản race đã tự chạy thật xác nhận trong audit.
    send(wsCaller1, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    send(wsCaller2, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });

    const results = await Promise.allSettled([
      waitForMessage(wsCaller1, (m) => m.type === 'call_ringing' || m.type === 'call_busy'),
      waitForMessage(wsCaller2, (m) => m.type === 'call_ringing' || m.type === 'call_busy')
    ]);
    const types = results.map((r) => (r.status === 'fulfilled' ? (r.value.type as string) : 'TIMEOUT'));
    const ringingCount = types.filter((t) => t === 'call_ringing').length;
    const busyCount = types.filter((t) => t === 'call_busy').length;
    expect(ringingCount).toBe(1);
    expect(busyCount).toBe(1);

    const ringingRows = await db.callSession.count({ where: { calleeId: callee.agentId, status: 'RINGING' } });
    expect(ringingRows).toBe(1); // đúng 1 CallSession RINGING, không phải 2.

    wsCaller1.close();
    wsCaller2.close();
  });

  // Nợ độ tin cậy đánh thức cuộc gọi (30/7): callee KHÔNG mở app (không có WS nào) lúc bị mời gọi — phải có
  // push FCM priority CAO best-effort để đánh thức app kịp hiện màn hình nhận cuộc gọi, ngoài broadcastToAgent
  // vốn không gửi được gì khi Set kết nối rỗng.
  it('callee KHÔNG có kết nối WS nào (offline) → gọi sendPushToAgent priority high đúng agentId/data', async () => {
    const caller = await makeTestAgent('Push Caller Offline');
    const callee = await makeTestAgent('Push Callee Offline');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    // Cố ý KHÔNG connect callee — mô phỏng app đã tắt/bị hệ điều hành kill nền.

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    const callId = ringing.callId as string;

    await vi.waitFor(() => expect(sendPushToAgent).toHaveBeenCalledTimes(1));
    const call = vi.mocked(sendPushToAgent).mock.calls[0];
    expect(call[1]).toBe(callee.agentId);
    const payload = call[2];
    expect(payload.priority).toBe('high');
    expect(payload.data).toEqual({
      kind: 'incoming_call',
      callId,
      callerAgentId: String(caller.agentId),
      callerName: 'Push Caller Offline'
    });

    wsCaller.close();
  });

  it('callee ĐANG mở app (có kết nối WS) → KHÔNG gọi sendPushToAgent (tránh double-ring/thông báo thừa)', async () => {
    const caller = await makeTestAgent('Push Caller Online');
    const callee = await makeTestAgent('Push Callee Online');
    await makeFriends(caller.agentId, callee.agentId);
    const wsCaller = await connect(port, caller.sessionId);
    const wsCallee = await connect(port, callee.sessionId);

    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    await waitForMessage(wsCallee, (m) => m.type === 'incoming_call');

    expect(sendPushToAgent).not.toHaveBeenCalled();

    wsCaller.close();
    wsCallee.close();
  });
});

// LANE A Vòng 2 (3/8) — chống spam/DoS call_invite: giới hạn số lời mời/1 caller trong 1 cửa sổ. Test tiêm
// ngưỡng nhỏ (maxInvitesPerWindow=3) + cửa sổ dài (đủ để cả 4 lần rơi trong 1 cửa sổ) qua options.
describe('call-signaling-server — rate-limit call_invite (chống spam/DoS)', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.mocked(sendPushToAgent).mockClear();
    vi.mocked(sendPushToAgent).mockResolvedValue(undefined);
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachCallSignaling(server, {
      ringTimeoutMs: 5000,
      signalingTimeoutMs: 5000,
      maxInvitesPerWindow: 3,
      inviteWindowMs: 60_000
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('caller gửi quá N lời mời trong cửa sổ → lời mời vượt ngưỡng bị chặn call_error RATE_LIMITED', async () => {
    const caller = await makeTestAgent('RateLimit Caller');
    const callee = await makeTestAgent('RateLimit Callee');
    await makeFriends(caller.agentId, callee.agentId);
    const ws = await connect(port, caller.sessionId);

    // Gửi TUẦN TỰ 4 lời mời (không cần connect callee — callee offline vẫn RINGING). Mỗi lời mời nhận đúng 1
    // phản hồi tức thì (call_ringing lần đầu, call_busy các lần sau, hoặc call_error khi vượt ngưỡng).
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      send(ws, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
      const msg = await waitForMessage(
        ws,
        (m) => m.type === 'call_ringing' || m.type === 'call_busy' || m.type === 'call_error'
      );
      outcomes.push(msg.type === 'call_error' ? `call_error:${String(msg.code)}` : (msg.type as string));
    }

    // 3 lần đầu KHÔNG bị rate-limit; lần thứ 4 (vượt ngưỡng 3) PHẢI là call_error RATE_LIMITED.
    expect(outcomes.slice(0, 3).some((o) => o.startsWith('call_error:RATE_LIMITED'))).toBe(false);
    expect(outcomes[3]).toBe('call_error:RATE_LIMITED');

    ws.close();
  });

  it('lời mời TRONG ngưỡng vẫn hoạt động bình thường (KHÔNG chặn nhầm dưới ngưỡng)', async () => {
    const caller = await makeTestAgent('UnderLimit Caller');
    const callee = await makeTestAgent('UnderLimit Callee');
    await makeFriends(caller.agentId, callee.agentId);
    const ws = await connect(port, caller.sessionId);

    send(ws, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    const ringing = await waitForMessage(ws, (m) => m.type === 'call_ringing' || m.type === 'call_error');
    expect(ringing.type).toBe('call_ringing');

    ws.close();
  });
});

describe('call-signaling-server — heartbeat dọn kết nối chết (audit độc lập 30/7 HIGH)', () => {
  let server: http.Server;
  const HEARTBEAT_INTERVAL_MS = 50;

  beforeEach(() => {
    vi.mocked(sendPushToAgent).mockClear();
    vi.mocked(sendPushToAgent).mockResolvedValue(undefined);
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

  it('callee mất mạng đột ngột (không đóng sạch, không bao giờ trả pong) → sweep heartbeat dọn kết nối trong tối đa 2 chu kỳ, lần gọi kế tiếp coi callee offline và gửi push đánh thức', async () => {
    // vi.useFakeTimers() PHẢI bật TRƯỚC attachCallSignaling() — setInterval bên trong nó chạy NGAY lúc gọi,
    // bật fake timer sau sẽ không "chụp lại" được cái interval thật đã tạo trước đó.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const wss = attachCallSignaling(server, {
      ringTimeoutMs: RING_TIMEOUT_MS,
      signalingTimeoutMs: SIGNALING_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const caller = await makeTestAgent('Heartbeat Caller');
    const callee = await makeTestAgent('Heartbeat Callee');
    await makeFriends(caller.agentId, callee.agentId);

    const wsCallee = await connect(port, callee.sessionId);
    // Chờ handleUpgrade() (async, tra DB xong mới addConnection()) chắc chắn hoàn tất trước khi lấy socket
    // server-side tương ứng từ wss.clients — setTimeout thật (KHÔNG bị fake, chỉ setInterval/clearInterval bị fake).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wss.clients.size).toBe(1);
    const serverSideCalleeWs = [...wss.clients][0];
    // Mô phỏng ĐÚNG kịch bản audit nêu: mất mạng không sạch (OS kill app nền/rớt wifi) — chặn ping THẬT gửi ra
    // dây nên client không bao giờ có cơ hội tự trả pong (thư viện `ws` tự động pong khi NHẬN được frame ping
    // thật qua mạng — chặn tại nguồn để giả lập "không bao giờ nhận được ping" chứ không phải "nhận nhưng lờ đi").
    serverSideCalleeWs.ping = vi.fn();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS); // chu kỳ 1: isAlive true→false, gọi ping() (stub).
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS); // chu kỳ 2: vẫn isAlive===false → terminate().
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve)); // flush sự kiện 'close' thật (EventEmitter, không fake) → removeConnection().

    expect(wss.clients.size).toBe(0);

    const wsCaller = await connect(port, caller.sessionId);
    send(wsCaller, { type: 'call_invite', calleeAgentId: callee.agentId, kind: 'VOICE' });
    await waitForMessage(wsCaller, (m) => m.type === 'call_ringing');
    await vi.waitFor(() => expect(sendPushToAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendPushToAgent).mock.calls[0][1]).toBe(callee.agentId);

    wsCaller.close();
  });
});
