// MÃ HOÁ MẬT KHẨU DIGISTORE PER-MÃ — [MOVE 5/9 Admin Demo] lõi đã chuyển sang packages/services/src/digistore-secret.ts
// để bot-api + quanly-api (desktop set-cred) dùng CHUNG 1 nguồn (KHÔNG copy thuật toán 2 nơi). File này CHỈ re-export
// để mọi import cũ (`./digistore-secret.js`) + test bot-api tiếp tục chạy không đổi.
export { encryptSecret, decryptSecret, DigistoreSecretError } from '@sigma/services';
