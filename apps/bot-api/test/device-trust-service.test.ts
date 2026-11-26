import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { issueDeviceToken, validateAndTouchDeviceToken } from '../src/device-trust-service.js';

async function makeAgent(db: ReturnType<typeof getBotDb>, name: string): Promise<number> {
  const agent = await db.agent.create({ data: { name } });
  return agent.id;
}

describe('device-trust-service — issueDeviceToken', () => {
  it('sinh token 64 ký tự hex (32 byte), hash khác plaintext, KHÔNG lưu plaintext trong DB', async () => {
    const db = getBotDb();
    const agentId = await makeAgent(db, 'Issue Test A');
    const r = await issueDeviceToken(db, agentId);
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    const row = await db.trustedDevice.findFirst({ where: { agentId } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).not.toBe(r.token);
    expect(row!.tokenHash).toHaveLength(64); // sha256 hex
  });

  it('expiresAt ~90 ngày sau thời điểm tạo', async () => {
    const db = getBotDb();
    const agentId = await makeAgent(db, 'Issue Test B');
    const before = Date.now();
    const r = await issueDeviceToken(db, agentId);
    const diffDays = (r.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(89.9);
    expect(diffDays).toBeLessThan(90.1);
  });

  it('label quá 200 ký tự bị cắt bớt, KHÔNG lỗi', async () => {
    const db = getBotDb();
    const agentId = await makeAgent(db, 'Issue Test C');
    await issueDeviceToken(db, agentId, 'x'.repeat(500));
    const row = await db.trustedDevice.findFirst({ where: { agentId } });
    expect(row!.label).toHaveLength(200);
  });

  it('1 agent cấp NHIỀU vé không thu hồi vé cũ (nhiều thiết bị song song hợp lệ)', async () => {
    const db = getBotDb();
    const agentId = await makeAgent(db, 'Issue Test D');
    const first = await issueDeviceToken(db, agentId, 'may 1');
    const second = await issueDeviceToken(db, agentId, 'may 2');
    expect(await validateAndTouchDeviceToken(db, agentId, first.token)).toBe(true);
    expect(await validateAndTouchDeviceToken(db, agentId, second.token)).toBe(true);
  });
});

describe('device-trust-service — validateAndTouchDeviceToken', () => {
  it('token đúng + đúng agentId + còn hạn → true, cập nhật lastUsedAt', async () => {
    const db = getBotDb();
    const agentId = await makeAgent(db, 'Validate Test A');
    const issued = await issueDeviceToken(db, agentId);
    const rowBefore = await db.trustedDevice.findFirst({ where: { agentId } });
    expect(rowBefore!.lastUsedAt).toBeNull();

    const ok = await validateAndTouchDeviceToken(db, agentId, issued.token);
    expect(ok).toBe(true);

    const rowAfter = await db.trustedDevice.findFirst({ where: { agentId } });
    expect(rowAfter!.lastUsedAt).not.toBeNull();
  });

  it('token đúng nhưng SAI agentId (vé của agent khác) → false — CHẶN dùng vé tài khoản A để bypass tài khoản B trên cùng máy', async () => {
    const db = getBotDb();
    const agentA = await makeAgent(db, 'Validate Test B-A');
    const agentB = await makeAgent(db, 'Validate Test B-B');
    const issuedForA = await issueDeviceToken(db, agentA);

    const ok = await validateAndTouchDeviceToken(db, agentB, issuedForA.token);
    expect(ok).toBe(false);
  });

  it('token KHÔNG tồn tại (chuỗi bất kỳ) → false, KHÔNG throw', async () => {
    const db = getBotDb();
    const agentId = await makeAgent(db, 'Validate Test C');
    const ok = await validateAndTouchDeviceToken(db, agentId, 'khong-ton-tai-trong-db-000000');
    expect(ok).toBe(false);
  });

  it('token rỗng → false ngay, KHÔNG query DB', async () => {
    const db = getBotDb();
    const agentId = await makeAgent(db, 'Validate Test D');
    const ok = await validateAndTouchDeviceToken(db, agentId, '');
    expect(ok).toBe(false);
  });

  it('token ĐÃ hết hạn → false', async () => {
    const db = getBotDb();
    const agentId = await makeAgent(db, 'Validate Test E');
    const issued = await issueDeviceToken(db, agentId);
    // Ép hết hạn thẳng trong DB (bằng thao tác update trực tiếp, không chờ 90 ngày thật).
    await db.trustedDevice.updateMany({ where: { agentId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const ok = await validateAndTouchDeviceToken(db, agentId, issued.token);
    expect(ok).toBe(false);
  });
});
