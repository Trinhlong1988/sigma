// SIGMA Phase 1 (23/7, CMD_BUILD) — thử thách OTP qua email (kế hoạch mục A: "Đăng ký tài khoản mới =
// bước OTP-email TRƯỚC khi tạo user Rocket.Chat"). Bền qua restart process (Postgres — model
// EmailOtpChallenge, KHÔNG in-memory Map, xem migration 20260723120000_email_otp_challenge). Mã 6 số sinh
// bằng crypto.randomInt (CSPRNG, KHÔNG Math.random). CHỈ hash SHA-256 được lưu — plaintext chỉ tồn tại trong
// bộ nhớ tạm thời để gửi email rồi bỏ, không bao giờ ghi xuống DB.
//
// 24/7 CMD_BUILD — 2 fix theo finding CMD_AUDIT (LEAD confirmed):
//   B1 (bảo mật — race condition giới hạn thử sai): verifyOtpChallenge cũ đọc challenge.attempts 1 LẦN đầu
//   hàm rồi tính nextAttempts từ giá trị CŨ, ghi lại — không atomic. N request song song cùng sai mã đọc
//   CÙNG attempts cũ → "lost update", MAX_ATTEMPTS bị bỏ qua phần lớn (đo được 16/20 request sai mã vẫn được
//   xử lý như hợp lệ thay vì bị chặn ở 5). FIX: `SELECT ... FOR UPDATE` khóa row bên trong db.$transaction
//   TRƯỚC khi đọc-tăng-ghi — cùng khuôn với apps/desktop (xem tid-service.ts/transaction-service.ts),
//   serialize MỌI verify cùng challenge.id, không phát minh cơ chế mới.
//   B2 (đáng tin cậy/UX — OTP bị "đốt" dù đăng ký RC thất bại giữa chừng): verify cũ set consumedAt NGAY khi
//   mã đúng, TRƯỚC khi routes/auth.ts gọi rcCreateUser — rcCreateUser lỗi giữa chừng thì OTP đã tiêu, user
//   phải xin mã MỚI dù lỗi không do họ. FIX: tách "xác minh mã đúng" (verifiedAt = CLAIM tạm) khỏi "tiêu dùng
//   thật" (consumedAt = terminal) — verifyOtpChallenge CHỈ claim + trả challengeId; caller (route) gọi
//   finalizeOtpChallenge() sau khi downstream (rcCreateUser) THÀNH CÔNG, hoặc releaseOtpChallenge() nếu THẤT
//   BẠI (mã verify lại được, KHÔNG bắt xin mã mới). FOR UPDATE cùng transaction ở B1 cũng chặn ĐÚNG 2 verify
//   song song cùng mã đúng cùng claim (request thứ 2 thấy verifiedAt đã set → IN_PROGRESS).
import { createHash, randomInt } from 'node:crypto';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

const CODE_LENGTH = 6;
const EXPIRES_MINUTES = 10;
const MAX_ATTEMPTS = 5;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function generateSixDigitCode(): string {
  // randomInt(0, 1_000_000) → 0..999999, pad về đúng 6 ký tự (giữ số 0 đứng đầu nếu có).
  return String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0');
}

export interface CreateOtpChallengeResult {
  challengeId: number;
  code: string; // PLAINTEXT — CHỈ dùng để gửi email ngay sau khi gọi hàm này, KHÔNG lưu lại nơi khác.
  expiresAt: Date;
}

/**
 * Sinh challenge OTP mới cho (email, purpose). Trước khi tạo, vô hiệu hoá (đánh dấu consumedAt = now) MỌI
 * challenge CŨ cùng email+purpose CHƯA dùng — tránh rác nhiều mã sống song song (mã cũ gửi trước đó sẽ
 * không còn verify được, đúng hành vi "gửi lại OTP thay thế mã trước" mà người dùng kỳ vọng).
 */
export async function createOtpChallenge(db: Db, email: string, purpose: string): Promise<CreateOtpChallengeResult> {
  const now = new Date();
  await db.emailOtpChallenge.updateMany({
    where: { email, purpose, consumedAt: null },
    data: { consumedAt: now }
  });

  const code = generateSixDigitCode();
  const expiresAt = new Date(now.getTime() + EXPIRES_MINUTES * 60_000);
  const created = await db.emailOtpChallenge.create({
    data: { email, purpose, codeHash: hashCode(code), expiresAt }
  });
  return { challengeId: created.id, code, expiresAt };
}

export type VerifyOtpOutcome = 'OK' | 'EXPIRED' | 'WRONG_CODE' | 'TOO_MANY_ATTEMPTS' | 'NOT_FOUND' | 'IN_PROGRESS';

export interface VerifyOtpResult {
  outcome: VerifyOtpOutcome;
  /**
   * CHỈ set khi outcome === 'OK' — id challenge đã được CLAIM (verifiedAt vừa set) nhưng CHƯA tiêu dùng thật
   * (consumedAt vẫn null). Caller BẮT BUỘC gọi finalizeOtpChallenge() sau khi luồng downstream (vd
   * rcCreateUser) THÀNH CÔNG, hoặc releaseOtpChallenge() nếu downstream THẤT BẠI. Nếu caller không gọi gì cả
   * (crash giữa chừng) — challenge tự nhả khi hết hạn (tối đa EXPIRES_MINUTES phút), KHÔNG khoá vĩnh viễn.
   */
  challengeId?: number;
}

/**
 * Xác minh mã OTP cho (email, purpose). Tìm challenge GẦN NHẤT còn "sống" (chưa consumedAt) rồi khóa row
 * (`SELECT ... FOR UPDATE` trong db.$transaction) TRƯỚC khi đọc-kiểm-ghi — atomic dưới concurrency thật
 * (B1). Mã ĐÚNG chỉ CLAIM (verifiedAt), KHÔNG tiêu dùng ngay (B2) — xem finalizeOtpChallenge/
 * releaseOtpChallenge bên dưới. KHÔNG throw lỗi mơ hồ — luôn trả outcome rõ ràng để caller (route) map sang
 * response cụ thể.
 */
export async function verifyOtpChallenge(db: Db, email: string, purpose: string, code: string): Promise<VerifyOtpResult> {
  return db.$transaction(async (tx) => {
    const now = new Date();
    const challenge = await tx.emailOtpChallenge.findFirst({
      where: { email, purpose, consumedAt: null },
      orderBy: { id: 'desc' }
    });
    if (!challenge) {
      return { outcome: 'NOT_FOUND' as const };
    }

    // Khóa row NGAY — B1 fix. Mọi verify khác nhắm cùng challenge.id (kể cả bắn song song thật, Promise.all)
    // phải CHỜ transaction này commit/rollback rồi mới đọc được state MỚI NHẤT — không còn "N request đọc
    // cùng 1 giá trị cũ rồi ghi đè nhau" như bản trước.
    await tx.$queryRaw`SELECT id FROM email_otp_challenges WHERE id = ${challenge.id} FOR UPDATE`;

    // Đọc LẠI sau khi có khóa — 1 request khác có thể vừa tăng attempts/claim/tiêu dùng trong lúc ta chờ.
    const locked = await tx.emailOtpChallenge.findUniqueOrThrow({ where: { id: challenge.id } });

    if (locked.consumedAt) {
      // Đã bị 1 request khác tiêu dùng thật (finalizeOtpChallenge) trong lúc ta chờ khóa — coi như hết sống.
      return { outcome: 'NOT_FOUND' as const };
    }
    if (locked.expiresAt.getTime() < now.getTime()) {
      return { outcome: 'EXPIRED' as const };
    }
    if (locked.attempts >= MAX_ATTEMPTS) {
      return { outcome: 'TOO_MANY_ATTEMPTS' as const };
    }

    const isMatch = locked.codeHash === hashCode(code);
    if (!isMatch) {
      const nextAttempts = locked.attempts + 1;
      // CỐ Ý không set consumedAt ở đây (kể cả khi nextAttempts chạm ngưỡng) — challenge vẫn "chưa dùng"
      // (consumedAt: null), nhưng nhánh kiểm attempts >= MAX_ATTEMPTS phía trên sẽ chặn MỌI lần gọi lại sau
      // đó trả TOO_MANY_ATTEMPTS nhất quán (attempts không giảm nên khoá vĩnh viễn challenge này).
      await tx.emailOtpChallenge.update({
        where: { id: locked.id },
        data: { attempts: nextAttempts }
      });
      return { outcome: nextAttempts >= MAX_ATTEMPTS ? ('TOO_MANY_ATTEMPTS' as const) : ('WRONG_CODE' as const) };
    }

    if (locked.verifiedAt) {
      // Mã ĐÚNG nhưng đã bị 1 request khác (song song, cũng mã đúng) claim trước và đang xử lý downstream
      // (rcCreateUser chưa xong) — B2 fix: KHÔNG claim chồng, tránh 2 request cùng thắng tạo 2 Agent/2 RC
      // user khác nhau cho cùng 1 mã OTP.
      return { outcome: 'IN_PROGRESS' as const };
    }

    // Mã ĐÚNG, chưa ai claim — CLAIM (KHÔNG set consumedAt ở đây, xem finalizeOtpChallenge()).
    await tx.emailOtpChallenge.update({
      where: { id: locked.id },
      data: { verifiedAt: now }
    });
    return { outcome: 'OK' as const, challengeId: locked.id };
  });
}

/**
 * Gọi SAU KHI toàn bộ luồng downstream (rcCreateUser) THÀNH CÔNG — tiêu dùng THẬT (consumedAt), challenge
 * không bao giờ verify lại được nữa (kể cả đúng mã, xem check `locked.consumedAt` ở trên).
 */
export async function finalizeOtpChallenge(db: Db, challengeId: number): Promise<void> {
  await db.emailOtpChallenge.update({
    where: { id: challengeId },
    data: { consumedAt: new Date() }
  });
}

/**
 * Gọi khi luồng downstream (rcCreateUser) THẤT BẠI — NHẢ claim (verifiedAt = null) để mã ĐÚNG này verify
 * lại được ở lần gọi verifyOtpChallenge tiếp theo, KHÔNG bắt user xin mã mới (B2). Không đụng
 * attempts/consumedAt/expiresAt — chỉ đảo ngược đúng 1 việc verifyOtpChallenge vừa làm khi claim.
 */
export async function releaseOtpChallenge(db: Db, challengeId: number): Promise<void> {
  await db.emailOtpChallenge.update({
    where: { id: challengeId },
    data: { verifiedAt: null }
  });
}
