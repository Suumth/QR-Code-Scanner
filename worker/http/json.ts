const MAX_JSON_BYTES = 4 * 1024;

export type JsonReadResult =
  | { value: Record<string, unknown> }
  | { error: "malformed" | "too_large" | "unsupported_media_type" };

export async function readBoundedJsonObject(request: Request): Promise<JsonReadResult> {
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return { error: "unsupported_media_type" };
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number.isInteger(Number(contentLength)) && Number(contentLength) > MAX_JSON_BYTES) {
    return { error: "too_large" };
  }

  const bytes = await readBodyBytes(request.body);
  if (!bytes) {
    return { error: "too_large" };
  }

  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof value === "object" && value !== null ? { value: value as Record<string, unknown> } : { error: "malformed" };
  } catch {
    return { error: "malformed" };
  }
}

async function readBodyBytes(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength > MAX_JSON_BYTES - length) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}
