// Type declarations cho image-normalize.mjs (dùng khi import từ TS — bot-api ocr-send-service).
export function fileToPng(filePath: string): Promise<Buffer>;
export function bufferToPng(buf: Buffer, ext?: string): Promise<Buffer>;
export function bufferToPreviewJpeg(buf: Buffer, maxSize?: number, quality?: number): Promise<Buffer>;
export const __moduleDir: string;
