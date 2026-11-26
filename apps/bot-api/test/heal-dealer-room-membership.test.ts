// [Admin Demo 9/9 — "làm triệt để, cấm tái diễn với các trường hợp khác"] Self-heal nhóm đại lý phải phủ CẢ 3 lỗ đã lọt:
//   (1) bot GHI (SupportAlpha) vắng nhóm → doanh số rơi câm (ca 4 đại lý 6/9 — đã có),
//   (2) bot GỬI (SIGMA_BOT) vắng nhóm → bill KHÔNG đăng vào nhóm (ca "ĐL - Mạnh HN" phát hiện 9/9),
//   (3) nhóm CHỈ CÓ BOT, 0 người thật → bill gửi vào KHÔNG AI THẤY (ca "ĐL- Hà Khach Demo SG" 8-9/9).
// Db GIẢ trong RAM (không đụng DB thật) — khẳng định hành vi, không phải "suite xanh nên chắc ổn".
import { describe, it, expect } from 'vitest';
import { healSupportBotDealerGroupMembership } from '../src/zalo-bill-support.js';

interface Mem { roomId: string; agentId: number; leftAt: Date | null }
function fakeDb(opts: { members: Mem[]; rooms: { id: string; name: string }[] }) {
  const members = [...opts.members];
  const agents = [
    { id: 413, code: 'SUPPORT_ALPHA' }, { id: 412, code: 'SIGMA_BOT' },
    { id: 270, code: 'DL22' }, { id: 381, code: 'DL62' }
  ];
  return {
    agent: {
      findFirst: async ({ where }: { where: { code?: string } }) => agents.find((a) => a.code === where.code) ?? null,
      findMany: async ({ where }: { where: { id: { in: number[] }; code?: { notIn: string[] } } }) =>
        agents.filter((a) => where.id.in.includes(a.id) && (!where.code || !where.code.notIn.includes(a.code))),
      upsert: async () => ({ id: 413, avatarImageMime: 'image/png' }),
      create: async () => ({ id: 413 }),
      update: async () => ({ id: 413 })
    },
    customerChatGroup: { findMany: async () => opts.rooms.map((r) => ({ roomId: r.id })) },
    chatRoom: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => opts.rooms.filter((r) => where.id.in.includes(r.id))
    },
    chatRoomMember: {
      findMany: async ({ where }: { where: { agentId?: number; roomId?: { in: string[] } | string; leftAt: null } }) =>
        members.filter((m) => m.leftAt === null
          && (where.agentId === undefined || m.agentId === where.agentId)
          && (where.roomId === undefined || (typeof where.roomId === 'string' ? m.roomId === where.roomId : where.roomId.in.includes(m.roomId)))),
      upsert: async ({ where }: { where: { roomId_agentId: { roomId: string; agentId: number } } }) => {
        const k = where.roomId_agentId;
        const co = members.find((m) => m.roomId === k.roomId && m.agentId === k.agentId);
        if (co) co.leftAt = null; else members.push({ ...k, leftAt: null });
        return {};
      }
    },
    __members: members
  } as unknown as Parameters<typeof healSupportBotDealerGroupMembership>[0] & { __members: Mem[] };
}

describe('self-heal nhóm đại lý', () => {
  it('thiếu bot GỬI (SIGMA_BOT) → tự thêm lại + nêu tên nhóm', async () => {
    const db = fakeDb({
      rooms: [{ id: 'r-manh', name: 'ĐL - Mạnh HN - Chờ' }],
      members: [{ roomId: 'r-manh', agentId: 413, leftAt: null }, { roomId: 'r-manh', agentId: 270, leftAt: null }]
    });
    const r = await healSupportBotDealerGroupMembership(db);
    expect(r.healedSendBot).toEqual(['r-manh']);
    expect(r.roomsKhongNguoi).toEqual([]);
  });

  it('nhóm CHỈ CÓ BOT → báo tên nhóm (không hàn câm, không tự thêm người)', async () => {
    const db = fakeDb({
      rooms: [{ id: 'r-huy', name: 'ĐL- Hà Khach Demo SG' }],
      members: [{ roomId: 'r-huy', agentId: 413, leftAt: null }, { roomId: 'r-huy', agentId: 412, leftAt: null }]
    });
    const r = await healSupportBotDealerGroupMembership(db);
    expect(r.roomsKhongNguoi).toEqual([{ roomId: 'r-huy', name: 'ĐL- Hà Khach Demo SG' }]);
    expect(r.healedSendBot).toEqual([]);
  });

  it('nhóm đủ 2 bot + có người → im lặng hoàn toàn', async () => {
    const db = fakeDb({
      rooms: [{ id: 'r-ok', name: 'ĐL- Mr Nguyễn SG' }],
      members: [
        { roomId: 'r-ok', agentId: 413, leftAt: null }, { roomId: 'r-ok', agentId: 412, leftAt: null },
        { roomId: 'r-ok', agentId: 270, leftAt: null }, { roomId: 'r-ok', agentId: 381, leftAt: null }
      ]
    });
    const r = await healSupportBotDealerGroupMembership(db);
    expect(r).toMatchObject({ healed: 0, healedSendBot: [], roomsKhongNguoi: [] });
  });

  it('thiếu CẢ bot ghi lẫn bot gửi → hàn cả hai', async () => {
    const db = fakeDb({ rooms: [{ id: 'r-x', name: 'ĐL - X' }], members: [{ roomId: 'r-x', agentId: 270, leftAt: null }] });
    const r = await healSupportBotDealerGroupMembership(db);
    expect(r.healedRoomIds).toEqual(['r-x']);
    expect(r.healedSendBot).toEqual(['r-x']);
  });
});
