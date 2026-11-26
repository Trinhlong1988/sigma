// GOM CHI TIẾT tạm ứng: OCR mọi bill 2 nhóm NĐT → lọc chuyển khoản ĐẾN Nguoi Dung Demo/Ke Toan Demo (theo TÊN chuẩn
// hoá HOẶC SỐ TK đã biết) → ghi list {group,sender,receiver,account,amount,date,time,ref,file}. In tổng/nhóm để đối
// chiếu đối chứng (TN 4,5 tỷ / CP 2,65 tỷ). CHỈ gom + xuất JSON (KHÔNG ghi DB) để review trước.
import fs from 'node:fs';
import path from 'node:path';
import { fileToPng } from '../src/image-normalize.mjs';
import { readTransferVision, ocrCacheFlush } from '../src/vision-ocr.mjs';

const RES = '<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const GROUPS = { gDEMOGROUP0000000006: 'TN', gDEMOGROUP0000000009: 'CP' };
const SINCE = new Date('2026-08-25T00:00:00');
const OUT = '<REPO>/Desktop/advances-collected.json';

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SIGMA_NAMES = ['nguoi dung demo', 'ke toan demo'];
const SIGMA_ACCS = new Set(['81331', '42227', '8888', 'DEMO-ACCT9', 'DEMO-ACCT']);
const isAlpha = (name, acc) => { const n = norm(name); if (SIGMA_NAMES.some((r) => n.includes(r))) return true; const a = (acc || '').replace(/\s/g, ''); return [...SIGMA_ACCS].some((x) => a.includes(x) || x.includes(a) && a.length >= 4); };

const collected = []; const tally = { TN: 0, CP: 0 }; let done = 0, total = 0;
for (const g of Object.keys(GROUPS)) { const pic = path.join(RES, g, 'picture'); if (fs.existsSync(pic)) total += fs.readdirSync(pic).filter((f) => !f.startsWith('.') && /\.(jxl|jpg|jpeg|png)$/i.test(f)).filter((f) => fs.statSync(path.join(pic, f)).mtime >= SINCE).length; }
console.log(`[collect] ${total} bill 2 nhóm NĐT`);
for (const g of Object.keys(GROUPS)) {
  const pic = path.join(RES, g, 'picture'); if (!fs.existsSync(pic)) continue;
  const files = fs.readdirSync(pic).filter((f) => !f.startsWith('.') && /\.(jxl|jpg|jpeg|png)$/i.test(f)).map((f) => ({ f, p: path.join(pic, f), t: fs.statSync(path.join(pic, f)).mtime })).filter((x) => x.t >= SINCE).sort((a, b) => a.t - b.t);
  for (const x of files) {
    done++;
    let png; try { png = await fileToPng(x.p); } catch { continue; }
    let transfers = []; try { ({ transfers } = await readTransferVision(png)); } catch { transfers = []; }
    for (const t of transfers) {
      if (!isAlpha(t.receiverName, t.receiverAccount)) continue;
      collected.push({ group: GROUPS[g], sender: t.senderName, receiver: t.receiverName, account: t.receiverAccount, amount: t.amount, date: t.date, time: t.time, ref: t.ref, file: x.f });
      tally[GROUPS[g]] += t.amount || 0;
    }
    if (done % 25 === 0) { console.log(`[collect] ${done}/${total} — TN ${(tally.TN / 1e6).toFixed(0)}tr, CP ${(tally.CP / 1e6).toFixed(0)}tr, ${collected.length} tạm ứng`); fs.writeFileSync(OUT, JSON.stringify({ collected, tally }, null, 2)); }
  }
}
ocrCacheFlush(); // lưu hết cache OCR (chống đọc lại lần sau)
fs.writeFileSync(OUT, JSON.stringify({ collected, tally }, null, 2));
console.log(`[collect] XONG. TN ${(tally.TN / 1e6).toFixed(0)}tr (đối chứng 4500tr), CP ${(tally.CP / 1e6).toFixed(0)}tr (đối chứng 2650tr). ${collected.length} tạm ứng → ${OUT}`);
