// [KHOÁ CHỐNG TÁI DIỄN 12/9] Lớp bug "đổi PROMPT mà quên bump cache tag" → cache cũ nhiễm trả kết quả thiếu
// field/format cũ vĩnh viễn (#p4 11/9, #qr1/#qr2 8/9). Snapshot sha256(prompt)↔tag: đổi prompt → hash lệch →
// test ĐỎ bắt (1) bump tag trong PROMPT_CACHE_REGISTRY + (2) cập nhật snapshot này CÙNG COMMIT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROMPT_CACHE_REGISTRY } from '../src/vision-ocr.mjs';

const SNAP = join(dirname(fileURLToPath(import.meta.url)), 'prompt-hash-snapshot.json');
const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

test('prompt đổi thì tag PHẢI bump (snapshot hash↔tag)', () => {
  const now = Object.fromEntries(Object.entries(PROMPT_CACHE_REGISTRY).map(([k, v]) => [k, { hash: sha8(v.prompt), tag: v.tag }]));
  if (!existsSync(SNAP)) { writeFileSync(SNAP, JSON.stringify(now, null, 1)); return; } // lần đầu: chụp
  const old = JSON.parse(readFileSync(SNAP, 'utf8'));
  for (const [k, cur] of Object.entries(now)) {
    const prev = old[k];
    if (!prev) continue; // prompt mới thêm — snapshot sẽ được chụp khi cập nhật file
    if (prev.hash !== cur.hash) {
      assert.notEqual(prev.tag, cur.tag, `PROMPT "${k}" ĐÃ ĐỔI (hash ${prev.hash}→${cur.hash}) mà tag vẫn "${cur.tag}" — PHẢI bump tag trong PROMPT_CACHE_REGISTRY rồi cập nhật test/prompt-hash-snapshot.json cùng commit (cache cũ sẽ nhiễm nếu không bump).`);
    } else {
      assert.equal(prev.tag, cur.tag, `PROMPT "${k}" không đổi mà tag đổi ${prev.tag}→${cur.tag} — bump thừa sẽ re-OCR oan toàn bộ cache, cập nhật snapshot nếu chủ đích.`);
    }
  }
  writeFileSync(SNAP, JSON.stringify(now, null, 1)); // đồng bộ snapshot sau khi pass
});
