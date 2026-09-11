export class AssetByteLimitError extends Error {}

function declaredResponseLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (!raw || !/^\d+$/.test(raw)) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : null;
}

/** Read a response without trusting Content-Length. The stream is cancelled as
 * soon as it crosses the caller's byte allowance. */
export async function readBoundedAssetResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new AssetByteLimitError(
        `Asset contains ${bytes.byteLength} bytes, above the ${maxBytes}-byte allowance.`,
      );
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
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
    }
  } finally {
    reader.releaseLock();
  }

  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
