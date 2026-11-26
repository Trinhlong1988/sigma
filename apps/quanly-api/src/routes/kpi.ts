// KPI DOANH SỐ qua HTTP (tab full-view màn Doanh Số, Admin Demo 24/11). CHỈ ĐỌC. Nghiệp vụ THUẦN ở
// @sigma/services (kpi-doanh-so.ts) — route chỉ gác quyền + ép kiểu query + trả JSON.
//
// GÁC QUYỀN: REVENUE_VIEW (hoặc REVENUE_MANAGE) — GIỐNG /v1/bills/manual. KPI là của STAFF doanh số.
// CỐ Ý KHÔNG thêm path này vào SCOPE_ALLOW_* của auth.ts: vai "Kế toán NĐT" deny-by-default sẽ TỰ bị
// chặn (403) — KPI không dành cho vai NĐT phạm vi hẹp.
import { Router, type Request, type Response } from 'express';
import { PERMISSIONS } from '@sigma/shared';
import { kpiDoanhSo } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, num, str, statusFor } from './_ctx.js';

export const kpiRouter = Router();

const QUYEN_XEM = 'REVENUE_VIEW';
const QUYEN_GHI = 'REVENUE_MANAGE';
// CHẶN NGAY LÚC NẠP MODULE nếu mã quyền không có trong danh mục — thà app không lên còn hơn chạy với route
// từ chối tất cả trong im lặng (cùng khuôn bill-manual.ts).
for (const ma of [QUYEN_XEM, QUYEN_GHI]) {
  if (!PERMISSIONS.some((x) => x.code === ma)) {
    throw new Error(`[kpi] Mã quyền "${ma}" KHÔNG có trong danh mục permissions — sửa lại trước khi chạy.`);
  }
}

// GET /v1/kpi/doanh-so?from=YYYY-MM-DD&to=YYYY-MM-DD&ca=1|2|3
//  → { theoNgay: [{ngay, doanhSo}], theoDaiLy: [{..., posCam, posKhongChay, posThap, posDatHanMuc}] }
kpiRouter.get(
  '/v1/kpi/doanh-so',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!ctx.user.permissions.includes(QUYEN_XEM) && !ctx.user.permissions.includes(QUYEN_GHI)) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Tài khoản không có quyền xem doanh số.' });
      return;
    }
    const from = (str(req.query['from']) ?? '').trim();
    const to = (str(req.query['to']) ?? '').trim();
    const caRaw = num(req.query['ca']);
    const ca = caRaw != null && Number.isInteger(caRaw) ? caRaw : null;
    const result = await kpiDoanhSo(ctx, { from, to, ca });
    res.status(statusFor(result)).json(result);
  })
);
