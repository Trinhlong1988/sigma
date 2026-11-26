// Regression test cho bug thật đêm 23→24/7 (xem CLAUDE.md workspace + async-handler.ts): gọi POST
// /v1/auth/register/request-otp trên server đang chạy → Prisma ném P2021 (bảng chưa migrate) → lỗi đó CRASH
// CẢ TIẾN TRÌNH Node (Express 4.21 KHÔNG tự bắt lỗi throw/reject trong async handler). Sau khi vá bằng
// asyncHandler() (src/async-handler.ts) + middleware lỗi tập trung (src/app.ts), lỗi async trong handler phải
// chỉ làm request đó trả 500, KHÔNG được thoát ra ngoài thành unhandled rejection.
//
// Cách chứng minh THẬT (không phải test hình thức): mock 1 dependency BÊN TRONG handler để nó throw/reject,
// gọi qua supertest + createApp() TRONG CÙNG process với vitest worker (không spawn server con) — nếu bug cũ
// còn tồn tại, lỗi sẽ crash cả vitest worker process (mọi test SAU nó trong file này cũng không chạy được/bị
// fail hàng loạt). Mỗi describe dưới đây có ÍT NHẤT 1 test NGAY SAU test lỗi để tự chứng minh process còn
// sống — nếu dòng report cuối cùng của file này hiện đủ số test PASS thì process đã sống sót qua cả 3 lỗi.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Request, Response } from 'express';

// Partial-mock — CÙNG khuôn auth-routes.test.ts (giữ nguyên phần thật, chỉ thay 1 hàm cụ thể) để không ảnh
// hưởng hành vi các export khác của cùng module.
vi.mock('../src/otp-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/otp-service.js')>('../src/otp-service.js');
  // vi.fn(actual.createOtpChallenge) — CÙNG khuôn getBotDb/reconcileLo bên dưới: mặc định gọi THẬT (DB
  // throwaway), .mockRejectedValueOnce() ở từng test chỉ ghi đè ĐÚNG 1 lần gọi kế tiếp. Nếu để vi.fn() trống
  // (không default), lần gọi THỨ 2 (test "còn sống" ngay sau) sẽ trả về undefined thay vì chạy thật, làm
  // handler tự throw lỗi KHÁC (challenge.code của undefined) — che mất ý nghĩa thật của test.
  return { ...actual, createOtpChallenge: vi.fn(actual.createOtpChallenge) };
});
vi.mock('../src/email-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/email-service.js')>('../src/email-service.js');
  return { ...actual, sendOtpEmail: vi.fn() };
});
vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getBotDb: vi.fn(actual.getBotDb) };
});
import { createApp, errorHandler } from '../src/app.js';
import { asyncHandler } from '../src/async-handler.js';
import { createOtpChallenge } from '../src/otp-service.js';
import { sendOtpEmail } from '../src/email-service.js';
import { getBotDb } from '../src/db.js';
import { WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';

function uniqEmail(): string {
  return `crash_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
}

describe('routes/auth.ts — lỗi DB bất ngờ trong request-otp (mô phỏng ĐÚNG bug thật P2021 23-24/7)', () => {
  const app = createApp();

  it('createOtpChallenge reject (giả lập Prisma lỗi bảng chưa migrate) → 500 INTERNAL_ERROR qua middleware lỗi tập trung, KHÔNG throw ra ngoài supertest', async () => {
    vi.mocked(createOtpChallenge).mockRejectedValueOnce(
      new Error('P2021: The table `public.EmailOtpChallenge` does not exist in the current database (mô phỏng).')
    );
    const res = await request(app).post('/v1/auth/register/request-otp').send({ email: uniqEmail() });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: expect.any(String) });
    // KHÔNG lộ message Prisma/stack thật ra response (chỉ được log console phía server) — chỉ được thấy
    // message an toàn chung đã định nghĩa ở app.ts, TUYỆT ĐỐI không phải nguyên văn lỗi Prisma.
    expect(JSON.stringify(res.body)).not.toContain('P2021');
    expect(JSON.stringify(res.body)).not.toContain('EmailOtpChallenge');
  });

  // BẰNG CHỨNG SỐNG: request NGAY SAU request lỗi ở trên, trong CÙNG file/process — nếu bug cũ (crash cả
  // process) còn tồn tại thì dòng test này KHÔNG BAO GIỜ chạy tới (worker đã chết ở test trước).
  it('NGAY SAU lỗi ở trên: request-otp HỢP LỆ khác vẫn được xử lý trọn vẹn → chứng minh process/worker CÒN SỐNG', async () => {
    vi.mocked(sendOtpEmail).mockResolvedValueOnce(undefined);
    const res = await request(app).post('/v1/auth/register/request-otp').send({ email: uniqEmail() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// AUDIT FIX (MEDIUM, security-auditor 24/7) — app.ts errorHandler trước đây gọi thẳng res.status(500).json()
// mà KHÔNG kiểm res.headersSent. Nếu 1 handler đã bắt đầu ghi response (streaming/res.write một phần) TRƯỚC
// khi lỗi xảy ra, gọi res.status()/res.json() LẦN 2 sẽ tự throw ERR_HTTP_HEADERS_SENT ĐỒNG BỘ ngay trong
// chính error middleware CUỐI CÙNG — quay lại đúng lớp bug "lỗi không kiểm soát" mà cả patch này sinh ra để
// diệt. Hiện KHÔNG route nào của SigMa thật sự res.write() từng phần trước khi lỗi (gap phòng thủ theo
// chiều sâu, chưa bị khai thác) — 2 test dưới đây CHỨNG MINH nhánh headersSent hoạt động đúng dù chưa route
// nào kích hoạt được trong thực tế hôm nay.
describe('app.ts errorHandler — audit fix (MEDIUM 24/7): KHÔNG tự ghi response lần 2 khi res.headersSent', () => {
  it('gọi TRỰC TIẾP errorHandler với res.headersSent=true → KHÔNG gọi res.status()/res.json() (tránh ERR_HTTP_HEADERS_SENT), CHỈ next(err) — bằng chứng chính xác nhánh code vừa sửa', () => {
    const statusSpy = vi.fn();
    const jsonSpy = vi.fn();
    // fakeRes tối thiểu — chỉ cần đủ field errorHandler đọc/gọi tới (headersSent + status + json), KHÔNG cần
    // dựng 1 http.ServerResponse thật cho unit test này (test tích hợp qua HTTP thật ở case kế tiếp).
    const fakeRes = { headersSent: true, status: statusSpy, json: jsonSpy } as unknown as Response;
    const nextSpy = vi.fn();
    const simulatedErr = new Error('Lỗi mô phỏng xảy ra SAU khi response đã bắt đầu ghi (headersSent=true).');

    expect(() => errorHandler(simulatedErr, {} as Request, fakeRes, nextSpy)).not.toThrow();
    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(nextSpy).toHaveBeenCalledTimes(1);
    expect(nextSpy).toHaveBeenCalledWith(simulatedErr);
  });

  // Test tích hợp qua HTTP THẬT (đúng khuôn 3 describe trên: asyncHandler thật + errorHandler thật mount qua
  // Express thật, KHÔNG mock lớp nào của chính patch). Handler res.write() một phần rồi throw — mô phỏng ĐÚNG
  // kịch bản audit nêu. Sau khi headers đã gửi, Express default final handler (gọi qua next(err) ở nhánh
  // headersSent) sẽ tự đóng socket — đây là hành vi TCP bình thường nằm ngoài tầm kiểm soát của middleware,
  // KHÔNG phải lỗi ERR_HTTP_HEADERS_SENT mà bản vá này nhắm diệt. Test KHÔNG assert response cụ thể (không
  // kiểm soát được thời điểm socket đóng) — chỉ khẳng định KHÔNG có lỗi ĐÚNG LOẠI "ghi header 2 lần" xảy ra.
  it('handler thật đã res.write() một phần rồi mới throw (qua asyncHandler+errorHandler thật) → KHÔNG phát sinh lỗi ERR_HTTP_HEADERS_SENT/write-after-end, request không treo test runner', async () => {
    const testApp = express();
    testApp.get(
      '/partial-then-fail',
      asyncHandler(async (_req, res) => {
        res.write('phan dau du lieu da gui...');
        throw new Error('Loi xay ra SAU khi da bat dau ghi response (mo phong audit fix).');
      })
    );
    testApp.use(errorHandler);

    let wrongKindOfError: string | null = null;
    try {
      await request(testApp).get('/partial-then-fail');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Lỗi kết nối mạng bình thường (socket bị đóng vì headers đã gửi) được CHẤP NHẬN — chỉ coi là FAIL nếu
      // đúng loại lỗi "ghi header/response lần 2" mà audit fix nhắm diệt.
      if (/ERR_HTTP_HEADERS_SENT|write after end|WRITE_AFTER_END|ERR_STREAM_WRITE_AFTER_END/i.test(message)) {
        wrongKindOfError = message;
      }
    }
    expect(wrongKindOfError).toBeNull();
  });

  // BẰNG CHỨNG SỐNG — dùng LẠI createApp() thật (không phải testApp cục bộ ở trên) NGAY SAU 2 test trên →
  // nếu process/worker đã chết, dòng này không bao giờ chạy tới.
  it('NGAY SAU 2 test trên: route khác qua createApp() thật vẫn xử lý bình thường (404) → process/worker CÒN SỐNG', async () => {
    const app = createApp();
    // BOLA fix (20/8): agentsRouter/loRouter (Bearer-token) ĐÃ GỠ — route không tồn tại nay rơi thẳng xuống
    // 404 handler cuối chuỗi, KHÔNG còn middleware Bearer toàn cục chặn 401 trước đó.
    const res = await request(app).get('/route-khong-ton-tai-crash-test');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});

// AUDIT FIX (LOW, security-auditor 24/7) — call site thứ 4 dùng asyncHandler trong auth.ts (GET /v1/auth/me →
// asyncHandler(requireSession)) TRƯỚC ĐÓ chưa có regression test crash-survival nào đi qua createApp() THẬT +
// error middleware thật của app.ts. Describe này mô phỏng getBotDb() reject (lỗi hạ tầng DB) — ĐÚNG lớp bug
// gốc (lỗi async trong middleware không bắt được → crash process nếu thiếu asyncHandler).
//
// B39 (27/7) — CẬP NHẬT sau khi requireRcAuth → requireSession (KHÔNG còn gọi rcGetMe/Rocket.Chat, xem
// BUGS_FIXED.md B39): dependency mô phỏng lỗi đổi từ rcGetMe (mạng RC) sang getBotDb (DB) — ĐÚNG dependency
// requireSession thật sự gọi (session-middleware.ts). GIỮ NGUYÊN ý nghĩa gốc (crash-survival), chỉ đổi điểm
// mock cho khớp middleware mới.
describe('routes/auth.ts (GET /v1/auth/me qua asyncHandler(requireSession)) — lỗi hạ tầng DB bất ngờ', () => {
  const app = createApp();

  it('getBotDb() reject (giả lập DB sập) → 500 INTERNAL_ERROR qua middleware lỗi tập trung, KHÔNG throw ra ngoài supertest', async () => {
    vi.mocked(getBotDb).mockImplementationOnce(() => {
      throw new Error('ECONNREFUSED sigma-db-internal:5432 (mô phỏng Postgres sập/network timeout).');
    });
    const res = await request(app)
      .get('/v1/auth/me')
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=session-id-khong-lien-quan-crash-test`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: expect.any(String) });
    // KHÔNG lộ chi tiết lỗi mạng/hostname DB nội bộ ra response.
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(res.body)).not.toContain('sigma-db-internal');
  });

  // BẰNG CHỨNG SỐNG — request NGAY SAU (thiếu cookie → 401 SESSION_INVALID, KHÔNG chạm getBotDb vì
  // requireSession trả sớm trước khi đọc DB) → nếu process đã chết ở test trên, dòng này không chạy tới.
  it('NGAY SAU lỗi ở trên: GET /v1/auth/me thiếu cookie vẫn xử lý bình thường (401 SESSION_INVALID) → process/worker CÒN SỐNG', async () => {
    const res = await request(app).get('/v1/auth/me').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SESSION_INVALID');
  });
});
