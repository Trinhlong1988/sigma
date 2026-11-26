// GUARD: mọi đường dẫn SCRIPT mà code production gọi (execFile/spawn/exec) PHẢI tồn tại trên đĩa.
//
// Ca thật 18/9 — Admin Demo báo "PaySmart (DEMOMAY) KHÔNG kéo được … ERR_MODULE_NOT_FOUND _paysmart-poll.mts, báo có
// QR DEMOMAY đang THIẾU dữ liệu mới": đợt dọn rác quét tiền tố `_*` (quy ước script debug tạm) đã xoá nhầm
// `apps/bot-api/_paysmart-poll.mts` — script SỐNG, được `routes/digistore.ts` gọi để kéo báo-có PaySmart. Không
// test nào đỏ, không typecheck nào phát hiện: đường dẫn nằm trong CHUỖI, chỉ vỡ lúc chạy thật, và vỡ CÂM ở tầng
// người dùng (báo-có thiếu dữ liệu chứ không có màn hình lỗi nào).
//
// Đây là lớp bug "tool built ≠ wired": code trỏ tới một file mà không gì bảo đảm file đó còn sống. Test này đọc
// SOURCE, rút mọi chuỗi đường dẫn script trong lời gọi tiến trình con, rồi khẳng định từng file có thật.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const BOT_API = path.resolve(__dirname, '..');
const SRC = path.join(BOT_API, 'src');

/** Mọi file .ts trong src (đệ quy). */
function moiFileTs(thuMuc: string): string[] {
  const ra: string[] = [];
  for (const m of readdirSync(thuMuc, { withFileTypes: true })) {
    const p = path.join(thuMuc, m.name);
    if (m.isDirectory()) ra.push(...moiFileTs(p));
    else if (m.name.endsWith('.ts')) ra.push(p);
  }
  return ra;
}

/** Rút các chuỗi '....mts' | '....mjs' nằm trong lời gọi execFile/spawn/exec/execSync. */
function duongDanScriptDuocGoi(noiDung: string): string[] {
  const ra: string[] = [];
  // bắt cả dạng execFile('npx', ['tsx', 'scripts/x.mts'], …) lẫn spawn('node', ['scripts/x.mjs'])
  const goi = /\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\s*\(([\s\S]{0,400}?)\)/g;
  for (const m of noiDung.matchAll(goi)) {
    for (const s of m[1].matchAll(/['"`]([^'"`]+\.(?:mts|mjs|cjs|js|py))['"`]/g)) {
      const duong = s[1];
      if (duong.startsWith('http') || duong.includes('*')) continue;
      ra.push(duong);
    }
  }
  return ra;
}

describe('guard: script mà code production gọi phải TỒN TẠI', () => {
  const files = moiFileTs(SRC);

  it('quét được source (chống test rỗng tự khen xanh)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('mọi đường dẫn script trong execFile/spawn đều có file thật', () => {
    const thieu: string[] = [];
    let soDuongDan = 0;
    for (const f of files) {
      const noiDung = readFileSync(f, 'utf8');
      for (const duong of duongDanScriptDuocGoi(noiDung)) {
        soDuongDan++;
        // cwd của các lời gọi này là gốc app (botApiRoot) — kiểm cả gốc app lẫn gốc repo cho chắc.
        const ungVien = [path.join(BOT_API, duong), path.resolve(BOT_API, '..', '..', duong)];
        if (!ungVien.some((p) => existsSync(p) && statSync(p).isFile())) {
          thieu.push(`${path.relative(BOT_API, f)} → "${duong}" KHÔNG TỒN TẠI`);
        }
      }
    }
    // Phải thực sự tìm thấy đường dẫn nào đó, nếu không regex đã chết mà test vẫn xanh (R198 — check phải CHẠY).
    expect(soDuongDan, 'không rút được đường dẫn script nào — regex hỏng, test đang tự khen xanh').toBeGreaterThan(0);
    expect(thieu, `Script bị gọi nhưng KHÔNG CÒN trên đĩa:\n${thieu.join('\n')}`).toEqual([]);
  });

  // [MỞ RỘNG ngay trong ngày] Guard bản đầu CHỈ kiểm file có tồn tại — nên khi chuyển
  // `_paysmart-poll.mts` vào `scripts/`, các import tương đối bên trong (`./src/db.js`) thành
  // `scripts/src/db.js` = SAI, script vẫn "tồn tại" nên guard vẫn xanh, mà chạy là ERR_MODULE_NOT_FOUND.
  // File có mặt ≠ file chạy được. Nay kiểm luôn: mọi import tương đối TRONG script phải resolve được.
  it('import tương đối bên trong script phải resolve được (chống di chuyển file làm gãy đường dẫn)', () => {
    const hong: string[] = [];
    let soImport = 0;
    for (const f of files) {
      for (const duong of duongDanScriptDuocGoi(readFileSync(f, 'utf8'))) {
        const scriptPath = [path.join(BOT_API, duong), path.resolve(BOT_API, '..', '..', duong)].find((p) => existsSync(p));
        if (!scriptPath) continue; // đã có test riêng bắt ca thiếu file
        const noiDung = readFileSync(scriptPath, 'utf8');
        const thuMuc = path.dirname(scriptPath);
        for (const m of noiDung.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
          soImport++;
          const raw = m[1];
          // .js trong nguồn TS/MTS = .ts/.mts trên đĩa (quy ước ESM của dự án).
          const ungVien = [raw, raw.replace(/\.js$/, '.ts'), raw.replace(/\.js$/, '.mts'), `${raw}.ts`, `${raw}.mts`, `${raw}/index.ts`];
          if (!ungVien.some((u) => existsSync(path.resolve(thuMuc, u)))) {
            hong.push(`${duong} → import "${raw}" KHÔNG resolve được (từ ${path.relative(BOT_API, thuMuc)})`);
          }
        }
      }
    }
    expect(soImport, 'không đọc được import nào trong script — regex hỏng, test tự khen xanh').toBeGreaterThan(0);
    expect(hong, `Script bị gãy import (chạy sẽ ERR_MODULE_NOT_FOUND):\n${hong.join('\n')}`).toEqual([]);
  });

  it('script sống KHÔNG được đặt tiền tố "_" (trùng quy ước script debug tạm → bị dọn nhầm)', () => {
    const pham: string[] = [];
    for (const f of files) {
      for (const duong of duongDanScriptDuocGoi(readFileSync(f, 'utf8'))) {
        if (path.basename(duong).startsWith('_')) pham.push(`${path.relative(BOT_API, f)} → "${duong}"`);
      }
    }
    expect(pham, `Script production mang tiền tố "_" (đợt dọn rác quét _* sẽ xoá nhầm — đã xảy ra 18/9 với PaySmart/DEMOMAY):\n${pham.join('\n')}`).toEqual([]);
  });
});
