// SIGMA (27/7) — regression cho routes/chat-attachments.ts (POST/GET/PATCH đính kèm chat THẬT). CÙNG
// khuôn qr.test.ts (createApp() + supertest, upload nhị phân thật qua multipart) + session-middleware.test.ts
// (tạo WebSession thật qua createWebSession(), gắn cookie + header CSRF, KHÔNG mock requireSession — test
// round-trip auth thật). `isRequesterRoomMember()` (room-membership qua RC thật) mock `global.fetch` — CÙNG
// khuôn test/rc-client.test.ts (lưu/khôi phục `originalFetch`, KHÔNG mock nguyên module rc-client vì hàm này
// gọi fetch() trực tiếp, không qua rc-client.ts, xem comment routes/chat-attachments.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { makeAgent } from './fixtures.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { getAttachmentRow } from '../src/chat-attachment-service.js';
import { findOrCreateDirectRoom } from '../src/services/chat-room-service.js';
import { makeFriends } from './fixtures.js';

// PNG 1x1 THẬT ĐẦY ĐỦ — CÙNG buffer + lý do đã tự verify trong chat-attachment-service.test.ts (đọc comment ở
// đó): chỉ 8-byte signature KHÔNG đủ để file-type nhận diện, cần chunk IHDR hợp lệ thật.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const PLAIN_TEXT_AS_JPG = Buffer.from('khong phai anh that, chi la .txt doi ten', 'utf8');

let uniqCounter = 0;
/** Tạo 1 agent đã "đăng nhập" (Agent.rcUserId khớp WebSession.rcUserId — đúng điều kiện requireSession tra
 * cứu, xem session-middleware.ts) — trả sessionId dùng làm cookie cho request. */
async function authedAgent() {
  uniqCounter += 1;
  const rcUserId = `rc-chatattach-${Date.now()}-${uniqCounter}`;
  const db = getBotDb();
  const agent = await makeAgent();
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId, rcUsername: `chatattach${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `dummy-tok-${uniqCounter}`, agentId: agent.id });
  return { agent, sessionId: ws.id };
}

function authed(app: ReturnType<typeof createApp>, sessionId: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE),
    post: (path: string) =>
      request(app).post(path).set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE),
    patch: (path: string) =>
      request(app).patch(path).set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
  };
}

describe('POST /v1/chat/attachments', () => {
  const app = createApp();

  it('chưa đăng nhập (thiếu cookie) → 401', async () => {
    const res = await request(app).post('/v1/chat/attachments').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE).attach('file', PNG_1PX, 'a.png');
    expect(res.status).toBe(401);
  });

  it('upload ảnh PNG hợp lệ qua multipart thật → 201 {ok:true,data:{id,url}}', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', PNG_1PX, 'anh-that.png');
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.data.id).toBe('string');
    expect(res.body.data.url).toBe(`/v1/chat/attachments/${res.body.data.id}`);
  });

  it('file .txt đổi tên .jpg (magic-bytes SAI) → 400 MIME_NOT_ALLOWED (không tin đuôi file)', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', PLAIN_TEXT_AS_JPG, 'gia-mao.jpg');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('MIME_NOT_ALLOWED');
  });

  it('file vượt 50MB → 413 FILE_TOO_LARGE, chặn Ở TẦNG BUSBOY (limits.fileSize) — KHÔNG đợi buffer hết cả file', async () => {
    const { sessionId } = await authedAgent();
    // 51MB — vượt MAX_ATTACHMENT_SIZE_BYTES (50MB) đúng 1MB, đủ để kích hoạt event 'limit' của busboy.
    const oversized = Buffer.alloc(51 * 1024 * 1024, 0x41);
    const res = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', oversized, 'qua-lon.png');
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('FILE_TOO_LARGE');
  }, 30_000);

  it('thiếu file trong multipart body → 400 NO_FILE', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/chat/attachments').field('khong-phai-file', 'abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_FILE');
  });
});

describe('GET /v1/chat/attachments/:id — quyền xem', () => {
  const app = createApp();
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chưa đăng nhập → 401', async () => {
    const { sessionId } = await authedAgent();
    const uploadRes = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', PNG_1PX, 'a.png');
    const id = uploadRes.body.data.id;
    const res = await request(app).get(`/v1/chat/attachments/${id}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('id không tồn tại → 404', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).get('/v1/chat/attachments/khong-ton-tai-xyz');
    expect(res.status).toBe(404);
  });

  it('chính uploader xem file của mình (roomId CHƯA set) → 200, đúng nội dung + Content-Type', async () => {
    const { sessionId } = await authedAgent();
    const uploadRes = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', PNG_1PX, 'anh-cua-toi.png');
    const id = uploadRes.body.data.id;
    const res = await authed(app, sessionId).get(`/v1/chat/attachments/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body, PNG_1PX)).toBe(0);
  });

  // LANE A Vòng 2 (3/8) — response phục vụ file PHẢI có `X-Content-Type-Options: nosniff` để trình duyệt KHÔNG
  // tự "đoán" (MIME sniff) 1 file người dùng tải lên thành loại nguy hiểm hơn khai báo (vd 1 file khai
  // image/png nhưng chứa HTML/JS → nếu thiếu nosniff, 1 số trình duyệt cũ có thể render như HTML → XSS lưu trữ).
  it('GET file trả về header X-Content-Type-Options: nosniff (chống MIME sniffing/XSS lưu trữ)', async () => {
    const { sessionId } = await authedAgent();
    const uploadRes = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', PNG_1PX, 'nosniff.png');
    const id = uploadRes.body.data.id;
    const res = await authed(app, sessionId).get(`/v1/chat/attachments/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('agent KHÁC (không phải uploader), roomId CHƯA set → 403 FORBIDDEN (mặc định chặn, chưa biết thuộc phòng nào)', async () => {
    const { sessionId: uploaderSession } = await authedAgent();
    const { sessionId: strangerSession } = await authedAgent();
    const uploadRes = await authed(app, uploaderSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'rieng-tu.png');
    const id = uploadRes.body.data.id;
    const res = await authed(app, strangerSession).get(`/v1/chat/attachments/${id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('agent KHÁC, roomId ĐÃ set + RC xác nhận LÀ thành viên phòng đó → 200 (cho xem)', async () => {
    const { sessionId: uploaderSession } = await authedAgent();
    const { sessionId: memberSession, agent: memberAgent } = await authedAgent();
    void memberAgent;
    const uploadRes = await authed(app, uploaderSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'trong-phong.png');
    const id = uploadRes.body.data.id;
    await authed(app, uploaderSession).patch(`/v1/chat/attachments/${id}/room`).send({ roomId: 'room-real-1' });

    global.fetch = (async () =>
      new Response(JSON.stringify({ success: true, subscription: { rid: 'room-real-1' } }), { status: 200 })) as unknown as typeof fetch;

    const res = await authed(app, memberSession).get(`/v1/chat/attachments/${id}`);
    expect(res.status).toBe(200);
  });

  // Phase 3 (30/7) — bug thật phát hiện lúc cutover UI: roomId giờ có thể thuộc phòng chat MỚI (`chat_rooms`),
  // KHÔNG chỉ RC. Trước fix, isRequesterRoomMember() CHỈ hỏi RC → phòng mới (id không tồn tại trong RC) luôn
  // 403 nhầm cho MỌI thành viên khác ngoài uploader. Test KHÔNG mock `global.fetch` (nếu code lỡ vẫn gọi RC,
  // fetch thật sẽ lỗi mạng/throw — chứng minh code ĐÃ đi đúng nhánh chat_rooms, không rơi về nhánh RC cũ).
  it('agent KHÁC là thành viên phòng chat MỚI (chat_rooms, KHÔNG phải RC) → 200, KHÔNG gọi RC', async () => {
    const db = getBotDb();
    const { sessionId: uploaderSession, agent: uploaderAgent } = await authedAgent();
    const { sessionId: memberSession, agent: memberAgent } = await authedAgent();
    await makeFriends(uploaderAgent.id, memberAgent.id);
    const room = await findOrCreateDirectRoom(db, uploaderAgent.id, memberAgent.id);

    const uploadRes = await authed(app, uploaderSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'phong-moi.png');
    const id = uploadRes.body.data.id;
    await authed(app, uploaderSession).patch(`/v1/chat/attachments/${id}/room`).send({ roomId: room.id });

    const res = await authed(app, memberSession).get(`/v1/chat/attachments/${id}`);
    expect(res.status).toBe(200);
  });

  it('agent KHÔNG PHẢI thành viên phòng chat MỚI → 403 (chặn đúng, không phải lỗ hổng)', async () => {
    const db = getBotDb();
    const { sessionId: uploaderSession, agent: uploaderAgent } = await authedAgent();
    const { agent: memberAgent } = await authedAgent();
    const { sessionId: strangerSession } = await authedAgent();
    await makeFriends(uploaderAgent.id, memberAgent.id);
    const room = await findOrCreateDirectRoom(db, uploaderAgent.id, memberAgent.id);

    const uploadRes = await authed(app, uploaderSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'phong-moi2.png');
    const id = uploadRes.body.data.id;
    await authed(app, uploaderSession).patch(`/v1/chat/attachments/${id}/room`).send({ roomId: room.id });

    const res = await authed(app, strangerSession).get(`/v1/chat/attachments/${id}`);
    expect(res.status).toBe(403);
  });

  it('agent KHÁC, roomId ĐÃ set + RC xác nhận KHÔNG phải thành viên → 403 (fail-closed đúng thiết kế)', async () => {
    const { sessionId: uploaderSession } = await authedAgent();
    const { sessionId: strangerSession } = await authedAgent();
    const uploadRes = await authed(app, uploaderSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'trong-phong2.png');
    const id = uploadRes.body.data.id;
    await authed(app, uploaderSession).patch(`/v1/chat/attachments/${id}/room`).send({ roomId: 'room-real-2' });

    global.fetch = (async () => new Response(JSON.stringify({ success: false, error: 'not a member' }), { status: 200 })) as unknown as typeof fetch;

    const res = await authed(app, strangerSession).get(`/v1/chat/attachments/${id}`);
    expect(res.status).toBe(403);
  });

  it('agent KHÁC, roomId ĐÃ set + RC mạng lỗi → 403 (fail-closed, KHÔNG mặc định cho xem khi không xác nhận được)', async () => {
    const { sessionId: uploaderSession } = await authedAgent();
    const { sessionId: strangerSession } = await authedAgent();
    const uploadRes = await authed(app, uploaderSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'trong-phong3.png');
    const id = uploadRes.body.data.id;
    await authed(app, uploaderSession).patch(`/v1/chat/attachments/${id}/room`).send({ roomId: 'room-real-3' });

    global.fetch = (async () => {
      throw new Error('ECONNREFUSED (giả lập RC sập)');
    }) as unknown as typeof fetch;

    const res = await authed(app, strangerSession).get(`/v1/chat/attachments/${id}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /v1/chat/attachments/:id/room', () => {
  const app = createApp();

  it('chính uploader gắn roomId → 200 ok, DB cập nhật thật', async () => {
    const db = getBotDb();
    const { sessionId, agent } = await authedAgent();
    const uploadRes = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', PNG_1PX, 'a.png');
    const id = uploadRes.body.data.id;
    const res = await authed(app, sessionId).patch(`/v1/chat/attachments/${id}/room`).send({ roomId: 'room-patch-1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const row = await getAttachmentRow(db, id);
    expect(row?.room_id).toBe('room-patch-1');
    expect(row?.uploader_id).toBe(agent.id);
  });

  it('agent KHÁC cố PATCH roomId của attachment không phải mình → 404 (KHÔNG lộ tồn tại/không tồn tại khác nhau)', async () => {
    const { sessionId: uploaderSession } = await authedAgent();
    const { sessionId: attackerSession } = await authedAgent();
    const uploadRes = await authed(app, uploaderSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'b.png');
    const id = uploadRes.body.data.id;
    const res = await authed(app, attackerSession).patch(`/v1/chat/attachments/${id}/room`).send({ roomId: 'room-hijack' });
    expect(res.status).toBe(404);
  });

  it('thiếu roomId trong body → 400 ROOM_ID_REQUIRED', async () => {
    const { sessionId } = await authedAgent();
    const uploadRes = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', PNG_1PX, 'c.png');
    const id = uploadRes.body.data.id;
    const res = await authed(app, sessionId).patch(`/v1/chat/attachments/${id}/room`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ROOM_ID_REQUIRED');
  });

  it('chưa đăng nhập → 401', async () => {
    const { sessionId } = await authedAgent();
    const uploadRes = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', PNG_1PX, 'd.png');
    const id = uploadRes.body.data.id;
    const res = await request(app).patch(`/v1/chat/attachments/${id}/room`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE).send({ roomId: 'x' });
    expect(res.status).toBe(401);
  });
});
