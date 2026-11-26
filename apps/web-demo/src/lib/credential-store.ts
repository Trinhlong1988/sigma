// SIGMA (29/7, Admin Demo báo "chưa có nhớ mật khẩu") — CHỈ có `autoComplete="username"/"current-password"`
// (B41) KHÔNG đủ để trình duyệt tự hiện hộp thoại "Lưu mật khẩu?" — Chrome/Edge chỉ tự động đề nghị lưu khi
// đăng nhập qua `<form>` submit thật HOẶC khi trang gọi tường minh Credential Management API. Toàn bộ luồng ở
// đây dùng `fetch()` qua nút bấm (KHÔNG phải `<form onSubmit>`), nên PHẢI tự gọi `navigator.credentials.store()`
// ngay sau khi đăng nhập/đăng ký thành công — đây LÀ cách chuẩn W3C cho đúng tình huống này, KHÔNG phải hack.
//
// KHÔNG hỗ trợ trên mọi trình duyệt (Safari/Firefox chưa có `PasswordCredential`) — luôn kiểm tồn tại trước,
// KHÔNG throw nếu thiếu. Trong app đóng gói (Capacitor WebView) API này thường không có tác dụng thật (trình
// duyệt hệ thống không có UI riêng để hỏi) — gọi vẫn an toàn (no-op), không cần tự loại trừ theo nền tảng.
export async function tryStoreLoginCredential(identifier: string, password: string): Promise<void> {
  const w = window as unknown as {
    PasswordCredential?: new (data: { id: string; password: string; name?: string }) => Credential;
  };
  if (!w.PasswordCredential || !navigator.credentials?.store) return;
  try {
    const credential = new w.PasswordCredential({ id: identifier, password, name: identifier });
    await navigator.credentials.store(credential);
  } catch {
    // Người dùng từ chối lưu / trình duyệt chặn (vd chế độ ẩn danh) — KHÔNG phải lỗi cần báo.
  }
}
