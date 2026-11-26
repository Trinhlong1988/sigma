// Re-OCR bill nhóm CP (g965) đọc-RỖNG lần đầu (Haiku hay lệch) → tìm 400tr tạm ứng thiếu (→Ke Toan Demo). Bypass cache.
import fs from 'node:fs';
import path from 'node:path';
import { fileToPng } from '../src/image-normalize.mjs';
import { readTransferVision, ocrCacheGet, ocrCacheFlush } from '../src/vision-ocr.mjs';

const RES = '<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const G = 'gDEMOGROUP0000000009';
const SINCE = new Date('2026-08-25T00:00:00');
const MODEL = process.argv[2] || 'claude-haiku-4-5'; // truyền 'claude-opus-4-8' để dùng Opus
const isAlphaRecv = (r) => /nguoi dung demo|ke toan demo/i.test((r || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd'));
const dayOf = (d) => { const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec((d || '').trim()); return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : null; };

const pic = path.join(RES, G, 'picture');
const files = fs.readdirSync(pic).filter((f) => !f.startsWith('.') && /\.(jxl|jpg|jpeg|png)$/i.test(f)).map((f) => ({ f, p: path.join(pic, f), t: fs.statSync(path.join(pic, f)).mtime })).filter((x) => x.t >= SINCE);
console.log(`[reocr-cp] ${files.length} bill g965, model ${MODEL}. Chỉ re-OCR bill đọc-rỗng lần đầu.`);
const found = []; let re = 0, done = 0;
for (const x of files) {
  done++;
  let png; try { png = await fileToPng(x.p); } catch { continue; }
  const prev = ocrCacheGet('transfer', png);
  if (prev && prev.transfers && prev.transfers.length) continue; // đã đọc ra transfer rồi → bỏ
  re++;
  let transfers = []; try { ({ transfers } = await readTransferVision(png, { model: MODEL, noCache: true })); } catch { transfers = []; }
  for (const t of transfers) if (isAlphaRecv(t.receiverName)) { found.push({ amount: t.amount, sender: t.senderName, receiver: t.receiverName, date: t.date, time: t.time, ref: t.ref, day: dayOf(t.date), file: x.f }); console.log(`  MỚI: ${(t.amount / 1e6).toFixed(1)}tr ${t.date} ${t.time || ''} ${t.senderName || '?'}→${t.receiverName} mã ${t.ref}`); }
  if (done % 25 === 0) console.log(`[reocr-cp] ${done}/${files.length}, re-OCR ${re}, tìm thấy ${found.length}`);
}
ocrCacheFlush();
const s25 = found.filter((a) => a.day === '2026-08-25').reduce((s, a) => s + a.amount, 0);
console.log(`[reocr-cp] XONG. re-OCR ${re} bill rỗng → tìm thêm ${found.length} tạm ứng | 25/8 = ${(s25 / 1e6).toFixed(0)}tr`);
fs.writeFileSync('<REPO>/Desktop/cp-reocr-found.json', JSON.stringify(found, null, 2));
