import { describe, test, expect, mock, beforeEach } from "bun:test"
import {
  formatSessionList,
  formatSessionInfo,
  formatHistory,
  parseSessionCallback,
  handleList,
  handleRename,
  handleDelete,
  handleInfo,
  handleHistory,
  handleSummarize,
} from "./sessions"
import { SessionManager } from "../session-manager"

// --- Mock SDK factory ---

function createMockSdk(overrides: {
  list?: any[]
  get?: any
  messages?: any[]
  update?: any
  delete?: any
  summarize?: any
} = {}) {
  return {
    session: {
      list: mock(async () => ({ data: overrides.list ?? [] })),
      get: mock(async () => ({ data: overrides.get ?? {} })),
      messages: mock(async () => ({ data: overrides.messages ?? [] })),
      update: mock(async () => ({ data: overrides.update ?? {} })),
      delete: mock(async () => ({ data: overrides.delete ?? true })),
      summarize: mock(async () => ({ data: overrides.summarize ?? true })),
      create: mock(async () => ({ data: { id: "new", title: "", directory: "/tmp" } })),
    },
  }
}

// --- Helper: make session objects ---

function makeSession(overrides: Partial<{
  id: string
  title: string
  directory: string
  time: { created: number; updated: number; compacting?: number }
  archived: boolean
}> = {}) {
  return {
    id: overrides.id ?? "sess-1",
    title: overrides.title ?? "Test Session",
    directory: overrides.directory ?? "/tmp",
    projectID: "proj-1",
    version: "1",
    time: overrides.time ?? {
      created: 1700000000000,
      updated: 1700001000000,
    },
    ...(overrides.archived ? { time: { ...overrides.time, created: 1700000000000, updated: 1700001000000, archived: 9999 } } : {}),
  }
}

function makeArchivedSession(id: string, title: string) {
  return {
    id,
    title,
    directory: "/tmp",
    projectID: "proj-1",
    version: "1",
    time: {
      created: 1700000000000,
      updated: 1700001000000,
      archived: 9999,
    },
  }
}

// ============================================================
// formatSessionList
// ============================================================

describe("formatSessionList", () => {
  test("formats sessions as inline keyboard rows (title + date)", () => {
    const sessions = [
      makeSession({ id: "s1", title: "My Session", time: { created: 1700000000000, updated: 1700001000000 } }),
    ]
    const result = formatSessionList(sessions)
    expect(result.text).toContain("Select a session")
    expect(result.reply_markup.inline_keyboard).toHaveLength(1)
    const btn = result.reply_markup.inline_keyboard[0][0]
    expect(btn.text).toContain("My Session")
    expect(btn.callback_data).toBe("sess:s1")
  })

  test("filters out archived sessions", () => {
    const sessions = [
      makeSession({ id: "s1", title: "Active" }),
      makeArchivedSession("s2", "Archived"),
    ]
    const result = formatSessionList(sessions)
    expect(result.reply_markup.inline_keyboard).toHaveLength(1)
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe("sess:s1")
  })

  test("sorts by updated desc", () => {
    const sessions = [
      makeSession({ id: "old", title: "Old", time: { created: 1000, updated: 1000 } }),
      makeSession({ id: "new", title: "New", time: { created: 2000, updated: 3000 } }),
    ]
    const result = formatSessionList(sessions)
    // "New" should be first (updated: 3000 > 1000)
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe("sess:new")
    expect(result.reply_markup.inline_keyboard[1][0].callback_data).toBe("sess:old")
  })

  test("limits to 10 sessions", () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      makeSession({ id: `s${i}`, title: `Session ${i}`, time: { created: 1000, updated: 2000 + i } }),
    )
    const result = formatSessionList(sessions)
    expect(result.reply_markup.inline_keyboard).toHaveLength(10)
  })

  test("empty list returns 'No sessions found.' text", () => {
    const result = formatSessionList([])
    expect(result.text).toBe("No sessions found.")
    expect(result.reply_markup.inline_keyboard).toHaveLength(0)
  })
})

// ============================================================
// parseSessionCallback
// ============================================================

describe("parseSessionCallback", () => {
  test("parses 'sess:abc123' correctly", () => {
    const result = parseSessionCallback("sess:abc123")
    expect(result).toEqual({ sessionPrefix: "abc123" })
  })

  test("returns null for non-sess prefix", () => {
    expect(parseSessionCallback("invalid")).toBeNull()
    expect(parseSessionCallback("perm:once:123")).toBeNull()
    expect(parseSessionCallback("q:123:0")).toBeNull()
  })
})

// ============================================================
// handleList
// ============================================================

describe("handleList", () => {
  test("returns formatted session list from SDK", async () => {
    const sdk = createMockSdk({
      list: [
        makeSession({ id: "s1", title: "Session One" }),
        makeSession({ id: "s2", title: "Session Two" }),
      ],
    })
    const result = await handleList({ sdk: sdk as any })
    expect(result.text).toContain("Select a session")
    expect(result.reply_markup.inline_keyboard).toHaveLength(2)
  })

  test("returns 'No sessions found.' when list is empty", async () => {
    const sdk = createMockSdk({ list: [] })
    const result = await handleList({ sdk: sdk as any })
    expect(result.text).toBe("No sessions found.")
  })
})

// ============================================================
// handleRename
// ============================================================

describe("handleRename", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
  })

  test("returns 'No active session.' when no session mapped", async () => {
    const sdk = createMockSdk()
    const result = await handleRename({
      chatKey: "123",
      title: "New Title",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toBe("No active session.")
  })

  test("returns 'Session renamed to: {title}' on success", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = createMockSdk()
    const result = await handleRename({
      chatKey: "123",
      title: "My New Title",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toBe("Session renamed to: My New Title")
  })

  test("calls sdk.session.update with correct params", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = createMockSdk()
    await handleRename({
      chatKey: "123",
      title: "Updated Title",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(sdk.session.update).toHaveBeenCalledTimes(1)
    const call = (sdk.session.update as any).mock.calls[0][0]
    expect(call.sessionID).toBe("s1")
    expect(call.title).toBe("Updated Title")
  })

  test("returns usage message when title is empty", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = createMockSdk()
    const result = await handleRename({
      chatKey: "123",
      title: "",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toBe("Usage: /rename <title>")
  })
})

// ============================================================
// handleDelete
// ============================================================

describe("handleDelete", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
  })

  test("returns 'No active session.' when no session mapped", async () => {
    const sdk = createMockSdk()
    const result = await handleDelete({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toBe("No active session.")
  })

  test("returns 'Session deleted.' on success", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = createMockSdk()
    const result = await handleDelete({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toBe("Session deleted.")
  })

  test("calls sdk.session.delete then sessionManager.remove", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = createMockSdk()
    await handleDelete({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(sdk.session.delete).toHaveBeenCalledTimes(1)
    const call = (sdk.session.delete as any).mock.calls[0][0]
    expect(call.sessionID).toBe("s1")
    // SessionManager mapping should be removed
    expect(sm.get("123")).toBeUndefined()
  })
})

// ============================================================
// handleInfo
// ============================================================

describe("handleInfo", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
  })

  test("returns 'No active session.' when no session mapped", async () => {
    const sdk = createMockSdk()
    const result = await handleInfo({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toBe("No active session.")
  })

  test("returns formatted session info on success", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = createMockSdk({
      get: {
        id: "s1",
        title: "My Session",
        directory: "/home/project",
        time: { created: 1700000000000, updated: 1700001000000 },
      },
    })
    const result = await handleInfo({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toContain("My Session")
  })

  test("includes title, created date, updated date", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = createMockSdk({
      get: {
        id: "s1",
        title: "Test",
        directory: "/home",
        time: { created: 1700000000000, updated: 1700001000000 },
      },
    })
    const result = await handleInfo({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toContain("Test")
    // Should contain some date representation
    expect(result).toMatch(/\d{4}/)  // year somewhere
  })
})

// ============================================================
// formatSessionInfo
// ============================================================

describe("formatSessionInfo", () => {
  test("formats session with title and dates", () => {
    const session = {
      id: "s1",
      title: "My Session",
      directory: "/home/project",
      time: { created: 1700000000000, updated: 1700001000000 },
    }
    const result = formatSessionInfo(session as any)
    expect(result).toContain("My Session")
    expect(result).toContain("/home/project")
  })
})

// ============================================================
// handleHistory
// ============================================================

describe("handleHistory", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
  })

  test("returns 'No active session.' when no session mapped", async () => {
    const sdk = createMockSdk()
    const result = await handleHistory({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toBe("No active session.")
  })

  test("returns formatted message history", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = createMockSdk({
      messages: [
        {
          info: { id: "m1", role: "user", time: { created: 1000 } },
          parts: [{ type: "text", text: "Hello" }],
        },
        {
          info: { id: "m2", role: "assistant", time: { created: 2000 } },
          parts: [{ type: "text", text: "Hi there!" }],
        },
      ],
    })
    const result = await handleHistory({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toContain("Hello")
    expect(result).toContain("Hi there!")
  })

  test("truncates long messages", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const longText = "A".repeat(1000)
    const sdk = createMockSdk({
      messages: [
        {
          info: { id: "m1", role: "user", time: { created: 1000 } },
          parts: [{ type: "text", text: longText }],
        },
      ],
    })
    const result = await handleHistory({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    // Should be truncated — result shorter than original text
    expect(result.length).toBeLessThan(longText.length)
  })

  test("returns 'No messages yet.' when history is empty", async () => {
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = createMockSdk({ messages: [] })
    const result = await handleHistory({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toBe("No messages yet.")
  })
})

// ============================================================
// formatHistory
// ============================================================

describe("formatHistory", () => {
  test("formats messages as role: text", () => {
    const messages = [
      {
        info: { id: "m1", role: "user" as const, time: { created: 1000 } },
        parts: [{ type: "text" as const, text: "Hello" }],
      },
      {
        info: { id: "m2", role: "assistant" as const, time: { created: 2000 } },
        parts: [{ type: "text" as const, text: "World" }],
      },
    ]
    const result = formatHistory(messages)
    expect(result).toContain("user")
    expect(result).toContain("Hello")
    expect(result).toContain("assistant")
    expect(result).toContain("World")
  })
})

// ============================================================
// handleSummarize
// ============================================================

describe("handleSummarize", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
  })

  test("returns 'No active session.' when no session mapped", async () => {
    const sdk = createMockSdk()
    const result = await handleSummarize({
      chatKey: "123",
      sdk: sdk as any,
      sessionManager: sm,
    })
    expect(result).toBe("No active session.")
  })
})
