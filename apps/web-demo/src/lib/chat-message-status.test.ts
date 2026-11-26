// Regression THUẦN (environment node, không render) cho 3 bug chat 5/8 (Admin Demo): tin gửi hiện ngay (append
// lạc quan + hòa giải WS echo), số chưa đọc clear (markRead gating), tick trạng thái đã gửi/đã đọc.
import { describe, expect, it } from 'vitest';
import { computeMineDisplayStatus, reconcileSentMessage, shouldMarkRoomRead, shouldAutoReadIncomingMessage } from './chat-message-status';
import type { ChatMessage } from '../mock-data/types';

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage {
  return {
    roomId: 'room-1',
    senderId: '10',
    senderName: '',
    type: 'text',
    text: 'hi',
    time: '12:00',
    status: 'sent',
    ...partial
  } as ChatMessage;
}

describe('#12 — shouldAutoReadIncomingMessage (auto-đọc CHỈ khi app đang hiển thị)', () => {
  it('tin người khác + app FOREGROUND → auto-đọc (giữ 0 kiểu Zalo)', () => {
    expect(shouldAutoReadIncomingMessage(false, false)).toBe(true);
  });
  it('BUG #12: tin người khác + app Ở NỀN (bấm HOME, phòng vẫn mở) → KHÔNG auto-đọc (giữ unread)', () => {
    expect(shouldAutoReadIncomingMessage(false, true)).toBe(false);
  });
  it('tin CỦA MÌNH → không tính (dù foreground)', () => {
    expect(shouldAutoReadIncomingMessage(true, false)).toBe(false);
  });
  it('tin của mình + nền → không tính', () => {
    expect(shouldAutoReadIncomingMessage(true, true)).toBe(false);
  });
});

describe('Bug #3 — computeMineDisplayStatus (tick đã gửi/đã đọc)', () => {
  const t = (iso: string) => new Date(iso).getTime();

  it('tin của mình + người kia đã đọc TỚI/QUA mốc → "seen" (2 tick xanh)', () => {
    const m = msg({ id: 'a', mine: true, status: 'sent', sentAtIso: '2026-08-05T10:00:00.000Z' });
    expect(computeMineDisplayStatus(m, t('2026-08-05T10:00:00.000Z'))).toBe('seen'); // đúng mốc (≤)
    expect(computeMineDisplayStatus(m, t('2026-08-05T10:05:00.000Z'))).toBe('seen'); // đọc tin mới hơn
  });

  it('tin của mình gửi SAU mốc đọc của người kia → giữ "sent" (1 tick)', () => {
    const m = msg({ id: 'a', mine: true, status: 'sent', sentAtIso: '2026-08-05T10:10:00.000Z' });
    expect(computeMineDisplayStatus(m, t('2026-08-05T10:00:00.000Z'))).toBe('sent');
  });

  it('peerReadAtMs null (nhóm/chưa có dữ liệu) → không nâng lên seen', () => {
    const m = msg({ id: 'a', mine: true, status: 'sent', sentAtIso: '2026-08-05T10:00:00.000Z' });
    expect(computeMineDisplayStatus(m, null)).toBe('sent');
  });

  it('người kia ONLINE (delivered) nhưng CHƯA đọc → "delivered" (2 tick xám)', () => {
    const m = msg({ id: 'a', mine: true, status: 'sent', sentAtIso: '2026-08-05T10:00:00.000Z' });
    // peerReadAtMs null (chưa đọc) + peerDeliveredAtMs ≥ sentAt → delivered
    expect(computeMineDisplayStatus(m, null, t('2026-08-05T10:00:05.000Z'))).toBe('delivered');
  });

  it('offline (peerDeliveredAtMs null) → giữ "sent" (1 tick)', () => {
    const m = msg({ id: 'a', mine: true, status: 'sent', sentAtIso: '2026-08-05T10:00:00.000Z' });
    expect(computeMineDisplayStatus(m, null, null)).toBe('sent');
  });

  it('đã đọc ƯU TIÊN hơn đã nhận: seen thắng delivered khi cả 2 mốc đều qua', () => {
    const m = msg({ id: 'a', mine: true, status: 'sent', sentAtIso: '2026-08-05T10:00:00.000Z' });
    expect(computeMineDisplayStatus(m, t('2026-08-05T10:10:00.000Z'), t('2026-08-05T10:05:00.000Z'))).toBe('seen');
  });

  it('tin gửi SAU mốc delivered (peer online lúc cũ, tin mới hơn) → vẫn "sent" cho tới delivery-receipt mới', () => {
    const m = msg({ id: 'a', mine: true, status: 'sent', sentAtIso: '2026-08-05T10:10:00.000Z' });
    expect(computeMineDisplayStatus(m, null, t('2026-08-05T10:00:00.000Z'))).toBe('sent');
  });

  it('GIỮ NGUYÊN trạng thái lạc quan (Bug #1): sending/failed KHÔNG bị đổi thành seen dù mốc đã qua', () => {
    const sending = msg({ id: 'a', mine: true, status: 'sending', sentAtIso: '2026-08-05T10:00:00.000Z' });
    const failed = msg({ id: 'b', mine: true, status: 'failed', sentAtIso: '2026-08-05T10:00:00.000Z' });
    expect(computeMineDisplayStatus(sending, t('2026-08-05T11:00:00.000Z'))).toBe('sending');
    expect(computeMineDisplayStatus(failed, t('2026-08-05T11:00:00.000Z'))).toBe('failed');
  });

  it('tin KHÔNG phải của mình / tin hệ thống → giữ nguyên status', () => {
    const other = msg({ id: 'a', mine: false, status: 'sent', sentAtIso: '2026-08-05T10:00:00.000Z' });
    const system = msg({ id: 'b', mine: true, type: 'system', status: 'sent', sentAtIso: '2026-08-05T10:00:00.000Z' });
    expect(computeMineDisplayStatus(other, t('2026-08-05T11:00:00.000Z'))).toBe('sent');
    expect(computeMineDisplayStatus(system, t('2026-08-05T11:00:00.000Z'))).toBe('sent');
  });
});

describe('Bug #1 — reconcileSentMessage (append lạc quan + hòa giải WS echo)', () => {
  it('trường hợp thường: thay bong bóng lạc quan bằng tin thật, KHÔNG còn id pending', () => {
    const prev = [msg({ id: 'x1' }), msg({ id: 'pending-2', mine: true, status: 'sending' })];
    const real = msg({ id: 'real-2', mine: true, status: 'sent' });
    const next = reconcileSentMessage(prev, 'pending-2', real);
    expect(next.map((m) => m.id)).toEqual(['x1', 'real-2']);
    expect(next.some((m) => m.id === 'pending-2')).toBe(false);
  });

  it('WS echo tới TRƯỚC (tin thật đã có): chỉ bỏ bong bóng lạc quan, KHÔNG nhân đôi', () => {
    const prev = [msg({ id: 'pending-2', mine: true, status: 'sending' }), msg({ id: 'real-2', mine: true, status: 'sent' })];
    const real = msg({ id: 'real-2', mine: true, status: 'sent' });
    const next = reconcileSentMessage(prev, 'pending-2', real);
    expect(next.map((m) => m.id)).toEqual(['real-2']);
    expect(next.filter((m) => m.id === 'real-2')).toHaveLength(1);
  });

  it('KHÔNG mutate mảng gốc', () => {
    const prev = [msg({ id: 'pending-2', mine: true, status: 'sending' })];
    reconcileSentMessage(prev, 'pending-2', msg({ id: 'real-2' }));
    expect(prev.map((m) => m.id)).toEqual(['pending-2']);
  });
});

describe('Bug #2 — shouldMarkRoomRead (điều kiện đánh dấu đã đọc)', () => {
  it('id server thật + khác mốc đã đánh dấu → true', () => {
    expect(shouldMarkRoomRead('cuid-real', null)).toBe(true);
    expect(shouldMarkRoomRead('cuid-real', 'cuid-cu')).toBe(true);
  });

  it('cùng mốc đã đánh dấu gần nhất → false (chống gọi lặp thừa)', () => {
    expect(shouldMarkRoomRead('cuid-real', 'cuid-real')).toBe(false);
  });

  it('id lạc quan/mock cục bộ (pending-/local-/fwd-) → false (chưa có id server để markRead)', () => {
    expect(shouldMarkRoomRead('pending-5', null)).toBe(false);
    expect(shouldMarkRoomRead('local-9', null)).toBe(false);
    expect(shouldMarkRoomRead('fwd-3', null)).toBe(false);
  });

  it('không có messageId → false', () => {
    expect(shouldMarkRoomRead(undefined, null)).toBe(false);
    expect(shouldMarkRoomRead('', null)).toBe(false);
  });
});
