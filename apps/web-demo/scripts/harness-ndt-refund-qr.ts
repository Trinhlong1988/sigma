// HARNESS R200 (Admin Demo 22/9 "nút tạo yêu cầu tiền hoàn theo giá mua để nhà NĐT hoàn") — màn Báo cáo QR THẬT:
// tick nhiều bill → bấm "💰 YC NĐT hoàn" → modal BẢNG TÍNH theo GIÁ MUA (sauPhiMua) + QR TK SIGMA (ACB 42227).
// Kiểm: tổng = Σ sauPhiMua tròn xuống nghìn · bill thiếu giá mua bị LOẠI + cảnh báo · ảnh render đủ QR.
// Chạy: node --import tsx scripts/harness-ndt-refund-qr.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'ndt-refund-qr');
// 3 bill có giá mua 0.85% (sauPhiMua = amount×0.9915) + 1 bill THIẾU giá mua (null → phải bị loại + cảnh báo)
const mk = (stt: number, iso: string, amount: number, payer: string, sauPhiMua: number | null): Record<string, unknown> => ({
  stt, dateIso: iso, hkdName: 'HKD DEMOMAY', amount, payerName: payer, billId: 'B' + stt,
  sauPhiBan: Math.round(amount * 0.988), sauPhiMua, loiNhuanAlpha: null, dealerName: 'Đại lý C',
  reconcileStatus: 'MATCHED', nguon: 'SMARTPAY', manualDs: true, manualDealer: null, maChuName: 'Đại lý C', sourceTidId: 1, feeType: 'cho', coPhiNhanh: false
});
// [23/9] SỐ DÒNG lấy từ env SO_DONG (mặc định 4) — Admin Demo báo "chèn 5 mã bị mất mã QR" → tái hiện đúng ca nhiều dòng.
const SO_DONG = Number(process.env.SO_DONG ?? 4);
const TEN = ['NGUYEN VAN A', 'TRAN THI B', 'LE VAN C', 'KHACH HANG 46', 'KHACH HANG 13', 'KHACH HANG 47', 'KHACH HANG 41', 'KHACH HANG 45'];
const ROWS = Array.from({ length: SO_DONG }, (_, i) =>
  mk(i + 1, `2026-09-21T0${1 + (i % 8)}:${String(10 + i).padStart(2, '0')}:00Z`, 6_000_000 + i * 1_111_000, TEN[i % TEN.length]!,
    i === SO_DONG - 1 ? null : Math.round((6_000_000 + i * 1_111_000) * 0.9915)) // dòng cuối THIẾU giá mua
);
// Σ sauPhiMua (3 bill có giá) = 19.608.895 → tròn xuống nghìn 19.608.000
const KY_VONG_TIEN = Math.floor((ROWS.filter((r) => r['sauPhiMua'] != null).reduce((s, r) => s + (r['sauPhiMua'] as number), 0)) / 1000) * 1000;
const REPORT = {
  rows: ROWS,
  totals: { amount: ROWS.reduce((s, r) => s + (r['amount'] as number), 0), loiNhuanAlpha: 0, count: SO_DONG, countUnreconciled: 0, sauPhiBan: 0, sauPhiMua: 0 },
  byDay: [{ day: '2026-09-21', doanhSo: 24_787_000, count: SO_DONG, countUnreconciled: 0, loiNhuan: 0 }],
  limitWarnings: []
};
const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1875, height: 1020 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    await page.routeWebSocket(/^ws/, () => { /* */ });
    let goiNdtQr = 0; let amountNhan: string | null = null; let infoNhan: string | null = null;
    let goiTaoYcht = 0; let billIdsGui: string[] = [];
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/digistore/baoco-report')) return json(route, REPORT);
      if (p.endsWith('/v1/digistore/dealer-names')) return json(route, { ok: true, dealers: ['Đại lý C'] });
      if (p.endsWith('/v1/digistore/ndt-qr-account')) return json(route, { ok: true, account: { bankCode: 'ACB', accountNo: '42227', accountName: 'NGUYEN VAN A' } });
      if (p.endsWith('/v1/ndt-refund-request') && route.request().method() === 'POST') {
        const b = route.request().postDataJSON() as { billIds: string[]; amount: number };
        goiTaoYcht++; billIdsGui = b.billIds;
        // [23/9] YCHT_TRUNG=1 → tái hiện ĐÚNG ca Admin Demo gặp: vài GD đã nằm YCHT cũ → server 409.
        if (process.env.YCHT_TRUNG === '1') {
          // [23/9 CHỐT Admin Demo] trùng VẪN TẠO + VẪN CÓ QR, server chỉ trả kèm danh sách GD nằm YCHT cũ để cảnh báo.
          return json(route, { ok: true, ycht: { id: 9, code: 'YCHT008', amount: b.amount, billIds: b.billIds,
            bankCode: 'ACB', accountNo: '42227', accountName: 'NGUYEN VAN A', status: 'MOI', createdAtIso: new Date().toISOString(),
            trungYchtCu: b.billIds.slice(0, 2).map((x) => ({ billId: x, code: 'YCHT001' })) } });
        }
        return json(route, { ok: true, ycht: { id: 1, code: 'YCHT007', amount: b.amount, billIds: b.billIds, bankCode: 'ACB', accountNo: '42227', accountName: 'NGUYEN VAN A', status: 'MOI', createdAtIso: new Date().toISOString() } });
      }
      if (p.includes('/v1/digistore/ndt-vietqr-png')) {
        goiNdtQr++;
        amountNhan = new URL(route.request().url()).searchParams.get('amount');
        infoNhan = new URL(route.request().url()).searchParams.get('info');
        const png = await readFile(path.join(ROOT, 'qa-screenshots', 'vietqr-sample.png'));
        return route.fulfill({ status: 200, contentType: 'image/png', body: png });
      }
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/baoco-report`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // tick CẢ 4 dòng (gồm 1 dòng thiếu giá mua → kỳ vọng cảnh báo loại)
    const ticks = page.locator('[data-testid="baoco-tick-row"]');
    console.log('SỐ DÒNG:', await ticks.count());
    for (let i = 0; i < SO_DONG; i++) await ticks.nth(i).click();
    await page.waitForTimeout(300);
    const nut = page.locator('[data-testid="btn-yc-ndt-hoan"]');
    console.log('NÚT "YC NĐT hoàn" hiện:', await nut.count());
    await nut.click();
    const modal = page.locator('[data-testid="ndt-rpt-modal"]');
    await modal.waitFor({ timeout: 10000 });
    await page.waitForTimeout(2500); // chờ canvas render xong (QR load + vẽ)
    console.log('GỌI ndt-vietqr-png:', goiNdtQr, 'lần · amount =', amountNhan, '(kỳ vọng', KY_VONG_TIEN + ')');
    console.log(amountNhan === String(KY_VONG_TIEN) ? '✓ TIỀN ĐÚNG = Σ sauPhiMua (3 bill có giá) tròn xuống nghìn' : '✗ TIỀN SAI');
    const canhBao = await modal.locator('.text-amber-800').textContent().catch(() => null);
    console.log('CẢNH BÁO thiếu giá mua:', JSON.stringify(canhBao));
    console.log(`TẠO YCHT: gọi ${goiTaoYcht} lần · gửi ${billIdsGui.length} billIds (mong ${SO_DONG - 1} — bill thiếu giá mua bị loại) ${billIdsGui.length === SO_DONG - 1 && goiTaoYcht === 1 ? '✓' : '✗'}`);
    console.log(`NỘI DUNG CK trên QR = "${infoNhan}" (mong YCHT007) ${infoNhan === 'YCHT007' ? '✓' : '✗'}`);
    const tieuDe = await modal.locator('img').getAttribute('alt').catch(() => '(không có ảnh — ca lỗi)');
    // tên file tải về: chặn download để đọc suggestedFilename
    const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await modal.getByRole('button', { name: /Tải ảnh yêu cầu/ }).click().catch(() => { /* ca trùng: nút bị ẩn — đúng ý */ });
    const d = await dl;
    console.log(`TÊN FILE tải về: ${d ? d.suggestedFilename() : '(không bắt được)'} (mong YCHT007.png) ${d && d.suggestedFilename() === 'YCHT007.png' ? '✓' : '✗'}`);
    await modal.screenshot({ path: path.join(OUT, `ndt-modal-${SO_DONG}.png`) });
    // [23/9] LƯU ĐÚNG ẢNH TẢI VỀ (canvas full) để LEAD nhìn như file Admin Demo nhận được — screenshot modal bị cắt.
    const src = await modal.locator('img').getAttribute('src');
    if (src?.startsWith('data:image/png;base64,')) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(OUT, `anh-tai-ve-${SO_DONG}.png`), Buffer.from(src.split(',')[1]!, 'base64'));
      console.log('ẢNH TẢI VỀ →', path.join(OUT, `anh-tai-ve-${SO_DONG}.png`));
    }
    console.log('alt ảnh:', tieuDe, '· Ảnh →', OUT);
    if (process.env.YCHT_TRUNG === '1') {
      const coAnh = await modal.locator('img').count();
      const nutTai = await modal.getByRole('button', { name: /Tải ảnh yêu cầu/ }).count();
      const canhBaoTxt = await modal.locator('.text-amber-800').textContent().catch(() => '');
      const coQr = (await modal.locator('img').getAttribute('src'))?.startsWith('data:image/png') ?? false;
      console.log(`CA TRÙNG → ảnh=${coAnh} (mong 1) · nút Tải ảnh=${nutTai} (mong 1) · cảnh báo có nhắc YCHT001=${canhBaoTxt?.includes('YCHT001')} · ảnh dựng được=${coQr}`);
      console.log(coAnh === 1 && nutTai === 1 && !!canhBaoTxt?.includes('YCHT001') ? '✓ TRÙNG VẪN TẠO + VẪN CÓ QR, có cảnh báo' : '✗ SAI');
      await modal.screenshot({ path: path.join(OUT, 'ca-trung.png') });
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
