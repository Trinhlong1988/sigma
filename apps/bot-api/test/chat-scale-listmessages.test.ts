// SIGMA Vòng 2.5 (3/8) — QUY MÔ LỚN: phòng chat nhiều tin/nhiều file. ĐO THẬT thời gian listMessages() +
// khẳng định cursor pagination ĐÚNG/ỔN ĐỊNH (không trùng/sót/lệch khi có tin mới chen vào), trên throwaway PG.
//
// Seed bằng raw SQL generate_series (nhanh, created_at RẢI đều mỗi giây để cursor có mốc phân biệt) — KHÔNG
// dùng createMany 30k (chậm + created_at trùng nhau phá tie-break). Số đo in ra console (xem output test) +
// assert TÍNH ĐÚNG tất định (không assert thời gian tuyệt đối — tránh flaky theo máy).
import { describe, it, expect, beforeAll } from 'vitest';
import { getBotDb } from '../src/db.js';
import { listMessages, listRoomAttachments } from '../src/services/chat-message-service.js';
import { makeAgent, makeChatRoom, makeChatRoomMember } from './fixtures.js';

const N_MESSAGES = 30_000;
const N_ATTACH = 3_000;

let roomId: string;
let agentId: number;
let attRoomId: string;

beforeAll(async () => {
  const db = getBotDb();
  const agent = await makeAgent();
  agentId = agent.id;
  const room = await makeChatRoom({ type: 'GROUP', name: 'Phong dong tin' });
  roomId = room.id;
  await makeChatRoomMember(roomId, agentId, { role: 'OWNER' });

  const suffix = `${Date.now()}`;
  const base = new Date('2026-01-01T00:00:00.000Z');
  // 30k tin TEXT, created_at = base + g giây (phân biệt từng tin) — id text sortable theo g.
  await db.$executeRawUnsafe(
    `INSERT INTO chat_messages (id, room_id, sender_id, kind, body, created_at)
     SELECT 'm${suffix}_' || lpad(g::text, 7, '0'), $1, $2, 'TEXT', 'msg ' || g,
            TIMESTAMPTZ '2026-01-01 00:00:00+00' + (g * INTERVAL '1 second')
     FROM generate_series(1, ${N_MESSAGES}) g`,
    roomId,
    agentId
  );
  void base;

  // Phòng thứ 2: N_ATTACH tin IMAGE + chat_attachments tương ứng (đo listRoomAttachments unbounded).
  const attRoom = await makeChatRoom({ type: 'GROUP', name: 'Phong nhieu file' });
  attRoomId = attRoom.id;
  await makeChatRoomMember(attRoomId, agentId, { role: 'OWNER' });
  await db.$executeRawUnsafe(
    `INSERT INTO chat_attachments (id, uploader_id, file_name, mime_type, size_bytes, checksum, storage_path, room_id, created_at)
     SELECT 'a${suffix}_' || lpad(g::text, 7, '0'), $1, 'f' || g || '.jpg', 'image/jpeg', 1024, 'deadbeef', 'a' || g || '.jpg', $2,
            TIMESTAMPTZ '2026-01-01 00:00:00+00' + (g * INTERVAL '1 second')
     FROM generate_series(1, ${N_ATTACH}) g`,
    agentId,
    attRoomId
  );
  await db.$executeRawUnsafe(
    `INSERT INTO chat_messages (id, room_id, sender_id, kind, body, attachment_id, created_at)
     SELECT 'i${suffix}_' || lpad(g::text, 7, '0'), $1, $2, 'IMAGE', 'anh ' || g, 'a${suffix}_' || lpad(g::text, 7, '0'),
            TIMESTAMPTZ '2026-01-01 00:00:00+00' + (g * INTERVAL '1 second')
     FROM generate_series(1, ${N_ATTACH}) g`,
    attRoomId,
    agentId
  );
}, 120_000);

describe('Scale — listMessages() cursor pagination trên phòng 30k tin', () => {
  it(`seed đủ ${N_MESSAGES} tin`, async () => {
    const cnt = await getBotDb().chatMessage.count({ where: { roomId } });
    expect(cnt).toBe(N_MESSAGES);
  });

  it('trang đầu (không cursor) trả limit tin MỚI NHẤT, có hasMore — ĐO thời gian', async () => {
    const t0 = performance.now();
    const page = await listMessages(getBotDb(), roomId, agentId, { limit: 30 });
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[SCALE] listMessages trang đầu (limit 30, phòng ${N_MESSAGES} tin): ${ms.toFixed(1)}ms`);
    expect(page.messages).toHaveLength(30);
    expect(page.hasMore).toBe(true);
    // Mới nhất trước: tin đầu tiên = created_at lớn nhất (g=30000).
    expect(page.messages[0].body).toBe(`msg ${N_MESSAGES}`);
    expect(page.messages[29].body).toBe(`msg ${N_MESSAGES - 29}`);
  });

  it('trang SÂU (cursor ~giữa) vẫn nhanh — ĐO thời gian (index (room_id, created_at))', async () => {
    // Lấy id tin ở giữa để làm cursor `before`.
    const mid = await getBotDb().chatMessage.findFirst({ where: { roomId, body: `msg ${Math.floor(N_MESSAGES / 2)}` }, select: { id: true } });
    expect(mid).not.toBeNull();
    const t0 = performance.now();
    const page = await listMessages(getBotDb(), roomId, agentId, { before: mid!.id, limit: 100 });
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[SCALE] listMessages trang sâu (before=giữa, limit 100): ${ms.toFixed(1)}ms`);
    expect(page.messages).toHaveLength(100);
    // Tất cả tin trả về phải CŨ HƠN cursor (msg 15000) → msg 14999..14900.
    expect(page.messages[0].body).toBe(`msg ${Math.floor(N_MESSAGES / 2) - 1}`);
  });

  it('cursor pagination ĐÚNG: đi hết phòng KHÔNG trùng/sót, thứ tự giảm nghiêm ngặt — ĐO tổng thời gian walk', async () => {
    const db = getBotDb();
    const seen = new Set<string>();
    let before: string | undefined;
    let lastCreatedAt = Number.POSITIVE_INFINITY;
    let pages = 0;
    const t0 = performance.now();
    for (;;) {
      const page = await listMessages(db, roomId, agentId, { before, limit: 500 });
      pages += 1;
      for (const m of page.messages) {
        expect(seen.has(m.id)).toBe(false); // KHÔNG trùng.
        seen.add(m.id);
        const ts = m.createdAt.getTime();
        expect(ts).toBeLessThanOrEqual(lastCreatedAt); // giảm dần (mới→cũ).
        lastCreatedAt = ts;
      }
      if (!page.hasMore) break;
      before = page.messages[page.messages.length - 1].id;
    }
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[SCALE] walk hết ${N_MESSAGES} tin: ${pages} trang (limit 500), tổng ${ms.toFixed(0)}ms, ${(ms / pages).toFixed(1)}ms/trang`);
    expect(seen.size).toBe(N_MESSAGES); // KHÔNG sót.
  }, 60_000);

  it('ỔN ĐỊNH khi có tin MỚI chen giữa 2 lần tải: cursor cũ không sinh trùng/sót', async () => {
    const db = getBotDb();
    // Tải trang đầu.
    const p1 = await listMessages(db, roomId, agentId, { limit: 100 });
    const cursor = p1.messages[p1.messages.length - 1].id;
    // Có 200 tin MỚI gửi vào phòng SAU khi client đã tải trang đầu.
    const suffix = `${Date.now()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO chat_messages (id, room_id, sender_id, kind, body, created_at)
       SELECT 'new${suffix}_' || g, $1, $2, 'TEXT', 'newmsg ' || g,
              TIMESTAMPTZ '2026-06-01 00:00:00+00' + (g * INTERVAL '1 second')
       FROM generate_series(1, 200) g`,
      roomId,
      agentId
    );
    // Trang kế dùng cursor CŨ (kéo lên xem tin cũ hơn) — tin mới (created_at 2026-06) KHÔNG được lọt vào đây.
    const p2 = await listMessages(db, roomId, agentId, { before: cursor, limit: 100 });
    const p1Ids = new Set(p1.messages.map((m) => m.id));
    for (const m of p2.messages) {
      expect(p1Ids.has(m.id)).toBe(false); // không trùng trang trước.
      expect((m.body ?? '').startsWith('newmsg')).toBe(false); // tin mới KHÔNG chen vào trang cũ (cursor theo created_at).
    }
    // p2 nối tiếp liền mạch: p1 = 100 tin mới nhất (msg 30000..29901, cursor=29901) → p2 bắt đầu msg 29900.
    expect(p2.messages[0].body).toBe(`msg ${N_MESSAGES - 100}`);
  });
});

describe('Scale — listRoomAttachments() (tab File) trên phòng nhiều file', () => {
  // FIX-PERF (4/8) — TRƯỚC ĐÂY test này KHẲNG ĐỊNH hành vi over-fetch (1 lời gọi trả CẢ N_ATTACH mục vào RAM).
  // Nay hàm ĐÃ phân trang (mặc định 30/trang, partial index) → đổi test sang: (a) 1 trang bị CHẶN đúng limit +
  // hasMore=true; (b) kéo hết trang qua cursor `before` gom đủ N_ATTACH mục (không trùng, đúng thứ tự mới→cũ).
  it(`phân trang: 1 trang bị chặn (limit) + hasMore, kéo hết cursor gom đủ ${N_ATTACH} file`, async () => {
    const db = getBotDb();
    const t0 = performance.now();
    const first = await listRoomAttachments(db, attRoomId, agentId, { limit: 100 });
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[SCALE] listRoomAttachments trang đầu (limit 100, partial index) trong phòng ${N_ATTACH} file: ${ms.toFixed(1)}ms, trả ${first.attachments.length} mục, hasMore=${first.hasMore}`);
    expect(first.attachments.length).toBe(100);
    expect(first.hasMore).toBe(true);

    // Kéo hết trang qua cursor — xác nhận gom ĐỦ N_ATTACH, KHÔNG trùng id, thứ tự createdAt giảm dần.
    const seen = new Set<string>();
    let before: string | undefined;
    let lastCreatedAt = Number.POSITIVE_INFINITY;
    for (let page = 0; page < 200; page++) {
      const r = await listRoomAttachments(db, attRoomId, agentId, { before, limit: 100 });
      for (const att of r.attachments) {
        expect(seen.has(att.attachmentId)).toBe(false); // không trùng giữa các trang.
        seen.add(att.attachmentId);
        const t = new Date(att.createdAt).getTime();
        expect(t).toBeLessThanOrEqual(lastCreatedAt); // mới→cũ xuyên suốt các trang.
        lastCreatedAt = t;
      }
      if (!r.hasMore || r.attachments.length === 0) break;
      before = r.attachments[r.attachments.length - 1].messageId;
    }
    expect(seen.size).toBe(N_ATTACH);
  }, 30_000);
});
