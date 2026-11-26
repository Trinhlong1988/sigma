// AUDIT-VÁ #7 (LOW) — copy đúng asyncHandler của apps/bot-api/src/async-handler.ts.
// Express 4.21 KHÔNG tự bắt lỗi throw/reject bên trong 1 async `(req,res)=>{}` handler → 1 promise reject
// không try/catch trở thành "unhandled promise rejection" ở tầng Node → Node 15+ TERMINATE cả tiến trình.
// asyncHandler ép MỌI lỗi đi qua next(err) → Express định tuyến tới error-handler 4-tham-số ở index.ts.
// Áp cho MỌI async route handler (lỗi CẢ LỚP, không bỏ sót route nào). KHÔNG nuốt lỗi (R198): .catch(next).
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
