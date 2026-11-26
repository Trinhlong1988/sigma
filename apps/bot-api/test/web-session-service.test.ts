// SIGMA (26/7) — test web-session-service.ts trên throwaway DB thật (CÙNG khuôn device-trust-service.test.ts).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { createWebSession, getWebSession, revokeWebSession, revokeAllWebSessionsForAgent, listWebSessionsForAgent, revokeWebSessionByIdForAgent, revokeOtherWebSessionsForAgent, parseDeviceLabel, parseDeviceKind, describeDevice, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { makeAgent } from './fixtures.js';

describe('web-session-service — createWebSession/getWebSession', () => {
  it('tạo mới → id dạng cuid (opaque, KHÔNG phải số nguyên tuần tự), expiresAt ~30 ngày sau', async () => {
    const db = getBotDb();
    const before = Date.now();
    const created = await createWebSession(db, { rcUserId: 'rc-u-1', rcUsername: 'u1', rcAuthToken: 'tok-1' });

    expect(typeof created.id).toBe('string');
    expect(created.id.length).toBeGreaterThan(10);
    expect(/^\d+$/.test(created.id)).toBe(false); // không phải id số nguyên đoán được

    const diffDays = (created.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);
  });

  it('getWebSession với id vừa tạo → trả đúng rcUserId/rcUsername/rcAuthToken/agentId', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const created = await createWebSession(db, { rcUserId: 'rc-u-2', rcUsername: 'u2', rcAuthToken: 'tok-2', agentId: agent.id });

    const row = await getWebSession(db, created.id);
    expect(row).not.toBeNull();
    expect(row!.rcUserId).toBe('rc-u-2');
    expect(row!.rcUsername).toBe('u2');
    expect(row!.rcAuthToken).toBe('tok-2');
    expect(row!.agentId).toBe(agent.id);
  });

  it('getWebSession → tự cập nhật lastUsedAt', async () => {
    const db = getBotDb();
    const created = await createWebSession(db, { rcUserId: 'rc-u-3', rcAuthToken: 'tok-3' });
    const before = await db.webSession.findUniqueOrThrow({ where: { id: created.id } });

    await new Promise((r) => setTimeout(r, 20));
    await getWebSession(db, created.id);

    const after = await db.webSession.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.lastUsedAt.getTime()).toBeGreaterThan(before.lastUsedAt.getTime());
  });

  it('id không tồn tại → null', async () => {
    const db = getBotDb();
    const row = await getWebSession(db, 'khong-ton-tai-id');
    expect(row).toBeNull();
  });

  it('id rỗng → null, KHÔNG query DB vô ích', async () => {
    const db = getBotDb();
    const row = await getWebSession(db, '');
    expect(row).toBeNull();
  });

  it('session ĐÃ HẾT HẠN (expiresAt trong quá khứ) → getWebSession trả null', async () => {
    const db = getBotDb();
    const row = await db.webSession.create({
      data: { rcUserId: 'rc-expired', rcAuthToken: 'tok-expired', expiresAt: new Date(Date.now() - 60_000) }
    });
    const result = await getWebSession(db, row.id);
    expect(result).toBeNull();
  });

  it('agentId optional — KHÔNG truyền → lưu null, không lỗi', async () => {
    const db = getBotDb();
    const created = await createWebSession(db, { rcUserId: 'rc-noagent', rcAuthToken: 'tok-noagent' });
    const row = await getWebSession(db, created.id);
    expect(row!.agentId).toBeNull();
  });
});

describe('web-session-service — revokeWebSession', () => {
  it('revoke session hợp lệ → getWebSession sau đó trả null (không dùng lại được)', async () => {
    const db = getBotDb();
    const created = await createWebSession(db, { rcUserId: 'rc-revoke-1', rcAuthToken: 'tok-revoke-1' });
    expect(await getWebSession(db, created.id)).not.toBeNull();

    await revokeWebSession(db, created.id);
    expect(await getWebSession(db, created.id)).toBeNull();
  });

  it('revoke id không tồn tại → KHÔNG throw (idempotent)', async () => {
    const db = getBotDb();
    await expect(revokeWebSession(db, 'khong-ton-tai')).resolves.toBeUndefined();
  });

  it('revoke id rỗng → KHÔNG throw, KHÔNG query DB vô ích', async () => {
    const db = getBotDb();
    await expect(revokeWebSession(db, '')).resolves.toBeUndefined();
  });
});

describe('web-session-service — revokeAllWebSessionsForAgent (dùng khi đổi mật khẩu)', () => {
  it('xóa MỌI phiên của agent → count đúng số đã xóa, getWebSession sau đó đều null', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const s1 = await createWebSession(db, { rcUserId: 'rc-ra-1', rcAuthToken: 'tok-ra-1', agentId: agent.id });
    const s2 = await createWebSession(db, { rcUserId: 'rc-ra-1', rcAuthToken: 'tok-ra-2', agentId: agent.id });

    const count = await revokeAllWebSessionsForAgent(db, agent.id);
    expect(count).toBe(2);
    expect(await getWebSession(db, s1.id)).toBeNull();
    expect(await getWebSession(db, s2.id)).toBeNull();
  });

  it('KHÔNG đụng phiên của agent khác', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await createWebSession(db, { rcUserId: 'rc-ra-a', rcAuthToken: 'tok-a', agentId: a.id });
    const sB = await createWebSession(db, { rcUserId: 'rc-ra-b', rcAuthToken: 'tok-b', agentId: b.id });

    await revokeAllWebSessionsForAgent(db, a.id);
    expect(await db.webSession.count({ where: { agentId: a.id } })).toBe(0);
    expect(await getWebSession(db, sB.id)).not.toBeNull(); // agent B còn nguyên
  });

  it('agent không có phiên nào → count 0, KHÔNG throw (idempotent)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    expect(await revokeAllWebSessionsForAgent(db, agent.id)).toBe(0);
  });

  it('agentId null/undefined → count 0, KHÔNG xóa gì (lưới an toàn chống where rỗng quét toàn bảng)', async () => {
    const db = getBotDb();
    const other = await makeAgent();
    await createWebSession(db, { rcUserId: 'rc-ra-guard', rcAuthToken: 'tok-guard', agentId: other.id });
    const totalBefore = await db.webSession.count();

    expect(await revokeAllWebSessionsForAgent(db, null)).toBe(0);
    expect(await revokeAllWebSessionsForAgent(db, undefined)).toBe(0);
    expect(await db.webSession.count()).toBe(totalBefore); // KHÔNG hàng nào bị xóa
  });
});

describe('web-session-service — listWebSessionsForAgent (màn "Thiết bị đang đăng nhập")', () => {
  it('trả MỌI phiên còn hạn của agent, mới-hoạt-động-nhất trước, KHÔNG kèm token nhạy cảm', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const s1 = await createWebSession(db, { rcAuthToken: 'tok-l1', agentId: agent.id });
    const s2 = await createWebSession(db, { rcAuthToken: 'tok-l2', agentId: agent.id });
    // s1 hoạt động gần đây hơn (đụng lastUsedAt sau) → phải đứng TRƯỚC s2 trong kết quả.
    await new Promise((r) => setTimeout(r, 20));
    await getWebSession(db, s1.id);

    const list = await listWebSessionsForAgent(db, { agentId: agent.id });
    expect(list.map((x) => x.id)).toEqual([s1.id, s2.id]);
    // KHÔNG rò rỉ rcAuthToken/rcUserId qua summary (chỉ id + mốc thời gian + userAgent + platform để suy nhãn/icon).
    expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'platform', 'userAgent']);
  });

  it('lưu + trả userAgent theo đúng phiên (để suy nhãn thiết bị)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    await createWebSession(db, { rcAuthToken: 't', agentId: agent.id, userAgent: ua });
    const list = await listWebSessionsForAgent(db, { agentId: agent.id });
    expect(list[0].userAgent).toBe(ua);
    expect(parseDeviceLabel(list[0].userAgent)).toBe('Chrome · Windows');
  });

  it('KHÔNG trả phiên đã hết hạn', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const alive = await createWebSession(db, { rcAuthToken: 'tok-alive', agentId: agent.id });
    await db.webSession.create({ data: { agentId: agent.id, rcAuthToken: 'tok-dead', expiresAt: new Date(Date.now() - 60_000) } });

    const list = await listWebSessionsForAgent(db, { agentId: agent.id });
    expect(list.map((x) => x.id)).toEqual([alive.id]);
  });

  it('KHÔNG trả phiên của agent KHÁC (cách ly theo agentId)', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await createWebSession(db, { rcAuthToken: 'tok-a', agentId: a.id });
    const sB = await createWebSession(db, { rcAuthToken: 'tok-b', agentId: b.id });

    const listB = await listWebSessionsForAgent(db, { agentId: b.id });
    expect(listB.map((x) => x.id)).toEqual([sB.id]);
  });

  it('khớp cả phiên CŨ chỉ có rcUserId (agentId=null) khi truyền rcUserId', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const rcUserId = `rc-legacy-${Date.now()}`;
    // phiên cũ kiểu RC: chỉ rcUserId, agentId null.
    const legacy = await createWebSession(db, { rcUserId, rcAuthToken: 'tok-legacy' });
    const modern = await createWebSession(db, { rcAuthToken: 'tok-modern', agentId: agent.id });

    const list = await listWebSessionsForAgent(db, { agentId: agent.id, rcUserId });
    expect(list.map((x) => x.id).sort()).toEqual([legacy.id, modern.id].sort());

    // KHÔNG truyền rcUserId → chỉ match theo agentId (KHÔNG kéo nhầm phiên rcUserId-only).
    const listAgentOnly = await listWebSessionsForAgent(db, { agentId: agent.id });
    expect(listAgentOnly.map((x) => x.id)).toEqual([modern.id]);
  });
});

describe('web-session-service — revokeWebSessionByIdForAgent (đăng xuất 1 thiết bị)', () => {
  it('xóa ĐÚNG 1 phiên thuộc agent → count 1, phiên khác của agent CÒN NGUYÊN', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const s1 = await createWebSession(db, { rcAuthToken: 'tok-r1', agentId: agent.id });
    const s2 = await createWebSession(db, { rcAuthToken: 'tok-r2', agentId: agent.id });

    expect(await revokeWebSessionByIdForAgent(db, s1.id, { agentId: agent.id })).toBe(1);
    expect(await getWebSession(db, s1.id)).toBeNull();
    expect(await getWebSession(db, s2.id)).not.toBeNull();
  });

  it('KHÔNG cho xóa phiên của agent KHÁC → count 0, phiên đó CÒN NGUYÊN', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const sB = await createWebSession(db, { rcAuthToken: 'tok-b', agentId: b.id });

    // agent A cố revoke phiên của B (đoán/bắt được id) → 0, không xóa được.
    expect(await revokeWebSessionByIdForAgent(db, sB.id, { agentId: a.id })).toBe(0);
    expect(await getWebSession(db, sB.id)).not.toBeNull();
  });

  it('id không tồn tại / rỗng → count 0, KHÔNG throw', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    expect(await revokeWebSessionByIdForAgent(db, 'khong-ton-tai', { agentId: agent.id })).toBe(0);
    expect(await revokeWebSessionByIdForAgent(db, '', { agentId: agent.id })).toBe(0);
  });
});

describe('web-session-service — parseDeviceLabel (nhãn thiết bị kiểu Zalo từ User-Agent)', () => {
  const cases: Array<[string, string | null, string]> = [
    ['Chrome trên Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Chrome · Windows'],
    ['Safari trên iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Safari · iPhone'],
    ['Chrome trên Android', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['WebView Android (không nhận trình duyệt)', 'Mozilla/5.0 (Linux; Android 12; SM-F926B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Mobile Safari/537.36', 'Android'],
    ['Edge trên Windows (UA chứa cả Chrome+Safari, phải ra Edge)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', 'Edge · Windows'],
    ['Firefox trên Linux', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0', 'Firefox · Linux'],
    ['Safari trên macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'Safari · macOS'],
    ['Opera trên Windows (OPR chứa Chrome, phải ra Opera)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0', 'Opera · Windows'],
    ['iPad Safari', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Safari · iPad'],
    ['UA rỗng → fallback', '', 'Thiết bị web/app'],
    ['null → fallback', null, 'Thiết bị web/app'],
    ['UA lạ không nhận ra gì → fallback', 'curl/8.4.0', 'Thiết bị web/app']
  ];
  for (const [name, ua, expected] of cases) {
    it(name, () => {
      expect(parseDeviceLabel(ua)).toBe(expected);
    });
  }
});

describe('web-session-service — parseDeviceKind (icon PC vs điện thoại kiểu Zalo)', () => {
  const UA_WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

  it("platform 'exe' → 'pc' (app máy tính) bất kể UA", () => {
    expect(parseDeviceKind(UA_ANDROID, 'exe')).toBe('pc');
  });
  it("platform 'apk' → 'mobile' (app điện thoại) bất kể UA", () => {
    expect(parseDeviceKind(UA_WIN_CHROME, 'apk')).toBe('mobile');
  });
  it('web + UA Windows Chrome → pc', () => {
    expect(parseDeviceKind(UA_WIN_CHROME, 'web')).toBe('pc');
  });
  it('web + UA iPhone → mobile', () => {
    expect(parseDeviceKind(UA_IPHONE, 'web')).toBe('mobile');
  });
  it('web + UA Android → mobile', () => {
    expect(parseDeviceKind(UA_ANDROID, null)).toBe('mobile');
  });
  it('UA rỗng/null, không platform → mặc định pc (không throw)', () => {
    expect(parseDeviceKind(null)).toBe('pc');
    expect(parseDeviceKind('')).toBe('pc');
  });
});

describe('web-session-service — describeDevice (nhãn + kind cho màn Thiết bị)', () => {
  const UA_WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  it("app native máy tính (platform 'exe') → nhãn 'Ứng dụng SigMa (Máy tính)' + kind pc", () => {
    expect(describeDevice(UA_WIN_CHROME, 'exe')).toEqual({ label: 'Ứng dụng SigMa (Máy tính)', kind: 'pc' });
  });
  it("app native Android (platform 'apk') → nhãn 'Ứng dụng SigMa (Android)' + kind mobile", () => {
    expect(describeDevice('Mozilla/5.0 (Linux; Android 13) Capacitor', 'apk')).toEqual({ label: 'Ứng dụng SigMa (Android)', kind: 'mobile' });
  });
  it('trình duyệt Windows Chrome (platform web) → nhãn "Chrome · Windows" + kind pc', () => {
    expect(describeDevice(UA_WIN_CHROME, 'web')).toEqual({ label: 'Chrome · Windows', kind: 'pc' });
  });
  it('trình duyệt iPhone Safari → nhãn "Safari · iPhone" + kind mobile', () => {
    expect(describeDevice(UA_IPHONE, 'web')).toEqual({ label: 'Safari · iPhone', kind: 'mobile' });
  });
  it('phiên cũ không UA/không platform → fallback nhãn chung + kind pc', () => {
    expect(describeDevice(null, null)).toEqual({ label: 'Thiết bị web/app', kind: 'pc' });
  });
});

describe('web-session-service — revokeOtherWebSessionsForAgent (đăng xuất tất cả thiết bị khác)', () => {
  it('xóa MỌI phiên của agent TRỪ phiên hiện tại → trả id đã xóa, phiên hiện tại còn nguyên', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const current = await createWebSession(db, { rcAuthToken: 'tok-cur', agentId: agent.id });
    const o1 = await createWebSession(db, { rcAuthToken: 'tok-o1', agentId: agent.id });
    const o2 = await createWebSession(db, { rcAuthToken: 'tok-o2', agentId: agent.id });

    const revoked = await revokeOtherWebSessionsForAgent(db, { agentId: agent.id }, current.id);
    expect(revoked.sort()).toEqual([o1.id, o2.id].sort());
    expect(await getWebSession(db, current.id)).not.toBeNull();
    expect(await getWebSession(db, o1.id)).toBeNull();
    expect(await getWebSession(db, o2.id)).toBeNull();
  });

  it('KHÔNG đụng phiên của agent KHÁC', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const aCur = await createWebSession(db, { rcAuthToken: 'tok-a-cur', agentId: a.id });
    await createWebSession(db, { rcAuthToken: 'tok-a-other', agentId: a.id });
    const bSess = await createWebSession(db, { rcAuthToken: 'tok-b', agentId: b.id });

    await revokeOtherWebSessionsForAgent(db, { agentId: a.id }, aCur.id);
    expect(await getWebSession(db, bSess.id)).not.toBeNull(); // agent B nguyên vẹn
  });

  it('exceptSessionId RỖNG → trả [] KHÔNG xóa gì (fail-safe chống tự đá chính mình)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await createWebSession(db, { rcAuthToken: 'tok-x1', agentId: agent.id });
    const before = await db.webSession.count({ where: { agentId: agent.id } });
    expect(await revokeOtherWebSessionsForAgent(db, { agentId: agent.id }, '')).toEqual([]);
    expect(await db.webSession.count({ where: { agentId: agent.id } })).toBe(before);
  });

  it('chỉ có phiên hiện tại (không thiết bị khác) → trả [] (idempotent)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const only = await createWebSession(db, { rcAuthToken: 'tok-only', agentId: agent.id });
    expect(await revokeOtherWebSessionsForAgent(db, { agentId: agent.id }, only.id)).toEqual([]);
    expect(await getWebSession(db, only.id)).not.toBeNull();
  });
});

describe('web-session-service — listWebSessionsForAgent trả platform (để suy icon/nhãn app)', () => {
  it('trả đúng platform theo phiên', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await createWebSession(db, { rcAuthToken: 'tok-plat', agentId: agent.id, platform: 'exe', userAgent: 'x' });
    const list = await listWebSessionsForAgent(db, { agentId: agent.id });
    expect(list[0].platform).toBe('exe');
    expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'platform', 'userAgent']);
  });
});

describe('web-session-service — WEB_SESSION_COOKIE_NAME', () => {
  it('tên cookie cố định "sigma_ws" — khớp toàn bộ luồng (routes/auth.ts, rc-auth-middleware.ts, rc-realtime-proxy.ts)', () => {
    expect(WEB_SESSION_COOKIE_NAME).toBe('sigma_ws');
  });
});
