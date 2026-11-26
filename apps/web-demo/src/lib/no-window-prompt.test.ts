// [Admin Demo 9/9 "bấm sao kê tự động không hiện ra gì"] — GỐC: dùng `window.prompt` để hỏi số tài khoản. Chạy ngon trên
// WEB nhưng ELECTRON (app SigMa PC) KHÔNG hỗ trợ prompt: bấm xong IM LẶNG, không hộp thoại, không lỗi.
// GUARD: cấm `window.prompt` trong toàn bộ src — cần hỏi gì thì làm hộp thoại trong app (chạy đúng ở cả 3 nền).
// (window.confirm/alert Electron VẪN hỗ trợ nên không chặn.)
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'apps', 'web-demo', 'src');

function moiFile(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) moiFile(full, acc);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(full);
  }
  return acc;
}

describe('cấm window.prompt (Electron không hỗ trợ → bấm không ra gì)', () => {
  it('không file nào trong web-demo/src gọi window.prompt', () => {
    const pham: string[] = [];
    for (const f of moiFile(SRC)) {
      const code = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      if (/\bwindow\.prompt\s*\(/.test(code)) pham.push(f.slice(SRC.length + 1));
    }
    expect(pham, `window.prompt KHÔNG chạy trên app Electron — dùng hộp thoại trong app. Vi phạm:\n${pham.join('\n')}`).toEqual([]);
  });
});
