// LANE C Vòng 2 (3/8) — B124 BẤT BIẾN room↔khách cho DESKTOP (apps/desktop/src/main/chat-room-tid-service.ts
// linkTidToRoomForDelivery). File test này SỐNG Ở apps/bot-api/test vì đây là nơi DUY NHẤT trong repo có sẵn
// hạ tầng "vitest + Postgres THẬT throwaway" (global-setup.ts, cùng khuôn selftest-pg) — apps/desktop chỉ có
// vitest pure-unit KHÔNG có DB. Service desktop nhận `db` qua tham số (DI) + chỉ import type `@sigma/database`
// (erase lúc build) nên chạy được thẳng với Prisma client thật của harness này. GHI RÕ (không giấu): đây là
// test-selftest-pg cho code desktop, đặt nhờ harness bot-api — KHÔNG phải 1 trong 7 file vitest pure-unit của
// apps/desktop.
//
// Tình huống SAI phải tái hiện (Admin Demo): nhân sự GIỮ chatRoomId CŨ khi đổi customerId → gắn TID của khách MỚI
// nhầm vào phòng của khách CŨ (lớp "cướp doanh số theo giai đoạn"). + auto-move soft-unlink, idempotent, P2002 race.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeChatRoom, makeChatRoomMember, makeTid } from './fixtures.js';
// eslint-disable-next-line import/no-relative-packages
import { linkTidToRoomForDelivery } from '../../desktop/src/main/chat-room-tid-service.js';

let custSeq = 0;
async function makeCustomer(agentId: number | null) {
  const db = getBotDb();
  custSeq += 1;
  const tag = `${Date.now()}_${custSeq}`;
  return db.customer.create({
    data: { code: `KHtest_${tag}`, fullName: `Khach ${tag}`, nickname: `KH${tag}`, agentId: agentId ?? undefined }
  });
}

async function countActiveLinks(tidId: number): Promise<number> {
  return getBotDb().chatRoomTid.count({ where: { tidId, unlinkedAt: null } });
}

describe('desktop linkTidToRoomForDelivery — BẤT BIẾN room↔khách (B124)', () => {
  it('CASE ĐÚNG: phòng thuộc đúng khách (Customer.agentId là thành viên) → gắn thành công, 1 hàng active', async () => {
    const db = getBotDb();
    const agentA = await makeAgent();
    const cust = await makeCustomer(agentA.id);
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, agentA.id);
    const tid = await makeTid({ agentId: agentA.id });

    const r = await linkTidToRoomForDelivery(db, tid.id, room.id, cust.id);
    expect(r.moved).toBe(false);
    expect(r.previousRoomId).toBeNull();
    expect(await countActiveLinks(tid.id)).toBe(1);
  });

  it('CHẶN gắn nhầm PHÒNG KHÁCH KHÁC: nhân sự giữ chatRoomId cũ (phòng khách A) khi giao cho khách B → THROW, 0 hàng', async () => {
    const db = getBotDb();
    const agentA = await makeAgent();
    const agentB = await makeAgent();
    const custA = await makeCustomer(agentA.id);
    const custB = await makeCustomer(agentB.id);
    // Phòng của khách A (agentA là thành viên) — KHÔNG có agentB.
    const roomOfA = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(roomOfA.id, agentA.id);
    const tidForB = await makeTid({ agentId: agentB.id });
    void custA;

    // Giao TID cho khách B nhưng form còn giữ roomId của khách A → PHẢI bị chặn.
    await expect(linkTidToRoomForDelivery(db, tidForB.id, roomOfA.id, custB.id)).rejects.toThrow(/KHÔNG thuộc khách hàng/);
    expect(await countActiveLinks(tidForB.id)).toBe(0);
  });

  it('CHẶN khi khách CHƯA gắn đại lý (Customer.agentId null) → THROW, 0 hàng', async () => {
    const db = getBotDb();
    const agentA = await makeAgent();
    const custNoAgent = await makeCustomer(null);
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, agentA.id);
    const tid = await makeTid({ agentId: agentA.id });

    await expect(linkTidToRoomForDelivery(db, tid.id, room.id, custNoAgent.id)).rejects.toThrow(/chưa gắn đại lý/);
    expect(await countActiveLinks(tid.id)).toBe(0);
  });

  it('AUTO-MOVE soft-unlink: cùng khách có 2 phòng, chuyển TID R1→R2 → 1 hàng active mới, hàng cũ soft-unlinked', async () => {
    const db = getBotDb();
    const agentA = await makeAgent();
    const cust = await makeCustomer(agentA.id);
    const r1 = await makeChatRoom({ type: 'GROUP' });
    const r2 = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(r1.id, agentA.id);
    await makeChatRoomMember(r2.id, agentA.id);
    const tid = await makeTid({ agentId: agentA.id });

    await linkTidToRoomForDelivery(db, tid.id, r1.id, cust.id);
    const moved = await linkTidToRoomForDelivery(db, tid.id, r2.id, cust.id);
    expect(moved.moved).toBe(true);
    expect(moved.previousRoomId).toBe(r1.id);
    expect(await countActiveLinks(tid.id)).toBe(1);
    // Hàng active còn lại phải trỏ r2; hàng r1 phải còn tồn tại nhưng đã unlinked (giữ lịch sử doanh số).
    const active = await db.chatRoomTid.findFirst({ where: { tidId: tid.id, unlinkedAt: null } });
    expect(active?.roomId).toBe(r2.id);
    const oldRow = await db.chatRoomTid.findFirst({ where: { tidId: tid.id, roomId: r1.id } });
    expect(oldRow?.unlinkedAt).not.toBeNull();
  });

  it('IDEMPOTENT cùng phòng: gắn LẠI đúng phòng đang gắn → moved:false, KHÔNG tạo hàng thừa (vẫn 1 active)', async () => {
    const db = getBotDb();
    const agentA = await makeAgent();
    const cust = await makeCustomer(agentA.id);
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, agentA.id);
    const tid = await makeTid({ agentId: agentA.id });

    await linkTidToRoomForDelivery(db, tid.id, room.id, cust.id);
    const again = await linkTidToRoomForDelivery(db, tid.id, room.id, cust.id);
    expect(again.moved).toBe(false);
    expect(again.previousRoomId).toBeNull();
    expect(await countActiveLinks(tid.id)).toBe(1);
  });

  it('CONCURRENCY (DB thật): 2 giao dịch ĐỒNG THỜI gắn cùng TID vào 2 phòng của CÙNG khách → LUÔN đúng 1 hàng active, KHÔNG ghi trùng, KHÔNG lỗi Prisma thô', async () => {
    const db = getBotDb();
    const agentA = await makeAgent();
    const cust = await makeCustomer(agentA.id);
    const r1 = await makeChatRoom({ type: 'GROUP' });
    const r2 = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(r1.id, agentA.id);
    await makeChatRoomMember(r2.id, agentA.id);
    const tid = await makeTid({ agentId: agentA.id });

    const results = await Promise.allSettled([
      linkTidToRoomForDelivery(db, tid.id, r1.id, cust.id),
      linkTidToRoomForDelivery(db, tid.id, r2.id, cust.id)
    ]);
    // BẤT BIẾN toàn vẹn: dù 2 giao dịch resolve theo P2002 (partial unique index chat_room_tids_tid_id_active_key
    // chặn hàng active thứ 2) HAY theo auto-move (bên đến sau thấy hàng bên trước → soft-unlink rồi tạo mới), kết
    // quả CUỐI luôn ĐÚNG 1 hàng active — KHÔNG BAO GIỜ 2 hàng active cùng lúc (không đếm doanh số 2 nơi).
    expect(await countActiveLinks(tid.id)).toBe(1);
    // Nếu có lời gọi bị từ chối, PHẢI là lỗi nghiệp vụ rõ nghĩa "thử lại" — KHÔNG để lỗi Prisma nội bộ (P2002) lọt ra.
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    for (const r of rejected) {
      expect(String(r.reason)).toMatch(/thử lại/);
      expect(String(r.reason)).not.toMatch(/P2002|PrismaClient/);
    }
  });

  it('P2002 MAPPING (deterministic, fake db faithful): create ném {code:P2002} → THROW lỗi "thử lại" rõ nghĩa (không lộ P2002 thô)', async () => {
    // Fake db TỐI THIỂU nhưng TRUNG THỰC shape: qua được BẤT BIẾN room↔khách (customer.agentId=7 là thành viên
    // phòng), findFirst active = null (chưa thấy hàng — mô phỏng đúng khoảnh khắc TRƯỚC khi bên kia commit trong
    // race), rồi create NÉM lỗi mang `code:'P2002'` ĐÚNG như Prisma ném khi vi phạm partial unique index — đây là
    // chính xác thứ `isUniqueViolation()` của service kiểm (`(e as {code?}).code === 'P2002'`), KHÔNG bịa shape.
    const fakeDb = {
      customer: { findUnique: async () => ({ agentId: 7 }) },
      chatRoomMember: { findFirst: async () => ({ id: 1 }) },
      chatRoomTid: {
        findFirst: async () => null,
        create: async () => {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
      }
    } as unknown as Parameters<typeof linkTidToRoomForDelivery>[0];

    await expect(linkTidToRoomForDelivery(fakeDb, 999, 'room-x', 55)).rejects.toThrow(/thử lại/);
  });
});
