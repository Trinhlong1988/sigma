// B49 (29/7) — regression test cho bug "ảnh/file đính kèm thật luôn 403 khi tải qua <img>/<a>" (xem comment
// gốc attachment-blob.ts). Test xác nhận: (1) fetchAttachmentObjectUrl() LUÔN gọi qua proxyFetch (tự gắn
// credentials:'include' + header CSRF `x-sigma-client: web` — KHÔNG BAO GIỜ dùng raw `<img src>`/`<a href>`
// trỏ thẳng endpoint nữa), (2) cache theo URL (không gọi lại API cho cùng 1 tin nhắn re-render nhiều lần),
// (3) lỗi (403/mạng) KHÔNG bị cache — thử lại lần sau vẫn gọi lại được (không khoá vĩnh viễn 1 phiên hết hạn).
// KHÔNG test downloadAttachment() ở đây — hàm đó cần `document`/DOM thật (jsdom CHƯA cài trong repo này, mọi
// test hiện có ở apps/web-demo/src/lib/*.test.ts đều "pure-logic, environment node" — thêm jsdom là quyết định
// riêng ngoài phạm vi fix bug này, không tự ý thêm dependency mới).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAttachmentObjectUrl, invalidateAttachmentObjectUrl } from './attachment-blob';

const FAKE_URL = 'https://bot-api.example/v1/chat/attachments/abc123';

describe('fetchAttachmentObjectUrl', () => {
  let createObjectUrlSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectUrlSpy = vi.fn(() => 'blob:fake-object-url');
    // Node không có URL.createObjectURL thật — stub tối thiểu đủ cho test, không cần polyfill Blob thật.
    (globalThis as unknown as { URL: { createObjectURL: unknown } }).URL.createObjectURL = createObjectUrlSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gọi fetch với credentials:include + header CSRF x-sigma-client:web (KHÔNG phải raw <img src>)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, blob: async () => new Blob(['fake']) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAttachmentObjectUrl(FAKE_URL);

    expect(result).toBe('blob:fake-object-url');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(FAKE_URL);
    expect(calledInit?.credentials).toBe('include');
    expect((calledInit?.headers as Headers).get('x-sigma-client')).toBe('web');
  });

  it('gọi lại LẦN 2 cho CÙNG url → dùng cache, KHÔNG fetch lại (chống gọi API lặp khi component re-render)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['fake']) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await fetchAttachmentObjectUrl(FAKE_URL + '?cache-test-1');
    await fetchAttachmentObjectUrl(FAKE_URL + '?cache-test-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('403 (CSRF_BLOCKED giả lập) → reject, KHÔNG cache lỗi — lần gọi sau vẫn thử fetch lại', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const url = FAKE_URL + '?cache-test-2';
    await expect(fetchAttachmentObjectUrl(url)).rejects.toThrow('ATTACHMENT_FETCH_FAILED_403');
    await expect(fetchAttachmentObjectUrl(url)).rejects.toThrow('ATTACHMENT_FETCH_FAILED_403');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// B113 (2/8, Admin Demo báo trực tiếp "đổi avatar xong không tự cập nhật bên ngoài") — regression cho
// invalidateAttachmentObjectUrl() (fix bug thật: avatar/ảnh bìa mutable dùng CHUNG cơ chế cache "vĩnh viễn
// theo URL" vốn thiết kế cho ảnh chat bất biến, xem comment đầy đủ ở attachment-blob.ts).
describe('invalidateAttachmentObjectUrl', () => {
  let revokeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as unknown as { URL: { createObjectURL: unknown } }).URL.createObjectURL = vi.fn(() => 'blob:fake-object-url');
    revokeSpy = vi.fn();
    (globalThis as unknown as { URL: { revokeObjectURL: unknown } }).URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sau invalidate → lần fetch KẾ TIẾP cho CÙNG url gọi lại API (KHÔNG còn ăn cache cũ) — đúng bug thật avatar không cập nhật', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['fake']) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://bot-api.example/v1/agents/42/avatar';

    await fetchAttachmentObjectUrl(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Chưa invalidate → vẫn cache HIT (hành vi cache cũ giữ nguyên cho trường hợp bình thường).
    await fetchAttachmentObjectUrl(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateAttachmentObjectUrl(url);
    await fetchAttachmentObjectUrl(url);
    expect(fetchMock).toHaveBeenCalledTimes(2); // đổi avatar xong → mount lại phải thấy ảnh MỚI, không phải cache cũ.
  });

  it('invalidate url CHƯA từng cache (chưa ai từng xem avatar này) → no-op, KHÔNG throw', () => {
    expect(() => invalidateAttachmentObjectUrl('https://bot-api.example/v1/agents/999/avatar')).not.toThrow();
  });

  it('invalidate revoke blob URL cũ (tránh rò rỉ bộ nhớ) — best-effort, đợi promise resolve trước khi revoke', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['fake']) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://bot-api.example/v1/agents/7/avatar';

    await fetchAttachmentObjectUrl(url);
    invalidateAttachmentObjectUrl(url);
    await Promise.resolve(); // để .then() revoke chạy hết microtask queue.
    await new Promise((r) => setTimeout(r, 0));

    expect(revokeSpy).toHaveBeenCalledWith('blob:fake-object-url');
  });
});
