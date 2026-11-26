// AUDIT2 (đợt kiểm thử đối kháng 2, 6/11) — thư viện dùng chung.
// CHỈ ĐỌC trang demo đang chạy ở cổng 57912 (KHÔNG giết tiến trình, KHÔNG sửa code sản phẩm).
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = resolve(here, '..', 'screenshots', 'audit2-bill-le');
mkdirSync(OUT, { recursive: true });
export const URL_DEMO = 'http://localhost:57912/harness-bill-le.html';

export const FINDINGS = [];
export function finding(muc, ma, mota, soDo) {
  FINDINGS.push({ muc, ma, mota, soDo });
  console.log(`  [${muc}] ${ma} — ${mota}\n        số đo: ${soDo}`);
}
export function ok(ma, mota, soDo) {
  console.log(`  [đã-thử-không-thấy-lỗi] ${ma} — ${mota} · ${soDo}`);
}

export async function moTrang(width = 1920, height = 1080) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const log = [];
  page.on('console', (m) => log.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => log.push({ type: 'pageerror', text: e.message + '\n' + (e.stack || '') }));
  await page.goto(URL_DEMO, { waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  await page.waitForTimeout(400);
  return { browser, page, log };
}

export async function anh(page, ten) {
  const p = resolve(OUT, ten);
  await page.screenshot({ path: p });
  console.log('        ảnh →', p);
  return p;
}

/** Đọc TOÀN BỘ bảng danh sách từ DOM: tiêu đề, từng dòng (mảng text), hàng TỔNG. */
export async function docBang(page) {
  return page.evaluate(() => {
    const t = document.querySelector('[data-kiem="khung-bang"] table');
    const head = [...t.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim());
    const rows = [...t.querySelectorAll('tbody tr')]
      .filter((tr) => !tr.hasAttribute('aria-hidden') && tr.querySelectorAll('td').length > 3)
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()));
    const foot = [...t.querySelectorAll('tfoot td')].map((td) => ({
      text: (td.textContent || '').trim(),
      colSpan: td.colSpan
    }));
    const rong = (sel) =>
      [...t.querySelectorAll(sel)].map((x) => ({
        ten: (x.textContent || '').trim(),
        rong: Math.round(x.getBoundingClientRect().width),
        trai: Math.round(x.getBoundingClientRect().left),
        cs: getComputedStyle(x)
      }));
    return {
      head,
      rows,
      foot,
      soCotHead: head.length,
      cotRong: [...t.querySelectorAll('thead th')].map((x) => Math.round(x.getBoundingClientRect().width)),
      rongBang: Math.round(t.getBoundingClientRect().width),
      minWidthBang: getComputedStyle(t).minWidth
    };
  });
}

/** 'Tổng' số từ chuỗi kiểu "29.625.000" / "−1.234" → number. */
export function soTuChuoi(s) {
  const neg = /[−-]/.test(s.trim()[0] ?? '');
  const d = (s || '').replace(/[^\d]/g, '');
  if (!d) return 0;
  return (neg ? -1 : 1) * Number(d);
}

/** Đọc 5 ô KPI. */
export async function docKpi(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('div.w-\\[172px\\]')].map((d) => ({
      nhan: (d.children[0].textContent || '').trim(),
      so: (d.children[1].textContent || '').trim(),
      textAlign: getComputedStyle(d).textAlign,
      rong: Math.round(d.getBoundingClientRect().width)
    }))
  );
}

/** Gõ vào ô lọc SỐ (placeholder "Số lô" / "Số HĐ"). */
export async function goOSo(page, placeholder, giaTri) {
  const el = page.getByPlaceholder(placeholder, { exact: true });
  await el.click();
  await el.fill('');
  if (giaTri !== '') await el.type(String(giaTri), { delay: 15 });
  await page.waitForTimeout(260);
  return el;
}
