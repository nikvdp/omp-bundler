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

  // Pumble sends X-Pumble-Request-Timestamp in MILLISECONDS (13 digits).
  // Comparing that against epoch seconds put every request ~1.8e12 outside the
  // tolerance, so each webhook was rejected here before its HMAC was checked
  // and the adapter stayed silent. Accept either unit: 13-digit values are
  // milliseconds, 10-digit values are seconds.
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) {
    return false;
  }
  const timestampSeconds =
    Math.abs(timestampNumber) >= 1e11 ? timestampNumber / 1000 : timestampNumber;

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
