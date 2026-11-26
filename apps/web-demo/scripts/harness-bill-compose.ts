// HARNESS R200 (Admin Demo 8/9) — render THẬT ảnh bill ghép (bill + khối đối chiếu) để LEAD nhìn trước khi ship.
// Thứ tự mới yêu cầu: HKD (nổi xanh như số tiền) → TID · Ngày · Giờ · Số lô → SỐ TIỀN → Thẻ → Phí bán %.
// Chạy: node --import tsx scripts/harness-bill-compose.ts
import { createServer } from 'vite';
import { chromium, type Browser } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-bill-compose');
const BILL = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  const billB64 = (await readFile(BILL)).toString('base64');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 900, height: 1200 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });

    const b64 = await page.evaluate(async (billBase64: string) => {
      const duongDan = '/src/lib/bill-table-image.ts'; // biến → TS không cố resolve, Vite dev vẫn nạp được
      const mod = await import(/* @vite-ignore */ duongDan);
      const bin = atob(billBase64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob = new Blob([buf], { type: 'image/jpeg' });
      const rows = [
        { key: 'hkdName', label: 'HKD', text: 'HKD DEMO 5 2', muted: false },
        { key: 'tid', label: 'TID', text: '53590002', muted: false },
        { key: 'date', label: 'Ngày', text: '08/09/2026', muted: false },
        { key: 'time', label: 'Giờ', text: '14:22:05', muted: false },
        { key: 'batchNumber', label: 'Số lô', text: '56', muted: false }
      ];
      const res = await (mod as { composeBillImage: (b: Blob, r: unknown[], a: string, rf?: string, w?: string, e?: unknown[]) => Promise<{ blob: Blob }> })
        .composeBillImage(blob, rows as never, '20.998.000đ', '20.700.000đ', undefined, [
          { label: 'Thẻ', value: 'Ngoài MB-Visa-Master (đã chọn)' },
          { label: 'Phí bán', value: '1.42%' }
        ]);
      const ab = await res.blob.arrayBuffer();
      let s = '';
      const u8 = new Uint8Array(ab);
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return btoa(s);
    }, billB64);

    const out = path.join(OUT, 'bill-ghep-moi.png');
    await writeFile(out, Buffer.from(b64, 'base64'));
    console.log('  đã render:', out, `(${Math.round(Buffer.from(b64, 'base64').length / 1024)}KB)`);
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
