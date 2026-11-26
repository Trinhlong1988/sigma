// AUDIT2-I — nhãn ô lọc MultiSelect bị "…" đến mức TRÙNG NHAU (nhìn ảnh mới thấy).
import { moTrang, anh, finding, ok, FINDINGS } from './_audit2-lib.mjs';
const { browser, page } = await moTrang(1920, 1080);
const d = await page.evaluate(() => {
  const r = [];
  for (const b of document.querySelectorAll('button[title^="Tất cả"]')) {
    const sp = b.querySelector('span');
    r.push({
      day: b.getAttribute('title'),
      hien: (sp.textContent || '').trim(),
      canCho: sp.scrollWidth, duocCho: sp.clientWidth, thieu: sp.scrollWidth - sp.clientWidth,
      rongNut: +b.getBoundingClientRect().width.toFixed(1)
    });
  }
  return r;
});
console.log('=== AUDIT2-I · nhãn ô lọc ===');
d.forEach((x) => console.log(`  "${x.day}" → hiện "${x.hien}" · cần ${x.canCho}px chỉ có ${x.duocCho}px (thiếu ${x.thieu}px) · nút ${x.rongNut}px`));
const bicat = d.filter((x) => x.thieu > 0);
const trung = {};
for (const x of d) { trung[x.hien] = (trung[x.hien] || 0) + 1; }
const dup = Object.entries(trung).filter(([, n]) => n > 1);
await anh(page, 'I-nhan-loc.png');
if (dup.length)
  finding('VỪA', 'I-NHAN-LOC-TRUNG',
    'Nhãn ô lọc bị "…" đến mức TRÙNG NHAU — nhìn màn KHÔNG phân biệt được ô nào lọc gì: MultiSelect khoá cứng w-[118px] (MultiSelect.tsx:56) trong khi nhãn dài 100-140px',
    dup.map(([t, n]) => `"${t}" xuất hiện ${n} ô khác nhau (${d.filter((x) => x.hien === t).map((x) => x.day).join(' / ')})`).join(' · ') + ` · tổng ${bicat.length}/${d.length} ô lọc bị cắt chữ`);
else if (bicat.length)
  finding('NHẸ', 'I-NHAN-LOC-CAT', 'Nhãn ô lọc bị cắt chữ', bicat.map((x) => `"${x.day}"→"${x.hien}" thiếu ${x.thieu}px`).join(' · '));
else ok('I-NHAN-LOC', 'Nhãn ô lọc hiện đủ', `${d.length} ô`);
console.log(`\n=== AUDIT2-I xong · ${FINDINGS.length} finding ===`);
await browser.close();
