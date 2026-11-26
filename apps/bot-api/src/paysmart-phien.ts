// PHIÊN PaySmart (sem.paysmart.com.vn) dùng CHUNG cho mọi việc đụng cổng này.
//
// Vì sao là module chứ không chép code sang từng script: repo đã dính bài học "bản copy ở nhiều nơi" — sửa chỗ
// này quên chỗ kia, rồi lớp đang chạy live lại là bản chưa sửa. Mọi đường vào cổng PaySmart (poll báo-có 30',
// tra cứu giao dịch POS, soi dữ liệu) đều phải đi qua đây.
//
// Hai đường vào, theo đúng thứ tự:
//   1) PHIÊN ĐÃ CẤT (Admin Demo 14/10 "kéo xong báo có phải lưu lại cookie để tái sử dụng") — cookie + localStorage
//      + tham số `mch`, mã hoá AES-GCM cùng khoá với mật khẩu, cất trong `qr_paysmart_cred.session_enc`.
//   2) ĐĂNG NHẬP MỚI — user + mật khẩu + OTP 6 số tự sinh từ secret TOTP (chính chuỗi trong mã QR Authenticator),
//      qua trình duyệt ngầm vì cổng có reCAPTCHA v3.
//
// Phiên chết TUYỆT ĐỐI không được biến thành "hôm nay không có giao dịch" — luôn tự rơi về đường 2 (R198).
import { createHmac } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { decryptSecret, encryptSecret } from '@sigma/services';

export const URL_LOGIN = 'https://sem.paysmart.com.vn/auth/login';
export const DUONG_API_DANH_SACH = '/api/management-transaction/list';
export const urlDanhSach = (mch: string): string =>
  `https://sem.paysmart.com.vn/merchant/management-transaction/list?mch=${mch}&merchantType=REFERRAL`;

/** Phiên cất quá lâu thì đừng thử nữa cho đỡ tốn 1 vòng — JWT cổng ngắn, cookie cũng không sống lâu. */
export const HAN_PHIEN_MS = 60 * 60_000;

export interface CredPaySmart {
  tid_id: number;
  username: string;
  password_enc: string;
  totp_secret_enc: string;
  session_enc?: string | null;
}

/**
 * Phiên đã cất: storageState Playwright + `mch` của phiên + MỐC THỜI GIAN cất (epoch ms).
 *
 * [14/10 — bài kiểm phản biện BẮT ĐƯỢC] Bản đầu tính tuổi phiên bằng cột `session_at` đọc qua `$queryRaw`. Dự án
 * có sẵn bẫy này: $queryRaw đọc `timestamptz` LỆCH +7h (đo thật: now() trả 20:25 trong khi UTC là 13:25) ⇒ phiên
 * cất 2 tiếng trước ra tuổi ÂM 300 phút ⇒ lọt cửa "quá hạn" và vẫn đem dùng. Nay mốc nằm NGAY TRONG gói mã hoá
 * dưới dạng SỐ epoch — không mang múi giờ nên không có gì để lệch. Cột `session_at` chỉ để người soi DB nhìn.
 */
export interface PhienDaCat {
  storage: unknown;
  mch: string;
  luc: number;
}

export type DuongVao = 'phien' | 'login' | 'phien-het-login-lai';

/** Mọi thứ cần để làm việc tiếp trên trang danh sách (kể cả phát lại request với khoảng ngày khác). */
export interface TrangDanhSach {
  page: Page;
  mch: string;
  /** JSON thô của lượt tải đầu tiên (danh sách mặc định hôm nay/hôm qua). */
  rawDauTien: string;
  /** URL + body + headers của request mà CHÍNH TRANG gửi — để phát lại với tham số khác, không tự chế API. */
  urlApi: string;
  bodyGoc: string;
  headers: Record<string, string>;
}

export function b32decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = A.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xFF); bits -= 8; } }
  return Buffer.from(out);
}

export function totp(secretB32: string, atMs = Date.now()): string {
  const key = b32decode(secretB32); const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const h = createHmac('sha1', key).update(ctr).digest(); const o = h[h.length - 1] & 0xF;
  return String((h.readUInt32BE(o) & 0x7FFFFFFF) % 1e6).padStart(6, '0');
}

/** Chờ sang cửa sổ TOTP mới khi còn < 8s (OTP sát mép 30s hay bị cổng từ chối). */
export async function choCuaSoTotpMoi(): Promise<void> {
  const rem = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (rem < 8) await new Promise((r) => setTimeout(r, (rem + 1) * 1000));
}

/** Đọc phiên đã cất; hỏng/quá hạn/mốc ở tương lai → null, kèm 1 dòng nói rõ vì sao (cấm im lặng). */
export function docPhien(cred: CredPaySmart, noi: (s: string) => void = console.log): PhienDaCat | null {
  if (!cred.session_enc) return null;
  let p: PhienDaCat;
  try {
    p = JSON.parse(decryptSecret(cred.session_enc)) as PhienDaCat;
  } catch (e) {
    noi(`[paysmart] · mã ${cred.tid_id}: phiên cũ đọc không được (${e instanceof Error ? e.message : String(e)}) — đăng nhập mới`);
    return null;
  }
  if (!p || !p.mch) { noi(`[paysmart] · mã ${cred.tid_id}: phiên cũ thiếu mch — đăng nhập mới`); return null; }
  const tuoi = typeof p.luc === 'number' && Number.isFinite(p.luc) ? Date.now() - p.luc : NaN;
  // Tuổi ÂM (mốc ở tương lai = đồng hồ lệch / dữ liệu hỏng) cũng KHÔNG hợp lệ — đúng cái đã lọt lần trước.
  if (!(tuoi >= 0 && tuoi < HAN_PHIEN_MS)) {
    noi(`[paysmart] · mã ${cred.tid_id}: phiên cũ ${Number.isFinite(tuoi) ? `${Math.round(tuoi / 60_000)} phút` : 'không rõ mốc'} — không dùng (hạn ${HAN_PHIEN_MS / 60_000} phút), đăng nhập mới`);
    return null;
  }
  return p;
}

interface DbGhi { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }

/** Cất phiên (mã hoá AES như mật khẩu — cookie là chìa khoá vào cổng ngân hàng, cấm để trần). */
export async function catPhien(db: DbGhi, tidId: number, phien: PhienDaCat, noi: (s: string) => void = console.log): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `UPDATE qr_paysmart_cred SET session_enc = $2, session_at = now() WHERE tid_id = $1`,
      tidId, encryptSecret(JSON.stringify(phien)));
  } catch (e) {
    // Không cất được thì lượt sau login lại — chỉ chậm, không sai số liệu. Nhưng phải NÓI, đừng im.
    noi(`[paysmart] · mã ${tidId}: KHÔNG cất được phiên (${e instanceof Error ? e.message : String(e)}) — lượt sau sẽ đăng nhập lại`);
  }
}

/** Bật PAYSMART_DEBUG_MANG=1 để in mọi request lên cổng — bài kiểm chứng đo "lượt này CÓ đăng nhập không" bằng
 *  việc có gọi /api/auth/authenticate hay không, thay vì tin dòng log tự khai. */
function ganGhiMang(page: Page): void {
  if (process.env['PAYSMART_DEBUG_MANG'] !== '1') return;
  page.on('request', (r) => { if (r.url().includes('/api/')) console.log(`[mang] ${r.method()} ${r.url().split('?')[0]}`); });
}

/** Gắn tai nghe bắt request + response của API danh sách. */
function batDanhSach(page: Page, hop: { raw: string; urlApi: string; bodyGoc: string; headers: Record<string, string> }): void {
  page.on('request', (req) => {
    if (req.url().includes(DUONG_API_DANH_SACH)) {
      hop.urlApi = req.url(); hop.bodyGoc = req.postData() ?? ''; hop.headers = req.headers();
    }
  });
  page.on('response', async (res) => {
    if (res.url().includes(DUONG_API_DANH_SACH)) hop.raw = await res.text().catch(() => '');
  });
}

/**
 * Mở trang danh sách giao dịch của 1 mã (ưu tiên phiên cũ, hỏng thì đăng nhập mới) rồi chạy `viec` trên đó.
 * Context chỉ đóng SAU khi `viec` xong — nhờ vậy `viec` phát lại được request với khoảng ngày khác.
 */
export async function voiTrangDanhSach<T>(
  browser: Browser,
  db: DbGhi,
  cred: CredPaySmart,
  viec: (t: TrangDanhSach) => Promise<T>,
  noi: (s: string) => void = console.log
): Promise<{ ok: true; ketQua: T; duong: DuongVao } | { ok: false; loi: string; duong: DuongVao }> {
  let pass: string, secret: string;
  try {
    pass = decryptSecret(cred.password_enc);
    secret = decryptSecret(cred.totp_secret_enc);
  } catch (e) {
    return { ok: false, duong: 'login', loi: `giải mã cred thất bại (DIGISTORE_ENC_KEY lệch?): ${e instanceof Error ? e.message : String(e)}` };
  }

  // ── Đường 1: phiên đã cất ────────────────────────────────────────────────────────────────────────────────
  const phienCu = docPhien(cred, noi);
  if (phienCu) {
    let ctx;
    try { ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, storageState: phienCu.storage as never }); }
    catch { ctx = null; }
    if (ctx) {
      const page = await ctx.newPage();
      ganGhiMang(page);
      const hop = { raw: '', urlApi: '', bodyGoc: '', headers: {} as Record<string, string> };
      batDanhSach(page, hop);
      try {
        await page.goto(urlDanhSach(phienCu.mch), { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(7000);
        if (!page.url().includes('/auth/login') && hop.raw) {
          const ketQua = await viec({ page, mch: phienCu.mch, rawDauTien: hop.raw, urlApi: hop.urlApi, bodyGoc: hop.bodyGoc, headers: hop.headers });
          return { ok: true, ketQua, duong: 'phien' };
        }
      } catch { /* rơi xuống đăng nhập mới */ }
      finally { await ctx.close().catch(() => {}); }
    }
  }

  // ── Đường 2: đăng nhập mới ───────────────────────────────────────────────────────────────────────────────
  const duong: DuongVao = phienCu ? 'phien-het-login-lai' : 'login';
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  ganGhiMang(page);
  const hop = { raw: '', urlApi: '', bodyGoc: '', headers: {} as Record<string, string> };
  batDanhSach(page, hop);
  try {
    await choCuaSoTotpMoi();
    await page.goto(URL_LOGIN, { waitUntil: 'networkidle', timeout: 60000 });
    await page.locator('input').first().fill(cred.username);
    await page.locator('input[type="password"]').first().fill(pass);
    await page.locator('input[name="twoFactorCode"]').fill(totp(secret));
    await page.locator('button[type="submit"], button:has-text("Đăng nhập")').first().click();
    // [16/9 fix "LOGIN FAIL chập chờn"] chờ THEO ĐIỀU KIỆN rời trang login (tới 25s) thay vì ngủ cứng 8s;
    // chưa rời → RETRY 1 lần với OTP cửa sổ mới (TOTP sát mép 30s hay trượt); fail thật → in message trang.
    await page.waitForURL((u) => !u.href.includes('/auth/login'), { timeout: 25_000 }).catch(() => {});
    if (page.url().includes('/auth/login')) {
      await choCuaSoTotpMoi();
      await page.locator('input[name="twoFactorCode"]').fill(totp(secret));
      await page.locator('button[type="submit"], button:has-text("Đăng nhập")').first().click();
      await page.waitForURL((u) => !u.href.includes('/auth/login'), { timeout: 25_000 }).catch(() => {});
    }
    if (page.url().includes('/auth/login')) {
      const loi = ((await page.locator('body').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 200);
      return { ok: false, duong, loi: `LOGIN FAIL (đã retry 1 lần) — trang nói: ${loi}` };
    }
    const mch = new URL(page.url()).searchParams.get('mch') ?? '';
    await page.goto(urlDanhSach(mch), { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(7000);
    await catPhien(db, cred.tid_id, { storage: await ctx.storageState(), mch, luc: Date.now() }, noi);
    const ketQua = await viec({ page, mch, rawDauTien: hop.raw, urlApi: hop.urlApi, bodyGoc: hop.bodyGoc, headers: hop.headers });
    return { ok: true, ketQua, duong };
  } catch (e) {
    return { ok: false, duong, loi: `lỗi trình duyệt: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Bóc danh sách giao dịch từ JSON thô cổng trả (lồng 2 lớp: j.data là CHUỖI JSON, bên trong mới có .data[]). */
export function bocDanhSach(raw: string): Record<string, unknown>[] {
  const inner = JSON.parse(JSON.parse(raw).data) as { data?: Record<string, unknown>[] };
  return inner.data ?? [];
}

/** Giao dịch QR (khách quét mã) — thứ DUY NHẤT được vào cache đối soát báo-có. */
export const laGdQr = (t: Record<string, unknown>): boolean =>
  String(t['allTransType'] ?? '').toUpperCase().startsWith('SCAN_TO_PAY');

/** Cổng trả `status` dạng SỐ: 3 = Thành công (đọc từ chính ô lọc "Trạng thái giao dịch": 3 Thành công · 2 Thất bại). */
export const laThanhCong = (t: Record<string, unknown>): boolean => Number(t['status']) === 3;

/**
 * Phát lại ĐÚNG request mà trang vừa gửi, chỉ đổi khoảng ngày + số dòng. Không tự chế tham số API — body là kiểu
 * DataTables (draw/columns/start/length), tự đặt tay là sai âm thầm.
 * @param tu/den định dạng dd/MM/yyyy như cổng hiển thị.
 */
export async function traTheoNgay(t: TrangDanhSach, tu: string, den: string, soDong = 500): Promise<Record<string, unknown>[]> {
  if (!t.urlApi || !t.bodyGoc) throw new Error('chưa bắt được request danh sách của trang — không phát lại được');
  const ngay = Array.from(new Set(t.bodyGoc.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []));
  if (!ngay.length) throw new Error('body request không có trường ngày dd/MM/yyyy — DỪNG, không đoán tham số');
  let body = t.bodyGoc;
  if (ngay.length >= 2) body = body.replace(ngay[0]!, tu).replace(ngay[1]!, den);
  else body = body.split(ngay[0]!).join(tu);
  body = body.replace(/"length"\s*:\s*\d+/, `"length":${soDong}`)
    .replace(/"page_size"\s*:\s*\d+/, `"page_size":${soDong}`)
    .replace(/"pageSize"\s*:\s*\d+/, `"pageSize":${soDong}`);
  const res = await t.page.request.fetch(t.urlApi, { method: 'POST', headers: t.headers, data: body });
  if (!res.ok()) throw new Error(`cổng trả HTTP ${res.status()} khi tra ${tu}–${den}`);
  return bocDanhSach(await res.text());
}
