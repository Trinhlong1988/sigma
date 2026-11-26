import fs from 'node:fs'; import path from 'node:path';
import { fileToPng } from '../src/image-normalize.mjs';
import { readBillVision } from '../src/vision-ocr.mjs';
const RES='<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const G='gDEMOGROUP0000000007';
const SINCE=new Date('2026-08-26T00:00:00'), UNTIL=new Date('2026-08-27T00:00:00');
const pic=path.join(RES,G,'picture');
const files=fs.readdirSync(pic).filter(f=>/\.(jxl|jpg|jpeg|png)$/i.test(f)).map(f=>({f,p:path.join(pic,f),t:fs.statSync(path.join(pic,f)).mtime})).filter(x=>x.t>=SINCE&&x.t<UNTIL).sort((a,b)=>a.t-b.t).slice(0,4);
console.log(`DRY-RUN: vision đọc ${files.length} ảnh 26/8 (KHÔNG ghi DB) — kiểm tid+tiền+GIỜ:`);
for(const x of files){
  let png; try{png=await fileToPng(x.p);}catch{continue;}
  let bills=[]; try{({bills}=await readBillVision(png,{noCache:true}));}catch(e){console.log(`  LỖI ${e.message}`);continue;}
  for(const b of bills) console.log(`  [${b.type}] TID=${b.tid||'?'} tiền=${(b.totalAmount/1e6).toFixed(2)}tr lô=${b.batchNumber||'?'} GIỜ="${b.dateTime||'KHÔNG ĐỌC ĐƯỢC'}"`);
}
console.log('DRY-RUN xong (không ghi gì).');
process.exit(0);
