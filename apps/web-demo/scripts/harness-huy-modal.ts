// HARNESS R200 (Admin Demo 25/9 "thêm số tiền hủy điền tay — chưa thấy tab hủy giao dịch đâu"):
// mount THẬT BillParamEditModal rồi CHỤP để LEAD nhìn khối HỦY + kiểm số "Ghi nhận doanh số" đổi theo khi gõ.
// Chạy: npx vite build && node --import tsx scripts/harness-huy-modal.ts
import { preview } from 'vite';
import { chromium, type Browser } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'huy-modal');

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', preview: { port: 0 } });
  const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 900, height: 1100 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    await page.route('**/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto(`${base}/?harness=huy-modal`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="khoi-huy-modal-sua"]', { timeout: 15000 });
    const ghi1 = await page.getByTestId('ghi-nhan-modal').innerText();
    await page.screenshot({ path: path.join(OUT, '1-khoi-huy.png') });
    // ĐIỀU KHIỂN THẬT: gõ tiền hủy 25.000 → "Ghi nhận doanh số" phải giảm đúng 25.000
    await page.getByTestId('o-tien-huy-modal').fill('25000');
    await page.waitForTimeout(300);
    const ghi2 = await page.getByTestId('ghi-nhan-modal').innerText();
    await page.screenshot({ path: path.join(OUT, '2-go-tien-huy.png') });
    const so = (s: string): number => Number(s.replace(/[^\d]/g, ''));
    console.log(`ghi nhận ban đầu (hủy 11.000): ${ghi1}`);
    console.log(`sau khi gõ hủy 25.000        : ${ghi2}`);
    console.log(so(ghi1) === 41_245_000 && so(ghi2) === 41_231_000
      ? '✓ ĐÚNG: 41.256.000 − 11.000 = 41.245.000 ; − 25.000 = 41.231.000'
      : `✗ SAI: kỳ vọng 41.245.000 rồi 41.231.000, nhận ${so(ghi1)} rồi ${so(ghi2)}`);
    process.exitCode = (so(ghi1) === 41_245_000 && so(ghi2) === 41_231_000) ? 0 : 1;
    console.log('[harness] Ảnh →', OUT);
  } finally { await browser?.close(); await server.close(); }
}
await main();
