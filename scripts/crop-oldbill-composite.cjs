// MIGRATION: crop 42 bill POS composite CŨ (ảnh bill trên + bảng dưới) → CHỈ giữ phần bill. Backup gốc trước.
// Fail-safe: KHÔNG thấy thanh "Số tiền" xanh → SKIP (giữ nguyên, không corrupt). Idempotent: ảnh đã crop (không còn
// bảng) → detect KHÔNG thấy → skip (an toàn chạy lại).
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

const UPLOADS = '<REPO>/apps/bot-api/uploads';
const BACKUP = process.argv[3] || '<BACKUP_DIR>/oldbill-composite-20260901';
const listFile = process.argv[2];
const DRY = process.argv.includes('--dry');

function isHeroBlue(r, g, b) { return r < 70 && g > 80 && g < 175 && b > 165 && b > r + 90; }

async function detectTableTop(img) {
  const W = img.bitmap.width, H = img.bitmap.height, samples = 24;
  for (let y = Math.floor(H * 0.25); y < H; y++) {
    let blue = 0;
    for (let i = 0; i < samples; i++) {
      const x = Math.floor((i + 0.5) * W / samples);
      const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
      if (isHeroBlue(r, g, b)) blue++;
    }
    if (blue >= samples * 0.85) return y;
  }
  return -1;
}

(async () => {
  if (!DRY) fs.mkdirSync(BACKUP, { recursive: true });
  const paths = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let cropped = 0, skipped = 0, missing = 0;
  for (const sp of paths) {
    const src = path.join(UPLOADS, sp);
    if (!fs.existsSync(src)) { console.log('MISSING', sp); missing++; continue; }
    let img;
    try { img = await Jimp.read(src); } catch (e) { console.log('READ_FAIL', sp, e.message); skipped++; continue; }
    const top = await detectTableTop(img);
    if (top <= 0 || top >= img.bitmap.height - 4) { console.log('SKIP (no table)', sp, `H=${img.bitmap.height} top=${top}`); skipped++; continue; }
    console.log(`${DRY ? 'DRY ' : ''}CROP ${sp} ${img.bitmap.width}x${img.bitmap.height} -> H=${top} (${(100 * top / img.bitmap.height).toFixed(0)}%)`);
    if (!DRY) {
      fs.copyFileSync(src, path.join(BACKUP, sp)); // backup gốc
      img.crop(0, 0, img.bitmap.width, top);
      await img.writeAsync(src); // overwrite
    }
    cropped++;
  }
  console.log(`\n${DRY ? '[DRY-RUN] ' : ''}DONE: cropped=${cropped} skipped=${skipped} missing=${missing} / total=${paths.length}`);
})();
