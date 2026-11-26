// MÃ HOÁ BẢN SAO LƯU DB (Admin Demo duyệt 7/11 — nhóm 1).
//
// Vì sao: 51 file `.dump` hiện là pg_dump THÔ (5 byte đầu = "PGDMP"), 2,72 GB, nằm trên admin share
// `\\127.0.0.1\D$`. Một tài khoản máy bị chiếm = lấy trọn dữ liệu tiền của cả công ty, KHÔNG cần vào app,
// KHÔNG để lại vết trong nhật ký kiểm toán.
//
// Cách làm: AES-256-GCM (có thẻ xác thực — sửa 1 byte là phát hiện). Khoá 32 byte nằm trong FILE RIÊNG,
// KHÔNG nằm cùng chỗ backup và KHÔNG nằm trong repo.
//
// Dùng:
//   node scripts/ma-hoa-backup.mjs --tao-khoa            → sinh khoá mới (chỉ chạy 1 lần, in đường dẫn)
//   node scripts/ma-hoa-backup.mjs --ma-hoa <file.dump>  → tạo <file.dump.enc> rồi KIỂM giải mã lại
//   node scripts/ma-hoa-backup.mjs --giai-ma <file.enc> <file-ra>
//
// Định dạng file .enc:  "ALPHAENC1" (9B) | iv (12B) | thẻ xác thực (16B) | dữ liệu đã mã hoá
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname, basename } from 'node:path';

const NHAN = Buffer.from('ALPHAENC1', 'utf8');
const DUONG_KHOA = process.env.SIGMA_BACKUP_KEY_FILE || '<BACKUP_DIR>\\khoa-ma-hoa.key';

function docKhoa() {
  if (!existsSync(DUONG_KHOA)) {
    console.error(`[ma-hoa] THIẾU khoá ${DUONG_KHOA} — chạy "--tao-khoa" trước. KHÔNG tự sinh khoá ngầm:`);
    console.error('[ma-hoa] sinh ngầm mỗi lần = mỗi bản backup một khoá khác ⇒ mất khả năng phục hồi.');
    process.exit(1);
  }
  const k = Buffer.from(readFileSync(DUONG_KHOA, 'utf8').trim(), 'hex');
  if (k.length !== 32) {
    console.error('[ma-hoa] Khoá không đúng 32 byte → DỪNG.');
    process.exit(1);
  }
  return k;
}

const bam = (f) => {
  const h = createHash('sha256');
  h.update(readFileSync(f));
  return h.digest('hex').slice(0, 16);
};

async function maHoa(nguon) {
  const khoa = docKhoa();
  const ra = nguon + '.enc';
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', khoa, iv);
  // Ghi phần thân trước vào file tạm, vì thẻ xác thực chỉ có SAU khi mã hoá xong.
  const tam = ra + '.tmp';
  await pipeline(createReadStream(nguon), c, createWriteStream(tam));
  const the = c.getAuthTag();
  const than = readFileSync(tam);
  writeFileSync(ra, Buffer.concat([NHAN, iv, the, than]));
  try { (await import('node:fs')).unlinkSync(tam); } catch { /* bỏ qua */ }
  return ra;
}

async function giaiMa(nguon, dich) {
  const khoa = docKhoa();
  const buf = readFileSync(nguon);
  if (!buf.subarray(0, NHAN.length).equals(NHAN)) throw new Error('Không phải file ALPHAENC1');
  const iv = buf.subarray(9, 21);
  const the = buf.subarray(21, 37);
  const than = buf.subarray(37);
  const d = createDecipheriv('aes-256-gcm', khoa, iv);
  d.setAuthTag(the);
  writeFileSync(dich, Buffer.concat([d.update(than), d.final()]));
  return dich;
}

const lenh = process.argv[2];
try {
  if (lenh === '--tao-khoa') {
    if (existsSync(DUONG_KHOA)) {
      console.error(`[ma-hoa] ĐÃ CÓ khoá ${DUONG_KHOA} — KHÔNG ghi đè (ghi đè = mọi bản backup cũ thành rác).`);
      process.exit(1);
    }
    mkdirSync(dirname(DUONG_KHOA), { recursive: true });
    const k = randomBytes(32).toString('hex');
    writeFileSync(DUONG_KHOA, k + '\n', { encoding: 'utf8', mode: 0o600 });
    console.log('[ma-hoa] Đã sinh khoá →', DUONG_KHOA);
    console.log('[ma-hoa] ⚠ CHÉP khoá này ra NƠI KHÁC (két/USB/ghi tay). MẤT KHOÁ = MẤT TOÀN BỘ BACKUP.');
    console.log('[ma-hoa] ⚠ ĐỪNG để khoá cùng thư mục với file backup trên máy chia sẻ.');
  } else if (lenh === '--ma-hoa') {
    const f = resolve(process.argv[3] ?? '');
    if (!existsSync(f)) throw new Error('Không thấy file: ' + f);
    const truoc = statSync(f).size;
    const bamTruoc = bam(f);
    const ra = await maHoa(f);
    // CỔNG QA: giải mã lại NGAY, so kích thước + mã băm. Không chứng minh được là KHÔNG dám coi là xong.
    const thu = ra + '.kiem';
    await giaiMa(ra, thu);
    const bamSau = bam(thu);
    const dauEnc = readFileSync(ra).subarray(0, 5).toString('utf8');
    const dauGoc = readFileSync(thu).subarray(0, 5).toString('utf8');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(thu);
    const dat = bamTruoc === bamSau && dauGoc === 'PGDMP' && dauEnc !== 'PGDMP';
    console.log(`[ma-hoa] ${basename(f)} ${(truoc / 1024 / 1024).toFixed(1)} MB → ${basename(ra)}`);
    console.log(`[ma-hoa] CỔNG QA: băm trước ${bamTruoc} · sau khi giải mã ${bamSau} · 5 byte đầu file mã hoá "${dauEnc}" · của bản giải mã "${dauGoc}"`);
    if (!dat) {
      console.error('[ma-hoa] *** KHÔNG ĐẠT — giữ nguyên file gốc, KHÔNG xoá gì. ***');
      process.exit(1);
    }
    console.log('[ma-hoa] ĐẠT: khôi phục lại ĐÚNG NGUYÊN BẢN, và file mã hoá không còn chữ ký PGDMP.');
  } else if (lenh === '--giai-ma') {
    const ra = await giaiMa(resolve(process.argv[3] ?? ''), resolve(process.argv[4] ?? ''));
    console.log('[ma-hoa] Đã giải mã →', ra);
  } else {
    console.log('Dùng: --tao-khoa | --ma-hoa <file.dump> | --giai-ma <file.enc> <file-ra>');
    process.exit(1);
  }
} catch (e) {
  console.error('[ma-hoa] LỖI:', e?.message ?? e);
  process.exit(1);
}
