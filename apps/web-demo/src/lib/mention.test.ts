// Tag @ mention (Zalo-style) — test LOGIC THUẦN mention.ts (dò token @ tại caret, lọc thành viên không dấu,
// trích mention còn trong text, dựng/parse metadataJson, chia đoạn tô đậm). Env 'node', KHÔNG DOM.
import { describe, it, expect } from 'vitest';
import {
  normalizeMentionText,
  findMentionQuery,
  filterMentionCandidates,
  applyMention,
  extractActiveMentions,
  buildMentionMetadataJson,
  parseMentionNames,
  splitMentionSegments,
  filterMentionCandidatesWithAll,
  ALL_MENTION_ID,
  ALL_MENTION_NAME,
  type MentionMember
} from './mention';

const MEMBERS: MentionMember[] = [
  { agentId: 1, name: 'Nguyễn Văn An' },
  { agentId: 2, name: 'Trần Thị Bình' },
  { agentId: 3, name: 'Đỗ Anh Dũng' },
  { agentId: 4, name: 'Lê An' }
];

describe('normalizeMentionText', () => {
  it('bỏ dấu + hạ chữ thường + xử lý đ/Đ', () => {
    expect(normalizeMentionText('Nguyễn Văn An')).toBe('nguyen van an');
    expect(normalizeMentionText('Đỗ Anh Dũng')).toBe('do anh dung');
    expect(normalizeMentionText('  BìNH  ')).toBe('binh');
  });
});

describe('findMentionQuery', () => {
  it('caret trong token @xxx → trả query + range', () => {
    const text = 'chào @ngu';
    const q = findMentionQuery(text, text.length);
    expect(q).toEqual({ query: 'ngu', start: 5, end: 9 });
  });

  it('vừa gõ @ (token rỗng) vẫn nhận diện', () => {
    const text = 'hi @';
    expect(findMentionQuery(text, 4)).toEqual({ query: '', start: 3, end: 4 });
  });

  it('có khoảng trắng giữa @ và caret → null', () => {
    const text = '@an rồi';
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  it('@ ở đầu chuỗi hợp lệ', () => {
    expect(findMentionQuery('@a', 2)).toEqual({ query: 'a', start: 0, end: 2 });
  });

  it('email a@b KHÔNG bị bắt (@ dính ký tự thường phía trước)', () => {
    const text = 'mail me a@bob';
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  it('caret ở giữa token trả đúng đoạn tới caret', () => {
    const text = '@binh xin chao';
    expect(findMentionQuery(text, 3)).toEqual({ query: 'bi', start: 0, end: 3 });
  });
});

describe('filterMentionCandidates', () => {
  it('lọc không dấu, khớp bất kỳ đâu', () => {
    // "an" khớp cả "tran" (Trần) + "anh" (Anh) → cả 4 (đúng: khớp con chuỗi bất kỳ đâu, không dấu).
    expect(filterMentionCandidates(MEMBERS, 'an').map((m) => m.agentId)).toEqual([1, 2, 3, 4]);
    expect(filterMentionCandidates(MEMBERS, 'dung').map((m) => m.agentId)).toEqual([3]);
    expect(filterMentionCandidates(MEMBERS, 'binh').map((m) => m.agentId)).toEqual([2]);
    expect(filterMentionCandidates(MEMBERS, 'van').map((m) => m.agentId)).toEqual([1]);
  });

  it('token rỗng trả toàn bộ', () => {
    expect(filterMentionCandidates(MEMBERS, '')).toHaveLength(4);
  });
});

describe('applyMention', () => {
  it('thay @token bằng @Tên + khoảng trắng, trả caret đúng', () => {
    const text = 'chào @ngu tiếp';
    const q = findMentionQuery(text, 9)!;
    const r = applyMention(text, q, MEMBERS[0]);
    expect(r.text).toBe('chào @Nguyễn Văn An  tiếp');
    // caret ngay sau "@Nguyễn Văn An " (gồm 1 space chèn).
    expect(r.text.slice(0, r.caret)).toBe('chào @Nguyễn Văn An ');
  });
});

describe('extractActiveMentions', () => {
  const drafts = [
    { agentId: 1, name: 'Nguyễn Văn An' },
    { agentId: 2, name: 'Trần Thị Bình' }
  ];
  it('chỉ giữ mention có @Tên còn trong text', () => {
    const text = 'gửi @Nguyễn Văn An xem nhé';
    expect(extractActiveMentions(text, drafts).map((m) => m.agentId)).toEqual([1]);
  });
  it('dedupe theo agentId khi nhắc 2 lần', () => {
    const text = '@Nguyễn Văn An và @Nguyễn Văn An';
    expect(extractActiveMentions(text, drafts).map((m) => m.agentId)).toEqual([1]);
  });
  it('không mention nào còn → rỗng', () => {
    expect(extractActiveMentions('không nhắc ai', drafts)).toEqual([]);
  });
});

describe('buildMentionMetadataJson / parseMentionNames', () => {
  it('round-trip agentIds + names', () => {
    const json = buildMentionMetadataJson([
      { agentId: 3, name: 'Đỗ Anh Dũng' },
      { agentId: 4, name: 'Lê An' }
    ]);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!);
    expect(parsed.mentions).toEqual([3, 4]);
    expect(parsed.mentionNames).toEqual(['Đỗ Anh Dũng', 'Lê An']);
    expect(parseMentionNames(json)).toEqual(['Đỗ Anh Dũng', 'Lê An']);
  });
  it('rỗng → null', () => {
    expect(buildMentionMetadataJson([])).toBeNull();
  });
  it('parse metadataJson hỏng/thiếu → []', () => {
    expect(parseMentionNames(null)).toEqual([]);
    expect(parseMentionNames('{broken')).toEqual([]);
    expect(parseMentionNames('{"foo":1}')).toEqual([]);
  });
});

describe('splitMentionSegments', () => {
  it('tô đậm đúng @Tên, giữ nguyên phần thường + xuống dòng', () => {
    const segs = splitMentionSegments('Chào @Lê An\nnhé', ['Lê An']);
    expect(segs).toEqual([
      { text: 'Chào ', isMention: false },
      { text: '@Lê An', isMention: true },
      { text: '\nnhé', isMention: false }
    ]);
  });

  it('khớp tên DÀI trước (tránh cắt cụt tiền tố)', () => {
    // "Lê An" là tiền tố hiển-thị của "Lê Anh Tú"; khớp dài trước để không cắt "@Lê An"h.
    const segs = splitMentionSegments('@Lê Anh Tú ơi', ['Lê An', 'Lê Anh Tú']);
    expect(segs[0]).toEqual({ text: '@Lê Anh Tú', isMention: true });
    expect(segs[1]).toEqual({ text: ' ơi', isMention: false });
  });

  it('không có tên mention → 1 đoạn thường', () => {
    expect(splitMentionSegments('bình thường', [])).toEqual([{ text: 'bình thường', isMention: false }]);
  });

  it('@ không khớp tên nào → giữ như text thường', () => {
    expect(splitMentionSegments('email a@b thôi', ['Lê An'])).toEqual([{ text: 'email a@b thôi', isMention: false }]);
  });
});

// @all — nhắc tất cả (Admin Demo 24/8)
describe('filterMentionCandidatesWithAll — @all', () => {
  it('token rỗng (vừa gõ @) → @Tất cả LÊN ĐẦU + toàn bộ thành viên', () => {
    const c = filterMentionCandidatesWithAll(MEMBERS, '');
    expect(c[0]).toEqual({ agentId: ALL_MENTION_ID, name: ALL_MENTION_NAME });
    expect(c.length).toBe(MEMBERS.length + 1);
  });
  it('gõ "@all" → có @Tất cả', () => {
    const c = filterMentionCandidatesWithAll(MEMBERS, 'all');
    expect(c.some((m) => m.agentId === ALL_MENTION_ID)).toBe(true);
  });
  it('gõ "tất" (không dấu "tat") → có @Tất cả', () => {
    expect(filterMentionCandidatesWithAll(MEMBERS, 'tat').some((m) => m.agentId === ALL_MENTION_ID)).toBe(true);
  });
  it('gõ tên người cụ thể → KHÔNG chèn @Tất cả', () => {
    const c = filterMentionCandidatesWithAll(MEMBERS, 'bình');
    expect(c.some((m) => m.agentId === ALL_MENTION_ID)).toBe(false);
    expect(c.every((m) => m.agentId !== ALL_MENTION_ID)).toBe(true);
  });
});

describe('buildMentionMetadataJson — @all', () => {
  it('chọn @all → mentionAll:true, mentions KHÔNG chứa sentinel, mentionNames có "Tất cả"', () => {
    const json = buildMentionMetadataJson([{ agentId: ALL_MENTION_ID, name: ALL_MENTION_NAME }]);
    const parsed = JSON.parse(json!) as { mentions: number[]; mentionNames: string[]; mentionAll?: boolean };
    expect(parsed.mentionAll).toBe(true);
    expect(parsed.mentions).toEqual([]); // sentinel không lọt vào danh sách agentId thật
    expect(parsed.mentionNames).toEqual(['Tất cả']); // để FE tô đậm @Tất cả
  });
  it('@all + 1 người cụ thể → mentionAll:true VÀ mentions có id người đó', () => {
    const json = buildMentionMetadataJson([{ agentId: ALL_MENTION_ID, name: ALL_MENTION_NAME }, { agentId: 2, name: 'Trần Thị Bình' }]);
    const parsed = JSON.parse(json!) as { mentions: number[]; mentionAll?: boolean };
    expect(parsed.mentionAll).toBe(true);
    expect(parsed.mentions).toEqual([2]);
  });
  it('KHÔNG có @all → không có field mentionAll (giữ shape cũ 100%)', () => {
    const json = buildMentionMetadataJson([{ agentId: 2, name: 'Trần Thị Bình' }]);
    const parsed = JSON.parse(json!) as Record<string, unknown>;
    expect('mentionAll' in parsed).toBe(false);
    expect(parsed.mentions).toEqual([2]);
  });
});
