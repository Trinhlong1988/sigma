// AUDIT ĐỐI KHÁNG 5/9 — REGRESSION khóa lỗ HIGH IDOR/BOLA: MỌI route /v1/digistore/* trả dòng tiền/PII/creds ngân
// hàng PHẢI khai báo requireAlphaOwner Ở TẦNG ROUTE (không chỉ requireSession). 65 test cũ phủ hàm thuần + adapter DB
// nhưng KHÔNG phủ tầng phân quyền HTTP — đây là test bù (thất bại quy trình test → gate chặn tái phát).
//
// Cách kiểm: soi digistoreRouter.stack → với mỗi path, thu tên các handler → khẳng định 'requireAlphaOwner' có mặt.
// Đây là guard CẤU TRÚC (chứng minh gate ĐƯỢC WIRE lên route). Hành vi 403/401 của chính middleware đã test ở
// alpha-owner.test.ts. Nếu ai lỡ bỏ gate 1 route → test này ĐỎ ngay.
delete process.env.SIGMA_OWNER_TEST_ALL; // gate THẬT phải được test không bypass
import { describe, expect, it } from 'vitest';
import { digistoreRouter } from '../src/routes/digistore.js';

type Layer = { route?: { path: string; stack: Array<{ handle: { name?: string } }> } };

function handlerNamesFor(path: string): string[] {
  const layers = (digistoreRouter as unknown as { stack: Layer[] }).stack;
  const names: string[] = [];
  for (const l of layers) {
    if (l.route && l.route.path === path) {
      for (const s of l.route.stack) names.push(s.handle?.name ?? '');
    }
  }
  return names;
}

// Mọi route trong vùng này = dữ liệu tiền/PII/creds bank → BẮT BUỘC owner-gate.
const OWNER_GATED = [
  '/v1/digistore/check-baoco',
  '/v1/digistore/set-cred',
  '/v1/digistore/creds',
  '/v1/digistore/refresh',
  '/v1/digistore/suggest-hkd',
  '/v1/qr-daily-limit', // hạn mức QR/ngày (6/9) — cùng router, cũng owner-gate
  // [14/9 — Báo cáo QR full chức năng CQR] Đối soát tay + gán đại lý + danh mục đại lý — đều owner-gate
  // (requireSession + requireAlphaOwner ở digistore.ts): ghi qr_baoco_recon (nghiệp vụ tiền) + lộ tên khách.
  '/v1/digistore/baoco-recon',
  '/v1/digistore/baoco-recon-dealer',
  // [16/9 — VietQR hoàn đại lý] TK nhận hoàn (TIỀN chuyển theo TK này) + đánh dấu hoàn + proxy ảnh QR — đều owner-gate.
  '/v1/digistore/dealer-refund-account',
  '/v1/digistore/refund-done',
  '/v1/digistore/refund-undo',
  '/v1/digistore/vietqr-png',
  '/v1/digistore/baoco-fee-type',
  // [16/9 tối — đối soát + hoàn per LÔ POS (Doanh số phòng)] — owner-gate (money).
  '/v1/pos-lot/recon',
  '/v1/pos-lot/note', // [21/9] ghi chú per-lô — cùng nhóm recon, owner-gate
  '/v1/pos-lot/refund-done',
  '/v1/pos-lot/refund-undo',
  '/v1/pos-lot/cong-no', // [17/9] sổ tiền đại lý đang cầm — số liệu tiền toàn hệ ⇒ owner-gate
  // [17/9 — YÊU CẦU HOÀN (YC) gộp nhiều lô] tạo/đọc/đánh dấu đã chuyển/huỷ — ĐỀU đụng tiền ⇒ owner-gate.
  '/v1/refund-request',
  '/v1/refund-request/list',
  '/v1/refund-request/paid',
  '/v1/refund-request/cancel',
  // [22/9 — YC NĐT hoàn] Nhà đầu tư: TK nhận + ảnh VietQR + tạo/đọc/đánh dấu/huỷ yêu cầu hoàn. ĐỀU đụng tiền
  // ⇒ owner-gate (đã đối chiếu từng dòng trong digistore.ts: cả 6 route đều có requireAlphaOwner).
  '/v1/digistore/ndt-qr-account',
  '/v1/digistore/ndt-vietqr-png',
  '/v1/ndt-refund-request',
  '/v1/ndt-refund-request/list',
  '/v1/ndt-refund-request/paid',
  '/v1/ndt-refund-request/cancel'
];

/**
 * [22/9] ĐỌC báo cáo đối soát — mở cho VIEWER (DL65 Khach Demo F) chứ không chỉ chủ SigMa: `requireQrReconViewer`.
 * KHÔNG phải lỗ hổng mà là chính sách Admin Demo chốt; bù lại server TƯỚC lợi nhuận/sau-phí-mua của người không
 * phải chủ NGAY TRONG DỮ LIỆU TRẢ VỀ (ẩn trên UI không đủ — soi network là thấy).
 * [14/10] `/baoco-export` (tải .xlsx) cùng nhóm này: cùng dữ liệu với báo cáo, và cũng tước lợi nhuận TRONG FILE.
 * Guard dưới khẳng định: các route này PHẢI có requireQrReconViewer (không được rơi về chỉ requireSession).
 */
const VIEWER_GATED = [
  '/v1/digistore/baoco-report',
  '/v1/digistore/baoco-export',
  '/v1/digistore/dealer-names'
];
/** [12/9] Route NỘI BỘ token-gated (X-Internal-Token fail-closed, KHUÔN internal-ingest) — KHÔNG owner-gate vì
 *  không có phiên người dùng; guard riêng bên dưới khẳng định KHÔNG lộ khi thiếu token (401/503). */
const TOKEN_GATED_INTERNAL = ['/internal/digistore/paysmart-poll'];

/** MỌI path đang đăng ký trong router (ĐẾM ĐỘNG — R198). Danh sách cứng ở trên chỉ để khẳng định các route đã biết
 *  vẫn tồn tại; guard THẬT là quét động bên dưới, nên route MỚI thêm sau này không thể lọt gate mà test vẫn xanh. */
function allRegisteredPaths(): string[] {
  const layers = (digistoreRouter as unknown as { stack: Layer[] }).stack;
  const paths = new Set<string>();
  for (const l of layers) if (l.route?.path) paths.add(l.route.path);
  return [...paths];
}

describe('digistore routes — phân quyền owner (audit 5/9)', () => {
  it('mọi route /v1/digistore/* đăng ký được (stack có path)', () => {
    for (const p of OWNER_GATED) {
      expect(handlerNamesFor(p).length, `route ${p} phải tồn tại trong router`).toBeGreaterThan(0);
    }
  });

  it('mọi route /v1/digistore/* có requireAlphaOwner trong chuỗi handler', () => {
    for (const p of OWNER_GATED) {
      const names = handlerNamesFor(p);
      expect(names, `route ${p} PHẢI có requireAlphaOwner (chống IDOR/BOLA)`).toContain('requireAlphaOwner');
    }
  });

  it('không route /v1/digistore/* nào chỉ có requireSession mà thiếu owner-gate', () => {
    for (const p of OWNER_GATED) {
      const names = handlerNamesFor(p);
      const hasOwner = names.includes('requireAlphaOwner');
      expect(hasOwner, `route ${p} thiếu owner-gate → rò rỉ dòng tiền/PII/creds`).toBe(true);
    }
  });

  // [8/9 — R198 "check phải CHẠY + đếm ĐỘNG"] Trước đây guard chỉ soi DANH SÁCH CỨNG ở trên → route mới (vd
  // /suggest-hkd) quên gate vẫn XANH. Nay quét MỌI route đang đăng ký.
  it('QUÉT ĐỘNG: mọi route đăng ký trong digistoreRouter đều có requireAlphaOwner (trừ internal token-gated đã khai báo)', () => {
    const paths = allRegisteredPaths();
    expect(paths.length, 'router phải có route để kiểm').toBeGreaterThan(0);
    const thieu = paths.filter((p) => !TOKEN_GATED_INTERNAL.includes(p) && !VIEWER_GATED.includes(p)
      && !handlerNamesFor(p).includes('requireAlphaOwner'));
    expect(thieu, `route thiếu owner-gate: ${thieu.join(', ')}`).toEqual([]);
  });

  it('nhóm ĐỌC báo cáo: phải có requireQrReconViewer (mở cho viewer KHÔNG được thành mở toang)', () => {
    for (const p of VIEWER_GATED) {
      const names = handlerNamesFor(p);
      expect(names.length, `route ${p} phải tồn tại trong router`).toBeGreaterThan(0);
      expect(names, `route ${p} PHẢI có requireQrReconViewer (không được chỉ requireSession)`).toContain('requireQrReconViewer');
    }
  });

  it('QUÉT ĐỘNG: mọi route đăng ký đều nằm trong danh sách đã rà soát (thêm route mới phải khai báo)', () => {
    const laHang = allRegisteredPaths().filter((p) => !OWNER_GATED.includes(p) && !TOKEN_GATED_INTERNAL.includes(p)
      && !VIEWER_GATED.includes(p));
    expect(laHang, `route mới chưa khai báo trong OWNER_GATED/TOKEN_GATED_INTERNAL: ${laHang.join(', ')}`).toEqual([]);
  });

  // [12/9] Route internal PHẢI tự vệ bằng token: thiếu/sai token → 401 (có cấu hình) hoặc 503 (chưa cấu hình) —
  // TUYỆT ĐỐI không 200. Gọi handler thật qua supertest-style mini: dựng express app gắn router.
  it('TOKEN_GATED_INTERNAL: thiếu token → 401/503, không bao giờ lộ', async () => {
    const express = (await import('express')).default;
    const http = await import('node:http');
    const app = express();
    app.use(express.json());
    app.use(digistoreRouter);
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as { port: number }).port;
    try {
      for (const p of TOKEN_GATED_INTERNAL) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST' });
        expect([401, 503], `${p} thiếu token phải 401/503, nhận ${res.status}`).toContain(res.status);
      }
    } finally { srv.close(); }
  });
});
