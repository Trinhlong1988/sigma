// Cột tiền int8 (BigInt) → JSON.stringify(bigint) NÉM "Do not know how to serialize a BigInt" → mọi nơi ghi
// audit/serialize hàng có tiền VỠ (writeAudit best-effort nuốt → mất audit; writeAuditStrict in-tx → ROLLBACK).
// Dạy BigInt tự serialize thành SỐ (VND < 2^53 nên an toàn precision + khớp DTO number). Import SIDE-EFFECT ở
// audit.ts (nơi JSON.stringify) + quanly-api app.ts để phủ cả runtime lẫn test. PORT từ apps/desktop main/bigint-json.
if (!('toJSON' in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function (this: bigint): number {
      return Number(this);
    },
    configurable: true,
    writable: true
  });
}
export {};
