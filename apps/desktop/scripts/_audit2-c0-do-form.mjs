// AUDIT2-C0 — dò DOM bảng nhập để viết selector đúng (không kết luận gì, chỉ liệt kê).
import { moTrang, anh } from './_audit2-lib.mjs';
const { browser, page } = await moTrang(1920, 1080);
await page.locator('[data-nut="them"]').click();
await page.waitForTimeout(600);
const d = await page.evaluate(() => {
  const mo = document.body;
  return {
    labels: [...mo.querySelectorAll('label')].map((l) => (l.textContent || '').trim().slice(0, 60)),
    inputs: [...mo.querySelectorAll('input')].map((i) => ({ type: i.type, ph: i.placeholder, aria: i.getAttribute('aria-label'), cls: i.className.slice(0, 40) })),
    selects: [...mo.querySelectorAll('select')].map((s) => ({ opts: [...s.options].map((o) => o.textContent.trim()) })),
    fieldLabels: [...mo.querySelectorAll('div')].filter((d) => /^(Số hóa đơn|Số lô|Ngày trên bill|Giờ quẹt|Loại thẻ|Loại phí|Trước phí|Tiền hủy|Sau phí bán|Đã hoàn|Người hoàn|Còn phải hoàn|Ghi chú|Ca)/.test((d.textContent || '').trim())).slice(0, 0),
    nut: [...mo.querySelectorAll('button')].map((b) => ((b.getAttribute('data-nut') || '') + ':' + (b.textContent || '').trim()).slice(0, 50))
  };
});
console.log(JSON.stringify(d, null, 1));
await anh(page, 'C0-form.png');
await browser.close();
