// Test helpers thuần DiaryScreen (#27 gallery lightbox nav + #30 pull-to-refresh) — không cần render.
import { describe, expect, it } from 'vitest';
import { clampGalleryIndex, PULL_REFRESH_THRESHOLD_PX, shouldTriggerPullRefresh } from './diary-ui';

describe('clampGalleryIndex — điều hướng gallery lightbox', () => {
  it('tiến/lùi trong khoảng hợp lệ', () => {
    expect(clampGalleryIndex(0, 1, 3)).toBe(1);
    expect(clampGalleryIndex(2, -1, 3)).toBe(1);
  });
  it('kẹp ở biên, KHÔNG cuộn vòng', () => {
    expect(clampGalleryIndex(0, -1, 3)).toBe(0); // đã ở ảnh đầu, lùi vẫn 0
    expect(clampGalleryIndex(2, 1, 3)).toBe(2); // đã ở ảnh cuối, tiến vẫn 2
  });
  it('len<=0 (không có ảnh) → 0', () => {
    expect(clampGalleryIndex(0, 1, 0)).toBe(0);
    expect(clampGalleryIndex(5, -1, 0)).toBe(0);
  });
  it('1 ảnh → luôn 0 (không có ảnh khác để qua lại)', () => {
    expect(clampGalleryIndex(0, 1, 1)).toBe(0);
    expect(clampGalleryIndex(0, -1, 1)).toBe(0);
  });
});

describe('shouldTriggerPullRefresh — pull-to-refresh', () => {
  const T = PULL_REFRESH_THRESHOLD_PX;
  it('kéo từ đỉnh, xuống, vượt ngưỡng, không đang refresh → true', () => {
    expect(shouldTriggerPullRefresh({ atTop: true, dy: T, threshold: T, refreshing: false })).toBe(true);
    expect(shouldTriggerPullRefresh({ atTop: true, dy: T + 30, threshold: T, refreshing: false })).toBe(true);
  });
  it('chưa vượt ngưỡng → false', () => {
    expect(shouldTriggerPullRefresh({ atTop: true, dy: T - 1, threshold: T, refreshing: false })).toBe(false);
  });
  it('không bắt đầu từ đỉnh (đang cuộn giữa danh sách) → false', () => {
    expect(shouldTriggerPullRefresh({ atTop: false, dy: T + 50, threshold: T, refreshing: false })).toBe(false);
  });
  it('đang refresh sẵn → false (không chồng chập)', () => {
    expect(shouldTriggerPullRefresh({ atTop: true, dy: T + 50, threshold: T, refreshing: true })).toBe(false);
  });
});
