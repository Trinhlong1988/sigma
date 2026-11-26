// SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — hash/verify mật khẩu nội bộ cho Agent, thay dần vai trò xác
// thực mật khẩu của Rocket.Chat (rcLogin). Dùng `bcrypt` (native binding, đã cài sẵn trong package.json) —
// KHÔNG tái dùng packages/business-rules/auth.rules.ts vì đó là domain model User (GLB desktop), khác Agent.
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 10; // khớp quy ước BCRYPT_ROUNDS ở packages/business-rules/auth.rules.ts cho nhất
// quán codebase, dù không import module đó.

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** KHÔNG throw khi hash rỗng/hỏng — trả false (Agent chưa có passwordHash local, hoặc hash hỏng dữ liệu). */
export async function verifyPasswordHash(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
