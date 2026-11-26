// SIGMA (27/7) — regression cho chat-attachment-service.ts (đính kèm ảnh/file chat THẬT, "Phần 1" kế
// hoạch đính kèm). Model `ChatAttachment` CHƯA `prisma migrate deploy`/`generate` lên client dùng chung
// (đúng CẤM tuyệt đối B37/B42) — bảng `chat_attachments` chỉ tồn tại nhờ throwaway DB của suite này TỰ chạy
// `prisma migrate deploy` ở global-setup.ts (bao gồm CẢ migration MỚI viết cho bảng này), KHÔNG cần thao tác gì
// thêm. Service dùng raw SQL ($queryRaw/$executeRaw) nên hoạt động đúng ngay cả khi model chưa có trong client
// generated — xem comment đầu chat-attachment-service.ts.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent } from './fixtures.js';
import { ALLOWED_MIME_TO_EXT, MAX_ATTACHMENT_SIZE_BYTES, getAttachmentFile, getAttachmentRow, saveAttachment, setAttachmentRoomId } from '../src/chat-attachment-service.js';

// PNG 1x1 THẬT ĐẦY ĐỦ (signature + IHDR + IDAT + IEND hợp lệ, KHÔNG phải chỉ 8 byte signature) — tự verify
// bằng node script TRỰC TIẾP TRƯỚC khi viết test này: `fileTypeFromBuffer()` (file-type, thư viện sniff
// magic-bytes dùng trong chat-attachment-service.ts) trả `undefined` cho buffer chỉ có 8-byte signature PNG +
// filler tuỳ ý (khác PNG_1PX cũ trong qr.test.ts — file đó KHÔNG đi qua sniff thật, chỉ gán tay
// `qrImageMime:'image/png'`) — PNG thật CẦN ít nhất chunk IHDR hợp lệ ngay sau signature mới được nhận diện.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00]);
const PLAIN_TEXT_AS_JPG = Buffer.from('day chi la mot file .txt gia mao doi ten thanh .jpg, khong phai anh that', 'utf8');

// SIGMA (31/7, việc #5 — nối ghi âm tin nhắn thoại THẬT) — 64 byte ĐẦU của 1 file WebM/Opus CHỈ CÓ AUDIO
// THẬT (sinh bằng `ffmpeg -f lavfi -i "sine=..." -c:a libopus -f webm`, mô phỏng CHÍNH XÁC output thật của
// `MediaRecorder({mimeType:'audio/webm;codecs=opus'})` trên Chromium/Android WebView — mimeType ưu tiên #1 của
// `voice-recording.ts`) — CẮT chỉ giữ EBML header (KHÔNG cần audio payload, detector `file-type` chỉ đọc field
// `DocType` của header, xem comment `chat-attachment-service.ts` ALLOWED_MIME_TO_EXT). Đã TỰ VERIFY THẬT
// (KHÔNG suy đoán) bằng `fileTypeFromBuffer()` TRƯỚC khi viết test: 32 byte đã đủ để detect, dùng 64 cho dư —
// kết quả THẬT là `{"ext":"webm","mime":"video/webm"}`, KHÔNG PHẢI `audio/webm` (file-type KHÔNG phân biệt
// audio-only/có-video cho WebM — chỉ đọc DocType container, xem comment nguồn ALLOWED_MIME_TO_EXT). ĐÂY LÀ
// PHÁT HIỆN THẬT quan trọng nhất của việc #5: allowlist PHẢI ghi `video/webm`, ghi `audio/webm` (theo trực
// giác/tên MediaRecorder) sẽ khiến MỌI voice message bị từ chối vĩnh viễn — xem test bên dưới xác nhận đúng
// hành vi (KHÔNG chỉ kiểm allowlist có đúng KEY, mà kiểm THẬT `saveAttachment()` chấp nhận buffer audio thật).
const WEBM_AUDIO_HEADER = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAACeREU2bdLpNu4tTq4QVSalmUw==',
  'base64'
);

describe('chat-attachment-service — saveAttachment', () => {
  it('upload ảnh PNG hợp lệ → ok:true, mimeType đúng theo magic-bytes THẬT (không tin tên file), row ghi DB thật', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const result = await saveAttachment(db, PNG_1PX, 'anh-that.png', agent.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('image/png');
    expect(result.sizeBytes).toBe(PNG_1PX.length);
    expect(typeof result.id).toBe('string');

    const row = await getAttachmentRow(db, result.id);
    expect(row).not.toBeNull();
    expect(row?.uploader_id).toBe(agent.id);
    expect(row?.mime_type).toBe('image/png');
    expect(row?.file_name).toBe('anh-that.png');
    expect(row?.room_id).toBeNull(); // CHƯA gắn phòng — đúng hành vi mới upload xong.
  });

  it('upload JPEG hợp lệ → mimeType image/jpeg dù đuôi file client gửi là .png (magic-bytes THẬT thắng, không tin đuôi file)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const result = await saveAttachment(db, JPEG_MIN, 'gia-mao-duoi.png', agent.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('file rỗng → ok:false, reason EMPTY_FILE (KHÔNG ghi row nào)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const result = await saveAttachment(db, Buffer.alloc(0), 'rong.png', agent.id);
    expect(result).toEqual({ ok: false, reason: 'EMPTY_FILE' });
  });

  it('file vượt quá 50MB → ok:false, reason FILE_TOO_LARGE (kiểm TRƯỚC khi sniff mime, tránh tốn công vô ích)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const oversized = Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1);
    const result = await saveAttachment(db, oversized, 'qua-lon.png', agent.id);
    expect(result).toEqual({ ok: false, reason: 'FILE_TOO_LARGE' });
  }, 20_000);

  it('file .txt đổi tên thành .jpg → magic-bytes THẬT không phải ảnh → ok:false, reason MIME_NOT_ALLOWED (KHÔNG tin đuôi file client gửi)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const result = await saveAttachment(db, PLAIN_TEXT_AS_JPG, 'gia-mao.jpg', agent.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MIME_NOT_ALLOWED');
  });

  it('đúng allowlist đã khai (7 loại: jpg/png/webp/pdf/docx/xlsx/webm) — không lẫn loại khác', () => {
    expect(Object.keys(ALLOWED_MIME_TO_EXT).sort()).toEqual(
      [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/webm'
      ].sort()
    );
  });

  // SIGMA (31/7, việc #5) — xem JSDoc WEBM_AUDIO_HEADER trên cho bối cảnh đầy đủ phát hiện file-type
  // detect audio-only WebM là `video/webm` (KHÔNG PHẢI `audio/webm`).
  it('upload voice message THẬT (WebM/Opus audio-only do MediaRecorder tạo) → ok:true, mimeType video/webm (KHÔNG bị từ chối)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const result = await saveAttachment(db, WEBM_AUDIO_HEADER, 'voice-1690000000000.webm', agent.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('video/webm');

    const row = await getAttachmentRow(db, result.id);
    expect(row?.mime_type).toBe('video/webm');
  });
});

describe('chat-attachment-service — getAttachmentFile', () => {
  it('id không tồn tại → null (KHÔNG throw)', async () => {
    const db = getBotDb();
    const result = await getAttachmentFile(db, 'khong-ton-tai-xyz');
    expect(result).toBeNull();
  });

  it('id tồn tại → trả đúng filePath/mimeType/fileName, file THẬT đọc được trên đĩa', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const saved = await saveAttachment(db, PNG_1PX, 'file-that.png', agent.id);
    if (!saved.ok) throw new Error('setup thất bại');
    const file = await getAttachmentFile(db, saved.id);
    expect(file).not.toBeNull();
    expect(file?.mimeType).toBe('image/png');
    expect(file?.fileName).toBe('file-that.png');
  });
});

describe('chat-attachment-service — setAttachmentRoomId', () => {
  it('chính uploader gắn roomId → true, row cập nhật đúng', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const saved = await saveAttachment(db, PNG_1PX, 'a.png', agent.id);
    if (!saved.ok) throw new Error('setup thất bại');
    const ok = await setAttachmentRoomId(db, saved.id, 'room-abc-123', agent.id);
    expect(ok).toBe(true);
    const row = await getAttachmentRow(db, saved.id);
    expect(row?.room_id).toBe('room-abc-123');
  });

  it('agent KHÁC (không phải uploader) cố gắn roomId → false, row KHÔNG đổi', async () => {
    const db = getBotDb();
    const uploader = await makeAgent();
    const attacker = await makeAgent();
    const saved = await saveAttachment(db, PNG_1PX, 'b.png', uploader.id);
    if (!saved.ok) throw new Error('setup thất bại');
    const ok = await setAttachmentRoomId(db, saved.id, 'room-hijack', attacker.id);
    expect(ok).toBe(false);
    const row = await getAttachmentRow(db, saved.id);
    expect(row?.room_id).toBeNull();
  });

  it('id không tồn tại → false (KHÔNG throw)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const ok = await setAttachmentRoomId(db, 'khong-ton-tai', 'room-x', agent.id);
    expect(ok).toBe(false);
  });

  // REGRESSION FIX membership-gate (12/8) — với phòng THẬT thuộc hệ chat mới (chat_rooms), uploader PHẢI là
  // thành viên đang hoạt động của phòng ĐÍCH mới gắn được (trước đây chỉ kiểm uploader → gắn bừa vào phòng lạ).
  it('uploader KHÔNG phải thành viên phòng THẬT (chat_rooms) → false (fail-closed)', async () => {
    const db = getBotDb();
    const owner = await makeAgent();
    const outsider = await makeAgent();
    const room = await db.chatRoom.create({
      data: { type: 'GROUP', name: 'Phòng thật', createdBy: owner.id, members: { create: [{ agentId: owner.id, role: 'OWNER' }] } }
    });
    const saved = await saveAttachment(db, PNG_1PX, 'outsider.png', outsider.id);
    if (!saved.ok) throw new Error('setup thất bại');
    const ok = await setAttachmentRoomId(db, saved.id, room.id, outsider.id);
    expect(ok).toBe(false);
    expect((await getAttachmentRow(db, saved.id))?.room_id).toBeNull();
  });

  it('uploader LÀ thành viên đang hoạt động của phòng THẬT → true', async () => {
    const db = getBotDb();
    const owner = await makeAgent();
    const member = await makeAgent();
    const room = await db.chatRoom.create({
      data: { type: 'GROUP', name: 'Phòng thật 2', createdBy: owner.id, members: { create: [{ agentId: owner.id, role: 'OWNER' }, { agentId: member.id, role: 'MEMBER' }] } }
    });
    const saved = await saveAttachment(db, PNG_1PX, 'member.png', member.id);
    if (!saved.ok) throw new Error('setup thất bại');
    const ok = await setAttachmentRoomId(db, saved.id, room.id, member.id);
    expect(ok).toBe(true);
    expect((await getAttachmentRow(db, saved.id))?.room_id).toBe(room.id);
  });
});
