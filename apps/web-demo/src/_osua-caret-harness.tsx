// HARNESS DEV (không được import bởi app) — mount OSua + useGroupedMoneyField y hệt OcrSendScreen:857
// cho scripts/harness-osua-caret.ts điều khiển thật. Xem comment ở script đó.
import { createRoot } from 'react-dom/client';
import { OSua } from './components/ImageZoomCompare';
import { useGroupedMoneyField } from './lib/grouped-money-input';
import type { JSX } from 'react';

function Harness(): JSX.Element {
  const f = useGroupedMoneyField('20898000');
  return <OSua m={{ label: 'Số tiền', value: f.value, kieu: 'tien', sua: (v) => f.setValue(v) }} />;
}
export function mount(): void {
  const div = document.createElement('div');
  div.id = 'osua-harness';
  document.body.appendChild(div);
  createRoot(div).render(<Harness />);
}
