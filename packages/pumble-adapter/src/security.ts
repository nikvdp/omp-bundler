import crypto from "node:crypto";
import type http from "node:http";

export function verifyPumbleSignature(
  headers: http.IncomingHttpHeaders,
  rawBody: Buffer,
  signingSecret: string,
  maxAgeSeconds: number,
) {
  if (!signingSecret) {
    return false;
  }

  const timestamp = headerValue(headers["x-pumble-request-timestamp"]);
  const signature = headerValue(headers["x-pumble-request-signature"]);
  if (!timestamp || !signature) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > maxAgeSeconds) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", signingSecret)
    .update(`${timestamp}:${rawBody.toString("utf8")}`)
    .digest("hex");

  return safeEqual(signature, expected);
}

function safeEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
