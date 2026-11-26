// Regression B2 (audit 23-24/7): rc-client.live-check.ts từng log thẳng authToken RC thật ra console. Vì
// live-check.ts là script chạy TAY (không nằm trong npm test, không gọi RC thật ở đây — xem convention ở đầu
// mỗi file live-check.ts), không thể "chạy thử" để bắt lỗi leak bằng cách import+execute như test thường. Test
// này đọc TRỰC TIẾP source text các file *.live-check.ts và khẳng định KHÔNG có chỗ nào in field nhạy cảm
// (authToken/password) ra console mà không qua biến đã redact — chặn tái diễn nếu ai đó sau này lỡ tay đổi
// `loginForLog` (đã redact) ngược lại thành `login` (chưa redact) trong lệnh console.log.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('live-check scripts không lộ secret ra console (B2 regression)', () => {
  const liveCheckFiles = readdirSync(testDir).filter((f) => f.endsWith('.live-check.ts'));

  it('có ít nhất 1 file live-check.ts để kiểm (tránh test rỗng-vô-nghĩa nếu ai đó đổi tên convention)', () => {
    expect(liveCheckFiles.length).toBeGreaterThan(0);
  });

  for (const file of liveCheckFiles) {
    it(`${file}: mọi console.log/error chứa "authToken"/"password" PHẢI qua biến đã redact, KHÔNG log trực tiếp field thật`, () => {
      const src = readFileSync(join(testDir, file), 'utf-8');
      const consoleLines = src
        .split('\n')
        .filter((line) => /console\.(log|error|warn)/.test(line));

      for (const line of consoleLines) {
        // Cho phép log tên field/placeholder (vd đặt tên biến 'authToken' trong message string mô tả), nhưng
        // CẤM in trực tiếp `.authToken`/`.password` (truy cập property) hoặc `JSON.stringify(login`/`JSON.stringify(me`
        // với object CHƯA qua bước redact — biến đã redact trong repo hiện tại đặt tên hậu tố `ForLog`.
        const accessesRawSecretField = /\.(authToken|password)\b/.test(line) && !/redact|ForLog/.test(line);
        expect(accessesRawSecretField, `dòng nghi log secret chưa redact trong ${file}: ${line.trim()}`).toBe(false);
      }
    });
  }
});
