// SIGMA (4/8, CMD_BUILD — Admin Demo chốt nhà cung cấp = eSMS.vn) — gửi OTP qua SMS để thêm/đổi SĐT xác thực
// (Agent.phone). ĐỐI XỨNG email-service.ts (Gmail SMTP OTP đã có): đọc credential LÚC GỌI (KHÔNG cache lúc
// import — đúng pattern db.ts/email-service.ts, để test đổi env giữa các case vẫn ăn đúng, và để process khởi
// động được ngay cả khi .env chưa điền — chỉ throw lúc THỰC SỰ gửi SMS). Fail-closed: thiếu biến môi trường →
// throw EsmsNotConfiguredError RÕ RÀNG, KHÔNG âm thầm bỏ qua việc gửi (R198 "check phải chạy, không nuốt lỗi
// im" — route KHÔNG được cho lưu phone nếu SMS chưa cấu hình).
//
// API eSMS.vn (SendMultipleMessage_V4_post_json) — body JSON:
//   { ApiKey, SecretKey, Brandname, Content, Phone (dạng 84xxxxxxxxx), SmsType, IsUnicode:"0" }
// Response THÀNH CÔNG: { CodeResult: "100", SMSID, ... }. CodeResult != "100" = LỖI (map message rõ, KHÔNG
// nuốt). Vòng đời OTP (challenge/verify/rate-limit/hash) TÁI DÙNG NGUYÊN otp-service.ts — file này CHỈ lo tầng
// "gửi SMS thật + chuẩn hoá SĐT", KHÔNG tự chế cơ chế OTP mới.
//
// Biến môi trường (LEAD điền key thật lúc deploy — KHÔNG hardcode, xem BUGS_FIXED bài học never_hardcode_credential):
//   ESMS_API_KEY     (bắt buộc)
//   ESMS_SECRET_KEY  (bắt buộc)
//   ESMS_BRANDNAME   (bắt buộc khi SmsType = "2" brandname — mặc định)
//   ESMS_SMS_TYPE    (tuỳ chọn, mặc định "2" = tin brandname)

const ESMS_ENDPOINT = 'http://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/';
const DEFAULT_SMS_TYPE = '2'; // "2" = tin thương hiệu (brandname). eSMS: type này BẮT BUỘC có Brandname.
const BRAND = 'SigMa';

/** Chuẩn hoá SĐT VN người dùng gõ về đúng dạng eSMS cần: "84xxxxxxxxx" (84 + 9 chữ số thuê bao, KHÔNG số 0
 * đầu, KHÔNG dấu +). Trả null nếu KHÔNG phải SĐT di động VN hợp lệ (10 chữ số dạng 0xxxxxxxxx). Hàm THUẦN
 * (không I/O) — test riêng được. Chỉ nhận 3 dạng người dùng VN thật gõ: "0xxxxxxxxx" / "84xxxxxxxxx" /
 * "+84xxxxxxxxx" (bỏ khoảng trắng/gạch ngang trước) — KHÔNG suy đoán đổi đầu số ngoài tiền tố quốc gia. */
export function normalizeVnPhoneTo84(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\s-]/g, '');
  let bare: string; // phần thuê bao KHÔNG tiền tố, kỳ vọng 9 chữ số (vd "981123710").
  if (cleaned.startsWith('+84')) bare = cleaned.slice(3);
  else if (cleaned.startsWith('84')) bare = cleaned.slice(2);
  else if (cleaned.startsWith('0')) bare = cleaned.slice(1);
  else return null;
  // SĐT di động VN: 9 chữ số sau mã 0/84, đầu 3/5/7/8/9 (đầu số di động hiện hành). Cố ý KHÔNG chấp nhận số
  // cố định (đầu 2) cho OTP — tránh gửi SMS tới số bàn không nhận được. Nếu spec mở rộng thì nới ở ĐÂY.
  if (!/^[3-9]\d{8}$/.test(bare)) return null;
  return `84${bare}`;
}

/** Dạng "0xxxxxxxxx" (10 số, national) để LƯU vào Agent.phone — đồng nhất với dữ liệu cũ trong DB (các record
 * hiện tại lưu 0-prefixed) + với buildPhoneSearchVariants() (friend-service tra cứu theo nhiều biến thể). Trả
 * null nếu SĐT không hợp lệ. */
export function normalizeVnPhoneToLocal(raw: string): string | null {
  const e164 = normalizeVnPhoneTo84(raw);
  if (!e164) return null;
  return `0${e164.slice(2)}`;
}

/** Nội dung SMS OTP — tách riêng khỏi việc gửi thật để test được không cần mock HTTP. IsUnicode="0" nên nội
 * dung PHẢI không dấu (tin brandname không unicode = 1 segment rẻ hơn, không rơi dấu gây lỗi hiển thị). */
export function buildOtpSmsContent(code: string, expiresMinutes = 10): string {
  return `${BRAND}: Ma xac thuc so dien thoai cua ban la ${code}. Ma het han sau ${expiresMinutes} phut. Khong chia se ma nay cho bat ky ai.`;
}

/** Thiếu cấu hình eSMS (ApiKey/SecretKey/Brandname) — fail-closed, KHÔNG cho lưu phone. Route BẮT map lỗi này
 * thành 500 rõ ("SMS chưa cấu hình") thay vì nuốt im (R198). */
export class EsmsNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`ESMS_NOT_CONFIGURED: thiếu ${missing} trong biến môi trường — SMS chưa cấu hình, không thể gửi mã xác thực SĐT.`);
    this.name = 'EsmsNotConfiguredError';
  }
}

/** eSMS trả về CodeResult != "100" (từ chối/lỗi phía nhà cung cấp) HOẶC HTTP lỗi. Giữ nguyên codeResult để
 * route/log truy vết, KHÔNG nuốt. */
export class EsmsSendError extends Error {
  readonly codeResult: string | null;
  constructor(message: string, codeResult: string | null) {
    super(message);
    this.name = 'EsmsSendError';
    this.codeResult = codeResult;
  }
}

// Bảng map một số CodeResult phổ biến của eSMS sang thông báo tiếng Việt rõ ràng (không phải toàn bộ — mã lạ
// vẫn báo kèm nguyên codeResult để truy vết, KHÔNG nuốt).
const CODE_RESULT_MESSAGE: Record<string, string> = {
  '99': 'eSMS: lỗi không xác định phía nhà cung cấp SMS.',
  '101': 'eSMS: sai ApiKey hoặc SecretKey (thông tin xác thực nhà cung cấp SMS không đúng).',
  '102': 'eSMS: tài khoản SMS đang bị khoá hoặc chưa kích hoạt.',
  '103': 'eSMS: tài khoản SMS không đủ số dư để gửi.',
  '104': 'eSMS: Brandname không đúng hoặc chưa được duyệt.',
  '118': 'eSMS: loại tin (SmsType) không hợp lệ.',
  '119': 'eSMS: Brandname chưa được cấp cho loại tin này.'
};

type FetchFn = typeof fetch;

/** Đọc + kiểm cấu hình eSMS TẠI THỜI ĐIỂM GỌI (không cache import). Fail-closed nếu thiếu. */
function readEsmsConfig(): { apiKey: string; secretKey: string; brandname: string; smsType: string } {
  const apiKey = process.env.ESMS_API_KEY;
  const secretKey = process.env.ESMS_SECRET_KEY;
  const smsType = process.env.ESMS_SMS_TYPE?.trim() || DEFAULT_SMS_TYPE;
  const brandname = process.env.ESMS_BRANDNAME;
  if (!apiKey) throw new EsmsNotConfiguredError('ESMS_API_KEY');
  if (!secretKey) throw new EsmsNotConfiguredError('ESMS_SECRET_KEY');
  // Brandname bắt buộc cho tin thương hiệu (SmsType "2"). Với loại tin khác eSMS vẫn nhận field rỗng, nhưng
  // SigMa mặc định dùng brandname → thiếu = fail-closed để không âm thầm rơi về gửi tin rác đầu số ngẫu nhiên.
  if (smsType === DEFAULT_SMS_TYPE && !brandname) throw new EsmsNotConfiguredError('ESMS_BRANDNAME');
  return { apiKey, secretKey, brandname: brandname ?? '', smsType };
}

/**
 * Gửi SMS OTP THẬT qua eSMS.vn. `phone` được chuẩn hoá về "84xxxxxxxxx" bên trong (idempotent — route đã
 * chuẩn hoá cũng không sao). `fetchOverride` CHỈ dùng cho test (mock HTTP eSMS — KHÔNG gọi mạng thật trong
 * vitest tự động); code sản xuất luôn dùng global fetch thật.
 *
 * Ném:
 *   - EsmsNotConfiguredError  → thiếu env (route map 500 "SMS chưa cấu hình", fail-closed KHÔNG lưu phone).
 *   - EsmsSendError           → SĐT không hợp lệ / HTTP lỗi / CodeResult != "100".
 */
export async function sendOtpSms(
  phone: string,
  code: string,
  opts: { expiresMinutes?: number; fetchOverride?: FetchFn } = {}
): Promise<{ smsId: string | null }> {
  const cfg = readEsmsConfig(); // fail-closed TRƯỚC — thiếu config thì không tốn công build request.
  const phone84 = normalizeVnPhoneTo84(phone);
  if (!phone84) {
    throw new EsmsSendError(`Số điện thoại không hợp lệ để gửi SMS: ${phone}`, null);
  }
  const content = buildOtpSmsContent(code, opts.expiresMinutes ?? 10);
  const body = {
    ApiKey: cfg.apiKey,
    SecretKey: cfg.secretKey,
    Brandname: cfg.brandname,
    Content: content,
    Phone: phone84,
    SmsType: cfg.smsType,
    IsUnicode: '0'
  };

  const doFetch = opts.fetchOverride ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(ESMS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new EsmsSendError(`Không kết nối được tới eSMS: ${(err as Error).message}`, null);
  }
  if (!resp.ok) {
    throw new EsmsSendError(`eSMS trả HTTP ${resp.status} khi gửi SMS.`, null);
  }

  type EsmsResponse = { CodeResult?: string | number; SMSID?: string | number; ErrorMessage?: string };
  let json: EsmsResponse | null = null;
  try {
    json = (await resp.json()) as EsmsResponse;
  } catch {
    throw new EsmsSendError('eSMS trả về nội dung không phải JSON hợp lệ.', null);
  }

  const codeResult = json?.CodeResult != null ? String(json.CodeResult) : null;
  if (codeResult !== '100') {
    const mapped = codeResult && CODE_RESULT_MESSAGE[codeResult];
    const detail = mapped ?? `Gửi SMS thất bại (CodeResult=${codeResult ?? 'không rõ'}${json?.ErrorMessage ? `, ${json.ErrorMessage}` : ''}).`;
    throw new EsmsSendError(detail, codeResult);
  }
  return { smsId: json?.SMSID != null ? String(json.SMSID) : null };
}
