// Phân tích tạm ứng từ CACHE OCR (tức thì, không gọi claude): gom transfer→ND Demo/KT Demo 2 nhóm NĐT, tách theo NGÀY,
// dedup theo mã GD, đối chiếu đối chứng (TN 25/8=4500tr, CP=2650tr). CHỈ đọc cache (hit) — nhanh.
import fs from 'node:fs';
import path from 'node:path';
import { fileToPng } from '../src/image-normalize.mjs';
import { readTransferVision } from '../src/vision-ocr.mjs';

const RES = '<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const GROUPS = { gDEMOGROUP0000000006: 'TN', gDEMOGROUP0000000009: 'CP' };
const SINCE = new Date('2026-08-25T00:00:00');
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SIGMA = ['nguoi dung demo', 'ke toan demo'];
const ACCS = ['81331', '42227', '8888', 'DEMO-ACCT9', 'DEMO-ACCT'];
const isAlpha = (name, acc) => { const n = norm(name); if (SIGMA.some((r) => n.includes(r))) return true; const a = (acc || '').replace(/\s/g, ''); return a.length >= 4 && ACCS.some((x) => a.includes(x) || x.includes(a)); };
const dayOf = (d) => { const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec((d || '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };

const all = [];
for (const g of Object.keys(GROUPS)) {
  const pic = path.join(RES, g, 'picture'); if (!fs.existsSync(pic)) continue;
  const files = fs.readdirSync(pic).filter((f) => !f.startsWith('.') && /\.(jxl|jpg|jpeg|png)$/i.test(f)).map((f) => ({ f, p: path.join(pic, f), t: fs.statSync(path.join(pic, f)).mtime })).filter((x) => x.t >= SINCE);
  for (const x of files) {
    let png; try { png = await fileToPng(x.p); } catch { continue; }
    let transfers = []; try { ({ transfers } = await readTransferVision(png)); } catch { transfers = []; } // cache hit
    for (const t of transfers) if (isAlpha(t.receiverName, t.receiverAccount)) all.push({ grp: GROUPS[g], ...t, day: dayOf(t.date) });
  }
}
// dedup theo (grp, ref) — ref null giữ nguyên
const seen = new Set(); const dedup = [];
for (const a of all) { const k = a.grp + '|' + (a.ref || `${a.amount}|${a.date}|${a.time}`); if (seen.has(k)) continue; seen.add(k); dedup.push(a); }
const sum = (arr, grp, day) => arr.filter((a) => a.grp === grp && (!day || a.day === day)).reduce((s, a) => s + (a.amount || 0), 0);
const cnt = (arr, grp, day) => arr.filter((a) => a.grp === grp && (!day || a.day === day)).length;
console.log('=== TỔNG (dedup theo mã GD) ===');
for (const grp of ['TN', 'CP']) {
  const dc = grp === 'TN' ? 4500 : 2650;
  console.log(`${grp}: 25/8 = ${(sum(dedup, grp, '2026-08-25') / 1e6).toFixed(0)}tr (${cnt(dedup, grp, '2026-08-25')} lần) vs đối chứng ${dc}tr | 26/8 = ${(sum(dedup, grp, '2026-08-26') / 1e6).toFixed(0)}tr (${cnt(dedup, grp, '2026-08-26')} lần) | không rõ ngày = ${(sum(dedup.filter(a => !a.day), grp) / 1e6).toFixed(0)}tr`);
}
console.log('=== CHI TIẾT 25/8 (từng bill) ===');
for (const a of dedup.filter((x) => x.day === '2026-08-25').sort((x, y) => x.grp.localeCompare(y.grp) || (x.time || '').localeCompare(y.time || ''))) console.log(` ${a.grp} ${(a.amount / 1e6).toFixed(1)}tr ${a.date} ${a.time || ''} ${a.sender || '?'}→${a.receiver} mã ${a.ref || '(không)'}`);
console.log('thô (chưa dedup):', all.length, '| dedup:', dedup.length);
