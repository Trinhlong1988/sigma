// Tag @ gợi ý thành viên nhóm kiểu Zalo (mention) — LOGIC THUẦN (không DOM/React), tách riêng để test độc lập
// ở env 'node' (cùng lớp "pure-logic test" như smart-search.ts/reply-preview.ts). MessageComposer.tsx dùng các
// hàm này để: dò token `@xxx` tại caret → lọc thành viên không dấu → chèn `@Tên ` + ghi nhớ agentId đã nhắc;
// lúc gửi trích danh sách mention CÒN trong text; ChatBubble.tsx dùng splitMentionSegments() để tô đậm `@Tên`.
//
// Vì `metadataJson` là JSON tự do (KHÔNG đổi schema DB), 1 tin nhắn có mention lưu:
//   { "mentions": [agentId, ...], "mentionNames": ["Tên hiển thị", ...] }
// `mentions` (mảng agentId) = nguồn cho BACKEND tạo thông báo MENTION (routes/chat.ts); `mentionNames` (mảng
// tên) = nguồn cho FE tô đậm `@Tên` khi render (KHÔNG suy ngược tên từ agentId ở tầng bubble — bubble không có
// danh bạ phòng). 2 mảng SONG SONG theo cùng thứ tự, xem buildMentionMetadata().

export interface MentionMember {
  agentId: number;
  name: string;
}

// Tag @all — nhắc TẤT CẢ thành viên nhóm (Admin Demo 24/8). Dùng agentId SENTINEL âm (không trùng agentId thật ≥1) +
// tên hiển thị "Tất cả". Lúc gửi → metadataJson.mentionAll=true (backend tự notify mọi thành viên đang trong nhóm,
// không cần client liệt kê agentId — đúng cả với người vào nhóm sau). Token chèn = "@Tất cả".
export const ALL_MENTION_ID = -1;
export const ALL_MENTION_NAME = 'Tất cả';
export function allMentionMember(): MentionMember {
  return { agentId: ALL_MENTION_ID, name: ALL_MENTION_NAME };
}

/** 1 lượt nhắc người dùng đã CHỌN trong ô soạn (agentId + đúng tên hiển thị đã chèn vào text) — MessageComposer
 *  giữ danh sách này để lúc gửi biết `@Tên` nào ứng với agentId nào (tên có thể chứa khoảng trắng, KHÔNG suy
 *  ngược từ text được). */
export interface MentionDraft {
  agentId: number;
  name: string;
}

/** Bỏ dấu tiếng Việt + hạ chữ thường để so khớp "không dấu" (CÙNG tinh thần smart-search.ts, viết lại tối giản
 *  ở đây để mention.ts độc lập không phụ thuộc file khác). Xử lý `đ/Đ` riêng vì NFD KHÔNG tách được nó. */
export function normalizeMentionText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // bỏ dấu tổ hợp (combining diacritics)
    .replace(/đ/g, 'd') // đ (U+0111) — NFD KHÔNG tách được, thay tay
    .trim();
}

export interface MentionQuery {
  /** Chuỗi sau dấu `@` tới caret (KHÔNG gồm `@`). */
  query: string;
  /** Vị trí dấu `@` trong text. */
  start: number;
  /** Vị trí caret (kết thúc token). */
  end: number;
}

/** Dò xem caret có đang nằm TRONG 1 token `@xxx` không (xxx = chuỗi tới caret, KHÔNG chứa khoảng trắng/`@`).
 *  Trả về null nếu không phải (không có `@`, hoặc có khoảng trắng chen giữa `@` và caret, hoặc `@` dính liền
 *  ký tự không phải khoảng trắng phía trước — tránh bắt nhầm email `a@b`). CHỈ quét ngược từ caret, O(token). */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') {
      const prev = i > 0 ? text[i - 1] : '';
      // `@` phải ở đầu chuỗi HOẶC sau 1 khoảng trắng/xuống dòng (không phải giữa từ như email).
      if (prev !== '' && !/\s/.test(prev)) return null;
      return { query: text.slice(i + 1, caret), start: i, end: caret };
    }
    // Gặp khoảng trắng trước khi gặp `@` → caret không nằm trong token mention.
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

/** Lọc thành viên theo token không dấu (khớp BẤT KỲ ĐÂU trong tên). Token rỗng → trả toàn bộ (vừa gõ `@`). */
export function filterMentionCandidates(members: MentionMember[], query: string): MentionMember[] {
  const q = normalizeMentionText(query);
  if (!q) return members;
  return members.filter((m) => normalizeMentionText(m.name).includes(q));
}

/** Như filterMentionCandidates NHƯNG chèn tùy chọn "@Tất cả" LÊN ĐẦU khi hợp lệ (Admin Demo 24/8). Hiện @all khi:
 *  token rỗng (vừa gõ `@`), hoặc khớp "all" (gõ @all), hoặc khớp "tất cả"/"tatca" không dấu. Đứng đầu cho dễ chọn. */
export function filterMentionCandidatesWithAll(members: MentionMember[], query: string): MentionMember[] {
  const q = normalizeMentionText(query);
  const showAll = q === '' || 'all'.startsWith(q) || normalizeMentionText(ALL_MENTION_NAME).includes(q);
  const filtered = filterMentionCandidates(members, query);
  return showAll ? [allMentionMember(), ...filtered] : filtered;
}

export interface ApplyMentionResult {
  text: string;
  /** Vị trí caret MỚI (ngay sau `@Tên ` vừa chèn). */
  caret: number;
}

/** Thay token `@xxx` (range) bằng `@Tên ` (kèm 1 khoảng trắng cuối để gõ tiếp liền mạch, kiểu Zalo). */
export function applyMention(text: string, range: { start: number; end: number }, member: MentionMember): ApplyMentionResult {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const insert = `@${member.name} `;
  return { text: before + insert + after, caret: before.length + insert.length };
}

/** Từ danh sách mention ĐÃ CHỌN (drafts) + text hiện tại, giữ lại NHỮNG mention mà `@Tên` VẪN còn trong text
 *  (người dùng có thể đã xóa 1 mention sau khi chèn). Dedupe theo agentId (nhắc 2 lần = 1 thông báo). */
export function extractActiveMentions(text: string, drafts: MentionDraft[]): MentionDraft[] {
  const seen = new Set<number>();
  const out: MentionDraft[] = [];
  for (const d of drafts) {
    if (seen.has(d.agentId)) continue;
    if (text.includes(`@${d.name}`)) {
      out.push(d);
      seen.add(d.agentId);
    }
  }
  return out;
}

/** Dựng `metadataJson` cho tin nhắn có mention (null nếu không có) — mảng agentId (backend) + mảng tên (FE tô
 *  đậm), SONG SONG cùng thứ tự. */
export function buildMentionMetadataJson(mentions: MentionDraft[]): string | null {
  if (mentions.length === 0) return null;
  const mentionAll = mentions.some((m) => m.agentId === ALL_MENTION_ID);
  // agentId THẬT (≠ sentinel @all) → backend tạo thông báo MENTION riêng từng người. `mentionNames` GIỮ CẢ "Tất cả"
  // để FE tô đậm `@Tất cả`. `mentionAll` (chỉ set khi có) → backend notify MỌI thành viên (không cần liệt kê id).
  const explicit = mentions.filter((m) => m.agentId !== ALL_MENTION_ID);
  return JSON.stringify({
    mentions: explicit.map((m) => m.agentId),
    mentionNames: mentions.map((m) => m.name),
    ...(mentionAll ? { mentionAll: true } : {})
  });
}

/** Đọc mảng tên mention từ metadataJson (dùng ở mapChatMessage → render tô đậm). Hỏng/không có → []. */
export function parseMentionNames(metadataJson: string | null | undefined): string[] {
  if (!metadataJson) return [];
  try {
    const parsed = JSON.parse(metadataJson) as { mentionNames?: unknown };
    if (Array.isArray(parsed.mentionNames)) {
      return parsed.mentionNames.filter((n): n is string => typeof n === 'string' && n.length > 0);
    }
  } catch {
    // metadataJson hỏng — coi như không có mention (KHÔNG throw, chỉ ảnh hưởng tô đậm hiển thị phụ).
  }
  return [];
}

export interface MentionSegment {
  text: string;
  isMention: boolean;
}

/** Chia text thành các đoạn để render: đoạn `@Tên` (isMention=true, tô đậm) xen kẽ đoạn thường. Khớp tên DÀI
 *  trước (tránh 1 tên là tiền tố của tên khác bị cắt cụt). An toàn với emoji/xuống dòng (chỉ so khớp chuỗi con
 *  literal, KHÔNG regex trên nội dung người dùng). Không có tên nào → trả nguyên 1 đoạn thường. */
export function splitMentionSegments(text: string, mentionNames: string[]): MentionSegment[] {
  const names = [...new Set(mentionNames.filter((n) => n.length > 0))].sort((a, b) => b.length - a.length);
  if (names.length === 0) return text ? [{ text, isMention: false }] : [];

  const segments: MentionSegment[] = [];
  let buffer = '';
  let i = 0;
  const flush = (): void => {
    if (buffer) {
      segments.push({ text: buffer, isMention: false });
      buffer = '';
    }
  };
  while (i < text.length) {
    if (text[i] === '@') {
      const matched = names.find((name) => text.startsWith(`@${name}`, i));
      if (matched) {
        flush();
        segments.push({ text: `@${matched}`, isMention: true });
        i += matched.length + 1;
        continue;
      }
    }
    buffer += text[i];
    i++;
  }
  flush();
  return segments;
}
