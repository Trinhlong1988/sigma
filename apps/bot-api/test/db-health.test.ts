// REGRESSION cho sự cố THẬT tối 30/9/2026 (memory incident_sigma_loi_ket_noi_sau_tat_may_dot_ngot_30_9):
// máy tắt đột ngột 19:06 → PostgreSQL crash-recovery → Prisma ném 57P03 → bot-api trả 500 INTERNAL_ERROR →
// app hiện "Lỗi kết nối mạng, vui lòng kiểm tra đường truyền" (SAI BẢN CHẤT), còn watchdog vẫn ghi
// "OK health 200" suốt vì /health KHÔNG chạm DB (check không thật sự chạy = false PASS, R198).
//
// Test này khoá CẢ HAI lỗ hổng đó:
//   (A) /health/deep chạm DB thật, chỉ phục vụ loopback, trả đúng 503 khi DB chưa sẵn sàng.
//   (B) lỗi 57P03 → 503 DB_STARTING (KHÔNG còn lẫn vào 500 chung).
// HÌNH DẠNG LỖI dùng ở đây LẤY ĐÚNG từ log _bot-api.log tối 30/9 (Prisma 7 + @prisma/adapter-pg bọc nhiều
// tầng: mã ngoài cùng là P2039, mã thật 57P03 nằm trong meta.driverAdapterError.cause) — KHÔNG bịa shape,
// vì bịa shape chính là cách bug này lọt lần đầu (memory feedback_mock_shape_accuracy_assert_values).
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { kiemTraDb, phanLoaiLoiDb } from '../src/db-health.js';
import { errorHandler } from '../src/app.js';

/** Bản sao ĐÚNG hình dạng lỗi Prisma ghi trong log thật tối 30/9. */
function loiPrisma57P03(): unknown {
  const err = new Error(
    'Invalid `db.webSession.findUnique()` invocation\nDatabase error. Code: `57P03`. ' +
      'Message: `the database system is starting up`'
  ) as Error & { code: string; meta: unknown };
  err.code = 'P2039';
  err.meta = {
    modelName: 'WebSession',
    driverAdapterError: { cause: { code: '57P03', message: 'the database system is starting up' } }
  };
  return err;
}

describe('phanLoaiLoiDb — nhận đúng lỗi hạ tầng DB', () => {
  it('lỗi 57P03 lồng sâu trong meta.driverAdapterError.cause → starting', () => {
    expect(phanLoaiLoiDb(loiPrisma57P03())).toBe('starting');
  });

  it('chỉ có câu chữ, KHÔNG có mã code → vẫn nhận ra starting', () => {
    expect(phanLoaiLoiDb(new Error('the database system is starting up'))).toBe('starting');
  });

  it('DB không kết nối được (P1001 / ECONNREFUSED) → down', () => {
    const e = new Error("Can't reach database server") as Error & { code: string };
    e.code = 'P1001';
    expect(phanLoaiLoiDb(e)).toBe('down');
    const e2 = new Error('connect ECONNREFUSED 127.0.0.1:5432') as Error & { code: string };
    e2.code = 'ECONNREFUSED';
    expect(phanLoaiLoiDb(e2)).toBe('down');
  });

  it('lỗi NGHIỆP VỤ bình thường → null (KHÔNG được vơ thành lỗi DB rồi trả 503 sai)', () => {
    const e = new Error('Unique constraint failed') as Error & { code: string };
    e.code = 'P2002';
    expect(phanLoaiLoiDb(e)).toBeNull();
    expect(phanLoaiLoiDb(new Error('agentId không hợp lệ'))).toBeNull();
    expect(phanLoaiLoiDb(undefined)).toBeNull();
  });

  it('đối tượng lỗi TỰ TRỎ VÒNG không làm treo/tràn ngăn xếp', () => {
    const a: Record<string, unknown> = { code: 'P2002' };
    a.cause = a;
    expect(phanLoaiLoiDb(a)).toBeNull();
  });
});

describe('kiemTraDb — truy vấn THẬT, không bao giờ throw', () => {
  it('SELECT 1 chạy được → up', async () => {
    expect(await kiemTraDb({ $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) } as never)).toBe('up');
  });

  it('DB đang khởi động → starting', async () => {
    expect(await kiemTraDb({ $queryRaw: vi.fn().mockRejectedValue(loiPrisma57P03()) } as never)).toBe('starting');
  });

  it('lỗi LẠ không phân loại được → down (fail-closed, KHÔNG báo xanh khi không chắc)', async () => {
    expect(await kiemTraDb({ $queryRaw: vi.fn().mockRejectedValue(new Error('chuyện gì đó')) } as never)).toBe('down');
  });
});

describe('errorHandler — 57P03 KHÔNG còn rơi vào 500 chung', () => {
  function app(nem: unknown) {
    const a = express();
    a.get('/thu', (_req, _res, next) => next(nem));
    a.use(errorHandler);
    return a;
  }

  it('57P03 → 503 DB_STARTING + câu tiếng Việt nói ĐÚNG việc cần làm (đợi), KHÔNG đổ tại đường truyền', async () => {
    const res = await request(app(loiPrisma57P03())).get('/thu');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_STARTING');
    expect(res.body.message).toContain('đang khởi động lại');
    expect(res.body.message).not.toContain('đường truyền');
    // KHÔNG lộ chi tiết nội bộ ra client (giữ nguyên nguyên tắc cũ của errorHandler).
    expect(JSON.stringify(res.body)).not.toContain('57P03');
    expect(JSON.stringify(res.body)).not.toContain('webSession');
  });

  it('DB chết hẳn → 503 DB_UNAVAILABLE', async () => {
    const e = new Error("Can't reach database server") as Error & { code: string };
    e.code = 'P1001';
    const res = await request(app(e)).get('/thu');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  it('lỗi thường vẫn là 500 INTERNAL_ERROR như cũ (không đổi hành vi cũ)', async () => {
    const res = await request(app(new Error('lỗi code bình thường'))).get('/thu');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });
});
