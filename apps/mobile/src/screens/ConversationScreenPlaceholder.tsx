// SIGMA Mobile Milestone 5.1 (29/7) — màn GIỮ CHỖ khi bấm mở 1 phòng chat từ ChatListScreen.tsx. Danh sách
// phòng đã đổi sang nguồn Phase 2 REST thật (/v1/chat/rooms, ổn định production) nhưng UI HỘI THOẠI THẬT (gửi/
// nhận tin nhắn, đính kèm, reaction...) là việc milestone 5.2 SAU — CHƯA build ở đây theo đúng phạm vi đã chốt
// (giao thức realtime Phase 3 dùng để đẩy tin mới tức thời CHƯA CHỐT XONG). Màn này CHỈ hiện tên phòng + thông
// báo trung thực "đang chờ đợt sau", KHÔNG giả lập khung chat để tránh gây hiểu nhầm là đã dùng được.
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { COLORS } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type ConversationRouteProp = RouteProp<RootStackParamList, 'ConversationPlaceholder'>;

export function ConversationScreenPlaceholder() {
  const navigation = useNavigation();
  const route = useRoute<ConversationRouteProp>();
  const { roomName } = route.params;

  return (
    <View style={styles.container} testID="conversation-placeholder-screen">
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => navigation.goBack()} testID="conversation-back-button">
          <Text style={styles.backText}>{'‹ Quay lại'}</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle} numberOfLines={1}>
          {roomName}
        </Text>
        <View style={styles.backSpacer} />
      </View>
      <View style={styles.center}>
        <Text style={styles.emoji}>💬</Text>
        <Text style={styles.message}>Tính năng trò chuyện trực tiếp đang được xây dựng.</Text>
        <Text style={styles.sub}>Sẽ mở ở đợt sau (milestone 5.2), sau khi giao thức thời gian thực hoàn tất.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.brand
  },
  backText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  backSpacer: { width: 60 },
  topBarTitle: { flex: 1, textAlign: 'center', color: '#fff', fontWeight: '700', fontSize: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  emoji: { fontSize: 40, marginBottom: 8 },
  message: { fontSize: 15, fontWeight: '600', color: COLORS.text, textAlign: 'center' },
  sub: { fontSize: 13, color: COLORS.textMuted, textAlign: 'center' }
});
