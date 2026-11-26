// Preload — the ONLY bridge between renderer and main. Exposes a typed `window.api`.
//
// ── MIGRATION IPC → HTTP (giữ nguyên bề mặt `window.api`) ─────────────────────────────────────────────
// Trước: mỗi method gọi `ipcRenderer.invoke('domain:action', args)` → handler trong main → @sigma/services → DB.
// Nay: các method NGHIỆP VỤ (CRUD/đọc/ghi dữ liệu) gọi thẳng REST API `quanly-api` qua `httpCall(...)`, GIỮ
// NGUYÊN tên method + tham số + kiểu trả Promise để 344 lời gọi ở renderer KHÔNG phải sửa 1 dòng nào.
//
// httpCall trả về `await res.json()` BẤT KỂ HTTP status (route trả body `{ok,...}` cho cả 400/403/404/409 qua
// statusFor) → renderer nhận đúng shape `{ok,data,...}` y như thời `ipcRenderer.invoke`. Lỗi mạng (fetch throw)
// → `{ok:false,error:'NETWORK',...}`; body không phải JSON (vd 502 Cloudflare) → `{ok:false,error:'BAD_RESPONSE'}`.
// Cookie phiên `ql_session` (httpOnly, SameSite=None) do trình duyệt tự quản nhờ `credentials:'include'`.
//
// API_BASE — thứ tự ưu tiên (4/8, kiến trúc HTTP): (a) biến môi trường `SIGMA_API_BASE` (test/dev, vd
// http://localhost:8790) → (b) apiBaseUrl người dùng nhập ở màn "Cấu hình máy chủ", lấy qua IPC
// `config:apiBase` (cache sau lần đầu) → (c) DEFAULT_API_BASE (domain Cloudflare ghi ở
// apps/quanly-api/src/app.ts: alpha-quanly-api.example.com). Chưa cấu hình + không có env → dùng default.
//
// ── CÁC METHOD GIỮ NGUYÊN `ipcRenderer.invoke` (phải chạy trong MAIN, KHÔNG có REST endpoint) ─────────────
//  • Sự kiện push (main→renderer): onUpdateAvailable, onDownloadProgress, onUpdateDownloaded, onUpdateError,
//    onWindowMaximized.
//  • Điều khiển cửa sổ: windowMinimize, windowToggleMaximize, windowClose, windowIsMaximized.
//  • Updater electron: getAppVersion, checkUpdate, startUpdate, installUpdateNow, getUpdateBootResult,
//    getLastAvailableUpdate.
//  • File/dialog/hệ điều hành: pickImage, readAttachment, openFilePath, reportExport, agentSetQrImage,
//    billExplainOpenFile, billExplainOpenFolder, billExplainImportTemplate, billExplainExportTemplate,
//    billExplainResetTemplate, openScreenshotDir, captureRegion.
//  • serverConfig: serverConfigGet, serverConfigTest, serverConfigSave.
//  • Credential nhớ máy (SafeStorage cục bộ): getRemembered, loginRemembered, saveRemembered, clearRemembered.
//  • Sao lưu cục bộ/phá hủy (file từ ĐĨA CLIENT): backupRestore.
//
// ── GIỮ IPC vì quanly-api CHƯA có route (TENTATIVE — xem cuối file/report cho LEAD) ─────────────────────
//  • Ảnh QR đại lý: agentGetQrImage.
//  • Thông báo đẩy nền: notifyPushUndelivered.
//  • Bill giải trình (thao tác sinh bill/file cục bộ): billExplainGenerate, billExplainConfig, billExplainSetConfig.
//  • Chi tiết 1 lần quét sức khỏe: healthRun(id) (route chỉ có GET /scan, GET /runs, POST /run — KHÔNG /runs/:id).
import { keoHetTrang } from '../shared/keo-het-danh-sach.js';
import { contextBridge, ipcRenderer } from 'electron';
import { validatePassword as checkPasswordStrength } from '@sigma/shared'; // B132 A1-2: kiểm ĐỘ MẠNH mật khẩu là PURE client-side (không server)

// ── HTTP bridge (thay ipcRenderer.invoke cho method nghiệp vụ) ────────────────────────────────────────
const DEFAULT_API_BASE = 'https://alpha-quanly-api.example.com';
const stripTrail = (s: string): string => s.replace(/\/+$/, '');

/** Giải địa chỉ máy chủ API theo thứ tự ưu tiên (env → cấu hình người dùng → default). */
async function resolveApiBase(): Promise<string> {
  const env = (typeof process !== 'undefined' && process.env && process.env.SIGMA_API_BASE) || '';
  if (env) return stripTrail(env);
  try {
    const configured = await ipcRenderer.invoke('config:apiBase');
    if (typeof configured === 'string' && configured.trim()) return stripTrail(configured.trim());
  } catch {
    /* IPC lỗi → fallback domain mặc định */
  }
  return stripTrail(DEFAULT_API_BASE);
}

/**
 * THẺ DỊCH VỤ Cloudflare Access — đọc 1 lần/đời tiến trình. `null` = máy chưa cấu hình ⇒ KHÔNG gửi header
 * (hành vi y hệt trước khi có tính năng này), để bật dần từng máy mà không ai mất kết nối.
 */
let cfPromise: Promise<{ id: string; secret: string } | null> | undefined;
function cfAccess(): Promise<{ id: string; secret: string } | null> {
  if (!cfPromise) {
    cfPromise = ipcRenderer
      .invoke('config:cfAccess')
      .then((v: unknown) => {
        const c = v as { id?: unknown; secret?: unknown } | null;
        return typeof c?.id === 'string' && typeof c?.secret === 'string' && c.id && c.secret
          ? { id: c.id, secret: c.secret }
          : null;
      })
      .catch(() => null);
  }
  return cfPromise;
}

/** KHOÁ THIẾT BỊ (GUID 1-cài-đặt, main giữ trong userData) — đọc 1 lần/đời tiến trình. */
let thietBiPromise: Promise<string> | undefined;
function khoaThietBi(): Promise<string> {
  if (!thietBiPromise) {
    thietBiPromise = ipcRenderer
      .invoke('config:deviceId')
      .then((v: unknown) => (typeof v === 'string' ? v : ''))
      .catch(() => '');
  }
  return thietBiPromise;
}

// Cache promise sau lần đầu (đọc cấu hình 1 lần/đời tiến trình preload) — httpCall await.
let apiBasePromise: Promise<string> | undefined;
function apiBase(): Promise<string> {
  if (!apiBasePromise) apiBasePromise = resolveApiBase();
  return apiBasePromise;
}
const enc = encodeURIComponent;

/** Ghép query-string từ object filter (bỏ undefined/null/'', boolean→'true'/'false', số/mảng→String). */
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
 * Gọi REST quanly-api. Trả BODY JSON ({ok,...}) BẤT KỂ status (route đã map lỗi nghiệp vụ → body qua statusFor;
 * KHÔNG throw ở 4xx để renderer nhận đúng shape cũ). fetch throw (mất mạng) → NETWORK; body phi-JSON → BAD_RESPONSE.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function httpCall(method: string, path: string, body?: unknown): Promise<any> {
  const init: RequestInit = {
    method,
    credentials: 'include',
    // X-SigMa-Client (audit 20/8, CSRF) — header TÙY BIẾN: trình duyệt BẮT BUỘC preflight cho header non-simple và
    // KHÔNG thể giả mạo cross-site (<form>/sandboxed-iframe không set được header tùy biến). Client hợp lệ (desktop
    // + web) LUÔN gửi. Server sẽ BẮT BUỘC header này trên đường GHI khi bật cờ SIGMA_ENFORCE_CLIENT_HEADER (xem
    // app.ts) — đóng vector Origin:null+json còn lại. Gửi SẴN ở đây trước để enable phía server không phá client.
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-SigMa-Client': '1' }
  };
  // THẺ DỊCH VỤ Cloudflare Access (nếu máy đã cấu hình) — để khi bật Access ở cổng, máy nhà vẫn vào được.
  const maMay = await khoaThietBi();
  if (maMay) (init.headers as Record<string, string>)['X-SigMa-Device'] = maMay;
  const cf = await cfAccess();
  if (cf) {
    (init.headers as Record<string, string>)['CF-Access-Client-Id'] = cf.id;
    (init.headers as Record<string, string>)['CF-Access-Client-Secret'] = cf.secret;
  }
  if (body !== undefined) init.body = JSON.stringify(body);
  // [B303/F3 24/11 — agent Electron đo thật] HẠN GIỜ: máy chủ NHẬN kết nối rồi im (Postgres đang
  // crash-recovery / tunnel nửa sống) là fetch treo VÔ HẠN — app có ≥8 bộ đếm tự gọi lại, mỗi nhịp đẻ
  // thêm 1 request treo, Chromium trần 6 kết nối/host ⇒ ~1 phút là đứng hình toàn app, câm. Đọc 25s,
  // ghi 60s (lệnh ghi tiền cho máy chủ đủ thời gian làm xong — hủy giữa chừng còn nguy hơn).
  const laGhi = method !== 'GET';
  init.signal = AbortSignal.timeout(laGhi ? 60000 : 25000);
  let res: Response;
  try {
    res = await fetch((await apiBase()) + path, init);
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      return { ok: false, error: 'TIMEOUT', message: 'Máy chủ nhận lệnh nhưng CHƯA trả lời sau ' + (laGhi ? 60 : 25) + ' giây — có thể cơ sở dữ liệu đang khởi động lại. ' + (laGhi ? 'ĐỪNG bấm lại ngay: bấm Làm mới kiểm tra lệnh đã vào sổ chưa.' : 'Thử Làm mới sau ít phút.') };
    }
    return { ok: false, error: 'NETWORK', message: 'Không kết nối được máy chủ. Kiểm tra mạng và cấu hình máy chủ rồi thử lại.' };
  }
  // BỊ CỔNG GÁC CHẶN: Cloudflare Access trả 302 về trang đăng nhập hoặc 403 kèm HTML, KHÔNG phải JSON của
  // mình. Nói thẳng nguyên nhân, đừng để app hiện "máy chủ lỗi" rồi cả 8 máy loay hoay không biết vì sao.
  if (res.status === 403 || res.status === 401) {
    const loaiND = res.headers.get('content-type') ?? '';
    if (!loaiND.includes('application/json')) {
      return {
        ok: false,
        error: 'ACCESS_BLOCKED',
        message: cf
          ? 'Cổng bảo mật từ chối thẻ của máy này (Cloudflare Access). Kiểm tra lại thẻ dịch vụ trong Cấu hình máy chủ.'
          : 'Máy chủ đã bật cổng bảo mật nhưng máy này CHƯA được cấp thẻ. Vào Cấu hình máy chủ để nhập thẻ dịch vụ.'
      };
    }
  }
  try {
    return await res.json();
  } catch {
    return { ok: false, error: 'BAD_RESPONSE', message: `Máy chủ trả về dữ liệu không hợp lệ (HTTP ${res.status}).` };
  }
}

/** Cast tiện dụng: filter/input `unknown` → Record cho qs()/spread body. */
function rec(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

/** Query string cho báo cáo tiền chờ: tuThang/denThang + các bộ lọc mảng (lặp `key=`) + hkd (lặp, KHÔNG tách phẩy). */
function tienChoQs(filter: unknown): string {
  const f = rec(filter);
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

const api = {
  // Auth — login/me/logout/realtimeTokens qua HTTP; cookie phiên tự quản. "Nhớ máy" vẫn dùng IPC SafeStorage
  // cục bộ (không có ở API): sau khi HTTP login OK thì persist/clear creds như main cũ. `force` (single-session
  // R46) CHƯA hỗ trợ ở API → bỏ qua (TENTATIVE).
  login: async (username: string, password: string, remember: boolean, force?: boolean) => {
    void force;
    const res = await httpCall('POST', '/v1/auth/login', { username, password });
    if (res && res.ok) {
      if (remember) await ipcRenderer.invoke('auth:saveRemembered', { username, password });
      else await ipcRenderer.invoke('auth:clearRemembered');
    }
    return res;
  },
  me: () => httpCall('GET', '/v1/auth/me'),
  // NHẬP BILL LẺ THỦ CÔNG (màn Doanh Số) — đi CHUNG đường ghi với bill OCR (createLoFromBillTid).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  billManualCreate: (input: any) => httpCall('POST', '/v1/bills/manual', input),
  // Danh sách bill theo kỳ — ĐỌC THẲNG TỪ SỔ, không dựng lại số ở client.
  // [DOANH SỐ TIỀN CHỜ 24/11] `nhomPhi` tuỳ chọn, backward-compat: 'tiencho' = chỉ bill Tiền chờ(8)/Uỷ quyền(9);
  // bỏ trống / 'thuong' = chỉ bill thường (≠8,9). Màn Doanh Số thường KHÔNG truyền → giữ nguyên hành vi cũ.
  billManualList: (from: string, to: string, nhomPhi?: string) =>
    httpCall('GET', `/v1/bills/manual?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${nhomPhi ? `&nhomPhi=${encodeURIComponent(nhomPhi)}` : ''}`),
  // [DOANH SỐ TIỀN CHỜ 24/11] TID đã khai giá bán loại phí Tiền chờ(8)/Uỷ quyền(9) — picker màn tiền chờ CHỈ hiện tập này.
  billManualTidsTienCho: () => httpCall('GET', '/v1/bills/manual/tids-tiencho'),
  // KPI Doanh Số (tab full-view) — ĐỌC THẲNG TỪ SỔ theo kỳ + (tuỳ chọn) ca.
  kpiDoanhSo: (from: string, to: string, ca?: number | null) =>
    httpCall('GET', `/v1/kpi/doanh-so?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${ca != null ? `&ca=${ca}` : ''}`),
  // DOANH SỐ TIỀN CHỜ / CÔNG NỢ PHẢI THU ỦY QUYỀN (Admin Demo 24/11) — nhập TỔNG/tháng + báo cáo + xoá. HTTP thuần.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tienChoNhap: (input: any) => httpCall('POST', '/v1/tien-cho', input),
  tienChoXoa: (id: number, password: string) => httpCall('DELETE', `/v1/tien-cho/${id}`, { password }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tienChoBaoCao: (filter: any) => httpCall('GET', `/v1/tien-cho/bao-cao${tienChoQs(filter)}`),
  logout: () => httpCall('POST', '/v1/auth/logout'),
  // Auth phụ (auth-extras.ts): heartbeat/online-users + đổi/đặt-lại mật khẩu + mật khẩu cấp 2 + validate — HTTP.
  sessionHeartbeat: () => httpCall('POST', '/v1/auth/heartbeat'),
  onlineUsers: () => httpCall('GET', '/v1/auth/online-users'),
  realtimeTokens: () => httpCall('GET', '/v1/realtime/tokens'),
  // route change-password chỉ dùng {oldPassword,newPassword}; confirmPassword giữ ở signature (renderer) — bỏ khi gửi.
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
  // B132 A1-2: validatePassword = kiểm ĐỘ MẠNH mật khẩu MỚI (pure @sigma/shared, client-side) — KHÔNG phải
  // đối-chiếu-mật-khẩu-server. Renderer ForceChangePassword đọc {valid,error}. (Route server /v1/auth/validate-
  // password là gate-nhạy-cảm khác, verifyActorPassword — KHÔNG dùng cho kiểm-độ-mạnh này.)
  validatePassword: (pwd: string) => Promise.resolve(checkPasswordStrength(pwd)),
  getRemembered: () => ipcRenderer.invoke('auth:getRemembered'),
  // B132 A1-3 (fix split-brain): TRƯỚC đây loginRemembered gọi IPC main-session (`auth:loginRemembered`) → đăng
  // nhập trong MAIN, KHÔNG set cookie ql_session của RENDERER → mọi data-request sau đó 401 (đăng nhập "ảo").
  // NAY: lấy credential đã nhớ từ main (safeStorage) rồi gọi CHÍNH httpCall /v1/auth/login như login thường →
  // cookie ql_session được set trong renderer → data-request KHÔNG còn 401. `force` bỏ qua (R46 single-session:
  // login mới tự thu hồi phiên cũ ở server, không cần hỏi). Mật khẩu chỉ transit qua PRELOAD (cầu context-isolated),
  // KHÔNG lộ ra web-renderer không tin cậy.
  loginRemembered: async (force?: boolean) => {
    void force;
    const creds = (await ipcRenderer.invoke('auth:getRememberedCreds')) as { username: string; password: string } | null;
    if (!creds) return { ok: false, error: 'NO_REMEMBERED', message: 'Chưa lưu đăng nhập.' };
    const res = await httpCall('POST', '/v1/auth/login', { username: creds.username, password: creds.password });
    if (res && res.ok) await ipcRenderer.invoke('auth:saveRemembered', creds); // gia hạn bản nhớ
    return res;
  },
  saveRemembered: (username: string, password: string) =>
    ipcRenderer.invoke('auth:saveRemembered', { username, password }),
  clearRemembered: () => ipcRenderer.invoke('auth:clearRemembered'),

  // Cấu hình máy chủ (G10.3) — GIỮ IPC (chạy ở main, quản lý kết nối Postgres cục bộ).
  serverConfigGet: () => ipcRenderer.invoke('serverConfig:get'),
  // Sự cố 9/8 (cấm tái diễn): địa chỉ API HIỆU LỰC data đang nối (env → cấu hình → default) — cho badge nguồn.
  getEffectiveApiBase: () => apiBase(),
  serverConfigTest: (input: unknown) => ipcRenderer.invoke('serverConfig:test', input),
  serverConfigSave: (input: unknown) => ipcRenderer.invoke('serverConfig:save', input),

  // Roles
  roleList: () => httpCall('GET', '/v1/roles'),
  rolePermissions: () => httpCall('GET', '/v1/permissions'),
  roleCreate: (input: unknown) => httpCall('POST', '/v1/roles', input),
  roleUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/roles/${id}`, input),
  roleLock: (id: number) => httpCall('POST', `/v1/roles/${id}/lock`),
  roleUnlock: (id: number) => httpCall('POST', `/v1/roles/${id}/unlock`),
  roleDelete: (id: number, password: string) => httpCall('DELETE', `/v1/roles/${id}`, { password }),

  // Users
  userList: (filter: unknown) => httpCall('GET', `/v1/users${qs(rec(filter))}`),
  // [KẾ TOÁN NĐT 24/11] Route HẸP người hoàn (chỉ id+tên; gác REVENUE_MANAGE) — thay userList cho ô "Người hoàn".
  refundPeople: () => httpCall('GET', '/v1/refund-people'),
  userCreate: (input: unknown) => httpCall('POST', '/v1/users', input),
  userUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/users/${id}`, input),
  userLock: (id: number) => httpCall('POST', `/v1/users/${id}/lock`),
  userUnlock: (id: number) => httpCall('POST', `/v1/users/${id}/unlock`),

  // Audit
  auditList: (query: unknown) => httpCall('GET', `/v1/audit-logs${qs(rec(query))}`),

  // Backup — create/list/mirror-config qua HTTP (server tự pg_dump). GIỮ IPC: backupRestore (file từ ĐĨA CLIENT).
  backupCreate: (note?: string) => httpCall('POST', '/v1/backups', { note }),
  backupList: () => httpCall('GET', '/v1/backups'),
  backupRestore: (filePath: string, password: string) =>
    ipcRenderer.invoke('backup:restore', { filePath, password }),
  backupMirrorConfigGet: () => httpCall('GET', '/v1/backups/mirror-config'),
  backupMirrorConfigSet: (input: { mirrorDir: string | null; keep?: number }, password: string) =>
    httpCall('PUT', '/v1/backups/mirror-config', { ...rec(input), password }),

  // Settings
  settingList: () => httpCall('GET', '/v1/settings'),
  settingUpdate: (key: string, value: string) => httpCall('PUT', `/v1/settings/${enc(key)}`, { value }),

  // Customers (G-POS.1)
  // [B180] kéo HẾT trang — máy chủ cắt mặc định 100 dòng, màn nào không tự phân trang mà gọi
  // thẳng sẽ MẤT dữ liệu câm (xem B179: sổ 114 TID, màn chỉ thấy 100).
  customerList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/customers${qs(rec(f))}`), filter),
  customerCounts: () => httpCall('GET', '/v1/customers/counts'),
  customerCreate: (input: unknown) => httpCall('POST', '/v1/customers', input),
  customerUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/customers/${id}`, input),
  // Nhà đầu tư (Admin Demo 9/8) — tab trong Quản Lý Nhân Sự
  investorList: (filter: unknown) => httpCall('GET', `/v1/investors${qs(rec(filter))}`),
  investorReport: (params: unknown) => httpCall('GET', `/v1/investors/report${qs(rec(params))}`),
  investorReportDetail: (params: unknown) => httpCall('GET', `/v1/investors/report-detail${qs(rec(params))}`),
  investorSettlement: (params: unknown) => httpCall('GET', `/v1/investors/settlement${qs(rec(params))}`),
  investorCreate: (input: unknown) => httpCall('POST', '/v1/investors', input),
  investorUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/investors/${id}`, input),
  investorDelete: (id: number, password: string) => httpCall('DELETE', `/v1/investors/${id}`, { password }),
  // Nhà đầu tư — SỔ TẠM ỨNG vốn (Phase C-2a)
  advanceList: (params: unknown) => httpCall('GET', `/v1/investor-advances${qs(rec(params))}`),
  advanceCreate: (input: unknown) => httpCall('POST', '/v1/investor-advances', input),
  advanceDelete: (id: number, password: string) => httpCall('DELETE', `/v1/investor-advances/${id}`, { password }),
  // Nhà đầu tư — TK CK "đi tiền tạm ứng" (cấu hình, matching OCR phase sau)
  investorBankAccountList: (investorId: number) => httpCall('GET', `/v1/investors/${investorId}/bank-accounts`),
  investorBankAccountCreate: (investorId: number, input: unknown) => httpCall('POST', `/v1/investors/${investorId}/bank-accounts`, input),
  investorBankAccountDelete: (investorId: number, accountId: number, password: string) => httpCall('DELETE', `/v1/investors/${investorId}/bank-accounts/${accountId}`, { password }),
  // Nhóm chat riêng của NĐT (Phase E) — NĐT có nhiều nhóm tự do; gắn 1 nhóm vào TK nhận tiền khi uỷ=NĐT.
  investorChatGroupList: (investorId: number) => httpCall('GET', `/v1/investors/${investorId}/chat-groups`),
  investorChatGroupAssignable: (investorId: number) => httpCall('GET', `/v1/investors/${investorId}/chat-groups/assignable`),
  investorChatGroupCreate: (investorId: number, input: unknown) => httpCall('POST', `/v1/investors/${investorId}/chat-groups`, input),
  investorChatGroupUpdate: (groupId: number, input: unknown) => httpCall('PATCH', `/v1/investor-chat-groups/${groupId}`, input),
  investorChatGroupDelete: (groupId: number) => httpCall('DELETE', `/v1/investor-chat-groups/${groupId}`),

  // Tài khoản CON (tài khoản xem) của NĐT (Admin Demo 12/8) — R_INVESTOR gắn investorId để chia sẻ quyền xem báo cáo.
  investorSubUserList: (investorId: number) => httpCall('GET', `/v1/investors/${investorId}/sub-users`),
  investorSubUserCreate: (investorId: number, input: unknown) => httpCall('POST', `/v1/investors/${investorId}/sub-users`, input),
  investorSubUserLock: (userId: number) => httpCall('POST', `/v1/investor-sub-users/${userId}/lock`),
  investorSubUserUnlock: (userId: number) => httpCall('POST', `/v1/investor-sub-users/${userId}/unlock`),
  investorSubUserDelete: (userId: number, password: string) => httpCall('DELETE', `/v1/investor-sub-users/${userId}`, { password }),
  // Nhóm chat theo loại phí của khách (cấu hình cơ sở SigMa)
  customerChatGroupsList: (customerId: number) => httpCall('GET', `/v1/customers/${customerId}/chat-groups`),
  customerChatGroupsSet: (customerId: number, rows: unknown) => httpCall('PUT', `/v1/customers/${customerId}/chat-groups`, { rows }),
  // PICKER nhóm chat GROUP chưa gán khách nào (dropdown tìm-kiếm-gợi-ý ở form khách) — CUSTOMER_VIEW.
  chatGroupsForPicker: (search?: string, limit?: number) => httpCall('GET', `/v1/chat-groups${qs({ search, limit })}`),
  // PICKER nhóm chat cho NĐT — liệt kê MỌI phòng GROUP (KHÔNG loại phòng đã gán khách) — INVESTOR_VIEW.
  investorChatGroupsForPicker: (search?: string, limit?: number) => httpCall('GET', `/v1/investor-chat-groups/pickable${qs({ search, limit })}`),
  agentList: () => httpCall('GET', '/v1/agents'),
  // QR đại lý — GIỮ IPC. setQrImage: file/dialog (main đọc bytes). getQrImage: TENTATIVE (chưa có route API).
  agentSetQrImage: (args: { agentId: number; srcPath: string; bankAccountLabel?: string | null }) => ipcRenderer.invoke('agent:setQrImage', args),
  // R201: đọc QR đại lý (staff xem) qua HTTP (CONFIG_RCV_ACCT_VIEW). Cũ ipcRenderer→getDb() chết trên máy client API.
  agentGetQrImage: (agentId: number) => httpCall('GET', `/v1/agents/${agentId}/qr-image`),

  // POS devices (G-POS.1)
  posList: (filter: unknown) => httpCall('GET', `/v1/pos-devices${qs(rec(filter))}`),
  posTimeline: (serial: string) => httpCall('GET', `/v1/pos-devices/${enc(serial)}/timeline`),
  posCreate: (input: unknown) => httpCall('POST', '/v1/pos-devices', input),
  posUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/pos-devices/${id}`, input),
  posDeploy: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/deploy`, input),
  posRecall: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/recall`, input),
  posTransferAgent: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/transfer-agent`, input),
  posChangeCustomer: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/change-customer`, input),
  posCancelCustomer: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/cancel-customer`, input),
  // Bán máy/TID + thu công nợ (device-sale). Bán cần mật khẩu → gộp {serial|tid, ...input, password} vào body.
  deviceSellPos: (serial: string, input: unknown, password: string) => httpCall('POST', '/v1/device-sales/sell-pos', { serial, ...rec(input), password }),
  deviceSellTid: (tid: string, input: unknown, password: string) => httpCall('POST', '/v1/device-sales/sell-tid', { tid, ...rec(input), password }),
  deviceSaleCollect: (input: unknown) => httpCall('POST', `/v1/device-sales/${rec(input)['deviceSaleId']}/collect`, input),
  deviceSaleList: (filter: unknown) => httpCall('GET', `/v1/device-sales${qs(rec(filter))}`),
  deviceSaleReceivables: () => httpCall('GET', '/v1/device-sales/receivables'),
  posReportDamage: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/report-damage`, input),
  posSendRepair: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/send-repair`, input),
  posReceiveRepaired: (serial: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/receive-repaired`, input),
  posRetire: (serial: string, password: string, input: unknown) => httpCall('POST', `/v1/pos-devices/${enc(serial)}/retire`, { ...rec(input), password }),

  // TIDs (G-POS.1)
  // [B180] kéo HẾT trang — máy chủ cắt mặc định 100 dòng, màn nào không tự phân trang mà gọi
  // thẳng sẽ MẤT dữ liệu câm (xem B179: sổ 114 TID, màn chỉ thấy 100).
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
  // PHA 2 (2A) — niêm yết phí bán theo (ngân hàng × đối tác) khi TID CHƯA tồn tại (luồng "Thêm TID" giao ngay).
  sellFeePreviewByBankPartner: (bankId: number, partnerId: number, feeTypeId: number, at?: string) =>
    httpCall('GET', `/v1/sell-fees/preview${qs({ bankId, partnerId, feeTypeId, at })}`),

  // Notifications (undelivered TID) — badge qua HTTP; đẩy Zalo nền: TENTATIVE giữ IPC (tiến trình nền server).
  notifyUndeliveredSummary: () => httpCall('GET', '/v1/notifications/undelivered'),
  // R201: đẩy nhắc TID chưa giao (server-side action, TID_VIEW) qua HTTP. Cũ ipcRenderer→getDb() chết trên máy client API.
  notifyPushUndelivered: () => httpCall('POST', '/v1/notifications/push-undelivered'),

  // Cấu hình ngân hàng (G-CFG.1)
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

  // Cấu hình cung ứng POS (G-CFG.2 §C6–C8)
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

  // Cấu hình phí (G-CFG.3 §C5)
  feeTypeList: () => httpCall('GET', '/v1/fee-types'),
  feeTypeCreate: (input: unknown) => httpCall('POST', '/v1/fee-types', input),
  feeTypeUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/fee-types/${id}`, input),
  feeTypeDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/fee-types', { ids, password }),

  // LOẠI GIAO MÁY (Admin Demo)
  handoverTypeList: () => httpCall('GET', '/v1/handover-types'),
  handoverTypeListLite: () => httpCall('GET', '/v1/handover-types/lite'),
  handoverTypeCreate: (input: unknown) => httpCall('POST', '/v1/handover-types', input),
  handoverTypeUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/handover-types/${id}`, input),
  handoverTypeDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/handover-types', { ids, password }),
  depositsHeld: (customerId?: number) => httpCall('GET', `/v1/deposits/held${qs({ customerId })}`),
  revenueByHandover: (filter: unknown) => httpCall('GET', `/v1/deposits/revenue-by-handover${qs(rec(filter))}`),
  // CỌC KẸT (Admin Demo 11/8) — cọc OPEN gắn máy đã BÁN/THANH LÝ → hoàn TAY khi có bill chuyển khoản.
  depositsNeedingManualRefund: () => httpCall('GET', '/v1/deposits/needing-manual-refund'),
  refundDepositManual: (depositId: number, input: unknown) => httpCall('POST', `/v1/deposits/${depositId}/manual-refund`, input),

  feeRateList: (filter: unknown) => httpCall('GET', `/v1/fee-rates${qs(rec(filter))}`),
  feeRateSet: (input: unknown) => httpCall('POST', '/v1/fee-rates', input),
  feeRateDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/fee-rates', { ids, password }),
  feeSellQuoteList: (partnerId: number, cardTypeId: number, at?: string) => httpCall('GET', `/v1/fee-sell-quotes${qs({ partnerId, cardTypeId, at })}`),

  // [Admin Demo 4/9] QR bán hàng + GIẢM phí bán cuối tuần (qr-fee-config.ts). Quyền CONFIG_FEE_VIEW (đọc) / CONFIG_FEE_MANAGE (ghi).
  // §1 GIẢM phí bán cuối tuần (POS, theo LOẠI THẺ) — chỉ áp T7/CN.
  weekendSellAdjustList: () => httpCall('GET', '/v1/weekend-sell-adjust'),
  weekendSellAdjustSet: (input: unknown) => httpCall('POST', '/v1/weekend-sell-adjust', input),
  weekendSellAdjustDelete: (id: number) => httpCall('DELETE', `/v1/weekend-sell-adjust/${id}`),
  // [Admin Demo 12/9] §KM Chương trình khuyến mại giảm giá bán (POS/QR, cửa sổ ngày, lịch, bật/tắt) — chỉ người SigMa (CONFIG_FEE).
  promoProgramList: () => httpCall('GET', '/v1/promo-programs'),
  promoProgramSet: (input: unknown) => httpCall('POST', '/v1/promo-programs', input),
  promoProgramDelete: (id: number) => httpCall('DELETE', `/v1/promo-programs/${id}`),
  // §2 Giá QR theo ĐỐI TÁC (tầng 1 — mặc định).
  qrPartnerFeeList: (partnerId?: number) => httpCall('GET', `/v1/qr-fees/partner${qs({ partnerId })}`),
  qrPartnerFeeSet: (input: unknown) => httpCall('POST', '/v1/qr-fees/partner', input),
  // §3 Giá QR theo TỪNG MÃ (tầng 2 — đè giá đối tác).
  qrMerchantFeeList: (tidId?: number) => httpCall('GET', `/v1/qr-fees/merchant${qs({ tidId })}`),
  qrMerchantFeeSet: (input: unknown) => httpCall('POST', '/v1/qr-fees/merchant', input),
  // §4 GIÁ BÁN QR theo ĐẠI LÝ (Admin Demo 5/9 "phí bán tùy khách") — lớp đè giá bán mặc định mã, khóa theo customerId.
  qrDealerSellFeeList: (customerId?: number) => httpCall('GET', `/v1/qr-fees/dealer-sell${qs({ customerId })}`),
  qrDealerSellFeeSet: (input: unknown) => httpCall('POST', '/v1/qr-fees/dealer-sell', input),
  qrDealerSellFeeDelete: (id: number) => httpCall('DELETE', `/v1/qr-fees/dealer-sell/${id}`),
  // §5 Tài khoản DigiStore (báo có) per-mã QR (Admin Demo 5/9) — set/get creds. GET KHÔNG trả password (chỉ configured/username/base).
  qrDigistoreCredGet: (tidId: number) => httpCall('GET', `/v1/qr-digistore/cred/${tidId}`),
  qrDigistoreCredSet: (input: unknown) => httpCall('POST', '/v1/qr-digistore/cred', input),

  // Tài khoản nhận tiền – ủy quyền (G-CFG.4 §8) — HTTP (receive-account.ts). Upload ảnh CCCD chưa có route (metadata only).
  rcvSourceList: () => httpCall('GET', '/v1/rcv-sources'),
  rcvSourceCreate: (input: unknown) => httpCall('POST', '/v1/rcv-sources', input),
  rcvSourceUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/rcv-sources/${id}`, input),
  rcvSourceDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/rcv-sources', { ids, password }),

  // [B180] kéo HẾT trang — máy chủ cắt mặc định 100 dòng, màn nào không tự phân trang mà gọi
  // thẳng sẽ MẤT dữ liệu câm (xem B179: sổ 114 TID, màn chỉ thấy 100).
  rcvAccountList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/receive-accounts${qs(rec(f))}`), filter),
  rcvAccountCreate: (input: unknown) => httpCall('POST', '/v1/receive-accounts', input),
  rcvAccountUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/receive-accounts/${id}`, input),
  rcvAccountDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/receive-accounts', { ids, password }),

  pickImage: () => ipcRenderer.invoke('file:pickImage'),
  readAttachment: (relPath: string) => ipcRenderer.invoke('file:read', relPath),

  // Quản lý Hồ sơ HKD (G-CFG.5 §10) — HTTP (dossier.ts). Đính kèm ảnh ĐKKD/CCCD chưa có route (metadata only).
  dossierSourceList: () => httpCall('GET', '/v1/dossier-sources'),
  dossierSourceCreate: (input: unknown) => httpCall('POST', '/v1/dossier-sources', input),
  dossierSourceUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/dossier-sources/${id}`, input),
  dossierSourceDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/dossier-sources', { ids, password }),

  // [B180] kéo HẾT trang — máy chủ cắt mặc định 100 dòng, màn nào không tự phân trang mà gọi
  // thẳng sẽ MẤT dữ liệu câm (xem B179: sổ 114 TID, màn chỉ thấy 100).
  dossierList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/dossiers${qs(rec(f))}`), filter),
  dossierCreate: (input: unknown) => httpCall('POST', '/v1/dossiers', input),
  dossierUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/dossiers/${id}`, input),
  dossierDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/dossiers', { ids, password }),

  // Cấu hình TID (G-CFG.6 §9)
  tidStatusList: () => httpCall('GET', '/v1/tid-statuses'),
  tidStatusCreate: (input: unknown) => httpCall('POST', '/v1/tid-statuses', input),
  tidStatusUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/tid-statuses/${id}`, input),
  tidStatusDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/tid-statuses', { ids, password }),

  tidConfigList: (filter: unknown) => httpCall('GET', `/v1/tid-configs${qs(rec(filter))}`),
  tidConfigCreate: (input: unknown) => httpCall('POST', '/v1/tid-configs', input),
  tidConfigUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/tid-configs/${id}`, input),
  // Admin Demo 3/9 — SỬA LỖI NHẬP chuỗi TID (đổi định danh + cascade). Gate mật khẩu ở server.
  tidRename: (id: number, newTid: string, password: string, expectedUpdatedAt?: string | null) => httpCall('POST', `/v1/tid-configs/${id}/rename`, { newTid, password, expectedUpdatedAt }),

  // Cấu hình ngành nghề (G-CFG.7 §11 Pha I1)
  industryList: (filter: unknown) => httpCall('GET', `/v1/industries${qs(rec(filter))}`),
  industryCreate: (input: unknown) => httpCall('POST', '/v1/industries', input),
  industryUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/industries/${id}`, input),
  industryDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/industries', { ids, password }),
  // Bill giải trình (Admin Demo 16/7) — DATA (product:* + billExplain list/delete) qua HTTP (bill-explain.ts).
  // GIỮ IPC: generate/config/template/openFile/openFolder (chưa có route + thao tác file cục bộ).
  // [B180] kéo HẾT trang — máy chủ cắt mặc định 100 dòng, màn nào không tự phân trang mà gọi
  // thẳng sẽ MẤT dữ liệu câm (xem B179: sổ 114 TID, màn chỉ thấy 100).
  productList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/products${qs(rec(f))}`), filter),
  productCreate: (input: unknown) => httpCall('POST', '/v1/products', input),
  productUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/products/${id}`, input),
  productDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/products', { ids, password }),
  productImport: (industryId: number, rows: unknown[]) => httpCall('POST', '/v1/products/import', { industryId, rows }),
  // R201 (dead-IPC): sinh bill = HYBRID. Phần DB (cấp DẢI số HĐ atomic + lưu bản ghi) đi qua quanly-api; file .xlsx
  // render CỤC BỘ ở main (đĩa client). Luồng: reserve (server, atomic) → renderLocal (main, file) → record (server).
  // Cũ ipcRenderer('billExplain:generate')→getDb() chết câm trên máy client API-mode.
  billExplainGenerate: async (input: unknown) => {
    const inp = rec(input);
    // (1) RESERVE: validate server-side + cấp DẢI số HĐ ATOMIC (advisory lock). Trả dossier + products + targets(parsed).
    const rsv = await httpCall('POST', '/v1/bill-explain/reserve', input);
    if (!rsv || !rsv.ok) return rsv || { ok: false, error: 'NETWORK', message: 'Không kết nối được máy chủ.' };
    // (2) RENDER CỤC BỘ (main): sinh + ghi file .xlsx lên đĩa client bằng dải số vừa cấp.
    const rendered = await ipcRenderer.invoke('billExplain:renderLocal', {
      dossier: rsv.dossier, products: rsv.products, targets: rsv.targets,
      billDate: inp['billDate'], billNoStart: rsv.billNoStart, billNoYear: rsv.billNoYear
    });
    if (!rendered || !rendered.ok) return rendered || { ok: false, error: 'RENDER_FAILED', message: 'Sinh bill thất bại.' };
    // (3) RECORD: lưu bản ghi server-side (biết billCount + filePath). totalAmount = Σ MỌI target (BigInt, không mất chữ số).
    const totalAmount = (rsv.targets as number[]).reduce((s: bigint, t: number) => s + BigInt(t), 0n).toString();
    const saved = await httpCall('POST', '/v1/bill-explain/record', {
      dossierId: inp['dossierId'], tidId: inp['tidId'] ?? null, industryId: inp['industryId'],
      billDate: inp['billDate'], totalAmount, billCount: rendered.totalBills, filePath: rendered.file
    });
    if (!saved || !saved.ok) {
      // Record thất bại → DỌN file cục bộ (số HĐ đã cấp nhảy quãng — vô hại, chốt Admin Demo 16/7). Trả lỗi record.
      await ipcRenderer.invoke('billExplain:unlinkLocalFile', rendered.file);
      return saved || { ok: false, error: 'DB_FAILED', message: 'Lưu bill vào cơ sở dữ liệu thất bại.' };
    }
    return { ok: true, id: saved.id, file: rendered.file, totalBills: rendered.totalBills, errors: rendered.errors };
  },
  // [B180] kéo HẾT trang — máy chủ cắt mặc định 100 dòng, màn nào không tự phân trang mà gọi
  // thẳng sẽ MẤT dữ liệu câm (xem B179: sổ 114 TID, màn chỉ thấy 100).
  billExplainList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/bill-explains${qs(rec(f))}`), filter),
  billExplainDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/bill-explains', { ids, password }),
  // R201: cấu hình = HYBRID. Số HĐ (DB) qua quanly-api; outputDir/resolve template = PER-MACHINE (main). MERGE ở preload.
  billExplainConfig: async () => {
    const [db, local] = await Promise.all([
      httpCall('GET', '/v1/bill-explain/config'),
      ipcRenderer.invoke('billExplain:localConfig')
    ]);
    if (!db || !db.ok) return db || { ok: false, error: 'NETWORK', message: 'Không kết nối được máy chủ.' };
    const l = (local ?? {}) as { outputDir?: string; defaultTemplatePath?: string; customTemplatePath?: string; customTemplateExists?: boolean };
    const templateIsCustom = !!(db.data?.templateCustomPath && l.customTemplateExists);
    return {
      ok: true,
      data: {
        outputDir: l.outputDir ?? '',
        billNoStart: db.data?.billNoStart ?? 1,
        billNoYear: db.data?.billNoYear ?? new Date().getFullYear(),
        templatePath: templateIsCustom ? (l.customTemplatePath ?? '') : (l.defaultTemplatePath ?? ''),
        templateIsCustom
      }
    };
  },
  billExplainSetConfig: async (input: unknown) => {
    const i = rec(input);
    if (i['outputDir'] !== undefined) {
      const r = await ipcRenderer.invoke('billExplain:setLocalOutputDir', i['outputDir']); // per-machine (LOW-C guard ở main)
      if (r && !r.ok) return r;
    }
    const dbInput: Record<string, unknown> = {};
    if (i['billNoStart'] !== undefined) dbInput.billNoStart = i['billNoStart'];
    if (i['billNoYear'] !== undefined) dbInput.billNoYear = i['billNoYear'];
    if (Object.keys(dbInput).length) return httpCall('PUT', '/v1/bill-explain/config', dbInput);
    return { ok: true };
  },
  // R201: mẫu hóa đơn = HYBRID. FILE cục bộ (main) + con trỏ template trong DB (PUT /v1/bill-explain/config, PRODUCT_MANAGE).
  // import: copy file vào userData (main) → set con trỏ DB; thất bại set con trỏ → dọn file vừa copy (giữ nhất quán).
  billExplainImportTemplate: async () => {
    const r = await ipcRenderer.invoke('billExplain:importTemplate');
    if (!r || !r.ok) return r;
    const s = await httpCall('PUT', '/v1/bill-explain/config', { templateCustomPath: r.templatePath });
    if (!s || !s.ok) { await ipcRenderer.invoke('billExplain:resetTemplate'); return s || { ok: false, error: 'NETWORK', message: 'Không kết nối được máy chủ.' }; }
    return { ok: true, templatePath: r.templatePath };
  },
  // reset: xóa file mẫu riêng userData (main) → xóa con trỏ DB (null).
  billExplainResetTemplate: async () => {
    const r = await ipcRenderer.invoke('billExplain:resetTemplate');
    if (!r || !r.ok) return r;
    return httpCall('PUT', '/v1/bill-explain/config', { templateCustomPath: null });
  },
  // export: THUẦN LOCAL (copy mẫu đang dùng ra file người dùng chọn) — không đụng DB.
  billExplainExportTemplate: () => ipcRenderer.invoke('billExplain:exportTemplate'),
  // R201: mở file bill theo filePath (renderer gửi từ DTO list/kết quả sinh) — main guard .xlsx + trong thư mục xuất.
  // Cũ ipcRenderer('billExplain:openFile', id)→getBillFilePath()→getDb() chết trên máy client API-mode.
  billExplainOpenFile: (filePath: string) => ipcRenderer.invoke('billExplain:openLocalFile', filePath),
  billExplainOpenFolder: () => ipcRenderer.invoke('billExplain:openFolder'),
  // ── PHASE H1 — Thu–Chi: danh mục thu/chi ──
  cashCategoryList: (filter: unknown) => httpCall('GET', `/v1/cash-categories${qs(rec(filter))}`),
  cashCategoryCreate: (input: unknown) => httpCall('POST', '/v1/cash-categories', input),
  cashCategoryUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/cash-categories/${id}`, input),
  cashCategoryDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/cash-categories', { ids, password }),
  // ── PHASE H2-core — Thu–Chi: Quỹ + Phiếu thu/chi ──
  fundList: (filter: unknown) => httpCall('GET', `/v1/funds${qs(rec(filter))}`),
  fundUserLite: () => httpCall('GET', '/v1/cashflow-users/lite'),
  fundCreate: (input: unknown) => httpCall('POST', '/v1/funds', input),
  fundUpdate: (id: number, input: unknown) => httpCall('PATCH', `/v1/funds/${id}`, input),
  fundDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/funds', { ids, password }),
  // [B180] kéo HẾT trang — máy chủ cắt mặc định 100 dòng, màn nào không tự phân trang mà gọi
  // thẳng sẽ MẤT dữ liệu câm (xem B179: sổ 114 TID, màn chỉ thấy 100).
  cashEntryList: (filter: unknown) => keoHetTrang((f) => httpCall('GET', `/v1/cash-entries${qs(rec(f))}`), filter),
  cashEntryReport: (filter: unknown) => httpCall('GET', `/v1/cash-entries/report${qs(rec(filter))}`),
  cashEntryCategoryLite: () => httpCall('GET', '/v1/cash-entries/categories-lite'),
  cashEntryPartnerLite: () => httpCall('GET', '/v1/cash-entries/partners-lite'),
  cashEntryCreate: (input: unknown) => httpCall('POST', '/v1/cash-entries', input),
  cashEntryCreateDebtReceipt: (input: unknown) => httpCall('POST', '/v1/cash-entries/debt-receipt', input),
  cashEntryCancel: (id: number, reason: string, password: string) => httpCall('POST', `/v1/cash-entries/${id}/cancel`, { reason, password }),

  // Nhập liệu hàng loạt từ Excel (#9) — export/importTemplate là thao tác FILE → GIỮ IPC.
  reportExport: (p: { kind?: 'report' | 'template'; fileBase: string; fileName: string; title: string; headers: string[]; rows?: (string | number | null | undefined)[][]; summary?: string; hints?: { header: string; required?: boolean; hint?: string }[]; chon?: Record<string, string[]>; khoiPhu?: { tieuDe: string; headers: string[]; rows: (string | number | null | undefined)[][] ; coHangTong?: boolean }[]; sheets?: unknown[]; cotTien?: string[]; cotRong?: string[]; cotGiua?: string[] }) => ipcRenderer.invoke('report:export', p),
  // [B231] xuất NHIỀU FILE (mỗi NĐT 1 file) — hỏi thư mục 1 lần rồi ghi hết vào đó.
  reportExportNhieuFile: (p: { files: { fileName: string; sheet: unknown }[] }) => ipcRenderer.invoke('report:exportNhieuFile', p),
  investorDetailExport: (p: { fileName: string; data: unknown }) => ipcRenderer.invoke('report:investorDetail', p),
  openFilePath: (path: string) => ipcRenderer.invoke('file:open', path),

  // Nhập Excel (import.ts) — HTTP. template = cột mẫu (không phải file); parse .xlsx→rows GIỮ ở renderer.
  importTemplate: (entityKey: string) => httpCall('GET', `/v1/import/template${qs({ entityKey })}`),
  importDryRun: (entityKey: string, rows: Record<string, unknown>[]) => httpCall('POST', '/v1/import/dry-run', { entityKey, rows }),
  importRun: (entityKey: string, rows: Record<string, unknown>[]) => httpCall('POST', '/v1/import/run', { entityKey, rows }),

  // Thùng rác (E4)
  trashList: () => httpCall('GET', '/v1/trash'),
  trashRestore: (entityType: string, id: number) => httpCall('POST', '/v1/trash/restore', { entityType, id }),
  trashLinkSummary: (entityType: string, id: number) => httpCall('GET', `/v1/trash/link-summary${qs({ entityType, id })}`),
  trashPurge: (entityType: string, id: number, password: string) => httpCall('POST', '/v1/trash/purge', { entityType, id, password }),
  trashEmptyAll: (level2Password: string) => httpCall('POST', '/v1/trash/empty', { level2Password }),

  // Dashboard (Nhóm B)
  dashboardStats: () => httpCall('GET', '/v1/dashboard/stats'),
  dashboardProfit: () => httpCall('GET', '/v1/dashboard/profit'),

  // Hòm thư nội bộ + thông báo bảo mật
  messageInbox: () => httpCall('GET', '/v1/messages'),
  messageUnreadCount: () => httpCall('GET', '/v1/messages/unread-count'),
  messageMarkRead: (id: number) => httpCall('POST', `/v1/messages/${id}/read`),
  messageMarkAllRead: () => httpCall('POST', '/v1/messages/read-all'),
  messageSend: (input: { recipientId: number; subject: string; body: string }) => httpCall('POST', '/v1/messages', input),

  // Doanh thu & Công nợ (Nhóm B)
  transactionList: (filter: unknown) => httpCall('GET', `/v1/transactions${qs(rec(filter))}`),
  transactionCreate: (input: unknown) => httpCall('POST', '/v1/transactions', input),
  revenueByFeeType: (filter: unknown) => httpCall('GET', `/v1/transactions/revenue-by-fee-type${qs(rec(filter))}`),
  transactionDelete: (ids: number[], password: string) => httpCall('DELETE', '/v1/transactions', { ids, password }),
  debtSummary: (filter: unknown) => httpCall('GET', `/v1/debt/summary${qs(rec(filter))}`),
  debtOpenTransactions: (filter: unknown) => httpCall('GET', `/v1/debt/open-transactions${qs(rec(filter))}`),
  // H2b — phân loại chất lượng công nợ + ghi giảm nợ xấu
  debtByQuality: (filter: unknown) => httpCall('GET', `/v1/debt/by-quality${qs(rec(filter))}`),
  debtClassify: (transactionId: number, quality: string, reason?: string) => httpCall('POST', '/v1/debt/classify', { transactionId, quality, reason }),
  debtQualityHistory: (transactionId: number) => httpCall('GET', `/v1/debt/${transactionId}/quality-history`),
  debtWriteOff: (transactionId: number, actorPassword: string) => httpCall('POST', '/v1/debt/write-off', { transactionId, actorPassword }),

  // Duyệt hủy bill (P1.2 Approval Engine)
  cancelRequest: (transactionId: number, reason: string) => httpCall('POST', '/v1/cancel-requests', { transactionId, reason }),
  cancelRequestList: (status?: string) => httpCall('GET', `/v1/cancel-requests${qs({ status })}`),
  globalSearch: (q: string) => httpCall('GET', `/v1/search${qs({ q })}`),
  captureRegion: (opts?: { hideApp?: boolean }) => ipcRenderer.invoke('capture:region', opts),
  openScreenshotDir: () => ipcRenderer.invoke('capture:openDir'),
  cancelApprove: (requestId: number, password: string, note?: string) => httpCall('POST', `/v1/cancel-requests/${requestId}/approve`, { password, note }),
  cancelReject: (requestId: number, note: string) => httpCall('POST', `/v1/cancel-requests/${requestId}/reject`, { note }),
  cancelApproveBulk: (requestIds: number[], password: string, note?: string) => httpCall('POST', '/v1/cancel-requests/approve-bulk', { requestIds, password, note }),
  cancelRejectBulk: (requestIds: number[], note: string) => httpCall('POST', '/v1/cancel-requests/reject-bulk', { requestIds, note }),
  // R34 — Duyệt hủy (xóa qua duyệt) TID/POS/Khách/Nhân sự.
  entityCancelRequest: (entityType: string, entityId: number, reason: string) => httpCall('POST', '/v1/entity-cancel-requests', { entityType, entityId, reason }),
  entityCancelList: (status?: string, entityType?: string) => httpCall('GET', `/v1/entity-cancel-requests${qs({ status, entityType })}`),
  entityCancelApprove: (entityType: string, requestId: number, password: string, note?: string) => httpCall('POST', `/v1/entity-cancel-requests/${requestId}/approve`, { entityType, password, note }),
  entityCancelApproveBulk: (items: { entityType: string; id: number }[], password: string, note?: string) => httpCall('POST', '/v1/entity-cancel-requests/approve-bulk', { items, password, note }),
  entityCancelReject: (entityType: string, requestId: number, note: string) => httpCall('POST', `/v1/entity-cancel-requests/${requestId}/reject`, { entityType, note }),
  exportReqCreate: (input: unknown) => httpCall('POST', '/v1/export-requests', input),
  exportReqList: (filter?: unknown) => httpCall('GET', `/v1/export-requests${qs(rec(filter))}`),
  exportReqApprove: (requestId: number, lines: unknown, password: string, note?: string) => httpCall('POST', `/v1/export-requests/${requestId}/approve`, { lines, password, note }),
  exportReqReject: (requestId: number, note: string) => httpCall('POST', `/v1/export-requests/${requestId}/reject`, { note }),
  exportReqCancel: (requestId: number, note?: string) => httpCall('POST', `/v1/export-requests/${requestId}/cancel`, { note }),

  // Bảo trì & Bộ nhớ (Nhóm E — Storage-Guard) — HTTP (storage.ts). Server tự đo disk/pg + backup an toàn.
  storageStatus: () => httpCall('GET', '/v1/storage/status'),
  storageCleanup: (opts: { clearHistory?: boolean; purgeTrash?: boolean; password: string }) => httpCall('POST', '/v1/storage/cleanup', opts),
  storageUpdateConfig: (cfg: { thresholdPct?: number; auditRetentionDays?: number; trashRetentionDays?: number; backupIntervalHours?: number; maintenanceDayOfWeek?: number; maintenanceHour?: number; maintenanceEnabled?: boolean; autoPurgeWeekly?: boolean }) => httpCall('PATCH', '/v1/storage/config', cfg),

  // Bảo trì: quét sức khỏe + lịch sử (health.ts). Desktop health:scan = runScan (persist MaintenanceRun) → POST /run
  // (KHÔNG phải GET /scan read-only). GIỮ IPC: healthRun(id) — chi tiết 1 lần quét, chưa có route API (TENTATIVE).
  healthScan: (opts: { autoFix?: boolean }) => httpCall('POST', '/v1/health/run', { autoFix: opts?.autoFix }),
  healthRuns: (limit?: number) => httpCall('GET', `/v1/health/runs${qs({ limit })}`),
  healthRun: (id: number) => ipcRenderer.invoke('health:run', id),

  // ── G11 Cập nhật phần mềm tích hợp (electron-updater) — GIỮ IPC (chạy ở main) ──
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  startUpdate: () => ipcRenderer.invoke('update:start'),
  installUpdateNow: () => ipcRenderer.invoke('update:installNow'),
  getUpdateBootResult: () => ipcRenderer.invoke('update:getBootResult'),
  getLastAvailableUpdate: () => ipcRenderer.invoke('update:getLastAvailable'),
  // Sự kiện realtime (main → renderer). Trả hàm hủy đăng ký để cleanup lúc unmount ([M8]).
  onUpdateAvailable: (cb: (p: { version: string }) => void) => {
    const h = (_e: unknown, p: { version: string }): void => cb(p);
    ipcRenderer.on('update-available', h);
    return () => ipcRenderer.removeListener('update-available', h);
  },
  onDownloadProgress: (cb: (p: { percent: number }) => void) => {
    const h = (_e: unknown, p: { percent: number }): void => cb(p);
    ipcRenderer.on('download-progress', h);
    return () => ipcRenderer.removeListener('download-progress', h);
  },
  onUpdateDownloaded: (cb: (p: { version: string }) => void) => {
    const h = (_e: unknown, p: { version: string }): void => cb(p);
    ipcRenderer.on('update-downloaded', h);
    return () => ipcRenderer.removeListener('update-downloaded', h);
  },
  onUpdateError: (cb: (p: { message: string }) => void) => {
    const h = (_e: unknown, p: { message: string }): void => cb(p);
    ipcRenderer.on('update-error', h);
    return () => ipcRenderer.removeListener('update-error', h);
  },

  // ── Điều khiển cửa sổ tự vẽ (nút Mac đỏ/vàng/lục) — GIỮ IPC (chạy ở main) ──
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
  windowMaximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'), // Admin Demo 11/8: full màn hình sau đăng nhập
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximized: (cb: (max: boolean) => void) => {
    const h = (_e: unknown, max: boolean): void => cb(max);
    ipcRenderer.on('window:maximized', h);
    return () => ipcRenderer.removeListener('window:maximized', h);
  }
};

export type GlbApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
