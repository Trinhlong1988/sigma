// Thư viện dùng chung cho các script _audit-* : build RIÊNG (không đụng cổng 57912 của người khác) + helper.
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, statSync, existsSync, readdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const RROOT = resolve(here, '..', 'src', 'renderer');
export const OUT = resolve(here, '..', 'screenshots', '_audit-bill-le');
const BUILD = resolve(here, '..', 'out', '_audit-bill-le');
mkdirSync(OUT, { recursive: true });

const cfg = {
  root: RROOT, configFile: false,
  resolve: { alias: { '@renderer': resolve(RROOT, 'src') } },
  plugins: [react(), tailwindcss()],
  build: { outDir: BUILD, rollupOptions: { input: resolve(RROOT, 'harness-bill-le.html') }, emptyOutDir: true },
  logLevel: 'error'
};

function moiNhatNguon() {
  let m = 0;
  const di = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = resolve(d, f.name);
    if (f.isDirectory()) di(p); else if (/\.(tsx?|css|html)$/.test(f.name)) m = Math.max(m, statSync(p).mtimeMs);
  } };
  di(RROOT);
  return m;
}

export async function moHarness({ width = 1440, height = 900 } = {}) {
  // AUDIT_URL=... : gắn vào server ĐANG CHẠY (vd 57912) thay vì build lại — dùng khi cây nguồn đang bị LEAD
  // sửa dở và không build được. KHÔNG giết tiến trình của người khác.
  if (process.env.AUDIT_URL) {
    const url0 = process.env.AUDIT_URL;
    console.log('[audit] gan vao server co san:', url0);
    const browser0 = await chromium.launch();
    const page0 = await browser0.newPage({ viewport: { width, height } });
    const logs0 = []; const errs0 = [];
    page0.on('console', (m) => { logs0.push(m.text()); if (m.type() === 'error') errs0.push(m.text()); });
    page0.on('pageerror', (e) => errs0.push('pageerror:' + String(e)));
    await page0.goto(url0, { waitUntil: 'networkidle' });
    await page0.waitForTimeout(700);
    return { page: page0, browser: browser0, server: { close: async () => {} }, logs: logs0, errs: errs0, url: url0 };
  }
  const nguon = moiNhatNguon();
  const js = existsSync(BUILD) ? readdirSync(resolve(BUILD, 'assets')).filter((f) => f.endsWith('.js'))[0] : null;
  const buildMs = js ? statSync(resolve(BUILD, 'assets', js)).mtimeMs : 0;
  if (buildMs < nguon) { console.log('[audit] nguồn mới hơn build → BUILD LẠI…'); await build(cfg); }
  else console.log('[audit] build còn mới (nguồn ' + new Date(nguon).toLocaleTimeString('vi-VN') + ' ≤ build ' + new Date(buildMs).toLocaleTimeString('vi-VN') + ') → dùng lại');
  const server = await preview({ ...cfg, preview: { port: 0 } });
  const url = server.resolvedUrls.local[0].replace(/\/$/, '') + '/harness-bill-le.html';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });
  const logs = [];
  const errs = [];
  page.on('console', (m) => { logs.push(m.text()); if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror:' + String(e)));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return { page, browser, server, logs, errs, url };
}

/** Lấy payload JSON mà trang in ra console ('[bill-le DEMO] payload sẽ gửi:'). */
export async function layPayload(page) {
  return page.evaluate(() => (window).__payload ?? null);
}
/** Cài bẫy để bắt payload object (console.log in object → text() mất chi tiết). */
export async function batPayload(page) {
  await page.evaluate(() => {
    const g = console.log.bind(console);
    (window).__payloads = [];
    console.log = (...a) => { if (typeof a[0] === 'string' && a[0].includes('payload sẽ gửi')) (window).__payloads.push(a[1]); g(...a); };
  });
}
export const docPayloads = (page) => page.evaluate(() => (window).__payloads ?? []);

export async function chonTid(page, s) {
  await page.getByPlaceholder('— Gõ số TID, tên HKD hoặc tên đại lý —').click();
  await page.keyboard.type(s, { delay: 15 });
  await page.waitForTimeout(250);
  await page.getByText(s, { exact: false }).last().click();
  await page.waitForTimeout(300);
}
export const shot = (page, n) => page.screenshot({ path: resolve(OUT, n), fullPage: true });
export const soDong = (page) => page.evaluate(() => document.querySelectorAll('tbody tr:not([aria-hidden])').length);
export const nutGhi = (page) => page.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Ghi nhận bill')); return b? b.disabled : null; });
export const canhBaoLo = (page) => page.evaluate(() => {
  const ds=[...document.querySelectorAll('.fixed.inset-0 p')].map(p=>(p.textContent||'').replace(/\s+/g,' ').trim()).filter(t=>/TRÙNG HOÀN TOÀN|TRÙNG SỐ LÔ|NGHỊCH THỨ TỰ/.test(t));
  return ds;
});
