// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ SHIM `window.api` CHO BẢN WEB (SigMa — SPA cổng 57913)                                        ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// MỤC ĐÍCH: dựng lại ĐÚNG bề mặt `window.api` mà 45 trang renderer đang gọi (460 lời gọi / 298 method), nhưng
// KHÔNG có Electron: mọi method nghiệp vụ đi `fetch` trực tiếp tới `quanly-api` — SAO ĐÚNG KHUÔN `httpCall` của
// `src/preload/index.ts` (credentials:'include' giữ cookie phiên `ql_session`, header `X-SigMa-Client`, trả BODY
// JSON bất kể HTTP status, fetch throw → NETWORK, body phi-JSON → BAD_RESPONSE). Nhờ vậy renderer KHÔNG phải sửa.
//
// ── R201 (trace lớp LIVE trước khi sửa) ────────────────────────────────────────────────────────────────
// Đã đọc TOÀN BỘ `src/preload/index.ts` (661 dòng) và phân loại từng method:
//   • Nhóm HTTP (≈270 method): thân là `httpCall(...)` → web dùng Y NGUYÊN đường REST, chỉ đổi cách giải API base.
//   • Nhóm IPC-only (30 method khai báo, 26 method renderer thật sự gọi + 5 method đăng-ký-sự-kiện): PHẢI xử lý
//     riêng — xem từng khối có nhãn "[IPC-ONLY]" bên dưới.
//   • Nhóm HYBRID (7 method): login / loginRemembered / billExplain{Generate,Config,SetConfig,ImportTemplate,
//     ResetTemplate} — vừa HTTP vừa IPC. Xem nhãn "[HYBRID]".
//   • Nhóm THUẦN CLIENT (2): validatePassword (hàm pure @sigma/shared), getEffectiveApiBase.
//
// ── R198 (CẤM nuốt lỗi im lặng) ────────────────────────────────────────────────────────────────────────
// Mọi method không chạy được trên web đều:
//   (1) `console.error` kèm TÊN METHOD + lý do, và
//   (2) TRẢ `{ ok:false, error:'WEB_UNSUPPORTED', message:'...' }` để UI hiện lỗi —
// TUYỆT ĐỐI KHÔNG trả `{ok:true}` rỗng/dữ liệu giả. Đặc biệt với method dính TIỀN:
//   • `billExplainGenerate` — trên desktop nó RESERVE dải số hóa đơn ở server (GHI DB) rồi mới render file cục bộ.
//     Trên web KHÔNG render được file ⇒ nếu vẫn gọi reserve thì DẢI SỐ HÓA ĐƠN BỊ ĐỐT VÔ ÍCH. Vì vậy shim NÉM LỖI
//     TRƯỚC khi gọi bất kỳ HTTP nào (xem khối billExplainGenerate).
//   • `backupRestore` — phục hồi DB từ file trên đĩa client: chặn thẳng, không mô phỏng.
//
// ── Cookie phiên ───────────────────────────────────────────────────────────────────────────────────────
// `quanly-api` set cookie `ql_session` với `httpOnly; sameSite:'none'; secure:true` (routes/auth.ts).
// ⇒ Trang web PHẢI chạy ở ngữ cảnh mà trình duyệt chịu nhận cookie `Secure`: `http://localhost:<cổng>` (localhost
//   được Chrome coi là trustworthy) hoặc HTTPS thật. Phục vụ qua IP LAN bằng http:// THUẦN sẽ MẤT cookie →
//   đăng nhập xong vẫn 401. Xem báo cáo (mục việc còn lại) để biết cách vá đúng.
// CORS: `apps/quanly-api/src/cors-allowlist.ts` cho phép `^http://(127.0.0.1|localhost)(:\d+)?$` ⇒ origin
//   `http://localhost:57913` ĐÃ nằm trong allowlist (cả đường đọc lẫn đường ghi) — KHÔNG cần sửa gì ở server.

import { keoHetTrang } from '../shared/keo-het-danh-sach.js';
import { validatePassword as checkPasswordStrength } from '@sigma/shared';
// Lấy kiểu `GlbApi` từ CHÍNH file khai báo mà renderer đang dùng (`preload/index.d.ts`) — KHÔNG lấy từ
// `preload/index.ts` để tránh kéo `electron` vào chương trình TypeScript của bản web. Khai báo `const api: GlbApi`
// bên dưới là CỔNG BIÊN DỊCH: thiếu/sai bất kỳ method nào trong 314 method là `tsc --noEmit` BÁO ĐỎ ngay.
import type { GlbApi } from '../preload/index.d';
import { buildReportWorkbook, buildTemplateWorkbook, buildMultiSheetWorkbook } from '../main/export-service.js';
import { buildInvestorDetailWorkbook, type InvestorDetailData } from '@sigma/services/investor-detail-workbook';

// Hằng đặt lúc BUILD (vite.config.web.ts → define). Khai báo ở đây để tsc biết.
declare const __SIGMA_WEB_VERSION__: string;
declare const __SIGMA_WEB_API_BASE__: string;

const stripTrail = (s: string): string => s.replace(/\/+$/, '');

/**
 * Địa chỉ `quanly-api` cho bản web — HẰNG SỐ LÚC BUILD (web không có màn "Cấu hình máy chủ" vì không có IPC).
 *  (a) `VITE_SIGMA_API_BASE` truyền lúc build → dùng y nguyên (ví dụ https://alpha-quanly-api.example.com).
 *  (b) Không truyền → suy từ CHÍNH host đang phục vụ trang + cổng 8790 (máy chủ nội bộ chạy quanly-api ở 8790).
 *      Mở trang ở http://localhost:57913 → API http://localhost:8790 (cùng host ⇒ cookie đi được).
 */
const API_BASE: string = (() => {
  const dinhSan = typeof __SIGMA_WEB_API_BASE__ === 'string' ? __SIGMA_WEB_API_BASE__.trim() : '';
  // (c) `same-origin` — CỔNG WEB tự chuyển tiếp /v1/* sang API (xem infra/web-static/serve-webapp-quanly.mjs).
  //     Base RỖNG ⇒ mọi lời gọi là đường DẪN TƯƠNG ĐỐI, tức CÙNG ORIGIN với trang. Nhờ vậy cookie phiên
  //     `ql_session` đi kèm tự nhiên, không phải trông vào `SameSite=None; Secure` — ra LAN bằng http thuần
  //     vẫn đăng nhập được. Đây là cấu hình KHUYẾN NGHỊ khi mở ra ngoài localhost.
  if (dinhSan === 'same-origin') return '';
  if (dinhSan) return stripTrail(dinhSan);
  const loc = window.location;
  return `${loc.protocol}//${loc.hostname}:8790`;
})();

/** Khoá nhận diện TRÌNH DUYỆT này — sinh 1 lần, giữ trong localStorage. Mất thì sinh lại (coi như máy mới). */
function khoaThietBi(): string {
  const K = 'alpha.khoa-thiet-bi';
  try {
    let v = localStorage.getItem(K);
    if (!v || !/^[A-Za-z0-9_-]{8,100}$/.test(v)) {
      v = 'web-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2));
      localStorage.setItem(K, v);
    }
    return v;
  } catch {
    return 'web-khong-luu-duoc';
  }
}

const enc = encodeURIComponent;

/** Ghép query-string từ object filter — COPY NGUYÊN hàm qs() của preload (giữ hành vi bỏ undefined/null/''). */
function qs(params: Record<string, unknown> | undefined | null): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v === '') continue;
    parts.push(`${enc(k)}=${enc(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Gọi REST quanly-api — SAO ĐÚNG `httpCall` của preload (dòng 81-103). Trả BODY JSON ({ok,...}) BẤT KỂ status;
 * fetch throw → NETWORK; body phi-JSON → BAD_RESPONSE. KHÔNG throw ở 4xx (renderer đang dựa vào điều này).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function httpCall(method: string, path: string, body?: unknown): Promise<any> {
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-SigMa-Client': '1',
      // KHOÁ THIẾT BỊ: sinh 1 lần cho trình duyệt này rồi giữ lại. Không phải bí mật — chỉ để nhận diện
      // máy trong danh sách phiên và làm nền cho bước DUYỆT THIẾT BỊ sau này.
      'X-SigMa-Device': khoaThietBi()
    }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(API_BASE + path, init);
  } catch {
    return { ok: false, error: 'NETWORK', message: 'Không kết nối được máy chủ. Kiểm tra mạng và cấu hình máy chủ rồi thử lại.' };
  }
  try {
    return await res.json();
  } catch {
    return { ok: false, error: 'BAD_RESPONSE', message: `Máy chủ trả về dữ liệu không hợp lệ (HTTP ${res.status}).` };
  }
}

/** Cast tiện dụng: filter/input `unknown` → Record cho qs()/spread body (COPY từ preload). */
function rec(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

// ── R198: báo KHÔNG HỖ TRỢ một cách TƯỜNG MINH (log + trả lỗi), tuyệt đối không trả dữ liệu giả ────────
function khongHoTro(method: string, viec: string, goiY = ''): { ok: false; error: 'WEB_UNSUPPORTED'; message: string } {
  const message = `${viec} chỉ chạy được trên bản DESKTOP (Electron). Bản web không có chức năng này.${goiY ? ' ' + goiY : ''}`;
  console.error(`[web-shim] KHÔNG HỖ TRỢ TRÊN WEB — window.api.${method}(): ${message}`);
  return { ok: false, error: 'WEB_UNSUPPORTED', message };
}
/** Ghi log cho method thuần-desktop đã được UI ẩn (nút cửa sổ / updater / nhớ máy) — gọi được nhưng vô hại. */
function ghiLogVoHai(method: string, viec: string): void {
  console.warn(`[web-shim] bỏ qua window.api.${method}() — ${viec} không có trên bản web (UI đã ẩn nút này).`);
}
/** Hàm hủy-đăng-ký rỗng cho các method onXxx (sự kiện main→renderer không tồn tại trên web). */
const huyRong = (): void => undefined;

// ── Tải file về máy người dùng: Blob + <a download> (thay hộp thoại Lưu của Electron) ──────────────────
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function taiVeFile(tenFile: string, bytes: ArrayBuffer | Uint8Array, mime = MIME_XLSX): void {
  // `bytes` có thể là Buffer polyfill của exceljs (là Uint8Array) hoặc ArrayBuffer → Blob nhận cả hai.
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = tenFile;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Giữ URL đủ lâu cho trình duyệt ghi xong file rồi mới thu hồi (thu hồi ngay có thể làm hỏng file lớn).
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Query string báo cáo tiền chờ — lặp `key=` cho mảng, hkd KHÔNG tách phẩy (bản web, song song preload). */
function tienChoQsWeb(filter: unknown): string {
  const f = (filter ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const add = (k: string, v: unknown): void => {
    if (v == null || v === '') return;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  };
  add('tuThang', f['tuThang']);
  add('denThang', f['denThang']);
  for (const k of ['tids', 'cards', 'daiLy', 'doiTac', 'banks', 'hkd']) {
    const arr = f[k];
    if (Array.isArray(arr)) for (const v of arr) add(k, v);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

const api: GlbApi = {
  // ── Auth ─────────────────────────────────────────────────────────────────────────────────────────────
  // [HYBRID → HTTP] Desktop: HTTP login + IPC safeStorage lưu "nhớ máy". Web: BỎ phần nhớ máy (không có
  // safeStorage) — UI đã ẩn ô "Ghi nhớ đăng nhập" bằng cờ `coDesktop`, nếu vẫn truyền remember=true thì LOG RÕ.
  login: async (username: string, password: string, remember: boolean, force?: boolean) => {
    void force; // `force` (R46 single-session) chưa hỗ trợ ở API — y như preload
    if (remember) ghiLogVoHai('login(remember=true)', 'ghi nhớ đăng nhập (safeStorage)');
    return httpCall('POST', '/v1/auth/login', { username, password });
  },
  me: () => httpCall('GET', '/v1/auth/me'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  billManualCreate: (input: any) => httpCall('POST', '/v1/bills/manual', input),
  // Danh sách bill theo kỳ — ĐỌC THẲNG TỪ SỔ, không dựng lại số ở client.
  // [DOANH SỐ TIỀN CHỜ 24/11] `nhomPhi` tuỳ chọn: 'tiencho' = chỉ Tiền chờ(8)/Uỷ quyền(9); bỏ trống = bill thường.
  billManualList: (from: string, to: string, nhomPhi?: string) =>
    httpCall('GET', `/v1/bills/manual?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${nhomPhi ? `&nhomPhi=${encodeURIComponent(nhomPhi)}` : ''}`),
  // [DOANH SỐ TIỀN CHỜ 24/11] TID đã khai giá bán Tiền chờ(8)/Uỷ quyền(9).
  billManualTidsTienCho: () => httpCall('GET', '/v1/bills/manual/tids-tiencho'),
  // KPI Doanh Số (tab full-view) — ĐỌC THẲNG TỪ SỔ theo kỳ + (tuỳ chọn) ca.
  kpiDoanhSo: (from: string, to: string, ca?: number | null) =>
    httpCall('GET', `/v1/kpi/doanh-so?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${ca != null ? `&ca=${ca}` : ''}`),
  // DOANH SỐ TIỀN CHỜ / CÔNG NỢ PHẢI THU ỦY QUYỀN (Admin Demo 24/11) — HTTP thuần, Y ĐƯỜNG REST như preload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tienChoNhap: (input: any) => httpCall('POST', '/v1/tien-cho', input),
  tienChoXoa: (id: number, password: string) => httpCall('DELETE', `/v1/tien-cho/${id}`, { password }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tienChoBaoCao: (filter: any) => httpCall('GET', `/v1/tien-cho/bao-cao${tienChoQsWeb(filter)}`),
  logout: () => httpCall('POST', '/v1/auth/logout'),
  sessionHeartbeat: () => httpCall('POST', '/v1/auth/heartbeat'),
  onlineUsers: () => httpCall('GET', '/v1/auth/online-users'),
  realtimeTokens: () => httpCall('GET', '/v1/realtime/tokens'),
  changePassword: (currentPassword: string, newPassword: string, confirmPassword?: string) => {
    void confirmPassword;
    return httpCall('POST', '/v1/auth/change-password', { oldPassword: currentPassword, newPassword });
  },
  adminResetPassword: (userId: number, newPassword: string, actorPassword: string) =>
    httpCall('POST', '/v1/auth/admin-reset-password', { targetUserId: userId, newPassword, actorPassword }),
  level2Status: () => httpCall('GET', '/v1/auth/level2/status'),
  setLevel2: (level1: string, newLevel2: string, confirmLevel2: string) =>
    httpCall('POST', '/v1/auth/level2/set', { level1, newLevel2, confirmLevel2 }),
  resetLevel2: (level1: string, oldLevel2: string, newLevel2: string, confirmLevel2: string) =>
    httpCall('POST', '/v1/auth/level2/reset', { level1, oldLevel2, newLevel2, confirmLevel2 }),
  // [THUẦN CLIENT] kiểm ĐỘ MẠNH mật khẩu — hàm pure @sigma/shared, chạy y hệt trên web.
  validatePassword: (pwd: string) => Promise.resolve(checkPasswordStrength(pwd)),
  // [IPC-ONLY] "Nhớ máy" dùng safeStorage của Electron (khóa theo máy). Web KHÔNG có → luôn rỗng.
  // KHÔNG dùng localStorage: lưu mật khẩu thật vào localStorage là lỗ bảo mật (XSS đọc được).
  getRemembered: async () => {
    ghiLogVoHai('getRemembered', 'đăng nhập đã nhớ (safeStorage)');
    return null;
  },
  loginRemembered: async (force?: boolean) => {
    void force;
    ghiLogVoHai('loginRemembered', 'đăng nhập đã nhớ (safeStorage)');
    // 'NO_REMEMBERED' là mã Login.tsx đã xử lý IM LẶNG (không báo lỗi đỏ) → người dùng nhập tay bình thường.
    return { ok: false, error: 'NO_REMEMBERED', message: 'Bản web không lưu đăng nhập trên máy. Vui lòng nhập mật khẩu.' };
  },
  saveRemembered: async (username: string, password: string) => {
    void username; void password;
    ghiLogVoHai('saveRemembered', 'lưu đăng nhập (safeStorage)');
    return { ok: false };
  },
  clearRemembered: async () => {
    ghiLogVoHai('clearRemembered', 'xóa đăng nhập đã lưu (safeStorage)');
    return { ok: false };
  },

  // ── Cấu hình máy chủ ─────────────────────────────────────────────────────────────────────────────────
  // [IPC-ONLY] Desktop: main quản kết nối Postgres cục bộ + apiBaseUrl người dùng nhập. Web: API base là HẰNG
  // LÚC BUILD ⇒ báo "đã cấu hình, không cần cấu hình" để App.tsx vào THẲNG màn đăng nhập (xem App.tsx dòng 71).
  // `database` để RỖNG — KHÔNG đoán tên DB; Login.tsx/Dashboard.tsx tự gọi GET /v1/health lấy tên DB THẬT.
  serverConfigGet: async () => ({
    ready: true,
    needsConfig: false,
    serverRole: false,
    configured: true,
    passwordSet: false,
    config: { host: '', port: 0, database: '', user: '', password: '' as const, apiBaseUrl: API_BASE || window.location.origin }
  }),
  getEffectiveApiBase: async () => API_BASE || window.location.origin,
  serverConfigTest: async (input: unknown) => {
    void input;
    const r = khongHoTro('serverConfigTest', 'Thử kết nối máy chủ', `Bản web nối cố định tới ${API_BASE} (đặt lúc build).`);
    return { ok: false, error: r.error };
  },
  serverConfigSave: async (input: unknown) => {
    void input;
    const r = khongHoTro('serverConfigSave', 'Lưu cấu hình máy chủ', `Muốn đổi địa chỉ API phải BUILD LẠI bản web với VITE_SIGMA_API_BASE.`);
    return { ok: false, error: r.error };
  },

  // ── Roles ────────────────────────────────────────────────────────────────────────────────────────────
  roleList: () => httpCall('GET', '/v1/roles'),
  rolePermissions: () => httpCall('GET', '/v1/permissions'),
  roleCreate: (input: unknown) => httpCall('POST', '/v1/roles', input),
  roleUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/roles/${id}`, input),
  roleLock: (id: number) => httpCall('POST', `/v1/roles/${id}/lock`),
  roleUnlock: (id: number) => httpCall('POST', `/v1/roles/${id}/unlock`),
  roleDelete: (id: number, password: string) => httpCall('DELETE', `/v1/roles/${id}`, { password }),

  // ── Users ────────────────────────────────────────────────────────────────────────────────────────────
  userList: (filter: unknown) => httpCall('GET', `/v1/users${qs(rec(filter))}`),
  // [KẾ TOÁN NĐT 24/11] Danh sách HẸP người được hoàn (id+fullName) — vai Kế toán NĐT dùng cho dropdown người hoàn
  // (không có USER_READ nên không gọi được /v1/users). Route gác REVENUE_MANAGE.
  refundPeople: () => httpCall('GET', '/v1/refund-people'),
  userCreate: (input: unknown) => httpCall('POST', '/v1/users', input),
  userUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/users/${id}`, input),
  userLock: (id: number) => httpCall('POST', `/v1/users/${id}/lock`),
  userUnlock: (id: number) => httpCall('POST', `/v1/users/${id}/unlock`),

  auditList: (query: unknown) => httpCall('GET', `/v1/audit-logs${qs(rec(query))}`),

  // ── Backup ───────────────────────────────────────────────────────────────────────────────────────────
  backupCreate: (note?: string) => httpCall('POST', '/v1/backups', { note }),
  backupList: () => httpCall('GET', '/v1/backups'),
  // [IPC-ONLY — PHÁ HỦY] Phục hồi đọc file .sql/.zip trên ĐĨA CLIENT rồi GHI ĐÈ cả database. Bản web KHÔNG có
  // đường đọc file đĩa, và CẤM mô phỏng: chặn thẳng, báo rõ phải dùng bản desktop trên máy chủ.
  backupRestore: async (filePath: string, password: string) => {
    void filePath; void password;
    return khongHoTro('backupRestore', 'Phục hồi dữ liệu từ bản sao lưu', 'Việc này phải làm bằng app desktop ở máy chủ.');
  },
  backupMirrorConfigGet: () => httpCall('GET', '/v1/backups/mirror-config'),
  backupMirrorConfigSet: (input: { mirrorDir: string | null; keep?: number }, password: string) =>
    httpCall('PUT', '/v1/backups/mirror-config', { ...rec(input), password }),

  // ── Settings ─────────────────────────────────────────────────────────────────────────────────────────
  settingList: () => httpCall('GET', '/v1/settings'),
  settingUpdate: (key: string, value: string) => httpCall('PUT', `/v1/settings/${enc(key)}`, { value }),

  // ── Customers / Nhà đầu tư ───────────────────────────────────────────────────────────────────────────
  // [B180] keo HET trang - may chu cat mac dinh 100 dong, man nao khong tu phan trang ma goi
  // thang se MAT du lieu cam (xem B179: so 114 TID, man chi thay 100).
  customerList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/customers${qs(rec(f))}`), filter),
  customerCounts: () => httpCall('GET', '/v1/customers/counts'),
  customerCreate: (input: unknown) => httpCall('POST', '/v1/customers', input),
  customerUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/customers/${id}`, input),
  investorList: (filter: unknown) => httpCall('GET', `/v1/investors${qs(rec(filter))}`),
  investorReport: (params: unknown) => httpCall('GET', `/v1/investors/report${qs(rec(params))}`),
  investorReportDetail: (params: unknown) => httpCall('GET', `/v1/investors/report-detail${qs(rec(params))}`),
  investorSettlement: (params: unknown) => httpCall('GET', `/v1/investors/settlement${qs(rec(params))}`),
  investorCreate: (input: unknown) => httpCall('POST', '/v1/investors', input),
  investorUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/investors/${id}`, input),
  investorDelete: (id: number, password: string) => httpCall('DELETE', `/v1/investors/${id}`, { password }),
  advanceList: (params: unknown) => httpCall('GET', `/v1/investor-advances${qs(rec(params))}`),
  advanceCreate: (input: unknown) => httpCall('POST', '/v1/investor-advances', input),
  advanceDelete: (id: number, password: string) => httpCall('DELETE', `/v1/investor-advances/${id}`, { password }),
  investorBankAccountList: (investorId: number) => httpCall('GET', `/v1/investors/${investorId}/bank-accounts`),
  investorBankAccountCreate: (investorId: number, input: unknown) => httpCall('POST', `/v1/investors/${investorId}/bank-accounts`, input),
  investorBankAccountDelete: (investorId: number, accountId: number, password: string) =>
    httpCall('DELETE', `/v1/investors/${investorId}/bank-accounts/${accountId}`, { password }),
  investorChatGroupList: (investorId: number) => httpCall('GET', `/v1/investors/${investorId}/chat-groups`),
  investorChatGroupAssignable: (investorId: number) => httpCall('GET', `/v1/investors/${investorId}/chat-groups/assignable`),
  investorChatGroupCreate: (investorId: number, input: unknown) => httpCall('POST', `/v1/investors/${investorId}/chat-groups`, input),
  investorChatGroupUpdate: (groupId: number, input: unknown) => httpCall('PATCH', `/v1/investor-chat-groups/${groupId}`, input),
  investorChatGroupDelete: (groupId: number) => httpCall('DELETE', `/v1/investor-chat-groups/${groupId}`),
  investorSubUserList: (investorId: number) => httpCall('GET', `/v1/investors/${investorId}/sub-users`),
  investorSubUserCreate: (investorId: number, input: unknown) => httpCall('POST', `/v1/investors/${investorId}/sub-users`, input),
  investorSubUserLock: (userId: number) => httpCall('POST', `/v1/investor-sub-users/${userId}/lock`),
  investorSubUserUnlock: (userId: number) => httpCall('POST', `/v1/investor-sub-users/${userId}/unlock`),
  investorSubUserDelete: (userId: number, password: string) => httpCall('DELETE', `/v1/investor-sub-users/${userId}`, { password }),
  customerChatGroupsList: (customerId: number) => httpCall('GET', `/v1/customers/${customerId}/chat-groups`),
  customerChatGroupsSet: (customerId: number, rows: unknown) => httpCall('PUT', `/v1/customers/${customerId}/chat-groups`, { rows }),
  chatGroupsForPicker: (search?: string, limit?: number) => httpCall('GET', `/v1/chat-groups${qs({ search, limit })}`),
  investorChatGroupsForPicker: (search?: string, limit?: number) => httpCall('GET', `/v1/investor-chat-groups/pickable${qs({ search, limit })}`),
  agentList: () => httpCall('GET', '/v1/agents'),
  // [IPC-ONLY] Đặt ảnh QR đại lý: main ĐỌC BYTES từ `srcPath` trên đĩa client rồi lưu. Web không có đường dẫn
  // đĩa thật (trình duyệt chỉ cho File object) và quanly-api CHƯA có route upload ⇒ chặn tường minh.
  agentSetQrImage: async (args: { agentId: number; srcPath: string; bankAccountLabel?: string | null }) => {
    void args;
    return khongHoTro('agentSetQrImage', 'Tải ảnh QR đại lý lên', 'Chưa có route upload ở quanly-api — dùng bản desktop.');
  },
  agentGetQrImage: (agentId: number) => httpCall('GET', `/v1/agents/${agentId}/qr-image`),

  // ── POS devices ──────────────────────────────────────────────────────────────────────────────────────
  posList: (filter: unknown) => httpCall('GET', `/v1/pos-devices${qs(rec(filter))}`),
  posTimeline: (serial: string) => httpCall('GET', `/v1/pos-devices/${enc(serial)}/timeline`),
  posCreate: (input: unknown) => httpCall('POST', '/v1/pos-devices', input),
  posUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/pos-devices/${id}`, input),
  posDeploy: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/deploy`, input),
  posRecall: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/recall`, input),
  posTransferAgent: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/transfer-agent`, input),
  posChangeCustomer: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/change-customer`, input),
  posCancelCustomer: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/cancel-customer`, input),
  deviceSellPos: (serial: string, input: unknown, password: string) => httpCall('POST', '/v1/device-sales/sell-pos', { serial, ...rec(input), password }),
  deviceSellTid: (tid: string, input: unknown, password: string) => httpCall('POST', '/v1/device-sales/sell-tid', { tid, ...rec(input), password }),
  deviceSaleCollect: (input: unknown) => httpCall('POST', `/v1/device-sales/${rec(input)['deviceSaleId']}/collect`, input),
  deviceSaleList: (filter: unknown) => httpCall('GET', `/v1/device-sales${qs(rec(filter))}`),
  deviceSaleReceivables: () => httpCall('GET', '/v1/device-sales/receivables'),
  posReportDamage: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/report-damage`, input),
  posSendRepair: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/send-repair`, input),
  posReceiveRepaired: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/receive-repaired`, input),
  posRetire: (serial: string, password: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/retire`, { ...rec(input), password }),

  // ── TIDs ─────────────────────────────────────────────────────────────────────────────────────────────
  // [B180] keo HET trang - may chu cat mac dinh 100 dong, man nao khong tu phan trang ma goi
  // thang se MAT du lieu cam (xem B179: so 114 TID, man chi thay 100).
  tidList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/tids${qs(rec(f))}`), filter),
  tidUndelivered: () => httpCall('GET', '/v1/tids/undelivered'),
  tidCreate: (input: unknown) => httpCall('POST', '/v1/tids', input),
  tidRefs: () => httpCall('GET', '/v1/tids/refs'),
  tidTimeline: (tid: string) => httpCall('GET', `/v1/tids/${enc(tid)}/timeline`),
  tidRevenueRanking: (filter: unknown) => httpCall('GET', `/v1/tids/revenue-ranking${qs(rec(filter))}`),
  tidAssign: (tid: string, input: unknown) => httpCall('POST', `/v1/tids/${enc(tid)}/assign`, input),
  tidReplace: (tid: string, input: unknown) => httpCall('POST', `/v1/tids/${enc(tid)}/replace`, input),
  tidRecall: (tid: string, input: unknown) => httpCall('POST', `/v1/tids/${enc(tid)}/recall`, input),
  tidMarkDelivered: (tid: string, input: unknown) => httpCall('POST', `/v1/tids/${enc(tid)}/mark-delivered`, input),
  tidChatRoomsForCustomer: (customerId: number) => httpCall('GET', `/v1/tids/chat-rooms${qs({ customerId })}`),
  tidSellFeeList: (tidId: number, feeTypeId: number, at?: string) => httpCall('GET', `/v1/tids/${tidId}/sell-fees${qs({ feeTypeId, at })}`),
  tidSellFeeSet: (input: unknown) => httpCall('PUT', `/v1/tids/${rec(input)['tidId']}/sell-fees`, input),
  sellFeePreviewByBankPartner: (bankId: number, partnerId: number, feeTypeId: number, at?: string) =>
    httpCall('GET', `/v1/sell-fees/preview${qs({ bankId, partnerId, feeTypeId, at })}`),

  // ── Notifications ────────────────────────────────────────────────────────────────────────────────────
  notifyUndeliveredSummary: () => httpCall('GET', '/v1/notifications/undelivered'),
  notifyPushUndelivered: () => httpCall('POST', '/v1/notifications/push-undelivered'),

  // ── Cấu hình ngân hàng / kho ─────────────────────────────────────────────────────────────────────────
  warehouseList: (filter: unknown) => httpCall('GET', `/v1/warehouses${qs(rec(filter))}`),
  warehouseLite: () => httpCall('GET', '/v1/warehouses/lite'),
  warehouseManagerCandidates: () => httpCall('GET', '/v1/warehouse-manager-candidates'),
  warehouseCreate: (input: unknown) => httpCall('POST', '/v1/warehouses', input),
  warehouseUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/warehouses/${id}`, input),
  warehouseDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/warehouses', { ids, password }),
  bankList: (filter: unknown) => httpCall('GET', `/v1/banks${qs(rec(filter))}`),
  bankLite: () => httpCall('GET', '/v1/banks/lite'),
  bankCreate: (input: unknown) => httpCall('POST', '/v1/banks', input),
  bankUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/banks/${id}`, input),
  bankDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/banks', { ids, password }),

  cardTypeList: (filter: unknown) => httpCall('GET', `/v1/card-types${qs(rec(filter))}`),
  cardTypeCreate: (input: unknown) => httpCall('POST', '/v1/card-types', input),
  cardTypeUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/card-types/${id}`, input),
  cardTypeDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/card-types', { ids, password }),

  partnerList: (filter: unknown) => httpCall('GET', `/v1/partners${qs(rec(filter))}`),
  partnerCreate: (input: unknown) => httpCall('POST', '/v1/partners', input),
  partnerUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/partners/${id}`, input),
  partnerDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/partners', { ids, password }),
  partnerBankMatrix: () => httpCall('GET', '/v1/partner-bank-matrix'),
  partnerBankSet: (partnerId: number, bankIds: number[]) => httpCall('PUT', `/v1/partners/${partnerId}/banks`, { bankIds }),
  statusOptionList: (entity: string, includeInactive?: boolean) => httpCall('GET', `/v1/status-options${qs({ entity, includeInactive })}`),
  statusOptionListMany: (entities: string[]) => httpCall('GET', `/v1/status-options/many${qs({ entities: entities.join(',') })}`),
  statusOptionEntities: () => httpCall('GET', '/v1/status-entities'),
  statusOptionCreate: (input: unknown) => httpCall('POST', '/v1/status-options', input),
  statusOptionUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/status-options/${id}`, input),
  statusOptionDelete: (id: number) => httpCall('DELETE', `/v1/status-options/${id}`),

  // ── Cấu hình cung ứng POS ────────────────────────────────────────────────────────────────────────────
  supplierList: (filter: unknown) => httpCall('GET', `/v1/suppliers${qs(rec(filter))}`),
  supplierLite: () => httpCall('GET', '/v1/suppliers/lite'),
  supplierCreate: (input: unknown) => httpCall('POST', '/v1/suppliers', input),
  supplierUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/suppliers/${id}`, input),
  supplierDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/suppliers', { ids, password }),

  posModelList: (filter: unknown) => httpCall('GET', `/v1/pos-models${qs(rec(filter))}`),
  posModelLite: () => httpCall('GET', '/v1/pos-models/lite'),
  posModelCreate: (input: unknown) => httpCall('POST', '/v1/pos-models', input),
  posModelUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/pos-models/${id}`, input),
  posModelDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/pos-models', { ids, password }),

  intakeStatusList: () => httpCall('GET', '/v1/intake-statuses'),
  intakeStatusCreate: (input: unknown) => httpCall('POST', '/v1/intake-statuses', input),
  intakeStatusUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/intake-statuses/${id}`, input),
  intakeStatusDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/intake-statuses', { ids, password }),

  posIntakeList: (filter: unknown) => httpCall('GET', `/v1/pos-intakes${qs(rec(filter))}`),
  posIntakeCreate: (input: unknown) => httpCall('POST', '/v1/pos-intakes', input),
  posIntakeUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/pos-intakes/${id}`, input),
  posIntakeDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/pos-intakes', { ids, password }),

  // ── Cấu hình phí ─────────────────────────────────────────────────────────────────────────────────────
  feeTypeList: () => httpCall('GET', '/v1/fee-types'),
  feeTypeCreate: (input: unknown) => httpCall('POST', '/v1/fee-types', input),
  feeTypeUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/fee-types/${id}`, input),
  feeTypeDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/fee-types', { ids, password }),

  handoverTypeList: () => httpCall('GET', '/v1/handover-types'),
  handoverTypeListLite: () => httpCall('GET', '/v1/handover-types/lite'),
  handoverTypeCreate: (input: unknown) => httpCall('POST', '/v1/handover-types', input),
  handoverTypeUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/handover-types/${id}`, input),
  handoverTypeDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/handover-types', { ids, password }),
  depositsHeld: (customerId?: number) => httpCall('GET', `/v1/deposits/held${qs({ customerId })}`),
  revenueByHandover: (filter: unknown) => httpCall('GET', `/v1/deposits/revenue-by-handover${qs(rec(filter))}`),
  depositsNeedingManualRefund: () => httpCall('GET', '/v1/deposits/needing-manual-refund'),
  refundDepositManual: (depositId: number, input: unknown) => httpCall('POST', `/v1/deposits/${depositId}/manual-refund`, input),

  feeRateList: (filter: unknown) => httpCall('GET', `/v1/fee-rates${qs(rec(filter))}`),
  feeRateSet: (input: unknown) => httpCall('POST', '/v1/fee-rates', input),
  feeRateDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/fee-rates', { ids, password }),
  feeSellQuoteList: (partnerId: number, cardTypeId: number, at?: string) => httpCall('GET', `/v1/fee-sell-quotes${qs({ partnerId, cardTypeId, at })}`),

  weekendSellAdjustList: () => httpCall('GET', '/v1/weekend-sell-adjust'),
  weekendSellAdjustSet: (input: unknown) => httpCall('POST', '/v1/weekend-sell-adjust', input),
  weekendSellAdjustDelete: (id: number) => httpCall('DELETE', `/v1/weekend-sell-adjust/${id}`),
  promoProgramList: () => httpCall('GET', '/v1/promo-programs'),
  promoProgramSet: (input: unknown) => httpCall('POST', '/v1/promo-programs', input),
  promoProgramDelete: (id: number) => httpCall('DELETE', `/v1/promo-programs/${id}`),
  qrPartnerFeeList: (partnerId?: number) => httpCall('GET', `/v1/qr-fees/partner${qs({ partnerId })}`),
  qrPartnerFeeSet: (input: unknown) => httpCall('POST', '/v1/qr-fees/partner', input),
  qrMerchantFeeList: (tidId?: number) => httpCall('GET', `/v1/qr-fees/merchant${qs({ tidId })}`),
  qrMerchantFeeSet: (input: unknown) => httpCall('POST', '/v1/qr-fees/merchant', input),
  qrDealerSellFeeList: (customerId?: number) => httpCall('GET', `/v1/qr-fees/dealer-sell${qs({ customerId })}`),
  qrDealerSellFeeSet: (input: unknown) => httpCall('POST', '/v1/qr-fees/dealer-sell', input),
  qrDealerSellFeeDelete: (id: number) => httpCall('DELETE', `/v1/qr-fees/dealer-sell/${id}`),
  qrDigistoreCredGet: (tidId: number) => httpCall('GET', `/v1/qr-digistore/cred/${tidId}`),
  qrDigistoreCredSet: (input: unknown) => httpCall('POST', '/v1/qr-digistore/cred', input),

  // ── Tài khoản nhận tiền – ủy quyền ───────────────────────────────────────────────────────────────────
  rcvSourceList: () => httpCall('GET', '/v1/rcv-sources'),
  rcvSourceCreate: (input: unknown) => httpCall('POST', '/v1/rcv-sources', input),
  rcvSourceUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/rcv-sources/${id}`, input),
  rcvSourceDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/rcv-sources', { ids, password }),

  // [B180] keo HET trang - may chu cat mac dinh 100 dong, man nao khong tu phan trang ma goi
  // thang se MAT du lieu cam (xem B179: so 114 TID, man chi thay 100).
  rcvAccountList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/receive-accounts${qs(rec(f))}`), filter),
  rcvAccountCreate: (input: unknown) => httpCall('POST', '/v1/receive-accounts', input),
  rcvAccountUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/receive-accounts/${id}`, input),
  rcvAccountDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/receive-accounts', { ids, password }),

  // [IPC-ONLY] Hộp thoại chọn ảnh của hệ điều hành → trả ĐƯỜNG DẪN TUYỆT ĐỐI để main đọc bytes.
  // Trên web KHÔNG thể có đường dẫn đó. CẤM trả path giả: form sẽ POST path giả → tạo bản ghi đính kèm RỖNG mà
  // KHÔNG ai biết (bug class "dữ liệu giả im lặng"). Trả {ok:false} → Attach.tsx hiện toast "Không chọn được ảnh".
  pickImage: async () => {
    console.error('[web-shim] KHÔNG HỖ TRỢ TRÊN WEB — window.api.pickImage(): hộp thoại chọn ảnh cần Electron; quanly-api chưa có route upload đính kèm. Dùng bản desktop để thêm/đổi ảnh.');
    return { ok: false };
  },
  // [IPC-ONLY] Đọc tệp đính kèm từ kho file của MÁY CHỦ qua main → data URL. Chưa có route HTTP tương ứng.
  readAttachment: async (relPath: string) => {
    void relPath;
    return khongHoTro('readAttachment', 'Xem tệp đính kèm (ĐKKD/CCCD/QR)', 'quanly-api chưa có route đọc đính kèm.');
  },

  // ── Hồ sơ HKD ────────────────────────────────────────────────────────────────────────────────────────
  dossierSourceList: () => httpCall('GET', '/v1/dossier-sources'),
  dossierSourceCreate: (input: unknown) => httpCall('POST', '/v1/dossier-sources', input),
  dossierSourceUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/dossier-sources/${id}`, input),
  dossierSourceDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/dossier-sources', { ids, password }),

  // [B180] keo HET trang - may chu cat mac dinh 100 dong, man nao khong tu phan trang ma goi
  // thang se MAT du lieu cam (xem B179: so 114 TID, man chi thay 100).
  dossierList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/dossiers${qs(rec(f))}`), filter),
  dossierCreate: (input: unknown) => httpCall('POST', '/v1/dossiers', input),
  dossierUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/dossiers/${id}`, input),
  dossierDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/dossiers', { ids, password }),

  // ── Cấu hình TID ─────────────────────────────────────────────────────────────────────────────────────
  tidStatusList: () => httpCall('GET', '/v1/tid-statuses'),
  tidStatusCreate: (input: unknown) => httpCall('POST', '/v1/tid-statuses', input),
  tidStatusUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/tid-statuses/${id}`, input),
  tidStatusDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/tid-statuses', { ids, password }),

  tidConfigList: (filter: unknown) => httpCall('GET', `/v1/tid-configs${qs(rec(filter))}`),
  tidConfigCreate: (input: unknown) => httpCall('POST', '/v1/tid-configs', input),
  tidConfigUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/tid-configs/${id}`, input),
  tidRename: (id: number, newTid: string, password: string, expectedUpdatedAt?: string | null) =>
    httpCall('POST', `/v1/tid-configs/${id}/rename`, { newTid, password, expectedUpdatedAt }),

  // ── Ngành nghề + Bill giải trình ─────────────────────────────────────────────────────────────────────
  industryList: (filter: unknown) => httpCall('GET', `/v1/industries${qs(rec(filter))}`),
  industryCreate: (input: unknown) => httpCall('POST', '/v1/industries', input),
  industryUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/industries/${id}`, input),
  industryDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/industries', { ids, password }),
  // [B180] keo HET trang - may chu cat mac dinh 100 dong, man nao khong tu phan trang ma goi
  // thang se MAT du lieu cam (xem B179: so 114 TID, man chi thay 100).
  productList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/products${qs(rec(f))}`), filter),
  productCreate: (input: unknown) => httpCall('POST', '/v1/products', input),
  productUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/products/${id}`, input),
  productDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/products', { ids, password }),
  productImport: (industryId: number, rows: unknown[]) => httpCall('POST', '/v1/products/import', { industryId, rows }),
  // ⚠️ [HYBRID — DÍNH SỐ HÓA ĐƠN, CẤM GỌI NỬA ĐƯỜNG] Desktop làm 3 bước: (1) POST /v1/bill-explain/reserve =
  // GHI DB, cấp DẢI SỐ HÓA ĐƠN atomic → (2) render .xlsx CỤC BỘ ở main → (3) POST /record. Bản web KHÔNG làm nổi
  // bước (2) (render cần template .xlsx trên đĩa + thư mục xuất của máy). Nếu shim cứ gọi bước (1) thì DẢI SỐ HÓA
  // ĐƠN BỊ CẤP RỒI BỎ (nhảy quãng) mà người dùng không hề có file ⇒ CHẶN NGAY, KHÔNG gọi HTTP nào.
  billExplainGenerate: async (input: unknown) => {
    void input;
    return khongHoTro(
      'billExplainGenerate',
      'Sinh bill giải trình',
      'Bước render file .xlsx chạy trên máy (template + thư mục xuất). Gọi từ web sẽ ĐỐT dải số hóa đơn mà không ra file — nên bị chặn.'
    );
  },
  // [B180] keo HET trang - may chu cat mac dinh 100 dong, man nao khong tu phan trang ma goi
  // thang se MAT du lieu cam (xem B179: so 114 TID, man chi thay 100).
  billExplainList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/bill-explains${qs(rec(f))}`), filter),
  billExplainDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/bill-explains', { ids, password }),
  // [HYBRID] Phần SỐ HÓA ĐƠN nằm ở DB (đọc được qua HTTP); phần thư-mục-xuất/mẫu là PER-MACHINE → web KHÔNG có.
  // Trả thật: billNoStart/billNoYear từ server, outputDir/templatePath RỖNG (không bịa đường dẫn) + log rõ.
  billExplainConfig: async () => {
    const db = await httpCall('GET', '/v1/bill-explain/config');
    if (!db || !db.ok) return db || { ok: false, error: 'NETWORK', message: 'Không kết nối được máy chủ.' };
    console.warn('[web-shim] window.api.billExplainConfig(): thư mục xuất + mẫu hóa đơn là của TỪNG MÁY (Electron) — bản web trả rỗng, KHÔNG bịa đường dẫn.');
    return {
      ok: true,
      data: {
        outputDir: '',
        billNoStart: db.data?.billNoStart ?? 1,
        billNoYear: db.data?.billNoYear ?? new Date().getFullYear(),
        templatePath: '',
        templateIsCustom: false
      }
    };
  },
  // [HYBRID] outputDir = per-machine → chặn tường minh. billNoStart/billNoYear = DB → cho qua HTTP như desktop.
  billExplainSetConfig: async (input: unknown) => {
    const i = rec(input);
    if (i['outputDir'] !== undefined) {
      return khongHoTro('billExplainSetConfig(outputDir)', 'Đổi thư mục xuất bill', 'Thư mục xuất thuộc từng máy — đặt ở bản desktop.');
    }
    const dbInput: Record<string, unknown> = {};
    if (i['billNoStart'] !== undefined) dbInput.billNoStart = i['billNoStart'];
    if (i['billNoYear'] !== undefined) dbInput.billNoYear = i['billNoYear'];
    if (Object.keys(dbInput).length) return httpCall('PUT', '/v1/bill-explain/config', dbInput);
    return { ok: true };
  },
  // [IPC-ONLY] 3 thao tác FILE MẪU + 2 thao tác MỞ FILE/THƯ MỤC cục bộ — không có trên web.
  billExplainImportTemplate: async () => khongHoTro('billExplainImportTemplate', 'Nhập mẫu hóa đơn từ file', 'Dùng bản desktop.'),
  billExplainResetTemplate: async () => khongHoTro('billExplainResetTemplate', 'Khôi phục mẫu hóa đơn gốc', 'Dùng bản desktop.'),
  billExplainExportTemplate: async () => khongHoTro('billExplainExportTemplate', 'Xuất mẫu hóa đơn ra file', 'Dùng bản desktop.'),
  billExplainOpenFile: async (filePath: string) => {
    void filePath;
    return khongHoTro('billExplainOpenFile', 'Mở file bill trên máy', 'Trình duyệt không mở được file trên đĩa máy chủ.');
  },
  billExplainOpenFolder: async () => khongHoTro('billExplainOpenFolder', 'Mở thư mục xuất bill', 'Trình duyệt không mở được thư mục trên máy.'),

  // ── Thu–Chi ──────────────────────────────────────────────────────────────────────────────────────────
  cashCategoryList: (filter: unknown) => httpCall('GET', `/v1/cash-categories${qs(rec(filter))}`),
  cashCategoryCreate: (input: unknown) => httpCall('POST', '/v1/cash-categories', input),
  cashCategoryUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/cash-categories/${id}`, input),
  cashCategoryDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/cash-categories', { ids, password }),
  fundList: (filter: unknown) => httpCall('GET', `/v1/funds${qs(rec(filter))}`),
  fundUserLite: () => httpCall('GET', '/v1/cashflow-users/lite'),
  fundCreate: (input: unknown) => httpCall('POST', '/v1/funds', input),
  fundUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/funds/${id}`, input),
  fundDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/funds', { ids, password }),
  // [B180] keo HET trang - may chu cat mac dinh 100 dong, man nao khong tu phan trang ma goi
  // thang se MAT du lieu cam (xem B179: so 114 TID, man chi thay 100).
  cashEntryList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/cash-entries${qs(rec(f))}`), filter),
  cashEntryReport: (filter: unknown) => httpCall('GET', `/v1/cash-entries/report${qs(rec(filter))}`),
  cashEntryCategoryLite: () => httpCall('GET', '/v1/cash-entries/categories-lite'),
  cashEntryPartnerLite: () => httpCall('GET', '/v1/cash-entries/partners-lite'),
  cashEntryCreate: (input: unknown) => httpCall('POST', '/v1/cash-entries', input),
  cashEntryCreateDebtReceipt: (input: unknown) => httpCall('POST', '/v1/cash-entries/debt-receipt', input),
  cashEntryCancel: (id: number, reason: string, password: string) => httpCall('POST', `/v1/cash-entries/${id}/cancel`, { reason, password }),

  // ── XUẤT EXCEL ───────────────────────────────────────────────────────────────────────────────────────
  // [IPC-ONLY → TẢI VỀ] Desktop: main dựng workbook (exceljs) + hộp thoại Lưu + mở bằng Excel.
  // Web: dựng workbook bằng CHÍNH 2 hàm đó (`main/export-service.ts` chỉ phụ thuộc exceljs+jszip, KHÔNG node:fs
  // → bundle được cho trình duyệt) ⇒ ĐỊNH DẠNG CHUẨN NHÀ GIỮ NGUYÊN, rồi `<a download>` cho trình duyệt lưu.
  // KHÔNG trả `path` (web không biết chỗ trình duyệt lưu) → exportCsv.ts/excelImport.ts thấy `!res.path` nên
  // KHÔNG hỏi "mở file ngay?" (vô nghĩa trên web). Lỗi dựng workbook vẫn trả ok:false + message → UI báo lỗi.
  reportExport: async (p) => {
    try {
      const buf =
        p.kind === 'template'
          ? await buildTemplateWorkbook({ title: p.title, headers: p.headers, hints: p.hints, chon: p.chon })
          // [B228 22/11] Bản WEB phải đi CÙNG đường với desktop: có `sheets` thì xuất nhiều tab, không thì
          // một tab kèm khối phụ. Quên chỗ này là web xuất thiếu tab mà không ai báo (lớp lỗi "fix chỗ nọ quên kia").
          : p.sheets && p.sheets.length > 0
            ? await buildMultiSheetWorkbook(p.sheets as Parameters<typeof buildMultiSheetWorkbook>[0])
            : await buildReportWorkbook({ title: p.title, headers: p.headers, rows: p.rows ?? [], summary: p.summary, khoiPhu: p.khoiPhu, cotTien: p.cotTien, cotRong: p.cotRong, cotGiua: p.cotGiua });
      taiVeFile(p.fileName, buf as unknown as Uint8Array);
      console.info(`[web-shim] window.api.reportExport(): đã đẩy "${p.fileName}" cho trình duyệt tải về (thư mục Tải xuống).`);
      // CỐ TÌNH KHÔNG trả `path`: trình duyệt không cho biết chỗ lưu. exportCsv.ts/excelImport.ts gặp `!res.path`
      // sẽ dừng im lặng (không hỏi "mở file ngay?") — người dùng thấy file ở khay Tải xuống của trình duyệt.
      return { ok: true };
    } catch (e) {
      const message = 'Không xuất được Excel: ' + (e instanceof Error ? e.message : String(e));
      console.error('[web-shim] window.api.reportExport() LỖI —', message);
      return { ok: false, error: 'EXPORT_FAILED', message };
    }
  },
  // [B231 22/11] Bản WEB không chọn được thư mục → tải LẦN LƯỢT từng file vào thư mục Tải xuống.
  // Phải chờ giữa 2 lần tải: bắn liên tiếp thì trình duyệt chặn các file sau mà KHÔNG báo gì.
  reportExportNhieuFile: async (p: { files: { fileName: string; sheet: unknown }[] }) => {
    try {
      let n = 0;
      for (const f of p.files) {
        const buf = await buildReportWorkbook(f.sheet as Parameters<typeof buildReportWorkbook>[0]);
        taiVeFile(f.fileName, buf as unknown as Uint8Array);
        n++;
        await new Promise((r) => setTimeout(r, 400));
      }
      console.info(`[web-shim] reportExportNhieuFile(): đã đẩy ${n} file cho trình duyệt tải về.`);
      return { ok: true, soFile: n };
    } catch (e) {
      const message = 'Không xuất được Excel: ' + (e instanceof Error ? e.message : String(e));
      console.error('[web-shim] reportExportNhieuFile() LỖI —', message);
      return { ok: false, error: 'EXPORT_FAILED', message };
    }
  },
  // [IPC-ONLY → TẢI VỀ] Báo cáo CHI TIẾT NĐT — dùng CHÍNH builder dùng chung @sigma/services (desktop + bot-api).
  investorDetailExport: async (p: { fileName: string; data: unknown }) => {
    try {
      const buf = await buildInvestorDetailWorkbook(p.data as InvestorDetailData | InvestorDetailData[]);
      taiVeFile(p.fileName, buf as unknown as Uint8Array);
      console.info(`[web-shim] window.api.investorDetailExport(): đã đẩy "${p.fileName}" cho trình duyệt tải về.`);
      return { ok: true };
    } catch (e) {
      const message = 'Không xuất được báo cáo NĐT: ' + (e instanceof Error ? e.message : String(e));
      console.error('[web-shim] window.api.investorDetailExport() LỖI —', message);
      return { ok: false, error: 'EXPORT_FAILED', message };
    }
  },
  // [IPC-ONLY] Mở file trên đĩa bằng app mặc định — trình duyệt không làm được (và không nên làm được).
  openFilePath: async (path: string) => {
    void path;
    const message = 'Bản web không mở được file trên máy. File đã tải về thư mục Tải xuống của trình duyệt.';
    console.warn('[web-shim] window.api.openFilePath():', message);
    return { ok: false, message };
  },

  // ── Nhập Excel ───────────────────────────────────────────────────────────────────────────────────────
  importTemplate: (entityKey: string) => httpCall('GET', `/v1/import/template${qs({ entityKey })}`),
  importDryRun: (entityKey: string, rows: Record<string, unknown>[]) => httpCall('POST', '/v1/import/dry-run', { entityKey, rows }),
  importRun: (entityKey: string, rows: Record<string, unknown>[]) => httpCall('POST', '/v1/import/run', { entityKey, rows }),

  // ── Thùng rác ────────────────────────────────────────────────────────────────────────────────────────
  trashList: () => httpCall('GET', '/v1/trash'),
  trashRestore: (entityType: string, id: number) => httpCall('POST', '/v1/trash/restore', { entityType, id }),
  trashLinkSummary: (entityType: string, id: number) => httpCall('GET', `/v1/trash/link-summary${qs({ entityType, id })}`),
  trashPurge: (entityType: string, id: number, password: string) => httpCall('POST', '/v1/trash/purge', { entityType, id, password }),
  trashEmptyAll: (level2Password: string) => httpCall('POST', '/v1/trash/empty', { level2Password }),

  // ── Dashboard ────────────────────────────────────────────────────────────────────────────────────────
  dashboardStats: () => httpCall('GET', '/v1/dashboard/stats'),
  dashboardProfit: () => httpCall('GET', '/v1/dashboard/profit'),

  // ── Hòm thư nội bộ ───────────────────────────────────────────────────────────────────────────────────
  messageInbox: () => httpCall('GET', '/v1/messages'),
  messageUnreadCount: () => httpCall('GET', '/v1/messages/unread-count'),
  messageMarkRead: (id: number) => httpCall('POST', `/v1/messages/${id}/read`),
  messageMarkAllRead: () => httpCall('POST', '/v1/messages/read-all'),
  messageSend: (input: { recipientId: number; subject: string; body: string }) => httpCall('POST', '/v1/messages', input),

  // ── Doanh thu & Công nợ ──────────────────────────────────────────────────────────────────────────────
  transactionList: (filter: unknown) => httpCall('GET', `/v1/transactions${qs(rec(filter))}`),
  transactionCreate: (input: unknown) => httpCall('POST', '/v1/transactions', input),
  revenueByFeeType: (filter: unknown) => httpCall('GET', `/v1/transactions/revenue-by-fee-type${qs(rec(filter))}`),
  transactionDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/transactions', { ids, password }),
  debtSummary: (filter: unknown) => httpCall('GET', `/v1/debt/summary${qs(rec(filter))}`),
  debtOpenTransactions: (filter: unknown) => httpCall('GET', `/v1/debt/open-transactions${qs(rec(filter))}`),
  debtByQuality: (filter: unknown) => httpCall('GET', `/v1/debt/by-quality${qs(rec(filter))}`),
  debtClassify: (transactionId: number, quality: string, reason?: string) => httpCall('POST', '/v1/debt/classify', { transactionId, quality, reason }),
  debtQualityHistory: (transactionId: number) => httpCall('GET', `/v1/debt/${transactionId}/quality-history`),
  debtWriteOff: (transactionId: number, actorPassword: string) => httpCall('POST', '/v1/debt/write-off', { transactionId, actorPassword }),

  // ── Duyệt hủy / xuất kho ─────────────────────────────────────────────────────────────────────────────
  cancelRequest: (transactionId: number, reason: string) => httpCall('POST', '/v1/cancel-requests', { transactionId, reason }),
  cancelRequestList: (status?: string) => httpCall('GET', `/v1/cancel-requests${qs({ status })}`),
  globalSearch: (q: string) => httpCall('GET', `/v1/search${qs({ q })}`),
  // [IPC-ONLY] Chụp vùng màn hình bằng desktopCapturer của Electron + lưu Pictures/SigMa-Screenshots.
  captureRegion: async (opts?: { hideApp?: boolean }) => {
    void opts;
    return khongHoTro('captureRegion', 'Chụp vùng màn hình', 'Dùng công cụ chụp của Windows (Win+Shift+S).');
  },
  openScreenshotDir: async () => {
    ghiLogVoHai('openScreenshotDir', 'mở thư mục ảnh chụp trên máy');
    return { ok: false };
  },
  cancelApprove: (requestId: number, password: string, note?: string) => httpCall('POST', `/v1/cancel-requests/${requestId}/approve`, { password, note }),
  cancelReject: (requestId: number, note: string) => httpCall('POST', `/v1/cancel-requests/${requestId}/reject`, { note }),
  cancelApproveBulk: (requestIds: number[], password: string, note?: string) => httpCall('POST', '/v1/cancel-requests/approve-bulk', { requestIds, password, note }),
  cancelRejectBulk: (requestIds: number[], note: string) => httpCall('POST', '/v1/cancel-requests/reject-bulk', { requestIds, note }),
  entityCancelRequest: (entityType: string, entityId: number, reason: string) => httpCall('POST', '/v1/entity-cancel-requests', { entityType, entityId, reason }),
  entityCancelList: (status?: string, entityType?: string) => httpCall('GET', `/v1/entity-cancel-requests${qs({ status, entityType })}`),
  entityCancelApprove: (entityType: string, requestId: number, password: string, note?: string) =>
    httpCall('POST', `/v1/entity-cancel-requests/${requestId}/approve`, { entityType, password, note }),
  entityCancelApproveBulk: (items: { entityType: string; id: number }[], password: string, note?: string) =>
    httpCall('POST', '/v1/entity-cancel-requests/approve-bulk', { items, password, note }),
  entityCancelReject: (entityType: string, requestId: number, note: string) =>
    httpCall('POST', `/v1/entity-cancel-requests/${requestId}/reject`, { entityType, note }),
  exportReqCreate: (input: unknown) => httpCall('POST', '/v1/export-requests', input),
  exportReqList: (filter?: unknown) => httpCall('GET', `/v1/export-requests${qs(rec(filter))}`),
  exportReqApprove: (requestId: number, lines: unknown, password: string, note?: string) =>
    httpCall('POST', `/v1/export-requests/${requestId}/approve`, { lines, password, note }),
  exportReqReject: (requestId: number, note: string) => httpCall('POST', `/v1/export-requests/${requestId}/reject`, { note }),
  exportReqCancel: (requestId: number, note?: string) => httpCall('POST', `/v1/export-requests/${requestId}/cancel`, { note }),

  // ── Bảo trì & Bộ nhớ ─────────────────────────────────────────────────────────────────────────────────
  storageStatus: () => httpCall('GET', '/v1/storage/status'),
  storageCleanup: (opts: { clearHistory?: boolean; purgeTrash?: boolean; password: string }) => httpCall('POST', '/v1/storage/cleanup', opts),
  storageUpdateConfig: (cfg: unknown) => httpCall('PATCH', '/v1/storage/config', cfg),
  healthScan: (opts: { autoFix?: boolean }) => httpCall('POST', '/v1/health/run', { autoFix: opts?.autoFix }),
  healthRuns: (limit?: number) => httpCall('GET', `/v1/health/runs${qs({ limit })}`),
  // [IPC-ONLY] Chi tiết 1 lần quét: quanly-api CHƯA có route GET /v1/health/runs/:id (chỉ /scan, /runs, /run).
  healthRun: async (id: number) => {
    void id;
    return khongHoTro('healthRun', 'Xem chi tiết một lần quét sức khỏe', 'quanly-api chưa có route GET /v1/health/runs/:id.');
  },

  // ── [IPC-ONLY] electron-updater — KHÔNG có trên web (UpdateBanner đã bị ẩn bằng cờ coDesktop) ────────
  // getAppVersion trả version ĐÓNG VÀO BẢN BUILD (đọc từ apps/desktop/package.json lúc build) — số THẬT của
  // chính mã nguồn đang chạy, KHÔNG bịa.
  getAppVersion: async () => __SIGMA_WEB_VERSION__,
  // [B226] Bản WEB không có bộ cập nhật — trả ok:false kèm lý do RÕ, không trả rỗng để màn hình
  // tưởng "đã hỏi xong, đang dùng bản mới nhất" (nút này vốn đã ẩn trên web, đây là lưới an toàn).
  checkUpdate: async () => {
    ghiLogVoHai('checkUpdate', 'cập nhật phần mềm (electron-updater)');
    return { ok: false, message: 'Bản web không tự cập nhật — hãy tải bản cài đặt mới từ trang tải về.' };
  },
  startUpdate: async () => ghiLogVoHai('startUpdate', 'cập nhật phần mềm (electron-updater)'),
  installUpdateNow: async () => ghiLogVoHai('installUpdateNow', 'cập nhật phần mềm (electron-updater)'),
  getUpdateBootResult: async () => null,
  getLastAvailableUpdate: async () => null,
  onUpdateAvailable: () => huyRong,
  onDownloadProgress: () => huyRong,
  onUpdateDownloaded: () => huyRong,
  onUpdateError: () => huyRong,

  // ── [IPC-ONLY] Nút cửa sổ tự vẽ (đỏ/vàng/lục) — trình duyệt không cho script đóng/thu nhỏ tab ──────────
  // TitleBar.tsx đã ẩn cụm nút này trên web (cờ coDesktop). Các hàm còn đây để GIỮ ĐỦ bề mặt GlbApi.
  windowMinimize: async () => ghiLogVoHai('windowMinimize', 'thu nhỏ cửa sổ'),
  // App.tsx gọi windowToggleMaximize/windowIsMaximized để biết trạng thái — trên web trang LUÔN chiếm hết khung.
  windowToggleMaximize: async () => {
    ghiLogVoHai('windowToggleMaximize', 'phóng to/khôi phục cửa sổ');
    return true;
  },
  windowMaximize: async () => ghiLogVoHai('windowMaximize', 'phóng to cửa sổ'),
  windowClose: async () => ghiLogVoHai('windowClose', 'đóng cửa sổ'),
  windowIsMaximized: async () => true,
  onWindowMaximized: () => huyRong
};

/**
 * Gắn shim vào `window` TRƯỚC khi React mount (renderer gọi window.api ngay trong useEffect đầu tiên),
 * và bật cờ `__SIGMA_WEB__` cho `renderer/src/lib/platform.ts` nhận biết nền tảng.
 */
export function capDatWindowApi(): void {
  (window as unknown as { __SIGMA_WEB__?: boolean }).__SIGMA_WEB__ = true;
  (window as unknown as { api: GlbApi }).api = api;
  console.info(`[web-shim] SigMa — BẢN WEB v${__SIGMA_WEB_VERSION__} · API = ${API_BASE}`);
}

export { api as webApi, API_BASE };
