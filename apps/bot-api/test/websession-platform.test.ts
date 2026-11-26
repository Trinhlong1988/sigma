// #3 (6/8, Admin Demo "đăng nhập máy mới đá phiên CŨ CÙNG NỀN như Zalo") — test derivePlatform (THUẦN) +
// revokeOtherSessionsSamePlatform (throwaway DB thật, CÙNG khuôn web-session-service.test.ts).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { createWebSession, getWebSession, derivePlatform, revokeOtherSessionsSamePlatform } from '../src/web-session-service.js';
import { makeAgent } from './fixtures.js';

const UA_ELECTRON = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SigMaPC/0.4.8 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

describe('derivePlatform — header thắng UA; Electron→exe; Android→apk; browser→web; thiếu cả hai→web', () => {
  it('header tường minh THẮNG User-Agent (dù UA nói khác)', () => {
    expect(derivePlatform(UA_BROWSER, 'apk')).toBe('apk');
    expect(derivePlatform(UA_ANDROID, 'web')).toBe('web');
    expect(derivePlatform(UA_ELECTRON, 'apk')).toBe('apk');
    expect(derivePlatform(UA_BROWSER, 'exe')).toBe('exe');
  });

  it('header hoa/thường/khoảng trắng vẫn nhận đúng (chuẩn hoá lower+trim)', () => {
    expect(derivePlatform(UA_BROWSER, '  APK ')).toBe('apk');
    expect(derivePlatform(UA_BROWSER, 'Exe')).toBe('exe');
  });

  it('header không hợp lệ/rỗng → BỎ QUA, suy từ User-Agent', () => {
    expect(derivePlatform(UA_ELECTRON, 'linux')).toBe('exe'); // giá trị lạ → fallback UA
    expect(derivePlatform(UA_ANDROID, '')).toBe('apk');
    expect(derivePlatform(UA_BROWSER, undefined)).toBe('web');
  });

  it('Electron UA → exe (kiểm TRƯỚC Chrome/Safari cùng chuỗi)', () => {
    expect(derivePlatform(UA_ELECTRON)).toBe('exe');
  });

  it('Android/Capacitor UA → apk', () => {
    expect(derivePlatform(UA_ANDROID)).toBe('apk');
    expect(derivePlatform('SomeApp Capacitor/5 (Android)')).toBe('apk');
  });

  it('trình duyệt thường → web', () => {
    expect(derivePlatform(UA_BROWSER)).toBe('web');
  });

  it('thiếu CẢ header lẫn UA → web', () => {
    expect(derivePlatform(null, null)).toBe('web');
    expect(derivePlatform(undefined, undefined)).toBe('web');
    expect(derivePlatform('')).toBe('web');
  });
});

describe('revokeOtherSessionsSamePlatform — đá phiên CŨ CÙNG NỀN, giữ nền khác', () => {
  it('3 phiên cùng agent (apk cũ + web + apk mới) → chỉ apk CŨ bị đá, web CÒN, trả đúng [apkCũ.id]', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const apkOld = await createWebSession(db, { agentId: agent.id, rcAuthToken: 't-apk-old', platform: 'apk', userAgent: UA_ANDROID });
    const web = await createWebSession(db, { agentId: agent.id, rcAuthToken: 't-web', platform: 'web', userAgent: UA_BROWSER });
    const apkNew = await createWebSession(db, { agentId: agent.id, rcAuthToken: 't-apk-new', platform: 'apk', userAgent: UA_ANDROID });

    const kicked = await revokeOtherSessionsSamePlatform(db, agent.id, 'apk', apkNew.id);

    expect(kicked).toEqual([apkOld.id]); // CHỈ apk cũ, KHÔNG kèm apk mới (except) hay web (nền khác)
    expect(await getWebSession(db, apkOld.id)).toBeNull(); // đã đá
    expect(await getWebSession(db, web.id)).not.toBeNull(); // web CÒN (đa-thiết-bị)
    expect(await getWebSession(db, apkNew.id)).not.toBeNull(); // phiên mới CÒN
  });

  it('effective platform suy từ userAgent khi cột platform = null (phiên CŨ trước tính năng)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    // Phiên CŨ: platform null nhưng userAgent Electron → effective 'exe'.
    const legacyExe = await db.webSession.create({
      data: { agentId: agent.id, rcAuthToken: 't-legacy-exe', userAgent: UA_ELECTRON, platform: null, expiresAt: new Date(Date.now() + 60_000) }
    });
    const newExe = await createWebSession(db, { agentId: agent.id, rcAuthToken: 't-new-exe', platform: 'exe', userAgent: UA_ELECTRON });

    const kicked = await revokeOtherSessionsSamePlatform(db, agent.id, 'exe', newExe.id);
    expect(kicked).toEqual([legacyExe.id]);
    expect(await getWebSession(db, legacyExe.id)).toBeNull();
  });

  it('KHÔNG đụng phiên của agent KHÁC (dù cùng nền)', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const aApk = await createWebSession(db, { agentId: a.id, rcAuthToken: 't-a-apk', platform: 'apk', userAgent: UA_ANDROID });
    const bApk = await createWebSession(db, { agentId: b.id, rcAuthToken: 't-b-apk', platform: 'apk', userAgent: UA_ANDROID });
    const aApkNew = await createWebSession(db, { agentId: a.id, rcAuthToken: 't-a-apk-new', platform: 'apk', userAgent: UA_ANDROID });

    const kicked = await revokeOtherSessionsSamePlatform(db, a.id, 'apk', aApkNew.id);
    expect(kicked).toEqual([aApk.id]);
    expect(await getWebSession(db, bApk.id)).not.toBeNull(); // agent B nguyên vẹn
  });

  it('KHÔNG đá phiên đã HẾT HẠN (coi như không còn)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const dead = await db.webSession.create({
      data: { agentId: agent.id, rcAuthToken: 't-dead', platform: 'apk', userAgent: UA_ANDROID, expiresAt: new Date(Date.now() - 60_000) }
    });
    const newApk = await createWebSession(db, { agentId: agent.id, rcAuthToken: 't-new', platform: 'apk', userAgent: UA_ANDROID });

    const kicked = await revokeOtherSessionsSamePlatform(db, agent.id, 'apk', newApk.id);
    expect(kicked).toEqual([]); // phiên hết hạn KHÔNG bị kể vào
    // hàng hết hạn không bị đụng (vẫn tồn tại ở DB, chỉ getWebSession coi là null vì hết hạn)
    expect(await db.webSession.count({ where: { id: dead.id } })).toBe(1);
  });

  it('agentId null/undefined → [] (KHÔNG đá gì — lưới an toàn chống where rỗng)', async () => {
    const db = getBotDb();
    const other = await makeAgent();
    await createWebSession(db, { agentId: other.id, rcAuthToken: 't-guard', platform: 'apk', userAgent: UA_ANDROID });
    const totalBefore = await db.webSession.count();

    expect(await revokeOtherSessionsSamePlatform(db, null, 'apk', 'bat-ky-id')).toEqual([]);
    expect(await revokeOtherSessionsSamePlatform(db, undefined, 'apk', 'bat-ky-id')).toEqual([]);
    expect(await db.webSession.count()).toBe(totalBefore); // KHÔNG hàng nào bị xóa
  });

  it('createWebSession lưu đúng cột platform', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const created = await createWebSession(db, { agentId: agent.id, rcAuthToken: 't-store', platform: 'exe' });
    const row = await db.webSession.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.platform).toBe('exe');
  });
});
