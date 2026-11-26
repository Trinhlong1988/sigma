// P1 (6/8) — regression test cho SWR cache danh tính /auth/me (bot-api-client.ts): write-through +
// getCachedAgentId() đồng bộ + dedupe request đang bay + clear lúc đăng xuất. Mock './proxy-fetch' (mạng) —
// KHÔNG DOM, chạy env node cùng lớp "pure-logic test" của vitest.config.ts gốc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./proxy-fetch', () => ({ proxyFetch: vi.fn() }));

import { proxyFetch } from './proxy-fetch';
import {
  clearAuthenticatedAgentCache,
  fetchAuthenticatedAgent,
  getCachedAgentId,
  getCachedAuthenticatedAgent
} from './bot-api-client';

const proxyFetchMock = vi.mocked(proxyFetch);

function okResponse(agentId: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ agent: { id: agentId, code: null, name: 'Demo', rcUserId: 'Demo1784981008', rcUsername: 'Demo' } })
  } as unknown as Response;
}

function errResponse(status: number): Response {
  return { ok: false, status, json: async () => ({ error: 'UNAUTHORIZED', message: 'chưa đăng nhập' }) } as unknown as Response;
}

describe('bot-api-client — SWR cache danh tính /auth/me', () => {
  beforeEach(() => {
    clearAuthenticatedAgentCache();
    proxyFetchMock.mockReset();
  });
  afterEach(() => clearAuthenticatedAgentCache());

  it('getCachedAgentId() = null khi chưa gọi lần nào', () => {
    expect(getCachedAgentId()).toBeNull();
    expect(getCachedAuthenticatedAgent()).toBeNull();
  });

  it('fetch thành công → write-through cache → getCachedAgentId() đọc đồng bộ đúng id (0 hop cho lần sau)', async () => {
    proxyFetchMock.mockResolvedValue(okResponse(270));
    const r = await fetchAuthenticatedAgent();
    expect(r.ok).toBe(true);
    expect(getCachedAgentId()).toBe(270);
    expect(getCachedAuthenticatedAgent()?.rcUsername).toBe('demo');
  });

  it('2 lời gọi ĐỒNG THỜI lúc cache nguội (AppShell prime + ConversationScreen cold) → dedupe, chỉ 1 request /auth/me', async () => {
    let resolveFetch!: (res: Response) => void;
    proxyFetchMock.mockImplementation(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    const p1 = fetchAuthenticatedAgent();
    const p2 = fetchAuthenticatedAgent();
    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(okResponse(270));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    expect(getCachedAgentId()).toBe(270);
  });

  it('response non-2xx → KHÔNG cache (getCachedAgentId vẫn null, lần sau thử lại thật)', async () => {
    proxyFetchMock.mockResolvedValue(errResponse(401));
    const r = await fetchAuthenticatedAgent();
    expect(r.ok).toBe(false);
    expect(getCachedAgentId()).toBeNull();
  });

  it('clearAuthenticatedAgentCache() xóa cache (chống dùng nhầm agentId giữa 2 tài khoản lúc đăng xuất)', async () => {
    proxyFetchMock.mockResolvedValue(okResponse(270));
    await fetchAuthenticatedAgent();
    expect(getCachedAgentId()).toBe(270);
    clearAuthenticatedAgentCache();
    expect(getCachedAgentId()).toBeNull();
  });

  it('sau clear, gọi lại VẪN thực hiện request mới (không kẹt in-flight cũ)', async () => {
    proxyFetchMock.mockResolvedValue(okResponse(270));
    await fetchAuthenticatedAgent();
    clearAuthenticatedAgentCache();
    proxyFetchMock.mockResolvedValue(okResponse(999));
    await fetchAuthenticatedAgent();
    expect(getCachedAgentId()).toBe(999);
    expect(proxyFetchMock).toHaveBeenCalledTimes(2);
  });
});
