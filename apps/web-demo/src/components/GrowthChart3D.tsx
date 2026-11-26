// BIỂU ĐỒ TĂNG TRƯỞNG "3D hiện đại" (Admin Demo 27/8: "có biểu đồ tăng trưởng mẫu hiện đại 3d"). SVG THUẦN
// (KHÔNG thêm thư viện nặng) — cột doanh số đùn khối 3D (mặt trước gradient + mặt trên sáng + mặt phải tối + đổ
// bóng) kèm đường xu hướng "sau phí". Bọc trong container overflow-x-auto → KHÔNG vỡ layout mobile 412px
// (nhiều ngày thì cuộn ngang, cùng pattern biểu đồ hoàn tiền cùng màn).
//
// DỮ LIỆU THẬT: caller truyền `points` = doanh số theo NGÀY từ API (KpiDailyPoint gross/net). KHÔNG bịa số —
// điểm nào API không trả thì mảng rỗng → hiện placeholder.
import type { JSX } from 'react';

export interface GrowthPoint {
  date: string; // YYYY-MM-DD
  gross: number; // trước phí
  net: number; // sau phí (thực nhận)
}

const fmtVnd = (n: number): string => Math.round(n).toLocaleString('vi-VN');
const fmtShort = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}tr`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
};

export function GrowthChart3D({ points }: { points: GrowthPoint[] }): JSX.Element {
  if (points.length === 0) {
    return (
      <div className="rounded-lg-mac border border-line p-6 text-center text-sm text-slate-400">
        Chưa có dữ liệu doanh số theo ngày trong khoảng thời gian này.
      </div>
    );
  }

  // Hình học cột 3D.
  const barW = 16;
  const depth = 7; // độ dày khối đùn (3D).
  const gap = 22;
  const chartH = 150;
  const labelH = 22;
  const leftPad = 6;
  const rightPad = depth + 6;
  const step = barW + depth + gap;
  const width = leftPad + points.length * step + rightPad;
  const svgH = depth + chartH + labelH;
  const baseline = depth + chartH; // đáy mặt trước.

  const max = Math.max(1, ...points.map((p) => Math.max(p.gross, p.net))) * 1.1;

  const xFront = (i: number): number => leftPad + i * step;
  const centerX = (i: number): number => xFront(i) + barW / 2;
  const netY = (v: number): number => baseline - (v / max) * chartH;

  const netLine = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${centerX(i).toFixed(1)},${netY(p.net).toFixed(1)}`).join(' ');

  return (
    <div className="overflow-x-auto rounded-lg-mac border border-line bg-white p-3">
      <svg width={width} height={svgH} role="img" aria-label="Biểu đồ tăng trưởng doanh số theo ngày">
        <defs>
          <linearGradient id="g3dFront" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4aa3e8" />
            <stop offset="100%" stopColor="#1877d6" />
          </linearGradient>
          <linearGradient id="g3dNet" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#22c55e" />
            <stop offset="100%" stopColor="#16a34a" />
          </linearGradient>
          <filter id="g3dShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="3" stdDeviation="2.5" floodColor="#1877d6" floodOpacity="0.25" />
          </filter>
        </defs>

        {/* Lưới ngang mờ */}
        {[0, 0.5, 1].map((g) => {
          const gy = depth + chartH * g;
          return <line key={g} x1={leftPad} y1={gy} x2={width - rightPad} y2={gy} stroke="#eef2f7" strokeWidth={1} />;
        })}

        {/* Cột 3D (đùn lên-phải) */}
        <g filter="url(#g3dShadow)">
          {points.map((p, i) => {
            const h = Math.max(1, (p.gross / max) * chartH);
            const x = xFront(i);
            const yTop = baseline - h;
            const topFace = `${x},${yTop} ${x + barW},${yTop} ${x + barW + depth},${yTop - depth} ${x + depth},${yTop - depth}`;
            const rightFace = `${x + barW},${yTop} ${x + barW + depth},${yTop - depth} ${x + barW + depth},${baseline - depth} ${x + barW},${baseline}`;
            return (
              <g key={p.date}>
                <polygon points={rightFace} fill="#135fa8" />
                <polygon points={topFace} fill="#6bb6ef" />
                <rect x={x} y={yTop} width={barW} height={h} rx={2} fill="url(#g3dFront)">
                  <title>{`${p.date}\nTrước phí: ${fmtVnd(p.gross)}đ\nSau phí: ${fmtVnd(p.net)}đ`}</title>
                </rect>
              </g>
            );
          })}
        </g>

        {/* Đường xu hướng "sau phí" (thực nhận) */}
        <path d={netLine} fill="none" stroke="url(#g3dNet)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={p.date} cx={centerX(i)} cy={netY(p.net)} r={2.6} fill="#16a34a" stroke="#fff" strokeWidth={1} />
        ))}

        {/* Nhãn ngày (MM/DD) */}
        {points.map((p, i) => (
          <text key={p.date} x={centerX(i)} y={svgH - 6} textAnchor="middle" fontSize={9} fill="#94a3b8">
            {p.date.slice(5).replace('-', '/')}
          </text>
        ))}

        {/* Nhãn đỉnh (rút gọn) cho cột cao nhất để có mốc đọc */}
        <text x={leftPad} y={depth - 1} fontSize={9} fill="#cbd5e1">
          {fmtShort(max)}
        </text>
      </svg>
    </div>
  );
}
