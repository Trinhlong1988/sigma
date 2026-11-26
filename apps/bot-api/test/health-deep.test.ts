// REGRESSION cho lỗ hổng "watchdog mù" lộ ra tối 30/9 (xem db-health.test.ts + memory
// incident_sigma_loi_ket_noi_sau_tat_may_dot_ngot_30_9): `/health` CHỈ trả {ok,service} TĨNH nên watchdog
// ghi "OK health 200" suốt trong lúc app người dùng đang chết vì PostgreSQL còn crash-recovery.
// `/health/deep` sinh ra để CHẠM DB THẬT — và vì nó tiết lộ trạng thái hạ tầng nên PHẢI đóng với Internet.
//
// KHÔNG mock cả module app: chỉ mock `db.js` (nguồn Prisma) để ép từng trạng thái DB, còn app dựng bằng
// createApp() THẬT — đúng đường mà cloudflared/watchdog đi tới, không phải một bản mô phỏng lệch điều kiện.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const queryRaw = vi.fn();
vi.mock('../src/db.js', () => ({
  getBotDb: () => ({ $queryRaw: queryRaw }),
  resetBotDb: async () => {}
}));

const { createApp } = await import('../src/app.js');

describe('/health/deep — kiểm DB thật, chỉ phục vụ máy cục bộ', () => {
  // BẪY (đã cắn thật khi viết test này): `beforeEach(() => queryRaw.mockReset())` TRẢ VỀ chính mock —
  // vitest coi giá trị trả về của beforeEach là HÀM TEARDOWN nên gọi lại mock sau mỗi test, mock đang
  // cấu hình reject ⇒ test đỏ dù assertion đã pass. PHẢI bọc ngoặc nhọn để beforeEach trả về undefined.
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it('DB chạy được → 200 + db:"up" (watchdog thấy XANH khi thật sự xanh)', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const res = await request(createApp()).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: 'bot-api', db: 'up' });
  });

  it('DB đang crash-recovery (57P03) → 503 + db:"starting" — ĐÂY là ca /health cũ báo xanh sai', async () => {
    const err = new Error('Database error. Code: `57P03`. Message: `the database system is starting up`') as Error & {
      code: string; meta: unknown;
    };
    err.code = 'P2039';
    err.meta = { driverAdapterError: { cause: { code: '57P03' } } };
    // mockImplementation (KHÔNG mockRejectedValue): mockRejectedValue tạo promise-bị-từ-chối NGAY tại
    // dòng này, trước khi request tới gắn handler → Node báo unhandledRejection và vitest tính là FAIL
    // dù code chạy đúng. Tạo LƯỜI mỗi lần gọi mới đúng hành vi thật của Prisma.
    queryRaw.mockImplementation(() => Promise.reject(err));
    const res = await request(createApp()).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, db: 'starting' });
  });

  it('DB chết hẳn → 503 + db:"down"', async () => {
    const err = new Error("Can't reach database server") as Error & { code: string };
    err.code = 'P1001';
    // mockImplementation (KHÔNG mockRejectedValue): mockRejectedValue tạo promise-bị-từ-chối NGAY tại
    // dòng này, trước khi request tới gắn handler → Node báo unhandledRejection và vitest tính là FAIL
    // dù code chạy đúng. Tạo LƯỜI mỗi lần gọi mới đúng hành vi thật của Prisma.
    queryRaw.mockImplementation(() => Promise.reject(err));
    const res = await request(createApp()).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, db: 'down' });
  });

  it('request đi qua cloudflared (có x-forwarded-for) → 404, KHÔNG lộ trạng thái hạ tầng ra Internet', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const res = await request(createApp()).get('/health/deep').set('X-Forwarded-For', '1.2.3.4');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('db');
    // KHÔNG được chạm DB khi đã từ chối (tránh biến endpoint thành kênh dò tải DB từ bên ngoài).
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('kẻ ngoài tự bơm X-Forwarded-For: 127.0.0.1 cũng KHÔNG qua được cổng', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const res = await request(createApp()).get('/health/deep').set('X-Forwarded-For', '127.0.0.1');
    expect(res.status).toBe(404);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('/health NÔNG giữ nguyên hợp đồng cũ {ok,service} — KHÔNG lộ thêm gì (cloudflared/Playwright đang dùng)', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'bot-api' });
  });
});
