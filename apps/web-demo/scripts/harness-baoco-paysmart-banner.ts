// HARNESS R200 (12/9) — banner refresh báo-có khi PaySmart LỖI (fix B4 agent-3: client hết nuốt câm).
// [14/10] Thêm ca NHIỀU MÃ: 2 mã PaySmart, 1 mã lỗi → banner phải GỌI TÊN đúng mã lỗi (trước đây viết cứng
// "DEMOMAY" nên mã thứ hai hỏng mà câu vẫn chỉ DEMOMAY = nói sai nhà) + nói rõ mấy/mấy mã kéo được.
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaoCoRefreshResult } from '../src/lib/digistore-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'baoco-paysmart');
interface Ca { ten: string; refresh: BaoCoRefreshResult; phaiThay: string[] }
const CAC_CA: Ca[] = [
  {
    ten: 'mot-ma-loi',
    refresh: { fetched: 12, matched: 9, unreconciled: 3, errors: [], paysmart: { ok: false, naped: 0, soMa: 1, soOk: 0, loiMa: [{ tidId: 187, tenHkd: 'HKD DEMOMAY', ly: 'LOGIN FAIL (đã retry 1 lần)' }], error: 'mã 187 (HKD DEMOMAY): LOGIN FAIL' } },
    phaiThay: ['HKD DEMOMAY', 'LOGIN FAIL']
  },
  {
    ten: 'hai-ma-mot-loi',
    refresh: { fetched: 12, matched: 9, unreconciled: 3, errors: [], paysmart: { ok: false, naped: 7, soMa: 2, soOk: 1, loiMa: [{ tidId: 201, tenHkd: 'HKD THỨ HAI', ly: 'không bắt được danh sách báo-có' }], error: 'mã 201' } },
    phaiThay: ['HKD THỨ HAI', '1/2 mã']
  },
  {
    ten: 'hai-ma-ok',
    refresh: { fetched: 12, matched: 9, unreconciled: 3, errors: [], paysmart: { ok: true, naped: 15, soMa: 2, soOk: 2, loiMa: [] } },
    phaiThay: ['2/2 mã']
  }
];
const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript({ content: [
      "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'KeToan' }));",
      "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 1, code: 'DL62', name: 'KeToan', rcUserId: 'u-me', rcUsername: 'tuyet' }));",
      'function FakeWS(){ this.readyState = 0; } FakeWS.prototype.addEventListener=function(){}; FakeWS.prototype.removeEventListener=function(){}; FakeWS.prototype.send=function(){}; FakeWS.prototype.close=function(){}; window.WebSocket=FakeWS;'
    ].join(String.fromCharCode(10)) });
    await page.routeWebSocket(/^ws/, () => {});
    let ca: Ca = CAC_CA[0];
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/digistore/refresh')) return json(route, { ok: true, ...ca.refresh });
      if (p.endsWith('/v1/digistore/baoco-report')) return json(route, { from: '2026-09-11T00:00:00Z', to: '2026-09-12T00:00:00Z', rows: [], byDay: [], totals: { amount: 0, count: 0, countUnreconciled: 0, loiNhuanAlpha: 0, sauPhiBan: 0, sauPhiMua: 0 } });
      if (p.endsWith('/v1/digistore/qr-ma')) return json(route, { ok: true, data: [] });
      const listLike = /categories|rooms|contacts|notifications|list|limit/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    const ketQua: Array<{ ca: string; shot: string; thieuChu: string[] }> = [];
    for (const c of CAC_CA) {
      ca = c;
      await page.goto(`${baseUrl}/app/baoco-report`, { waitUntil: 'networkidle' });
      await page.getByText('Tải lại giao dịch mới nhất').click();
      await page.waitForSelector('[data-testid="baoco-refresh-banner"]', { timeout: 8000 });
      await page.waitForTimeout(400);
      const shot = path.join(OUT, `banner-paysmart-${c.ten}.png`);
      await page.locator('[data-testid="baoco-refresh-banner"]').screenshot({ path: shot });
      const chu = (await page.locator('[data-testid="baoco-refresh-banner"]').innerText()).replace(/\s+/g, ' ');
      // Khẳng định TỪNG chữ phải có (R198: không thấy finding ≠ check đã chạy) — thiếu chữ nào in ra chữ đó.
      ketQua.push({ ca: c.ten, shot, thieuChu: c.phaiThay.filter((t) => !chu.includes(t)) });
    }
    console.log(JSON.stringify(ketQua, null, 1));
    if (ketQua.some((k) => k.thieuChu.length)) { await ctx.close(); throw new Error('BANNER THIẾU CHỮ: ' + JSON.stringify(ketQua.filter((k) => k.thieuChu.length))); }
    await ctx.close();
  } finally { await browser?.close(); await server.close(); }
}
void main();
