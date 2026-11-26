// Hòm thư nội bộ qua HTTP (adapter — migrate màn "Hòm thư" sang API). Nghiệp vụ THUẦN ở @sigma/services
// (message.ts). Bề mặt khớp IPC desktop: message:inbox/unreadCount/markRead/markAllRead/send.
import { Router, type Request, type Response } from 'express';
import { listInbox, unreadCount, markRead, markAllRead, sendMessage } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num } from './_ctx.js';

export const messageRouter = Router();

// GET /v1/messages — hòm thư của chính người đăng nhập (thư đến, mới nhất trước).
messageRouter.get(
  '/v1/messages',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listInbox(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/messages/unread-count — số thư chưa đọc (bộ đếm realtime).
messageRouter.get(
  '/v1/messages/unread-count',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await unreadCount(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/messages — gửi thư nội bộ cho một người dùng khác (MESSAGE_SEND).
messageRouter.post(
  '/v1/messages',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await sendMessage(ctx, {
      recipientId: num(b['recipientId']) ?? 0,
      subject: typeof b['subject'] === 'string' ? (b['subject'] as string) : '',
      body: typeof b['body'] === 'string' ? (b['body'] as string) : ''
    });
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/messages/read-all — đánh dấu đã đọc tất cả thư của mình.
messageRouter.post(
  '/v1/messages/read-all',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await markAllRead(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/messages/:id/read — đánh dấu 1 thư đã đọc (chỉ thư của chính mình).
messageRouter.post(
  '/v1/messages/:id/read',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã thư không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await markRead(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);
