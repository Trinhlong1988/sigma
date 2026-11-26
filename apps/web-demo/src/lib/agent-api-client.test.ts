// SIGMA (31/7 tiếp B71-part2) — regression test cho previewLoOcr() (agent-api-client.ts), nối UI OCR
// preview vào ReconcileDetailScreen.tsx. Mock global.fetch (KHÔNG gọi bot-api/OCR service thật, KHÔNG chạm DB
// `sigma`) — mọi shape response ĐÚNG NGUYÊN VĂN response thật của route POST /v1/me/lo/ocr-preview
// (apps/bot-api/src/routes/me.ts) đã verify end-to-end thật ở B71-part2 (đúng bài học
// feedback_mock_shape_accuracy_assert_values — không bịa shape mock kết quả OCR/API bên thứ 3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewLoOcr, isRecentlyAcceptedFriend, NEW_FRIEND_BADGE_THRESHOLD_MINUTES } from './agent-api-client';

// B107-tiếp (2/8, Admin Demo chốt lại ngưỡng "Bạn mới" = 60 phút, SỬA quyết định tự chọn cũ "5 ngày" 24/7).
describe('isRecentlyAcceptedFriend', () => {
  // [22/11] ĐÓNG BĂNG ĐỒNG HỒ. Trước đây bài kiểm biên dựng mốc "đúng 60 phút trước" bằng `Date.now()`,
  // rồi hàm lại gọi `Date.now()` LẦN NỮA — chỉ cần 1 mili giây trôi qua là tuổi thành 60 phút + 1ms ⇒ rơi
  // ra ngoài ngưỡng ⇒ ĐỎ NGẪU NHIÊN, chặn ship mà không có lỗi thật nào. Đóng băng để hai lần đọc giờ
  // cùng một mốc; phép kiểm biên vẫn kiểm đúng cái cần kiểm.
  const MOC = new Date('2026-11-22T10:00:00+07:00').getTime();
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(MOC); });
  afterEach(() => { vi.useRealTimers(); });

  it('acceptedAt null (chưa là bạn/chưa xác định) → false', () => {
    expect(isRecentlyAcceptedFriend(null)).toBe(false);
  });

  it('acceptedAt vừa xong (0 phút trước) → true', () => {
    expect(isRecentlyAcceptedFriend(new Date().toISOString())).toBe(true);
  });

  it(`acceptedAt đúng ${NEW_FRIEND_BADGE_THRESHOLD_MINUTES} phút trước (biên trong) → true`, () => {
    const ts = new Date(Date.now() - NEW_FRIEND_BADGE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
    expect(isRecentlyAcceptedFriend(ts)).toBe(true);
  });

  it(`acceptedAt ${NEW_FRIEND_BADGE_THRESHOLD_MINUTES + 1} phút trước (ngoài ngưỡng) → false`, () => {
    const ts = new Date(Date.now() - (NEW_FRIEND_BADGE_THRESHOLD_MINUTES + 1) * 60 * 1000).toISOString();
    expect(isRecentlyAcceptedFriend(ts)).toBe(false);
  });

  it('acceptedAt trong TƯƠNG LAI (đồng hồ lệch/dữ liệu lỗi) → false (KHÔNG âm thầm coi là "mới")', () => {
    const ts = new Date(Date.now() + 60 * 1000).toISOString();
    expect(isRecentlyAcceptedFriend(ts)).toBe(false);
  });
});

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

function fakeFile(): File {
  return new File([new Uint8Array([1, 2, 3])], 'bill.jpg', { type: 'image/jpeg' });
}

describe('previewLoOcr', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gọi POST multipart field "image" kèm credentials:include + header CSRF x-sigma-client:web (proxyFetch)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(200, { found: false, rawText: null, parsedAmount: null, needsManualReview: true, reasons: ['x'] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await previewLoOcr(123, fakeFile());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/me/lo/ocr-preview');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Headers).get('x-sigma-client')).toBe('web');
    const form = init?.body as FormData;
    const uploaded = form.get('image');
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe('bill.jpg');
  });

  it('KHÔNG set Content-Type tay (để trình duyệt tự set kèm boundary multipart) — khác agentApiFetch() JSON thường', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(200, { found: false, rawText: null, parsedAmount: null, needsManualReview: true, reasons: [] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await previewLoOcr(1, fakeFile());

    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Headers).has('Content-Type')).toBe(false);
  });

  it('found=true, needsManualReview=false -> ok:true, data đúng nguyên văn (case autofill sạch)', async () => {
    const body = { found: true, rawText: '520000', parsedAmount: 520000, needsManualReview: false, reasons: [] };
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, body)));

    const r = await previewLoOcr(1, fakeFile());

    expect(r).toEqual({ ok: true, data: body });
  });

  it('found=true, needsManualReview=true (case thật B71-part2 rớt dấu chấm phân nhóm) -> ok:true, giữ NGUYÊN reasons[]', async () => {
    const body = {
      found: true,
      rawText: '52700.000',
      parsedAmount: 52700000,
      needsManualReview: true,
      reasons: ['Định dạng phân nhóm nghìn không đúng chuẩn (mỗi nhóm sau dấu chấm phải đúng 3 chữ số): "52700.000" — nghi ngờ OCR làm rớt/thêm dấu chấm, đổi sai giá trị số tiền.']
    };
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, body)));

    const r = await previewLoOcr(1, fakeFile());

    expect(r).toEqual({ ok: true, data: body });
  });

  it('found=false (không khớp mẫu "VND ...") -> ok:true, data.found=false', async () => {
    const body = { found: false, rawText: null, parsedAmount: null, needsManualReview: true, reasons: ['Không tìm thấy dòng số tiền (mẫu "VND ...") trong kết quả OCR — cần nhập tay.'] };
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, body)));

    const r = await previewLoOcr(1, fakeFile());

    expect(r).toEqual({ ok: true, data: body });
  });

  it('lỗi mạng (fetch throw) -> ok:false, error NETWORK_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const r = await previewLoOcr(1, fakeFile());

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('NETWORK_ERROR');
    }
  });

  it('400 NO_FILE (thiếu file) -> ok:false, error/message passthrough từ server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(400, { error: 'NO_FILE', message: 'Thiếu ảnh bill trong yêu cầu.' })));

    const r = await previewLoOcr(1, fakeFile());

    expect(r).toEqual({ ok: false, error: 'NO_FILE', message: 'Thiếu ảnh bill trong yêu cầu.' });
  });

  it('400 MIME_NOT_ALLOWED (magic-bytes sniff phía server chặn) -> ok:false, error/message passthrough', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(400, { error: 'MIME_NOT_ALLOWED', message: 'Ảnh không đúng định dạng jpeg/png/webp — vui lòng chụp lại.' })));

    const r = await previewLoOcr(1, fakeFile());

    expect(r).toEqual({ ok: false, error: 'MIME_NOT_ALLOWED', message: 'Ảnh không đúng định dạng jpeg/png/webp — vui lòng chụp lại.' });
  });

  it('413 FILE_TOO_LARGE -> ok:false, error/message passthrough', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(413, { error: 'FILE_TOO_LARGE', message: 'Ảnh vượt quá giới hạn 10MB.' })));

    const r = await previewLoOcr(1, fakeFile());

    expect(r).toEqual({ ok: false, error: 'FILE_TOO_LARGE', message: 'Ảnh vượt quá giới hạn 10MB.' });
  });

  it('502 SERVICE_UNREACHABLE (OCR service Python không tới được) -> ok:false, error/message passthrough', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(502, { error: 'SERVICE_UNREACHABLE', message: 'Không gọi được dịch vụ OCR — vui lòng nhập tay.' }))
    );

    const r = await previewLoOcr(1, fakeFile());

    expect(r).toEqual({ ok: false, error: 'SERVICE_UNREACHABLE', message: 'Không gọi được dịch vụ OCR — vui lòng nhập tay.' });
  });

  it('502 SERVICE_ERROR (OCR service trả lỗi nội bộ) -> ok:false, error/message passthrough', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(502, { error: 'SERVICE_ERROR', message: 'Không gọi được dịch vụ OCR — vui lòng nhập tay.' }))
    );

    const r = await previewLoOcr(1, fakeFile());

    expect(r).toEqual({ ok: false, error: 'SERVICE_ERROR', message: 'Không gọi được dịch vụ OCR — vui lòng nhập tay.' });
  });

  it('JSON phản hồi không parse được -> ok:false, error PARSE_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new Error('bad json');
            }
          }) as unknown as Response
      )
    );

    const r = await previewLoOcr(1, fakeFile());

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('PARSE_ERROR');
    }
  });
});
