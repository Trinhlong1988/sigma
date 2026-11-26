// ĐỌC MÃ QR 2FA (ảnh Authenticator) → lấy chuỗi secret để nạp cho mã QR PaySmart mới. [Admin Demo 14/10]
//
// Vì sao cần: tài khoản PaySmart bắt buộc "Mã xác thực" 6 số. Máy tự sinh 6 số đó từ SECRET nằm trong mã QR mà
// app Authenticator quét lúc thiết lập 2FA (DEMOMAY đang chạy đúng kiểu này: secret 32 ký tự base32 trong DB).
// Nên chỉ cần ẢNH CHỤP mã QR là đủ, không cần chép tay chuỗi.
//
//   npx tsx scripts/doc-qr-2fa.mts <đường-dẫn-ảnh-QR.png>
//   npx tsx scripts/doc-qr-2fa.mts --tu-kiem        # tự kiểm: sinh QR từ secret DEMOMAY rồi đọc lại, phải khớp
//
// In ra: secret + mã 6 số sinh ra lúc này (đối chiếu với app trên điện thoại là biết đúng/sai NGAY, không phải
// đợi tới lượt poll mới phát hiện). KHÔNG ghi gì vào DB — nạp DB là việc của scripts/them-ma-paysmart.mts.
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import { decryptSecret } from '@sigma/services';
import { getBotDb } from '../src/db.js';

function b32decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = A.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xFF); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secretB32: string, atMs = Date.now()): string {
  const key = b32decode(secretB32); const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const h = createHmac('sha1', key).update(ctr).digest(); const o = h[h.length - 1] & 0xF;
  return String((h.readUInt32BE(o) & 0x7FFFFFFF) % 1e6).padStart(6, '0');
}

/**
 * Giải mã QR trong file ảnh (PNG hoặc JPG — ảnh chụp màn hình điện thoại hay là .jpg) → chuỗi bên trong.
 * JPG đi qua sharp để ra RGBA thô. Ảnh chụp màn hình thường rất to/nhiều nhiễu nén ⇒ thử THÊM vài cách:
 * ảnh gốc → phóng to 2× → tăng tương phản xám. Không đọc được mới chịu thua (R198: nói rõ đã thử mấy cách).
 */
async function docQrTuAnh(duongDan: string): Promise<string | null> {
  const thu = (data: Buffer | Uint8Array, w: number, h: number): string | null =>
    jsQR(new Uint8ClampedArray(data.buffer ? (data as Buffer) : data), w, h)?.data ?? null;
  if (/\.png$/i.test(duongDan)) {
    const png = PNG.sync.read(await readFile(duongDan));
    const r = thu(png.data, png.width, png.height);
    if (r) return r;
  }
  const sharp = (await import('sharp')).default;
  const cach: Array<[string, () => Promise<{ data: Buffer; info: { width: number; height: number } }>]> = [
    ['gốc', () => sharp(duongDan).ensureAlpha().raw().toBuffer({ resolveWithObject: true })],
    ['phóng 2×', () => sharp(duongDan).metadata().then((m) => sharp(duongDan).resize({ width: (m.width ?? 800) * 2, kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }))],
    ['xám + tương phản', () => sharp(duongDan).greyscale().normalise().threshold(128).ensureAlpha().raw().toBuffer({ resolveWithObject: true })]
  ];
  for (const [ten, lam] of cach) {
    try {
      const { data, info } = await lam();
      const r = thu(data, info.width, info.height);
      if (r) { console.log(`  (đọc được QR bằng cách: ${ten})`); return r; }
    } catch (e) { console.log(`  (cách "${ten}" lỗi: ${e instanceof Error ? e.message : String(e)})`); }
  }
  return null;
}

/** Rút secret từ chuỗi QR: hoặc URI otpauth://totp/...?secret=XXX, hoặc chính chuỗi base32 trần. */
function rutSecret(noiDung: string): { secret: string | null; nhan?: string; loi?: string } {
  const s = noiDung.trim();
  if (s.toLowerCase().startsWith('otpauth://')) {
    try {
      const u = new URL(s);
      const sec = (u.searchParams.get('secret') ?? '').toUpperCase().replace(/\s+/g, '');
      if (!sec) return { secret: null, loi: 'URI otpauth KHÔNG có tham số secret' };
      return { secret: sec, nhan: decodeURIComponent(u.pathname.replace(/^\/+/, '')) };
    } catch (e) {
      return { secret: null, loi: `URI otpauth hỏng: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const tran = s.toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z2-7]{16,}=*$/.test(tran)) return { secret: tran };
  return { secret: null, loi: `nội dung QR không phải otpauth cũng không phải chuỗi base32: "${s.slice(0, 60)}"` };
}


/** Mã hoá base32 (secret trong QR "chuyển tài khoản" của Google Authenticator là BYTES, phải đổi ra base32). */
function b32encode(buf: Buffer): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}

interface MucMigration { ten: string; phatHanh: string; secret: string }

/**
 * Đọc QR "Chuyển tài khoản → Xuất" của Google Authenticator: otpauth-migration://offline?data=<base64 protobuf>.
 * Tự giải protobuf (không kéo thêm thư viện): message OtpParameters lặp ở field 1 của payload;
 * bên trong: 1=secret(bytes) · 2=name(string) · 3=issuer(string).
 * CẢNH BÁO: QR này chứa secret của MỌI tài khoản trong app — chỉ in tên, secret chỉ in cho mục được chọn.
 */
function docMigration(uri: string): MucMigration[] {
  const data = new URL(uri).searchParams.get('data') ?? '';
  const buf = Buffer.from(decodeURIComponent(data), 'base64');
  const docVarint = (b: Buffer, i: number): [number, number] => {
    let kq = 0, ca = 0, n = i;
    for (;;) { const byte = b[n++]!; kq |= (byte & 0x7f) << ca; if ((byte & 0x80) === 0) break; ca += 7; }
    return [kq, n];
  };
  const docMuc = (b: Buffer): MucMigration => {
    let i = 0; const m: MucMigration = { ten: '', phatHanh: '', secret: '' };
    while (i < b.length) {
      const [tag, i1] = docVarint(b, i); const field = tag >> 3, kieu = tag & 7;
      if (kieu === 2) {
        const [len, i2] = docVarint(b, i1); const noi = b.subarray(i2, i2 + len); i = i2 + len;
        if (field === 1) m.secret = b32encode(noi);
        else if (field === 2) m.ten = noi.toString('utf8');
        else if (field === 3) m.phatHanh = noi.toString('utf8');
      } else if (kieu === 0) { const [, i2] = docVarint(b, i1); i = i2; }
      else break;
    }
    return m;
  };
  const ds: MucMigration[] = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, i1] = docVarint(buf, i); const field = tag >> 3, kieu = tag & 7;
    if (kieu === 2) {
      const [len, i2] = docVarint(buf, i1); const noi = buf.subarray(i2, i2 + len); i = i2 + len;
      if (field === 1) ds.push(docMuc(noi));
    } else if (kieu === 0) { const [, i2] = docVarint(buf, i1); i = i2; }
    else break;
  }
  return ds;
}

async function tuKiem(): Promise<void> {
  // Tự kiểm ĐƯỜNG ĐỌC bằng secret CÓ THẬT (DEMOMAY): sinh QR y như app 2FA → đọc lại → phải ra đúng secret cũ và
  // sinh ra cùng 6 số. Không đạt thì đừng tin bước đọc ảnh của Admin Demo gửi (R198: check phải CHẠY, không chỉ "không lỗi").
  const db = getBotDb();
  const r = await db.$queryRawUnsafe<Array<{ totp_secret_enc: string }>>(
    `SELECT totp_secret_enc FROM qr_paysmart_cred WHERE tid_id = 187`);
  if (!r[0]) { console.error('❌ không có cred mã 187 để tự kiểm'); process.exit(1); }
  const goc = decryptSecret(r[0].totp_secret_enc);
  const uri = `otpauth://totp/SmartPay:DEMO-MERCHANT-01?secret=${goc}&issuer=SmartPay`;
  const tam = '<REPO>/apps/bot-api/_anh-paysmart/_tu-kiem-qr.png';
  await QRCode.toFile(tam, uri, { width: 420, margin: 2 });
  const doc = await docQrTuAnh(tam);
  if (!doc) { console.error('❌ TỰ KIỂM HỎNG: không đọc được QR vừa sinh'); process.exit(1); }
  const { secret } = rutSecret(doc);
  const khop = secret === goc && secret != null && totp(secret) === totp(goc);
  console.log(`tự kiểm: sinh QR → đọc lại → secret ${khop ? 'KHỚP' : 'LỆCH'} · độ dài ${secret?.length ?? 0} · mã 6 số ${secret ? totp(secret) : '—'}`);
  // Tự kiểm NHÁNH 2: QR "chuyển tài khoản" của Authenticator (otpauth-migration). Dựng gói protobuf y khuôn
  // Google rồi đọc lại — không kiểm thì nhánh này tới lúc Admin Demo gửi ảnh thật mới biết hỏng (R198).
  const varint = (n: number): Buffer => { const b: number[] = []; let x = n; do { let c = x & 0x7f; x >>>= 7; if (x) c |= 0x80; b.push(c); } while (x); return Buffer.from(b); };
  const field = (soHieu: number, noi: Buffer): Buffer => Buffer.concat([varint((soHieu << 3) | 2), varint(noi.length), noi]);
  const muc = Buffer.concat([
    field(1, b32decode(goc)),
    field(2, Buffer.from('DEMO-MERCHANT-01', 'utf8')),
    field(3, Buffer.from('SmartPay', 'utf8'))
  ]);
  const goiMig = Buffer.concat([field(1, muc)]);
  const uriMig = `otpauth-migration://offline?data=${encodeURIComponent(goiMig.toString('base64'))}`;
  const tamMig = '<REPO>/apps/bot-api/_anh-paysmart/_tu-kiem-qr-migration.png';
  await QRCode.toFile(tamMig, uriMig, { width: 480, margin: 2 });
  const docMig = await docQrTuAnh(tamMig);
  const dsMig = docMig && docMig.toLowerCase().startsWith('otpauth-migration://') ? docMigration(docMig) : [];
  const khopMig = dsMig.length === 1 && dsMig[0]!.secret === goc && dsMig[0]!.ten === 'DEMO-MERCHANT-01';
  console.log(`tự kiểm 2 (QR "chuyển tài khoản"): đọc ra ${dsMig.length} tài khoản · secret ${khopMig ? 'KHỚP' : 'LỆCH'}${dsMig[0] ? ` · nhãn "${dsMig[0].phatHanh} / ${dsMig[0].ten}"` : ''}`);

  // XOÁ ngay 2 ảnh QR vừa sinh: chúng chứa SECRET THẬT của DEMOMAY dưới dạng ảnh — ai cầm được ảnh là quét vào
  // Authenticator sinh mã 6 số như thường (R: không để credential nằm trần trên đĩa).
  const { unlink } = await import('node:fs/promises');
  for (const f of [tam, tamMig]) await unlink(f).catch(() => {});

  const dat = khop && khopMig;
  console.log(dat ? '✅ CẢ 2 kiểu QR đều đọc được — gửi ảnh QR (thiết lập 2FA hoặc "chuyển tài khoản") là lấy được secret ngay' : '❌ có nhánh đọc QR KHÔNG đạt');
  process.exit(dat ? 0 : 1);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || arg === '--tu-kiem') { await tuKiem(); return; }
  const noiDung = await docQrTuAnh(arg);
  if (!noiDung) { console.error(`❌ không tìm thấy mã QR trong ảnh ${arg} (ảnh mờ/cắt thiếu góc?)`); process.exit(1); }
  if (noiDung.toLowerCase().startsWith('otpauth-migration://')) {
    const ds = docMigration(noiDung);
    console.log(`✓ đọc được QR "chuyển tài khoản" của Authenticator — ${ds.length} tài khoản bên trong:`);
    const loc = (process.argv[3] ?? '').trim().toLowerCase();
    ds.forEach((m, i) => {
      const nhanDay = `${m.phatHanh ? m.phatHanh + ' / ' : ''}${m.ten}`;
      const chon = loc ? nhanDay.toLowerCase().includes(loc) : ds.length === 1;
      console.log(`  [${i + 1}] ${nhanDay}${chon ? `
      secret: ${m.secret} (${m.secret.length} ký tự) · mã 6 số lúc này: ${totp(m.secret)}` : ''}`);
    });
    if (!loc && ds.length > 1) console.log('→ chạy lại kèm từ khoá tên tài khoản để in secret, vd: npx tsx scripts/doc-qr-2fa.mts anh.png DEMO-MERCHANT-02');
    process.exit(0);
  }
  const { secret, nhan, loi } = rutSecret(noiDung);
  if (!secret) { console.error('❌', loi); process.exit(1); }
  console.log(`✓ đọc được QR${nhan ? ` · nhãn: ${nhan}` : ''}`);
  console.log(`  secret: ${secret}  (${secret.length} ký tự)`);
  console.log(`  mã 6 số LÚC NÀY: ${totp(secret)} — mở app Authenticator so, TRÙNG là đúng secret.`);
  process.exit(0);
}
void main();
