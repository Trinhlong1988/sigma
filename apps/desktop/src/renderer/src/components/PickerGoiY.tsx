// Ô CHỌN CÓ GỢI Ý TÌM KIẾM — dùng chung cho mọi chỗ phải chọn 1 thứ trong danh sách dài
// (khách hàng, máy POS, ngân hàng…). Admin Demo 15-16/11: "có gợi ý tìm kiếm", "không phân biệt hoa thường".
//
// Vì sao <datalist> chứ không tự dựng dropdown: trình duyệt lọc sẵn theo chuỗi con, KHÔNG phân biệt hoa/thường,
// bàn phím + đọc màn hình chạy đúng, và không phải bắt sự kiện click-ra-ngoài (nguồn bug cố hữu của dropdown tự chế).
// Bề ngoài dùng ĐÚNG lớp `inputCls` của brand chung — nhìn y hệt các ô nhập khác, không lệch design-system.
import { useId, useMemo } from 'react';

export interface MucChon {
  /** Giá trị trả về (giữ dạng chuỗi cho khớp <select> cũ, thay thế 1-1). */
  value: string;
  /** Chữ hiện trong ô + trong danh sách gợi ý. Nên có MÃ để gõ mã ra ngay. */
  nhan: string;
}

/** Lớp ô nhập của brand chung (khớp `inputCls` dùng khắp các màn). */
const O_NHAP = 'w-full rounded-md border border-line px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand';

export function PickerGoiY({
  items,
  value,
  onChange,
  placeholder = 'Gõ để tìm…',
  disabled,
  dataKiem
}: {
  items: MucChon[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  dataKiem?: string;
}): JSX.Element {
  const listId = useId();
  const theoNhan = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) m.set(it.nhan.trim().toLowerCase(), it.value);
    return m;
  }, [items]);
  const dangChon = items.find((it) => it.value === value);

  return (
    <>
      <input
        className={O_NHAP}
        list={listId}
        // `key` theo value: khi cha đổi lựa chọn (reset form, chọn giúp…) ô vẽ lại đúng nhãn mới.
        key={value}
        defaultValue={dangChon ? dangChon.nhan : ''}
        placeholder={placeholder}
        disabled={disabled}
        data-kiem={dataKiem}
        onChange={(e) => {
          // Khớp KHÔNG phân biệt hoa/thường. Gõ dở (chưa khớp ai) ⇒ coi như CHƯA chọn — không đoán bừa,
          // vì chọn nhầm khách/máy là giao nhầm nhà.
          const v = theoNhan.get(e.target.value.trim().toLowerCase());
          onChange(v ?? '');
        }}
      />
      <datalist id={listId}>
        {items.map((it) => (
          <option key={it.value} value={it.nhan} />
        ))}
      </datalist>
    </>
  );
}

/** So MÃ theo kiểu người đọc: phần số so theo GIÁ TRỊ (KH2 < KH10), phần chữ so theo bảng chữ cái. */
export function soSanhMa(a: string, b: string): number {
  return (a ?? '').localeCompare(b ?? '', 'vi', { numeric: true, sensitivity: 'base' });
}
