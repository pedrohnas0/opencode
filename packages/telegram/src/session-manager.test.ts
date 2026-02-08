import { describe, test, expect, beforeEach, mock } from "bun:test"
import { SessionManager } from "./session-manager"

// Minimal mock SDK that satisfies what SessionManager needs
function createMockSdk(sessionId: string) {
  return {
    session: {
      create: mock(async () => ({
        data: { id: sessionId, title: "", directory: "/tmp" },
      })),
    },
  }
}

describe("SessionManager", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 3, ttlMs: 1000 })
  })

  test("getOrCreate creates new session on first access", async () => {
    const sdk = createMockSdk("s1")
    const entry = await sm.getOrCreate("chat:1", sdk as any)
    expect(entry.sessionId).toBe("s1")
    expect(sdk.session.create).toHaveBeenCalledTimes(1)
  })

  test("getOrCreate returns cached on second access", async () => {
    const sdk = createMockSdk("s1")
    await sm.getOrCreate("chat:1", sdk as any)
    const entry = await sm.getOrCreate("chat:1", sdk as any)
    expect(entry.sessionId).toBe("s1")
    expect(sdk.session.create).toHaveBeenCalledTimes(1) // not called again
  })

  test("get returns entry by chatKey", async () => {
    const sdk = createMockSdk("s1")
    await sm.getOrCreate("chat:1", sdk as any)
    const entry = sm.get("chat:1")
    expect(entry).toBeDefined()
    expect(entry!.sessionId).toBe("s1")
  })

  test("get returns undefined for unknown chatKey", () => {
    expect(sm.get("unknown")).toBeUndefined()
  })

  test("getBySessionId reverse lookup", async () => {
    const sdk = createMockSdk("s1")
    await sm.getOrCreate("chat:1", sdk as any)
    const result = sm.getBySessionId("s1")
    expect(result).toBeDefined()
    expect(result!.chatKey).toBe("chat:1")
    expect(result!.entry.sessionId).toBe("s1")
  })

  test("getBySessionId returns undefined for unknown session", () => {
    expect(sm.getBySessionId("unknown")).toBeUndefined()
  })

  test("remove clears both maps", async () => {
    const sdk = createMockSdk("s1")
    await sm.getOrCreate("chat:1", sdk as any)
    sm.remove("chat:1")
    expect(sm.get("chat:1")).toBeUndefined()
    expect(sm.getBySessionId("s1")).toBeUndefined()
  })

  test("evicts oldest when maxEntries exceeded", async () => {
    for (let i = 1; i <= 4; i++) {
      await sm.getOrCreate(`chat:${i}`, createMockSdk(`s${i}`) as any)
    }
    // chat:1 should be evicted (oldest, max is 3)
    expect(sm.get("chat:1")).toBeUndefined()
    expect(sm.getBySessionId("s1")).toBeUndefined()
    // chat:4 should exist
    expect(sm.get("chat:4")).toBeDefined()
    expect(sm.get("chat:4")!.sessionId).toBe("s4")
  })

  test("getOrCreate refreshes access order (LRU)", async () => {
    // Fill to capacity: 1, 2, 3
    for (let i = 1; i <= 3; i++) {
      await sm.getOrCreate(`chat:${i}`, createMockSdk(`s${i}`) as any)
    }
    // Access chat:1 again (refreshes it)
    await sm.getOrCreate("chat:1", createMockSdk("s1-new") as any)
    // Add chat:4 — should evict chat:2 (oldest unreferenced), not chat:1
    await sm.getOrCreate("chat:4", createMockSdk("s4") as any)
    expect(sm.get("chat:1")).toBeDefined()
    expect(sm.get("chat:2")).toBeUndefined() // evicted
    expect(sm.get("chat:4")).toBeDefined()
  })

  test("expired entries cleaned up by TTL", async () => {
    await sm.getOrCreate("chat:1", createMockSdk("s1") as any)
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1100))
    sm.cleanup()
    expect(sm.get("chat:1")).toBeUndefined()
    expect(sm.getBySessionId("s1")).toBeUndefined()
  })

  test("set allows manual session binding", () => {
    sm.set("chat:1", { sessionId: "manual-1", directory: "/tmp" })
    const entry = sm.get("chat:1")
    expect(entry).toBeDefined()
    expect(entry!.sessionId).toBe("manual-1")
    expect(sm.getBySessionId("manual-1")).toBeDefined()
  })

  test("set overwrites previous binding and cleans reverse map", async () => {
    await sm.getOrCreate("chat:1", createMockSdk("s1") as any)
    sm.set("chat:1", { sessionId: "s2", directory: "/tmp" })
    expect(sm.get("chat:1")!.sessionId).toBe("s2")
    expect(sm.getBySessionId("s1")).toBeUndefined() // old reverse map cleaned
    expect(sm.getBySessionId("s2")).toBeDefined()
  })

  test("size tracks current entry count", async () => {
    expect(sm.size).toBe(0)
    await sm.getOrCreate("chat:1", createMockSdk("s1") as any)
    expect(sm.size).toBe(1)
    await sm.getOrCreate("chat:2", createMockSdk("s2") as any)
    expect(sm.size).toBe(2)
    sm.remove("chat:1")
    expect(sm.size).toBe(1)
  })

  // --- Phase 4: restore() ---

  function createRestoreSdk(sessions: Array<{ id: string; title: string; directory?: string; archived?: number }>) {
    return {
      session: {
        create: mock(async () => ({ data: { id: "new", title: "", directory: "/tmp" } })),
        list: mock(async () => ({
          data: sessions.map((s) => ({
            id: s.id,
            title: s.title,
            directory: s.directory ?? "/tmp",
            time: { created: 1000, updated: 2000, archived: s.archived },
          })),
        })),
      },
    }
  }

  test("restore populates sessions matching 'Telegram {chatId}' pattern", async () => {
    const sdk = createRestoreSdk([
      { id: "s1", title: "Telegram 12345" },
      { id: "s2", title: "Telegram 67890" },
    ])
    const count = await sm.restore(sdk as any)
    expect(count).toBe(2)
    expect(sm.get("12345")?.sessionId).toBe("s1")
    expect(sm.get("67890")?.sessionId).toBe("s2")
  })

  test("restore ignores archived sessions", async () => {
    const sdk = createRestoreSdk([
      { id: "s1", title: "Telegram 12345", archived: 9999 },
    ])
    const count = await sm.restore(sdk as any)
    expect(count).toBe(0)
    expect(sm.get("12345")).toBeUndefined()
  })

  test("restore ignores sessions without matching title pattern", async () => {
    const sdk = createRestoreSdk([
      { id: "s1", title: "My Custom Session" },
      { id: "s2", title: "Telegram chat" },
      { id: "s3", title: "Telegram12345" },
    ])
    const count = await sm.restore(sdk as any)
    expect(count).toBe(0)
  })

  test("restore returns count of restored sessions", async () => {
    const sdk = createRestoreSdk([
      { id: "s1", title: "Telegram 111" },
      { id: "s2", title: "Not matching" },
      { id: "s3", title: "Telegram 333" },
    ])
    const count = await sm.restore(sdk as any)
    expect(count).toBe(2)
  })

  test("restore does not overwrite existing mappings", async () => {
    sm.set("12345", { sessionId: "existing", directory: "/existing" })
    const sdk = createRestoreSdk([
      { id: "s1", title: "Telegram 12345" },
    ])
    const count = await sm.restore(sdk as any)
    expect(count).toBe(0)
    expect(sm.get("12345")?.sessionId).toBe("existing")
  })
})
