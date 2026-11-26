// Helpers THUẦN (không React/DOM) cho DiaryScreen — tách riêng để unit test được logic điều hướng gallery
// lightbox (#27) + quyết định pull-to-refresh (#30) mà KHÔNG cần render/DOM thật.

/** Kẹp chỉ số ảnh trong gallery lightbox vào [0, len-1]. `delta` = -1 (ảnh trước) / +1 (ảnh sau). Ở biên thì
 * GIỮ NGUYÊN (KHÔNG cuộn vòng — cùng hành vi gallery ConversationScreen). len<=0 → 0 (không có ảnh). */
export function clampGalleryIndex(current: number, delta: number, len: number): number {
  if (len <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > len - 1) return len - 1;
  return next;
}

/** Ngưỡng kéo (px, theo dịch chuyển ngón THẬT) để kích hoạt refresh khi nhả tay pull-to-refresh. */
export const PULL_REFRESH_THRESHOLD_PX = 70;

/** Có nên refresh khi nhả tay không: CHỈ khi bắt đầu kéo từ ĐỈNH danh sách (atTop), kéo XUỐNG (dy>0) vượt
 * ngưỡng, và KHÔNG đang refresh sẵn (tránh chồng chập). */
export function shouldTriggerPullRefresh(opts: { atTop: boolean; dy: number; threshold: number; refreshing: boolean }): boolean {
  return opts.atTop && !opts.refreshing && opts.dy >= opts.threshold;
}
