// Script CHẠY TAY để gọi Rocket.Chat THẬT (chat.example.com) — KHÔNG phải file *.test.ts nên
// KHÔNG bị vitest include (`test/**/*.test.ts`), KHÔNG chạy trong `npm test`/CI. Chạy bằng:
//   npm run test:rc-live --workspace @sigma/bot-api
//
// 4/8 hoàn tất LOẠI RC khỏi luồng đăng nhập agent — `rcLogin`/`rcGetMe`-qua-token-user KHÔNG còn là đường
// xác thực nữa (rcLogin đã bị gỡ export, chỉ còn internal cho admin). Vì thế phần smoke-test rcLogin/rcGetMe
// bằng 1 tài khoản user THẬT đã được GỠ khỏi script này. Chỉ còn smoke-test các hàm rc-client CÒN dùng cho
// thao tác QUẢN TRỊ user RC nền (rcCreateUser/rcDeleteUser) — chúng tự lấy admin token qua getAdminAuth()
// (đọc RC_ADMIN_AUTH_TOKEN/RC_ADMIN_USER_ID hoặc RC_ADMIN_USERNAME/RC_ADMIN_PASSWORD trong env).
//
// Cần mạng tới chat.example.com + biến môi trường thật cho quyền admin:
//   RC_ADMIN_AUTH_TOKEN + RC_ADMIN_USER_ID  (ưu tiên — Personal Access Token), HOẶC
//   RC_ADMIN_USERNAME + RC_ADMIN_PASSWORD   (fallback — rc-client tự login admin nội bộ + cache token).
// Việc TẠO user THẬT chỉ chạy khi cố ý đặt RC_LIVE_TRY_CREATE=1 (SẼ tạo 1 user THẬT rồi TỰ XOÁ ngay).
// KHÔNG được chạy nhầm trong CI (không đặt RC_LIVE_TRY_CREATE → script tự thoát sớm, không throw phá pipeline).
import 'dotenv/config';
import { rcCreateUser, rcDeleteUser } from '../src/rc-client.js';

async function main(): Promise<void> {
  console.log(`[rc-live-check] RC_BASE_URL = ${process.env.RC_BASE_URL || '(mặc định chat.example.com)'}`);
  console.log(
    '[rc-live-check] LƯU Ý: rcLogin/rcGetMe (đăng nhập bằng tài khoản user) đã bị gỡ khỏi đường xác thực agent ' +
      '(4/8 LOẠI RC). Script này chỉ còn smoke-test rcCreateUser/rcDeleteUser (thao tác admin trên user RC nền).'
  );

  if (process.env.RC_LIVE_TRY_CREATE !== '1') {
    console.log(
      '[rc-live-check] RC_LIVE_TRY_CREATE khác "1" → bỏ qua (không tạo user thật). Đặt RC_LIVE_TRY_CREATE=1 ' +
        '(kèm RC_ADMIN_AUTH_TOKEN/RC_ADMIN_USER_ID hoặc RC_ADMIN_USERNAME/RC_ADMIN_PASSWORD) nếu muốn thử thật.'
    );
    return;
  }

  const newUsername = `sigma_live_check_${Date.now()}`;
  console.log(`[rc-live-check] RC_LIVE_TRY_CREATE=1 → tạo user THẬT "${newUsername}" (CẨN THẬN, dữ liệu thật trên RC)...`);
  const created = await rcCreateUser({
    username: newUsername,
    email: `${newUsername}@example.com`,
    name: 'Live Check (tự xoá ngay sau khi test)',
    password: `Live${Date.now()}!`
  });
  console.log('[rc-live-check] rcCreateUser →', JSON.stringify(created, null, 2));

  // BUG THẬT 24/7 (đêm 23/7 → sáng 24/7): dòng nhắc tay "NHỚ VÀO RC ADMIN XOÁ" trước đây không ai làm theo
  // → user test sót lại thật trên production → hôm sau round-trip lại đúng email đó bị RC báo "đã dùng",
  // gây nhầm lẫn tưởng là bug. TỰ ĐỘNG xóa NGAY tại đây thay vì nhắc tay — không phụ thuộc người chạy nhớ.
  if (created.ok) {
    console.log(`[rc-live-check] tự xoá user test "${newUsername}" ngay...`);
    const deleted = await rcDeleteUser(newUsername);
    if (deleted.ok) {
      console.log('[rc-live-check] đã xoá user test thành công, KHÔNG còn sót lại trên production.');
    } else {
      console.error(
        `[rc-live-check] XÓA USER TEST THẤT BẠI — user "${newUsername}" CÒN SÓT LẠI THẬT trên production, ` +
          'cần vào RC admin xoá tay ngay:',
        JSON.stringify(deleted, null, 2)
      );
    }
  } else {
    console.error('[rc-live-check] rcCreateUser THẤT BẠI (không tạo được user, KHÔNG có gì cần xoá).');
  }
}

main().catch((err) => {
  console.error('[rc-live-check] LỖI:', err);
  process.exitCode = 1;
});
