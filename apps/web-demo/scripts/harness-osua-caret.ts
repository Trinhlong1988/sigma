// HARNESS R200 (Admin Demo 16/9 "sửa số ở giữa nhảy loạn ra cuối") — ĐIỀU KHIỂN THẬT trên ĐÚNG OSua + useGroupedMoneyField.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function main(): Promise<void> {
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
  await page.goto(base + '/');
  await page.evaluate(async () => { const duongDan = '/src/_osua-caret-harness.tsx'; const m = await import(/* @vite-ignore */ duongDan); (m as { mount: () => void }).mount(); });
  const inp = page.locator('#osua-harness input');
  await inp.waitFor({ timeout: 5000 });
  console.log('value đầu:', await inp.inputValue()); // mong "20.898.000"
  await inp.click();
  await inp.evaluate((el) => (el as HTMLInputElement).setSelectionRange(4, 4)); // "20.8|98.000" (3 chữ số trước caret... "20.8" = 2,0,8 → 3)
  await page.keyboard.type('7');
  const sau = await inp.evaluate((el) => ({ value: (el as HTMLInputElement).value, caret: (el as HTMLInputElement).selectionStart ?? -1 }));
  const digitsTruoc = sau.value.slice(0, sau.caret).replace(/[^0-9]/g, '').length;
  const ok = digitsTruoc === 4 && sau.caret < sau.value.length; // 3 chữ số cũ + "7" vừa gõ = 4, và KHÔNG văng cuối
  console.log('sau khi gõ "7" giữa số:', JSON.stringify(sau), '| chữ số trước caret:', digitsTruoc);
  console.log(ok ? '✅ CARET GIỮ ĐÚNG CHỖ (không văng cuối)' : '❌ CARET SAI');
  await browser.close(); await server.close();
  process.exit(ok ? 0 : 1);
}
void main();
