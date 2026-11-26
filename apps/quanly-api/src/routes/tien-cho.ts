// DOANH Sá» TIá»€N CHá»œ / CÃ”NG Ná»¢ PHáº¢I THU á»¦Y QUYá»€N qua HTTP (Admin Demo 24/11). Nghiá»‡p vá»¥ THUáº¦N á»Ÿ @sigma/services
// (tien-cho.ts) â€” route chá»‰ gÃ¡c quyá»n + Ã©p kiá»ƒu + tráº£ JSON. Bá» máº·t:
//   POST   /v1/tien-cho            â€” NHáº¬P/Sá»¬A 1 bill tá»•ng thÃ¡ng (gÃ¡c REVENUE_MANAGE)
//   DELETE /v1/tien-cho/:id        â€” xoÃ¡ má»m 1 dÃ²ng (gÃ¡c REVENUE_MANAGE)
//   GET    /v1/tien-cho/bao-cao    â€” bÃ¡o cÃ¡o gom theo filter (gÃ¡c REVENUE_VIEW | REVENUE_MANAGE)
//
// GÃC QUYá»€N: REVENUE_VIEW/MANAGE â€” GIá»NG /v1/bills/manual + /v1/kpi/doanh-so. Cá» Ã KHÃ”NG thÃªm path nÃ y vÃ o
// SCOPE_ALLOW_* cá»§a auth.ts: vai "Káº¿ toÃ¡n NÄT" deny-by-default sáº½ Tá»° bá»‹ cháº·n (403) â€” mÃ n nÃ y KHÃ”NG dÃ nh cho vai
// NÄT pháº¡m vi háº¹p (Ä‘Ã¢y lÃ  cÃ´ng ná»£ pháº£i thu toÃ n há»‡ cá»§a SigMa, khÃ´ng scope theo 1 NÄT).
import { Router, type Request, type Response } from 'express';
import { PERMISSIONS } from '@sigma/shared';
import { nhapTienCho, baoCaoTienCho, xoaTienCho } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, str, statusFor, reauthRateLimiter, verifyActorPassword } from './_ctx.js';

export const tienChoRouter = Router();

const QUYEN_XEM = 'REVENUE_VIEW';
const QUYEN_GHI = 'REVENUE_MANAGE';
// CHáº¶N NGAY LÃšC Náº P MODULE náº¿u mÃ£ quyá»n khÃ´ng cÃ³ trong danh má»¥c (cÃ¹ng khuÃ´n kpi.ts / bill-manual.ts).
for (const ma of [QUYEN_XEM, QUYEN_GHI]) {
  if (!PERMISSIONS.some((x) => x.code === ma)) {
    throw new Error(`[tien-cho] MÃ£ quyá»n "${ma}" KHÃ”NG cÃ³ trong danh má»¥c permissions â€” sá»­a láº¡i trÆ°á»›c khi cháº¡y.`);
  }
}

/** TÃ¡ch chuá»—i csv/máº£ng tá»« query â†’ number[] (bá» pháº§n tá»­ phi sá»‘). */
function numArr(v: unknown): number[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === 'string' && v.trim() !== '' ? v.split(',') : [];
  const out = raw.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n));
  return out.length > 0 ? out : undefined;
}
/** HKD lá»c theo TÃŠN â€” gá»­i dáº¡ng máº£ng (repeated query hkd=a&hkd=b) hoáº·c 1 chuá»—i. KHÃ”NG tÃ¡ch theo dáº¥u pháº©y. */
function strArr(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() !== '' ? [v] : [];
  const out = raw.map((x) => x.trim()).filter((x) => x !== '');
  return out.length > 0 ? out : undefined;
}

// POST /v1/tien-cho â€” body { thang, tidId, feeTypeId, dong: [{cardTypeId, doanhSoTruocPhi, ghiChu?}] }
tienChoRouter.post(
  '/v1/tien-cho',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const dongRaw = Array.isArray(b['dong']) ? (b['dong'] as Record<string, unknown>[]) : [];
    const dong = dongRaw.map((d) => ({
      cardTypeId: Number(d['cardTypeId']),
      doanhSoTruocPhi: Number(d['doanhSoTruocPhi']),
      ghiChu: typeof d['ghiChu'] === 'string' ? (d['ghiChu'] as string) : null
    }));
    const result = await nhapTienCho(ctx, {
      thang: str(b['thang']) ?? '',
      tidId: Number(b['tidId']),
      feeTypeId: Number(b['feeTypeId']),
      dong
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/tien-cho/:id â€” xoÃ¡ má»m 1 dÃ²ng
tienChoRouter.delete(
  '/v1/tien-cho/:id',
  reauthRateLimiter, // [vá audit F-DELETE] xoá BẢN GHI TIỀN (phải thu) → đồng bộ chuẩn app: re-auth mật khẩu + rate-limit.
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pwOk = await verifyActorPassword(ctx.db, ctx.user.id, str(b['password']) ?? '');
    if (!pwOk) { res.status(409).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu không đúng — xoá dòng tiền chờ cần xác nhận mật khẩu.' }); return; }
    const id = Number(req.params['id']);
    const result = await xoaTienCho(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/tien-cho/bao-cao?tuThang=YYYY-MM&denThang=YYYY-MM&tids=&cards=&daiLy=&doiTac=&banks=&hkd=
tienChoRouter.get(
  '/v1/tien-cho/bao-cao',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query;
    const result = await baoCaoTienCho(ctx, {
      tuThang: str(q['tuThang']) ?? '',
      denThang: str(q['denThang']) ?? '',
      tids: numArr(q['tids']),
      cards: numArr(q['cards']),
      daiLy: numArr(q['daiLy']),
      doiTac: numArr(q['doiTac']),
      banks: numArr(q['banks']),
      hkd: strArr(q['hkd'])
    });
    res.status(statusFor(result)).json(result);
  })
);
