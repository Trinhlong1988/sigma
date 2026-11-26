// [Admin Demo 9/9 "sao lại có 2 nhóm Khach Demo SG? gate đâu?"] TRÙNG NHÓM = LỖI TIỀN: bot gắn khách + gửi bill vào
// nhóm A, người ngồi nhóm B ⇒ bill "gửi thành công" mà không ai thấy (ca Khach Demo 8-9/9).
// Bằng chứng thật trong DB: "ĐL- Hà Khach Demo SG" bị tạo 2 LẦN cách 29 GIÂY (26/8 01:11:45 và 01:12:14);
// "ĐL - Quỳnh SG" cũng 2 lần cách 1 phút (1/9 07:02 và 07:03). Trước đây KHÔNG có gate nào chặn.
import { describe, it, expect } from 'vitest';
import { createGroupRoom, ChatServiceError } from '../src/services/chat-room-service.js';

/** Db giả: chỉ đủ cho nhánh gate (list nhóm GROUP còn sống). Tạo mới → ném trước khi chạm create. */
function fakeDb(tenDaCo: string[]) {
  return {
    chatRoom: {
      findMany: async () => tenDaCo.map((name, i) => ({ id: `r${i}`, name, createdAt: new Date('2026-08-26T01:11:45+07:00') })),
      create: async () => { throw new Error('KHÔNG ĐƯỢC TẠO — gate phải chặn trước'); }
    },
    // canMessageAgent tra bạn bè/chặn — cho phép hết để chắc chắn test dừng ở GATE TRÙNG TÊN.
    agentFriendship: { findFirst: async () => ({ status: 'ACCEPTED' }) },
    agentBlock: { findFirst: async () => null }
  } as unknown as Parameters<typeof createGroupRoom>[0];
}

async function tao(db: Parameters<typeof createGroupRoom>[0], ten: string): Promise<string> {
  try { await createGroupRoom(db, 270, ten, [381, 384]); return 'TẠO ĐƯỢC'; }
  catch (e) { return e instanceof ChatServiceError ? `${e.code}: ${e.message}` : `LỖI KHÁC: ${(e as Error).message}`; }
}

describe('gate chống tạo 2 nhóm cùng đại lý', () => {
  it('tạo lại ĐÚNG tên đã có (double-click 29 giây) → CHẶN', async () => {
    const r = await tao(fakeDb(['ĐL- Hà Khach Demo SG']), 'ĐL- Hà Khach Demo SG');
    expect(r).toContain('DUPLICATE_GROUP_NAME');
    expect(r).toContain('ĐL- Hà Khach Demo SG');
  });

  it('tên LỆCH DẤU / hoa-thường / khoảng trắng vẫn bị coi là trùng', async () => {
    for (const ten of ['ĐL - HÀ QUỐC HUY SG', 'DL- Ha Quoc Huy  SG', 'ĐL-Hà Khach Demo SG']) {
      expect(await tao(fakeDb(['ĐL- Hà Khach Demo SG']), ten), ten).toContain('DUPLICATE_GROUP_NAME');
    }
  });

  it('tên KHÁC đại lý → vẫn tạo bình thường (không chặn oan)', async () => {
    const r = await tao(fakeDb(['ĐL- Hà Khach Demo SG']), 'ĐL - Lộc SG');
    expect(r).not.toContain('DUPLICATE_GROUP_NAME');
  });

  it('nhóm THƯỜNG (không phải nhóm đại lý) trùng tên → KHÔNG chặn (chỉ siết nhóm gắn khách/nhận bill)', async () => {
    const r = await tao(fakeDb(['Nhóm nội bộ']), 'Nhóm nội bộ');
    expect(r).not.toContain('DUPLICATE_GROUP_NAME');
  });
});
