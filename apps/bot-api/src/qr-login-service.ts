// SIGMA (3/8) — Đăng nhập bằng quét QR động (kiểu Zalo/WhatsApp Web). Đây là LÕI NGHIỆP VỤ (service) tách
// khỏi route (qr-login.ts) để test đơn vị chạy thẳng trên DB throwaway không cần dựng HTTP. Threat-model đã
// duyệt (bảo mật là ưu tiên số 1) — mọi ràng buộc dưới đây là BẮT BUỘC, KHÔNG được cắt xén:
//
//  1. Token QR + pollSecret đều 256-bit CSPRNG (crypto.randomBytes(32)). DB CHỈ lưu HASH sha-256 — token/
//     pollSecret THÔ không bao giờ ghi xuống đĩa. So khớp bằng cách hash input rồi tra theo cột hash UNIQUE
//     (tokenHash) hoặc so constant-time (matchCode). CÙNG khuôn otp-service.ts (hash mã, KHÔNG lưu plaintext).
//  2. pollSecret riêng cấp cho MÁY TẠO QR (cookie httpOnly) — chỉ máy có pollSecret mới claim được phiên ở
//     bước status. Người chỉ NHÌN/chụp QR (không có cookie) KHÔNG lấy được phiên.
//  3. QR động: web gọi lại create mỗi ~60s để XOAY token (tạo challenge MỚI cùng pollSecret). TTL mỗi challenge
//     120s (giao nhau 1 nhịp, tránh hụt lúc đang quét). 1-LẦN-DÙNG: chuyển PENDING→APPROVED→CONSUMED atomic
//     (updateMany có ĐIỀU KIỆN status ở WHERE — chỉ 1 caller thắng, chống double-approve/double-consume/race).
//  4. approve CHỈ nhận agentId từ phiên điện thoại đã xác thực (route truyền req.agent.id, KHÔNG tin input).
//  5. matchCode 2 chữ số: hiển thị trên PC, điện thoại phải GÕ LẠI — so constant-time, sai 3 lần → HỦY
//     challenge (chống dò 2 chữ số). matchCode ỔN ĐỊNH theo pollSecret (xoay token KHÔNG đổi mã người dùng đang
//     đọc). KHÔNG lộ matchCode qua getRequesterInfo (buộc đọc trên PC).
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

// TTL 120s cho mỗi challenge (token). Web xoay token mỗi ROTATE_INTERVAL_MS (~60s) — CHALLENGE_TTL_MS gấp đôi
// để token cũ còn sống 1 nhịp khi token mới vừa sinh (tránh khoảng "chết" lúc người dùng đang quét đúng lúc xoay).
export const CHALLENGE_TTL_MS = 120_000;
export const ROTATE_INTERVAL_SECONDS = 60;
// Trần số challenge PENDING còn sống cho 1 pollSecret — chặn 1 máy (hoặc kẻ giữ 1 cookie) tạo vô hạn challenge
// làm phình bảng. Bình thường tối đa 2 sống cùng lúc (token đang xoay), 8 là dư dả cho jitter/nhiều tab.
const MAX_PENDING_PER_POLL_SECRET = 8;
// Số lần GÕ SAI matchCode tối đa trước khi HỦY challenge (chống dò 2 chữ số — 100 khả năng, ít lần thử là đủ).
// AUDIT-vá LOW #3 (security-audit độc lập): NGÂN SÁCH đoán đếm theo CẢ NHÓM pollSecret (mọi lần xoay token cùng
// máy), KHÔNG theo từng hàng token — trước đây xoay token reset về 0, cho kẻ tấn công N lần MỖI nhịp 60s.
// 4/8 (Admin Demo "quét sai quá 5 lần tạm block như Zalo"): ngưỡng 5 (khớp yêu cầu). Đây là tầng HỦY CHALLENGE
// (theo pollSecret/máy tạo QR). Tầng thứ 2 = TẠM KHÓA THEO AGENT (điện thoại duyệt) ở route qr-login.ts
// (qr-approve-lockout.ts): sai tích luỹ ≥5 → khóa duyệt QR 10 phút, chống né bằng cách tạo QR mới liên tục.
export const MAX_APPROVE_ATTEMPTS = 5;

// AUDIT-vá MEDIUM #1: hàng CONSUMED = NHẬT KÝ đăng nhập-qua-QR (mục 8) — PHẢI sống lâu, tách khỏi TTL challenge
// (120s). Giữ 90 ngày rồi mới dọn (đủ để người dùng soi "đăng nhập lạ"). Hàng chưa CONSUMED dọn theo expiresAt.
const CONSUMED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** So khớp constant-time 2 chuỗi (chống timing-attack đoán matchCode). Độ dài khác nhau → false NGAY (nhưng
 * vẫn gọi timingSafeEqual trên 2 buffer cùng độ dài để không rò rỉ độ dài qua timing của chính hàm này). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // So chính ab với ab để tốn cùng thời lượng, rồi trả false — không thoát sớm theo độ dài.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** 256-bit ngẫu nhiên mật mã học, base64url — dùng cho CẢ token QR và pollSecret (2 giá trị độc lập). */
function generate256BitToken(): string {
  return randomBytes(32).toString('base64url');
}

/** matchCode 2 chữ số "00".."99" (randomInt = CSPRNG, KHÔNG Math.random). Giữ số 0 đứng đầu. */
function generateMatchCode(): string {
  return String(randomInt(0, 100)).padStart(2, '0');
}

export interface CreateChallengeInput {
  /** pollSecret THÔ đọc từ cookie hiện có của máy (nếu đã có) — reuse để matchCode/danh tính máy ổn định qua
   * các lần xoay token. Rỗng/thiếu → sinh pollSecret MỚI (máy lần đầu tạo QR). */
  existingPollSecret?: string | null;
  requesterIp?: string | null;
  requesterUa?: string | null;
}

export interface CreatedChallenge {
  /** Token THÔ — CHỈ trả về đúng 1 lần ở đây để web encode `sigma-login:v1:<token>` vào QR. KHÔNG lưu DB. */
  token: string;
  /** pollSecret THÔ — route set vào cookie httpOnly. Chỉ đổi khi máy chưa có cookie (existingPollSecret rỗng). */
  pollSecret: string;
  /** true nếu pollSecret là MỚI sinh (route cần set lại cookie); false nếu reuse cookie cũ (không cần set lại). */
  pollSecretIsNew: boolean;
  matchCode: string;
  expiresInSeconds: number;
  rotateInSeconds: number;
}

/** Dọn challenge đã QUÁ HẠN khỏi bảng (best-effort, KHÔNG chặn luồng chính nếu lỗi). Gọi ở đầu create — biên độ
 * dọn nhỏ, không cần worker nền riêng cho quy mô hiện tại. Xóa hẳn hàng expiresAt < now (kể cả CONSUMED/CANCELLED
 * đã quá hạn — chúng chỉ còn ý nghĩa nhật ký ngắn hạn; nhật ký dài hạn nằm ở endpoint events lọc theo agentId
 * còn sống trong DB tới khi hết hạn). */
export async function cleanupExpired(db: Db): Promise<void> {
  try {
    const now = new Date();
    // AUDIT-vá MEDIUM #1: KHÔNG còn xoá MỌI hàng expiresAt<now (trước đây xoá luôn hàng CONSUMED — nhật ký
    // đăng nhập-qua-QR mục 8 bay sau ~120s, /qr/events luôn rỗng). Giờ:
    //   - Hàng CHƯA CONSUMED (PENDING/APPROVED/CANCELLED/SUPERSEDED) hết hạn → xoá (rác challenge, không phải audit).
    //   - Hàng CONSUMED → CHỈ xoá khi consumedAt cũ hơn CONSUMED_RETENTION_MS (90 ngày) — giữ làm nhật ký.
    await db.qrLoginChallenge.deleteMany({
      where: {
        OR: [
          { status: { not: 'CONSUMED' }, expiresAt: { lt: now } },
          { status: 'CONSUMED', consumedAt: { lt: new Date(now.getTime() - CONSUMED_RETENTION_MS) } }
        ]
      }
    });
  } catch (err) {
    console.error('[bot-api] qr-login cleanupExpired thất bại (KHÔNG chặn luồng create):', err);
  }
}

/**
 * Tạo 1 challenge QR mới. Nếu máy đã có pollSecret (cookie) → REUSE (giữ matchCode ổn định + gom challenge cùng
 * 1 máy), ngược lại sinh pollSecret mới. matchCode lấy lại từ challenge PENDING gần nhất cùng pollSecret (để số
 * người dùng đang đọc trên PC KHÔNG đổi khi token xoay); chưa có → sinh mới. Áp trần MAX_PENDING_PER_POLL_SECRET.
 */
export async function createChallenge(db: Db, input: CreateChallengeInput): Promise<CreatedChallenge> {
  await cleanupExpired(db);

  const now = new Date();
  // AUDIT-vá MEDIUM #2 (chống session-fixation): CHỈ tin pollSecret client gửi lên khi nó đang SỞ HỮU 1 challenge
  // PENDING còn sống (đúng máy đang xoay token của phiên của mình). pollSecret LẠ/HẾT HẠN/BỊ GHIM (kẻ tấn công
  // đặt cookie __Host- cho nạn nhân) → KHÔNG "ngồi lên" nó, SINH pollSecret MỚI. Nhờ vậy kẻ tấn công không thể
  // ép nạn nhân dùng 1 pollSecret mà hắn biết trước để claim phiên ở /status.
  let pollSecret = input.existingPollSecret?.trim() || '';
  let pollSecretIsNew = false;
  let livePending: Awaited<ReturnType<typeof db.qrLoginChallenge.findFirst>> = null;
  if (pollSecret) {
    livePending = await db.qrLoginChallenge.findFirst({
      where: { pollSecretHash: sha256(pollSecret), status: 'PENDING', expiresAt: { gt: now } },
      orderBy: { id: 'desc' }
    });
    if (!livePending) pollSecret = ''; // secret lạ/hết hạn → bỏ, sinh mới bên dưới (không ngồi lên secret bị ghim)
  }
  if (!pollSecret) {
    pollSecret = generate256BitToken();
    pollSecretIsNew = true;
  }
  const pollSecretHash = sha256(pollSecret);

  // matchCode ổn định theo pollSecret: lấy từ challenge PENDING còn sống gần nhất (livePending ở trên, CHỈ có khi
  // pollSecret hợp lệ); chưa có (máy mới/secret vừa bị thay) → sinh mới.
  const matchCode = livePending?.matchCode ?? generateMatchCode();

  // Trần pending/pollSecret — nếu vượt, đánh dấu các challenge PENDING cũ NHẤT thành SUPERSEDED (không xóa hẳn để
  // giữ audit ngắn hạn). Đơn giản: nếu đang có ≥ trần, superseded TẤT CẢ pending cũ trừ nhịp mới sắp tạo.
  const pendingCount = await db.qrLoginChallenge.count({ where: { pollSecretHash, status: 'PENDING', expiresAt: { gt: now } } });
  if (pendingCount >= MAX_PENDING_PER_POLL_SECRET) {
    await db.qrLoginChallenge.updateMany({
      where: { pollSecretHash, status: 'PENDING' },
      data: { status: 'SUPERSEDED' }
    });
  }

  const token = generate256BitToken();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  await db.qrLoginChallenge.create({
    data: {
      tokenHash: sha256(token),
      pollSecretHash,
      matchCode,
      status: 'PENDING',
      requesterIp: input.requesterIp ?? null,
      requesterUa: input.requesterUa ?? null,
      expiresAt
    }
  });

  return {
    token,
    pollSecret,
    pollSecretIsNew,
    matchCode,
    expiresInSeconds: Math.floor(CHALLENGE_TTL_MS / 1000),
    rotateInSeconds: ROTATE_INTERVAL_SECONDS
  };
}

export interface RequesterInfo {
  requesterIp: string | null;
  requesterUa: string | null;
  createdAt: Date;
  expiresAt: Date;
  /** Vị trí gần đúng SUY từ IP (chỉ phân loại thô LAN/công khai — KHÔNG có geoip DB, xem note route). */
  approxLocation: string;
}

export type RequesterInfoResult =
  | { outcome: 'OK'; info: RequesterInfo }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'EXPIRED' };

/** Suy vị trí GẦN ĐÚNG từ IP — KHÔNG có geoip DB (không thêm dependency nặng + tránh gọi mạng ngoài trong luồng
 * đăng nhập). Chỉ phân loại thô: IP riêng (LAN) vs công khai. Trung thực: với IP công khai KHÔNG khẳng định
 * thành phố/quốc gia (chưa suy được) — hiển thị đúng như vậy. Đây là "nếu suy được từ IP" ở mức tối thiểu. */
export function approxLocationFromIp(ip: string | null | undefined): string {
  if (!ip) return 'Không xác định';
  const v = ip.replace(/^::ffff:/, '');
  if (v === '127.0.0.1' || v === '::1' || v.startsWith('10.') || v.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(v)) {
    return 'Mạng nội bộ (LAN)';
  }
  return 'IP công khai (chưa suy được vị trí chi tiết)';
}

/** Thông tin bên-yêu-cầu cho màn xác nhận trên điện thoại (đã auth). Tra theo TOKEN thô (hash rồi tra tokenHash).
 * KHÔNG trả matchCode (buộc người dùng đọc trên PC). Chỉ trả cho challenge còn PENDING & chưa hết hạn. */
export async function getRequesterInfo(db: Db, token: string): Promise<RequesterInfoResult> {
  if (!token) return { outcome: 'NOT_FOUND' };
  const ch = await db.qrLoginChallenge.findUnique({ where: { tokenHash: sha256(token) } });
  if (!ch || ch.status !== 'PENDING') return { outcome: 'NOT_FOUND' };
  if (ch.expiresAt.getTime() < Date.now()) return { outcome: 'EXPIRED' };
  return {
    outcome: 'OK',
    info: {
      requesterIp: ch.requesterIp,
      requesterUa: ch.requesterUa,
      createdAt: ch.createdAt,
      expiresAt: ch.expiresAt,
      approxLocation: approxLocationFromIp(ch.requesterIp)
    }
  };
}

export type ApproveOutcome = 'OK' | 'NOT_FOUND' | 'EXPIRED' | 'WRONG_CODE' | 'CANCELLED';

export interface ApproveResult {
  outcome: ApproveOutcome;
  /** Số lần thử còn lại (chỉ có nghĩa khi WRONG_CODE) — để UI điện thoại báo "còn N lần". */
  attemptsRemaining?: number;
}

/**
 * ĐIỆN THOẠI (đã auth) duyệt 1 challenge: {token, code, agentId(TỪ phiên, KHÔNG tin input)}. Atomic dưới
 * concurrency (SELECT ... FOR UPDATE khóa row trong transaction, CÙNG khuôn otp-service.ts) — chống 2 approve
 * song song / double-approve. matchCode so constant-time; sai → tăng approveAttempts, chạm MAX → HỦY (CANCELLED),
 * mọi approve sau (kể cả đúng mã) đều CANCELLED. Đúng mã + còn PENDING → chuyển APPROVED + gán agentId.
 */
export async function approveChallenge(db: Db, token: string, code: string, agentId: number): Promise<ApproveResult> {
  if (!token) return { outcome: 'NOT_FOUND' };
  const tokenHash = sha256(token);

  return db.$transaction(async (tx) => {
    const now = new Date();
    const ch = await tx.qrLoginChallenge.findUnique({ where: { tokenHash } });
    if (!ch) return { outcome: 'NOT_FOUND' as const };

    // Khóa row NGAY (giống otp-service B1 fix) — mọi approve khác cùng challenge phải chờ transaction này xong.
    await tx.$queryRaw`SELECT id FROM qr_login_challenges WHERE id = ${ch.id} FOR UPDATE`;
    const locked = await tx.qrLoginChallenge.findUniqueOrThrow({ where: { id: ch.id } });

    if (locked.status === 'CANCELLED') return { outcome: 'CANCELLED' as const };
    if (locked.status !== 'PENDING') return { outcome: 'NOT_FOUND' as const }; // APPROVED/CONSUMED/SUPERSEDED — không duyệt lại
    if (locked.expiresAt.getTime() < now.getTime()) return { outcome: 'EXPIRED' as const };

    if (!constantTimeEqual(code ?? '', locked.matchCode)) {
      // AUDIT-vá LOW #3: đếm ngân sách đoán theo CẢ NHÓM pollSecret (tổng approveAttempts của mọi challenge
      // CHƯA CONSUMED cùng pollSecretHash — gồm cả các token đã xoay), KHÔNG chỉ hàng token này. Trước đây xoay
      // token tạo hàng mới attempts=0 → reset ngân sách, cho kẻ tấn công 3 lần mỗi nhịp. `_sum` ĐÃ gồm giá trị
      // hiện tại của locked (trước khi +1), nên tổng mới = priorSum + 1.
      const agg = await tx.qrLoginChallenge.aggregate({
        where: { pollSecretHash: locked.pollSecretHash, status: { not: 'CONSUMED' } },
        _sum: { approveAttempts: true }
      });
      const groupTotal = (agg._sum.approveAttempts ?? 0) + 1;
      const willCancel = groupTotal >= MAX_APPROVE_ATTEMPTS;
      await tx.qrLoginChallenge.update({
        where: { id: locked.id },
        data: { approveAttempts: locked.approveAttempts + 1, status: willCancel ? 'CANCELLED' : 'PENDING' }
      });
      if (willCancel) {
        // Hủy TOÀN NHÓM: mọi token PENDING còn lại cùng pollSecret cũng chết theo (không cho dùng token xoay khác
        // để né). Người dùng thật phải làm mới mã QR trên PC (sinh pollSecret mới — xem createChallenge fix #2).
        await tx.qrLoginChallenge.updateMany({
          where: { pollSecretHash: locked.pollSecretHash, status: 'PENDING' },
          data: { status: 'CANCELLED' }
        });
        return { outcome: 'CANCELLED' as const };
      }
      return { outcome: 'WRONG_CODE' as const, attemptsRemaining: MAX_APPROVE_ATTEMPTS - groupTotal };
    }

    // Mã ĐÚNG + PENDING → APPROVED, gán danh tính điện thoại (agentId TỪ phiên).
    await tx.qrLoginChallenge.update({
      where: { id: locked.id },
      data: { status: 'APPROVED', agentId, approvedAt: now }
    });
    return { outcome: 'OK' as const };
  });
}

export type ConsumeOutcome = 'PENDING' | 'APPROVED' | 'EXPIRED';

export interface ConsumeResult {
  outcome: ConsumeOutcome;
  /** CHỈ set khi APPROVED — agentId đã duyệt để route mint phiên. Route tự load Agent + tạo WebSession. */
  agentId?: number;
  /** id challenge đã consume (để route ghi nhật ký/log). */
  challengeId?: number;
}

/**
 * MÁY TẠO QR (có cookie pollSecret) hỏi trạng thái. Tìm challenge APPROVED gần nhất của pollSecret này → CONSUME
 * atomic (updateMany điều kiện status='APPROVED' → chỉ 1 caller thắng, chống double-consume) → trả agentId để
 * route mint phiên. Không có APPROVED nhưng còn PENDING sống → 'PENDING'. Không còn gì sống → 'EXPIRED'.
 * KHÔNG có pollSecret hợp lệ (cookie thiếu/sai) → LUÔN rơi 'EXPIRED' (không tìm thấy hàng nào theo hash) — người
 * chỉ nhìn QR KHÔNG có cookie này nên KHÔNG BAO GIỜ claim được phiên.
 */
export async function consumeIfApproved(db: Db, pollSecret: string): Promise<ConsumeResult> {
  if (!pollSecret) return { outcome: 'EXPIRED' };
  const pollSecretHash = sha256(pollSecret);
  const now = new Date();

  const approved = await db.qrLoginChallenge.findFirst({
    where: { pollSecretHash, status: 'APPROVED', expiresAt: { gt: now } },
    orderBy: { id: 'desc' }
  });
  if (approved) {
    // CONSUME atomic: chỉ hàng còn đúng status='APPROVED' mới chuyển được → 2 request status song song, chỉ 1
    // thắng (count=1), request kia count=0 coi như chưa tới lượt (sẽ thấy PENDING/EXPIRED lần poll sau).
    const claimed = await db.qrLoginChallenge.updateMany({
      where: { id: approved.id, status: 'APPROVED' },
      data: { status: 'CONSUMED', consumedAt: now }
    });
    if (claimed.count === 1) {
      return { outcome: 'APPROVED', agentId: approved.agentId ?? undefined, challengeId: approved.id };
    }
    // Thua race — rơi xuống kiểm pending bên dưới.
  }

  const pending = await db.qrLoginChallenge.findFirst({
    where: { pollSecretHash, status: 'PENDING', expiresAt: { gt: now } }
  });
  if (pending) return { outcome: 'PENDING' };
  return { outcome: 'EXPIRED' };
}

/** Nhật ký sự kiện đăng nhập-qua-QR của 1 agent (item 8) — các challenge đã CONSUMED gần đây gán agentId này. */
export interface QrLoginEvent {
  id: number;
  requesterIp: string | null;
  requesterUa: string | null;
  approxLocation: string;
  approvedAt: Date | null;
  consumedAt: Date | null;
}

export async function listQrLoginEvents(db: Db, agentId: number, limit = 20): Promise<QrLoginEvent[]> {
  const rows = await db.qrLoginChallenge.findMany({
    where: { agentId, status: 'CONSUMED' },
    orderBy: { id: 'desc' },
    take: limit
  });
  return rows.map((r) => ({
    id: r.id,
    requesterIp: r.requesterIp,
    requesterUa: r.requesterUa,
    approxLocation: approxLocationFromIp(r.requesterIp),
    approvedAt: r.approvedAt,
    consumedAt: r.consumedAt
  }));
}
