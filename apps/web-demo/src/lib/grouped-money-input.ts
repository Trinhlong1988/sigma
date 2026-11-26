// SIGMA (1/8) — Helper thuần cho ô nhập tiền tay: live-grouping (dấu chấm phân nhóm nghìn NGAY khi gõ, đúng
// lớp bug B87 đã sửa ở dự án chị em quan-ly-glb/GLB IMS: "12 ô nhập tiền thiếu live-grouping khi gõ") + validate
// NGHIÊM khi Admin Demo báo 1/8 vấn đề 2 ("140tr" gõ vào bị hiểu nhầm thành "140đ", lệch x1.000.000).
//
// Thuật toán group 3-số ĐÚNG packages/shared/src/forms.ts (groupDigits/onlyDigits, đang dùng ở apps/desktop
// B87) — đã grep xác nhận TRƯỚC khi viết. apps/web-demo là app build RIÊNG, KHÔNG khai @sigma/shared trong
// package.json/vite config và có quy ước SẴN CÓ trong repo là "mirror thủ công logic/type qua ranh giới app"
// (xem agent-api-client.ts OcrAmountPreview mirror ocr-bridge.ts, MyLoViolation mirror RuleViolationEntry) —
// mirror lại CÙNG thuật toán ở đây thay vì import chéo, giữ đúng ranh giới kiến trúc đã có.
//
// KHÁC packages/shared/forms.ts groupDigits(): forms.ts (dùng ở GLB desktop) SILENTLY loại bỏ MỌI ký tự không
// phải digit khi gõ (kể cả chữ cái) — hợp lý cho GLB vì chưa có báo cáo lệch đơn vị. Ở ĐÂY áp NGHIÊM hơn theo
// đúng yêu cầu vấn đề 2: ký tự KHÔNG phải digit/dấu phân cách (chấm/phẩy/space) phải bị TỪ CHỐI rõ ràng (không
// cho ký tự đó lọt vào ô, kèm thông báo đỏ hiển thị ngay) — KHÔNG BAO GIỜ âm thầm nuốt ký tự lạ rồi coi phần
// còn lại là số hợp lệ (nếu chỉ silently strip như GLB, gõ "140tr" sẽ tự động còn lại "140" MÀ KHÔNG CÓ CẢNH
// BÁO NÀO — tái tạo chính xác lớp bug Admin Demo báo, chỉ là ở tầng keystroke thay vì tầng submit).
import { useLayoutEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';

/** Chỉ giữ chữ số. '' nếu rỗng/không có digit nào. */
export function onlyDigits(raw: string): string {
  return (raw ?? '').replace(/\D/g, '');
}

/** Nhóm 3 chữ số kiểu Việt Nam bằng dấu chấm. "5000000" -> "5.000.000"; "" -> "". Input PHẢI đã là digit-only
 * (gọi onlyDigits() trước nếu chưa chắc) — hàm này không tự lọc lại. */
export function groupDigits(digitsOnly: string): string {
  const s = digitsOnly.replace(/^0+(?=\d)/, ''); // bỏ 0 dẫn đầu, giữ '0' đơn lẻ (đang gõ dở)
  if (s === '') return '';
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Ký tự HỢP LỆ cho ô tiền tay: chữ số + dấu phân cách nghìn người dùng có thể tự gõ (chấm/phẩy/khoảng trắng —
// phẩy/space chấp nhận ở INPUT dù ta luôn hiển thị lại bằng chấm, để không chặn oan người quen gõ kiểu khác).
// KHÔNG chấp nhận chữ cái/ký hiệu khác (vd "tr", "k", "đ", "-", "e" — chặn cả scientific notation).
const VALID_MONEY_CHARS = /^[\d.,\s]*$/;

export interface GroupedMoneyEdit {
  /** Giá trị MỚI cho input (đã group lại bằng dấu chấm). Khi rejected=true, GIỮ NGUYÊN y hệt oldValue. */
  value: string;
  /** Vị trí con trỏ nên đặt lại (index trong `value`) sau khi format. */
  cursor: number;
  /** true nếu lần gõ này chứa ký tự KHÔNG hợp lệ và bị TỪ CHỐI HOÀN TOÀN (không có fallback cắt bớt). */
  rejected: boolean;
}

/**
 * Tính state mới cho ô tiền live-grouping ngay khi gõ, GIỮ ĐÚNG vị trí con trỏ — đếm số CHỮ SỐ đứng trước con
 * trỏ ở giá trị vừa gõ, rồi tìm lại đúng vị trí đó (theo số chữ số) trong chuỗi đã group lại. Đây là bài toán
 * kinh điển "cursor nhảy lung tung" khi số ký tự đổi do thêm/bớt dấu chấm ngăn cách — ví dụ gõ chèn số "5" vào
 * giữa "140.000" ở vị trí sau "140" phải cho ra "1405.000"→group lại "1.405.000" với con trỏ đứng NGAY SAU số
 * "5" vừa gõ (chữ số thứ 4), KHÔNG nhảy về cuối chuỗi.
 *
 * @param rawValue  giá trị input NGAY SAU keystroke (e.target.value — DOM đã áp dụng edit của user).
 * @param cursorPos vị trí con trỏ NGAY SAU keystroke (e.target.selectionStart).
 * @param oldValue  giá trị TRƯỚC keystroke (dùng để revert khi bị từ chối).
 * @param oldCursor vị trí con trỏ TRƯỚC keystroke (dùng để revert khi bị từ chối).
 */
export function applyGroupedMoneyEdit(rawValue: string, cursorPos: number, oldValue: string, oldCursor: number): GroupedMoneyEdit {
  if (!VALID_MONEY_CHARS.test(rawValue)) {
    return { value: oldValue, cursor: oldCursor, rejected: true };
  }
  const digitsBeforeCursor = onlyDigits(rawValue.slice(0, cursorPos)).length;
  const digits = onlyDigits(rawValue);
  const grouped = groupDigits(digits);
  if (digitsBeforeCursor === 0) {
    return { value: grouped, cursor: 0, rejected: false };
  }
  let seen = 0;
  let cursor = grouped.length;
  for (let i = 0; i < grouped.length; i++) {
    if (/\d/.test(grouped[i])) {
      seen++;
      if (seen === digitsBeforeCursor) {
        cursor = i + 1;
        break;
      }
    }
  }
  return { value: grouped, cursor, rejected: false };
}

/** Parse ô tiền ĐÃ group (digit + dấu chấm do chính groupDigits() sinh ra) -> số nguyên đồng. Rỗng -> null
 * (chưa nhập, KHÔNG phải lỗi). Không bao giờ trả NaN — tự vệ (defense-in-depth R198) dù applyGroupedMoneyEdit
 * đã chặn ký tự lạ ngay từ lúc gõ, hàm parse KHÔNG tin ngược lại state mà vẫn strip digit-only trước khi Number(). */
export function parseGroupedMoneyValue(value: string): number | null {
  const digits = onlyDigits(value);
  if (digits === '') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/**
 * Hook dùng chung cho MỌI ô nhập tiền tay cần live-grouping + chặn ký tự lạ (ReconcileDetailScreen.tsx
 * "Tổng tiền OCR", OcrBillPreview.tsx "Số tiền (đ)"). Trả `value` (đã group, bind thẳng vào input), `error`
 * (thông báo đỏ khi vừa gõ ký tự lạ — tự KHÔNG tự xoá, component gọi `clearError()` nếu muốn ẩn theo hành vi
 * riêng, mặc định giữ hiển thị tới lần gõ hợp lệ tiếp theo để người dùng chắc chắn thấy được), `inputRef` (PHẢI
 * gắn vào input để hook tự khôi phục vị trí con trỏ qua useLayoutEffect), `onChange` (gắn thẳng vào input),
 * và `setValue` (set giá trị lập trình, vd tự điền từ OCR — tự group lại, không cần qua bàn phím).
 */
export function useGroupedMoneyField(initialValue = ''): {
  value: string;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  setValue: (digitsOrGrouped: string) => void;
} {
  const [value, setValueState] = useState(() => groupDigits(onlyDigits(initialValue)));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCursorRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pendingCursorRef.current != null && inputRef.current) {
      inputRef.current.setSelectionRange(pendingCursorRef.current, pendingCursorRef.current);
      pendingCursorRef.current = null;
    }
  }, [value]);

  function onChange(e: ChangeEvent<HTMLInputElement>): void {
    const raw = e.target.value;
    const cursorPos = e.target.selectionStart ?? raw.length;
    // oldCursor: dùng độ dài value cũ làm fallback hợp lý khi trình duyệt không báo selectionStart (hiếm).
    const edit = applyGroupedMoneyEdit(raw, cursorPos, value, value.length);
    if (edit.rejected) {
      setError('Chỉ được nhập số (0-9) — không dùng chữ hoặc ký hiệu như "tr"/"k"/"đ". Vui lòng nhập đủ số 0 (VD 140 triệu → 140000000).');
      // KHÔNG setValueState — input controlled sẽ tự revert về giá trị cũ ở lần render kế tiếp (KHÔNG âm thầm
      // chấp nhận ký tự lạ rồi cắt bớt, đúng yêu cầu vấn đề 2).
      return;
    }
    setError(null);
    setValueState(edit.value);
    pendingCursorRef.current = edit.cursor;
  }

  function setValue(digitsOrGrouped: string): void {
    setError(null);
    setValueState(groupDigits(onlyDigits(digitsOrGrouped)));
  }

  return { value, error, inputRef, onChange, setValue };
}
