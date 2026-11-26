// Sao lưu qua HTTP (adapter — migrate SERVER-OPS sang API). Nghiệp vụ THUẦN ở @sigma/services (backup.ts). Route
// CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (backup:create/list/
// mirrorConfigGet/mirrorConfigSet). Server TỰ pg_dump vào ổ máy chủ (SIGMA_BACKUP_DIR). KHÔNG expose restore
// (backup:restore) — restore nhận file từ ĐĨA CLIENT + pg_restore phá hủy DB thật → giữ IPC ở desktop máy chủ.
// Quyền: create/list/mirrorConfigGet=BACKUP_CREATE; mirrorConfigSet=BACKUP_RESTORE (privileged) + MẬT KHẨU.
import { Router, type Request, type Response } from 'express';
import { createBackup, listBackups, getBackupMirrorConfig, setBackupMirrorConfig } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, num, str } from './_ctx.js';

export const backupRouter = Router();

// POST /v1/backups — tạo bản sao lưu (body {note}). Server tự pg_dump. Cần BACKUP_CREATE.
backupRouter.post(
  '/v1/backups',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createBackup(ctx, str(b['note']));
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/backups — liệt kê các bản sao lưu đã ghi nhận. Cần BACKUP_CREATE.
backupRouter.get(
  '/v1/backups',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listBackups(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/backups/mirror-config — cấu hình + trạng thái mirror (tầng 2). Cần BACKUP_CREATE.
backupRouter.get(
  '/v1/backups/mirror-config',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await getBackupMirrorConfig(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// PUT /v1/backups/mirror-config — đặt thư mục mirror + số bản giữ (body {mirrorDir, keep, password}). Đổi cấu hình
// sao lưu = PRIVILEGED → cần BACKUP_RESTORE + xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC. Sai → 409 WRONG_PASSWORD.
backupRouter.put(
  '/v1/backups/mirror-config',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
    if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
      const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
      res.status(statusFor(wrong)).json(wrong);
      return;
    }
    const mirrorDir = typeof b['mirrorDir'] === 'string' ? (b['mirrorDir'] as string) : (b['mirrorDir'] === null ? null : '');
    const result = await setBackupMirrorConfig(ctx, { mirrorDir, keep: num(b['keep']) });
    res.status(statusFor(result)).json(result);
  })
);
