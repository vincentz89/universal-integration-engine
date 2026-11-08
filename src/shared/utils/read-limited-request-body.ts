import type { IncomingMessage } from "node:http";

export const MAX_WEBHOOK_BODY_BYTES = 1_048_576; // 1 MiB

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the maximum allowed size.");
    this.name = "PayloadTooLargeError";
  }
}

export async function readLimitedRequestBody(
  req: IncomingMessage,
  maxBytes = MAX_WEBHOOK_BODY_BYTES,
): Promise<Buffer> {
  const contentLength = req.headers["content-length"];

  if (
    typeof contentLength === "string" &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    req.pause();
    throw new PayloadTooLargeError();
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = (preserveErrorListener = false) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);

      if (!preserveErrorListener) {
        req.off("error", onError);
      }
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;

      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

      totalBytes += buffer.length;

      if (totalBytes > maxBytes) {
        settled = true;
        req.pause();
        cleanup(true);
        reject(new PayloadTooLargeError());
        return;
      }

      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) return;

      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    };

    const onError = (error: Error) => {
      if (settled) return;

      settled = true;
      cleanup();
      reject(error);
    };

    const onAborted = () => {
      if (settled) return;

      settled = true;
      cleanup();
      reject(new Error("Request was aborted."));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);

    req.resume();
  });
}