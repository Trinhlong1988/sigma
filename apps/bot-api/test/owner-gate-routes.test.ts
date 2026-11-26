// [Admin Demo 9/9 "khoá tính năng tra soát sao kê chỉ cho SigMa xem được, với MB lib cũng vậy"]
// GUARD: MỌI route thuộc nhóm CHỈ-CHỦ-SIGMA phải có `requireAlphaOwner` NGAY TRÊN ROUTE (không dựa vào việc ẩn menu
// — ẩn UI chỉ là lịch sự, ai gõ thẳng URL/gọi API vẫn phải bị 403). Thêm route mới vào nhóm mà quên gate = đỏ ở CI.
//
// Nhóm khoá: /v1/statement-recon/* (tra soát sao kê + LẤY SAO KÊ MB TỰ ĐỘNG) · /v1/alpha-aggregate/* (tổng gộp).
delete process.env.SIGMA_OWNER_TEST_ALL; // gate THẬT phải được test không bypass
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_DIR = join(process.cwd(), 'src', 'routes');
const NHOM_KHOA = ['/v1/statement-recon/', '/v1/alpha-aggregate/'];

/**
 * Mỗi lần đăng ký route = `router.<method>('<path>', <middlewares…>`. Lấy 300 ký tự NGAY SAU đường dẫn làm `head`
 * (middleware luôn đứng ngay đó). KHÔNG cắt ở "(req" vì `asyncHandler(requireSession)` cũng khớp chuỗi đó — bản
 * đầu cắt kiểu ấy nên báo nhầm 9 route "thiếu gate" trong khi chúng có đủ.
 */
function dangKyRoute(src: string): { path: string; head: string }[] {
  const ra: { path: string; head: string }[] = [];
  const re = /\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) ra.push({ path: m[2], head: src.slice(m.index, m.index + 300) });
  return ra;
}

describe('owner-gate — nhóm route chỉ chủ SigMa', () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'));
  const tatCa = files.flatMap((f) => dangKyRoute(readFileSync(join(ROUTES_DIR, f), 'utf8')).map((r) => ({ ...r, file: f })));

  it('quét được route (guard không rỗng nghĩa)', () => {
    expect(tatCa.length).toBeGreaterThan(50);
    expect(tatCa.some((r) => r.path.includes('/v1/statement-recon/'))).toBe(true);
  });

  it('mọi route /v1/statement-recon/* và /v1/alpha-aggregate/* đều có requireAlphaOwner', () => {
    const thieu = tatCa
      .filter((r) => NHOM_KHOA.some((k) => r.path.includes(k)))
      .filter((r) => !r.head.includes('requireAlphaOwner'))
      .map((r) => `${r.file} → ${r.path}`);
    expect(thieu, `Route thuộc nhóm CHỈ-CHỦ-SIGMA nhưng THIẾU requireAlphaOwner (ai cũng gọi được):\n${thieu.join('\n')}`).toEqual([]);
  });

  it('route lấy sao kê MB tự động (fetch-auto) nằm trong nhóm khoá', () => {
    const r = tatCa.find((x) => x.path.endsWith('/v1/statement-recon/fetch-auto'));
    expect(r, 'không tìm thấy route fetch-auto').toBeTruthy();
    expect(r!.head).toContain('requireAlphaOwner');
    expect(r!.head).toContain('requireSession');
  });
});
