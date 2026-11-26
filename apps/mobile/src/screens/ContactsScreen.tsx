// SIGMA Mobile Milestone 5.1 (29/7) — màn Danh bạ ĐẦY ĐỦ. Giai đoạn 1 (26/7) trước đây CHỈ hiện bạn bè
// ACCEPTED (bỏ hết UI gửi/nhận lời mời, chặn, biệt danh) — nhiệm vụ này PORT NGHIỆP VỤ từ
// apps/web-demo/src/screens/ContactsScreen.tsx (tham khảo Ý TƯỞNG/luồng nghiệp vụ, KHÔNG copy code — RN khác
// React DOM hoàn toàn) sang UI React Native mới, dùng đúng endpoint /v1/me/friends/* đã có sẵn phía bot-api
// (xem apps/bot-api/src/routes/me.ts + friend-service.ts, đọc trực tiếp source thật — KHÔNG đoán path/payload).
//
// "Nhắn tin" điều hướng qua createOrOpenDirectRoom() (POST /v1/chat/rooms/direct, Phase 2 REST đã production
// thật) → ConversationScreenPlaceholder.tsx (CHƯA có UI hội thoại thật, milestone 5.2 SAU) — nhất quán với
// luồng tap-to-open ở ChatListScreen.tsx, không cần route/API nào khác ngoài phạm vi đã duyệt.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { COLORS } from '../theme';
import {
  acceptFriendRequest,
  blockFriend,
  createOrOpenDirectRoom,
  listMyFriends,
  lookupAgentByCode,
  rejectFriendRequest,
  sendFriendRequest,
  setFriendNickname,
  unblockFriend,
  unfriend,
  type AgentLookupResult,
  type FriendListItem,
  type FriendListResult,
  type FriendRequestListItem
} from '../lib/api-client';
import type { RootStackParamList } from '../navigation/types';

/** true nếu MÌNH không thể nhắn tin/gọi cho người này — HOẶC mình đã chặn họ (tự nhất quán), HOẶC họ đã chặn
 * mình (enforcement thật, xem canMessageAgent() bot-api). CHỈ dùng để quyết định disable, KHÔNG hiện chữ "họ
 * đã chặn bạn" ra UI — cùng nguyên tắc ContactsScreen.tsx bản web-demo. */
function isBlockedForMe(f: FriendListItem): boolean {
  return f.blockedByMe || f.blockedThem;
}

function matches(haystack: string | null | undefined, q: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(q.toLowerCase());
}

export function ContactsScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();

  const [data, setData] = useState<FriendListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [query, setQuery] = useState('');

  const [lookupCode, setLookupCode] = useState('');
  // Audit độc lập 31/7 (MEDIUM) — dùng ở withBusy() để tránh setState sau unmount.
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [lookupResult, setLookupResult] = useState<AgentLookupResult | null>(null);

  const [profile, setProfile] = useState<FriendListItem | null>(null);
  const [confirmUnfriend, setConfirmUnfriend] = useState<FriendListItem | null>(null);
  const [confirmBlock, setConfirmBlock] = useState<FriendListItem | null>(null);

  const [editingNickname, setEditingNickname] = useState<FriendListItem | null>(null);
  const [nicknameInput, setNicknameInput] = useState('');
  const [nicknameBusy, setNicknameBusy] = useState(false);
  const [nicknameError, setNicknameError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    const r = await listMyFriends();
    if (!r.ok) {
      setLoadError(r.message);
      setLoading(false);
      return;
    }
    setData(r.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Đồng bộ lại `profile` (snapshot lúc mở mini hồ sơ) mỗi khi `data` đổi (vd sau khi đặt biệt danh/chặn) —
  // nếu bạn bè đó không còn trong danh sách (vừa unfriend ở nơi khác), tự đóng modal.
  useEffect(() => {
    if (!profile || !data) return;
    const updated = data.friends.find((f) => f.agentId === profile.agentId);
    setProfile(updated ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function onRefresh(): Promise<void> {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function withBusy(key: string, fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      setBusyKeys((prev) => new Set(prev).add(key));
      setActionError('');
      try {
        await fn();
      } finally {
        // Audit độc lập 31/7 (MEDIUM): tránh setState sau khi màn hình đã unmount (vd bấm "Nhắn tin" điều
        // hướng đi trước khi request nền kết thúc) — không crash nhưng React cảnh báo, và giữ tham chiếu state
        // ngoài ý muốn. isMountedRef khai ở component, set false lúc cleanup effect.
        if (isMountedRef.current) {
          setBusyKeys((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      }
    };
  }

  async function doLookup(): Promise<void> {
    const code = lookupCode.trim();
    if (!code) return;
    setLookupBusy(true);
    setLookupError('');
    setLookupResult(null);
    const r = await lookupAgentByCode(code);
    setLookupBusy(false);
    if (!r.ok) {
      setLookupError(r.message);
      return;
    }
    setLookupResult(r.data);
  }

  async function doSendRequest(toAgentId: number): Promise<void> {
    const r = await sendFriendRequest(toAgentId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    setInfoMessage(r.data.autoAccepted ? 'Đã thành bạn bè!' : 'Đã gửi lời mời kết bạn.');
    setLookupResult(null);
    setLookupCode('');
    await load();
  }

  async function doAccept(requestId: number): Promise<void> {
    const r = await acceptFriendRequest(requestId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    await load();
  }

  async function doReject(requestId: number): Promise<void> {
    const r = await rejectFriendRequest(requestId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    await load();
  }

  async function doUnfriend(agentId: number): Promise<void> {
    const r = await unfriend(agentId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    setConfirmUnfriend(null);
    setProfile(null);
    await load();
  }

  async function doBlock(agentId: number): Promise<void> {
    const r = await blockFriend(agentId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    setConfirmBlock(null);
    await load();
  }

  async function doUnblock(agentId: number): Promise<void> {
    const r = await unblockFriend(agentId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    await load();
  }

  async function doSetNickname(): Promise<void> {
    if (!editingNickname) return;
    const trimmed = nicknameInput.trim();
    setNicknameBusy(true);
    setNicknameError('');
    const r = await setFriendNickname(editingNickname.agentId, trimmed.length > 0 ? trimmed : null);
    setNicknameBusy(false);
    if (!r.ok) {
      setNicknameError(r.message);
      return;
    }
    setEditingNickname(null);
    await load();
  }

  async function doMessage(f: FriendListItem): Promise<void> {
    const r = await createOrOpenDirectRoom(f.agentId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    setProfile(null);
    navigation.navigate('ConversationPlaceholder', { roomId: r.data.id, roomName: f.nickname ?? f.agentName });
  }

  const allFriends = data?.friends ?? [];
  const incoming = data?.incomingRequests ?? [];
  const outgoing = data?.outgoingRequests ?? [];

  const q = query.trim();
  const friends = useMemo(() => {
    if (!q) return allFriends;
    return allFriends.filter((f) => matches(f.agentName, q) || matches(f.agentCode, q) || matches(f.nickname, q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFriends, q]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.brand} />
      </View>
    );
  }

  return (
    <View style={styles.container} testID="contacts-screen">
      <FlatList
        data={friends}
        keyExtractor={(item) => String(item.requestId)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          <View>
            <Text style={styles.header}>Danh bạ</Text>

            {!!actionError && <Text style={styles.errorBanner}>{actionError}</Text>}
            {!!infoMessage && <Text style={styles.infoBanner}>{infoMessage}</Text>}
            {!!loadError && <Text style={styles.errorBanner}>Không tải được danh bạ: {loadError}</Text>}

            {/* Thêm bạn qua mã đại lý — căn cứ tối thiểu để gửi lời mời (KHÔNG phải tìm kiếm mờ). */}
            <View style={styles.lookupBox}>
              <Text style={styles.lookupTitle}>Thêm bạn qua mã đại lý</Text>
              <View style={styles.lookupRow}>
                <TextInput
                  style={styles.lookupInput}
                  value={lookupCode}
                  onChangeText={(t) => {
                    setLookupCode(t);
                    setLookupResult(null);
                    setLookupError('');
                  }}
                  placeholder="Nhập mã đại lý, vd DL001"
                  autoCapitalize="characters"
                  testID="lookup-code-input"
                />
                <TouchableOpacity
                  style={styles.lookupButton}
                  onPress={doLookup}
                  disabled={lookupBusy || !lookupCode.trim()}
                  testID="lookup-code-button"
                >
                  {lookupBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.lookupButtonText}>Tìm</Text>}
                </TouchableOpacity>
              </View>
              {!!lookupError && <Text style={styles.errorText}>{lookupError}</Text>}
              {lookupResult && (
                <View style={styles.lookupResultRow}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{lookupResult.name.slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{lookupResult.name}</Text>
                    <Text style={styles.sub}>Mã: {lookupResult.code ?? '—'}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.smallButton}
                    onPress={() => doSendRequest(lookupResult.id)}
                    testID="lookup-send-request-button"
                  >
                    <Text style={styles.smallButtonText}>Kết bạn</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* Lời mời NHẬN VỀ. */}
            {incoming.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Lời mời kết bạn ({incoming.length})</Text>
                {incoming.map((r: FriendRequestListItem) => {
                  const acceptKey = `accept:${r.requestId}`;
                  const rejectKey = `reject:${r.requestId}`;
                  const busy = busyKeys.has(acceptKey) || busyKeys.has(rejectKey);
                  return (
                    <View key={r.requestId} style={styles.requestRow} testID={`incoming-request-${r.requestId}`}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>{r.agentName.slice(0, 1).toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.name}>{r.agentName}</Text>
                        <Text style={styles.sub}>Mã: {r.agentCode ?? '—'}</Text>
                      </View>
                      <TouchableOpacity
                        style={styles.smallButton}
                        disabled={busy}
                        onPress={withBusy(acceptKey, () => doAccept(r.requestId))}
                        testID={`accept-request-${r.requestId}`}
                      >
                        <Text style={styles.smallButtonText}>Chấp nhận</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.smallButtonNeutral}
                        disabled={busy}
                        onPress={withBusy(rejectKey, () => doReject(r.requestId))}
                        testID={`reject-request-${r.requestId}`}
                      >
                        <Text style={styles.smallButtonNeutralText}>Từ chối</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Lời mời ĐÃ GỬI, đang chờ. */}
            {outgoing.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Đã gửi lời mời ({outgoing.length})</Text>
                {outgoing.map((r: FriendRequestListItem) => {
                  const key = `unfriend:${r.agentId}`;
                  return (
                    <View key={r.requestId} style={styles.requestRow} testID={`outgoing-request-${r.requestId}`}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>{r.agentName.slice(0, 1).toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.name}>{r.agentName}</Text>
                        <Text style={styles.sub}>Mã: {r.agentCode ?? '—'} · Đang chờ phản hồi</Text>
                      </View>
                      <TouchableOpacity
                        style={styles.smallButtonNeutral}
                        disabled={busyKeys.has(key)}
                        onPress={withBusy(key, () => doUnfriend(r.agentId))}
                        testID={`outgoing-unfriend-${r.agentId}`}
                      >
                        <Text style={styles.smallButtonNeutralText}>Thu hồi</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Tìm kiếm trên danh sách bạn bè. */}
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Tìm bạn bè theo tên hoặc mã đại lý..."
              testID="friends-search-input"
            />
            <Text style={styles.sectionTitle}>{q ? `Bạn bè (${friends.length} kết quả cho "${q}")` : `Bạn bè (${friends.length})`}</Text>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {q ? `Không tìm thấy bạn bè nào khớp "${q}".` : 'Chưa có bạn bè nào — thử thêm bạn qua mã đại lý ở trên.'}
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => setProfile(item)} testID={`friend-row-${item.agentId}`}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{(item.nickname ?? item.agentName).slice(0, 1).toUpperCase()}</Text>
              {item.online === true && <View style={styles.onlineDot} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.nickname ?? item.agentName}</Text>
              <Text style={styles.sub}>{item.agentCode ? `Mã: ${item.agentCode}` : item.rcUsername ?? ''}</Text>
            </View>
            <TouchableOpacity
              style={styles.messageButton}
              disabled={isBlockedForMe(item) || busyKeys.has(`message:${item.agentId}`)}
              onPress={withBusy(`message:${item.agentId}`, () => doMessage(item))}
              testID={`message-friend-${item.agentId}`}
            >
              {busyKeys.has(`message:${item.agentId}`) ? (
                <ActivityIndicator color={COLORS.brand} size="small" />
              ) : (
                <Text style={[styles.messageButtonText, isBlockedForMe(item) && styles.messageButtonTextDisabled]}>Nhắn tin</Text>
              )}
            </TouchableOpacity>
          </TouchableOpacity>
        )}
      />

      {/* Mini hồ sơ bạn bè. */}
      <Modal visible={!!profile} animationType="fade" transparent onRequestClose={() => setProfile(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {profile && (
              <>
                <View style={styles.modalHeader}>
                  <View style={styles.modalAvatar}>
                    <Text style={styles.modalAvatarText}>{(profile.nickname ?? profile.agentName).slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <Text style={styles.modalName}>{profile.nickname ?? profile.agentName}</Text>
                  {!!profile.nickname && <Text style={styles.modalSub}>{profile.agentName}</Text>}
                  <Text style={styles.modalSub}>Mã: {profile.agentCode ?? '—'}</Text>
                </View>
                <View style={styles.modalBody}>
                  <TouchableOpacity
                    style={styles.modalRowButton}
                    onPress={() => {
                      setNicknameInput(profile.nickname ?? '');
                      setNicknameError('');
                      setEditingNickname(profile);
                    }}
                  >
                    <Text style={styles.modalRowButtonText}>Đặt biệt danh</Text>
                    <Text style={styles.sub}>{profile.nickname ?? 'Chưa đặt'}</Text>
                  </TouchableOpacity>

                  {isBlockedForMe(profile) && <Text style={styles.warningText}>Không thể nhắn tin/gọi cho người này.</Text>}

                  <TouchableOpacity
                    style={[styles.primaryButton, isBlockedForMe(profile) && styles.buttonDisabled]}
                    disabled={isBlockedForMe(profile)}
                    onPress={() => doMessage(profile)}
                  >
                    <Text style={styles.primaryButtonText}>Nhắn tin</Text>
                  </TouchableOpacity>

                  {profile.blockedByMe ? (
                    <TouchableOpacity style={styles.neutralButton} onPress={() => doUnblock(profile.agentId)} testID="profile-unblock-button">
                      <Text style={styles.neutralButtonText}>Bỏ chặn</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={styles.neutralButton} onPress={() => setConfirmBlock(profile)} testID="profile-open-block-confirm">
                      <Text style={styles.neutralButtonText}>Chặn</Text>
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity style={styles.neutralButton} onPress={() => setConfirmUnfriend(profile)} testID="profile-open-unfriend-confirm">
                    <Text style={styles.neutralButtonText}>Hủy kết bạn</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.modalCloseButton} onPress={() => setProfile(null)}>
                    <Text style={styles.modalCloseButtonText}>Đóng</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Xác nhận hủy kết bạn. */}
      <Modal visible={!!confirmUnfriend} animationType="fade" transparent onRequestClose={() => setConfirmUnfriend(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Hủy kết bạn</Text>
            <Text style={styles.confirmMessage}>
              Hủy kết bạn với {confirmUnfriend?.nickname ?? confirmUnfriend?.agentName}? Hai bạn sẽ không còn thấy nhau trong danh sách bạn bè.
            </Text>
            <View style={styles.confirmActions}>
              <TouchableOpacity style={styles.neutralButton} onPress={() => setConfirmUnfriend(null)}>
                <Text style={styles.neutralButtonText}>Hủy bỏ</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.dangerButton}
                disabled={!!confirmUnfriend && busyKeys.has(`confirm-unfriend:${confirmUnfriend.agentId}`)}
                onPress={
                  confirmUnfriend
                    ? withBusy(`confirm-unfriend:${confirmUnfriend.agentId}`, () => doUnfriend(confirmUnfriend.agentId))
                    : undefined
                }
                testID="confirm-unfriend-button"
              >
                {confirmUnfriend && busyKeys.has(`confirm-unfriend:${confirmUnfriend.agentId}`) ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.primaryButtonText}>Hủy kết bạn</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Xác nhận chặn. */}
      <Modal visible={!!confirmBlock} animationType="fade" transparent onRequestClose={() => setConfirmBlock(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Chặn người này</Text>
            <Text style={styles.confirmMessage}>
              Chặn {confirmBlock?.nickname ?? confirmBlock?.agentName}? Sau khi chặn, người này sẽ KHÔNG thể gọi điện hoặc nhắn tin cho bạn nữa. Bạn có
              thể bỏ chặn bất cứ lúc nào.
            </Text>
            <View style={styles.confirmActions}>
              <TouchableOpacity style={styles.neutralButton} onPress={() => setConfirmBlock(null)}>
                <Text style={styles.neutralButtonText}>Hủy bỏ</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.dangerButton}
                disabled={!!confirmBlock && busyKeys.has(`confirm-block:${confirmBlock.agentId}`)}
                onPress={confirmBlock ? withBusy(`confirm-block:${confirmBlock.agentId}`, () => doBlock(confirmBlock.agentId)) : undefined}
                testID="confirm-block-button"
              >
                {confirmBlock && busyKeys.has(`confirm-block:${confirmBlock.agentId}`) ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.primaryButtonText}>Chặn</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Đặt biệt danh. */}
      <Modal visible={!!editingNickname} animationType="fade" transparent onRequestClose={() => setEditingNickname(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Đặt biệt danh</Text>
            <Text style={styles.confirmMessage}>Biệt danh cho {editingNickname?.agentName} (chỉ mình bạn thấy)</Text>
            <TextInput
              style={styles.lookupInput}
              value={nicknameInput}
              onChangeText={setNicknameInput}
              maxLength={50}
              placeholder="Để trống = dùng tên thật"
              testID="nickname-input"
            />
            {!!nicknameError && <Text style={styles.errorText}>{nicknameError}</Text>}
            <View style={styles.confirmActions}>
              <TouchableOpacity style={styles.neutralButton} onPress={() => setEditingNickname(null)}>
                <Text style={styles.neutralButtonText}>Hủy</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryButton} disabled={nicknameBusy} onPress={doSetNickname} testID="save-nickname-button">
                {nicknameBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryButtonText}>Lưu</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg },
  header: { fontSize: 20, fontWeight: '700', color: COLORS.text, padding: 16, paddingBottom: 8 },
  errorBanner: { color: COLORS.danger, fontSize: 12, marginHorizontal: 16, marginBottom: 8 },
  infoBanner: { color: COLORS.brand, fontSize: 12, marginHorizontal: 16, marginBottom: 8, fontWeight: '600' },
  errorText: { color: COLORS.danger, fontSize: 12, marginTop: 6 },
  warningText: { color: '#b45309', fontSize: 12, marginBottom: 4 },
  empty: { color: COLORS.textMuted, textAlign: 'center', marginTop: 32, paddingHorizontal: 24 },

  lookupBox: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.brand,
    backgroundColor: '#eef3fd'
  },
  lookupTitle: { fontSize: 14, fontWeight: '700', color: COLORS.brand, marginBottom: 8 },
  lookupRow: { flexDirection: 'row', gap: 8 },
  lookupInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    backgroundColor: '#fff',
    color: COLORS.text
  },
  lookupButton: { backgroundColor: COLORS.brand, borderRadius: 8, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  lookupButtonText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  lookupResultRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, backgroundColor: '#fff', borderRadius: 8, padding: 10 },

  section: { marginHorizontal: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: COLORS.textMuted, marginBottom: 8, marginHorizontal: 16 },
  requestRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },

  searchInput: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 9,
    fontSize: 14,
    backgroundColor: COLORS.card,
    color: COLORS.text
  },

  row: { flexDirection: 'row', alignItems: 'center', padding: 12, marginHorizontal: 12, marginVertical: 4, backgroundColor: COLORS.card, borderRadius: 10, gap: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.brand, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700' },
  onlineDot: { position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: 5, backgroundColor: '#22c55e', borderWidth: 2, borderColor: '#fff' },
  name: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  sub: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },

  smallButton: { backgroundColor: COLORS.brand, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  smallButtonText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  smallButtonNeutral: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  smallButtonNeutralText: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },

  messageButton: { paddingHorizontal: 10, paddingVertical: 6 },
  messageButtonText: { color: COLORS.brand, fontSize: 12, fontWeight: '700' },
  messageButtonTextDisabled: { color: COLORS.border },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modalCard: { width: '100%', maxWidth: 340, backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden' },
  modalHeader: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 16, backgroundColor: COLORS.brand, gap: 4 },
  modalAvatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.brandDark, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  modalAvatarText: { color: '#fff', fontSize: 24, fontWeight: '700' },
  modalName: { color: '#fff', fontSize: 16, fontWeight: '700' },
  modalSub: { color: 'rgba(255,255,255,0.75)', fontSize: 12 },
  modalBody: { padding: 16, gap: 10 },
  modalRowButton: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, padding: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalRowButtonText: { fontSize: 14, color: COLORS.text, fontWeight: '600' },
  modalCloseButton: { alignItems: 'center', paddingVertical: 8 },
  modalCloseButtonText: { color: COLORS.textMuted, fontSize: 13 },

  primaryButton: { backgroundColor: COLORS.brand, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  neutralButton: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  neutralButtonText: { color: COLORS.text, fontWeight: '600', fontSize: 14 },
  dangerButton: { backgroundColor: COLORS.danger, borderRadius: 8, paddingVertical: 12, alignItems: 'center', flex: 1 },
  buttonDisabled: { opacity: 0.5 },

  confirmCard: { width: '100%', maxWidth: 340, backgroundColor: '#fff', borderRadius: 14, padding: 16, gap: 10 },
  confirmTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  confirmMessage: { fontSize: 13, color: COLORS.textMuted },
  confirmActions: { flexDirection: 'row', gap: 10, marginTop: 4 }
});
