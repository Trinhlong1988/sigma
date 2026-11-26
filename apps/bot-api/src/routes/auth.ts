// SIGMA Phase 1 (23/7, CMD_BUILD) — 3 endpoint đăng ký/đăng nhập qua Rocket.Chat (kế hoạch mục A + D.1).
// Route MỚI này KHÔNG dùng requireBearerAuth (Bearer cũ) — là endpoint public cho client tự đăng ký/xác
// thực OTP, đúng bản chất "trước khi có bất kỳ danh tính nào". Route nghiệp vụ CŨ (agents.ts/lo.ts) GIỮ
// NGUYÊN Bearer ở Phase 1 này (đổi auth của chúng là việc Phase 3, ngoài phạm vi task này).
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { getBotDb } from '../db.js';
import { createOtpChallenge, verifyOtpChallenge, finalizeOtpChallenge, releaseOtpChallenge } from '../otp-service.js';
import { issueDeviceToken, validateAndTouchDeviceToken } from '../device-trust-service.js';
import { sendOtpEmail, OtpSmtpNotConfiguredError } from '../email-service.js';
import { requireSession } from '../session-middleware.js';
import { asyncHandler } from '../async-handler.js';
import { revokeWebSession, revokeAllWebSessionsForAgent, finalizeLoginSession, setWebSessionCookie, clearWebSessionCookie, WEB_SESSION_COOKIE_NAME } from '../web-session-service.js';
import { broadcastToAgent } from '../chat-realtime-hub.js';
import { hashPassword, verifyPasswordHash } from '../password-service.js';
import { verifyGoogleIdToken, exchangeGoogleAuthCode } from '../google-oauth-service.js';
import { USERNAME_REGEX } from '@sigma/shared';
import { Prisma, nextCode, type Agent } from '@sigma/database';
import { randomBytes } from 'node:crypto';

// B58 (30/7) — Agent.code prefix dùng cho MỌI đại lý tự tạo qua bot-api (verify-otp + Google) — "DL" (Đại
// Lý), 2 chữ cái hợp lệ theo CODE_PREFIX_REGEX (@sigma/business-rules). Hằng số DUY NHẤT, tránh gõ tay literal
// 'DL' lặp lại ở 2 call site (createAgentViaGoogle + verify-otp) rồi lệch nhau về sau.
const AGENT_CODE_PREFIX = 'DL';

/** true nếu err là lỗi VI PHẠM UNIQUE CONSTRAINT thật của Prisma (P2002) — dùng để phân biệt "race condition
 * tạo trùng, phục hồi được" khỏi lỗi hệ thống khác (audit độc lập 28/7 chỉ ra: catch-all trước đây coi MỌI lỗi
 * là race, có thể nuốt nhầm lỗi hạ tầng thật). */
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export const authRouter = Router();

// #3 (6/8, Admin Demo "đăng nhập máy mới đá phiên CŨ CÙNG NỀN như Zalo") ──────────────────────────────────────
/** Ép header thô (string | string[] | undefined) về string | undefined — header tùy chỉnh 1 giá trị. */
function headerString(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}


const REGISTER_PURPOSE = 'AGENT_REGISTER';
// Regex kiểm tra dạng email cơ bản (KHÔNG cố gắng bao phủ RFC 5322 đầy đủ — chỉ chặn input rõ ràng sai dạng
// trước khi tốn 1 lượt gửi mail/ghi DB, đúng mức "validate cơ bản" spec yêu cầu).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// SECURITY AUDIT FIX (HIGH) — request-otp KHÔNG rate limit trước đây → 1 caller có thể spam gửi mail OTP tới
// bất kỳ email nào (email-bomb nạn nhân) VÀ dễ tiêu hết quota gửi/ngày của Gmail SMTP dùng chung, làm hỏng
// việc gửi OTP cho TẤT CẢ agent khác. Áp 2 limiter độc lập chỉ trên route request-otp (KHÔNG áp toàn app —
// không đụng route khác ngoài phạm vi audit):
//   - Per-IP: chặn 1 IP spam nhiều email khác nhau.
//   - Per-email: chặn 1 email bị nhắm liên tục dù request đến từ nhiều IP khác nhau.
// Trả 429 cùng khuôn JSON lỗi {error, message} như các lỗi khác trong file này.
const requestOtpIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu từ địa chỉ IP này, vui lòng thử lại sau.' }
});

const requestOtpEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Khóa theo email (KHÔNG theo IP mặc định) — cần req.body.email đã có sẵn (express.json() chạy trước ở
  // app.ts, xem createApp()). Email rỗng/không hợp lệ dùng chung 1 bucket 'unknown' — validate email thật sự
  // xảy ra ở handler bên dưới NGAY SAU limiter này, không phải việc của limiter.
  keyGenerator: (req) => {
    const email = (req.body as { email?: string } | undefined)?.email;
    return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : 'unknown';
  },
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu mã OTP cho email này, vui lòng thử lại sau.' }
});

// 24/7 (Admin Demo yêu cầu) — "Quên mật khẩu" + "đăng nhập bằng SĐT nếu có" dùng CHUNG khuôn rate-limit với
// request-otp đăng ký (2 limiter riêng, KHÔNG share bucket với REGISTER_PURPOSE — 1 email vừa đăng ký vừa
// quên mật khẩu trong cùng giờ không nên đụng trần của nhau).
const PASSWORD_RESET_PURPOSE = 'PASSWORD_RESET';
const forgotPasswordIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu từ địa chỉ IP này, vui lòng thử lại sau.' }
});
const forgotPasswordEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = (req.body as { email?: string } | undefined)?.email;
    return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : 'unknown';
  },
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu mã cho email này, vui lòng thử lại sau.' }
});
// resolve-phone lộ "SĐT này có tồn tại tài khoản không" qua 200/404 — chấp nhận được (đăng nhập vốn đã lộ
// tương tự qua sai mật khẩu/không tìm thấy tài khoản), nhưng vẫn rate-limit theo IP để chặn dò hàng loạt.
const resolvePhoneIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu từ địa chỉ IP này, vui lòng thử lại sau.' }
});

// 25/7 (Phase 3 — thiết bị tin cậy) — /login/device-bypass nhận CẢ mật khẩu lẫn vé nhớ máy trong 1 request,
// nhạy cảm hơn resolve-phone thuần túy → rate-limit CÙNG khuôn request-otp (per-IP + per-email), chặn dò mật
// khẩu hàng loạt kể cả khi kẻ tấn công có sẵn 1 vé nhớ máy đánh cắp được.
const deviceBypassIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu từ địa chỉ IP này, vui lòng thử lại sau.' }
});
const deviceBypassEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = (req.body as { email?: string } | undefined)?.email;
    return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : 'unknown';
  },
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu đăng nhập cho email này, vui lòng thử lại sau.' }
});

// ── SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — tách vai trò xác thực mật khẩu ra khỏi RC ──────────────────
// 4/8 hoàn tất LOẠI RC — sau khi xoá hết tài khoản cũ (chỉ còn tài khoản có passwordHash + tài khoản mới độc
// lập RC), xác thực mật khẩu CHỈ còn đường nội bộ bcrypt. Không còn round-trip RC → chỉ 2 kết cục: LOCAL_OK
// (bcrypt khớp) | FAILED (không khớp / không có passwordHash). Bỏ RC_OK/RC_TOTP_REQUIRED/ERROR (RC đã cắt).
type AgentPasswordCheckResult =
  | { outcome: 'LOCAL_OK' }
  | { outcome: 'FAILED' };

/**
 * Kiểm mật khẩu cho 1 lần đăng nhập — ƯU TIÊN đường NỘI BỘ (bcrypt, KHÔNG gọi RC) nếu Agent đã có
 * `passwordHash`; CHỈ fallback qua RC (`rcLogin`, đường CŨ) khi Agent CHƯA có `passwordHash` (tài khoản cũ
 * đăng ký trước Phase 1 này, chưa backfill — HOẶC tài khoản Google thuần chưa từng đặt mật khẩu nội bộ, trường
 * hợp sau sẽ luôn FAILED vì mật khẩu RC của họ là chuỗi ngẫu nhiên không ai biết, đúng ý muốn: họ phải dùng
 * nút Google, không dùng mật khẩu). Fallback XÁC NHẬN mật khẩu đúng (RC_OK hoặc RC_TOTP_REQUIRED, CẢ HAI đều
 * nghĩa là RC đã kiểm mật khẩu khớp) → BACKFILL `passwordHash` NGAY (best-effort, KHÔNG chặn đăng nhập nếu ghi
 * lỗi) để lần sau đi thẳng đường nội bộ, không gọi RC nữa.
 */
// 4/8 LOẠI RC — bcrypt hash CỐ ĐỊNH (cost 10, khớp BCRYPT_ROUNDS) dùng để cân bằng thời gian phản hồi khi email
// KHÔNG tồn tại (agent==null): so 1 lần bcrypt "giả" tốn thời gian tương đương verify thật → kẻ tấn công KHÔNG
// phân biệt được "email có/không tồn tại" qua timing. Hash của 1 chuỗi vô nghĩa — KHÔNG phải mật khẩu thật.
const DUMMY_TIMING_HASH = '$2b$10$Q9nmaHSjkfaanl1ClZnHv.niN9HBehVNArnc2/hXfkDrrgMqZWi.G';

async function checkAgentPassword(
  agent: Agent | null,
  password: string
): Promise<AgentPasswordCheckResult> {
  if (agent?.passwordHash) {
    const ok = await verifyPasswordHash(password, agent.passwordHash);
    return ok ? { outcome: 'LOCAL_OK' } : { outcome: 'FAILED' };
  }

  // 4/8 hoàn tất LOẠI RC — không còn round-trip Rocket.Chat. Tài khoản KHÔNG có passwordHash:
  //  - `agent == null` (email không tồn tại): chạy 1 bcrypt GIẢ (cùng cost với verify thật) để cân bằng thời
  //    gian phản hồi → chống dò email tồn tại/không qua timing.
  //  - Agent tồn tại nhưng chưa đặt mật khẩu nội bộ (Google-only, hoặc legacy chưa backfill): FAILED — họ dùng
  //    nút Google hoặc "Quên mật khẩu" để đặt passwordHash. KHÔNG gọi rcLogin/rcGetUserTotpEnabled (đã cắt hẳn).
  if (!agent) await verifyPasswordHash(password, DUMMY_TIMING_HASH);
  return { outcome: 'FAILED' };
}

type CreateAgentViaGoogleResult =
  | { ok: true; agent: Agent }
  | { ok: false; status: number; error: string; message: string };

// BUG THẬT (Admin Demo 14/8 "đăng nhập lần đầu bằng gmail, xem QR báo chưa liên kết, không có QR") — GỐC: tài khoản
// tạo qua Google có rcUsername = null (createAgentViaGoogle không set), mà rcUsername chính là @handle DUY NHẤT dùng
// cho: (1) mã QR kết bạn (MyQrScreen sinh QR từ URL /app/u/:rcUsername), (2) tra hồ sơ công khai, (3) tag @-mention.
// null → 3 tính năng đó chết + MyQrScreen hiện nhầm "Chưa liên kết tài khoản". OTP-register luôn có rcUsername (user
// tự chọn) nên không dính. FIX: mọi tài khoản Google được CẤP @handle tự sinh (khớp USERNAME_REGEX [A-Za-z0-9]{8,}),
// vừa cho tài khoản mới (createAgentViaGoogle) vừa BACKFILL tài khoản cũ đang null ở lần đăng nhập kế (resolveOrCreate).
function stripToHandle(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[Đđ]/g, 'd').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}
/** Ứng viên @handle từ tên (ưu tiên) / local-part email, thêm hậu tố số để né trùng; LUÔN ≥8 ký tự alnum. */
function candidateHandle(name: string, email: string, salt: number): string {
  let base = stripToHandle(name) || stripToHandle((email.split('@')[0] ?? '')) || 'alpha';
  base = base.slice(0, 16);
  const suffix = salt === 0 ? '' : String(salt);
  let cand = base + suffix;
  if (cand.length < 8) cand = base + '0'.repeat(8 - cand.length) + suffix; // đệm '0' TRƯỚC hậu tố để đủ 8, vẫn khớp regex
  return cand.slice(0, 24);
}
/** Đảm bảo agent có rcUsername (@handle @unique). Đã có → trả nguyên. Chưa có (Google-only cũ/mới) → sinh + lưu,
 *  thử nhiều hậu tố nếu trùng (findFirst + P2002 catch cho race). Fallback cực hiếm: theo id + thời gian (alnum). */
async function ensureRcUsername(db: ReturnType<typeof getBotDb>, agent: Agent): Promise<Agent> {
  if (agent.rcUsername) return agent;
  for (let salt = 0; salt < 60; salt++) {
    const cand = candidateHandle(agent.name ?? '', agent.email ?? '', salt);
    if (!USERNAME_REGEX.test(cand)) continue;
    const exists = await db.agent.findFirst({ where: { rcUsername: cand }, select: { id: true } });
    if (exists) continue;
    try {
      return await db.agent.update({ where: { id: agent.id }, data: { rcUsername: cand } });
    } catch (err) {
      if (isUniqueConstraintError(err)) continue; // race sát nút: agent khác vừa chiếm handle → thử hậu tố kế
      throw err;
    }
  }
  const fb = ('u' + agent.id + 'x' + Date.now().toString(36)).replace(/[^A-Za-z0-9]/g, '');
  const fallback = (fb.length >= 8 ? fb : fb + '00000000').slice(0, 24);
  return db.agent.update({ where: { id: agent.id }, data: { rcUsername: fallback } });
}

/** Tạo Agent MỚI hoàn toàn qua Google (chưa từng có tài khoản SigMa nào khớp googleId/email).
 * 4/8 LOẠI RC khỏi auth — KHÔNG còn tạo user Rocket.Chat "nền": Agent tạo CHỈ từ dữ liệu Google
 * (googleId/email/name), rcUserId/rcUsername = null (phiên đăng nhập độc lập RC), passwordHash = null (tài
 * khoản Google-only, đăng nhập bằng nút Google, không có mật khẩu nội bộ). */
async function createAgentViaGoogle(
  db: ReturnType<typeof getBotDb>,
  input: { googleId: string; email: string; name: string }
): Promise<CreateAgentViaGoogleResult> {
  try {
    // B58 fix (30/7) — agent.create PHẢI set `code` (nextCode) để "thêm bạn qua mã đại lý" hoạt động giữa các
    // đại lý tự đăng ký (findAliveAgentByCode đòi khớp code khác null). nextCode(tx) + agent.create nằm CÙNG 1
    // transaction — nếu create lỗi (kể cả race P2002 bắt ở catch bên dưới), counter cũng rollback theo.
    const agent = await db.$transaction(async (tx) => {
      const code = await nextCode(AGENT_CODE_PREFIX, tx);
      return tx.agent.create({
        data: { code, name: input.name, email: input.email, googleId: input.googleId }
      });
    });
    return { ok: true, agent };
  } catch (err) {
    // Race hiếm: 2 request Google-login đồng thời cùng email/googleId MỚI — request thua gặp lỗi unique
    // constraint Prisma (P2002). Dùng lại hàng đã được request THẮNG tạo, KHÔNG lỗi 500 cho request thua.
    // AUDIT FIX (LOW, độc lập 28/7) — CHỈ coi là race khi ĐÚNG P2002 (unique constraint) — lỗi khác luôn ném lại.
    if (!isUniqueConstraintError(err)) throw err;
    const existing = await db.agent.findFirst({ where: { OR: [{ googleId: input.googleId }, { email: input.email }] } });
    if (existing) {
      console.warn(`[bot-api] createAgentViaGoogle: race condition tạo trùng Agent (email=${input.email}) — dùng hàng đã tạo trước.`, err);
      return { ok: true, agent: existing };
    }
    throw err;
  }
}

// POST /v1/auth/register/request-otp — {email} → tạo challenge OTP + gửi mail. Luôn trả {ok:true} khi việc
// GỬI thành công (KHÔNG lộ có/không có tài khoản/đại lý đã tồn tại ứng với email này — chống dò email).
// Lỗi hạ tầng (SMTP chưa cấu hình / gửi thất bại) KHÔNG bị nuốt câm — trả 500 rõ ràng (đây là lỗi hệ thống,
// không phải tín hiệu về sự tồn tại tài khoản, nên không vi phạm nguyên tắc chống dò email ở trên).
authRouter.post('/v1/auth/register/request-otp', requestOtpIpLimiter, requestOtpEmailLimiter, asyncHandler(async (req, res) => {
  const body = req.body as { email?: string };
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'VALIDATION', message: 'email không hợp lệ.' });
    return;
  }

  const db = getBotDb();
  const challenge = await createOtpChallenge(db, email, REGISTER_PURPOSE);
  try {
    await sendOtpEmail(email, challenge.code);
  } catch (err) {
    if (err instanceof OtpSmtpNotConfiguredError) {
      res.status(500).json({ error: 'OTP_SMTP_NOT_CONFIGURED', message: err.message });
      return;
    }
    // 24/7 (Admin Demo: "không có chỗ nào tiếng Anh") — err.message ở đây là lỗi hạ tầng Nodemailer/Gmail SMTP
    // thật (vd "Invalid login", "Connection timeout") — LUÔN tiếng Anh, KHÔNG có bảng dịch cố định vì phụ
    // thuộc SMTP server, KHÁC OTP_SMTP_NOT_CONFIGURED (message tự viết sẵn tiếng Việt ở email-service.ts, giữ
    // nguyên). Dùng câu chung tiếng Việt thay vì forward nguyên văn.
    res.status(500).json({ error: 'OTP_SEND_FAILED', message: 'Gửi email mã xác thực thất bại, vui lòng thử lại sau.' });
    return;
  }
  res.json({ ok: true });
}));

interface VerifyOtpRequestBody {
  email?: string;
  code?: string;
  username?: string;
  password?: string;
  name?: string;
  // Mở rộng form đăng ký (24/7, Admin Demo yêu cầu) — CẢ 3 field này KHÔNG bắt buộc ở tầng validate (gender/
  // dateOfBirth optional theo UI, phone CHƯA bắt buộc theo đúng lời Admin Demo "tạm thời số điện thoại chưa
  // bắt buộc sau mới áp dụng").
  gender?: string;
  dateOfBirth?: string; // ISO date "YYYY-MM-DD"
  phone?: string;
}

const ALLOWED_GENDERS = new Set(['MALE', 'FEMALE', 'OTHER']);

// POST /v1/auth/register/verify-otp — {email, code, username, password, name} → verify OTP → tạo Agent MỚI
// hoàn toàn NỘI BỘ (4/8 LOẠI RC): passwordHash (bcrypt) là nguồn xác thực thật, username lưu vào rcUsername
// (@unique, tên đăng nhập nội bộ), rcUserId = null (phiên đăng nhập độc lập RC). KHÔNG còn gọi rcCreateUser.
//
// MỌI lần verify-otp thành công đều TẠO Agent MỚI (name lấy từ input). Nếu về sau cần map vào Agent chờ gán
// sẵn (theo code có trước), bổ sung cách map tường minh (vd nhập agentCode lúc đăng ký) — KHÔNG tự suy đoán.
authRouter.post('/v1/auth/register/verify-otp', asyncHandler(async (req, res) => {
  const body = req.body as VerifyOtpRequestBody;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!email || !EMAIL_RE.test(email) || !code || !username || !password || !name) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu hoặc sai định dạng email/code/username/password/name.' });
    return;
  }
  // SECURITY AUDIT FIX (LOW) — trước đây KHÔNG có ràng buộc độ mạnh mật khẩu, agent tự đăng ký có thể đặt
  // mật khẩu rỗng-tối-thiểu (vd "1") cho tài khoản Rocket.Chat thật. Chặn SỚM (trước khi tiêu 1 lượt thử
  // verifyOtpChallenge/gọi rcCreateUser) — chỉ kiểm độ dài tối thiểu, KHÔNG suy đoán thêm rule phức tạp
  // (chữ hoa/số/ký tự đặc biệt) ngoài phạm vi finding audit.
  if (password.length < 8) {
    res.status(400).json({ error: 'VALIDATION', message: 'Mật khẩu phải có ít nhất 8 ký tự.' });
    return;
  }

  // Hồ sơ mở rộng (24/7) — gender/dateOfBirth optional (UI không bắt buộc), phone CHƯA bắt buộc theo đúng
  // lời Admin Demo. Validate ĐỊNH DẠNG nếu có gửi (KHÔNG bắt buộc phải gửi), tránh lưu rác vào DB.
  const genderRaw = typeof body?.gender === 'string' ? body.gender.trim().toUpperCase() : '';
  if (genderRaw && !ALLOWED_GENDERS.has(genderRaw)) {
    res.status(400).json({ error: 'VALIDATION', message: 'gender phải là MALE/FEMALE/OTHER.' });
    return;
  }
  const dateOfBirthRaw = typeof body?.dateOfBirth === 'string' ? body.dateOfBirth.trim() : '';
  let dateOfBirth: Date | null = null;
  if (dateOfBirthRaw) {
    const parsed = new Date(dateOfBirthRaw);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: 'VALIDATION', message: 'dateOfBirth phải là ngày hợp lệ (YYYY-MM-DD).' });
      return;
    }
    // Chặn năm vô lý (vd 9999 / 0100): new Date() nuốt được nhưng không phải ngày sinh thật. Bound 1900..nay.
    const yob = parsed.getUTCFullYear();
    if (yob < 1900 || yob > new Date().getUTCFullYear()) {
      res.status(400).json({ error: 'VALIDATION', message: 'dateOfBirth phải trong khoảng năm 1900 đến năm hiện tại.' });
      return;
    }
    dateOfBirth = parsed;
  }
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';

  const db = getBotDb();
  // Email UNIQUE trên Agent (migration 20260724180000) — kiểm trùng SỚM, tránh verifyOtpChallenge/rcCreateUser
  // chạy xong rồi mới vỡ ở bước cuối (đã tạo user Rocket.Chat thật nhưng agent.create lỗi unique constraint).
  const existingByEmail = await db.agent.findFirst({ where: { email } });
  if (existingByEmail) {
    res.status(400).json({ error: 'EMAIL_ALREADY_REGISTERED', message: 'Email này đã đăng ký tài khoản trước đó — hãy đăng nhập thay vì đăng ký lại.' });
    return;
  }
  // B1/B2 fix (24/7, CMD_BUILD theo finding CMD_AUDIT 23/7 — xem otp-service.ts): verifyOtpChallenge giờ chỉ
  // CLAIM mã đúng (verifiedAt), KHÔNG tiêu dùng ngay (consumedAt) — tiêu dùng thật CHỈ sau khi tạo Agent THÀNH
  // CÔNG (finalizeOtpChallenge). Nếu tạo Agent THẤT BẠI vì trùng tên đăng nhập/email (P2002) →
  // releaseOtpChallenge nhả claim, CÙNG mã OTP đó verify lại được (user đổi username rồi "Thử lại"), KHÔNG bắt
  // xin mã mới dù lỗi không do họ gõ sai OTP.
  const verify = await verifyOtpChallenge(db, email, REGISTER_PURPOSE, code);
  if (verify.outcome !== 'OK') {
    const status = verify.outcome === 'TOO_MANY_ATTEMPTS' ? 429 : verify.outcome === 'IN_PROGRESS' ? 409 : 400;
    res.status(status).json({ error: `OTP_${verify.outcome}`, message: otpOutcomeMessage(verify.outcome) });
    return;
  }
  // verify.outcome === 'OK' → verifyOtpChallenge LUÔN trả kèm challengeId (xem VerifyOtpResult), nhưng vẫn
  // kiểm tường minh thay vì `!` — tránh 1 lớp lỗi "quên set challengeId" âm thầm lọt qua typecheck.
  if (verify.challengeId == null) {
    res.status(500).json({ error: 'OTP_INTERNAL', message: 'Xác minh OTP thiếu challengeId nội bộ — báo lỗi hệ thống.' });
    return;
  }
  const challengeId = verify.challengeId;

  // 4/8 LOẠI RC khỏi auth — KHÔNG còn gọi rcCreateUser. Tạo Agent hoàn toàn NỘI BỘ: passwordHash (bcrypt) là
  // NGUỒN THẬT xác thực đăng nhập (xem checkAgentPassword); username client chọn lưu vào `rcUsername` (@unique,
  // đóng vai "tên đăng nhập nội bộ" — RC không còn tham gia, nhưng cột này vẫn là nơi giữ ràng buộc DUY NHẤT
  // của tên đăng nhập). rcUserId = null → phiên đăng nhập độc lập RC (rcAuthToken = null).
  //
  // B58: agent.create PHẢI set `code` (nextCode) để "Thêm bạn qua mã đại lý" hoạt động (findAliveAgentByCode
  // đòi code khác null). nextCode(tx) + agent.create CÙNG 1 transaction — create lỗi thì counter rollback theo.
  let agent: Agent;
  try {
    agent = await db.$transaction(async (tx) => {
      const code = await nextCode(AGENT_CODE_PREFIX, tx);
      return tx.agent.create({
        data: {
          code,
          name,
          rcUsername: username,
          email,
          gender: genderRaw || null,
          dateOfBirth,
          phone: phone || null,
          passwordHash: await hashPassword(password)
        }
      });
    });
  } catch (err) {
    // Trùng tên đăng nhập (rcUsername @unique) HOẶC email (race sát nút với check existingByEmail ở trên) —
    // P2002. NHẢ claim OTP để user đổi username rồi "Thử lại" với CÙNG mã (không đốt oan mã đúng). Lỗi khác
    // (hạ tầng DB...) ném lại nguyên vẹn → errorHandler tập trung, KHÔNG nuốt câm.
    if (!isUniqueConstraintError(err)) throw err;
    await releaseOtpChallenge(db, challengeId);
    res.status(400).json({ error: 'USERNAME_OR_EMAIL_TAKEN', message: 'Tên đăng nhập hoặc email đã được sử dụng, vui lòng chọn tên đăng nhập khác.' });
    return;
  }
  // Agent tạo THÀNH CÔNG → tiêu dùng OTP thật (finalize) — từ đây mã OTP này không dùng lại được nữa.
  await finalizeOtpChallenge(db, challengeId);

  // 4/8 LOẠI RC — mint phiên ĐỘC LẬP RC ngay sau đăng ký (KHÔNG gọi rcCreateLoginTokenForUser nữa): chỉ dựa
  // agentId, rcUserId/rcAuthToken = null. Tài khoản vừa tạo LUÔN có phiên (sessionReady:true) — không còn phụ
  // thuộc RC container sống hay chết. Client dùng cookie httpOnly `sigma_ws` đã set, KHÔNG cần rcLogin.
  // #3 (6/8) — tạo phiên + ĐÁ phiên cũ CÙNG NỀN (đăng ký cũng đá: 1 tài khoản 1 phiên/nền, xem finalizeLoginSession).
  const newSessionId = await finalizeLoginSession(
    db,
    { rcUserId: null, rcUsername: agent.rcUsername, agentId: agent.id },
    { userAgent: headerString(req.headers['user-agent']), platformHeader: headerString(req.headers['x-sigma-platform']) }
  );
  setWebSessionCookie(res, newSessionId);
  // Thiết bị đăng nhập realtime (5/8) — báo MỌI kết nối WS đang mở khác của agent này (nếu có) làm mới danh
  // sách "Thiết bị đang đăng nhập" (màn Bảo mật) ngay khi có thiết bị mới đăng nhập. Best-effort tuyệt đối —
  // broadcastToAgent KHÔNG BAO GIỜ throw + no-op nếu agent chưa có kết nối nào (xem chat-realtime-hub.ts),
  // nên KHÔNG ảnh hưởng gì tới luồng đăng nhập/đăng ký hiện có.
  broadcastToAgent(agent.id, { msg: 'sessions-updated' });
  const sessionReady = true;

  // 25/7 (Phase 3 — thiết bị tin cậy) — máy vừa dùng để đăng ký ĐÃ chứng minh sở hữu email thật (qua OTP ở
  // trên), cấp thẳng luôn 1 vé nhớ máy để lần ĐĂNG NHẬP kế tiếp trên CÙNG máy này không phải qua OTP nữa
  // (xem device-trust-service.ts). Lỗi ở bước này KHÔNG chặn đăng ký (agent đã tạo là kết quả chính) —
  // `deviceToken: null` chỉ khiến máy này bị coi là "thiết bị mới" ở lần đăng nhập kế tiếp, không nghiêm
  // trọng, KHÔNG cần rollback gì.
  let deviceToken: string | null = null;
  try {
    const issued = await issueDeviceToken(db, agent.id, req.headers['user-agent']);
    deviceToken = issued.token;
  } catch (err) {
    console.error('[bot-api] issueDeviceToken thất bại sau khi đăng ký — máy này sẽ bị coi là thiết bị mới ở lần đăng nhập sau:', err);
  }

  res.json({
    ok: true,
    agent: { id: agent.id, code: agent.code, name: agent.name, rcUserId: agent.rcUserId, rcUsername: agent.rcUsername },
    sessionReady,
    deviceToken
  });
}));

// ── Phase 3 (25/7, Admin Demo chốt "thiết bị mới → OTP; thiết bị cũ đã đăng nhập rồi → chỉ cần mật khẩu") ─────
// Thiết bị tin cậy: xem comment đầu file device-trust-service.ts + comment model TrustedDevice (schema.prisma)
// cho toàn bộ thiết kế/lý do. TÓM TẮT: vé nhớ máy KHÔNG thay thế mật khẩu — chỉ thay thế bước 2FA-qua-email.

interface DeviceBypassBody {
  email?: string;
  password?: string;
  deviceToken?: string;
}

// POST /v1/auth/login/device-bypass — {email, password, deviceToken}. THÀNH CÔNG (200 + session) CHỈ KHI cả
// 3 đều đúng: email có Agent thật đã link RC + mật khẩu ĐÚNG (xác minh THẬT qua RC, server-side — RC luôn
// kiểm mật khẩu TRƯỚC khi trả totp-required, đã verify thật bằng curl trước khi viết route này, KHÔNG suy
// đoán) + deviceToken khớp đúng agent này và còn hạn. BẤT KỲ điều kiện nào sai → 401 UNAUTHORIZED chung
// chung (KHÔNG phân biệt "sai mật khẩu" hay "vé hết hạn" hay "email không tồn tại" — tránh lộ thông tin dò
// tài khoản qua endpoint nhạy cảm này; client luôn tự fallback về luồng đăng nhập thường khi gặp 401 ở đây,
// nên không cần thông báo lỗi chi tiết cho người dùng).
authRouter.post('/v1/auth/login/device-bypass', deviceBypassIpLimiter, deviceBypassEmailLimiter, asyncHandler(async (req, res) => {
  const body = req.body as DeviceBypassBody;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const deviceToken = typeof body?.deviceToken === 'string' ? body.deviceToken : '';
  if (!email || !password || !deviceToken) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu email/password/deviceToken.' });
    return;
  }

  const db = getBotDb();
  const agent = await db.agent.findFirst({ where: { email, deletedAt: null } });

  // 4/8 hoàn tất LOẠI RC — checkAgentPassword() chỉ còn LOCAL_OK/FAILED (bcrypt nội bộ). agent==null vẫn chạy 1
  // bcrypt giả bên trong để cân bằng timing (chống dò email). Agent có passwordHash → verify nhanh nội bộ.
  const passwordCheck = await checkAgentPassword(agent, password);
  const passwordOk = passwordCheck.outcome === 'LOCAL_OK';
  // 4/8 LOẠI RC — KHÔNG còn đòi rcUserId/rcUsername (tài khoản mới độc lập RC có 2 field này = null vẫn dùng
  // được "nhớ máy"). Chỉ cần agent tồn tại + mật khẩu đúng.
  if (!agent || !passwordOk) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Đăng nhập thất bại.' });
    return;
  }

  const deviceValid = await validateAndTouchDeviceToken(db, agent.id, deviceToken);
  if (!deviceValid) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Đăng nhập thất bại.' });
    return;
  }

  // 4/8 LOẠI RC — LOCAL_OK: mint session ĐỘC LẬP RC (giống web-login), KHÔNG gọi rcCreateLoginTokenForUser
  // (chỗ trước đây văng 502 khi RC chết). rcUserId đọc từ agent (null với tài khoản mới), rcAuthToken=null.
  // #3 (6/8) — tạo phiên + ĐÁ phiên cũ CÙNG NỀN (đăng nhập lại thiết-bị-tin-cậy cũng là 1 lần đăng nhập).
  const newSessionId = await finalizeLoginSession(
    db,
    { rcUserId: agent.rcUserId ?? null, rcUsername: agent.rcUsername, agentId: agent.id },
    { userAgent: headerString(req.headers['user-agent']), platformHeader: headerString(req.headers['x-sigma-platform']) }
  );
  setWebSessionCookie(res, newSessionId);
  // Thiết bị đăng nhập realtime (5/8) — báo MỌI kết nối WS đang mở khác của agent này (nếu có) làm mới danh
  // sách "Thiết bị đang đăng nhập" (màn Bảo mật) ngay khi có thiết bị mới đăng nhập. Best-effort tuyệt đối —
  // broadcastToAgent KHÔNG BAO GIỜ throw + no-op nếu agent chưa có kết nối nào (xem chat-realtime-hub.ts),
  // nên KHÔNG ảnh hưởng gì tới luồng đăng nhập/đăng ký hiện có.
  broadcastToAgent(agent.id, { msg: 'sessions-updated' });
  res.json({ ok: true });
}));

interface DeviceTokenIssueBody {
  label?: string;
}

// AUDIT FIX (HIGH, phản biện độc lập 25/7) — route này là DUY NHẤT trong file có requireSession nhưng KHÔNG
// rate-limit (mọi route nhạy cảm khác trong file đều có). Session bị đánh cắp tạm thời (XSS/máy dùng chung)
// có thể phát hành VÔ HẠN vé bypass-2FA sống 90 ngày — sống LÂU HƠN cả session bị đánh cắp, thành cửa hậu
// lâu dài. Giới hạn per-agent (KHÔNG phải per-IP — key theo req.agent.id, đọc SAU requireSession đã set):
// 10 vé/giờ đủ dùng nhiều thiết bị thật (điện thoại/máy tính/tablet), chặn phát hành hàng loạt.
const deviceTokenIssueLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.agent?.id ?? 'unknown'),
  message: { error: 'RATE_LIMITED', message: 'Đã cấp quá nhiều vé nhớ máy trong 1 giờ, vui lòng thử lại sau.' }
});

// POST /v1/auth/device-token/issue — cần requireSession (đã đăng nhập ĐẦY ĐỦ, kể cả qua OTP nếu RC yêu cầu).
// Gọi SAU khi luồng đăng nhập thường (có OTP) hoàn tất, để lần đăng nhập KẾ TIẾP trên máy này bỏ qua OTP.
// Limiter đặt SAU requireSession (thứ tự middleware quan trọng — cần req.agent đã set để lấy key theo agent).
authRouter.post('/v1/auth/device-token/issue', asyncHandler(requireSession), deviceTokenIssueLimiter, asyncHandler(async (req, res) => {
  const db = getBotDb();
  const body = req.body as DeviceTokenIssueBody;
  const label = typeof body?.label === 'string' ? body.label : req.headers['user-agent'];
  const issued = await issueDeviceToken(db, req.agent!.id, label);
  res.json({ token: issued.token, expiresAt: issued.expiresAt });
}));

// AUDIT FIX (LOW, phản biện độc lập 25/7) — TRƯỚC ĐÂY không có cách nào thu hồi vé nhớ máy (trừ thao tác DB
// tay hoặc chờ hết hạn 90 ngày) — user nghi ngờ máy/vé bị lộ không có cách tự "đăng xuất từ xa mọi thiết bị"
// qua app. Thu hồi TẤT CẢ vé của agent hiện tại (KHÔNG phân biệt vé nào — đơn giản + an toàn hơn: server
// KHÔNG biết vé nào đang dùng ở request này vì device-bypass là public route không gắn session vào request
// issue). requireSession — chỉ chính chủ (đã đăng nhập đầy đủ) mới thu hồi được vé của mình.
authRouter.post('/v1/auth/device-token/revoke-all', asyncHandler(requireSession), asyncHandler(async (req, res) => {
  const db = getBotDb();
  const deleted = await db.trustedDevice.deleteMany({ where: { agentId: req.agent!.id } });
  res.json({ ok: true, revokedCount: deleted.count });
}));

function otpOutcomeMessage(outcome: 'EXPIRED' | 'WRONG_CODE' | 'TOO_MANY_ATTEMPTS' | 'NOT_FOUND' | 'IN_PROGRESS'): string {
  switch (outcome) {
    case 'EXPIRED':
      return 'Mã OTP đã hết hạn, vui lòng yêu cầu mã mới.';
    case 'WRONG_CODE':
      return 'Mã OTP không đúng.';
    case 'TOO_MANY_ATTEMPTS':
      return 'Đã nhập sai quá số lần cho phép, vui lòng yêu cầu mã mới.';
    case 'NOT_FOUND':
      return 'Không tìm thấy yêu cầu OTP cho email này, vui lòng yêu cầu mã mới.';
    case 'IN_PROGRESS':
      return 'Yêu cầu đăng ký với mã này đang được xử lý, vui lòng thử lại sau vài giây.';
  }
}

// GET /v1/auth/me — cần requireSession (header x-rc-auth-token/x-rc-user-id), trả thông tin Agent đã link.
// requireSession CŨNG là async (gọi rcGetMe + db.agent.findFirst) — bọc asyncHandler luôn (KHÔNG chỉ handler
// cuối), vì asyncHandler nhận đúng dạng (req,res,next)=>Promise<void> mà middleware này cũng khớp, và lỗi bên
// trong nó (vd Rocket.Chat network down) là CÙNG lớp bug crash-process, không riêng gì handler cuối chuỗi.
authRouter.get('/v1/auth/me', asyncHandler(requireSession), (req, res) => {
  res.json({ agent: req.agent });
});

// ── Quên mật khẩu (24/7, Admin Demo yêu cầu) ───────────────────────────────────────────────────────────────
// POST /v1/auth/forgot-password/request-otp — {email} → CÙNG khuôn request-otp đăng ký (chống dò email:
// LUÔN trả {ok:true} kể cả email không có tài khoản nào — chỉ KHÔNG gửi mail thật nếu không tìm thấy Agent,
// nhưng response y hệt để không lộ tồn tại/không tồn tại qua status code hay message).
authRouter.post('/v1/auth/forgot-password/request-otp', forgotPasswordIpLimiter, forgotPasswordEmailLimiter, asyncHandler(async (req, res) => {
  const body = req.body as { email?: string };
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'VALIDATION', message: 'email không hợp lệ.' });
    return;
  }

  const db = getBotDb();
  const agent = await db.agent.findFirst({ where: { email, deletedAt: null } });
  // 4/8 LOẠI RC — gửi mã cho MỌI Agent tồn tại (KHÔNG còn đòi `agent.rcUserId`): tài khoản tạo độc lập RC sau
  // ngày 4/8 có rcUserId = null nhưng VẪN đặt lại mật khẩu nội bộ (passwordHash) được — đòi rcUserId sẽ khoá
  // vĩnh viễn "Quên mật khẩu" cho các tài khoản mới đó.
  if (agent) {
    const challenge = await createOtpChallenge(db, email, PASSWORD_RESET_PURPOSE);
    try {
      await sendOtpEmail(email, challenge.code);
    } catch (err) {
      if (err instanceof OtpSmtpNotConfiguredError) {
        res.status(500).json({ error: 'OTP_SMTP_NOT_CONFIGURED', message: err.message });
        return;
      }
      // 24/7 (Admin Demo: "không có chỗ nào tiếng Anh") — cùng lý do với route request-otp đăng ký ở trên: lỗi
      // SMTP thật luôn tiếng Anh, không forward nguyên văn.
      res.status(500).json({ error: 'OTP_SEND_FAILED', message: 'Gửi email mã xác thực thất bại, vui lòng thử lại sau.' });
      return;
    }
  }
  // Email không tồn tại/chưa link RC → im lặng, KHÔNG tạo challenge/gửi mail, nhưng response GIỐNG HỆT
  // trường hợp thành công (chống dò email, cùng nguyên tắc route request-otp đăng ký ở trên).
  res.json({ ok: true });
}));

interface ForgotPasswordResetBody {
  email?: string;
  code?: string;
  newPassword?: string;
}

// POST /v1/auth/forgot-password/reset — {email, code, newPassword} → verify OTP thật → đổi mật khẩu RC
// thật qua quyền admin (rcSetUserPassword, KHÔNG cần mật khẩu cũ — đúng bản chất "quên").
authRouter.post('/v1/auth/forgot-password/reset', asyncHandler(async (req, res) => {
  const body = req.body as ForgotPasswordResetBody;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
  if (!email || !EMAIL_RE.test(email) || !code) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu hoặc sai định dạng email/code.' });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: 'VALIDATION', message: 'Mật khẩu mới phải có ít nhất 8 ký tự.' });
    return;
  }

  const db = getBotDb();
  const verify = await verifyOtpChallenge(db, email, PASSWORD_RESET_PURPOSE, code);
  if (verify.outcome !== 'OK') {
    const status = verify.outcome === 'TOO_MANY_ATTEMPTS' ? 429 : verify.outcome === 'IN_PROGRESS' ? 409 : 400;
    res.status(status).json({ error: `OTP_${verify.outcome}`, message: otpOutcomeMessage(verify.outcome) });
    return;
  }
  if (verify.challengeId == null) {
    res.status(500).json({ error: 'OTP_INTERNAL', message: 'Xác minh OTP thiếu challengeId nội bộ — báo lỗi hệ thống.' });
    return;
  }
  const challengeId = verify.challengeId;

  // Mã ĐÚNG nhưng Agent không còn tồn tại (vd tài khoản đã bị xóa GIỮA lúc OTP còn sống) — nhả claim (KHÔNG
  // tiêu OTP oan), trả lỗi rõ. 4/8 LOẠI RC — KHÔNG còn đòi `agent.rcUserId` (tài khoản độc lập RC có rcUserId
  // = null vẫn đặt lại mật khẩu nội bộ được).
  const agent = await db.agent.findFirst({ where: { email, deletedAt: null } });
  if (!agent) {
    await releaseOtpChallenge(db, challengeId);
    res.status(404).json({ error: 'AGENT_NOT_FOUND', message: 'Không tìm thấy tài khoản ứng với email này.' });
    return;
  }

  // SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — passwordHash nội bộ giờ là NGUỒN THẬT quyết định đăng nhập
  // được hay không (xem checkAgentPassword()) — đây là bước BLOCKING, phải thành công request mới OK.
  await db.agent.update({ where: { id: agent.id }, data: { passwordHash: await hashPassword(newPassword) } });

  // SECURITY (Vòng 2.5 AUTH hardening 3/8) — đổi mật khẩu PHẢI vô hiệu hóa MỌI phiên đang sống của agent.
  // Nếu không, 1 phiên đã bị đánh cắp (cookie `sigma_ws` lộ qua XSS/máy dùng chung) vẫn sống tới 30 ngày
  // BẤT CHẤP nạn nhân đã đặt lại mật khẩu để giành lại quyền kiểm soát — việc reset trở nên vô nghĩa như một
  // biện pháp khắc phục. Người dùng khi "quên mật khẩu" vốn KHÔNG đang đăng nhập (không có phiên hiện tại cần
  // giữ lại) — họ sẽ đăng nhập lại tạo phiên mới sau reset; cắt mọi phiên cũ là hành vi ĐÚNG. Bước này là
  // blocking (đứng SAU đổi passwordHash, TRƯỚC finalizeOtpChallenge) — nếu xóa phiên lỗi, KHÔNG được coi
  // reset là thành công (thà báo lỗi để nạn nhân thử lại còn hơn để phiên bị đánh cắp sống sót âm thầm).
  const revokedSessions = await revokeAllWebSessionsForAgent(db, agent.id);
  if (revokedSessions > 0) {
    console.log(`[bot-api] forgot-password/reset: đã thu hồi ${revokedSessions} phiên đang sống của agentId=${agent.id} sau khi đổi mật khẩu (chống phiên bị đánh cắp sống sót qua reset).`);
  }

  // 4/8 LOẠI RC — KHÔNG còn đồng bộ mật khẩu sang Rocket.Chat (rcSetUserPassword đã gỡ). passwordHash nội bộ ở
  // trên là NGUỒN THẬT DUY NHẤT; tài khoản cũ còn rcUserId sẽ tự backfill passwordHash ở lần đăng nhập kế
  // (checkAgentPassword) nếu chưa có, nhưng "quên mật khẩu" đã ghi thẳng passwordHash nên không cần RC nữa.
  await finalizeOtpChallenge(db, challengeId);
  res.json({ ok: true });
}));

// GET /v1/auth/resolve-phone?phone= — 24/7 (Admin Demo: "đăng nhập bằng email hoặc SĐT nếu có SĐT") — public,
// tra Agent theo SĐT (khớp CHÍNH XÁC sau khi bỏ khoảng trắng, KHÔNG suy đoán chuẩn hóa +84/0 phức tạp hơn
// — đúng phạm vi yêu cầu), trả email tương ứng để client tự gọi rcLogin() bằng email đó (RC không có khái
// niệm đăng nhập bằng SĐT sẵn). 404 nếu không tìm thấy — CHẤP NHẬN lộ tồn tại/không tồn tại qua status code
// (khác nguyên tắc chống-dò-email ở route OTP) vì đây LÀ bước đăng nhập, không phải đăng ký — sai SĐT/sai
// mật khẩu vốn đã lộ tương tự ở bất kỳ form đăng nhập nào.
authRouter.get('/v1/auth/resolve-phone', resolvePhoneIpLimiter, asyncHandler(async (req, res) => {
  const phoneRaw = req.query.phone;
  const phone = typeof phoneRaw === 'string' ? phoneRaw.trim().replace(/\s/g, '') : '';
  if (!phone) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu tham số phone.' });
    return;
  }
  const db = getBotDb();
  const agent = await db.agent.findFirst({ where: { phone, deletedAt: null } });
  if (!agent || !agent.email) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Không tìm thấy tài khoản ứng với số điện thoại này.' });
    return;
  }
  res.json({ email: agent.email });
}));

// ── SIGMA (26/7) — đăng nhập THƯỜNG qua bot-api thay vì gọi thẳng Rocket.Chat từ trình duyệt (kiến trúc
// mới: toàn bộ giao tiếp RC đi qua bot-api làm trung gian — xem web-session-service.ts đầu file). TRƯỚC ĐÂY
// `apps/web-demo/src/lib/rc-client.ts rcLogin()` gọi THẲNG `POST ${RC_BASE_URL}/api/v1/login` từ browser (2
// route dưới đây THAY THẾ hoàn toàn lệnh gọi đó — web-demo giờ gọi bot-api, bot-api gọi RC server-side). CÙNG
// khuôn rate-limit deviceBypass (per-IP + per-identifier) — đây cũng là route nhạy cảm dò mật khẩu hàng loạt.
const webLoginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu từ địa chỉ IP này, vui lòng thử lại sau.' }
});
const webLoginIdentifierLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const identifier = (req.body as { identifier?: string } | undefined)?.identifier;
    return typeof identifier === 'string' && identifier.trim() ? identifier.trim().toLowerCase() : 'unknown';
  },
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu đăng nhập cho tài khoản này, vui lòng thử lại sau.' }
});

interface WebLoginBody {
  identifier?: string;
  password?: string;
}

// POST /v1/auth/web-login — {identifier, password}. identifier = email/username (RC field `user` linh hoạt,
// CÙNG lý do đã verify ở web-demo/src/lib/rc-client.ts — KHÔNG suy đoán field khác). Thành công → tạo
// WebSession + set cookie, trả {ok:true} (KHÔNG còn userId/authToken trong body). RC đòi 2FA-qua-email (thiết
// bị mới) → {ok:false, kind:'TOTP_REQUIRED'} (KHÔNG set cookie, client gọi tiếp /web-login/totp).
/** 4/8 hoàn tất LOẠI RC — checkAgentPassword() chỉ còn LOCAL_OK/FAILED (bcrypt nội bộ, KHÔNG gọi RC). LOCAL_OK
 * → mint phiên độc lập RC (rcAuthToken=null). Không còn nhánh TOTP_REQUIRED/502-hạ-tầng-RC vì RC đã cắt hẳn. */
async function handleWebLoginPasswordCheck(
  res: import('express').Response,
  db: ReturnType<typeof getBotDb>,
  identifier: string,
  password: string,
  // 5/8 — helper KHÔNG có `req` (2 caller /web-login + /web-login/totp truyền vào) → nhận thẳng User-Agent để
  // lưu vào WebSession cho nhãn "Thiết bị đăng nhập" (parseDeviceLabel).
  userAgent: string | undefined,
  // #3 (6/8) — header X-Sigma-Platform (nếu client gửi) để suy NỀN chính xác; thiếu → fallback User-Agent.
  platformHeader: string | undefined
): Promise<void> {
  // FIX (5/8, Admin Demo "đăng ký xong máy khác đăng nhập không được"): identifier = EMAIL hoặc SỐ ĐIỆN THOẠI
  // (form ghi "Email hoặc số điện thoại") — TRƯỚC chỉ lookup `email: identifier` (case-sensitive) nên (a) đăng
  // nhập bằng SĐT luôn fail (email không khớp số), (b) email có chữ HOA fail (email lưu lowercase; device-bypass
  // đã .toLowerCase() nhưng web-login quên). Nay: OR email(lowercase) + phone(trim), deletedAt null.
  const id = identifier.trim();
  const agent = await db.agent.findFirst({
    where: { deletedAt: null, OR: [{ email: id.toLowerCase() }, { phone: id }] }
  });
  const check = await checkAgentPassword(agent, password);

  if (check.outcome === 'FAILED') {
    res.status(401).json({ ok: false, kind: 'ERROR', message: 'Sai email/số điện thoại hoặc mật khẩu.' });
    return;
  }

  // LOCAL_OK — mật khẩu đã verify nội bộ (bcrypt, KHÔNG gọi RC). 4/8 LOẠI RC: mint phiên ĐỘC LẬP RC — chỉ dựa
  // agentId, KHÔNG gọi rcCreateLoginTokenForUser nữa (đây chính là chỗ trước đây văng 502 khi RC container chết,
  // dù mật khẩu đúng). rcUserId giữ nếu agent còn link RC (đọc thẳng từ agent, KHÔNG round-trip RC) để rc-proxy
  // cũ còn dùng được tới khi mảng users.info/room.info chuyển hẳn sang dữ liệu nội bộ; rcAuthToken = null.
  if (!agent) {
    res.status(500).json({ ok: false, kind: 'ERROR', message: 'Tài khoản không hợp lệ, vui lòng liên hệ hỗ trợ.' });
    return;
  }
  // #3 (6/8) — tạo phiên + ĐÁ phiên cũ CÙNG NỀN (đăng nhập thường qua email/SĐT + mật khẩu).
  const newSessionId = await finalizeLoginSession(
    db,
    { rcUserId: agent.rcUserId ?? null, rcUsername: agent.rcUsername, agentId: agent.id },
    { userAgent, platformHeader }
  );
  setWebSessionCookie(res, newSessionId);
  // Thiết bị đăng nhập realtime (5/8) — báo MỌI kết nối WS đang mở khác của agent này (nếu có) làm mới danh
  // sách "Thiết bị đang đăng nhập" (màn Bảo mật) ngay khi có thiết bị mới đăng nhập. Best-effort tuyệt đối —
  // broadcastToAgent KHÔNG BAO GIỜ throw + no-op nếu agent chưa có kết nối nào (xem chat-realtime-hub.ts),
  // nên KHÔNG ảnh hưởng gì tới luồng đăng nhập/đăng ký hiện có.
  broadcastToAgent(agent.id, { msg: 'sessions-updated' });
  res.json({ ok: true });
}

authRouter.post('/v1/auth/web-login', webLoginIpLimiter, webLoginIdentifierLimiter, asyncHandler(async (req, res) => {
  const body = req.body as WebLoginBody;
  const identifier = typeof body?.identifier === 'string' ? body.identifier.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!identifier || !password) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu identifier/password.' });
    return;
  }

  const db = getBotDb();
  await handleWebLoginPasswordCheck(res, db, identifier, password, headerString(req.headers['user-agent']), headerString(req.headers['x-sigma-platform']));
}));

interface WebLoginTotpBody {
  identifier?: string;
  password?: string;
  code?: string;
}

// POST /v1/auth/web-login/totp — GIỮ để tương thích client CŨ đã cài (trước đây gọi sau khi /web-login trả
// TOTP_REQUIRED). 4/8 hoàn tất LOẠI RC — không còn 2FA-qua-RC, /web-login KHÔNG bao giờ trả TOTP_REQUIRED nữa
// nên client MỚI không gọi route này; route chỉ còn xác thực identifier+password nội bộ (code bỏ qua) để bản
// APK cũ không bị 404 giữa chừng. Xoá hẳn route này khi chắc chắn không còn client cũ nào dùng.
authRouter.post('/v1/auth/web-login/totp', webLoginIpLimiter, webLoginIdentifierLimiter, asyncHandler(async (req, res) => {
  const body = req.body as WebLoginTotpBody;
  const identifier = typeof body?.identifier === 'string' ? body.identifier.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!identifier || !password) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu identifier/password.' });
    return;
  }

  const db = getBotDb();
  await handleWebLoginPasswordCheck(res, db, identifier, password, headerString(req.headers['user-agent']), headerString(req.headers['x-sigma-platform']));
}));

// ── SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — đăng nhập Google OAuth thật ──────────────────────────────
const webLoginGoogleIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu từ địa chỉ IP này, vui lòng thử lại sau.' }
});

interface WebLoginGoogleBody {
  idToken?: string;
}

// ── Helper CHUNG resolve/tạo Agent từ danh tính Google (dùng cho cả idToken-web lẫn code-flow native exe) ──────
type GoogleAgentResolution =
  | { ok: true; agent: Agent; isNewAccount: boolean }
  | { ok: false; status: number; error: string; message: string };

async function resolveOrCreateGoogleAgent(
  db: ReturnType<typeof getBotDb>,
  input: { googleId: string; email: string; name: string }
): Promise<GoogleAgentResolution> {
  const { googleId, email, name } = input;
  let agent = await db.agent.findFirst({ where: { googleId, deletedAt: null } });
  if (!agent) {
    const byEmail = await db.agent.findFirst({ where: { email, deletedAt: null } });
    if (byEmail) {
      // race hiếm P2002 (2 request cùng email auto-link đồng thời) — đọc lại hàng thật thay vì 500.
      try {
        agent = await db.agent.update({ where: { id: byEmail.id }, data: { googleId } });
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        agent = await db.agent.findFirst({ where: { OR: [{ googleId }, { email }] } });
        if (!agent) throw err;
        console.warn(`[bot-api] google-login: race auto-link googleId (email=${email}).`, err);
      }
    }
  }
  // BACKFILL @handle (bug 14/8) — tài khoản Google CŨ đang rcUsername=null: cấp handle NGAY lần đăng nhập kế để QR/
  // hồ sơ/tag hoạt động, không cần script chạy tay riêng cho từng máy.
  if (agent) return { ok: true, agent: await ensureRcUsername(db, agent), isNewAccount: false };
  const created = await createAgentViaGoogle(db, { googleId, email, name });
  if (!created.ok) return { ok: false, status: created.status, error: created.error, message: created.message };
  return { ok: true, agent: await ensureRcUsername(db, created.agent), isNewAccount: true };
}

// ── Google native cho vỏ EXE (Electron) — Authorization Code flow phía SERVER (6/8, Admin Demo chọn GIỮ nút Google
// trên exe). Vỏ exe origin 127.0.0.1:<cổng ngẫu nhiên> → GIS token-flow bị origin_mismatch. Thay bằng: Electron
// mở cửa sổ → /google/start (302 tới Google) → Google → /google/callback (đổi code→id_token bằng SECRET CHỈ ở
// server, verify, tạo phiên, set cookie sigma_ws dùng chung jar) → 302 /google/finish (Electron bắt URL này
// để đóng cửa sổ). Cookie `state` chống CSRF. redirectUri PHẢI khớp Authorized redirect URIs trong Google Console.
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'https://sigma-api.example.com/v1/auth/google/callback';
const GOOGLE_OAUTH_STATE_COOKIE = 'sigma_goauth_state';

authRouter.get('/v1/auth/google/start', asyncHandler(async (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('Thiếu GOOGLE_CLIENT_ID.');
    return;
  }
  const state = randomBytes(16).toString('hex');
  // Cookie state httpOnly + Secure + SameSite=Lax (gửi kèm điều hướng top-level GET khi Google redirect về callback).
  res.cookie(GOOGLE_OAUTH_STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: 'lax', path: '/v1/auth/google', maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}));

authRouter.get('/v1/auth/google/callback', asyncHandler(async (req, res) => {
  const finish = (status: 'ok' | 'error', msg?: string): void => {
    const q = new URLSearchParams({ status, ...(msg ? { msg } : {}) });
    res.redirect(`/v1/auth/google/finish?${q.toString()}`);
  };
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const cookieState = req.cookies?.[GOOGLE_OAUTH_STATE_COOKIE] as string | undefined;
  res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, { path: '/v1/auth/google' });
  if (req.query.error) { finish('error', 'Bạn đã hủy hoặc Google từ chối.'); return; }
  if (!code || !state || !cookieState || state !== cookieState) { finish('error', 'Phiên đăng nhập không hợp lệ.'); return; }

  const exchanged = await exchangeGoogleAuthCode(code, GOOGLE_OAUTH_REDIRECT_URI);
  if (!exchanged.ok) {
    console.error('[bot-api] google/callback exchange fail:', exchanged.kind, exchanged.message);
    finish('error', exchanged.kind === 'CONFIG_MISSING' ? 'Máy chủ chưa cấu hình Google (thiếu client secret).' : 'Đổi mã Google thất bại.');
    return;
  }
  const verified = await verifyGoogleIdToken(exchanged.idToken);
  if (!verified.ok) { finish('error', 'Xác thực Google thất bại.'); return; }
  if (!verified.data.emailVerified) { finish('error', 'Email Google chưa xác thực.'); return; }

  const db = getBotDb();
  const resolution = await resolveOrCreateGoogleAgent(db, verified.data);
  if (!resolution.ok) { finish('error', resolution.message); return; }
  const { agent } = resolution;
  // #3 (6/8) — Google native exe (code-flow): header X-Sigma-Platform KHÔNG gửi được ở điều hướng top-level
  // GET này → derivePlatform tự suy từ User-Agent (vỏ Electron → 'exe'). Tạo phiên + ĐÁ phiên cũ CÙNG NỀN.
  const newSessionId = await finalizeLoginSession(
    db,
    { rcUserId: agent.rcUserId ?? null, rcUsername: agent.rcUsername, agentId: agent.id },
    { userAgent: headerString(req.headers['user-agent']), platformHeader: headerString(req.headers['x-sigma-platform']) }
  );
  setWebSessionCookie(res, newSessionId);
  broadcastToAgent(agent.id, { msg: 'sessions-updated' });
  finish('ok');
}));

authRouter.get('/v1/auth/google/finish', (req, res) => {
  const ok = req.query.status === 'ok';
  const msg = typeof req.query.msg === 'string' ? req.query.msg : '';
  // Trang tối giản — Electron bắt URL /google/finish để đóng cửa sổ (cũng tự window.close() nếu là popup).
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>SigMa</title><style>body{font-family:system-ui,Arial,sans-serif;background:#f1f5f9;color:#0f2740;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.c{text-align:center;padding:28px}</style></head><body><div class="c"><h2>${ok ? 'Đăng nhập Google thành công' : 'Đăng nhập Google thất bại'}</h2><p>${ok ? 'Đang quay lại ứng dụng…' : (msg || 'Vui lòng thử lại.')}</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},1200)</script></body></html>`);
});

// POST /v1/auth/web-login/google — {idToken} (Google Identity Services JS SDK phía client). Verify chữ ký +
// audience → tìm Agent theo googleId, fallback theo email để auto-link tài khoản cũ, hoặc tạo Agent MỚI ĐỘC
// LẬP RC (4/8 LOẠI RC — KHÔNG tạo RC user nền, xem createAgentViaGoogle()) → mint WebSession độc lập RC
// (rcAuthToken null, chỉ dựa agentId — KHÔNG gọi rcCreateLoginTokenForUser).
authRouter.post('/v1/auth/web-login/google', webLoginGoogleIpLimiter, asyncHandler(async (req, res) => {
  const idToken = typeof (req.body as WebLoginGoogleBody)?.idToken === 'string' ? (req.body as WebLoginGoogleBody).idToken!.trim() : '';
  if (!idToken) {
    res.status(400).json({ error: 'VALIDATION', message: 'Thiếu idToken.' });
    return;
  }

  const verified = await verifyGoogleIdToken(idToken);
  if (!verified.ok) {
    if (verified.kind === 'CONFIG_MISSING') {
      res.status(500).json({ error: 'GOOGLE_CLIENT_ID_NOT_CONFIGURED', message: verified.message });
      return;
    }
    res.status(401).json({ error: 'GOOGLE_TOKEN_INVALID', message: 'Đăng nhập Google thất bại, vui lòng thử lại.' });
    return;
  }
  if (!verified.data.emailVerified) {
    res.status(401).json({ error: 'GOOGLE_EMAIL_NOT_VERIFIED', message: 'Email Google chưa được xác thực.' });
    return;
  }

  const db = getBotDb();
  const resolution = await resolveOrCreateGoogleAgent(db, verified.data);
  if (!resolution.ok) {
    res.status(resolution.status).json({ error: resolution.error, message: resolution.message });
    return;
  }
  const { agent, isNewAccount } = resolution;

  // 4/8 LOẠI RC — mint phiên ĐỘC LẬP RC (KHÔNG gọi rcCreateLoginTokenForUser nữa): chỉ dựa agentId,
  // rcAuthToken = null. Tài khoản Google MỚI có rcUserId = null; tài khoản cũ auto-link vẫn còn rcUserId (đọc
  // thẳng từ agent, KHÔNG round-trip RC) — giữ lại cho rc-proxy cũ dùng tới khi chuyển hẳn sang dữ liệu nội bộ.
  // KHÔNG còn nhánh 500 AGENT_RC_LINK_MISSING (rcUserId = null giờ là trạng thái BÌNH THƯỜNG của tài khoản mới).
  // #3 (6/8) — tạo phiên + ĐÁ phiên cũ CÙNG NỀN (đăng nhập Google web idToken).
  const newSessionId = await finalizeLoginSession(
    db,
    { rcUserId: agent.rcUserId ?? null, rcUsername: agent.rcUsername, agentId: agent.id },
    { userAgent: headerString(req.headers['user-agent']), platformHeader: headerString(req.headers['x-sigma-platform']) }
  );
  setWebSessionCookie(res, newSessionId);
  // Thiết bị đăng nhập realtime (5/8) — báo MỌI kết nối WS đang mở khác của agent này (nếu có) làm mới danh
  // sách "Thiết bị đang đăng nhập" (màn Bảo mật) ngay khi có thiết bị mới đăng nhập. Best-effort tuyệt đối —
  // broadcastToAgent KHÔNG BAO GIỜ throw + no-op nếu agent chưa có kết nối nào (xem chat-realtime-hub.ts),
  // nên KHÔNG ảnh hưởng gì tới luồng đăng nhập/đăng ký hiện có.
  broadcastToAgent(agent.id, { msg: 'sessions-updated' });
  res.json({ ok: true, isNewAccount });
}));

// POST /v1/auth/web-logout — đọc cookie `sigma_ws`, revoke WebSession trong DB + clear cookie. 4/8 hoàn tất
// LOẠI RC — phiên nay độc lập RC (rcAuthToken luôn null) nên KHÔNG còn bước logout phía Rocket.Chat; chỉ revoke
// session nội bộ. Thiếu cookie/session không hợp lệ vẫn trả {ok:true} (idempotent — đăng xuất 1 thứ vốn đã
// không còn hiệu lực không phải lỗi cần báo).
authRouter.post('/v1/auth/web-logout', asyncHandler(async (req, res) => {
  const sessionId = req.cookies?.[WEB_SESSION_COOKIE_NAME] as string | undefined;
  if (sessionId) {
    const db = getBotDb();
    await revokeWebSession(db, sessionId);
  }
  clearWebSessionCookie(res);
  res.json({ ok: true });
}));
