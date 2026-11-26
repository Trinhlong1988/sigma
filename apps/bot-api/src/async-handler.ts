// BUG THẬT đêm 23→24/7: gọi POST /v1/auth/register/request-otp trên server đang chạy → Prisma ném P2021
// (bảng chưa migrate) → lỗi này CRASH CẢ TIẾN TRÌNH Node, không chỉ trả 500 cho request đó. Gốc: Express
// 4.21 (xem package.json) KHÔNG tự bắt lỗi throw/reject bên trong 1 async `(req,res) => {...}` handler —
// khác Express 5. Khi 1 async handler throw hoặc await 1 promise reject mà không có try/catch bao ngoài, nó
// trở thành "unhandled promise rejection" ở tầng Node — mặc định Node 15+ TERMINATE toàn bộ process.
//
// asyncHandler ép MỌI lỗi (throw hoặc reject) bên trong handler đi qua next(err) → Express định tuyến lỗi đó
// tới middleware lỗi tập trung ở app.ts (KHÔNG rơi ra ngoài thành unhandled rejection). Áp cho MỌI async route
// handler trong routes/*.ts — không tự ý bỏ sót route nào (đây là lỗi CẢ LỚP, không phải 1 chỗ).
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    // .catch(next) — KHÔNG nuốt lỗi: mọi lỗi bắt được LUÔN chuyển tiếp cho middleware lỗi (đúng nguyên tắc
    // R198 "check/error phải LUÔN hiển thị, không được biến mất câm lặng"), không bao giờ catch rồi bỏ qua.
    fn(req, res, next).catch(next);
  };
}
