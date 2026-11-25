import { createHash, createHmac } from "node:crypto";

// LD-CARE-02: deterministic invite token = base64url(HMAC-SHA256(inviteId, secret))
// — recomputable on resend so the same inviteLink is republished (FR-CAR-015).
export function deriveInviteToken(inviteId: string, secret: string): string {
  return createHmac("sha256", secret).update(inviteId).digest("base64url");
}

// Stored/lookup form — SHA-256 hex of the raw token (raw never persisted).
export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function buildInviteLink(rawToken: string, base: string): string {
  return `${base}${rawToken}`;
}
