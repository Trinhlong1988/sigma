// SIGMA Mobile Milestone 5.1 (29/7) — màn Danh sách chat. TRƯỚC ĐÂY (Giai đoạn 1, 26/7) tải qua
// GET /v1/rc/subscriptions.get (Rocket.Chat, xem api-client.ts listRooms() — GIỮ NGUYÊN không xóa) — ĐỔI sang
// GET /v1/chat/rooms (Phase 2 "chat lõi" tự xây, ĐÃ deploy production thật, ổn định, xem
// apps/bot-api/src/routes/chat.ts) đúng bước chuẩn bị cutover đã chốt trong nhiệm vụ milestone 5.1. THÊM
// tap-to-open (mở ConversationScreenPlaceholder.tsx — CHƯA build UI hội thoại thật, đó là việc milestone 5.2
// SAU, xem comment file đó).
//
// Tên hiển thị phòng DIRECT: /v1/chat/rooms KHÔNG tự trả tên Agent đối phương (room-service thuần domain chat,
// chỉ trả `otherAgentId` — xem comment ChatRoomSummary trong api-client.ts) — màn này tự tra tên qua
// listMyFriends() (đã tải sẵn cho ContactsScreen, gọi lại ở đây vì 2 màn độc lập/không share state toàn cục)
// vì phòng DIRECT chỉ tồn tại giữa 2 bạn bè ACCEPTED (canMessageAgent() bot-api enforce khi tạo phòng).
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { COLORS } from '../theme';
import { listChatRooms, listMyFriends, type ChatRoomSummary } from '../lib/api-client';
import type { RootStackParamList } from '../navigation/types';

const ROOM_TYPE_LABEL: Record<ChatRoomSummary['type'], string> = { DIRECT: 'Tin nhắn riêng', GROUP: 'Nhóm' };

const MESSAGE_KIND_PREVIEW: Record<string, string> = {
  IMAGE: '[Hình ảnh]',
  FILE: '[Tệp đính kèm]',
  VOICE: '[Tin nhắn thoại]',
  LOCATION: '[Vị trí]',
  QR: '[Mã QR]'
};

/** Rút gọn nội dung xem trước tin nhắn cuối — TEXT hiện nguyên văn (cắt ngắn), loại khác hiện nhãn cố định
 * (KHÔNG có nội dung văn bản thật để hiện, vd ảnh/tệp/voice). PURE FUNCTION tách riêng để unit-test không cần
 * mock fetch (xem __tests__/ChatListScreen.test.tsx). */
export function previewLastMessage(lastMessage: ChatRoomSummary['lastMessage']): string {
  if (!lastMessage) return 'Chưa có tin nhắn nào';
  if (lastMessage.kind === 'TEXT') {
    const body = (lastMessage.body ?? '').trim();
    if (!body) return 'Chưa có tin nhắn nào';
    return body.length > 60 ? `${body.slice(0, 60)}…` : body;
  }
  return MESSAGE_KIND_PREVIEW[lastMessage.kind] ?? 'Tin nhắn mới';
}

/** Tên hiển thị của 1 phòng — GROUP dùng tên nhóm thật; DIRECT tra qua bản đồ agentId→tên (biệt danh ưu tiên
 * hơn tên thật, cùng quy ước ContactsScreen.tsx) xây từ danh sách bạn bè, fallback "Đại lý #id" nếu vì lý do gì
 * đó KHÔNG tìm thấy trong danh sách bạn bè hiện tại (vd vừa hủy kết bạn ở thiết bị khác, dữ liệu chưa đồng bộ
 * — vẫn hiện được phòng cũ, không để trống/crash). PURE FUNCTION — test được không cần mock. */
export function resolveRoomDisplayName(room: ChatRoomSummary, friendNameByAgentId: Map<number, string>): string {
  if (room.type === 'GROUP') return room.name ?? 'Nhóm chat';
  if (room.otherAgentId != null) {
    return friendNameByAgentId.get(room.otherAgentId) ?? `Đại lý #${room.otherAgentId}`;
  }
  return 'Không rõ';
}

export function ChatListScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [rooms, setRooms] = useState<ChatRoomSummary[] | null>(null);
  const [friendNameByAgentId, setFriendNameByAgentId] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [roomsResult, friendsResult] = await Promise.all([listChatRooms(), listMyFriends()]);
    if (!roomsResult.ok) {
      setError(roomsResult.message);
      return;
    }
    setError('');
    setRooms(roomsResult.data);
    // Danh bạ lỗi KHÔNG chặn hiện danh sách phòng (đây chỉ là tra tên hiển thị, có thể fallback "Đại lý #id") —
    // best-effort, chỉ cập nhật bản đồ nếu tải thành công.
    if (friendsResult.ok) {
      const map = new Map<number, string>();
      for (const f of friendsResult.data.friends) map.set(f.agentId, f.nickname ?? f.agentName);
      setFriendNameByAgentId(map);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onRefresh(): Promise<void> {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function openRoom(room: ChatRoomSummary): void {
    const roomName = resolveRoomDisplayName(room, friendNameByAgentId);
    navigation.navigate('ConversationPlaceholder', { roomId: room.id, roomName });
  }

  if (rooms === null && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.brand} />
      </View>
    );
  }

  return (
    <View style={styles.container} testID="chatlist-screen">
      <Text style={styles.header}>Danh sách chat</Text>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={rooms ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={!error ? <Text style={styles.empty}>Chưa có cuộc trò chuyện nào.</Text> : null}
        renderItem={({ item }) => {
          const displayName = resolveRoomDisplayName(item, friendNameByAgentId);
          return (
            <TouchableOpacity style={styles.row} onPress={() => openRoom(item)} testID={`chat-room-${item.id}`}>
              <View style={[styles.avatar, item.avatarColor ? { backgroundColor: item.avatarColor } : null]}>
                <Text style={styles.avatarText}>{displayName.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {displayName}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {previewLastMessage(item.lastMessage)} · {ROOM_TYPE_LABEL[item.type]}
                </Text>
              </View>
              {item.unreadCount > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{item.unreadCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg },
  header: { fontSize: 20, fontWeight: '700', color: COLORS.text, padding: 16, paddingBottom: 8 },
  error: { color: COLORS.danger, paddingHorizontal: 16, fontSize: 13 },
  empty: { color: COLORS.textMuted, textAlign: 'center', marginTop: 32 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, marginHorizontal: 12, marginVertical: 4, backgroundColor: COLORS.card, borderRadius: 10, gap: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.brandDark, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700' },
  name: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  sub: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },
  badge: { backgroundColor: COLORS.brand, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2, minWidth: 20, alignItems: 'center' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' }
});
