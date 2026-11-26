// KIỂM: thẻ Cloudflare Access CÓ THẬT SỰ được gắn khi cổng web chuyển tiếp hay không.
// Dựng 1 "API giả" ghi lại header nhận được, cho cổng web trỏ vào đó, rồi gọi qua cổng web.
// Không đụng API thật, không đụng cấu hình thật.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const GOC = resolve(import.meta.dirname, '../../..');
const CONG_API_GIA = 18791;
const CONG_WEB = 57919;
const THE_ID = 'kiemthu-id-0123456789';
const THE_SECRET = 'kiemthu-secret-0123456789abcdef';

let datHet = true;
const chot = (ok, ten) => {
  if (!ok) {
    datHet = false;
    console.log('  >>> PHÉP KIỂM ĐỎ — ' + ten);
  }
};

const nhan = [];
const apiGia = createServer((req, res) => {
  nhan.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'api-gia' }));
});
await new Promise((ok) => apiGia.listen(CONG_API_GIA, '127.0.0.1', ok));

const chayWeb = (env) =>
  spawn(process.execPath, [resolve(GOC, 'infra/web-static/serve-webapp-quanly.mjs')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

async function thu(nhanThu, env, mongCo) {
  const p = chayWeb({ QLWEB_PORT: String(CONG_WEB), QLWEB_API_TARGET: `http://127.0.0.1:${CONG_API_GIA}`, ...env });
  let log = '';
  p.stdout.on('data', (d) => (log += d.toString()));
  p.stderr.on('data', (d) => (log += d.toString()));
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CONG_WEB}/v1/health`);
      if (r.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  nhan.length = 0;
  await fetch(`http://127.0.0.1:${CONG_WEB}/v1/health`).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 200));
  const h = nhan[0]?.headers ?? {};
  const coId = typeof h['cf-access-client-id'] === 'string';
  const coSecret = typeof h['cf-access-client-secret'] === 'string';
  console.log(`  [${nhanThu}] API nhận được: cf-access-client-id=${coId ? h['cf-access-client-id'] : '(không có)'} · secret=${coSecret ? 'CÓ' : '(không có)'}`);
  chot(coId === mongCo && coSecret === mongCo, `${nhanThu} — mong ${mongCo ? 'CÓ' : 'KHÔNG CÓ'} thẻ`);
  if (mongCo) chot(h['cf-access-client-id'] === THE_ID, `${nhanThu} — gửi ĐÚNG client id`);
  p.kill();
  await new Promise((r) => setTimeout(r, 400));
  return log;
}

try {
  await thu('chưa cấu hình thẻ', {}, false);
  const log = await thu('đã cấu hình thẻ', { QLWEB_CF_ACCESS_ID: THE_ID, QLWEB_CF_ACCESS_SECRET: THE_SECRET }, true);
  const coDongBao = /thẻ Cloudflare Access: ĐÃ cấu hình/.test(log);
  console.log('  [khởi động có báo rõ đang gắn thẻ]', coDongBao);
  chot(coDongBao, 'máy chủ in rõ trạng thái thẻ lúc khởi động');
} catch (e) {
  console.error('[kiem-the-cf] LỖI:', e?.message ?? e);
  datHet = false;
} finally {
  apiGia.close();
  console.log('[kiem-the-cf] KẾT LUẬN:', datHet ? 'không phép kiểm nào đỏ' : '*** CÒN PHÉP KIỂM ĐỎ ***');
  process.exitCode = datHet ? 0 : 1;
}
