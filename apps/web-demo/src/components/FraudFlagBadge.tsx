// Chip cảnh báo gian lận theo Rule A-F, 2 mức: nhẹ (amber) / nghiêm trọng (rose). MỚI cho web-demo.
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { FraudFlag } from '../mock-data/types';
import { FRAUD_RULE_LABEL } from '../mock-data/lo';

import type { JSX } from "react";

export function FraudFlagBadge({ flag }: { flag: FraudFlag }): JSX.Element {
  const isSevere = flag.severity === 'nghiem_trong';
  return (
    <div
      title={flag.description}
      className={
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ' +
        (isSevere ? 'bg-danger/10 text-danger' : 'bg-warning/15 text-warning')
      }
    >
      {isSevere ? <ShieldAlert className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
      {FRAUD_RULE_LABEL[flag.rule] ?? `Quy tắc ${flag.rule}`}
      <span className="opacity-70">· {isSevere ? 'Nghiêm trọng' : 'Cảnh báo nhẹ'}</span>
    </div>
  );
}
