import { describe, expect, it } from "vitest";
import {
  deriveInviteToken,
  hashInviteToken,
  buildInviteLink,
} from "@core/Tokens/inviteToken.js";

describe("core-tokens", () => {
  it("deriveInviteToken is deterministic per inviteId+secret", () => {
    const a = deriveInviteToken("id-1", "s");
    const b = deriveInviteToken("id-1", "s");
    expect(a).toBe(b);
    expect(a).not.toBe(deriveInviteToken("id-2", "s"));
    expect(a).not.toBe(deriveInviteToken("id-1", "other"));
  });

  it("hashInviteToken is stable sha256 hex", () => {
    const h = hashInviteToken("tok");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken("tok")).toBe(h);
  });

  it("buildInviteLink concatenates base + token", () => {
    expect(buildInviteLink("abc", "https://x/invite/")).toBe(
      "https://x/invite/abc",
    );
  });
});
