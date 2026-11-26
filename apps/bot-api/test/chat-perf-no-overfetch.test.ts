// PERF regression (5/8, EDIT AGENT — "load danh sách Trò chuyện + mở 1 chat hơi CHẬM"). GỐC: các query đường
// NÓNG dùng `include`/`findFirst` KHÔNG có `select` → Prisma kéo TOÀN BỘ cột, KỂ CẢ cột BYTEA nặng
// (chat_rooms.avatar_image / agents.avatar_image / cover_image / qr_image) rồi VỨT ĐI. Đo THẬT: agent 270 mang
// ~474KB ảnh → requireSession full-row 12.5ms vs select 0.84ms (~15×); endpoint /v1/chat/rooms 24ms→9ms.
//
// Test này KHÓA lại bằng cách BẮT SQL THẬT Prisma phát ra (log query events) khi gọi listRoomsForAgent /
// getRoomDetail và KHẲNG ĐỊNH KHÔNG câu SELECT nào chạm chat_rooms lại kéo cột `avatar_image`. Nếu mai này ai
// bỏ `select` (quay lại `include` trần) → test ĐỎ ngay, không để over-fetch tái diễn âm thầm. Không assert
// "suite pass" chung chung — assert ĐÚNG cột bytea vắng mặt trong SQL (đúng tinh thần R198).
import { describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../packages/database/generated/prisma/client.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { getBotDb } from '../src/db.js';
import { createGroupRoom, getRoomDetail, listRoomsForAgent } from '../src/services/chat-room-service.js';

function makeLoggingDb(): { db: PrismaClient; queries: string[] } {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const db = new PrismaClient({ adapter, log: [{ emit: 'event', level: 'query' }] });
  const queries: string[] = [];
  db.$on('query', (e: { query: string }) => queries.push(e.query));
  return { db, queries };
}

describe('perf — không over-fetch cột BYTEA trên đường nóng chat', () => {
  it('listRoomsForAgent + getRoomDetail KHÔNG SELECT chat_rooms.avatar_image (dù phòng CÓ ảnh nhóm)', async () => {
    const seed = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const c = await makeAgent();
    await makeFriends(a.id, b.id);
    await makeFriends(a.id, c.id);

    const room = await createGroupRoom(seed, a.id, 'Nhóm test over-fetch', [b.id, c.id]);
    // Gắn ảnh nhóm THẬT (bytea) — chính là cột nặng KHÔNG được kéo về trong danh sách/chi tiết.
    await seed.$executeRaw`UPDATE chat_rooms SET avatar_image = decode('deadbeefcafe', 'hex'), avatar_image_mime = 'image/png' WHERE id = ${room.id}`;

    const { db, queries } = makeLoggingDb();
    try {
      queries.length = 0;
      const rooms = await listRoomsForAgent(db, a.id);
      const detail = await getRoomDetail(db, room.id, a.id);

      // Kết quả VẪN ĐÚNG (shape/nội dung không đổi — avatarColor/avatarUrl vẫn có, avatarImage KHÔNG lộ).
      const summary = rooms.find((r) => r.id === room.id)!;
      expect(summary).toBeTruthy();
      expect(summary.name).toBe('Nhóm test over-fetch');
      expect(Object.keys(summary)).not.toContain('avatarImage');
      expect(detail.id).toBe(room.id);
      expect(detail.members.map((m) => m.agentId).sort()).toEqual([a.id, b.id, c.id].sort());
      expect(Object.keys(detail)).not.toContain('avatarImage');

      // SQL THẬT: mọi câu chạm bảng chat_rooms KHÔNG được nhắc tới cột avatar_image (over-fetch bytea).
      // Prisma phát SQL dạng `SELECT ... FROM "public"."chat_rooms" ...`. Lọc câu SELECT có bảng chat_rooms
      // (KHÔNG khớp nhầm chat_room_members — chuỗi "chat_rooms" khác "chat_room_members").
      const roomSelects = queries.filter((q) => /select/i.test(q) && /"chat_rooms"/i.test(q));
      expect(roomSelects.length).toBeGreaterThan(0); // chắc chắn CÓ đọc chat_rooms (test thật sự chạy đúng path)
      const leaking = roomSelects.filter((q) => /avatar_image/i.test(q));
      expect(leaking, `SQL kéo cột bytea avatar_image (over-fetch tái diễn):\n${leaking.join('\n')}`).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });
});
