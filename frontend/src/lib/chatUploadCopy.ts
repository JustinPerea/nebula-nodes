import { copyForStatus } from './errorCopy';

/** The line under a chat image chip whose upload was refused (the chip
 * already shows the file's name). Its two written chip lines stay; else the
 * backend's written reason or GM's line for the status (error-copy round 2:
 * never "Upload failed (503)"). */
export function chatUploadChipError(status: number, detail: unknown): string {
  if (status === 413) return 'Image > 20MB';
  if (status === 415) return 'Not an image';
  return copyForStatus(status, detail);
}
