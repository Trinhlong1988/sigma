// GUARD chống tái diễn (Admin Demo 1/9 "2 tab thủ công/tự động phải như nhau, tại note phải có từ lâu rồi"): bill CK
// PHẢI có PARITY POS về NGÀY — OCR mù ngày → mặc định HÔM NAY + nút sửa (date-picker) + note "đã cập nhật" + ngày đã
// sửa PHẢI đi kèm payload gửi (server ghi billDate/advance_date đúng, KHÔNG chỉ hiển thị). BUG đã xảy ra: CK chỉ hiện
// "Bank · Ngày" tĩnh (transfer.date), OCR mù → '—', không sửa được, ngày không tới server → billDate lệch/rỗng.
// TransferReviewCard dùng CHUNG cả 2 tab (manual/auto) nên khóa 1 component = parity cả 2 (R198: check đọc source thật).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'OcrSendScreen.tsx'), 'utf8');
// Cô lập thân TransferReviewCard (từ khai báo tới OcrSendScreen) để assert đúng trong card CK, không lẫn card POS.
const ckStart = src.indexOf('function TransferReviewCard');
const ckEnd = src.indexOf('export function OcrSendScreen');
const ck = src.slice(ckStart, ckEnd);

describe('TransferReviewCard — PARITY POS về ngày (mặc định hôm nay + sửa + note + gửi kèm payload)', () => {
  it('có state ngày, OCR mù → mặc định todayDmy()', () => {
    expect(ckStart).toBeGreaterThanOrEqual(0);
    expect(ck).toMatch(/const \[date, setDate\] = useState\(/);
    expect(ck).toMatch(/todayDmy\(\)/);
    expect(ck).toMatch(/ocrHadDate/);
  });
  it('có date-picker native + input sửa tay (như POS)', () => {
    expect(ck).toMatch(/type="date"/);
    expect(ck).toMatch(/dmyToIso\(date\)/);
    expect(ck).toMatch(/isoToDmy\(e\.target\.value\)/);
  });
  it('có note "đã cập nhật" khi user sửa ngày (dateTouched)', () => {
    expect(ck).toMatch(/dateTouched/);
    expect(ck).toMatch(/Đã cập nhật ngày/);
  });
  it('NGÀY đã sửa đi KÈM payload gửi (override transfer.date → server ghi billDate/advance_date đúng)', () => {
    expect(ck).toMatch(/const dateForSend =/);
    // BOTH nhánh payload (INVESTOR + DEALER) phải mang date: dateForSend — nếu chỉ 1 nhánh → 1 hướng mất ngày.
    const occurrences = (ck.match(/date: dateForSend/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
