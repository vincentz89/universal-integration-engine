import crypto from "node:crypto";

function safeCompare(
  expected: string,
  received: string,
): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    receivedBuffer,
  );
}

export function verifyBigCommerceSignature(
  rawBody: Buffer,
  secret: string,
  webhookId: string,
  timestamp: string,
  signatureHeader: string,
): boolean {
  const timestampNumber = Number(timestamp);

  if (
    !Number.isInteger(timestampNumber) ||
    timestampNumber <= 0
  ) {
    return false;
  }

  const currentTimestamp = Math.floor(Date.now() / 1000);
  const toleranceSeconds = 300;

  if (
    Math.abs(currentTimestamp - timestampNumber) >
    toleranceSeconds
  ) {
    return false;
  }

  const signedPrefix = Buffer.from(
    `${webhookId}.${timestamp}.`,
    "utf8",
  );

  const expectedSignature = crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.concat([signedPrefix, rawBody]))
    .digest("base64");

  const signatures = signatureHeader.split(" ");

  return signatures.some((entry) => {
    const [version, signature] = entry.split(",");

    if (version !== "v1" || !signature) {
      return false;
    }

    return safeCompare(expectedSignature, signature);
  });
}