// SIGMA Phase 4 (30/7) — test call-session-service.ts (state machine THUẦN, không WebSocket). Xem
// test/call-signaling-server.test.ts cho test giao thức WS đầy đủ (invite→ring→accept/reject→offer/answer/
// ICE→end, timeout) — file này CHỈ test đúng phạm vi state machine DB (transition hợp lệ/race/lịch sử/sweep).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import {
  CallServiceError,
  createInvite,
  getCallHistoryForAgent,
  isTerminalStatus,
  markAccepted,
  markCancelled,
  markEnded,
  markFailed,
  markRejected,
  markTimeout,
  sweepStaleAcceptedCalls
} from '../src/call-session-service.js';

async function makeAgent(name: string): Promise<number> {
  const db = getBotDb();
  const agent = await db.agent.create({ data: { name } });
  return agent.id;
}

describe('call-session-service — createInvite', () => {
  it('tạo call RINGING với callerId/calleeId/kind đúng', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller A');
    const callee = await makeAgent('Callee A');
    const call = await createInvite(db, caller, callee, 'VOICE');
    expect(call.status).toBe('RINGING');
    expect(call.callerId).toBe(caller);
    expect(call.calleeId).toBe(callee);
    expect(call.kind).toBe('VOICE');
    expect(call.acceptedAt).toBeNull();
    expect(call.endedAt).toBeNull();
  });

  it('callerId === calleeId → CallServiceError VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent('Self Call');
    await expect(createInvite(db, a, a, 'VOICE')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('kind khác VOICE/VIDEO → CallServiceError VALIDATION', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller Kind');
    const callee = await makeAgent('Callee Kind');
    // @ts-expect-error — cố ý truyền kind sai để test validation runtime (không chỉ dựa vào type-check).
    await expect(createInvite(db, caller, callee, 'AUDIO')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('callerId/calleeId không phải số nguyên dương → CallServiceError VALIDATION', async () => {
    const db = getBotDb();
    await expect(createInvite(db, -1, 5, 'VOICE')).rejects.toBeInstanceOf(CallServiceError);
    await expect(createInvite(db, 1.5, 5, 'VOICE')).rejects.toBeInstanceOf(CallServiceError);
  });
});

describe('call-session-service — transitions hợp lệ', () => {
  it('RINGING → ACCEPTED → ENDED, durationSec tính từ acceptedAt', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller B');
    const callee = await makeAgent('Callee B');
    const call = await createInvite(db, caller, callee, 'VIDEO');

    const accepted = await markAccepted(db, call.id);
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.acceptedAt).not.toBeNull();

    const ended = await markEnded(db, call.id, 'NORMAL');
    expect(ended.status).toBe('ENDED');
    expect(ended.endReason).toBe('NORMAL');
    expect(ended.durationSec).not.toBeNull();
    expect(ended.durationSec).toBeGreaterThanOrEqual(0);
  });

  it('RINGING → REJECTED (callee từ chối)', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller C');
    const callee = await makeAgent('Callee C');
    const call = await createInvite(db, caller, callee, 'VOICE');
    const rejected = await markRejected(db, call.id, 'BAN');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.endReason).toBe('BAN');
    expect(rejected.endedAt).not.toBeNull();
  });

  it('RINGING → CANCELLED (caller tự hủy)', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller D');
    const callee = await makeAgent('Callee D');
    const call = await createInvite(db, caller, callee, 'VOICE');
    const cancelled = await markCancelled(db, call.id);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('RINGING → MISSED (hết giờ đổ chuông)', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller E');
    const callee = await makeAgent('Callee E');
    const call = await createInvite(db, caller, callee, 'VOICE');
    const missed = await markTimeout(db, call.id);
    expect(missed.status).toBe('MISSED');
    expect(missed.endReason).toBe('RING_TIMEOUT');
  });

  it('ACCEPTED → FAILED (lỗi giao thức sau khi đã nghe máy)', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller F');
    const callee = await makeAgent('Callee F');
    const call = await createInvite(db, caller, callee, 'VOICE');
    await markAccepted(db, call.id);
    const failed = await markFailed(db, call.id, 'SIGNALING_TIMEOUT');
    expect(failed.status).toBe('FAILED');
    expect(failed.endReason).toBe('SIGNALING_TIMEOUT');
  });

  it('RINGING → FAILED (lỗi giao thức trước khi nghe máy)', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller G');
    const callee = await makeAgent('Callee G');
    const call = await createInvite(db, caller, callee, 'VOICE');
    const failed = await markFailed(db, call.id, 'WS_ERROR');
    expect(failed.status).toBe('FAILED');
  });
});

describe('call-session-service — transitions KHÔNG hợp lệ (race/trạng thái sai)', () => {
  it('markAccepted 2 lần → lần 2 CallServiceError INVALID_STATE (chống race callee bấm 2 lần/2 thiết bị)', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller H');
    const callee = await makeAgent('Callee H');
    const call = await createInvite(db, caller, callee, 'VOICE');
    await markAccepted(db, call.id);
    await expect(markAccepted(db, call.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('markAccepted SAU KHI đã REJECTED → INVALID_STATE (callee từ chối rồi bấm nghe từ thiết bị khác)', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller I');
    const callee = await makeAgent('Callee I');
    const call = await createInvite(db, caller, callee, 'VOICE');
    await markRejected(db, call.id);
    await expect(markAccepted(db, call.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('markEnded khi CÒN RINGING (chưa accept) → INVALID_STATE', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Caller J');
    const callee = await makeAgent('Callee J');
    const call = await createInvite(db, caller, callee, 'VOICE');
    await expect(markEnded(db, call.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('callId không tồn tại → CALL_NOT_FOUND', async () => {
    const db = getBotDb();
    await expect(markAccepted(db, 'khong-ton-tai')).rejects.toMatchObject({ code: 'CALL_NOT_FOUND' });
  });
});

describe('call-session-service — isTerminalStatus', () => {
  it('phân loại đúng trạng thái cuối/chưa cuối', () => {
    expect(isTerminalStatus('RINGING')).toBe(false);
    expect(isTerminalStatus('ACCEPTED')).toBe(false);
    expect(isTerminalStatus('ENDED')).toBe(true);
    expect(isTerminalStatus('REJECTED')).toBe(true);
    expect(isTerminalStatus('CANCELLED')).toBe(true);
    expect(isTerminalStatus('MISSED')).toBe(true);
    expect(isTerminalStatus('FAILED')).toBe(true);
  });
});

describe('call-session-service — getCallHistoryForAgent', () => {
  it('trả cả cuộc gọi ĐI và ĐẾN của 1 agent, mới nhất trước', async () => {
    const db = getBotDb();
    const a = await makeAgent('History A');
    const b = await makeAgent('History B');
    const c = await makeAgent('History C');
    const call1 = await createInvite(db, a, b, 'VOICE'); // a gọi đi
    await markCancelled(db, call1.id);
    const call2 = await createInvite(db, c, a, 'VIDEO'); // a nhận cuộc gọi
    await markRejected(db, call2.id);

    const history = await getCallHistoryForAgent(db, { agentId: a });
    const ids = history.map((h) => h.id);
    expect(ids).toContain(call1.id);
    expect(ids).toContain(call2.id);
    // mới nhất trước — call2 tạo SAU call1.
    expect(ids.indexOf(call2.id)).toBeLessThan(ids.indexOf(call1.id));
  });

  it('agentId không liên quan → không thấy trong lịch sử người khác', async () => {
    const db = getBotDb();
    const a = await makeAgent('History D');
    const b = await makeAgent('History E');
    const outsider = await makeAgent('History Outsider');
    const call = await createInvite(db, a, b, 'VOICE');

    const history = await getCallHistoryForAgent(db, { agentId: outsider });
    expect(history.map((h) => h.id)).not.toContain(call.id);
  });

  it('agentId không phải số nguyên dương → CallServiceError VALIDATION', async () => {
    const db = getBotDb();
    await expect(getCallHistoryForAgent(db, { agentId: -5 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('call-session-service — sweepStaleAcceptedCalls (an toàn 4h)', () => {
  it('call ACCEPTED quá hạn maxAgeMs → tự đóng ENDED/SAFETY_TIMEOUT', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Sweep Caller A');
    const callee = await makeAgent('Sweep Callee A');
    const call = await createInvite(db, caller, callee, 'VOICE');
    await markAccepted(db, call.id);
    // Đẩy acceptedAt về quá khứ xa (giả lập "đã ACCEPTED từ lâu") — ghi thẳng DB, KHÔNG có API public nào
    // cho việc này (đúng — sweep chỉ nên chạy tự động, test cần "làm giả thời gian" để không phải chờ 4h thật).
    await db.callSession.update({ where: { id: call.id }, data: { acceptedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) } });

    const closed = await sweepStaleAcceptedCalls(db, 4 * 60 * 60 * 1000);
    expect(closed).toBe(1);
    const row = await db.callSession.findUniqueOrThrow({ where: { id: call.id } });
    expect(row.status).toBe('ENDED');
    expect(row.endReason).toBe('SAFETY_TIMEOUT');
  });

  it('call ACCEPTED CHƯA quá hạn → KHÔNG bị đóng', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Sweep Caller B');
    const callee = await makeAgent('Sweep Callee B');
    const call = await createInvite(db, caller, callee, 'VOICE');
    await markAccepted(db, call.id);

    const closed = await sweepStaleAcceptedCalls(db, 4 * 60 * 60 * 1000);
    expect(closed).toBe(0);
    const row = await db.callSession.findUniqueOrThrow({ where: { id: call.id } });
    expect(row.status).toBe('ACCEPTED');
  });

  it('call RINGING (chưa accept) dù cũ vẫn KHÔNG bị sweep đụng tới (sweep chỉ nhắm ACCEPTED)', async () => {
    const db = getBotDb();
    const caller = await makeAgent('Sweep Caller C');
    const callee = await makeAgent('Sweep Callee C');
    const call = await createInvite(db, caller, callee, 'VOICE');
    await db.callSession.update({ where: { id: call.id }, data: { startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) } });

    await sweepStaleAcceptedCalls(db, 4 * 60 * 60 * 1000);
    const row = await db.callSession.findUniqueOrThrow({ where: { id: call.id } });
    expect(row.status).toBe('RINGING');
  });
});
