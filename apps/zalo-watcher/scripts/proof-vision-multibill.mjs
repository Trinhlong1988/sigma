import fs from 'node:fs'; import path from 'node:path';
import { fileToPng } from '../src/image-normalize.mjs';
import { readBillVision } from '../src/vision-ocr.mjs';
const RES='<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const G='gDEMOGROUP0000000008';
const SINCE=new Date('2026-08-26T00:00:00');
const pic=path.join(RES,G,'picture');
const files=fs.readdirSync(pic).filter(f=>/\.(jxl|jpg|jpeg|png)$/i.test(f)).map(f=>({f,p:path.join(pic,f),t:fs.statSync(path.join(pic,f)).mtime})).filter(x=>x.t>=SINCE).sort((a,b)=>b.t-a.t).slice(0,6);
console.log(`Re-OCR ${files.length} ảnh 26/8 nhóm g8926 bằng vision (Haiku):`);
let multi=0, totalBills=0;
for(const x of files){
  let png; try{png=await fileToPng(x.p);}catch{continue;}
  let bills=[]; try{({bills}=await readBillVision(png,{noCache:true}));}catch(e){console.log(`  ${x.f.slice(0,30)} LỖI ${e.message}`);continue;}
  const sale=bills.filter(b=>b.type==='SALE'&&b.tid);
  totalBills+=sale.length; if(sale.length>1)multi++;
  console.log(`  ${x.f.slice(0,24)}... → ${bills.length} bill (${sale.length} SALE có TID): ${sale.map(b=>`TID${b.tid}=${(b.totalAmount/1e6).toFixed(1)}tr`).join(', ')||'(none)'}`);
}
console.log(`\nTổng: ${totalBills} bill SALE, ${multi} ảnh nhiều-bill (chứng minh vision tách được)`);
process.exit(0);
