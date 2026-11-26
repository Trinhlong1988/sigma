// Bảo trì bộ nhớ (Storage-Guard) qua HTTP (adapter — migrate SERVER-OPS sang API). Nghiệp vụ THUẦN ở
// @sigma/services (storage.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC
// desktop (storage:status/cleanup/updateConfig). Server = máy chủ (nơi quanly-api chạy) → tự đo disk/pg + backup.
// Quyền: status=STORAGE_VIEW; cleanup/config=STORAGE_CLEANUP (admin). Cleanup xác nhận MẬT KHẨU do ADAPTER kiểm
// TRƯỚC (khuôn customer.ts) — thao tác PHÁ HỦY (xóa lịch sử/thùng rác).
import { Router, type Request, type Response } from 'express';
import { getStorageStatus, runCleanup, updateStorageConfig } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, bool } from './_ctx.js';

export const storageRouter = Router();

// GET /v1/storage/status — tình trạng bộ nhớ + bảo trì (cần STORAGE_VIEW).
storageRouter.get(
  '/v1/storage/status',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await getStorageStatus(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/storage/cleanup — dọn dẹp AN TOÀN (body {clearHistory, purgeTrash, password}). §14 xác nhận MẬT KHẨU
// do ADAPTER kiểm TRƯỚC khi gọi lõi. Sai mật khẩu → 409 WRONG_PASSWORD, KHÔNG gọi lõi (không backup/xóa).
storageRouter.post(
  '/v1/storage/cleanup',
  reauthRateLimiter, // B132 #1
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
    const result = await runCleanup(ctx, { clearHistory: bool(b['clearHistory']), purgeTrash: bool(b['purgeTrash']) });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/storage/config — cập nhật cấu hình bảo trì (ngưỡng/hạn lưu/chu kỳ/lịch). Cần STORAGE_CLEANUP.
storageRouter.patch(
  '/v1/storage/config',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateStorageConfig(ctx, {
      thresholdPct: num(b['thresholdPct']),
      auditRetentionDays: num(b['auditRetentionDays']),
      trashRetentionDays: num(b['trashRetentionDays']),
      backupIntervalHours: num(b['backupIntervalHours']),
      maintenanceDayOfWeek: num(b['maintenanceDayOfWeek']),
      maintenanceHour: num(b['maintenanceHour']),
      maintenanceEnabled: bool(b['maintenanceEnabled']),
      autoPurgeWeekly: bool(b['autoPurgeWeekly'])
    });
    res.status(statusFor(result)).json(result);
  })
);
