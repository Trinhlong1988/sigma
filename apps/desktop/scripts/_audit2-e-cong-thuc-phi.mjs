// AUDIT2-E — SO CÔNG THỨC PHÍ: client `Math.round((tienLo * pct * 1000) / 100000)` (BillManualEntryPage.tsx:552)
// vs backend `marginToAmount(amount, marginMilli)` (packages/business-rules/src/transaction.rules.ts:14).
// KHÔNG chép tay hàm backend: ĐỌC THẲNG file .ts, bóc thân hàm rồi dựng hàm thật (chống lệch bản).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', '..', '..', 'packages', 'business-rules', 'src', 'transaction.rules.ts');
const src = readFileSync(SRC, 'utf8');
const m = /export function marginToAmount\(amount: number, marginMilli: number\): number \{([\s\S]*?)\n\}/.exec(src);
if (!m) throw new Error('KHÔNG bóc được marginToAmount từ ' + SRC);
const than = m[1].replace(/: number/g, '').replace(/\bconst a = BigInt/, 'const a = BigInt');
// eslint-disable-next-line no-new-func
const marginToAmount = new Function('amount', 'marginMilli', than);
console.log('=== AUDIT2-E · CLIENT vs BACKEND (marginToAmount bóc từ file thật) ===');
console.log('  nguồn backend:', SRC);
console.log('  tự kiểm hàm bóc: marginToAmount(100000000, 1170) =', marginToAmount(100000000, 1170), '(phải = 1170000)');
if (marginToAmount(100000000, 1170) !== 1170000) throw new Error('hàm bóc sai — dừng, không kết luận bừa');

const clientPhi = (tienLo, pct) => Math.round((tienLo * pct * 1000) / 100000);
const backendPhi = (tienLo, pct) => marginToAmount(tienLo, Math.round(pct * 1000));

const PCT_THAT = [1.0, 1.02, 1.05, 1.07, 1.08, 1.1, 1.12, 1.13, 1.15, 1.155, 1.16, 1.17, 1.25, 1.36, 1.42, 1.5, 0.1, 0.92, 1.45];

let tongLech = 0;
let tongQuet = 0;
for (const pct of PCT_THAT) {
  let lech = 0;
  const vd = [];
  for (let t = 1000; t <= 2_000_000_000; t += 1000) {
    tongQuet++;
    const a = clientPhi(t, pct), b = backendPhi(t, pct);
    if (a !== b) { lech++; if (vd.length < 3) vd.push(`${t} → client ${a} vs backend ${b} (lệch ${a - b})`); }
  }
  for (let t = 1; t <= 300000; t += 1) {
    tongQuet++;
    const a = clientPhi(t, pct), b = backendPhi(t, pct);
    if (a !== b) { lech++; if (vd.length < 5) vd.push(`${t} → client ${a} vs backend ${b} (lệch ${a - b})`); }
  }
  tongLech += lech;
  console.log(`  % ${pct}: ${lech} mức tiền LỆCH` + (vd.length ? '\n      ' + vd.join('\n      ') : ''));
}

console.log('\n  — mức tiền thật kế toán gặp —');
const MUC = [10_000_000, 12_000_000, 18_000_000, 20_000_000, 25_000_000, 30_000_000, 33_500_000, 35_000_000, 45_000_000, 50_000_000, 100_000_000, 123_456_789, 999_999_999];
for (const pct of [1.07, 1.15, 1.17, 1.155, 1.42]) {
  const row = MUC.map((t) => (clientPhi(t, pct) === backendPhi(t, pct) ? null : `${t}:${clientPhi(t, pct) - backendPhi(t, pct)}`)).filter(Boolean);
  console.log(`  % ${pct}: ${row.length ? 'LỆCH ' + row.join(' · ') : 'khớp hết'}`);
}

console.log('\n  — số CỰC LỚN (ô tiền cho gõ 17 chữ số, client không có BigInt) —');
for (const t of [99_999_999_999_999_999, 9_007_199_254_740_993, 1e17, 12_345_678_901_234_567]) {
  const a = clientPhi(t, 1.17), b = backendPhi(t, 1.17);
  console.log(`  tiền ${t} @1,17% → client ${a} · backend ${b} · LỆCH ${a - b}`);
}

console.log('\n  — % có 3 CHỮ SỐ THẬP PHÂN hoặc hơn (Math.round(pct*1000) làm tròn ở backend) —');
for (const pct of [1.1555, 1.0005, 1.4449, 1.2345]) {
  const t = 100_000_000;
  console.log(`  %${pct} trên ${t} → client ${clientPhi(t, pct)} · backend ${backendPhi(t, pct)} · LỆCH ${clientPhi(t, pct) - backendPhi(t, pct)}`);
}

console.log(`\n  ĐÃ QUÉT ${tongQuet.toLocaleString('vi')} cặp (tiền × %) · TỔNG LỆCH: ${tongLech}`);
console.log(tongLech === 0
  ? '  ⇒ 2 công thức TRÙNG KHỚP trong dải quét: lỗi cũ #7 KHÔNG tái hiện với % ≤ 3 chữ số thập phân.'
  : '  ⇒ CÓ LỆCH thật.');
