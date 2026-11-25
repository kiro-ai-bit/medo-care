import { describe, expect, it, vi } from "vitest";
import { createDirectoryCache } from "@infrastructure/IdentityClient/directory.js";

const entry = {
  id: "u1",
  displayName: "User One",
  role: "Patient" as const,
  email: "u1@example.com",
};

describe("directory cache", () => {
  it("caches within TTL; invalidate forces refetch; invalidateAll clears", async () => {
    let calls = 0;
    const client = {
      getDirectoryEntry: async () => {
        calls += 1;
        return entry;
      },
    };
    const cache = createDirectoryCache(client);

    await cache.getDirectoryEntry("u1");
    await cache.getDirectoryEntry("u1");
    expect(calls).toBe(1); // second read served from cache

    cache.invalidate("u1");
    await cache.getDirectoryEntry("u1");
    expect(calls).toBe(2); // AccountDeleted invalidation → refetch

    cache.invalidateAll();
    await cache.getDirectoryEntry("u1");
    expect(calls).toBe(3);
  });

  it("entry expires after 60s TTL → refetch", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        getDirectoryEntry: async () => {
          calls += 1;
          return entry;
        },
      };
      const cache = createDirectoryCache(client);
      await cache.getDirectoryEntry("u1");
      vi.setSystemTime(Date.now() + 59_000);
      await cache.getDirectoryEntry("u1");
      expect(calls).toBe(1); // still within TTL
      vi.setSystemTime(Date.now() + 2_000);
      await cache.getDirectoryEntry("u1");
      expect(calls).toBe(2); // TTL elapsed → refetch
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches null results too (negative caching within TTL)", async () => {
    let calls = 0;
    const client = {
      getDirectoryEntry: async () => {
        calls += 1;
        return null;
      },
    };
    const cache = createDirectoryCache(client);
    expect(await cache.getDirectoryEntry("missing")).toBeNull();
    expect(await cache.getDirectoryEntry("missing")).toBeNull();
    expect(calls).toBe(1);
  });
});
