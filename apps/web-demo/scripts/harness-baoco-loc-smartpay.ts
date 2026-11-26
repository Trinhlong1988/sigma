// HARNESS R200 (14/10) — khối LỌC báo-có sau khi sao y giao diện cổng SmartPay (Admin Demo chốt phương án B).
// Render THẬT bằng vite + chromium ở ĐÚNG khung nhìn 1440×900 như lúc đo trang gốc, chụp ảnh, rồi ĐO LẠI
// computed style và SO với số gốc đã đo trên sem.paysmart.com.vn (apps/bot-api/_anh-paysmart/paysmart-css*.json).
// Lệch quá sai số cho phép → in ra từng mục lệch + exit 1 (không để "nhìn na ná" trôi qua).
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'baoco-loc-smartpay');
const json = (route: Route, body: unknown): Promise<void> =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Số ĐO THẬT trên cổng SmartPay (viewport 1440×900) — nguồn: _tam-do-css-paysmart.mts. */
const GOC = {
  nhan: { 'font-size': '13px', 'font-weight': '500', color: 'rgb(63, 66, 84)', 'line-height': '19.5px' },
  o_nhap: { height: '34.7969px', 'border-radius': '5.525px', 'font-size': '12.35px', color: 'rgb(94, 98, 120)', 'background-color': 'rgb(255, 255, 255)', 'border-top-color': 'rgb(225, 227, 234)', 'border-top-style': 'solid', 'border-top-width': '1px' },
  o_solid: { 'background-color': 'rgb(249, 249, 249)', 'border-top-color': 'rgb(249, 249, 249)' },
  nut_tim: { 'background-color': 'rgb(241, 250, 255)', color: 'rgb(0, 158, 247)', 'border-top-style': 'dashed', 'border-top-color': 'rgb(0, 158, 247)', 'border-radius': '5.525px', 'font-size': '12.35px', 'font-weight': '500' },
  nut_clear: { 'background-color': 'rgb(255, 248, 221)', color: 'rgb(255, 199, 0)', 'border-top-style': 'dashed', 'border-top-color': 'rgb(255, 199, 0)' },
  nut_dac: { 'background-color': 'rgb(0, 158, 247)', color: 'rgb(255, 255, 255)' },
  the: { padding: '26px 29.25px' }
};

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  let hong = false;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript({ content: [
      "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u', agentName: 'Nguoi Dung Demo' }));",
      "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u', rcUsername: 'nguoidungdemo' }));",
      'function FakeWS(){ this.readyState = 0; } FakeWS.prototype.addEventListener=function(){}; FakeWS.prototype.removeEventListener=function(){}; FakeWS.prototype.send=function(){}; FakeWS.prototype.close=function(){}; window.WebSocket=FakeWS;'
    ].join(String.fromCharCode(10)) });
    await page.routeWebSocket(/^ws/, () => {});
    let soLanTaiBaoCao = 0;
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/digistore/baoco-report')) soLanTaiBaoCao++;
      if (p.endsWith('/v1/digistore/baoco-report')) return json(route, { from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z', rows: [], byDay: [], totals: { amount: 0, count: 0, countUnreconciled: 0, loiNhuanAlpha: 0, sauPhiBan: 0, sauPhiMua: 0 } });
      // listQrMa đọc /v1/digistore/creds và lấy .items (không phải qr-ma/.data — sai đường là panel mã rỗng).
      if (p.endsWith('/v1/digistore/creds')) return json(route, { ok: true, items: [
        { tidId: 185, tid: 'QR-HKDTRAMYNGUYEN-g2itsjci8z', hkdName: 'HKD TRÀ MY NGUYỄN' },
        { tidId: 187, tid: 'QR-HKDDEMOMAY-mtwr7znklro', hkdName: 'HKD DEMOMAY' }
      ] });
      if (p.endsWith('/v1/qr-daily-limit')) return json(route, { ok: true, ma: [], limits: {} });
      if (p.endsWith('/v1/digistore/dealer-names')) return json(route, { ok: true, dealers: ['ĐL - Lộc SG'] });
      const listLike = /categories|rooms|contacts|notifications|list|limit/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/baoco-report`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="baoco-loc-smartpay"]', { timeout: 10000 });
    await page.waitForTimeout(600);

    await page.locator('[data-testid="baoco-loc-smartpay"]').screenshot({ path: path.join(OUT, 'loc-smartpay.png') });
    await page.screenshot({ path: path.join(OUT, 'man-hinh-1440.png') });

    // ĐO LẠI trên bản mình (truyền evaluate dạng chuỗi: esbuild/tsx bọc hàm có tên bằng __name làm vỡ evaluate).
    const do_ = await page.evaluate(`(() => {
      const lay = (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return { KHONG_THAY: sel };
        const s = getComputedStyle(el); const o = {};
        for (const p of props) o[p] = s.getPropertyValue(p);
        const b = el.getBoundingClientRect(); o._w = b.width.toFixed(1); o._h = b.height.toFixed(1);
        return o;
      };
      const P_O = ['height','border-radius','font-size','color','background-color','border-top-color','border-top-style','border-top-width','font-family'];
      const P_NUT = ['background-color','color','border-top-style','border-top-color','border-radius','font-size','font-weight','font-family'];
      const cot = Array.from(document.querySelectorAll('.sp-loc__o')).map((e) => e.getBoundingClientRect().width.toFixed(2));
      return {
        the: lay('.sp-loc', ['padding','background-color','font-family']),
        nhan: lay('.sp-loc__nhan', ['font-size','font-weight','color','line-height','letter-spacing','font-family']),
        o_nhap: lay('.sp-loc__nhap:not(.sp-loc__nhap--solid)', P_O), // ô thường (ô ngày mang thêm class --solid, đừng đo nhầm)
        o_solid: lay('.sp-loc__nhap--solid', P_O),
        nut_tim: lay('.sp-loc__nut--tim', P_NUT),
        nut_clear: lay('.sp-loc__nut--clear', P_NUT),
        nut_dac: lay('.sp-loc__nut--dac', P_NUT),
        be_rong_cot: cot,
        so_o: document.querySelectorAll('.sp-loc__o').length
      };
    })()`) as Record<string, Record<string, string>> & { be_rong_cot: string[]; so_o: number };

    const lech: string[] = [];
    const so = (ten: string, thuc: Record<string, string> | undefined, mong: Record<string, string>): void => {
      if (!thuc || thuc['KHONG_THAY']) { lech.push(`${ten}: KHÔNG THẤY phần tử trên trang`); return; }
      for (const [k, v] of Object.entries(mong)) if (thuc[k] !== v) lech.push(`${ten}.${k}: bản mình "${thuc[k]}" ≠ gốc SmartPay "${v}"`);
    };
    so('nhãn', do_['nhan'], GOC.nhan);
    so('ô nhập', do_['o_nhap'], GOC.o_nhap);
    so('ô ngày (solid)', do_['o_solid'], GOC.o_solid);
    so('nút Tìm kiếm', do_['nut_tim'], GOC.nut_tim);
    so('nút Clear', do_['nut_clear'], GOC.nut_clear);
    so('nút đặc', do_['nut_dac'], GOC.nut_dac);
    so('thẻ lọc', do_['the'], GOC.the);
    if (!(do_['the']?.['font-family'] ?? '').includes('Nunito')) lech.push(`thẻ lọc dùng font "${do_['the']?.['font-family']}" — gốc là Nunito`);
    // 4 cột/hàng: mọi ô phải cùng bề rộng (≈ 1/4 bề ngang lưới).
    const rong = Array.from(new Set(do_.be_rong_cot));
    if (rong.length !== 1) lech.push(`cột KHÔNG đều: ${do_.be_rong_cot.join(' · ')}`);

    // ── HÀNH VI THẬT (ảnh tĩnh KHÔNG đủ cho nút — R200a): gõ/chọn rồi bấm Clear phải sạch; bấm Tìm kiếm phải TẢI.
    await page.locator('[data-testid="baoco-search-amount"]').fill('1234');
    await page.locator('[data-testid="baoco-search-payer"]').fill('NGUYEN VAN A');
    await page.locator('[data-testid="baoco-filter-status"]').selectOption('unreconciled');
    await page.locator('[data-testid="baoco-loc-ky"]').selectOption('week');
    await page.locator('[data-testid="baoco-filter-ma"]').click();
    await page.locator('[data-testid="baoco-ma-tick-187"]').check();
    await page.locator('[data-testid="baoco-filter-ma"]').click();
    const truocClear = {
      tien: await page.locator('[data-testid="baoco-search-amount"]').inputValue(),
      ma: (await page.locator('[data-testid="baoco-filter-ma"]').innerText()).replace(/\s+/g, ' ').trim()
    };
    await page.locator('[data-testid="baoco-nut-clear"]').click();
    await page.waitForTimeout(250);
    const sauClear = {
      tien: await page.locator('[data-testid="baoco-search-amount"]').inputValue(),
      nguoi: await page.locator('[data-testid="baoco-search-payer"]').inputValue(),
      trangThai: await page.locator('[data-testid="baoco-filter-status"]').inputValue(),
      ky: await page.locator('[data-testid="baoco-loc-ky"]').inputValue(),
      ma: (await page.locator('[data-testid="baoco-filter-ma"]').innerText()).replace(/\s+/g, ' ').trim()
    };
    if (truocClear.tien !== '1234') lech.push(`gõ số tiền không vào ô (đọc lại "${truocClear.tien}")`);
    if (!truocClear.ma.includes('DEMOMAY')) lech.push(`tích mã không hiện lên nút (nút đang là "${truocClear.ma}")`);
    if (sauClear.tien !== '' || sauClear.nguoi !== '') lech.push(`Clear KHÔNG xoá ô chữ: tiền="${sauClear.tien}" người="${sauClear.nguoi}"`);
    if (sauClear.trangThai !== 'all') lech.push(`Clear KHÔNG trả trạng thái về "all" (đang "${sauClear.trangThai}")`);
    if (sauClear.ky !== 'today') lech.push(`Clear KHÔNG trả kỳ về "today" (đang "${sauClear.ky}")`);
    if (!sauClear.ma.includes('Tất cả mã')) lech.push(`Clear KHÔNG bỏ tích mã (nút đang là "${sauClear.ma}")`);

    const truocTim = soLanTaiBaoCao;
    await page.locator('[data-testid="baoco-nut-tim"]').click();
    await page.waitForTimeout(800);
    if (soLanTaiBaoCao <= truocTim) lech.push('bấm "Tìm kiếm" KHÔNG gọi lại báo cáo (nút chết)');

    console.log(JSON.stringify({ so_o: do_.so_o, be_rong_cot: do_.be_rong_cot[0], truocClear, sauClear, soLanTaiBaoCao, lech }, null, 1));
    if (lech.length) hong = true;
    await ctx.close();
  } finally { await browser?.close(); await server.close(); }
  if (hong) throw new Error('KHỐI LỌC LỆCH SO VỚI CỔNG SmartPay — xem danh sách lệch ở trên');
}
void main();
