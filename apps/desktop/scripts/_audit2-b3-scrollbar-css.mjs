import { chromium } from 'playwright';
const html = `<!doctype html><style>
div{width:200px;overflow:auto;border:0}
div>p{width:900px;margin:0;height:40px}
#a::-webkit-scrollbar{height:16px}
#a::-webkit-scrollbar-thumb{background:#7aa7cf}
#b{scrollbar-width:auto;scrollbar-color:#7aa7cf #e7edf4}
#b::-webkit-scrollbar{height:16px}
#b::-webkit-scrollbar-thumb{background:#7aa7cf}
#c{scrollbar-width:thin}
#c::-webkit-scrollbar{height:16px}
</style>
<div id=a><p>a</p></div><div id=b><p>b</p></div><div id=c><p>c</p></div>`;
for (const args of [[], ['--disable-features=OverlayScrollbar,FluentOverlayScrollbar']]) {
  const b = await chromium.launch({ args });
  const p = await b.newPage();
  await p.setContent(html);
  const r = await p.evaluate(() => ['a','b','c'].map(id=>{const e=document.getElementById(id);return id+'='+(e.offsetHeight-e.clientHeight)+'px'}));
  console.log((args.length?'tắt-overlay':'mặc-định')+':', r.join(' · '));
  await b.close();
}
