// SigMa — HÀM DÙNG CHUNG cho nghiệp vụ SigMa theo đại lý (TID kèm loại thẻ + QR nhận tiền). Các ROUTE
// Bearer-token cũ (GET /v1/agents/:agentCode/tids, POST /v1/agents/:agentCode/quote, GET /v1/agents/:agentCode/qr)
// ĐÃ GỠ (BOLA fix 20/8): khóa Bearer TĨNH dùng-chung (SIGMA_API_KEY) KHÔNG mang danh tính đại lý nên bất kỳ
// ai giữ khóa đều thao tác được cho MỌI :agentCode qua URL — không có kiểm tra sở hữu. Bề mặt LIVE thật là các
// route RC-auth /v1/me/* (routes/me.ts) suy agentId TỪ phiên đăng nhập, KHÔNG nhận :agentCode client tự khai.
// File này chỉ còn GIỮ các hàm thuần mà routes/me.ts TÁI DÙNG — KHÔNG còn router/route nào ở đây.
import { getBotDb } from '../db.js';
import { agentScopeCustomerIds } from '../agent-tid-scope.js';

// Đáp ứng /tids — mỗi TID kèm sẵn danh sách loại thẻ khả dụng của ngân hàng TID đó, để caller (routes/me.ts →
// bot/web) tự quyết định mời đại lý chọn (>1 lựa chọn) hay im lặng dựa mặc định của quote (0 hoặc 1 lựa chọn).
export interface TidWithCardTypeOptions {
  id: number;
  tid: string;
  mid: string | null;
  status: string;
  // hkdName/bankName (SIGMA Phase 3, 24/7) — để routes/me.ts (GET /v1/me/tids) hiển thị đúng mục A0 kế
  // hoạch ("mỗi dòng hiện: số TID, tên HKD, ngân hàng").
  hkdName: string | null;
  bankName: string | null;
  cardTypeOptions: { id: number; name: string }[];
}

// Tách thành hàm riêng (24/7) để routes/me.ts (GET /v1/me/tids) TÁI DÙNG NGUYÊN — logic "TID còn sống +
// cardTypeOptions theo ngân hàng" cho đại lý đang đăng nhập (agentId suy từ phiên, KHÔNG từ URL).
export async function listAgentTidsWithCardTypeOptions(db: ReturnType<typeof getBotDb>, agentId: number): Promise<TidWithCardTypeOptions[]> {
  // ĐẠI LÝ = KHÁCH, "tự nhận" qua NHÓM CHAT — phạm vi khách suy từ helper DÙNG CHUNG (agent-tid-scope.ts), CÙNG
  // nguồn với quoteRow/previewSellFeeForTid (fee-quote.ts) để 3 đường không lệch định nghĩa "TID của đại lý"
  // (audit 20/8 I1). THAY cách cũ lọc `tids.agentId` (LUÔN null → không bill nào từng khớp → mọi đại lý báo "chưa
  // liên kết đại lý"). Xem agent-tid-scope.ts cho chuỗi + hardening C2/N2.
  const customerIds = await agentScopeCustomerIds(db, agentId);
  if (customerIds.length === 0) return [];
  const tids = await db.tid.findMany({
    where: { customerId: { in: customerIds }, deletedAt: null, status: { notIn: ['DEAD', 'CLOSED', 'RECALLED'] } },
    select: { id: true, tid: true, mid: true, status: true, bankId: true, hkdName: true },
    orderBy: { id: 'asc' }
  });
  if (tids.length === 0) return [];
  // cardTypeOptions — cho caller (routes/me.ts → bot/web-demo) biết có >1 lựa chọn để mời chọn, hay chỉ 0/1 để
  // dựa mặc định của quote (xem fee-quote.ts). ĐÚNG query apps/desktop/src/main/tid-sell-fee-service.ts:62, rỗng
  // nếu TID chưa gán ngân hàng. FIX N+1 (audit 20/8 P1): gom bankId DISTINCT → 1 cardType.findMany + 1 bank.findMany
  // rồi map trong bộ nhớ (trước: 2 query/TID; chủ/staff ở nhiều nhóm → hàng trăm query mỗi lần gọi + mỗi OCR preview).
  const bankIds = [...new Set(tids.map((t) => t.bankId).filter((b): b is number => b != null))];
  const [cardTypes, banks] = await Promise.all([
    bankIds.length
      ? db.cardType.findMany({ where: { bankId: { in: bankIds }, deletedAt: null }, select: { id: true, name: true, bankId: true }, orderBy: { id: 'asc' } })
      : Promise.resolve([] as { id: number; name: string; bankId: number }[]),
    bankIds.length
      ? db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: number; name: string }[])
  ]);
  const cardsByBank = new Map<number, { id: number; name: string }[]>();
  for (const ct of cardTypes) {
    const arr = cardsByBank.get(ct.bankId) ?? [];
    arr.push({ id: ct.id, name: ct.name }); // findMany đã orderBy id asc → thứ tự trong bank giữ đúng.
    cardsByBank.set(ct.bankId, arr);
  }
  const bankNameById = new Map(banks.map((b) => [b.id, b.name]));
  return tids.map((t) => ({
    id: t.id,
    tid: t.tid,
    mid: t.mid,
    status: t.status,
    hkdName: t.hkdName,
    bankName: t.bankId != null ? (bankNameById.get(t.bankId) ?? null) : null,
    cardTypeOptions: t.bankId != null ? (cardsByBank.get(t.bankId) ?? []) : []
  }));
}

export interface AgentQrData {
  agentCode: string | null;
  imageBase64: string;
  mime: string;
  bankAccountLabel: string | null;
  qrUpdatedAt: string | null;
}

interface AgentQrSource {
  code: string | null;
  qrImage: Uint8Array | null;
  qrImageMime: string | null;
  bankAccountLabel: string | null;
  qrUpdatedAt: Date | null;
}

// Tách hàm thuần (24/7) để routes/me.ts (GET /v1/me/qr) TÁI DÙNG NGUYÊN cách "chưa cấu hình QR → coi như không
// có" — tránh cài lại điều kiện (qrImage rỗng/null) ở nhiều nơi.
export function buildAgentQrResult(agent: AgentQrSource): { ok: true; data: AgentQrData } | { ok: false } {
  if (!agent.qrImage || agent.qrImage.length === 0) return { ok: false };
  return {
    ok: true,
    data: {
      agentCode: agent.code,
      imageBase64: Buffer.from(agent.qrImage).toString('base64'),
      mime: agent.qrImageMime ?? 'image/png',
      bankAccountLabel: agent.bankAccountLabel,
      qrUpdatedAt: agent.qrUpdatedAt ? agent.qrUpdatedAt.toISOString() : null
    }
  };
}
