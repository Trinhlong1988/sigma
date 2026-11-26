// THÔNG BÁO "MỞ FILE" sau khi tải thành công (Admin Demo 27/8: "sao không có thông báo mở file khi tải thành
// công?"). DÙNG CHUNG cho cả 3 màn có nút Tải Excel (KpiReportScreen / InvestorRevenueScreen / RoomRevenueScreen)
// để tránh lặp code. Sau khi downloadAttachment() xong, màn gọi showDownloadDone(result, fileName) → hiện hộp
// thoại "Đã tải xong" với:
//   • Native APK + file thường (có result.uri): nút [Mở file] gọi openDownloadedFile() → mở bằng app mặc định.
//   • Web/EXE: file vào Downloads trình duyệt — KHÔNG mở tự động được → chỉ báo "Đã lưu vào Tải xuống", nút [Đóng].
import { useState, type JSX } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Modal } from './Modal';
import { DotsLoader } from './DotsLoader';
import { openDownloadedFile, type DownloadResult } from '../lib/attachment-blob';

export function DownloadDoneDialog({
  result,
  fileName,
  onClose
}: {
  result: DownloadResult;
  fileName: string;
  onClose: () => void;
}): JSX.Element {
  const [opening, setOpening] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);
  // Mở được bằng app mặc định: APK + file thường (có uri, không phải ảnh vào Thư viện) HOẶC Electron desktop
  // (Admin Demo 1/9 "Excel thiếu nút mở") — bridge SigMaPC.openFile mở file đã lưu Downloads.
  const canOpen = (result.native && !!result.uri && !result.savedToGallery) || (!!result.electron && !!result.uri);

  async function handleOpen(): Promise<void> {
    setOpening(true);
    setOpenErr(null);
    try {
      await openDownloadedFile(result);
      onClose();
    } catch {
      // R198: KHÔNG nuốt lỗi câm — báo rõ file vẫn còn trong Tài liệu để người dùng tự mở.
      setOpenErr('Chưa mở được file bằng ứng dụng mặc định. File đã lưu trong thư mục Tài liệu — mở bằng ứng dụng “Tệp”.');
      setOpening(false);
    }
  }

  const savedWhere = result.electron
    ? `Đã lưu vào thư mục Tải xuống${result.uri ? ` (${result.uri})` : ''}.`
    : result.native
      ? result.savedToGallery
        ? 'Đã lưu vào Thư viện ảnh của thiết bị.'
        : 'Đã lưu vào thư mục Tài liệu của thiết bị.'
      : 'Đã lưu vào thư mục Tải xuống của trình duyệt.';

  return (
    <Modal title="Tải xuống hoàn tất" onClose={onClose} width="max-w-sm">
      <div className="flex gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-700">Đã tải xong.</p>
          <p className="mt-0.5 break-all text-xs text-slate-500">{fileName}</p>
          <p className="mt-1 text-xs text-slate-400">{savedWhere}</p>
          {openErr && <p className="mt-2 text-xs text-danger">{openErr}</p>}
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line px-4 py-2 text-sm font-medium text-slate-600 hover:bg-appbg"
        >
          Đóng
        </button>
        {canOpen && (
          <button
            type="button"
            onClick={() => void handleOpen()}
            disabled={opening}
            className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white btn-primary disabled:opacity-60"
          >
            {opening && <DotsLoader size="sm" color="white" />}
            Mở file
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Hook DÙNG CHUNG: quản trạng thái hộp thoại "Đã tải xong". Màn gọi `showDownloadDone(result, fileName)` ngay sau
 * khi `downloadAttachment()` thành công; render `{downloadDialog}` trong JSX của màn. */
export function useDownloadDialog(): {
  showDownloadDone: (result: DownloadResult, fileName: string) => void;
  downloadDialog: JSX.Element | null;
} {
  const [done, setDone] = useState<{ result: DownloadResult; fileName: string } | null>(null);
  const downloadDialog = done ? (
    <DownloadDoneDialog result={done.result} fileName={done.fileName} onClose={() => setDone(null)} />
  ) : null;
  return {
    showDownloadDone: (result, fileName) => setDone({ result, fileName }),
    downloadDialog
  };
}
