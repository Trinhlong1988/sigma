// Lane D vòng 2 (3/8, việc 1 — header hội thoại VỠ mobile) — regression e2e Playwright.
// Chạy: `node apps/web-demo/scripts/header-responsive.e2e.mjs` (từ ROOT repo — cần node_modules root có
// playwright + vite). Tự spawn vite dev server, mở `header-harness.html` (render ConversationScreen full-width
// KHÔNG scale, với 1 phòng DIRECT tên RẤT DÀI) ở emulate iPhone 390px + Android 412px, ASSERT:
//   - header ≤ 64px (không đổ cao do tên wrap dọc — bug gốc: 235px, 7 dòng)
//   - tên hiển thị ĐÚNG 1 dòng (white-space:nowrap, không wrap)
//   - <sm: nút "⋯" hiện + mở menu chứa Gọi video / Thông tin / Chọn nhiều
//   - ≥sm (800px): "⋯" ẩn, các icon (Info/Video) hiện inline
// Thoát code ≠ 0 nếu bất kỳ assert nào fail (dùng được trong CI). KHÔNG cần backend (vùng tin nhắn báo lỗi
// tải là bình thường — header render độc lập từ prop `room`).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const WEB_DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Có thể trỏ tới 1 vite dev server ĐÃ CHẠY (khuyến nghị cho Windows — tránh flaky khi tự spawn + cold
// dep-optimizer): `HARNESS_URL=http://localhost:5301/header-harness.html node ...scripts/header-responsive.e2e.mjs`
// (server chạy bằng: `cd apps/web-demo && npx vite --port 5301`). KHÔNG set HARNESS_URL → script tự spawn vite.
const EXTERNAL_URL = process.env.HARNESS_URL || '';
const PORT = 5288;
const BASE = `http://localhost:${PORT}`;
const HARNESS = EXTERNAL_URL || `${BASE}/header-harness.html`;
const MAX_HEADER_PX = 64;

function log(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) process.exitCode = 1;
}

// Cold-start vite: lần load ĐẦU của trình duyệt kích hoạt dep-optimizer; module có thể lỗi 504 "outdated
// optimize dep" 1 nhịp mà KHÔNG tự reload → trang trắng. Thử goto + reload tối đa `tries` lần tới khi header
// xuất hiện.
async function gotoHarnessUntilReady(page, url, sel, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    try {
      await page.waitForSelector(sel, { timeout: 6000, state: 'visible' });
      return true;
    } catch {
      await page.waitForTimeout(800); // để optimizer xong rồi reload lại
    }
  }
  return false;
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* chưa lên — thử lại */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const vite = EXTERNAL_URL
  ? null
  : spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vite', '--port', String(PORT), '--strictPort'],
      { cwd: WEB_DEMO_DIR, stdio: 'ignore', shell: process.platform === 'win32' }
    );

let browser;
try {
  const up = await waitForServer(HARNESS);
  if (!up) {
    console.error('FAIL  vite dev server không lên được trong 30s');
    process.exitCode = 1;
  } else {
    browser = await chromium.launch();
    for (const dev of [
      { name: 'iPhone', width: 390, height: 844 },
      { name: 'Android', width: 412, height: 915 }
    ]) {
      const ctx = await browser.newContext({ viewport: { width: dev.width, height: dev.height }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      if (!(await gotoHarnessUntilReady(page, HARNESS, '.border-b .text-slate-800'))) {
        log(false, `[${dev.name}] KHÔNG render được harness (header không xuất hiện)`);
        await ctx.close();
        continue;
      }
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => {
        const header = document.querySelector('.border-b');
        const nameEl = document.querySelector('.border-b .text-slate-800');
        const cs = nameEl ? getComputedStyle(nameEl) : null;
        return {
          headerHeight: header ? Math.round(header.getBoundingClientRect().height) : -1,
          nameHeight: nameEl ? Math.round(nameEl.getBoundingClientRect().height) : -1,
          lineHeight: cs ? parseFloat(cs.lineHeight) : -1,
          whiteSpace: cs ? cs.whiteSpace : ''
        };
      });
      log(m.headerHeight > 0 && m.headerHeight <= MAX_HEADER_PX, `[${dev.name} ${dev.width}px] header ${m.headerHeight}px ≤ ${MAX_HEADER_PX}px`);
      log(m.whiteSpace === 'nowrap', `[${dev.name}] tên white-space=nowrap (là "${m.whiteSpace}")`);
      log(m.nameHeight > 0 && m.nameHeight <= m.lineHeight + 4, `[${dev.name}] tên 1 dòng (cao ${m.nameHeight}px ≤ line-height ${m.lineHeight}px)`);

      const more = page.getByRole('button', { name: 'Thêm', exact: true });
      log(await more.isVisible(), `[${dev.name}] nút "⋯" hiện ở <sm`);
      await more.click();
      await page.waitForTimeout(200);
      const items = await page.getByRole('menuitem').allInnerTexts();
      log(items.some((t) => t.includes('Gọi video')) && items.some((t) => t.includes('Thông tin')) && items.some((t) => t.includes('Chọn nhiều')), `[${dev.name}] menu ⋯ chứa Video/Thông tin/Chọn nhiều (thấy: ${JSON.stringify(items)})`);
      await ctx.close();
    }

    // ≥sm: ⋯ ẩn, icon inline
    const ctxWide = await browser.newContext({ viewport: { width: 800, height: 900 } });
    const pageWide = await ctxWide.newPage();
    await gotoHarnessUntilReady(pageWide, HARNESS, '.border-b .text-slate-800');
    await pageWide.waitForTimeout(300);
    log(!(await pageWide.getByRole('button', { name: 'Thêm', exact: true }).isVisible()), `[≥sm 800px] nút "⋯" ẨN`);
    log(await pageWide.getByRole('button', { name: 'Thông tin hội thoại' }).isVisible(), `[≥sm 800px] icon "Thông tin" hiện inline`);
    const wideHeader = await pageWide.evaluate(() => Math.round(document.querySelector('.border-b').getBoundingClientRect().height));
    log(wideHeader <= MAX_HEADER_PX, `[≥sm 800px] header ${wideHeader}px ≤ ${MAX_HEADER_PX}px`);
    await ctxWide.close();
  }
} finally {
  if (browser) await browser.close();
  if (vite) vite.kill();
}

console.log(process.exitCode ? '\n❌ CÓ ASSERT FAIL' : '\n✅ TẤT CẢ ASSERT PASS');
