// LỌC BOT SIGMA khỏi Tìm bạn / Danh bạ (Admin Demo) — bot hệ thống Agent.code='SIGMA_BOT' (investor-crosspost-
// service.ts seed) KHÔNG được hiện ở tra cứu mã/email/SĐT, gửi lời mời, hay danh sách bạn bè; NHƯNG VẪN là
// thành viên phòng chat. Chạy trên throwaway Postgres THẬT (global-setup.ts). Điểm mấu chốt chống hồi quy:
// agent có code=NULL KHÔNG bị nuốt (lọc app-level, không SQL 3-trị `NOT code='SIGMA_BOT'`).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { lookupAgentByCode, lookupAgentByEmailOrPhone, sendFriendRequest, listFriends } from '../src/friend-service.js';
import { SIGMA_BOT_CODE } from '../src/investor-crosspost-service.js';
import { makeAgent, makeFriends, makeChatRoom, makeChatRoomMember } from './fixtures.js';

/** Đảm bảo bot SigMa tồn tại (idempotent theo code @unique) + đặt email/phone khi cần cho test tra cứu. */
async function ensureBot(opts: { email?: string; phone?: string } = {}) {
  const db = getBotDb();
  return db.agent.upsert({
    where: { code: SIGMA_BOT_CODE },
    update: { name: 'SigMa', email: opts.email ?? undefined, phone: opts.phone ?? undefined },
    create: { code: SIGMA_BOT_CODE, name: 'SigMa', email: opts.email, phone: opts.phone }
  });
}

describe('friend-service — ẩn bot SigMa khỏi tìm bạn/danh bạ', () => {
  it('lookupAgentByCode gõ đúng mã SIGMA_BOT → AGENT_NOT_FOUND (bot ẩn)', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    await ensureBot();
    const r = await lookupAgentByCode(db, me.id, SIGMA_BOT_CODE);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('AGENT_NOT_FOUND');
  });

  it('lookupAgentByEmailOrPhone theo EMAIL của bot → AGENT_NOT_FOUND', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const botEmail = `alphabot_${Date.now()}@bot.test`;
    await ensureBot({ email: botEmail });
    const r = await lookupAgentByEmailOrPhone(db, me.id, botEmail);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('AGENT_NOT_FOUND');
  });

  it('lookupAgentByEmailOrPhone theo SĐT: bot bị lọc, NHƯNG agent code=NULL cùng SĐT KHÔNG bị nuốt', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const phone = `09${Date.now().toString().slice(-8)}`; // 10 số, khớp buildPhoneSearchVariants dạng 0xxx
    const bot = await ensureBot({ phone });
    // Agent có code = NULL (cột nullable) — nếu lọc bằng SQL `NOT code='SIGMA_BOT'` thì điều kiện 3-trị sẽ
    // NUỐT luôn hàng này (NULL != 'SIGMA_BOT' → UNKNOWN → loại). Lọc app-level PHẢI giữ lại nó.
    const nullCodeAgent = await db.agent.create({ data: { code: null, name: 'Không mã', phone } });

    const r = await lookupAgentByEmailOrPhone(db, me.id, phone);
    expect(r.ok).toBe(true);
    const arr = (r as { data: { id: number }[] }).data;
    expect(arr.some((a) => a.id === bot.id)).toBe(false); // bot SigMa ẩn
    expect(arr.some((a) => a.id === nullCodeAgent.id)).toBe(true); // code=NULL KHÔNG bị nuốt
  });

  it('sendFriendRequest tới bot SigMa → AGENT_NOT_FOUND (không gửi được lời mời cho bot)', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const bot = await ensureBot();
    const r = await sendFriendRequest(db, me.id, bot.id);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('AGENT_NOT_FOUND');
  });

  it('listFriends: bot SigMa (dù có quan hệ) KHÔNG hiện; bạn thường VẪN hiện', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const normalFriend = await makeAgent();
    const bot = await ensureBot();
    await makeFriends(me.id, normalFriend.id);
    await makeFriends(me.id, bot.id); // quan hệ bất thường với bot — để khẳng định bị lọc khỏi danh bạ
    const res = await listFriends(db, me.id);
    expect(res.friends.some((f) => f.agentId === bot.id)).toBe(false);
    expect(res.friends.some((f) => f.agentId === normalFriend.id)).toBe(true);
  });

  it('bot SigMa VẪN là thành viên phòng chat (lọc danh bạ KHÔNG đụng thành viên phòng)', async () => {
    const db = getBotDb();
    const bot = await ensureBot();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, bot.id);
    const members = await db.chatRoomMember.findMany({ where: { roomId: room.id, leftAt: null } });
    expect(members.some((m) => m.agentId === bot.id)).toBe(true);
  });
});
