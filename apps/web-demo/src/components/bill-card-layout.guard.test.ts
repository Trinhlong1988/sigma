// GUARD chống tái diễn (Admin Demo 1/9 "kiểm chứng cấm tái diễn"): card bill POS + CK PHẢI bố cục NGANG ở MỌI bề rộng
// (ảnh trái · bảng phải). BUG đã xảy ra: dùng `flex-col sm:flex-row` → màn HẸP (APK/panel <640px) xếp DỌC = "blog dọc
// bên dưới". Test đọc source thật (R198: check chạy thật, fail-loud nếu không đọc được file), khoá:
//   1) KHÔNG còn `flex-col sm:flex-row` (mầm bệnh xếp dọc theo viewport).
//   2) CÓ `flex-row items-stretch` (ngang + 2 cột cao bằng nhau).
//   3) PosBillCard KHÔNG lặp ô 'Loại' = 'Bill POS' (đã có ở header → tránh hiện 2 lần).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pos = readFileSync(path.join(HERE, 'PosBillCard.tsx'), 'utf8');
const ck = readFileSync(path.join(HERE, 'TransferCkCard.tsx'), 'utf8');

describe('bill card layout — NGANG mọi bề rộng (chống "blog dọc bên dưới")', () => {
  it('PosBillCard: flex-row (KHÔNG flex-col sm:flex-row)', () => {
    expect(pos).toMatch(/flex flex-row items-stretch/);
    expect(pos).not.toMatch(/className="[^"]*flex-col sm:flex-row/);
  });
  it('TransferCkCard: flex-row (KHÔNG flex-col sm:flex-row)', () => {
    expect(ck).toMatch(/flex flex-row items-stretch/);
    expect(ck).not.toMatch(/flex-col sm:flex-row/);
  });
  it('PosBillCard: KHÔNG lặp ô "Loại: Bill POS" (đã có ở header)', () => {
    // header có "Bill POS"; KHÔNG được có thêm 1 ô nhãn "Loại" với nội dung "Bill POS".
    expect(pos).not.toMatch(/>Loại<\/div>\s*<div[^>]*>Bill POS/);
  });
});
