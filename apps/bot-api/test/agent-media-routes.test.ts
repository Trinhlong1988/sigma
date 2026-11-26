// SIGMA (1/8) — regression cho routes/me.ts POST/GET avatar + ảnh bìa (agent-media-service.ts), mục 39
// mở rộng. CÙNG khuôn chat-attachments-routes.test.ts (createApp() + supertest, upload nhị phân thật qua
// multipart, WebSession thật qua createWebSession() — KHÔNG mock requireSession, test round-trip auth thật).
//
// Model Agent CHƯA `prisma migrate deploy`/`generate` lên client dùng chung (đúng CẤM tuyệt đối B37/B42) —
// cột avatar_image/avatar_image_mime/avatar_updated_at/cover_image/cover_image_mime/cover_updated_at chỉ tồn
// tại nhờ throwaway DB của suite này TỰ chạy `prisma migrate deploy` ở global-setup.ts (bao gồm CẢ migration
// MỚI viết cho các cột này). CHỜ LEAD chạy `prisma migrate deploy` + `prisma generate` trên schema dùng chung
// TRƯỚC KHI suite này chạy được thật (Prisma Client generated hiện tại KHÔNG có field avatarImage/coverImage
// trên model Agent → tsc báo lỗi type tại agent-media-service.ts/routes/me.ts, ĐÚNG NHƯ KỲ VỌNG, xem báo cáo
// cuối cùng của nhiệm vụ này).
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { makeAgent } from './fixtures.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';

// PNG 1x1 THẬT ĐẦY ĐỦ (signature + IHDR + IDAT + IEND hợp lệ) — CÙNG buffer đã tự verify trong
// chat-attachment-service.test.ts (đọc comment ở đó): chỉ 8-byte signature KHÔNG đủ để file-type nhận diện.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00]);
const PLAIN_TEXT_AS_JPG = Buffer.from('day chi la mot file .txt gia mao doi ten thanh .jpg, khong phai anh that', 'utf8');

let uniqCounter = 0;
/** Tạo 1 agent đã "đăng nhập" (Agent.rcUserId khớp WebSession.rcUserId — đúng điều kiện requireSession tra
 * cứu, xem session-middleware.ts) — trả sessionId dùng làm cookie cho request. CÙNG helper
 * chat-attachments-routes.test.ts authedAgent(). */
async function authedAgent() {
  uniqCounter += 1;
  const rcUserId = `rc-agentmedia-${Date.now()}-${uniqCounter}`;
  const db = getBotDb();
  const agent = await makeAgent();
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId, rcUsername: `agentmedia${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `dummy-tok-${uniqCounter}`, agentId: agent.id });
  return { agent, sessionId: ws.id };
}

function authed(app: ReturnType<typeof createApp>, sessionId: string) {
  return {
    get: (path: string) => request(app).get(path).set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE),
    post: (path: string) => request(app).post(path).set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
  };
}

describe('POST /v1/me/avatar', () => {
  const app = createApp();

  it('chưa đăng nhập (thiếu cookie) → 401', async () => {
    const res = await request(app).post('/v1/me/avatar').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE).attach('file', PNG_1PX, 'a.png');
    expect(res.status).toBe(401);
  });

  it('upload PNG hợp lệ qua multipart thật → {ok:true}, DB ghi đúng avatarImage/avatarImageMime/avatarUpdatedAt', async () => {
    const { agent, sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/me/avatar').attach('file', PNG_1PX, 'avatar-that.png');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const db = getBotDb();
    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(Buffer.compare(Buffer.from(row!.avatarImage!), PNG_1PX)).toBe(0);
    expect(row!.avatarImageMime).toBe('image/png');
    expect(row!.avatarUpdatedAt).not.toBeNull();
    // coverImage KHÔNG bị đụng bởi upload avatar (2 cặp cột độc lập).
    expect(row!.coverImage).toBeNull();
  });

  it('upload JPEG hợp lệ → mimeType image/jpeg dù đuôi file client gửi là .png (magic-bytes THẬT thắng)', async () => {
    const { agent, sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/me/avatar').attach('file', JPEG_MIN, 'gia-mao-duoi.png');
    expect(res.status).toBe(200);
    const db = getBotDb();
    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(row!.avatarImageMime).toBe('image/jpeg');
  });

  it('file .txt đổi tên .jpg (magic-bytes SAI) → 400 MIME_NOT_ALLOWED, DB KHÔNG đổi', async () => {
    const { agent, sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/me/avatar').attach('file', PLAIN_TEXT_AS_JPG, 'gia-mao.jpg');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MIME_NOT_ALLOWED');
    const db = getBotDb();
    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(row!.avatarImage).toBeNull();
  });

  it('file vượt quá 5MB → 413 FILE_TOO_LARGE (kiểm tầng business, sau khi busboy 10MB ceiling cho qua)', async () => {
    const { sessionId } = await authedAgent();
    const oversized = Buffer.alloc(6 * 1024 * 1024, 0x41); // 6MB — vượt 5MB, dưới ceiling busboy 10MB.
    const res = await authed(app, sessionId).post('/v1/me/avatar').attach('file', oversized, 'qua-lon.png');
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('FILE_TOO_LARGE');
  }, 20_000);

  it('thiếu file trong multipart body → 400 NO_FILE', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/me/avatar').field('khong-phai-file', 'abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_FILE');
  });
});

describe('GET /v1/agents/:id/avatar', () => {
  const app = createApp();

  it('chưa đăng nhập → 401', async () => {
    const { agent } = await authedAgent();
    const res = await request(app).get(`/v1/agents/${agent.id}/avatar`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('agent chưa có avatar → 200 PNG fallback (màu+chữ theo agentId, đồng nhất mọi nền — 8/8, KHÔNG còn 404)', async () => {
    const { agent, sessionId } = await authedAgent();
    const res = await authed(app, sessionId).get(`/v1/agents/${agent.id}/avatar`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // Body là PNG thật (magic bytes) — Android BitmapFactory/popup EXE decode được.
    expect(Buffer.from(res.body).subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    expect(Buffer.from(res.body).length).toBeGreaterThan(100);
  });

  it('id không phải số → 400 VALIDATION', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).get('/v1/agents/khong-phai-so/avatar');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('agent KHÁC (không phải chủ sở hữu) VẪN xem được avatar của người khác → 200, đúng nội dung + Content-Type (khác qrImage chỉ chủ sở hữu xem)', async () => {
    const { agent: owner, sessionId: ownerSession } = await authedAgent();
    const { sessionId: viewerSession } = await authedAgent();
    await authed(app, ownerSession).post('/v1/me/avatar').attach('file', PNG_1PX, 'avatar.png');

    const res = await authed(app, viewerSession).get(`/v1/agents/${owner.id}/avatar`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body, PNG_1PX)).toBe(0);
  });

  it('agentId không tồn tại → 200 PNG fallback (KHÔNG throw, KHÔNG lộ tồn tại; chỉ ô màu + "?")', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).get('/v1/agents/999999999/avatar');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.body).subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  });
});

describe('POST /v1/me/cover + GET /v1/agents/:id/cover', () => {
  const app = createApp();

  it('upload ảnh bìa hợp lệ → {ok:true}, DB ghi coverImage — avatarImage KHÔNG bị đụng', async () => {
    const { agent, sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/me/cover').attach('file', PNG_1PX, 'bia-that.png');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const db = getBotDb();
    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(Buffer.compare(Buffer.from(row!.coverImage!), PNG_1PX)).toBe(0);
    expect(row!.coverImageMime).toBe('image/png');
    expect(row!.avatarImage).toBeNull();
  });

  it('agent KHÁC vẫn xem được ảnh bìa của người khác → 200, đúng nội dung', async () => {
    const { agent: owner, sessionId: ownerSession } = await authedAgent();
    const { sessionId: viewerSession } = await authedAgent();
    await authed(app, ownerSession).post('/v1/me/cover').attach('file', JPEG_MIN, 'bia.jpg');

    const res = await authed(app, viewerSession).get(`/v1/agents/${owner.id}/cover`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('agent chưa có ảnh bìa → 404 NOT_FOUND', async () => {
    const { agent, sessionId } = await authedAgent();
    const res = await authed(app, sessionId).get(`/v1/agents/${agent.id}/cover`);
    expect(res.status).toBe(404);
  });
});
