// SIGMA (1/8, mục 32 "Sao lưu, đồng bộ") — 3 route /v1/me/drive-backup/* (routes/me.ts), business logic
// drive-backup-service.ts. CÙNG khuôn me-categories.test.ts/me-profile.test.ts (session cookie qua
// createWebSession + CSRF header). Mock TOÀN BỘ drive-backup-service.js (exchangeAuthorizationCode/
// encryptRefreshToken/runAgentDriveBackup) — KHÔNG gọi Google OAuth/Drive API thật trong test tự động, giữ NGUYÊN
// class DriveBackupError THẬT (qua vi.importActual, CÙNG cách me-profile.test.ts mock email-service.js) để route
// `err instanceof DriveBackupError` vẫn nhận diện đúng lỗi mock ném ra.
//
// CHƯA CHẠY ĐƯỢC cho tới khi LEAD `prisma migrate deploy` + `prisma generate` (cột google_drive_refresh_token/
// google_drive_last_backup_at trên bảng agents CHƯA có trong Prisma Client dùng chung lúc viết file này) — xem
// BUGS_FIXED.md, ĐÂY LÀ HỆ QUẢ TẤT YẾU ĐÃ BIẾT TRƯỚC (CÙNG tình trạng me-categories.test.ts lúc build tính năng
// Phân loại 31/7 — Prisma Client báo "Unknown argument" cho MỌI thao tác đọc/ghi 2 cột này tới khi generate lại).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/drive-backup-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/drive-backup-service.js')>('../src/drive-backup-service.js');
  return {
    ...actual,
    exchangeAuthorizationCode: vi.fn(),
    encryptRefreshToken: vi.fn(),
    runAgentDriveBackup: vi.fn()
  };
});

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent } from './fixtures.js';
import { DriveBackupError, exchangeAuthorizationCode, encryptRefreshToken, runAgentDriveBackup } from '../src/drive-backup-service.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-me-drive-backup-test-${Date.now()}-${rcCounter}`;
}

async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string> }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } };
}

describe('/v1/me/drive-backup/* — Sao lưu Google Drive (mục 32, 1/8)', () => {
  const app = createApp();

  beforeEach(() => {
    vi.mocked(exchangeAuthorizationCode).mockReset();
    vi.mocked(encryptRefreshToken).mockReset();
    vi.mocked(runAgentDriveBackup).mockReset();
  });

  it('thiếu session → 401 cho cả 3 endpoint', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).post('/v1/me/drive-backup/connect').set(csrf).send({ code: 'x' })).status).toBe(401);
    expect((await request(app).get('/v1/me/drive-backup/status').set(csrf)).status).toBe(401);
    expect((await request(app).post('/v1/me/drive-backup/run').set(csrf)).status).toBe(401);
  });

  describe('POST /v1/me/drive-backup/connect', () => {
    it('thiếu code → 400 VALIDATION, KHÔNG gọi exchangeAuthorizationCode', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      const res = await request(app).post('/v1/me/drive-backup/connect').set(headers).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION');
      expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
    });

    it('exchangeAuthorizationCode CONFIG_MISSING → 500, KHÔNG gọi encryptRefreshToken', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      vi.mocked(exchangeAuthorizationCode).mockResolvedValue({ ok: false, kind: 'CONFIG_MISSING', message: 'Thiếu GOOGLE_CLIENT_SECRET.' });
      const res = await request(app).post('/v1/me/drive-backup/connect').set(headers).send({ code: 'auth-code-1' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('CONFIG_MISSING');
      expect(encryptRefreshToken).not.toHaveBeenCalled();
    });

    it('exchangeAuthorizationCode INVALID_CODE → 400', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      vi.mocked(exchangeAuthorizationCode).mockResolvedValue({ ok: false, kind: 'INVALID_CODE', message: 'invalid_grant' });
      const res = await request(app).post('/v1/me/drive-backup/connect').set(headers).send({ code: 'auth-code-bad' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_CODE');
    });

    it('exchangeAuthorizationCode NO_REFRESH_TOKEN → 400', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      vi.mocked(exchangeAuthorizationCode).mockResolvedValue({ ok: false, kind: 'NO_REFRESH_TOKEN', message: 'Google không trả refresh_token.' });
      const res = await request(app).post('/v1/me/drive-backup/connect').set(headers).send({ code: 'auth-code-2' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NO_REFRESH_TOKEN');
    });

    it('thành công → lưu MÃ HOÁ, response CHỈ {ok:true,connected:true} — KHÔNG lộ token dạng nào', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      vi.mocked(exchangeAuthorizationCode).mockResolvedValue({ ok: true, refreshToken: 'plain-refresh-token-thật' });
      vi.mocked(encryptRefreshToken).mockReturnValue('iv-fake.tag-fake.data-fake');

      const res = await request(app).post('/v1/me/drive-backup/connect').set(headers).send({ code: 'auth-code-ok' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, connected: true });
      expect(JSON.stringify(res.body)).not.toContain('plain-refresh-token-thật');
      expect(JSON.stringify(res.body)).not.toContain('iv-fake.tag-fake.data-fake');
      expect(encryptRefreshToken).toHaveBeenCalledWith('plain-refresh-token-thật');

      const db = getBotDb();
      const updated = (await db.agent.findUnique({ where: { id: a.id } })) as unknown as { googleDriveRefreshToken: string | null };
      expect(updated.googleDriveRefreshToken).toBe('iv-fake.tag-fake.data-fake');
    });

    it('encryptRefreshToken ném DriveBackupError CONFIG_MISSING (thiếu DRIVE_TOKEN_ENC_KEY) → 500, KHÔNG ghi DB', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      vi.mocked(exchangeAuthorizationCode).mockResolvedValue({ ok: true, refreshToken: 'plain-refresh-token-2' });
      vi.mocked(encryptRefreshToken).mockImplementation(() => {
        throw new DriveBackupError('CONFIG_MISSING', 'Thiếu DRIVE_TOKEN_ENC_KEY.');
      });

      const res = await request(app).post('/v1/me/drive-backup/connect').set(headers).send({ code: 'auth-code-enc-fail' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('CONFIG_MISSING');
      const db = getBotDb();
      const updated = (await db.agent.findUnique({ where: { id: a.id } })) as unknown as { googleDriveRefreshToken: string | null };
      expect(updated.googleDriveRefreshToken).toBeNull();
    });
  });

  describe('GET /v1/me/drive-backup/status', () => {
    it('chưa kết nối → {connected:false, lastBackupAt:null}', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      const res = await request(app).get('/v1/me/drive-backup/status').set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ connected: false, lastBackupAt: null });
    });

    it('đã kết nối → {connected:true}, response KHÔNG chứa field token dạng nào', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      const db = getBotDb();
      await db.agent.update({ where: { id: a.id }, data: { googleDriveRefreshToken: 'iv.tag.data' } as never });

      const res = await request(app).get('/v1/me/drive-backup/status').set(headers);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(Object.keys(res.body).sort()).toEqual(['connected', 'lastBackupAt']);
    });
  });

  describe('POST /v1/me/drive-backup/run', () => {
    it('chưa kết nối Drive → 400 NOT_CONNECTED, KHÔNG gọi runAgentDriveBackup', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      const res = await request(app).post('/v1/me/drive-backup/run').set(headers);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NOT_CONNECTED');
      expect(runAgentDriveBackup).not.toHaveBeenCalled();
    });

    it('đã kết nối, backup thành công → trả fileId/fileName/uploadedAt, ghi googleDriveLastBackupAt', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      const db = getBotDb();
      await db.agent.update({ where: { id: a.id }, data: { googleDriveRefreshToken: 'iv.tag.data' } as never });
      const uploadedAt = new Date().toISOString();
      vi.mocked(runAgentDriveBackup).mockResolvedValue({ fileId: 'drive-file-1', fileName: `SigMa-backup-${a.id}-1.json`, uploadedAt });

      const res = await request(app).post('/v1/me/drive-backup/run').set(headers);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fileId: 'drive-file-1', fileName: `SigMa-backup-${a.id}-1.json`, uploadedAt });
      const updated = (await db.agent.findUnique({ where: { id: a.id } })) as unknown as { googleDriveLastBackupAt: Date | null };
      expect(updated.googleDriveLastBackupAt).not.toBeNull();
    });

    it('runAgentDriveBackup ném DRIVE_TOKEN_REFRESH_FAILED (quyền bị thu hồi) → 401, KHÔNG ghi googleDriveLastBackupAt', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      const db = getBotDb();
      await db.agent.update({ where: { id: a.id }, data: { googleDriveRefreshToken: 'iv.tag.data' } as never });
      vi.mocked(runAgentDriveBackup).mockRejectedValue(new DriveBackupError('DRIVE_TOKEN_REFRESH_FAILED', 'Quyền đã bị thu hồi.'));

      const res = await request(app).post('/v1/me/drive-backup/run').set(headers);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('DRIVE_TOKEN_REFRESH_FAILED');
      const updated = (await db.agent.findUnique({ where: { id: a.id } })) as unknown as { googleDriveLastBackupAt: Date | null };
      expect(updated.googleDriveLastBackupAt).toBeNull();
    });

    it('runAgentDriveBackup ném DRIVE_UPLOAD_FAILED (Drive API lỗi) → 502', async () => {
      const a = await makeAgent();
      const { headers } = await linkAgentToRc(a.id);
      const db = getBotDb();
      await db.agent.update({ where: { id: a.id }, data: { googleDriveRefreshToken: 'iv.tag.data' } as never });
      vi.mocked(runAgentDriveBackup).mockRejectedValue(new DriveBackupError('DRIVE_UPLOAD_FAILED', 'Google Drive trả lỗi HTTP 500.'));

      const res = await request(app).post('/v1/me/drive-backup/run').set(headers);

      expect(res.status).toBe(502);
      expect(res.body.error).toBe('DRIVE_UPLOAD_FAILED');
    });
  });
});
