// BATCH quét toàn bộ bill 2 nhóm NĐT → OCR chuyển khoản → POST /internal/investor-advance-ingest (endpoint tự
// lọc người-nhận=TK SigMa + dedup theo mã GD). Single-thread (bill rải, tránh rate-limit). Ghi tiến độ + tally.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { fileToPng } from '../src/image-normalize.mjs';
import { readTransferVision } from '../src/vision-ocr.mjs';
import { postAdvance } from '../src/ingest-client.mjs';

const cfg = loadConfig();
const RES = '<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const GROUPS = ['gDEMOGROUP0000000006', 'gDEMOGROUP0000000009'];
const SINCE = new Date('2026-08-25T00:00:00');
const OUT = path.join(path.dirname(cfg.stateFile ?? '.'), 'advance-batch-result.json');

function isoFrom(date, time) {
  if (!date) return null;
  const dm = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(String(date).trim());
  if (!dm) return null;
  const dd = dm[1].padStart(2, '0'), mm = dm[2].padStart(2, '0'), yyyy = dm[3];
  let hh = '00', mi = '00', ss = '00';
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(time || '').trim());
  if (tm) { hh = tm[1].padStart(2, '0'); mi = tm[2]; ss = tm[3] || '00'; }
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

const tally = {};
let done = 0, total = 0;
const recorded = [];

for (const g of GROUPS) {
  tally[g] = { bills: 0, transferBills: 0, recorded: 0, duplicate: 0, skip: 0, sumRecorded: 0 };
  const pic = path.join(RES, g, 'picture');
  if (!fs.existsSync(pic)) continue;
  const files = fs.readdirSync(pic).filter((f) => !f.startsWith('.') && /\.(jxl|jpg|jpeg|png)$/i.test(f))
    .map((f) => ({ p: path.join(pic, f), t: fs.statSync(path.join(pic, f)).mtime }))
    .filter((x) => x.t >= SINCE).sort((a, b) => a.t - b.t);
  total += files.length;
}
console.log(`[batch] Tổng ${total} bill 2 nhóm NĐT. Bắt đầu...`);

for (const g of GROUPS) {
  const pic = path.join(RES, g, 'picture');
  if (!fs.existsSync(pic)) continue;
  const files = fs.readdirSync(pic).filter((f) => !f.startsWith('.') && /\.(jxl|jpg|jpeg|png)$/i.test(f))
    .map((f) => ({ p: path.join(pic, f), t: fs.statSync(path.join(pic, f)).mtime }))
    .filter((x) => x.t >= SINCE).sort((a, b) => a.t - b.t);
  for (const x of files) {
    done++;
    tally[g].bills++;
    let png;
    try { png = await fileToPng(x.p); } catch { continue; }
    const imageHash = createHash('sha256').update(png).digest('hex');
    let transfers = [];
    try { ({ transfers } = await readTransferVision(png)); } catch { transfers = []; }
    if (transfers.length) tally[g].transferBills++;
    for (const t of transfers) {
      try {
        const { body } = await postAdvance(cfg, {
          zaloGroupId: g, receiverName: t.receiverName, receiverAccountNumber: t.receiverAccount, receiverBank: t.receiverBank,
          senderName: t.senderName, senderAccountNumber: t.senderAccount, amount: t.amount,
          advanceDateIso: isoFrom(t.date, t.time), ref: t.ref, imageHash, rawDate: t.date, rawTime: t.time
        });
        const a = body?.outcome?.action;
        if (a === 'recorded') { tally[g].recorded++; tally[g].sumRecorded += t.amount; recorded.push({ g, sender: t.senderName, amount: t.amount, ref: t.ref, date: t.date, time: t.time, inv: body.outcome.investorId }); }
        else if (a === 'duplicate') tally[g].duplicate++;
        else tally[g].skip++;
      } catch { /* mạng lỗi 1 bill — bỏ qua, batch tiếp */ }
    }
    if (done % 25 === 0) {
      console.log(`[batch] ${done}/${total} — TN rec ${tally[GROUPS[0]].recorded}, CP rec ${tally[GROUPS[1]].recorded}`);
      fs.writeFileSync(OUT, JSON.stringify({ done, total, tally, recorded }, null, 2));
    }
  }
}
fs.writeFileSync(OUT, JSON.stringify({ done, total, tally, recorded }, null, 2));
console.log('[batch] XONG.');
for (const g of GROUPS) console.log(`  ${g}: ${tally[g].bills} bill, ${tally[g].transferBills} chuyển khoản, GHI ${tally[g].recorded} (${(tally[g].sumRecorded / 1e6).toFixed(0)}tr), trùng ${tally[g].duplicate}, bỏ ${tally[g].skip}`);
console.log(`Kết quả: ${OUT}`);
