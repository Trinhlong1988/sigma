// [Admin Demo 9/9 — CHỐNG TÁI DIỄN] BUG THẬT: nút lối tắt "→ Báo cáo lô" trên log mở `/app/room-revenue?tid=…` —
// ROUTE NÀY KHÔNG TỒN TẠI (báo cáo lô nằm ở `/app/chat/:roomId/revenue`) ⇒ bấm ra trang trắng; anh Demo báo
// "click vào không có lối tắt đến". Không test nào bắt được vì đường dẫn chỉ là CHUỖI.
//
// GUARD: quét MỌI `window.open('…/app/…')` trong src → chuẩn hoá `${...}` thành `:p` → đối chiếu với TẬP ROUTE THẬT
// (dựng từ `src/routes.ts` + các `path=` khai báo trong `App.tsx`). Lối tắt trỏ route không có = FAIL ngay ở test.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'apps', 'web-demo', 'src');

function moiFile(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) moiFile(full, acc);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(full);
  }
  return acc;
}

/** Bỏ query + thay mọi biến (`${x}`, `:id`) bằng `:p`, bỏ "/" cuối → so khớp được giữa link và route. */
function chuanHoa(p: string): string {
  return p.split('?')[0].replace(/\$\{[^}]*\}/g, ':p').replace(/:[A-Za-z0-9_]+/g, ':p').replace(/\/+$/, '') || '/';
}

/** Tập route THẬT: giá trị chuỗi/template trong routes.ts + path= trong App.tsx (đã thay ${ROUTES.x}). */
function tapRoute(): Set<string> {
  const routesSrc = readFileSync(join(SRC, 'routes.ts'), 'utf8');
  const appSrc = readFileSync(join(SRC, 'App.tsx'), 'utf8');
  const giaTri = new Map<string, string>(); // key trong ROUTES → đường dẫn thô
  for (const m of routesSrc.matchAll(/(\w+):\s*'(\/[^']*)'/g)) giaTri.set(m[1], m[2]);
  for (const m of routesSrc.matchAll(/(\w+):\s*\([^)]*\)[^=]*=>\s*`(\/[^`]*)`/g)) giaTri.set(m[1], m[2]);

  const ra = new Set<string>();
  for (const v of giaTri.values()) ra.add(chuanHoa(v));
  for (const m of appSrc.matchAll(/path="([^"]+)"/g)) ra.add(chuanHoa(m[1]));
  for (const m of appSrc.matchAll(/path=\{`([^`]+)`\}/g)) {
    const thay = m[1].replace(/\$\{ROUTES\.(\w+)\}/g, (_s, k: string) => giaTri.get(k) ?? '${x}');
    ra.add(chuanHoa(thay));
  }
  for (const m of appSrc.matchAll(/path=\{ROUTES\.(\w+)\}/g)) { const v = giaTri.get(m[1]); if (v) ra.add(chuanHoa(v)); }
  return ra;
}

describe('lối tắt nội bộ phải trỏ route CÓ THẬT', () => {
  it('mọi window.open("…/app/…") đều khớp 1 route khai báo', () => {
    const routes = tapRoute();
    expect(routes.size, 'không đọc được route nào → guard vô nghĩa').toBeGreaterThan(15);
    expect([...routes]).toContain('/app/chat/:p/revenue'); // sanity: có đúng route báo cáo lô
    // Bằng chứng guard THẬT SỰ bắt được ca đã lọt: đường dẫn cũ '/app/room-revenue' KHÔNG nằm trong tập route.
    expect([...routes]).not.toContain('/app/room-revenue');

    const loi: string[] = [];
    for (const f of moiFile(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/window\.open\(\s*[`'"]([^`'"]*\/app\/[^`'"]*)[`'"]/g)) {
        const duong = chuanHoa(m[1].replace(/^.*?(\/app\/)/, '$1'));
        if (!routes.has(duong)) loi.push(`${f.slice(SRC.length + 1)} → ${duong}`);
      }
    }
    expect(loi, `Lối tắt trỏ ROUTE KHÔNG TỒN TẠI (bấm vào ra trang trắng):\n${loi.join('\n')}`).toEqual([]);
  });
});
