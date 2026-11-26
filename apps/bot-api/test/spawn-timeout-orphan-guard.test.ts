// [KHOÁ CHỐNG TÁI DIỄN 12/9 — Admin Demo "chống tái diễn chặt chẽ"] Lớp bug ORPHAN Windows: child_process với option
// `timeout:` chỉ giết wrapper (cmd/npx), CÂY CON (tsx→node→chromium) SỐNG SÓT thành ma (agent-3 tái hiện thật
// 11/9: con PID 34932 + cháu 14204 sống sau timeout; tiền lệ claude-orphan 3/9). LUẬT: trong src/ CẤM truyền
// `timeout:` cho execFile/spawn/exec — phải tự quản setTimeout + killChildTree (digistore-refresh-gate.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|mts|mjs|js)$/.test(e)) yield p;
  }
}

describe('khoá orphan: cấm child_process + option timeout trong src/', () => {
  it('mọi execFile/spawn/exec KHÔNG được truyền timeout: (tự quản killChildTree thay thế)', () => {
    const viPham: string[] = [];
    for (const f of walk(SRC)) {
      const s = readFileSync(f, 'utf8');
      // Bắt call child_process có object options chứa timeout: trong cùng biểu thức (heuristic đủ chặt cho repo).
      const re = /\b(execFile|spawn|exec)\s*\(([^;]{0,400}?)\btimeout\s*:/gs;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) != null) {
        // setTimeout/clearTimeout không phải option; chỉ tính khi trong cùng lời gọi (heuristic: không có ');' giữa)
        if (!/\)\s*;/.test(m[2])) viPham.push(`${f.replace(SRC, 'src')} :: ${m[1]}(...timeout:...)`);
      }
    }
    expect(viPham, `child_process + timeout: = ORPHAN cây con trên Windows — dùng khuôn killChildTree (digistore-refresh-gate.ts). Vi phạm:\n${viPham.join('\n')}`).toEqual([]);
  });
});
