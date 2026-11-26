// Card hiển thị QR nhận tiền trong tin nhắn / màn QrDisplayScreen. MỚI cho web-demo — QR vẽ giả lập
// bằng lưới ô vuông ngẫu nhiên-cố định (không cần thư viện QR ngoài cho demo tĩnh).
import { QrCode } from 'lucide-react';

import type { JSX } from "react";

function pseudoQrPattern(seed: string): boolean[][] {
  const size = 9;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const grid: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) {
      h = (h * 1103515245 + 12345) >>> 0;
      row.push(((h >> 16) & 1) === 1);
    }
    grid.push(row);
  }
  return grid;
}

export function QrCard({
  amount,
  tid,
  bank,
  note
}: {
  amount: number;
  tid: string;
  bank: string;
  note?: string;
}): JSX.Element {
  const grid = pseudoQrPattern(tid + amount);
  return (
    <div className="w-64 max-w-full overflow-hidden rounded-lg-mac border border-line bg-white shadow-card">
      <div className="flex items-center gap-2 bg-gradient-to-r from-brand to-brand-teal px-3 py-2 text-white">
        <QrCode className="h-4 w-4" />
        <span className="text-sm font-semibold">QR nhận tiền</span>
      </div>
      <div className="flex flex-col items-center gap-2 p-4">
        {/* Nền QR = trắng CỐ ĐỊNH qua inline style (không dùng class bg-white) — dark mode override
            .bg-white thành nền tối làm QR tối-trên-tối mất tương phản (polish CMD_AUDIT 23/7);
            QR thật ngoài đời cũng luôn in trên nền trắng bất kể theme. */}
        <div className="grid grid-cols-9 gap-0.5 rounded p-2 ring-1 ring-line" style={{ backgroundColor: '#ffffff' }}>
          {grid.flatMap((row, r) =>
            row.map((on, c) => (
              <div key={`${r}-${c}`} className="h-2.5 w-2.5" style={{ backgroundColor: on ? '#0f172a' : '#ffffff' }} />
            ))
          )}
        </div>
        <div className="w-full text-center">
          <div className="text-lg font-bold text-brand">{amount.toLocaleString('vi-VN')} đ</div>
          <div className="mt-1 text-xs text-slate-500">
            {bank} · TID {tid}
          </div>
          {note && <div className="mt-1 text-xs text-slate-400">{note}</div>}
        </div>
      </div>
    </div>
  );
}
