// SIGMA (1/8) — regression THUẦN cho nextPendingDate() (DateOfBirthPicker.tsx), CÙNG khuôn
// ocr-preview-ui.test.ts (vitest environment 'node', KHÔNG jsdom — component tự nó (JSX/hooks) KHÔNG test
// được ở đây, chỉ test hàm logic thuần đã tách riêng, xem docstring nextPendingDate()).
//
// BUG THẬT (1/8, Admin Demo "đổi ngày sinh bấm lưu như không lưu hồ sơ") — bản CŨ suy `y/m/d` TRỰC TIẾP từ prop
// `value` mỗi render, KHÔNG có state nội bộ nào nhớ lựa chọn TỪNG PHẦN giữa các lần cuộn 3 bánh xe độc lập.
// Bắt đầu từ `value=""` (agent chưa từng khai ngày sinh — CẢ lúc Đăng ký lẫn Hồ sơ lần đầu): cuộn 1 bánh xe
// bất kỳ chỉ có ĐÚNG 1/3 chiều non-null, 2 chiều còn lại vẫn đọc null từ `value` CHƯA ĐỔI (vì onChange trước
// đó CHƯA BAO GIỜ fire) → deadlock tuyệt đối, KHÔNG CÁCH NÀO đạt đủ cả 3 cùng lúc dù cuộn theo thứ tự nào.
// Test dưới đây khẳng định `nextPendingDate()` (bản fix, cộng dồn vào 1 state ĐỘC LẬP `pending` sống qua
// nhiều lần render) thoát được deadlock này.
import { describe, expect, it } from 'vitest';
import { nextPendingDate, resolveEditingMode, type PendingDate } from './DateOfBirthPicker';

const EMPTY: PendingDate = { y: null, m: null, d: null };

describe('nextPendingDate — bắt đầu từ rỗng (agent chưa từng khai ngày sinh)', () => {
  it('cuộn CHỈ 1/3 bánh xe (ngày) → pending cập nhật đúng ngày nhưng isoDate VẪN null (chưa đủ 3 chiều)', () => {
    const r = nextPendingDate(EMPTY, 'd', 15);
    expect(r.pending).toEqual({ y: null, m: null, d: 15 });
    expect(r.isoDate).toBeNull();
  });

  it('cuộn đủ 3 bánh xe THEO THỨ TỰ ngày→tháng→năm (mỗi lần dùng pending MỚI NHẤT, không phải state cha cũ) → lần thứ 3 mới ra isoDate ĐẦY ĐỦ ĐÚNG — CHỨNG MINH deadlock cũ đã hết', () => {
    let pending = EMPTY;
    let r1 = nextPendingDate(pending, 'd', 20);
    pending = r1.pending;
    expect(r1.isoDate).toBeNull(); // đúng bug cũ tại bước này: mọi lần gọi đều null nếu thiếu 1/3.

    let r2 = nextPendingDate(pending, 'm', 8);
    pending = r2.pending;
    expect(r2.isoDate).toBeNull();

    const r3 = nextPendingDate(pending, 'y', 1990);
    // ĐIỂM MẤU CHỐT khác bản cũ: bản cũ deadlock vĩnh viễn ở đây (mãi mãi null vì mỗi WheelColumn đọc closure
    // render-time cũ, KHÔNG có accumulator) — bản fix cộng dồn đúng, ra isoDate ĐẦY ĐỦ, ĐÚNG cả 3 chiều.
    expect(r3.isoDate).toBe('1990-08-20');
    expect(r3.pending).toEqual({ y: 1990, m: 8, d: 20 });
  });

  it('cuộn đủ 3 bánh xe THEO THỨ TỰ KHÁC (năm→ngày→tháng) → vẫn ra ĐÚNG isoDate bất kể thứ tự cuộn', () => {
    let pending = EMPTY;
    pending = nextPendingDate(pending, 'y', 2001).pending;
    pending = nextPendingDate(pending, 'd', 3).pending;
    const r = nextPendingDate(pending, 'm', 12);
    expect(r.isoDate).toBe('2001-12-03');
  });
});

describe('nextPendingDate — đã có ngày sinh sẵn (đổi 1 chiều)', () => {
  const EXISTING: PendingDate = { y: 1988, m: 5, d: 12 };

  it('đổi CHỈ năm (2 chiều còn lại giữ nguyên từ pending hiện có) → ra isoDate ĐÚNG NGAY LẦN ĐẦU (không deadlock vì 2 chiều kia đã sẵn non-null)', () => {
    const r = nextPendingDate(EXISTING, 'y', 1995);
    expect(r.isoDate).toBe('1995-05-12');
  });

  it('đổi liên tiếp cả 3 chiều (mô phỏng cuộn nhanh nhiều bánh xe) → kết quả CUỐI phản ánh ĐỦ cả 3 thay đổi, không rơi rớt chiều nào do đọc nhầm giá trị CŨ', () => {
    let pending = EXISTING;
    pending = nextPendingDate(pending, 'y', 1990).pending;
    pending = nextPendingDate(pending, 'm', 8).pending;
    const r = nextPendingDate(pending, 'd', 20);
    expect(r.isoDate).toBe('1990-08-20');
  });
});

describe('resolveEditingMode — bánh xe CHỈ khi user CHỦ ĐỘNG nhập/sửa (Admin Demo 5/8, LẦN 2 — hết "nháy quay quay")', () => {
  // Ngữ nghĩa MỚI (đồng bộ DateOfBirthPicker.tsx): chế độ bánh xe = DẪN XUẤT thuần từ `userEditing`, KHÔNG
  // phụ thuộc `isComplete` nữa. Chưa khai + chưa chạm → hiện NÚT "Chọn ngày sinh…" (không phải bánh xe);
  // value nạp async (rỗng→đủ) mà user chưa chạm → ô GỌN NGAY. Bánh xe chỉ bật khi user bấm "Sửa"/chạm cột.

  it('ngày ĐẦY ĐỦ + user chưa sửa (kể cả value nạp async) → chế độ GỌN, KHÔNG bánh xe', () => {
    expect(resolveEditingMode(true, false)).toBe(false);
  });

  // (Admin Demo 5/8, LẦN 2) CHƯA khai + user CHƯA chủ động sửa → nút "Chọn ngày sinh…" (placeholder),
  // KHÔNG bánh xe (không còn frame nào lăn khi vừa mở màn/đang tải). Đây là case bản trước đây trả `true`
  // (bánh xe) — nay PHẢI `false`.
  it('CHƯA khai + user CHƯA sửa → nút "Chọn ngày sinh…", KHÔNG bánh xe', () => {
    expect(resolveEditingMode(false, false)).toBe(false);
  });

  it('user ĐANG chủ động sửa (bấm "Sửa" / chạm bánh xe) dù ngày đã đủ → giữ bánh xe cho tới khi bấm "Xong"', () => {
    expect(resolveEditingMode(true, true)).toBe(true);
  });

  it('CHƯA đủ + user ĐANG sửa (bấm "Chọn ngày sinh…" rồi cuộn) → hiện bánh xe để nhập', () => {
    expect(resolveEditingMode(false, true)).toBe(true);
  });

  it('mô phỏng ĐÚNG chuỗi bug: mount rỗng (async) → KHÔNG lăn lúc đầu, và về gọn ngay khi value đủ', () => {
    // 1) render đầu: value="" → chưa đủ, user chưa chạm → nút "Chọn ngày sinh…", KHÔNG bánh xe (hết nháy).
    expect(resolveEditingMode(false, false)).toBe(false);
    // 2) value async về đầy đủ, user vẫn CHƯA chạm → ô GỌN (không bao giờ lăn).
    expect(resolveEditingMode(true, false)).toBe(false);
    // 3) user bấm "Sửa" → bánh xe mở.
    expect(resolveEditingMode(true, true)).toBe(true);
  });
});

describe('nextPendingDate — clamp ngày khi tháng mới có ít ngày hơn', () => {
  it('ngày 31 (tháng có 31 ngày) đổi sang tháng 2 (28/29 ngày) → tự động clamp ngày xuống ngày cuối tháng mới, KHÔNG ra ngày ảo "31/2"', () => {
    const r = nextPendingDate({ y: 2021, m: 1, d: 31 }, 'm', 2);
    expect(r.isoDate).toBe('2021-02-28'); // 2021 không nhuận.
    expect(r.pending.d).toBe(31); // pending giữ nguyên lựa chọn thô người dùng vừa cuộn (chưa clamp) — CHỈ isoDate phát ra đã clamp, khớp hành vi bản gốc (emit() cũ cũng chỉ clamp lúc phát chuỗi, không ghi đè lại `d` hiển thị).
  });

  it('năm nhuận — ngày 29/2 hợp lệ, không bị clamp oan', () => {
    const r = nextPendingDate({ y: 2020, m: 1, d: 29 }, 'm', 2);
    expect(r.isoDate).toBe('2020-02-29'); // 2020 nhuận.
  });
});
