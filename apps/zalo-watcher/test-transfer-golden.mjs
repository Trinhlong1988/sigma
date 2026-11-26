// GOLDEN TEST bill CHUYỂN KHOẢN hoàn tiền đại lý (Admin Demo 31/8 "cấm tái diễn").
// Chạy: node test-transfer-golden.mjs  — TRƯỚC MỌI thay đổi OCR transfer (prompt/model/resize/classify) + trước ship.
// Dùng readBillOrTransfer (ĐÚNG path /ocr ship). Fixtures + đáp án THẬT ở golden-transfer/ (GITIGNORE — data tiền).
// Bug đã chặn: Haiku hoán người gửi↔nhận + lấy nhầm số bong bóng thông báo thay số biên lai "Chuyển tiền thành công".
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readBillOrTransfer } from './src/vision-ocr.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'golden-transfer');
const norm = (s) => (s || '').toString().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

async function main() {
  if (!existsSync(join(DIR, 'expected.json'))) {
    console.error('⚠ THIẾU golden-transfer/expected.json + ảnh mẫu THẬT (gitignore). Copy bill thật vào rồi chạy lại.');
    process.exit(2);
  }
  const spec = JSON.parse(await readFile(join(DIR, 'expected.json'), 'utf8'));
  let fail = 0;
  for (const c of spec.cases) {
    const buf = await readFile(join(DIR, c.file));
    const r = await readBillOrTransfer(buf);
    const errs = [];
    if (c.kind && r.kind !== c.kind) errs.push(`kind=${r.kind} (mong ${c.kind})`);
    if (c.kind === 'TRANSFER') {
      const t = r.transfers?.[0] ?? {};
      if (c.amount != null && Number(t.amount) !== Number(c.amount)) errs.push(`amount=${t.amount} (mong ${c.amount}) ⚠TIỀN`);
      if (c.receiverNameIncludes && !norm(t.receiverName).includes(norm(c.receiverNameIncludes))) errs.push(`receiver="${t.receiverName}" (mong chứa "${c.receiverNameIncludes}")`);
      if (c.senderNameIncludes && !norm(t.senderName).includes(norm(c.senderNameIncludes))) errs.push(`sender="${t.senderName}" (mong chứa "${c.senderNameIncludes}")`);
      // [Admin Demo 16/9] appBank = bank CỦA APP chụp bill (MBV ≠ MB) — quyết định miễn chặn trùng giờ+tiền, sai là chặn oan/thả nhầm.
      if (c.appBank && norm(t.appBank).replace(/[^A-Z0-9]/g, '') !== norm(c.appBank).replace(/[^A-Z0-9]/g, '')) errs.push(`appBank="${t.appBank}" (mong "${c.appBank}") ⚠BANK`);
    }
    if (errs.length) { fail++; console.log(`❌ ${c.file}: ${errs.join(' · ')}`); }
    else console.log(`✅ ${c.file} (${c.kind})`);
  }
  console.log(fail ? `\n❌ GOLDEN FAIL ${fail}/${spec.cases.length}` : `\n✅ GOLDEN PASS ${spec.cases.length}/${spec.cases.length}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
