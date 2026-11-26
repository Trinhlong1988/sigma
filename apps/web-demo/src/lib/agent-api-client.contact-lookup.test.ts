// SIGMA (31/7) — regression test cho lookupAgentByContact() (agent-api-client.ts), nối UI "Hoặc tìm theo
// email/SĐT" ở ContactsScreen.tsx. File TÁCH RIÊNG khỏi agent-api-client.test.ts (KHÔNG gộp) — file đó đang
// là phạm vi làm việc riêng của đợt B71-part2 (OCR preview, previewLoOcr()), tách để tránh đụng/conflict khi
// 2 việc build song song trên CÙNG file chưa commit. Mock global.fetch (KHÔNG gọi bot-api thật, KHÔNG chạm DB
// `sigma`) — shape response ĐÚNG NGUYÊN VĂN route GET /v1/me/friends/lookup-by-contact (routes/me.ts):
// trả THẲNG object (nhánh email) hoặc mảng (nhánh SĐT), KHÔNG bọc {ok:true,...} — client tự bọc.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupAgentByContact } from './agent-api-client';

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

describe('lookupAgentByContact', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gọi đúng GET /v1/me/friends/lookup-by-contact?q=... (query encode đúng, kể cả ký tự @)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200, { id: 1, code: 'DL001', name: 'A' }));
    vi.stubGlobal('fetch', fetchMock);

    await lookupAgentByContact('a b@example.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/me/friends/lookup-by-contact?q=');
    expect(String(url)).toContain(encodeURIComponent('a b@example.com'));
  });

  it('email → data là 1 object AgentLookupResult (KHÔNG phải mảng)', async () => {
    const body = { id: 42, code: 'DL042', name: 'Nguyễn Văn A' };
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, body)));

    const r = await lookupAgentByContact('a@example.com');

    expect(r).toEqual({ ok: true, data: body });
    expect(Array.isArray(r.ok ? r.data : null)).toBe(false);
  });

  it('SĐT nhiều kết quả → data là MẢNG đúng nguyên văn', async () => {
    const body = [
      { id: 1, code: 'DL001', name: 'Bạn B' },
      { id: 2, code: null, name: 'Bạn C' }
    ];
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, body)));

    const r = await lookupAgentByContact('0901234567');

    expect(r).toEqual({ ok: true, data: body });
    expect(Array.isArray(r.ok ? r.data : null)).toBe(true);
  });

  it('SĐT không khớp ai → data là MẢNG RỖNG, ok:true (KHÔNG phải lỗi)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, [])));

    const r = await lookupAgentByContact('0900000609');

    expect(r).toEqual({ ok: true, data: [] });
  });

  it('email không tồn tại → 404 AGENT_NOT_FOUND → ok:false đúng error/message thật của bot-api', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(404, { error: 'AGENT_NOT_FOUND', message: 'Không tìm thấy đại lý với email "x@x.com".' })));

    const r = await lookupAgentByContact('x@x.com');

    expect(r).toEqual({ ok: false, error: 'AGENT_NOT_FOUND', message: 'Không tìm thấy đại lý với email "x@x.com".' });
  });

  it('lỗi mạng (fetch throw) → NETWORK_ERROR, KHÔNG throw ra ngoài', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('mất mạng'); }));

    const r = await lookupAgentByContact('a@example.com');

    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error).toBe('NETWORK_ERROR');
  });
});
