// SIGMA "Hồ sơ cá nhân" (1/8, Admin Demo yêu cầu — thay ProfileScreen.tsx Phase 0 mock hoàn toàn: trước đây
// CHỈ có state cục bộ Tên hiển thị/Trạng thái/avatar-màu, KHÔNG gọi API nào, nút Lưu là toast giả). Đọc/sửa 4
// field hồ sơ cơ bản đã có SẴN cột DB (Agent.name/email/gender/dateOfBirth/phone, schema.prisma — 0 migration
// mới). CÙNG khuôn service khác (chat-category-service.ts/friend-service.ts): DB access + validate sống Ở
// ĐÂY, routes/me.ts CHỈ wrap HTTP.
//
// QUYẾT ĐỊNH THIẾT KẾ (Admin Demo SỬA GẤP giữa chừng lúc đang build — xem BUGS_FIXED.md):
// - name/gender/dateOfBirth: sửa TRỰC TIẾP qua PATCH /v1/me/profile (updateMyProfile() dưới đây), KHÔNG cần
//   xác nhận gì thêm — đúng brief gốc.
// - email: BẮT BUỘC qua luồng OTP-xác-nhận-gửi-tới-EMAIL-MỚI (kiểu Zalo đổi email liên kết: nhập email mới →
//   OTP gửi tới email MỚI (KHÔNG phải email cũ) → nhập đúng mã → LÚC ĐÓ mới thật sự ghi DB). updateMyProfile()
//   dưới đây KHÔNG nhận field `email` — route PATCH /v1/me/profile (routes/me.ts) CHỦ ĐỘNG TỪ CHỐI 400 nếu
//   body chứa key `email`/`phone` (KHÔNG âm thầm bỏ qua — đúng nguyên tắc "check phải chạy, không nuốt lỗi
//   im", tránh caller tưởng đã đổi email nhưng thực ra bị lờ đi). 3 hàm validateNewEmailFormat()/
//   isEmailTakenByOtherAgent()/applyEmailChange() ở cuối file hỗ trợ 2 route MỚI POST /v1/me/email-change/
//   request-otp + /confirm (routes/me.ts, orchestrate OTP CÙNG khuôn routes/auth.ts forgot-password/reset —
//   xem comment ở đó, dùng lại NGUYÊN otp-service.ts/email-service.ts, KHÔNG viết lại cơ chế OTP mới).
// - phone: CHƯA xây được — đã tự grep xác nhận toàn `apps/bot-api/src` KHÔNG có bất kỳ hạ tầng gửi SMS nào
//   (0 kết quả cho 'sms'/'SMS'/'Twilio'/'ZNS'). KHÔNG tự bịa provider/API key. `updateMyProfile()` KHÔNG nhận
//   field `phone` — CẦN LEAD hỏi Admin Demo chọn nhà cung cấp SMS (Twilio/Zalo ZNS/eSMS...) trước khi xây, xem
//   BUGS_FIXED.md mục "chưa làm". Frontend (ProfileScreen.tsx) giữ ô SĐT READ-ONLY kèm ghi chú rõ, KHÔNG giả
//   vờ nút hoạt động.
import { Prisma, type Db } from '@sigma/database';
import { normalizeVnPhoneTo84, normalizeVnPhoneToLocal } from '../esms-service.js';

export type ProfileServiceError =
  | { ok: false; error: 'VALIDATION'; message: string }
  | { ok: false; error: 'EMAIL_ALREADY_REGISTERED'; message: string }
  | { ok: false; error: 'AGENT_NOT_FOUND'; message: string };

export interface AgentProfileDto {
  name: string;
  email: string | null;
  gender: string | null;
  dateOfBirth: string | null; // ISO "YYYY-MM-DD", null nếu chưa khai
  phone: string | null;
}

const ALLOWED_GENDERS = new Set(['MALE', 'FEMALE', 'OTHER']);
// Regex CÙNG routes/auth.ts EMAIL_RE — file đó KHÔNG export hằng số này, duplicate 1 regex nhỏ chấp nhận
// được (đúng cách isUniqueConstraintError() cũng bị duplicate độc lập ở chat-room-service.ts/routes/auth.ts).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** true nếu err là lỗi VI PHẠM UNIQUE CONSTRAINT thật của Prisma (P2002) — CÙNG helper đã duplicate ở
 * chat-room-service.ts/routes/auth.ts (không export chéo giữa các file độc lập). */
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function toIsoDateOnly(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function toDto(agent: { name: string; email: string | null; gender: string | null; dateOfBirth: Date | null; phone: string | null }): AgentProfileDto {
  return {
    name: agent.name,
    email: agent.email,
    gender: agent.gender,
    dateOfBirth: toIsoDateOnly(agent.dateOfBirth),
    phone: agent.phone
  };
}

/** GET /v1/me/profile — hồ sơ CỦA CHÍNH đại lý đang đăng nhập (agentId từ req.agent!.id, xem routes/me.ts). */
export async function getMyProfile(db: Db, agentId: number): Promise<{ ok: true; data: AgentProfileDto } | ProfileServiceError> {
  const agent = await db.agent.findFirst({ where: { id: agentId, deletedAt: null } });
  if (!agent) return { ok: false, error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' };
  return { ok: true, data: toDto(agent) };
}

export interface UpdateProfileInput {
  name?: string;
  gender?: string;
  dateOfBirth?: string; // ISO "YYYY-MM-DD"
}

/** PATCH /v1/me/profile — CHỈ name/gender/dateOfBirth (email/phone đi đường riêng, xem comment đầu file).
 * Partial update — field KHÔNG có mặt trong input (`undefined`) giữ nguyên giá trị cũ, KHÔNG bị ghi đè. */
export async function updateMyProfile(
  db: Db,
  agentId: number,
  input: UpdateProfileInput
): Promise<{ ok: true; data: AgentProfileDto } | ProfileServiceError> {
  const data: { name?: string; gender?: string; dateOfBirth?: Date } = {};

  if (input.name !== undefined) {
    if (typeof input.name !== 'string') return { ok: false, error: 'VALIDATION', message: 'name phải là chuỗi.' };
    const trimmed = input.name.trim();
    if (trimmed.length === 0) return { ok: false, error: 'VALIDATION', message: 'Tên hiển thị không được để trống.' };
    data.name = trimmed;
  }

  if (input.gender !== undefined) {
    const normalized = typeof input.gender === 'string' ? input.gender.trim().toUpperCase() : '';
    if (!ALLOWED_GENDERS.has(normalized)) {
      return { ok: false, error: 'VALIDATION', message: 'gender phải là MALE/FEMALE/OTHER.' };
    }
    data.gender = normalized;
  }

  if (input.dateOfBirth !== undefined) {
    if (typeof input.dateOfBirth !== 'string' || input.dateOfBirth.trim().length === 0) {
      return { ok: false, error: 'VALIDATION', message: 'dateOfBirth phải là chuỗi ngày hợp lệ (YYYY-MM-DD).' };
    }
    const parsed = new Date(input.dateOfBirth.trim());
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'VALIDATION', message: 'dateOfBirth phải là ngày hợp lệ.' };
    }
    if (parsed.getTime() > Date.now()) {
      return { ok: false, error: 'VALIDATION', message: 'Ngày sinh không được ở tương lai.' };
    }
    // Chặn năm vô lý (vd 9999 / 0100): new Date() nuốt được nhưng không phải ngày sinh thật. Bound dưới 1900.
    const yob = parsed.getUTCFullYear();
    if (yob < 1900 || yob > new Date().getUTCFullYear()) {
      return { ok: false, error: 'VALIDATION', message: 'dateOfBirth phải trong khoảng năm 1900 đến năm hiện tại.' };
    }
    data.dateOfBirth = parsed;
  }

  const existing = await db.agent.findFirst({ where: { id: agentId, deletedAt: null } });
  if (!existing) return { ok: false, error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' };

  const updated = await db.agent.update({ where: { id: agentId }, data });
  return { ok: true, data: toDto(updated) };
}

// ── Đổi email liên kết — luồng OTP gửi tới email MỚI (1/8, SỬA GẤP giữa chừng, xem comment đầu file) ────────

/** Chuẩn hoá + validate ĐỊNH DẠNG email mới (trim + lowercase + regex cơ bản) — KHÔNG kiểm trùng ở đây (xem
 * isEmailTakenByOtherAgent riêng, để caller quyết định thời điểm kiểm — cần kiểm CẢ lúc request-otp LẪN lúc
 * confirm, phòng race 1 agent khác giành mất email đó ngay trong lúc OTP đang chờ nhập). */
export function validateNewEmailFormat(raw: string): { ok: true; email: string } | { ok: false; message: string } {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email || !EMAIL_RE.test(email)) return { ok: false, message: 'Email mới không hợp lệ.' };
  return { ok: true, email };
}

/** true nếu email đã thuộc 1 Agent KHÁC (agentId khác, còn sống — deletedAt: null) — chặn SỚM trước khi tốn 1
 * lượt gửi OTP, CÙNG cách routes/auth.ts register/verify-otp kiểm existingByEmail. agentId CHÍNH MÌNH bị loại
 * trừ (`NOT: { id: agentId }`) — agent tự "đổi" sang ĐÚNG email hiện tại của mình không nên bị báo trùng. */
export async function isEmailTakenByOtherAgent(db: Db, agentId: number, email: string): Promise<boolean> {
  const existing = await db.agent.findFirst({ where: { email, deletedAt: null, NOT: { id: agentId } } });
  return !!existing;
}

/** Ghi THẬT email mới vào Agent — gọi SAU KHI verifyOtpChallenge() ở routes/me.ts trả outcome 'OK'. Vẫn tự
 * bắt P2002 (race hiếm: 2 agent cùng đổi sang trùng 1 email mới GIỮA lúc isEmailTakenByOtherAgent() đã qua
 * nhưng CHƯA update xong — CÙNG lớp race routes/auth.ts createAgentViaGoogle() đã xử lý) — trả lỗi rõ 409
 * thay vì để Prisma ném lỗi 500 thô. */
export async function applyEmailChange(db: Db, agentId: number, newEmail: string): Promise<{ ok: true; data: AgentProfileDto } | ProfileServiceError> {
  try {
    const updated = await db.agent.update({ where: { id: agentId }, data: { email: newEmail } });
    return { ok: true, data: toDto(updated) };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: false, error: 'EMAIL_ALREADY_REGISTERED', message: 'Email này vừa được tài khoản khác đăng ký, vui lòng dùng email khác.' };
    }
    throw err;
  }
}

// ── Thêm/đổi SĐT xác thực — luồng OTP qua SMS eSMS.vn (4/8, CMD_BUILD, Admin Demo chốt nhà cung cấp eSMS) ────────
// CÙNG KHUÔN đổi email ở trên (validate định dạng riêng khỏi kiểm-trùng/ghi-DB, để route quyết định thời điểm
// gọi) nhưng dùng SMS thay email (esms-service.ts) và ghi Agent.phone thay Agent.email. otp-service.ts TÁI DÙNG
// NGUYÊN — challenge/verify/rate-limit/hash y hệt, chỉ khác `purpose='PHONE_CHANGE'` và "định danh" truyền vào
// là SĐT dạng 84 thay vì email (2 loại KHÔNG BAO GIỜ đụng nhau: email luôn chứa '@', SĐT toàn chữ số).

/** Chuẩn hoá + validate ĐỊNH DẠNG SĐT mới. Trả CẢ 2 dạng: `phone` (0xxxxxxxxx — dạng LƯU vào Agent.phone, đồng
 * nhất dữ liệu cũ) và `phone84` (84xxxxxxxxx — dạng eSMS cần để gửi SMS + làm "định danh" key cho OTP challenge,
 * ổn định giữa request-otp và verify). KHÔNG kiểm trùng ở đây (xem ghi chú applyPhoneChange). */
export function validateNewPhoneFormat(raw: string): { ok: true; phone: string; phone84: string } | { ok: false; message: string } {
  const phone84 = normalizeVnPhoneTo84(raw);
  const phone = normalizeVnPhoneToLocal(raw);
  if (!phone84 || !phone) {
    return { ok: false, message: 'Số điện thoại không hợp lệ. Nhập SĐT di động VN 10 số (vd 0912345678).' };
  }
  return { ok: true, phone, phone84 };
}

/** Ghi THẬT SĐT mới vào Agent.phone — gọi SAU KHI verifyOtpChallenge() (routes/me.ts) trả outcome 'OK'.
 *
 * TENTATIVE (chưa áp ràng buộc UNIQUE): schema hiện tại `Agent.phone` KHÔNG @unique (xem schema.prisma dòng
 * ~236: "phone String?", KHÔNG có @unique) và lookupAgentByEmailOrPhone() đã thiết kế phone khớp ra NHIỀU đại
 * lý (SĐT dùng chung hợp lệ trong nghiệp vụ này). Brief yêu cầu "chống đổi sang SĐT người khác đã dùng" NHƯNG
 * spec chưa khẳng định phone phải duy nhất — KHÔNG tự áp unique (đúng bài học cam_suy_luan/no unilateral schema
 * change + throwaway DB). Để LEAD chốt với Admin Demo: nếu cần cấm trùng → thêm migration @unique + kiểm trùng ở
 * ĐÂY (đối xứng isEmailTakenByOtherAgent). Hiện chỉ ghi thẳng, không kiểm trùng. */
export async function applyPhoneChange(db: Db, agentId: number, newPhone: string): Promise<{ ok: true; data: AgentProfileDto } | ProfileServiceError> {
  const existing = await db.agent.findFirst({ where: { id: agentId, deletedAt: null } });
  if (!existing) return { ok: false, error: 'AGENT_NOT_FOUND', message: 'Đại lý không tồn tại.' };
  const updated = await db.agent.update({ where: { id: agentId }, data: { phone: newPhone } });
  return { ok: true, data: toDto(updated) };
}
