// vitest `setupFiles` (chạy TRONG mỗi test file, khác `globalSetup` chạy 1 lần bên ngoài toàn bộ suite).
// Ngắt kết nối Prisma client của FILE ĐÓ sau khi xong (vitest cô lập module registry theo từng file mặc
// định → mỗi file có 1 singleton `getBotDb()` riêng) — tránh để lại session mở khi global-setup dropdb
// throwaway DB ở cuối suite ("database is being accessed by other users").
import { afterAll } from 'vitest';
import { resetBotDb } from '../src/db.js';

afterAll(async () => {
  await resetBotDb();
});

// [14/9] Gate owner /v1/ocr-send/* (siết non-owner) — agent fixture code ngẫu nhiên: bật bypass CHỈ-TEST để các
// suite nghiệp vụ đi qua gate (prod không bao giờ set env này; test authz sweep là source-scan nên không ảnh hưởng).
