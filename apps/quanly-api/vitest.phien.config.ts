// Cấu hình riêng cho bộ kiểm phiên — vitest gốc KHÔNG include apps/quanly-api/test (lỗ T19 đã ghi nhận),
// nên phải có config riêng, nếu không bộ này không bao giờ chạy mà vẫn tưởng "đã có test".
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/phien-bao-mat.test.ts'],
    globalSetup: [],
    setupFiles: [],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
});
