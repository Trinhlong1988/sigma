// Script chụp ảnh demo (spec mục 6) — mở từng route ở 3 viewport (iPhone 390x844, Android 412x915,
// Desktop 1440x900), chụp full-page, lưu PNG vào screenshots/{iphone,android,desktop}/<ten-man-hinh>.png.
// Tự khởi động Vite dev server (không cần `npm run dev` chạy sẵn ở terminal khác) rồi tắt khi xong.
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots');

interface ViewportSpec {
  key: 'iphone' | 'android' | 'desktop';
  width: number;
  height: number;
}

const VIEWPORTS: ViewportSpec[] = [
  { key: 'iphone', width: 390, height: 844 },
  { key: 'android', width: 412, height: 915 },
  { key: 'desktop', width: 1440, height: 900 }
];

// route path + tên file — khớp danh sách màn hình dựng ở src/screens (spec mục 4).
const CAPTURES: Array<{ route: string; file: string }> = [
  { route: '/design-gallery', file: 'gallery' },
  { route: '/login', file: 'dang-nhap' },
  { route: '/otp', file: 'nhap-otp' },
  { route: '/app/chat', file: 'danh-sach-chat' },
  { route: '/app/chat/room-hong', file: 'cua-so-chat' },
  { route: '/app/sell-tid', file: 'ban-tid' },
  { route: '/app/lo', file: 'lich-su-lo' },
  { route: '/app/lo/lo1', file: 'chi-tiet-doi-soat' },
  { route: '/app/fraud', file: 'canh-bao-gian-lan' },
  { route: '/app/qr', file: 'hien-thi-qr' },
  { route: '/app/kpi', file: 'bao-cao-kpi' },
  { route: '/app/contacts', file: 'danh-ba' },
  { route: '/app/settings', file: 'cai-dat' },
  // Đợt bổ sung 23/7 (mục 21-30):
  { route: '/app/chat?cat=cat-congviec', file: 'danh-sach-chat-loc-phan-loai' }, // chip lọc "Công việc" active
  { route: '/app/chat?manage=1', file: 'quan-ly-phan-loai' }, // modal quản lý phân loại mở
  { route: '/app/chat/room-nhom-doi-soat', file: 'cua-so-chat-nhom-file' }, // FileMessageCard (mục 30)
  { route: '/app/my-qr', file: 'ma-qr-cua-toi' }, // QR cá nhân (mục 24)
  { route: '/app/my-qr?scan=1', file: 'quet-qr' }, // modal quét QR mở
  { route: '/app/security', file: 'tai-khoan-bao-mat' }, // đổi mật khẩu + thiết bị (mục 25)
  { route: '/app/call/voice', file: 'goi-thoai' }, // gọi thoại 1-1 (mục 28)
  { route: '/app/call/video', file: 'goi-video-nhom' }, // gọi video nhóm (mục 28)
  // Đợt bổ sung 2 (mục 31-40):
  { route: '/app/chat?q=a', file: 'tim-kiem-toan-cuc' }, // panel tìm kiếm 3 nhóm (mục 33)
  { route: '/app/chat?notif=1', file: 'thong-bao-toast' }, // banner thông báo góc phải (mục 35)
  { route: '/app/call/incoming', file: 'cuoc-goi-den' }, // màn cuộc gọi đến (mục 36)
  { route: '/app/chat/room-hong?callpill=1', file: 'bong-bong-goi-noi' }, // bong bóng gọi nổi (mục 36)
  { route: '/preview/lockscreen', file: 'man-khoa-push' }, // push màn khóa (mục 35)
  { route: '/app/chat/room-hong?emoji=1', file: 'emoji-sticker' }, // panel emoji/sticker (mục 38)
  { route: '/app/profile', file: 'ho-so-ca-nhan' }, // hồ sơ + đổi avatar (mục 39)
  { route: '/app/diary', file: 'nhat-ky' } // nhật ký (mục 40)
];

// Capture cần init localStorage TRƯỚC khi trang load (mục 22 — Settings với cỡ chữ "Lớn" đang chọn).
const SPECIAL_CAPTURES: Array<{ route: string; file: string; initScript: string }> = [
  {
    route: '/app/settings',
    file: 'cai-dat-co-chu-lon',
    initScript: `window.localStorage.setItem('sigma-demo-fontsize', 'lon');`
  }
];

async function main(): Promise<void> {
  for (const v of VIEWPORTS) {
    await mkdir(path.join(OUT_DIR, v.key), { recursive: true });
  }

  const server: ViteDevServer = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { port: 0 }
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  const baseUrl = `http://localhost:${port}`;
  console.log(`[capture-frames] Vite dev server lên ở ${baseUrl}`);

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      for (const cap of CAPTURES) {
        const url = baseUrl + cap.route;
        await page.goto(url, { waitUntil: 'networkidle' });
        // theme mặc định sáng; đợi 1 nhịp cho animation/font load ổn định trước khi chụp.
        await page.waitForTimeout(200);
        const outFile = path.join(OUT_DIR, viewport.key, `${cap.file}.png`);
        await page.screenshot({ path: outFile, fullPage: true });
        console.log(`[capture-frames] ${viewport.key}/${cap.file}.png <- ${cap.route}`);
      }
      // Capture đặc biệt: cần addInitScript (localStorage) trước khi load → dùng page riêng.
      for (const cap of SPECIAL_CAPTURES) {
        const specialPage = await context.newPage();
        await specialPage.addInitScript(cap.initScript);
        await specialPage.goto(baseUrl + cap.route, { waitUntil: 'networkidle' });
        await specialPage.waitForTimeout(200);
        const outFile = path.join(OUT_DIR, viewport.key, `${cap.file}.png`);
        await specialPage.screenshot({ path: outFile, fullPage: true });
        console.log(`[capture-frames] ${viewport.key}/${cap.file}.png <- ${cap.route} (init)`);
        await specialPage.close();
      }
      await context.close();
    }
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log('[capture-frames] Xong.');
}

main().catch((err) => {
  console.error('[capture-frames] LỖI:', err);
  process.exitCode = 1;
});
