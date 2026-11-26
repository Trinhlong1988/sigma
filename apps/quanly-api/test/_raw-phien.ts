// STUB raw-SQL cho bảng `login_sessions` — dùng chung mọi bộ kiểm route của quanly-api.
//
// VÌ SAO CÓ FILE NÀY (13/11): từ đợt BĂM PHIÊN 12/11, `auth.ts` ghi/chạm/đo phiên bằng SQL THÔ (phải tính bằng
// `now()` của DB vì tầng ORM quy đổi timestamptz lệch 7 tiếng). Db GIẢ trong các test route không có
// `$queryRawUnsafe`/`$executeRawUnsafe` ⇒ login nổ 500 ⇒ **45 bài kiểm đỏ CÂM** ở 7 file, mà cổng ship lúc đó
// cũng mù (exit code bị nuốt) nên không ai thấy. Gom 1 chỗ để lần sau code đổi thì sửa 1 nơi.
//
// NGUYÊN TẮC: câu nào CHƯA mô phỏng thì NÉM LỖI kèm nguyên văn — cấm trả rỗng cho qua (R198).

export interface PhienGia {
  id: string;
  userId: number;
  createdAt?: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  deviceInfo?: string | null;
  deviceId?: string | null;
}

export function rawPhienStub(sessions: PhienGia[]): {
  $queryRawUnsafe: (sql: string, ...p: unknown[]) => Promise<unknown[]>;
  $executeRawUnsafe: (sql: string, ...p: unknown[]) => Promise<number>;
} {
  return {
    $queryRawUnsafe: async (sql: string, ...p: unknown[]) => {
      // Đã ngồi không bao lâu (requireQlSession) — tính bằng now() của DB.
      if (/EXTRACT\(EPOCH FROM \(now\(\) - last_seen_at\)\)/i.test(sql)) {
        const s = sessions.find((x) => x.id === (p[0] as string));
        return s ? [{ giay: Math.floor((Date.now() - s.lastSeenAt.getTime()) / 1000) }] : [];
      }
      // Còn bao lâu nữa phiên tự đóng (heartbeat) = cái nào đến TRƯỚC: ngồi-không hết hạn, hay trần phiên.
      if (/SELECT LEAST\(/i.test(sql) && /login_sessions/i.test(sql)) {
        const s = sessions.find((x) => x.id === (p[0] as string));
        if (!s) return [];
        const bayGio = Date.now();
        const conNgoiKhong = (s.lastSeenAt.getTime() + Number(p[1]) * 60_000 - bayGio) / 1000;
        const conTranPhien = (s.expiresAt.getTime() - bayGio) / 1000;
        return [{ giay: Math.trunc(Math.min(conNgoiKhong, conTranPhien)) }];
      }
      throw new Error('rawPhienStub: CHƯA mô phỏng câu SQL này, bổ sung đi (đừng để test xanh suông): ' + sql);
    },
    $executeRawUnsafe: async (sql: string, ...p: unknown[]) => {
      if (/INSERT INTO login_sessions/i.test(sql)) {
        const [id, userId, ttl, deviceInfo, deviceId] = p as [string, number, string, string | null, string | null];
        const bayGio = new Date();
        sessions.push({
          id, userId, createdAt: bayGio, expiresAt: new Date(bayGio.getTime() + Number(ttl)),
          lastSeenAt: bayGio, deviceInfo: deviceInfo ?? null, deviceId: deviceId ?? null
        });
        return 1;
      }
      if (/UPDATE login_sessions SET last_seen_at/i.test(sql)) {
        const s = sessions.find((x) => x.id === (p[0] as string));
        if (!s) return 0;
        s.lastSeenAt = new Date();
        return 1;
      }
      throw new Error('rawPhienStub: CHƯA mô phỏng câu SQL (execute) này, bổ sung đi: ' + sql);
    }
  };
}
