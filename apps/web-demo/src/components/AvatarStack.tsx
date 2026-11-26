// Chồng avatar tròn (nhóm chat / danh sách thành viên online). MỚI cho web-demo.
import type { Agent } from '../mock-data/types';
import { OnlineDot } from './OnlineDot';
import { avatarColorForKey } from './../lib/avatar-color';

import type { JSX } from "react";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[parts.length - 1]?.[0] ?? '?').toUpperCase();
}

export function AvatarStack({ agents, max = 4, size = 28 }: { agents: Agent[]; max?: number; size?: number }): JSX.Element {
  const shown = agents.slice(0, max);
  const extra = agents.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((a, i) => (
        <div
          key={a.id}
          title={a.name}
          className="relative flex items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold text-white shadow-soft"
          style={{
            width: size,
            height: size,
            marginLeft: i === 0 ? 0 : -Math.round(size * 0.32),
            // Item 7 (6/8) — KHÔNG đọc `a.avatarColor` (màu rời của mock Agent) → dùng NGUỒN DUY NHẤT avatar-color.ts.
            // LƯU Ý: component này hiện KHÔNG có nơi nào dùng (grep 0 caller) — demo Phase 0; mock `Agent.id` là
            // CHUỖI (không phải agentId số) nên dùng `avatarColorForKey(a.id)` (cùng palette/hash). Nếu sau này nối
            // dữ liệu THẬT có agentId số, đổi sang `avatarColorForAgent(agentId)`.
            backgroundColor: avatarColorForKey(a.id),
            zIndex: shown.length - i
          }}
        >
          {initials(a.name)}
          {a.online && (
            <OnlineDot
              online
              size={Math.round(size * 0.32)}
              className="absolute -bottom-0.5 -right-0.5 border-2 border-white"
              title="Đang hoạt động"
            />
          )}
        </div>
      ))}
      {extra > 0 && (
        <div
          className="flex items-center justify-center rounded-full border-2 border-white bg-slate-300 text-[11px] font-semibold text-slate-700 shadow-soft"
          style={{ width: size, height: size, marginLeft: -Math.round(size * 0.32) }}
        >
          +{extra}
        </div>
      )}
    </div>
  );
}
