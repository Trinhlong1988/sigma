// B112 (2/8) — TÁCH RA từ OcrBillPreview.tsx (nơi effect này ban đầu viết inline, B111 2/8) thành hook DÙNG
// CHUNG — EditBillMessageModal.tsx (panel "Sửa" bill đã gửi, mới) cần GỌI ĐÚNG 1 luồng debounce này để hàng
// "Hoàn tiền" luôn tính nhất quán, tránh lệch 2 nơi (đúng bài học B106 retro "sửa 1 nơi quên nơi khác").
//
// 20/8 — SỬA BUG TIỀN NGHIÊM TRỌNG (Admin Demo): trước đây hook chỉ trả `FeePreviewData | null` và GIỮ NGUYÊN
// giá trị CŨ khi số tiền đổi (chỉ huỷ timer, KHÔNG đánh dấu "đang chờ"). Hệ quả: `buildRefundText(parsedAmount
// MỚI, feePreview CŨ)` → dòng "Hoàn tiền" lệch số tiền/lệch % phí, và vì nút Gửi CHỈ gate theo `parsedAmount>0`
// nên dòng lỗi thời đó bị NƯỚNG VĨNH VIỄN vào ẢNH GHÉP gửi đi (composeBillImage). Nay hook TRẢ THÊM
// `previewAmount` (số tiền mà `feePreview` hiện tại được tính CHO) + `pending` (đang chờ mạng/debounce cho số
// tiền MỚI) để caller CHẶN gửi/lưu khi preview CHƯA khớp số tiền hiện tại (xem `isRefundTextStale()`).
import { useEffect, useState } from 'react';
import { getFeePreview, type FeePreviewData } from './agent-api-client';

/** Trạng thái xem trước phí trả về từ `useFeePreview` — KHÔNG chỉ là `FeePreviewData` mà kèm metadata để caller
 *  biết preview đó có "tươi" cho số tiền hiện tại không (chống nướng dòng Hoàn tiền lỗi thời vào ảnh). */
export interface FeePreviewState {
  /** Kết quả preview HIỆN CÓ. Có thể là của số tiền CŨ khi `pending===true` (giữ lại để tránh nháy màn hình) —
   *  chỉ dùng để BAKE VÀO ẢNH khi preview đã tươi (caller gate qua `isRefundTextStale`). */
  feePreview: FeePreviewData | null;
  /** Số tiền mà `feePreview` được tính CHO. `null` khi chưa có preview nào (chưa fetch / thiếu TID / số tiền
   *  không hợp lệ). Preview chỉ tươi cho số tiền X khi `previewAmount === X`. */
  previewAmount: number | null;
  /** `true` khi đang CHỜ mạng (hoặc còn trong cửa sổ debounce 300ms) để lấy preview cho số tiền MỚI — caller
   *  PHẢI chặn gửi/lưu trong lúc này. `false` khi không cần preview (thiếu TID / số tiền không hợp lệ) HOẶC
   *  preview đã tươi cho số tiền hiện tại. */
  pending: boolean;
}

const IDLE_STATE: FeePreviewState = { feePreview: null, previewAmount: null, pending: false };

/** Dòng "Hoàn tiền" (dựng từ `feePreview`) có LỖI THỜI so với `parsedAmount` không → caller chặn gửi/lưu để
 *  KHÔNG nướng dòng sai vào ảnh vĩnh viễn. Hàm THUẦN (tách để test được ở env node — hook React không test
 *  trực tiếp được vì repo chưa có jsdom).
 *  - Không có số tiền hợp lệ → KHÔNG lỗi thời (không có gì để hoàn/gửi; nút Gửi đã tự chặn qua `canSend`).
 *  - Không có TID → KHÔNG lỗi thời: không TID thì không có phí, dòng Hoàn tiền = nguyên số tiền (phí 0%) là
 *    ĐÚNG và tươi ngay, KHÔNG cần đợi mạng.
 *  - Có TID + số tiền hợp lệ → lỗi thời khi ĐANG chờ mạng (`pending`) HOẶC preview hiện có tính cho số tiền
 *    KHÁC (`previewAmount !== parsedAmount`, gồm cả cửa sổ debounce trước khi fetch chạy). */
export function isRefundTextStale(params: {
  hasTid: boolean;
  parsedAmount: number | null;
  pending: boolean;
  previewAmount: number | null;
}): boolean {
  const { hasTid, parsedAmount, pending, previewAmount } = params;
  if (parsedAmount == null || parsedAmount <= 0) return false;
  if (!hasTid) return false;
  return pending || previewAmount !== parsedAmount;
}

/** Xem trước phí bán/hoàn tiền cho 1 TID+số tiền — debounce 300ms (CÙNG pattern tìm kiếm trong phòng,
 * ConversationScreen.tsx inRoomSearchQuery effect) để tránh gọi API mỗi phím gõ số tiền. `tid`/`parsedAmount`
 * thiếu/không hợp lệ → trạng thái rỗng (feePreview null, pending false) ngay, KHÔNG gọi API. Route
 * `/v1/me/fee-preview` KHÔNG BAO GIỜ lỗi (xem fee-quote.ts previewSellFeeForTid()) — `r.ok===false` (lỗi mạng/
 * phiên hết hạn) cũng coi là kết quả TƯƠI cho số tiền đó (feePreview=null, pending=false) → caller (qua
 * `buildRefundText()`, bill-refund-text.ts) tự hiểu là phí 0%, KHÔNG chặn luồng gửi/sửa. */
export function useFeePreview(tid: string | undefined, parsedAmount: number | null, cardTypeId?: number): FeePreviewState {
  const [state, setState] = useState<FeePreviewState>(IDLE_STATE);
  useEffect(() => {
    if (!tid || parsedAmount == null || parsedAmount <= 0) {
      setState(IDLE_STATE);
      return;
    }
    let cancelled = false;
    // Đánh dấu ĐANG CHỜ preview cho `parsedAmount` MỚI NGAY LẬP TỨC (trước cả debounce) — giữ `feePreview`/
    // `previewAmount` CŨ để tránh nháy dòng Hoàn tiền trên màn hình, nhưng `pending=true` báo caller rằng dòng
    // hiện tại CHƯA khớp số tiền này → chặn gửi/lưu cho tới khi fetch cho số tiền này về (fix bug nướng ảnh).
    // 21/8 — ĐỔI LOẠI THẺ (cardTypeId) cũng chạy lại effect này (nằm trong dep) → pending=true → isRefundTextStale
    // trả true tới khi preview mới về, CHẶN gửi/lưu trong lúc đang đổi thẻ (giữ nguyên guard chống nướng số sai).
    setState((prev) => ({ feePreview: prev.feePreview, previewAmount: prev.previewAmount, pending: true }));
    const timer = setTimeout(() => {
      void getFeePreview(tid, parsedAmount, cardTypeId).then((r) => {
        if (cancelled) return;
        // Kết quả TƯƠI cho ĐÚNG `parsedAmount` này: gắn `previewAmount=parsedAmount` + `pending=false`. Lỗi
        // mạng (r.ok===false) → feePreview=null nhưng VẪN là kết quả tươi (phí 0%), KHÔNG kẹt pending.
        setState({ feePreview: r.ok ? r.data : null, previewAmount: parsedAmount, pending: false });
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tid, parsedAmount, cardTypeId]);
  return state;
}
