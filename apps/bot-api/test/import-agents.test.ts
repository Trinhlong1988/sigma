// Test cho scripts/import-agents-from-customers.mjs — import hàng loạt Customer -> Agent + user Rocket.Chat.
// CÙNG khuôn auth-routes.test.ts: mock CẠNH mạng duy nhất (rc-client), chạy thật trên DB throwaway Postgres
// (global-setup.ts). KHÔNG assert theo tổng số candidate toàn cục (nhiều `it()` trong cùng file chia sẻ 1 DB
// — Customer tạo ở test trước có thể còn agentId=NULL nếu cố ý không import, làm lệch tổng số ở test sau) —
// mọi assertion tra CỤ THỂ theo id/code của Customer do CHÍNH test đó tạo ra, không dựa vào count toàn cục.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/rc-client.js', () => ({
  rcCreateUser: vi.fn(),
  rcDeleteUser: vi.fn()
}));

import { getBotDb } from '../src/db.js';
import { rcCreateUser, rcDeleteUser } from '../src/rc-client.js';
import { importAgentsFromCustomers, suggestUsername, generateStrongPassword } from '../scripts/import-agents-from-customers.mjs';
import { runCleanup } from '../scripts/cleanup-imported-test-customers.mjs';

function uniqSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function makeCustomer(overrides: Partial<{ email: string | null; fullName: string; phone: string | null; agentId: number | null; deletedAt: Date | null }> = {}) {
  const db = getBotDb();
  const suffix = uniqSuffix();
  return db.customer.create({
    data: {
      code: `IMPTEST_${suffix}`,
      fullName: overrides.fullName ?? 'Khách Hàng Test',
      nickname: 'KH Test',
      email: overrides.email === undefined ? `imptest_${suffix}@example.com` : overrides.email,
      phone: overrides.phone === undefined ? '0911111111' : overrides.phone,
      agentId: overrides.agentId ?? null,
      deletedAt: overrides.deletedAt ?? null
    }
  });
}

describe('suggestUsername (port từ apps/web-demo/src/screens/OtpScreen.tsx)', () => {
  it('lấy phần trước @, hạ chữ thường, thay ký tự lạ bằng _', () => {
    expect(suggestUsername('DemoUser+Test1@Example.COM')).toBe('demouser_test1');
    expect(suggestUsername('plain.user@example.com')).toBe('plain_user');
  });
});

describe('generateStrongPassword', () => {
  it('sinh mật khẩu ĐỦ MẠNH + KHÁC NHAU mỗi lần gọi (CSPRNG, không phải chuỗi cố định)', () => {
    const a = generateStrongPassword();
    const b = generateStrongPassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[0-9]/);
  });
});

describe('importAgentsFromCustomers', () => {
  beforeEach(() => {
    vi.mocked(rcCreateUser).mockReset();
    vi.mocked(rcDeleteUser).mockReset();
  });

  it('Customer thiếu email (null) → BỎ QUA rõ ràng (skippedNoEmail), KHÔNG gọi rcCreateUser, KHÔNG có trong successes/errors', async () => {
    const db = getBotDb();
    const c = await makeCustomer({ email: null });

    const report = await importAgentsFromCustomers(db);

    expect(report.skippedNoEmail.some((s) => s.id === c.id)).toBe(true);
    expect(report.successes.some((s) => s.id === c.id)).toBe(false);
    expect(report.errors.some((e) => e.id === c.id)).toBe(false);
    expect(rcCreateUser).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'Khách Hàng Test' }));

    const row = await db.customer.findUnique({ where: { id: c.id } });
    expect(row!.agentId).toBeNull(); // KHÔNG bị đánh dấu đã import
  });

  it('Customer đã có agentId (đã import từ trước) → KHÔNG được quét lại, kể cả có email hợp lệ', async () => {
    const db = getBotDb();
    const existingAgent = await db.agent.create({ data: { name: 'Đại lý có sẵn' } });
    const c = await makeCustomer({ agentId: existingAgent.id });

    const report = await importAgentsFromCustomers(db);

    expect(report.successes.some((s) => s.id === c.id)).toBe(false);
    expect(report.skippedNoEmail.some((s) => s.id === c.id)).toBe(false);
    expect(report.errors.some((e) => e.id === c.id)).toBe(false);
  });

  it('Customer đã xóa mềm (deletedAt != null) → KHÔNG được quét dù agentId NULL + có email', async () => {
    const db = getBotDb();
    const c = await makeCustomer({ deletedAt: new Date() });

    const report = await importAgentsFromCustomers(db);

    expect(report.successes.some((s) => s.id === c.id)).toBe(false);
    expect(report.skippedNoEmail.some((s) => s.id === c.id)).toBe(false);
    expect(rcCreateUser).not.toHaveBeenCalled();
  });

  it('tạo Agent thành công → Agent có ĐÚNG field (name/email/phone/rcUserId/rcUsername) + Customer.agentId link đúng', async () => {
    const db = getBotDb();
    const c = await makeCustomer({ fullName: 'Nguyễn Văn Test', phone: '0987654321' });
    vi.mocked(rcCreateUser).mockResolvedValue({ ok: true, data: { _id: `rc-imp-${c.id}`, username: `imp_${c.id}` } });

    const report = await importAgentsFromCustomers(db);

    const success = report.successes.find((s) => s.id === c.id);
    expect(success).toBeDefined();
    expect(success!.rcUsername).toBe(`imp_${c.id}`);

    const agent = await db.agent.findUnique({ where: { id: success!.agentId } });
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe('Nguyễn Văn Test');
    expect(agent!.email).toBe(c.email);
    expect(agent!.phone).toBe('0987654321');
    expect(agent!.rcUserId).toBe(`rc-imp-${c.id}`);
    expect(agent!.rcUsername).toBe(`imp_${c.id}`);

    const row = await db.customer.findUnique({ where: { id: c.id } });
    expect(row!.agentId).toBe(agent!.id); // đánh dấu đã import
  });

  it('rcCreateUser gọi ĐÚNG username suy ra từ email + password KHÔNG rỗng/KHÔNG cố định', async () => {
    const db = getBotDb();
    const suffix = uniqSuffix();
    const email = `porttest_${suffix}@example.com`;
    const c = await makeCustomer({ email });
    vi.mocked(rcCreateUser).mockResolvedValue({ ok: true, data: { _id: `rc-port-${c.id}`, username: `porttest_${suffix}` } });

    await importAgentsFromCustomers(db);

    expect(rcCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: `porttest_${suffix}`, email, name: 'Khách Hàng Test' })
    );
    const call = vi.mocked(rcCreateUser).mock.calls.find((args) => args[0].email === email);
    expect(call![0].password.length).toBeGreaterThanOrEqual(16);
  });

  it('1 dòng lỗi (rcCreateUser thất bại — username trùng) KHÔNG chặn dòng khác: dòng lỗi vào errors, dòng còn lại vẫn thành công', async () => {
    const db = getBotDb();
    const failing = await makeCustomer({ fullName: 'Sẽ Lỗi' });
    const ok = await makeCustomer({ fullName: 'Sẽ Thành Công' });

    vi.mocked(rcCreateUser).mockImplementation(async (input) => {
      if (input.email === failing.email) {
        return { ok: false, kind: 'HTTP', status: 400, errorCode: 'error-field-unavailable', message: 'Username đã tồn tại' };
      }
      return { ok: true, data: { _id: `rc-${input.username}`, username: input.username } };
    });

    const report = await importAgentsFromCustomers(db);

    const errorRow = report.errors.find((e) => e.id === failing.id);
    expect(errorRow).toBeDefined();
    expect(errorRow!.reason).toContain('rcCreateUser thất bại');

    const successRow = report.successes.find((s) => s.id === ok.id);
    expect(successRow).toBeDefined();

    const failingRow = await db.customer.findUnique({ where: { id: failing.id } });
    expect(failingRow!.agentId).toBeNull(); // KHÔNG bị đánh dấu đã import khi lỗi
    const okRow = await db.customer.findUnique({ where: { id: ok.id } });
    expect(okRow!.agentId).not.toBeNull();

    // `failing` CỐ Ý giữ agentId=NULL (đúng hành vi mong đợi khi lỗi) — nhưng script quét TOÀN BỘ bảng
    // customers (KHÔNG có tham số scope/giới hạn theo test, đúng thiết kế thật — brief không yêu cầu scoping),
    // nên nếu không dọn, dòng này sẽ bị importAgentsFromCustomers() ở CÁC it() SAU quét lại và gọi rcCreateUser
    // lần nữa với mock implementation của test khác → lệch assertion "toHaveBeenCalledTimes"/"not.toHaveBeenCalled"
    // ở các test sau (đã tự bắt được bug isolation này khi chạy suite thật, KHÔNG suy đoán). Xóa mềm để loại
    // khỏi phạm vi quét của các it() tiếp theo trong CÙNG file — mô phỏng đúng "Admin Demo tự xóa dòng lỗi khỏi
    // danh sách chờ" trong thực tế, không đổi ngữ nghĩa test.
    await db.customer.update({ where: { id: failing.id }, data: { deletedAt: new Date() } });
  });

  it('Agent.email ĐÃ tồn tại từ trước (không thuộc Customer này) → báo lỗi rõ, KHÔNG gọi rcCreateUser, KHÔNG tạo Agent thứ 2', async () => {
    const db = getBotDb();
    const suffix = uniqSuffix();
    const email = `dupagent_${suffix}@example.com`;
    await db.agent.create({ data: { name: 'Agent Có Sẵn', email } });
    const c = await makeCustomer({ email });

    const beforeCount = await db.agent.count();
    const report = await importAgentsFromCustomers(db);
    const afterCount = await db.agent.count();

    expect(afterCount).toBe(beforeCount); // không tạo thêm Agent nào
    expect(rcCreateUser).not.toHaveBeenCalled();
    const errorRow = report.errors.find((e) => e.id === c.id);
    expect(errorRow).toBeDefined();
    expect(errorRow!.reason).toContain('đã tồn tại');

    // `c` giữ agentId=NULL (lỗi trùng Agent.email, đúng hành vi mong đợi) — dọn khỏi phạm vi quét của các
    // it() SAU trong CÙNG file (CÙNG lý do đã ghi ở test "1 dòng lỗi" phía trên: script quét TOÀN BỘ bảng,
    // không có scope theo test).
    await db.customer.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
  });

  it('IDEMPOTENT: chạy 2 lần liên tiếp trên CÙNG dữ liệu → lần 2 KHÔNG tạo thêm Agent/gọi rcCreateUser cho Customer đã import ở lần 1', async () => {
    const db = getBotDb();
    const c = await makeCustomer({ fullName: 'Idempotent Test' });
    vi.mocked(rcCreateUser).mockResolvedValue({ ok: true, data: { _id: `rc-idem-${c.id}`, username: `idem_${c.id}` } });

    const firstReport = await importAgentsFromCustomers(db);
    const firstSuccess = firstReport.successes.find((s) => s.id === c.id);
    expect(firstSuccess).toBeDefined();
    expect(rcCreateUser).toHaveBeenCalledTimes(1);

    const agentCountAfterFirst = await db.agent.count();

    vi.mocked(rcCreateUser).mockClear();
    const secondReport = await importAgentsFromCustomers(db);

    // Customer đã import KHÔNG còn xuất hiện ở BẤT KỲ danh sách nào của lần chạy thứ 2 (không phải candidate nữa).
    expect(secondReport.successes.some((s) => s.id === c.id)).toBe(false);
    expect(secondReport.errors.some((e) => e.id === c.id)).toBe(false);
    expect(secondReport.skippedNoEmail.some((s) => s.id === c.id)).toBe(false);
    expect(rcCreateUser).not.toHaveBeenCalled(); // lần 2 không gọi RC cho dòng đã xong

    const agentCountAfterSecond = await db.agent.count();
    expect(agentCountAfterSecond).toBe(agentCountAfterFirst); // không tạo thêm Agent nào

    const row = await db.customer.findUnique({ where: { id: c.id } });
    expect(row!.agentId).toBe(firstSuccess!.agentId); // agentId giữ nguyên, không đổi/không nhân đôi
  });

  // AUDIT FIX regression (26/7, security-auditor độc lập — MEDIUM/CONFIRMED): rcCreateUser tạo user RC THẬT
  // thành công, nhưng bước DB sau đó lỗi (mô phỏng bằng 2 Customer khác nhau nhưng rcCreateUser mock trả VỀ
  // CÙNG 1 rcUserId — Agent.rcUserId là UNIQUE ở schema, dòng thứ 2 vỡ constraint NGAY TRONG transaction) →
  // PHẢI tự gọi rcDeleteUser xóa lại user RC vừa tạo, KHÔNG được để "mồ côi" (tồn tại ở RC, không Agent nào
  // trỏ tới, mật khẩu ngẫu nhiên không ai biết, không tự dọn được).
  it('DB lỗi SAU KHI rcCreateUser đã tạo user RC thật (rcUserId trùng, vỡ constraint) → tự động compensate bằng rcDeleteUser', async () => {
    const db = getBotDb();
    const cFirst = await makeCustomer({ fullName: 'Đã Có RC User' });
    const cSecond = await makeCustomer({ fullName: 'Sẽ Vỡ Constraint' });
    const sharedRcId = `rc-collision-${cFirst.id}`;

    vi.mocked(rcCreateUser).mockImplementation(async (input) => ({ ok: true, data: { _id: sharedRcId, username: input.username } }));
    vi.mocked(rcDeleteUser).mockResolvedValue({ ok: true, data: { success: true } });

    const report = await importAgentsFromCustomers(db);

    const firstSuccess = report.successes.find((s) => s.id === cFirst.id);
    expect(firstSuccess).toBeDefined(); // dòng đầu tạo Agent bình thường, chiếm mất rcUserId đó.

    const secondError = report.errors.find((e) => e.id === cSecond.id);
    expect(secondError).toBeDefined();
    expect(secondError!.reason).toContain('ĐÃ tự xóa RC user'); // xác nhận compensate CHẠY THẬT, không chỉ log suông.
    expect(rcDeleteUser).toHaveBeenCalledTimes(1);
    const expectedUsername = suggestUsername(cSecond.email!);
    expect(rcDeleteUser).toHaveBeenCalledWith(expectedUsername); // ĐÚNG username của dòng bị lỗi (cSecond), không phải cFirst.

    // Customer thứ 2 KHÔNG bị kẹt ở sentinel -1 — claim đã được release lại về null để lần chạy sau thử lại được.
    const secondRow = await db.customer.findUnique({ where: { id: cSecond.id } });
    expect(secondRow!.agentId).toBeNull();

    // Dọn khỏi phạm vi các it() sau (cùng lý do đã ghi ở các test trên).
    await db.customer.update({ where: { id: cSecond.id }, data: { deletedAt: new Date() } });
  });

  // AUDIT FIX regression (26/7, LOW/PLAUSIBLE): claim atomic chặn 2 lượt gọi SONG SONG cùng xử lý 1 Customer
  // — trước đây check-then-act không khóa gì, phụ thuộc hoàn toàn vào Rocket.Chat tự chặn trùng (chưa verify
  // độc lập được). Test gọi importAgentsFromCustomers() 2 LẦN THẬT SỰ SONG SONG (Promise.all, không phải
  // tuần tự) trên CÙNG 1 Customer — CHỈ ĐÚNG 1 lần được tạo Agent, KHÔNG được cả 2.
  it('CONCURRENCY: 2 lượt gọi importAgentsFromCustomers() song song trên CÙNG dữ liệu → CHỈ 1 lượt tạo Agent cho 1 Customer, không tạo đôi', async () => {
    const db = getBotDb();
    const c = await makeCustomer({ fullName: 'Concurrency Test' });
    vi.mocked(rcCreateUser).mockImplementation(async (input) => ({ ok: true, data: { _id: `rc-conc-${c.id}-${Math.random()}`, username: input.username } }));

    const [reportA, reportB] = await Promise.all([importAgentsFromCustomers(db), importAgentsFromCustomers(db)]);

    const successesForC = [...reportA.successes, ...reportB.successes].filter((s) => s.id === c.id);
    expect(successesForC).toHaveLength(1); // ĐÚNG 1 lượt thắng, không phải 0 hay 2.

    const agentsWithThisCustomer = await db.agent.count({ where: { rcUserId: { startsWith: `rc-conc-${c.id}-` } } });
    expect(agentsWithThisCustomer).toBe(1); // xác nhận thật trong DB, không chỉ tin report trả về.
  });
});

// AUDIT FIX regression (26/7, security-auditor độc lập — LOW/CONFIRMED): cảnh báo "email không khớp alias
// test" TRƯỚC ĐÂY chỉ in ra màn hình, `runCleanup({confirm:true})` vẫn xóa thẳng — giờ PHẢI chặn thật, không
// xóa GÌ CẢ nếu có bất kỳ dòng đáng ngờ nào trong phạm vi.
describe('cleanup-imported-test-customers — chặn xóa khi có dòng đáng ngờ', () => {
  beforeEach(() => {
    vi.mocked(rcDeleteUser).mockReset();
  });

  it('Agent có email KHÔNG khớp dạng "+testimportN" (dù Customer.code khớp prefix TESTKH) → --confirm KHÔNG xóa GÌ CẢ, trả blockedBySuspicious', async () => {
    const db = getBotDb();
    const suffix = uniqSuffix();
    const suspiciousAgent = await db.agent.create({ data: { name: 'Trông đáng ngờ', email: `khong-phai-test-alias-${suffix}@example.com`, rcUsername: `suspicious_${suffix}` } });
    const c = await db.customer.create({
      data: { code: `TESTKH_SUSPICIOUS_${suffix}`, fullName: 'Đáng ngờ', nickname: 'KH', agentId: suspiciousAgent.id }
    });

    const result = await runCleanup(db, { confirm: true });

    expect(result.result).toBeNull(); // KHÔNG xóa gì — bị chặn.
    expect(result.blockedBySuspicious?.length).toBeGreaterThan(0);
    expect(rcDeleteUser).not.toHaveBeenCalled();

    const agentStillThere = await db.agent.findUnique({ where: { id: suspiciousAgent.id } });
    expect(agentStillThere).not.toBeNull(); // Agent VẪN CÒN — không bị xóa nhầm.
    const customerRow = await db.customer.findUnique({ where: { id: c.id } });
    expect(customerRow!.agentId).toBe(suspiciousAgent.id); // link VẪN CÒN nguyên.

    // Dọn tay (test tự tạo, không qua đường import thật).
    await db.customer.delete({ where: { id: c.id } });
    await db.agent.delete({ where: { id: suspiciousAgent.id } });
  });
});
