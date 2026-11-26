// TÀI KHOẢN DIGISTORE PER-MÃ QR (Admin Demo 5/9) — set/get creds cho mã QR (tids kind='QR') từ SigMa desktop.
// LỚP LIVE (R201): renderer TidPage → window.api.qrDigistoreCredSet/Get → httpCall('/v1/qr-digistore/...') → route này
// (quanly-api) → encryptSecret(@sigma/services) + UPSERT qr_digistore_cred. KHÔNG đụng bot-api (bot-api chỉ ĐỌC creds
// đã mã hoá để poll báo-có; bảng dùng CHUNG). Link DigiStore MẶC ĐỊNH BVBank chung → base optional (rỗng → NULL →
// resolver dùng DIGISTORE_BASE || default). Chỉ username + password per mã.
//
// BẢO MẬT: password mã hoá AES-256-GCM (encryptSecret, khoá env DIGISTORE_ENC_KEY off-repo) — CẤM lưu/log plaintext.
// GET KHÔNG trả password (chỉ configured/username/base). Quyền: set = CONFIG_TID_MANAGE (như thêm/sửa cấu hình mã QR
// ở TidPage), get = CONFIG_TID_VIEW hoặc CONFIG_TID_MANAGE.
//
// R198 (không nuốt lỗi im): encryptSecret NÉM khi thiếu/khoá sai → route trả finding RÕ (500 + code + message), KHÔNG
// lưu plaintext lén, KHÔNG nuốt câm.
import { Router, type Request, type Response } from 'express';
import { encryptSecret, DigistoreSecretError, ensureAlphaExtraSchemaOnce } from '@sigma/services';
import { hasPermission } from '@sigma/shared';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, num, str } from './_ctx.js';

export const qrDigistoreRouter = Router();

const MANAGE = 'CONFIG_TID_MANAGE'; // set-cred = quản lý cấu hình mã QR (khớp quyền "Thêm mã QR" ở TidPage)
const VIEW = 'CONFIG_TID_VIEW';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền cấu hình tài khoản DigiStore cho mã QR.';

// POST /v1/qr-digistore/cred — LƯU/CẬP NHẬT creds DigiStore cho 1 mã QR. Body {tidId, username, password, base?}.
// encryptSecret(password) + UPSERT qr_digistore_cred (ON CONFLICT tid_id). KHÔNG log password.
qrDigistoreRouter.post(
  '/v1/qr-digistore/cred',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!hasPermission(ctx.user, MANAGE)) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const tidId = num(b['tidId']);
    const username = str(b['username']);
    const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
    const base = str(b['base']) ?? null;
    if (tidId === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu mã QR (tidId).' });
      return;
    }
    if (!username) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Vui lòng nhập tài khoản (User) DigiStore.' });
      return;
    }
    if (!password) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Vui lòng nhập mật khẩu DigiStore.' });
      return;
    }
    // Mã QR phải tồn tại + đúng kind='QR' + chưa xoá (không cấu hình creds cho TID POS).
    const rows = (await ctx.db.$queryRawUnsafe(
      `SELECT id FROM tids WHERE id = $1 AND kind = 'QR' AND deleted_at IS NULL LIMIT 1`,
      tidId
    )) as Array<{ id: number }>;
    if (!rows.length) {
      res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy mã QR (hoặc không phải mã QR bán hàng).' });
      return;
    }
    // encryptSecret NÉM DigistoreSecretError nếu thiếu/khoá sai (R198) → trả finding RÕ, KHÔNG lưu plaintext.
    let passwordEnc: string;
    try {
      passwordEnc = encryptSecret(password);
    } catch (err) {
      if (err instanceof DigistoreSecretError) {
        res.status(500).json({ ok: false, error: err.code, message: err.message });
        return;
      }
      throw err;
    }
    await ensureAlphaExtraSchemaOnce(ctx.db); // best-effort (idempotent) — bảng thường đã có lúc boot
    await ctx.db.$executeRawUnsafe(
      `INSERT INTO qr_digistore_cred (tid_id, base, username, password_enc, updated_at)
         VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tid_id) DO UPDATE SET
         base = EXCLUDED.base, username = EXCLUDED.username, password_enc = EXCLUDED.password_enc, updated_at = now()`,
      tidId,
      base && base.trim() ? base.trim() : null,
      username,
      passwordEnc
    );
    res.json({ ok: true, configured: true, username, base: base && base.trim() ? base.trim() : null });
  })
);

// GET /v1/qr-digistore/cred/:tidId — trạng thái cấu hình creds (KHÔNG trả password). {configured, username, base, isQr}.
// isQr = mã này có phải mã QR bán hàng (tids.kind='QR') — để UI sửa TID CHỈ hiện mục DigiStore cho mã QR (POS ẩn).
qrDigistoreRouter.get(
  '/v1/qr-digistore/cred/:tidId',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!hasPermission(ctx.user, VIEW) && !hasPermission(ctx.user, MANAGE)) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
      return;
    }
    const tidId = num(req.params.tidId);
    if (tidId === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã QR không hợp lệ.' });
      return;
    }
    const tidRows = (await ctx.db.$queryRawUnsafe(
      `SELECT (kind = 'QR') AS "isQr" FROM tids WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      tidId
    )) as Array<{ isQr: boolean }>;
    const isQr = tidRows.length > 0 && tidRows[0].isQr === true;
    const rows = (await ctx.db.$queryRawUnsafe(
      `SELECT username AS "username", base AS "base" FROM qr_digistore_cred WHERE tid_id = $1 LIMIT 1`,
      tidId
    )) as Array<{ username: string; base: string | null }>;
    if (!rows.length) {
      res.json({ ok: true, configured: false, username: null, base: null, isQr });
      return;
    }
    res.json({ ok: true, configured: true, username: rows[0].username, base: rows[0].base ?? null, isQr });
  })
);
