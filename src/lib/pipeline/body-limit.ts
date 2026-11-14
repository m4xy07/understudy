// Read a request body with a hard byte limit. A Content-Length header can be absent (chunked
// transfer) or untrue, so the limit is enforced on the bytes actually read: the stream is
// cancelled as soon as it passes the limit and nothing more is buffered.

/** The whole body, or "too_large" once more than `limit` bytes have arrived. */
export async function readBodyWithin(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | "too_large"> {
  if (!body) return new Uint8Array(new ArrayBuffer(0));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
