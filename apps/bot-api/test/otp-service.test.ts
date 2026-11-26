import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { createOtpChallenge, verifyOtpChallenge, finalizeOtpChallenge, releaseOtpChallenge } from '../src/otp-service.js';

const MAX_ATTEMPTS = 5; // khớp const cùng tên trong src/otp-service.ts (không export — test đối chiếu literal).

const PURPOSE = 'AGENT_REGISTER';

function uniqEmail(): string {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
}

describe('otp-service — createOtpChallenge', () => {
  it('sinh mã 6 chữ số, hash khác plaintext, KHÔNG lưu plaintext trong DB', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);
    expect(r.code).toMatch(/^\d{6}$/);
    const row = await db.emailOtpChallenge.findUnique({ where: { id: r.challengeId } });
    expect(row).not.toBeNull();
    expect(row!.codeHash).not.toBe(r.code);
    expect(row!.codeHash).toHaveLength(64); // sha256 hex
    expect(row!.consumedAt).toBeNull();
    expect(row!.attempts).toBe(0);
  });

  it('expiresAt ~10 phút sau thời điểm tạo', async () => {
    const db = getBotDb();
    const before = Date.now();
    const r = await createOtpChallenge(db, uniqEmail(), PURPOSE);
    const diffMinutes = (r.expiresAt.getTime() - before) / 60_000;
    expect(diffMinutes).toBeGreaterThan(9.9);
    expect(diffMinutes).toBeLessThan(10.1);
  });

  it('tạo challenge mới cho CÙNG email+purpose sẽ vô hiệu hoá challenge cũ chưa dùng', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const first = await createOtpChallenge(db, email, PURPOSE);
    await createOtpChallenge(db, email, PURPOSE);

    const oldRow = await db.emailOtpChallenge.findUnique({ where: { id: first.challengeId } });
    expect(oldRow!.consumedAt).not.toBeNull();

    // Mã cũ không còn verify được nữa: vì đã có challenge MỚI còn sống cho cùng email+purpose,
    // verifyOtpChallenge khớp vào challenge mới đó (query chỉ tìm consumedAt:null) rồi so hash → LỆCH
    // (mã cũ không phải mã của challenge mới) → WRONG_CODE, không phải NOT_FOUND (NOT_FOUND chỉ xảy ra khi
    // hoàn toàn không còn challenge sống nào cho email+purpose này).
    const verifyOld = await verifyOtpChallenge(db, email, PURPOSE, first.code);
    expect(verifyOld.outcome).toBe('WRONG_CODE');
  });
});

describe('otp-service — verifyOtpChallenge', () => {
  // B2 fix (24/7, CMD_AUDIT 23/7): mã đúng giờ chỉ CLAIM (verifiedAt), KHÔNG tiêu dùng ngay (consumedAt) —
  // xem finalizeOtpChallenge/releaseOtpChallenge. Test cũ "verify lại lần 2 → NOT_FOUND" SAI với semantics
  // mới (challenge vẫn "sống", chỉ đang bị claim) → sửa thành IN_PROGRESS, thêm 2 test finalize/release riêng
  // dưới đây để phủ đủ cả nhánh "tiêu dùng thật" lẫn "nhả lại vì downstream lỗi".
  it('mã đúng → OK kèm challengeId (claim, CHƯA tiêu dùng), verify lại mã đúng lần 2 (chưa finalize/release) → IN_PROGRESS', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);

    const ok = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(ok.outcome).toBe('OK');
    expect(ok.challengeId).toBe(r.challengeId);

    const again = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(again.outcome).toBe('IN_PROGRESS');

    const row = await db.emailOtpChallenge.findUnique({ where: { id: r.challengeId } });
    expect(row!.consumedAt).toBeNull(); // CHƯA tiêu dùng thật — chỉ claim.
    expect(row!.verifiedAt).not.toBeNull();
  });

  // B2 — nhánh downstream (rcCreateUser) THÀNH CÔNG: route gọi finalizeOtpChallenge → tiêu dùng THẬT,
  // verify lại sau đó (kể cả đúng mã) → NOT_FOUND (đây là hành vi "1 lần dùng" mà test cũ mong đợi, giờ đạt
  // được qua bước finalize tường minh thay vì tự động ngay trong verifyOtpChallenge).
  it('B2: rcCreateUser THÀNH CÔNG (mô phỏng) → finalizeOtpChallenge → verify lại CÙNG mã sau đó → NOT_FOUND', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);

    const ok = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(ok.outcome).toBe('OK');
    await finalizeOtpChallenge(db, ok.challengeId!);

    const row = await db.emailOtpChallenge.findUnique({ where: { id: r.challengeId } });
    expect(row!.consumedAt).not.toBeNull();

    const again = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(again.outcome).toBe('NOT_FOUND');
  });

  // B2 — nhánh downstream (rcCreateUser) THẤT BẠI (mô phỏng): route gọi releaseOtpChallenge → nhả claim →
  // CÙNG mã OTP đó verify lại được ngay (KHÔNG bắt user xin mã mới) — đúng yêu cầu fix chính của bug này.
  it('B2: rcCreateUser THẤT BẠI (mô phỏng) → releaseOtpChallenge → verify lại CÙNG mã OTP → cho qua bước xác minh mã (OK) lần nữa', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);

    const firstAttempt = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(firstAttempt.outcome).toBe('OK');

    // Mô phỏng rcCreateUser thất bại — route sẽ gọi releaseOtpChallenge thay vì finalizeOtpChallenge.
    await releaseOtpChallenge(db, firstAttempt.challengeId!);

    const row = await db.emailOtpChallenge.findUnique({ where: { id: r.challengeId } });
    expect(row!.consumedAt).toBeNull();
    expect(row!.verifiedAt).toBeNull();
    expect(row!.attempts).toBe(0); // release KHÔNG đụng attempts.

    // Retry với CÙNG mã OTP (như user bấm "Thử lại" trên form đăng ký, không phải xin mã mới) → phải qua
    // được bước xác minh mã lần nữa (OK), không phải NOT_FOUND/đã dùng.
    const retry = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(retry.outcome).toBe('OK');
    expect(retry.challengeId).toBe(r.challengeId);
  });

  // B2 concurrency — 2 request verify song song CÙNG mã đúng: chỉ 1 được "thắng" (OK + challengeId), request
  // còn lại phải bị chặn (IN_PROGRESS), KHÔNG được phép cả 2 cùng OK (mới dẫn tới 2 lần gọi rcCreateUser →
  // 2 Agent/2 RC user khác nhau cho cùng 1 mã OTP — đúng yêu cầu "chỉ 1 được thắng" trong finding CMD_AUDIT).
  it('B2 concurrency: N request verify song song CÙNG mã đúng → CHỈ ĐÚNG 1 request nhận OK, còn lại IN_PROGRESS', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);
    const N = 10;

    const results = await Promise.all(Array.from({ length: N }, () => verifyOtpChallenge(db, email, PURPOSE, r.code)));

    const okCount = results.filter((x) => x.outcome === 'OK').length;
    const inProgressCount = results.filter((x) => x.outcome === 'IN_PROGRESS').length;
    expect(okCount).toBe(1);
    expect(inProgressCount).toBe(N - 1);
  });

  it('không có challenge nào cho email → NOT_FOUND', async () => {
    const db = getBotDb();
    const r = await verifyOtpChallenge(db, uniqEmail(), PURPOSE, '000000');
    expect(r.outcome).toBe('NOT_FOUND');
  });

  it('mã sai → WRONG_CODE, tăng attempts, KHÔNG khoá cho tới khi chạm ngưỡng', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);
    const wrongCode = r.code === '111111' ? '222222' : '111111';

    const v1 = await verifyOtpChallenge(db, email, PURPOSE, wrongCode);
    expect(v1.outcome).toBe('WRONG_CODE');
    const row = await db.emailOtpChallenge.findUnique({ where: { id: r.challengeId } });
    expect(row!.attempts).toBe(1);

    // Mã đúng vẫn verify được sau vài lần sai (chưa chạm ngưỡng).
    const ok = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(ok.outcome).toBe('OK');
  });

  it('sai đủ 5 lần → TOO_MANY_ATTEMPTS, mã đúng sau đó vẫn bị chặn (khoá vĩnh viễn challenge đó)', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);
    const wrongCode = r.code === '111111' ? '222222' : '111111';

    let last;
    for (let i = 0; i < 5; i++) {
      last = await verifyOtpChallenge(db, email, PURPOSE, wrongCode);
    }
    expect(last!.outcome).toBe('TOO_MANY_ATTEMPTS');

    // Kể cả nhập ĐÚNG mã sau khi đã khoá → vẫn TOO_MANY_ATTEMPTS, không cho qua.
    const tryCorrect = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(tryCorrect.outcome).toBe('TOO_MANY_ATTEMPTS');
  });

  // B1 fix (24/7, CMD_AUDIT 23/7 — REGRESSION THƯỜNG TRỰC, không phải file tạm): bản cũ đọc
  // challenge.attempts 1 lần đầu hàm rồi ghi lại từ giá trị CŨ (không atomic) → bắn N request SONG SONG
  // (Promise.all, KHÔNG tuần tự) cùng sai mã đọc CÙNG attempts cũ → "lost update", đo được 16/20 request sai
  // mã vẫn được xử lý như hợp lệ thay vì bị chặn ở MAX_ATTEMPTS(5). Fix dùng `SELECT ... FOR UPDATE` trong
  // db.$transaction để serialize — assert: dưới concurrency thật, số outcome WRONG_CODE (tức "đoán được xử
  // lý") KHÔNG BAO GIỜ vượt MAX_ATTEMPTS, và attempts cuối cùng trong DB cũng bị chặn đúng ở MAX_ATTEMPTS
  // (không tăng vọt lên 15+ như bug cũ).
  it('B1 concurrency: bắn 15 request verifyOtpChallenge SAI MÃ song song (Promise.all) vào CÙNG 1 challenge → số WRONG_CODE không vượt MAX_ATTEMPTS, attempts DB bị chặn đúng ngưỡng', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);
    const wrongCode = r.code === '111111' ? '222222' : '111111';
    const N = 15;

    const results = await Promise.all(Array.from({ length: N }, () => verifyOtpChallenge(db, email, PURPOSE, wrongCode)));

    const wrongCount = results.filter((x) => x.outcome === 'WRONG_CODE').length;
    const tooManyCount = results.filter((x) => x.outcome === 'TOO_MANY_ATTEMPTS').length;

    // Tiêu chí BẮT BUỘC theo finding CMD_AUDIT: tổng số lần "đoán được xử lý" (WRONG_CODE) KHÔNG vượt
    // MAX_ATTEMPTS bất kể bắn song song bao nhiêu request — đây chính là bug cũ (16/20 vẫn được xử lý).
    expect(wrongCount).toBeLessThanOrEqual(MAX_ATTEMPTS);
    // Mọi request phải rơi vào đúng 1 trong 2 outcome này (không request nào lọt qua thành OK/khác — mã vốn sai).
    expect(wrongCount + tooManyCount).toBe(N);
    // Ít nhất 1 request phải bị chặn thật (chứng minh cơ chế khoá có hoạt động, không phải "tình cờ" wrongCount thấp).
    expect(tooManyCount).toBeGreaterThan(0);

    const row = await db.emailOtpChallenge.findUnique({ where: { id: r.challengeId } });
    // Bất biến cốt lõi: DB KHÔNG BAO GIỜ ghi attempts vượt MAX_ATTEMPTS, dù 15 request cùng chạy song song.
    expect(row!.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
    expect(row!.attempts).toBe(MAX_ATTEMPTS); // đủ 15 request sai (>5) nên chắc chắn chạm đúng ngưỡng, không dư không thiếu.

    // Mã ĐÚNG sau khi đã khoá bởi đợt tấn công song song → vẫn phải bị chặn (không có cách nào lách qua).
    const tryCorrectAfter = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(tryCorrectAfter.outcome).toBe('TOO_MANY_ATTEMPTS');
  });

  it('mã hết hạn → EXPIRED (giả lập bằng cách chỉnh expiresAt về quá khứ)', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);
    await db.emailOtpChallenge.update({
      where: { id: r.challengeId },
      data: { expiresAt: new Date(Date.now() - 60_000) }
    });
    const v = await verifyOtpChallenge(db, email, PURPOSE, r.code);
    expect(v.outcome).toBe('EXPIRED');
  });

  it('purpose khác nhau KHÔNG lẫn nhau (mã purpose A không verify được bằng purpose B)', async () => {
    const db = getBotDb();
    const email = uniqEmail();
    const r = await createOtpChallenge(db, email, PURPOSE);
    const v = await verifyOtpChallenge(db, email, 'OTHER_PURPOSE', r.code);
    expect(v.outcome).toBe('NOT_FOUND');
  });
});
