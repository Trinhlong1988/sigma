// URL endpoint avatar THẬT của 1 agent — NGUỒN DUY NHẤT dựng URL (item 12, 6/8). Tách khỏi AgentAvatar.tsx
// (component React) để dùng lại được ở tầng lib THUẦN (notify-avatar.ts, AppShell resolve avatar thông báo push)
// mà KHÔNG kéo React vào. Endpoint đọc theo :id (người KHÁC xem được — routes/me.ts) nên dùng cho cả bạn bè/đối
// phương, KHÔNG chỉ /me. `version` (updatedAt) → `?v=` phá cache khi ảnh vừa đổi (key mới, luôn cache-miss).
//
// LƯU Ý auth: endpoint này (GET /v1/agents/:id/avatar) đòi header CSRF `x-sigma-client:web` (requireSession)
// nên KHÔNG dùng URL trần trong <img src>/Notification icon được — PHẢI tải blob qua proxyFetch
// (fetchAttachmentObjectUrl/fetchAttachmentDataUrl, xem attachment-blob.ts). Hàm này CHỈ dựng chuỗi URL.
function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

/** URL đọc avatar THẬT của 1 agent theo agentId. `version` tùy chọn (updatedAt) → thêm `?v=` để phá cache. */
export function agentAvatarUrl(agentId: number, version?: string | number | null): string {
  const base = `${botApiBaseUrl()}/v1/agents/${agentId}/avatar`;
  return version != null && version !== '' ? `${base}?v=${encodeURIComponent(String(version))}` : base;
}
