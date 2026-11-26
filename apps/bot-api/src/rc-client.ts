// SIGMA Phase 1 (23/7, CMD_BUILD) — client REST gọi Rocket.Chat thật (`chat.example.com`, xem
// kế hoạch mục A). Toàn bộ hàm KHÔNG throw khi RC trả lỗi nghiệp vụ (sai mật khẩu/username trùng/token hết
// hạn...) — luôn trả discriminated union `ApiCallResult<T>` (CÙNG shape `sigma-bot/src/pure/types.ts`,
// copy 1-đối-1 vào đây vì bot-api và sigma-bot là 2 package/repo tách biệt, không share được qua import
// — chấp nhận trùng lặp nhỏ để giữ ranh giới package rõ ràng). RC_BASE_URL/RC_ADMIN_* đọc process.env LÚC
// GỌI (không cache lúc import — ĐÚNG pattern db.ts/email-service.ts).
export type RcApiError =
  | { ok: false; kind: 'NETWORK'; message: string }
  | { ok: false; kind: 'HTTP'; status: number; errorCode?: string; message: string }
  | { ok: false; kind: 'PARSE'; message: string };

export type RcApiResult<T> = { ok: true; data: T } | RcApiError;

export interface RcLoginData {
  userId: string;
  authToken: string;
}

export interface RcMeData {
  _id: string;
  username: string;
  name?: string;
  emails?: { address: string; verified: boolean }[];
}

export interface RcCreateUserInput {
  username: string;
  email: string;
  name: string;
  password: string;
}

export interface RcCreateUserData {
  _id: string;
  username: string;
}

function rcBaseUrl(): string {
  return process.env.RC_BASE_URL || 'https://chat.example.com';
}

/** Gói fetch chung: bắt lỗi mạng (NETWORK), lỗi parse JSON (PARSE), map non-2xx sang HTTP — KHÔNG BAO GIỜ throw. */
async function rcFetch<T>(path: string, init: RequestInit): Promise<RcApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${rcBaseUrl()}${path}`, init);
  } catch (err) {
    return { ok: false, kind: 'NETWORK', message: err instanceof Error ? err.message : String(err) };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, kind: 'PARSE', message: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    const b = body as { error?: string; errorType?: string; message?: string } | null;
    return {
      ok: false,
      kind: 'HTTP',
      status: res.status,
      errorCode: b?.errorType ?? b?.error,
      message: b?.error ?? b?.message ?? `Máy chủ trả lỗi HTTP ${res.status}`
    };
  }
  return { ok: true, data: body as T };
}


/** GET /api/v1/me — xác minh authToken/userId còn hợp lệ + trả thông tin user (rc-auth-middleware dùng hàm này). */
export async function rcGetMe(authToken: string, userId: string): Promise<RcApiResult<RcMeData>> {
  return rcFetch<RcMeData>('/api/v1/me', {
    method: 'GET',
    headers: { 'X-Auth-Token': authToken, 'X-User-Id': userId }
  });
}

// Cache token admin trong bộ nhớ tiến trình (KHÔNG lưu DB — token RC tự có TTL riêng, đủ dùng trong 1 vòng
// đời process; nếu hết hạn giữa chừng, rcCreateUser bên dưới sẽ nhận lỗi HTTP 401 từ RC, ta không tự retry ở
// Phase 1 — QUYẾT ĐỊNH BUILD, ghi rõ trong báo cáo cho LEAD xác nhận đủ hay cần refresh chủ động).
let cachedAdminAuth: RcLoginData | null = null;

// INTERNAL (4/8 hoàn tất LOẠI RC) — login admin lấy token cho các thao tác quản trị CÒN dùng RC (rcCreateUser/
// rcDeleteUser/rcSetUserPassword tạo/xoá/đổi mật khẩu user RC nền cho tài khoản cũ). KHÔNG export — auth đăng
// nhập của agent đã cắt hẳn RC (xem routes/auth.ts checkAgentPassword). Dùng field `user` (RC tự tra
// username/email/SĐT). Không có tham số 2FA `code` (đăng nhập admin bằng username/password thuần).
async function rcLogin(username: string, password: string): Promise<RcApiResult<RcLoginData>> {
  const r = await rcFetch<{ status: string; data: { userId: string; authToken: string } }>('/api/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: username, password })
  });
  if (!r.ok) return r;
  return { ok: true, data: { userId: r.data.data.userId, authToken: r.data.data.authToken } };
}

async function getAdminAuth(): Promise<RcApiResult<RcLoginData>> {
  const explicitToken = process.env.RC_ADMIN_AUTH_TOKEN;
  const explicitUserId = process.env.RC_ADMIN_USER_ID;
  if (explicitToken && explicitUserId) {
    return { ok: true, data: { userId: explicitUserId, authToken: explicitToken } };
  }

  if (cachedAdminAuth) {
    return { ok: true, data: cachedAdminAuth };
  }

  const adminUsername = process.env.RC_ADMIN_USERNAME;
  const adminPassword = process.env.RC_ADMIN_PASSWORD;
  if (!adminUsername || !adminPassword) {
    return {
      ok: false,
      kind: 'HTTP',
      status: 500,
      errorCode: 'RC_ADMIN_CREDENTIALS_NOT_CONFIGURED',
      message: 'Thiếu RC_ADMIN_AUTH_TOKEN/RC_ADMIN_USER_ID hoặc RC_ADMIN_USERNAME/RC_ADMIN_PASSWORD trong biến môi trường.'
    };
  }
  const login = await rcLogin(adminUsername, adminPassword);
  if (!login.ok) return login;
  cachedAdminAuth = login.data;
  return login;
}

/** Cho test reset cache token admin giữa các case (giống resetBotDb ở db.ts). */
export function resetRcAdminAuthCache(): void {
  cachedAdminAuth = null;
}

/**
 * POST /api/v1/users.create — tạo user Rocket.Chat mới bằng quyền admin. Cách lấy admin token: ƯU TIÊN
 * RC_ADMIN_AUTH_TOKEN/RC_ADMIN_USER_ID tĩnh nếu Admin Demo tự tạo Personal Access Token cho tài khoản admin
 * (đơn giản nhất, không cần lo hết hạn); NẾU KHÔNG có, fallback login bằng RC_ADMIN_USERNAME/PASSWORD rồi
 * cache token trong bộ nhớ tiến trình — QUYẾT ĐỊNH BUILD (spec cho tự chọn cách đơn giản hơn), LEAD xác nhận
 * lại cách nào Admin Demo muốn dùng thật ở production.
 */
export async function rcCreateUser(input: RcCreateUserInput): Promise<RcApiResult<RcCreateUserData>> {
  const admin = await getAdminAuth();
  if (!admin.ok) return admin;

  // BUG THẬT phát hiện 24/7 qua live round-trip trên production (KHÔNG phải unit test bắt được — mock test
  // cũ dùng ĐÚNG shape lồng `{user:{...}}` nhưng chỉ assert `r.ok===true`, không check `r.data._id` nên
  // không lộ ra): response thật của RC `/api/v1/users.create` là `{user:{_id,username,...}, success}`, KHÔNG
  // phải `{_id,username}` phẳng. Code cũ trả thẳng `r` (chưa unwrap `.user`) → agent.rcUserId/rcUsername lưu
  // undefined→null dù RC user đã tạo thật. Unwrap `.user` giống cách rcLogin đã unwrap `.data` phía trên.
  const r = await rcFetch<{ user: RcCreateUserData; success: boolean }>('/api/v1/users.create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': admin.data.authToken,
      'X-User-Id': admin.data.userId
    },
    body: JSON.stringify({
      username: input.username,
      email: input.email,
      name: input.name,
      password: input.password,
      verified: true, // admin tạo hộ = coi như đã xác thực (email đã qua OTP ở luồng gọi hàm này)
      requirePasswordChange: false
    })
  });
  if (!r.ok) return r;
  return { ok: true, data: { _id: r.data.user._id, username: r.data.user.username } };
}

/**
 * POST /api/v1/users.delete — xóa user Rocket.Chat bằng quyền admin. Dùng để dọn tài khoản test (live-check
 * script/round-trip thủ công) NGAY sau khi tạo — bài học 24/7: 1 user test tạo đêm 23/7 không bị xóa đã gây
 * nhầm lẫn thật (RC báo "email đã dùng" khi round-trip lại đúng email đó ngày hôm sau). Cùng cơ chế
 * getAdminAuth() như rcCreateUser (token tĩnh ưu tiên, fallback login+cache).
 */
export async function rcDeleteUser(username: string): Promise<RcApiResult<{ success: boolean }>> {
  const admin = await getAdminAuth();
  if (!admin.ok) return admin;

  return rcFetch<{ success: boolean }>('/api/v1/users.delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': admin.data.authToken,
      'X-User-Id': admin.data.userId
    },
    body: JSON.stringify({ username })
  });
}

/**
 * POST /api/v1/users.update — đổi mật khẩu Rocket.Chat bằng quyền admin, dùng cho luồng "Quên mật khẩu"
 * (24/7, Admin Demo yêu cầu): sau khi verify OTP-email thật (otp-service.ts, purpose PASSWORD_RESET) xác nhận
 * chủ email, gọi hàm này set thẳng mật khẩu mới — KHÔNG cần mật khẩu cũ (đúng bản chất "quên"). CÙNG cơ chế
 * getAdminAuth() như rcCreateUser/rcDeleteUser.
 */
export async function rcSetUserPassword(userId: string, newPassword: string): Promise<RcApiResult<{ success: boolean }>> {
  const admin = await getAdminAuth();
  if (!admin.ok) return admin;

  return rcFetch<{ success: boolean }>('/api/v1/users.update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': admin.data.authToken,
      'X-User-Id': admin.data.userId
    },
    body: JSON.stringify({ userId, data: { password: newPassword } })
  });
}

