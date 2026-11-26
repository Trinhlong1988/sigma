// SIGMA (1/8, mục 32 "Sao lưu, đồng bộ") — Admin Demo chốt hướng KHÁC Zalo (xem comment schema.prisma model
// Agent): server ĐÃ lưu vĩnh viễn mọi tin nhắn, tính năng này CHỈ xuất lịch sử chat CỦA MÌNH ra 1 file JSON rồi
// đẩy lên Google Drive CÁ NHÂN của họ — bản sao độc lập ngoài app, KHÔNG phải disaster-recovery.
//
// Luồng OAuth ở đây HOÀN TOÀN KHÁC google-oauth-service.ts (file đó verify ID-token thuần cho ĐĂNG NHẬP, KHÔNG
// có Client Secret, KHÔNG xin quyền gì). Ở ĐÂY dùng Authorization Code flow (google-auth-library OAuth2Client,
// CÙNG thư viện ĐÃ CÓ SẴN trong node_modules/package.json — KHÔNG cài thêm gì) xin ĐÚNG 1 scope
// `drive.file` (an toàn — app CHỈ đọc/ghi được file CHÍNH NÓ tạo ra qua API này, KHÔNG đọc được Drive còn lại
// của người dùng) để lấy `refresh_token` dùng lại nhiều lần không phải xin quyền lại mỗi lần.
//
// Drive API gọi thẳng qua REST (`fetch` — Node 24 có sẵn global fetch, KHÔNG cần cài `googleapis`, đúng ràng
// buộc "KHÔNG npm install thêm trừ khi thực sự cần" — package `googleapis` KHÔNG có sẵn trong node_modules,
// đã kiểm trước khi viết file này) thay vì dùng SDK `googleapis` (KHÔNG có sẵn trong node_modules/package.json
// — đã kiểm TRƯỚC khi viết file này, xem báo cáo build; KHÔNG tự ý cài thêm gói ngoài phạm vi đã duyệt).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import type { Db } from '@sigma/database';
import { listRoomsForAgent } from './services/chat-room-service.js';
import { listMessages } from './services/chat-message-service.js';

export class DriveBackupError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DriveBackupError';
    this.code = code;
  }
}

// ── Mã hoá đối xứng refresh_token (1/8) ─────────────────────────────────────────────────────────────────────
// AUDIT ĐỘC LẬP (grep 'crypto'/'encrypt' toàn apps/bot-api/src TRƯỚC khi viết, xem báo cáo build) — repo KHÔNG
// có helper mã hoá 2 chiều sẵn (device-trust-service.ts/otp-service.ts CHỈ hash 1 chiều SHA-256 cho token —
// KHÔNG áp dụng được ở đây vì refresh_token PHẢI giải mã lại được để gọi Drive API). Viết mới AES-256-GCM
// (Node `node:crypto` built-in, KHÔNG cần thư viện ngoài) — NỢ KỸ THUẬT đã ghi rõ ở comment schema.prisma
// model Agent: khoá DRIVE_TOKEN_ENC_KEY hiện là biến môi trường phẳng, chưa qua KMS/HSM riêng — LEAD cân nhắc
// nâng cấp đợt sau nếu cần.
//
// Định dạng lưu: "ivBase64.authTagBase64.ciphertextBase64" (1 chuỗi, dễ lưu cột TEXT). IV 12 byte (khuyến nghị
// chuẩn GCM), sinh MỚI mỗi lần mã hoá (KHÔNG tái dùng IV — tái dùng IV với CÙNG khoá phá vỡ tính an toàn GCM).
function encryptionKey(): Buffer {
  const raw = process.env.DRIVE_TOKEN_ENC_KEY;
  if (!raw) {
    throw new DriveBackupError('CONFIG_MISSING', 'Thiếu biến môi trường DRIVE_TOKEN_ENC_KEY.');
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new DriveBackupError('CONFIG_MISSING', 'DRIVE_TOKEN_ENC_KEY không đúng định dạng base64.');
  }
  if (key.length !== 32) {
    throw new DriveBackupError('CONFIG_MISSING', 'DRIVE_TOKEN_ENC_KEY phải là khoá 32 byte mã hoá base64 (vd: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))").');
  }
  return key;
}

export function encryptRefreshToken(plainRefreshToken: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainRefreshToken, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptRefreshToken(stored: string): string {
  const key = encryptionKey();
  const parts = stored.split('.');
  if (parts.length !== 3) {
    throw new DriveBackupError('DECRYPT_FAILED', 'Dữ liệu refresh token lưu sai định dạng.');
  }
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (err) {
    // GCM tự phát hiện ciphertext bị hỏng/khoá sai (authTag không khớp) → throw ở decipher.final(). Bọc lại
    // thành DriveBackupError có code rõ ràng thay vì để lỗi crypto thô lọt ra route (đúng R198 "check phải
    // chạy, không nuốt lỗi im" — lỗi này PHẢI thành finding rõ ràng cho agent gọi, không phải 500 mù mờ).
    throw new DriveBackupError('DECRYPT_FAILED', `Giải mã refresh token thất bại: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── OAuth Authorization Code flow (1/8) ─────────────────────────────────────────────────────────────────────
// Đọc process.env LÚC GỌI (không cache theo giá trị lúc import module) — CÙNG nguyên tắc google-oauth-
// service.ts đã áp dụng, để đổi env trong test/khi Admin Demo điền Client Secret thật KHÔNG cần restart tiến trình
// mới ăn giá trị mới (tsx watch reload lại module là đủ).
function oauthClientConfig(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) throw new DriveBackupError('CONFIG_MISSING', 'Thiếu GOOGLE_CLIENT_ID trong biến môi trường.');
  if (!clientSecret) throw new DriveBackupError('CONFIG_MISSING', 'Thiếu GOOGLE_CLIENT_SECRET trong biến môi trường.');
  return { clientId, clientSecret };
}

export type ExchangeCodeResult =
  | { ok: true; refreshToken: string }
  | { ok: false; kind: 'CONFIG_MISSING' | 'INVALID_CODE' | 'NO_REFRESH_TOKEN'; message: string };

/** Đổi authorization code (frontend lấy được từ popup `google.accounts.oauth2.initCodeClient`, xem
 * lib/google-drive-backup.ts phía web-demo) lấy `refresh_token` thật. `redirectUri: 'postmessage'` là giá trị
 * ĐẶC BIỆT dùng khi code đến từ luồng popup (ux_mode:'popup') của Google Identity Services — KHÔNG phải URL
 * thật nào (xác nhận qua tài liệu chính thức Google "Use Code Model", KHÔNG suy đoán). `access_type:'offline'`
 * + `prompt:'consent'` PHẢI được đặt ở PHÍA CLIENT lúc initCodeClient (không đặt được lại ở đây) — nếu Google
 * không trả `refresh_token` (vd người dùng đã từng cấp quyền, Google không lặp lại refresh_token nếu thiếu
 * ép `consent`), trả lỗi NO_REFRESH_TOKEN rõ ràng thay vì lưu `null` âm thầm. */
export async function exchangeAuthorizationCode(code: string): Promise<ExchangeCodeResult> {
  let clientId: string;
  let clientSecret: string;
  try {
    ({ clientId, clientSecret } = oauthClientConfig());
  } catch (err) {
    return { ok: false, kind: 'CONFIG_MISSING', message: err instanceof Error ? err.message : String(err) };
  }

  const client = new OAuth2Client({ clientId, clientSecret, redirectUri: 'postmessage' });
  let tokens: { refresh_token?: string | null };
  try {
    const result = await client.getToken(code);
    tokens = result.tokens;
  } catch (err) {
    return { ok: false, kind: 'INVALID_CODE', message: err instanceof Error ? err.message : String(err) };
  }

  if (!tokens.refresh_token) {
    return {
      ok: false,
      kind: 'NO_REFRESH_TOKEN',
      message: 'Google không trả về refresh token — vui lòng ngắt kết nối trong tài khoản Google rồi thử kết nối lại.'
    };
  }
  return { ok: true, refreshToken: tokens.refresh_token };
}

/** Đổi refresh_token đã lưu lấy access_token MỚI (access_token hết hạn sau ~1h, refresh_token dùng lại được
 * nhiều lần cho tới khi người dùng tự thu hồi quyền phía Google). */
async function accessTokenFromRefreshToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = oauthClientConfig();
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  let response: { token?: string | null };
  try {
    response = await client.getAccessToken();
  } catch (err) {
    // Refresh token bị người dùng thu hồi thẳng trong tài khoản Google (Settings > Third-party access) là
    // nguyên nhân THẬT phổ biến nhất gây lỗi ở đây — map rõ code riêng để route trả 401 (yêu cầu kết nối lại),
    // KHÔNG phải 500 mù mờ.
    throw new DriveBackupError('DRIVE_TOKEN_REFRESH_FAILED', `Làm mới quyền truy cập Google Drive thất bại (có thể đã bị thu hồi quyền): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.token) {
    throw new DriveBackupError('DRIVE_TOKEN_REFRESH_FAILED', 'Google không trả về access token mới.');
  }
  return response.token;
}

// ── Xây nội dung backup JSON (1/8) — TÁI DÙNG NGUYÊN listRoomsForAgent/listMessages đã có sẵn
// (chat-room-service.ts/chat-message-service.ts), KHÔNG viết lại query mới. ───────────────────────────────────
export interface DriveBackupMessageDto {
  senderId: number | null;
  senderName: string | null;
  text: string;
  sentAt: string;
}

export interface DriveBackupRoomDto {
  roomId: string;
  roomName: string;
  messages: DriveBackupMessageDto[];
}

export interface DriveBackupContent {
  exportedAt: string;
  agent: { id: number; name: string };
  rooms: DriveBackupRoomDto[];
}

type RawMessageRow = Awaited<ReturnType<typeof listMessages>>['messages'][number];

// Giới hạn an toàn mỗi phòng — phòng cực nhiều tin (vd nhóm hoạt động lâu năm) không kéo 1 lần vô hạn, tránh
// backup treo lâu/1 file khổng lồ. TENTATIVE (Admin Demo chưa chốt số cụ thể) — 5000 tin/phòng đủ dư cho quy mô
// hiện tại, LEAD điều chỉnh nếu cần.
const MAX_MESSAGES_PER_ROOM = 5000;
const MESSAGES_PAGE_SIZE = 100;

function placeholderText(m: Pick<RawMessageRow, 'kind' | 'body' | 'deletedAt' | 'attachmentId'>, fileNameByAttachmentId: Map<string, string>): string {
  // Tin đã "thu hồi" (soft-delete) đã bị null hoá body/attachmentId ở nguồn (deleteMessage(), chat-message-
  // service.ts) — kiểm deletedAt TRƯỚC để không hiện chuỗi rỗng vô nghĩa.
  if (m.deletedAt) return '[Tin nhắn đã thu hồi]';
  switch (m.kind) {
    case 'TEXT':
      return m.body ?? '';
    case 'IMAGE':
      return '[Ảnh]';
    case 'VOICE':
      return '[Tin nhắn thoại]';
    case 'LOCATION':
      return '[Vị trí]';
    case 'QR':
      return '[Mã QR]';
    case 'FILE': {
      const fileName = m.attachmentId ? fileNameByAttachmentId.get(m.attachmentId) : undefined;
      return fileName ? `[File: ${fileName}]` : '[File]';
    }
    default:
      return m.body ?? '';
  }
}

/** Xây toàn bộ nội dung backup (mọi phòng + tin nhắn CỦA agent này) — CHỈ text, bỏ qua nội dung ảnh/file/voice
 * thật sự (quá lớn để đưa vào 1 file JSON, chỉ ghi placeholder — ĐÚNG giới hạn Zalo cũng có "không hỗ trợ backup
 * ảnh/video/file", KHÔNG làm hơn Zalo, xem yêu cầu nhiệm vụ). */
export async function buildAgentBackupContent(db: Db, agent: { id: number; name: string }): Promise<DriveBackupContent> {
  const roomSummaries = await listRoomsForAgent(db, agent.id);

  const messagesByRoomId = new Map<string, RawMessageRow[]>();
  const senderIds = new Set<number>();
  const attachmentIds = new Set<string>();

  for (const room of roomSummaries) {
    if (room.type === 'DIRECT' && room.otherAgentId !== null) senderIds.add(room.otherAgentId);

    const collected: RawMessageRow[] = [];
    let before: string | undefined;
    while (collected.length < MAX_MESSAGES_PER_ROOM) {
      const page = await listMessages(db, room.id, agent.id, { before, limit: MESSAGES_PAGE_SIZE });
      if (page.messages.length === 0) break;
      collected.push(...page.messages);
      if (!page.hasMore) break;
      before = page.messages[page.messages.length - 1]!.id;
    }
    collected.reverse(); // listMessages trả mới→cũ; đảo lại thành cũ→mới, đọc tự nhiên như lịch sử chat thật.
    messagesByRoomId.set(room.id, collected);
    for (const m of collected) {
      if (m.senderId !== null) senderIds.add(m.senderId);
      if (m.attachmentId) attachmentIds.add(m.attachmentId);
    }
  }

  const [senderRows, attachmentRows] = await Promise.all([
    senderIds.size > 0 ? db.agent.findMany({ where: { id: { in: [...senderIds] } }, select: { id: true, name: true } }) : Promise.resolve([]),
    attachmentIds.size > 0 ? db.chatAttachment.findMany({ where: { id: { in: [...attachmentIds] } }, select: { id: true, fileName: true } }) : Promise.resolve([])
  ]);
  const nameBySenderId = new Map(senderRows.map((r) => [r.id, r.name]));
  const fileNameByAttachmentId = new Map(attachmentRows.map((r) => [r.id, r.fileName]));

  const rooms: DriveBackupRoomDto[] = roomSummaries.map((room) => {
    const roomName =
      room.name ??
      (room.type === 'DIRECT'
        ? (room.otherAgentId !== null ? (nameBySenderId.get(room.otherAgentId) ?? `Đại lý #${room.otherAgentId}`) : 'Chat trực tiếp')
        : 'Nhóm chat');
    const messages = (messagesByRoomId.get(room.id) ?? []).map((m) => ({
      senderId: m.senderId,
      senderName: m.senderId !== null ? (nameBySenderId.get(m.senderId) ?? null) : null,
      text: placeholderText(m, fileNameByAttachmentId),
      sentAt: m.createdAt.toISOString()
    }));
    return { roomId: room.id, roomName, messages };
  });

  return { exportedAt: new Date().toISOString(), agent: { id: agent.id, name: agent.name }, rooms };
}

// ── Upload lên Google Drive (1/8) — gọi REST trực tiếp bằng fetch, KHÔNG dùng SDK `googleapis` (KHÔNG có sẵn
// trong node_modules, xem comment đầu file). `uploadType=multipart` — đủ dùng cho file JSON nhỏ (backup text
// thuần, không phải file lớn cần resumable upload). ────────────────────────────────────────────────────────
export interface DriveUploadResult {
  fileId: string;
  fileName: string;
}

export async function uploadJsonToDrive(accessToken: string, fileName: string, jsonContent: string): Promise<DriveUploadResult> {
  const boundary = `sigma-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name: fileName, mimeType: 'application/json' });
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${jsonContent}\r\n` +
    `--${boundary}--`;

  let res: Response;
  try {
    res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    });
  } catch (err) {
    throw new DriveBackupError('DRIVE_UPLOAD_FAILED', `Không gọi được Google Drive API: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DriveBackupError('DRIVE_UPLOAD_FAILED', `Google Drive trả lỗi HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { id?: string; name?: string };
  if (!json.id) {
    throw new DriveBackupError('DRIVE_UPLOAD_FAILED', 'Google Drive không trả về fileId sau khi upload.');
  }
  return { fileId: json.id, fileName: json.name ?? fileName };
}

// ── Hàm tổng hợp dùng ở route POST /v1/me/drive-backup/run (1/8) ───────────────────────────────────────────
export interface RunBackupResult {
  fileId: string;
  fileName: string;
  uploadedAt: string;
}

/** Chạy 1 lượt backup ĐẦY ĐỦ: giải mã refresh_token đã lưu → lấy access_token mới → xây nội dung backup → upload
 * Drive. KHÔNG tự cập nhật `googleDriveLastBackupAt` (caller — route — tự ghi SAU KHI hàm này trả về thành công,
 * để route giữ quyền quyết định transaction/thời điểm ghi, đúng ranh giới service/route chung của repo). */
export async function runAgentDriveBackup(db: Db, agent: { id: number; name: string }, encryptedRefreshToken: string): Promise<RunBackupResult> {
  const refreshToken = decryptRefreshToken(encryptedRefreshToken);
  const accessToken = await accessTokenFromRefreshToken(refreshToken);
  const content = await buildAgentBackupContent(db, agent);
  const fileName = `SigMa-backup-${agent.id}-${Date.now()}.json`;
  const uploaded = await uploadJsonToDrive(accessToken, fileName, JSON.stringify(content, null, 2));
  return { fileId: uploaded.fileId, fileName: uploaded.fileName, uploadedAt: new Date().toISOString() };
}
