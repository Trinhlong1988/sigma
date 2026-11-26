// Sinh icon nguồn 1024x1024 cho @capacitor/assets (Android app icon) TỪ ẢNH LOGO THẬT alpha-logo.webp.
// 3/8 (Admin Demo "icon mở/cài vẫn icon cũ"): THAY cách CŨ tự-vẽ-lại vector "điện thoại lồng chữ A" + màu cũ
// #1657d0 (B36, 27/7) — bài học B118: vẽ lại vector tách rời ảnh thật = SAI. Nay compose thẳng ảnh webp thật
// (byte-identical logo trong app + desktop icon.ico) → icon launcher khớp 100% brand mới. Tone nền brand #0579cc.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPT_DIR, '..', 'resources');
const LOGO = join(SCRIPT_DIR, '..', 'src', 'assets', 'alpha-logo.webp');
const TINT = '#eaf2ff'; // nền sáng brand-tint (khớp thẻ Login trắng-xanh nhạt), hoà với nền trắng của logo webp.

const logoBuf = fs.readFileSync(LOGO);
const svgPng = (svg, w, h) => sharp(Buffer.from(svg)).resize(w, h).png().toBuffer();

// Logo webp nền TRẮNG → compose lên nền sáng TINT (giống desktop) cho liền mạch, KHÔNG để nền trắng vuông lệch.
async function tintSquare(size) {
  return sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${TINT}"/></svg>`
  )).png().toBuffer();
}
async function logoAt(size, ratio) {
  const inner = Math.round(size * ratio);
  const off = Math.round((size - inner) / 2);
  const lg = await sharp(logoBuf).resize(inner, inner, { fit: 'contain', background: { r: 234, g: 242, b: 255, alpha: 1 } }).png().toBuffer();
  return { lg, off };
}

// ---- icon.png (legacy vuông): nền sáng bo góc + logo ~80% ----
async function iconPng(size) {
  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
    <defs><linearGradient id="bev" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e6f2fb"/></linearGradient></defs>
    <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#bev)"/></svg>`;
  const bgPng = await svgPng(bg, size, size);
  const { lg, off } = await logoAt(size, 0.8);
  return sharp(bgPng).composite([{ input: lg, left: off, top: off }]).png().toBuffer();
}

// ---- foreground (adaptive): nền TINT đầy khung + logo ~68% (an toàn safe-zone Android tự crop ~66%) ----
async function foregroundPng(size) {
  const base = await tintSquare(size);
  const { lg, off } = await logoAt(size, 0.68);
  return sharp(base).composite([{ input: lg, left: off, top: off }]).png().toBuffer();
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/icon.png`, await iconPng(1024));
fs.writeFileSync(`${OUT_DIR}/icon-foreground.png`, await foregroundPng(1024));
fs.writeFileSync(`${OUT_DIR}/icon-background.png`, await tintSquare(1024));

console.log('WROTE icon resources tu logo THAT:', fs.readdirSync(OUT_DIR).join(', '));
