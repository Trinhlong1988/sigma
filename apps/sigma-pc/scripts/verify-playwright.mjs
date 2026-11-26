// KIỂM CHỨNG THẬT: Playwright-electron khởi chạy SigMa PC → chụp màn Đăng nhập.
import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pcDir = path.resolve(here, '..');

const app = await electron.launch({ args: ['.'], cwd: pcDir });

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');

const logs = [];
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

// Chờ app điều hướng + render (RootRedirect → /login).
await win.waitForTimeout(4000);

const url = win.url();
const title = await win.title();
const bodyText = (await win.evaluate(() => document.body.innerText || '')).slice(0, 400);
const hasLogo = await win.evaluate(() =>
  !!document.querySelector('img[src*="alpha-logo"], img[alt*="SigMa"], img[alt*="SigMa"]')
);
const rootChildren = await win.evaluate(() => document.getElementById('root')?.childElementCount ?? -1);

await win.screenshot({ path: path.join(pcDir, '_evidence', 'sigma-pc.png') });

console.log('URL       :', url);
console.log('TITLE     :', title);
console.log('ROOT kids :', rootChildren);
console.log('HAS LOGO  :', hasLogo);
console.log('BODY[0..400]:\n' + bodyText);
if (logs.length) console.log('CONSOLE:\n' + logs.slice(0, 30).join('\n'));

await app.close();
