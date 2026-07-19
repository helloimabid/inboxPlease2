export class BodyTooLargeError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Body exceeds ${maximumBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** Read a request/response stream without ever buffering beyond the limit. */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  declaredLength?: number,
): Promise<ArrayBuffer> {
  if (
    declaredLength !== undefined && Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new BodyTooLargeError(maximumBytes);
  }
  if (!body) return new ArrayBuffer(0);

  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('body size limit exceeded');
        throw new BodyTooLargeError(maximumBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}
