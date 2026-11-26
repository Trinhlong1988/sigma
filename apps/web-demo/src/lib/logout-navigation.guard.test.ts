// GUARD chống tái diễn bug "đăng xuất bị KẸT" (Admin Demo 11/9 — bấm Đăng xuất xong màn đứng nguyên, phải kill
// app). GỐC (tái hiện + đo thật bằng scripts/harness-logout.ts, trace pushState/popstate): ConfirmDialog →
// Modal → useBackIntercept push sentinel history; performLogout navigate('/login') push route thật; Modal
// unmount → cleanup sentinel `history.back()` NUỐT entry /login vừa push → URL bật về /app/chat với session đã
// xóa, RequireAuth không re-render (React bail-out) → kẹt vĩnh viễn. Test đọc SOURCE THẬT (cùng pattern
// bill-card-layout.guard.test.ts — R198 fail-loud nếu file đổi tên/mất), khoá 3 lớp fix:
//   1) logout.ts: closeOverlayForNavigation() PHẢI được gọi TRƯỚC navigate (mọi cleanup overlay bỏ history.back).
//   2) App.tsx RequireAuth: PHẢI useLocation() (chống React bail-out — guard re-check session mỗi lần đổi route).
//   3) rc-client.ts rcLogout: fetch PHẢI có timeout ngắn (server treo không giữ request pending vô hạn).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const logoutSrc = readFileSync(path.join(HERE, 'logout.ts'), 'utf8');
const rcClientSrc = readFileSync(path.join(HERE, 'rc-client.ts'), 'utf8');
const appSrc = readFileSync(path.join(HERE, '..', 'App.tsx'), 'utf8');

describe('logout — điều hướng /login KHÔNG được bị sentinel back-intercept nuốt (bug KẸT 11/9)', () => {
  it('performLogout gọi closeOverlayForNavigation() TRƯỚC navigate(ROUTES.login)', () => {
    const iClose = logoutSrc.indexOf('closeOverlayForNavigation()');
    const iNavigate = logoutSrc.indexOf('navigate(ROUTES.login)');
    expect(iClose).toBeGreaterThan(-1); // phải CÓ lời gọi (không chỉ import).
    expect(iNavigate).toBeGreaterThan(-1);
    expect(iClose).toBeLessThan(iNavigate); // và phải ĐỨNG TRƯỚC navigate (đọc stack lúc overlay còn mount).
  });

  it('RequireAuth (App.tsx) subscribe useLocation() — guard re-check session mỗi lần đổi route', () => {
    const body = appSrc.slice(appSrc.indexOf('function RequireAuth'), appSrc.indexOf('function', appSrc.indexOf('function RequireAuth') + 10));
    expect(body).toContain('useLocation()');
    expect(body).toContain('getSession()');
  });

  it('rcLogout fetch best-effort có timeout ngắn (server treo không giữ pending vô hạn)', () => {
    const start = rcClientSrc.indexOf('export async function rcLogout');
    expect(start).toBeGreaterThan(-1);
    const end = rcClientSrc.indexOf('export ', start + 1); // hết hàm = tới export kế tiếp (hoặc EOF).
    const body = rcClientSrc.slice(start, end === -1 ? undefined : end);
    expect(body).toMatch(/AbortSignal\.timeout\(\d+\)/);
  });
});
