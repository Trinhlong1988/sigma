// [Admin Demo 16/9 khuya] ĐÁNH GIÁ GEMINI (hôm nay) vs OPUS từ DỮ LIỆU OCR ĐÃ CÓ — không gọi API, chỉ đọc sổ cache.
// Cách so: mỗi ẢNH có khoá hash riêng; cùng 1 hash có thể tồn tại nhiều "variant" model:
//   consensus:claude-sonnet-5@2400#cons1:<hash>  = đường CHUẨN (từ 16/9 engine THẬT là GEMINI, model chỉ là nhãn)
//   consensus:claude-opus-4-8@2400#cons1:<hash>  = lượt "Đọc lại bằng Opus" (đi thẳng Claude Opus)
// Ảnh nào có CẢ HAI ⇒ so được: cùng kind? cùng SỐ TIỀN? cùng TID/lô (POS) / cùng người nhận (CK)?
// LƯU Ý TRUNG THỰC: đây là so KHỚP GIỮA 2 MODEL, KHÔNG phải so với sự thật — lệch nghĩa là "1 trong 2 sai",
// khớp KHÔNG chứng minh cả 2 đúng. Muốn biết đúng/sai tuyệt đối phải có bộ golden người xác nhận.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(ROOT, 'ocr-cache.jsonl'), 'utf8').split('\n');

/** hash ảnh → { sonnet: {...}, opus: {...} } (bản GHI SAU thắng — đúng như cache dùng thật) */
const theoAnh = new Map();
let tongDong = 0;
for (const ln of lines) {
  if (!ln.trim()) continue;
  let e;
  try { e = JSON.parse(ln); } catch { continue; }
  tongDong += 1;
  const k = String(e.k ?? '');
  if (!k.startsWith('consensus:')) continue;
  const m = /^consensus:(claude-[a-z0-9.-]+)@\d+#cons1:([0-9a-f]+)$/.exec(k);
  if (!m) continue;
  const [, model, hash] = m;
  const nhom = model.includes('opus') ? 'opus' : model.includes('sonnet') ? 'sonnet' : null;
  if (!nhom) continue;
  const cur = theoAnh.get(hash) ?? {};
  cur[nhom] = e.v;
  theoAnh.set(hash, cur);
}

const tienCua = (v) => {
  if (!v) return null;
  if (v.kind === 'POS') return (v.bills ?? []).map((b) => Math.round(Number(b.totalAmount) || 0)).sort((a, b) => a - b).join('+');
  if (v.kind === 'TRANSFER') return (v.transfers ?? []).map((t) => Math.round(Number(t.amount) || 0)).sort((a, b) => a - b).join('+');
  if (v.kind === 'QR') return (v.qr ?? []).map((q) => Math.round(Number(q.amount) || 0)).sort((a, b) => a - b).join('+');
  return null;
};
const khoaPos = (v) => (v?.bills ?? []).map((b) => `${b.tid ?? '-'}/${b.batchNumber ?? '-'}`).sort().join(',');
const nguoiNhan = (v) => (v?.transfers ?? []).map((t) => String(t.receiverName ?? '').toUpperCase().trim()).sort().join(',');

let cap = 0, cungKind = 0, cungTien = 0, lechTien = [], cungKhoaPos = 0, cungNhan = 0, posCap = 0, ckCap = 0;
for (const [hash, d] of theoAnh) {
  if (!d.sonnet || !d.opus) continue;
  cap += 1;
  const kS = d.sonnet.kind, kO = d.opus.kind;
  if (kS === kO) cungKind += 1;
  const tS = tienCua(d.sonnet), tO = tienCua(d.opus);
  if (tS != null && tO != null) {
    if (tS === tO) cungTien += 1;
    else lechTien.push({ hash: hash.slice(0, 10), kindS: kS, kindO: kO, tienS: tS, tienO: tO });
  }
  if (kS === 'POS' && kO === 'POS') { posCap += 1; if (khoaPos(d.sonnet) === khoaPos(d.opus)) cungKhoaPos += 1; }
  if (kS === 'TRANSFER' && kO === 'TRANSFER') { ckCap += 1; if (nguoiNhan(d.sonnet) === nguoiNhan(d.opus)) cungNhan += 1; }
}

const pc = (a, b) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);
console.log(`SỔ CACHE: ${tongDong} dòng · ${theoAnh.size} ảnh có bản consensus`);
console.log(`ẢNH ĐƯỢC ĐỌC BỞI CẢ HAI (Gemini-đường-chuẩn ↔ Opus): ${cap}`);
console.log(`  · cùng LOẠI bill      : ${cungKind}/${cap} (${pc(cungKind, cap)})`);
console.log(`  · cùng SỐ TIỀN        : ${cungTien}/${cap} (${pc(cungTien, cap)})  ← chỉ tiêu quan trọng nhất`);
console.log(`  · POS cùng TID+số lô  : ${cungKhoaPos}/${posCap} (${pc(cungKhoaPos, posCap)})`);
console.log(`  · CK cùng người nhận  : ${cungNhan}/${ckCap} (${pc(cungNhan, ckCap)})`);
if (lechTien.length) {
  console.log(`\nCÁC ẢNH LỆCH TIỀN (${lechTien.length}) — 1 trong 2 model đọc sai, cần người xác minh:`);
  for (const x of lechTien.slice(0, 20)) {
    console.log(`  ${x.hash}… | Gemini(${x.kindS}) ${x.tienS}  ≠  Opus(${x.kindO}) ${x.tienO}`);
  }
}
