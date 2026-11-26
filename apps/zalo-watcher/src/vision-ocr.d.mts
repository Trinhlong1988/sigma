// Type declarations cho vision-ocr.mjs (dùng khi import từ TS — bot-api ocr-send-service).
export interface VisionBill {
  tid: string | null;
  agencyName: string | null;
  batchNumber: string | null;
  type: 'SALE' | 'SETTLEMENT';
  totalAmount: number;
  dateTime: string | null;
}
export interface VisionResult {
  bills: VisionBill[];
  failed?: boolean;
  escalated?: boolean;
}
export interface ReadOpts {
  model?: string;
  maxSize?: number;
  quality?: number;
  timeoutMs?: number;
  retries?: number;
  noCache?: boolean;
}
export function readBillVision(pngBuffer: Buffer, opts?: ReadOpts): Promise<VisionResult>;
export function readBillVisionSmart(pngBuffer: Buffer, opts?: ReadOpts): Promise<VisionResult>;
export function readBillForSend(pngBuffer: Buffer, opts?: ReadOpts): Promise<VisionResult>;
export function shouldEscalateBillRead(bills: VisionBill[] | null | undefined): boolean;
export function ocrCacheGet(type: string, pngBuffer: Buffer): unknown;
export function ocrCacheSet(type: string, pngBuffer: Buffer, value: unknown): void;
export function readTransferVision(pngBuffer: Buffer, opts?: ReadOpts): Promise<{ transfers: unknown[] }>;
