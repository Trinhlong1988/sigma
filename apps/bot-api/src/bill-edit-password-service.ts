// MẬT KHẨU SỬA BILL (Admin Demo 1/9 "phải nhập mật khẩu mới sửa được, để mật khẩu 1111; thêm setup/đổi mật khẩu;
// đổi chỉ Nhân viên B + Nguoi Dung Demo example.com") — 1 mật khẩu GLOBAL (không per-user) gác thao tác SỬA tham số
// bill trên card. Mặc định '1111' khi CHƯA set. Lưu app_settings key 'bill.editPassword' = bcrypt hash (KHÔNG lưu
// plaintext). ĐỔI mật khẩu: chỉ 2 tài khoản allowlist (username 'admin'=Nguoi Dung Demo/demo id2, 'KeToanDemo'=Trần
// Ke Toan Demo id3 — dùng USERNAME cho bền, id có thể lệch nếu reseed sau data-loss) + phải nhập ĐÚNG mật khẩu hiện tại.
import { hashPassword, verifyPasswordHash } from './password-service';

const KEY = 'bill.editPassword';
const DEFAULT_PW = '1111';
/** EMAIL AGENT được phép ĐỔI mật khẩu sửa (người sửa bill trong chat = Agent, KHÔNG phải users-table). Nguoi Dung Demo
 *  = agent id270 code DL22 email '<DIEN_VAO>' (khớp "demo" Admin Demo chỉ); Nhân viên B = agent id381
 *  code DL62 email 'user1@example.com'. CHỈ 2 email này (Admin Demo xác nhận "tk đúng" 1/9). So khớp
 *  KHÔNG phân biệt hoa/thường. LOẠI agent id408 "long trịnh"/user4 (không phải demo). */
export const BILL_EDIT_PW_CHANGER_EMAILS = ['<DIEN_VAO>', 'user1@example.com'];
function isAllowedChanger(email: string | null | undefined): boolean {
  return !!email && BILL_EDIT_PW_CHANGER_EMAILS.includes(email.trim().toLowerCase());
}

/** DB tối thiểu cần: app_settings findUnique/upsert. */
interface EditPwDb {
  appSetting: {
    findUnique: (a: { where: { key: string } }) => Promise<{ value: string | null } | null>;
    upsert: (a: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => Promise<unknown>;
  };
}

/** true nếu mật khẩu sửa ĐÃ được set (khác mặc định). Dùng cho UI biết đang ở chế độ setup (còn 1111) hay đã đổi. */
export async function isBillEditPasswordSet(db: EditPwDb): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key: KEY } });
  return !!row?.value;
}

/** Kiểm mật khẩu sửa. CHƯA set (không row / value rỗng) → so khớp mặc định '1111'. Đã set → bcrypt compare.
 *  KHÔNG throw — trả false khi sai/hỏng. */
export async function verifyBillEditPassword(db: EditPwDb, plain: string): Promise<boolean> {
  if (typeof plain !== 'string' || plain.length === 0) return false;
  const row = await db.appSetting.findUnique({ where: { key: KEY } });
  if (!row?.value) return plain === DEFAULT_PW;
  return verifyPasswordHash(plain, row.value);
}

export type SetBillEditPwResult =
  | { ok: true }
  | { ok: false; error: 'FORBIDDEN' | 'CURRENT_PASSWORD_WRONG' | 'PASSWORD_TOO_SHORT' };

/** ĐỔI/SETUP mật khẩu sửa. Gác 2 lớp: (1) actorUsername ∈ allowlist, (2) currentPlain khớp mật khẩu hiện tại
 *  (mặc định '1111' nếu chưa set) — chống người có phiên đúng tài khoản nhưng không biết mật khẩu cũ đổi bừa.
 *  newPlain tối thiểu 4 ký tự. Ghi bcrypt hash vào app_settings. */
export async function setBillEditPassword(
  db: EditPwDb,
  actorEmail: string | null | undefined,
  currentPlain: string,
  newPlain: string
): Promise<SetBillEditPwResult> {
  if (!isAllowedChanger(actorEmail)) return { ok: false, error: 'FORBIDDEN' };
  // SEC-HIGH (1/9): mật khẩu MỚI tối thiểu 6 ký tự (mặc định 1111 chỉ là fallback — KT Demo/ND Demo NÊN đổi sang ≥6).
  if (typeof newPlain !== 'string' || newPlain.trim().length < 6) return { ok: false, error: 'PASSWORD_TOO_SHORT' };
  const currentOk = await verifyBillEditPassword(db, currentPlain);
  if (!currentOk) return { ok: false, error: 'CURRENT_PASSWORD_WRONG' };
  const hash = await hashPassword(newPlain.trim());
  await db.appSetting.upsert({ where: { key: KEY }, update: { value: hash }, create: { key: KEY, value: hash } });
  return { ok: true };
}
