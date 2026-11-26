// (21/8, tính năng "chọn loại thẻ + giá bán trên bill") — ô chọn LOẠI THẺ dùng CHUNG cho cả màn xem-trước-quét-
// bill (OcrBillPreview.tsx) lẫn màn sửa-bill (EditBillMessageModal.tsx), tránh lệch 2 nơi (đúng bài học "sửa 1
// nơi quên nơi khác"). Bill quẹt KHÔNG tự nhận diện loại thẻ; mỗi loại (MB / Ngoài-Visa-Master / Ngoài-Napas)
// có GIÁ BÁN khác nhau → đại lý chọn đúng loại để dòng "Hoàn tiền" tính đúng phí. Backend (getTidCardOptions)
// trả danh sách thẻ + giá; component này CHỈ hiển thị + báo lựa chọn ra ngoài, KHÔNG tự tính tiền.
import type { JSX } from 'react';
import { Field, inputCls } from './Field';
import type { TidCardOptions } from '../lib/agent-api-client';

/** Text giá bán 1 loại thẻ: milli-% (% × 1000) → "1,1%"; null = chưa cấu hình giá bán (Admin Demo 20/8: KHÔNG mượn
 * niêm yết, hiện rõ "chưa cấu hình giá bán" thay vì "0%"). */
export function priceText(phiBanMilli: number | null): string {
  return phiBanMilli == null
    ? 'chưa cấu hình giá bán'
    : `${(phiBanMilli / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%`;
}

/** Ô chọn loại thẻ. Ẩn hoàn toàn (trả null) khi KHÔNG có thẻ nào (TID ngoài scope/chưa cấu hình) — đúng yêu cầu
 * "CHỈ khi cardOptions?.cards?.length > 0". `value`=cardTypeId đang chọn; `onChange` nhận cardTypeId mới. */
export function CardTypeSelect({
  options,
  value,
  onChange
}: {
  options: TidCardOptions | null;
  value: number | null;
  onChange: (cardTypeId: number) => void;
}): JSX.Element | null {
  if (!options?.cards?.length) return null;
  return (
    <Field label="Loại thẻ">
      <select className={inputCls} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
        {options.cards.map((card) => (
          <option key={card.cardTypeId} value={card.cardTypeId}>
            {`${card.name} — ${priceText(card.phiBanMilli)}`}
          </option>
        ))}
      </select>
    </Field>
  );
}
