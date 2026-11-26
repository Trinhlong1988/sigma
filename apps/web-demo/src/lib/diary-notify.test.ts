// #32 (6/8, Admin Demo "push nhật ký REALTIME") — test THUẦN cho: parse 'diary-notify' (hợp lệ/không) +
// helpers cập nhật chuông tức thì (build item, +1 optimistic, dedupe theo postId). KHÔNG cần WS/render thật.
import { describe, expect, it } from 'vitest';
import { parseDiaryNotifyPayload } from './chat-realtime';
import { applyRealtimeDiaryPost, buildDiaryPostNotificationItem, markDiaryNotifySeen, type NotificationFeed } from './notifications';

describe('parseDiaryNotifyPayload', () => {
  it('payload hợp lệ → trả DiaryNotifyEvent đúng field', () => {
    const ev = parseDiaryNotifyPayload({ msg: 'diary-notify', kind: 'diary_post', authorAgentId: 7, authorName: 'An', postId: 'p1', at: '2026-08-06T00:00:00.000Z' });
    expect(ev).toEqual({ kind: 'diary_post', authorAgentId: 7, authorName: 'An', postId: 'p1', at: '2026-08-06T00:00:00.000Z' });
  });
  it('thiếu at → tự điền thời điểm nhận (string ISO)', () => {
    const ev = parseDiaryNotifyPayload({ kind: 'diary_post', authorAgentId: 7, authorName: 'An', postId: 'p1' });
    expect(ev).not.toBeNull();
    expect(typeof ev!.at).toBe('string');
  });
  it('shape lệch → null (kind sai / thiếu field / postId rỗng / kiểu sai)', () => {
    expect(parseDiaryNotifyPayload({ kind: 'other', authorAgentId: 7, authorName: 'An', postId: 'p1' })).toBeNull();
    expect(parseDiaryNotifyPayload({ kind: 'diary_post', authorName: 'An', postId: 'p1' })).toBeNull(); // thiếu authorAgentId
    expect(parseDiaryNotifyPayload({ kind: 'diary_post', authorAgentId: '7', authorName: 'An', postId: 'p1' })).toBeNull(); // authorAgentId kiểu string
    expect(parseDiaryNotifyPayload({ kind: 'diary_post', authorAgentId: 7, authorName: 'An', postId: '' })).toBeNull(); // postId rỗng
  });

  // 7/8 (Admin Demo "bình luận/cảm xúc nhật ký không push/không chuông") — parser PHẢI nhận kind comment/reaction
  // với bộ field actorAgentId/actorName (khác diary_post dùng authorAgentId/authorName), chuẩn hóa về author*.
  // GỐC bug: parser cũ chỉ nhận 'diary_post' → frame comment/reaction bị vứt → client không chuông/không +1.
  it('diary_comment với actorAgentId/actorName → nhận, chuẩn hóa về authorAgentId/authorName', () => {
    const ev = parseDiaryNotifyPayload({ msg: 'diary-notify', kind: 'diary_comment', actorAgentId: 381, actorName: 'Nhân viên B', postId: 'p9', at: '2026-08-07T00:00:00.000Z' });
    expect(ev).toEqual({ kind: 'diary_comment', authorAgentId: 381, authorName: 'Nhân viên B', postId: 'p9', at: '2026-08-07T00:00:00.000Z' });
  });
  it('diary_reaction với actorAgentId/actorName → nhận đúng kind', () => {
    const ev = parseDiaryNotifyPayload({ kind: 'diary_reaction', actorAgentId: 5, actorName: 'B', postId: 'p10' });
    expect(ev?.kind).toBe('diary_reaction');
    expect(ev?.authorAgentId).toBe(5);
  });
  it('comment thiếu CẢ actor* lẫn author* → null', () => {
    expect(parseDiaryNotifyPayload({ kind: 'diary_comment', postId: 'p9' })).toBeNull();
  });
});

function baseFeed(): NotificationFeed {
  return { holidays: [], birthdays: [], friendUpdates: [], unreadFriendUpdateCount: 0, totalCount: 0, loadError: null };
}

describe('applyRealtimeDiaryPost + buildDiaryPostNotificationItem — chuông +1 optimistic', () => {
  it('chèn item lên ĐẦU + tăng unread + tổng badge, KHÔNG đụng holidays/birthdays', () => {
    const feed: NotificationFeed = { ...baseFeed(), holidays: [{} as never], totalCount: 1 };
    const item = buildDiaryPostNotificationItem({ authorAgentId: 3, authorName: 'Bình', at: '2026-08-06T01:00:00.000Z' }, -1);
    expect(item).toEqual({ id: -1, type: 'DIARY_POST', actorAgentId: 3, actorAgentName: 'Bình', postId: null, createdAt: '2026-08-06T01:00:00.000Z', readAt: null });
    const next = applyRealtimeDiaryPost(feed, item);
    expect(next.friendUpdates[0]).toBe(item);
    expect(next.unreadFriendUpdateCount).toBe(1);
    expect(next.totalCount).toBe(2); // 1 (holiday) + 1 mới
    expect(next.holidays).toBe(feed.holidays); // giữ nguyên tham chiếu (không đụng)
  });

  it('nhận 2 bài KHÁC postId → +2 (mỗi lần lên đầu)', () => {
    const seen = new Set<string>();
    let feed = baseFeed();
    for (const [pid, name] of [['pA', 'A'], ['pB', 'B']] as const) {
      expect(markDiaryNotifySeen(seen, pid)).toBe(true);
      feed = applyRealtimeDiaryPost(feed, buildDiaryPostNotificationItem({ authorAgentId: 1, authorName: name, at: '2026-08-06T02:00:00.000Z' }, -1));
    }
    expect(feed.unreadFriendUpdateCount).toBe(2);
    expect(feed.friendUpdates).toHaveLength(2);
  });
});

describe('markDiaryNotifySeen — dedupe theo postId (chống double WS/FCM)', () => {
  it('postId mới → true (và ghi nhớ); postId đã thấy → false', () => {
    const seen = new Set<string>();
    expect(markDiaryNotifySeen(seen, 'p1')).toBe(true);
    expect(markDiaryNotifySeen(seen, 'p1')).toBe(false); // lần 2 CÙNG postId → không xử lý lại
    expect(markDiaryNotifySeen(seen, 'p2')).toBe(true);
  });

  it('mô phỏng WS + FCM cùng báo 1 bài tới máy đang mở → chuông CHỈ +1', () => {
    const seen = new Set<string>();
    let feed = baseFeed();
    const ev = { authorAgentId: 5, authorName: 'C', at: '2026-08-06T03:00:00.000Z', postId: 'dup1' };
    // Lần 1 (WS): áp dụng.
    if (markDiaryNotifySeen(seen, ev.postId)) feed = applyRealtimeDiaryPost(feed, buildDiaryPostNotificationItem(ev, -1));
    // Lần 2 (FCM/đa-kết-nối cùng postId): bị dedupe, KHÔNG áp dụng.
    if (markDiaryNotifySeen(seen, ev.postId)) feed = applyRealtimeDiaryPost(feed, buildDiaryPostNotificationItem(ev, -2));
    expect(feed.unreadFriendUpdateCount).toBe(1);
    expect(feed.friendUpdates).toHaveLength(1);
  });
});
