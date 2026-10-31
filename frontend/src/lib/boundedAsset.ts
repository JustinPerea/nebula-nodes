import { ConnectionLostError } from './errorCopy';

export class AssetByteLimitError extends Error {}

/** A body read that rejects with a TypeError is fetch's own no-answer: the
 * headers came, then the connection dropped mid-stream. It is classified here,
 * at the read, as fetchUrl classifies fetch()'s rejection (typeerror review,
 * 2026-10-24). Only the read itself is wrapped, so a locked or used body (a
 * bug) stays a plain TypeError; an AbortError (the caller's own abort) comes
 * back unchanged. */
function bodyDropped(error: unknown, heading: string): unknown {
  if (!(error instanceof TypeError)) return error;
  if (error instanceof ConnectionLostError) return heading && !error.heading ? error.withHeading(heading) : error;
  return new ConnectionLostError(error, { heading });
}

function declaredResponseLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (!raw || !/^\d+$/.test(raw)) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : null;
}

/** A look at the first bytes of a body before the rest is read: a file whose
 * header is wrong stops after its header, not after the whole download. */
export interface AssetPrefixCheck {
  /** How many leading bytes the check wants. A shorter body is checked whole. */
  bytes: number;
  /** Throws to stop the read; the stream is cancelled first. `declaredLength`
   * is the response's Content-Length, when it gave a usable one. */
  check: (prefix: Uint8Array, context: { declaredLength: number | null }) => void;
}

function concatChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read a response without trusting Content-Length. The stream is cancelled as
 * soon as it crosses the caller's byte allowance, or as soon as `prefixCheck`
 * refuses its first bytes. */
export async function readBoundedAssetResponse(
  response: Response,
  maxBytes: number,
  options: { heading?: string; prefixCheck?: AssetPrefixCheck } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const heading = options.heading ?? '';
  const prefixCheck = options.prefixCheck;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new AssetByteLimitError('No asset capacity remains.');
  }
  const declaredLength = declaredResponseLength(response);
  if (declaredLength != null && declaredLength > maxBytes) {
    throw new AssetByteLimitError(
      `Asset declares ${declaredLength} bytes, above the ${maxBytes}-byte allowance.`,
    );
  }

  if (!response.body) {
    if (response.bodyUsed) throw new TypeError('The asset response body was already read.');
    const buffer = await response.arrayBuffer().catch((error: unknown) => { throw bodyDropped(error, heading); });
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > maxBytes) {
      throw new AssetByteLimitError(
        `Asset contains ${bytes.byteLength} bytes, above the ${maxBytes}-byte allowance.`,
      );
    }
    prefixCheck?.check(bytes.subarray(0, prefixCheck.bytes), { declaredLength });
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let prefixChecked = !prefixCheck;
  const checkPrefix = async () => {
    prefixChecked = true;
    if (!prefixCheck) return;
    try {
      prefixCheck.check(concatChunks(chunks, byteLength).subarray(0, prefixCheck.bytes), { declaredLength });
    } catch (error) {
      await reader.cancel('Asset failed its header check').catch(() => undefined);
      throw error;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read()
        .catch((error: unknown) => { throw bodyDropped(error, heading); });
      if (done) break;
      if (!value) continue;
      if (byteLength + value.byteLength > maxBytes) {
        await reader.cancel('Asset exceeded its byte allowance').catch(() => undefined);
        throw new AssetByteLimitError(
          `Asset exceeded the ${maxBytes}-byte allowance while streaming.`,
        );
      }
      chunks.push(value);
      byteLength += value.byteLength;
      if (!prefixChecked && byteLength >= prefixCheck!.bytes) await checkPrefix();
    }
    if (!prefixChecked) await checkPrefix();
  } finally {
    reader.releaseLock();
  }

  return concatChunks(chunks, byteLength);
}
