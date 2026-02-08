import { describe, test, expect, mock, beforeEach } from "bun:test"
import { createBot, START_MESSAGE, type BotDeps } from "./bot"
import { SessionManager } from "./session-manager"
import { TurnManager } from "./turn-manager"
import { PendingRequests } from "./pending-requests"
import type { Config } from "./config"

const testConfig: Config = {
  botToken: "123456:ABC-DEF_test-token",
  opencodeUrl: "http://127.0.0.1:4096",
  projectDirectory: "/tmp/test",
  testEnv: false,
  allowedUsers: [],
  allowAllUsers: true,
  e2e: { apiId: 0, apiHash: "", session: "", botUsername: "" },
}

// --- Phase 0 tests (unchanged) ---

describe("createBot", () => {
  test("returns a Bot instance", () => {
    const bot = createBot(testConfig)
    expect(bot).toBeDefined()
    expect(bot.start).toBeFunction()
    expect(bot.stop).toBeFunction()
  })

  test("bot has error handler", () => {
    const bot = createBot(testConfig)
    expect(bot.errorHandler).toBeDefined()
  })
})

describe("START_MESSAGE", () => {
  test("contains expected text", () => {
    expect(START_MESSAGE).toContain("OpenCode Telegram Bot")
    expect(START_MESSAGE).toContain("/new")
    expect(START_MESSAGE).toContain("/cancel")
  })
})

// --- Phase 1 tests: handleMessage and handleNew ---

describe("handleMessage", () => {
  test("calls sdk.session.prompt with correct parts", async () => {
    const { handleMessage } = await import("./bot")
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    // Pre-populate session
    sm.set("123", { sessionId: "s1", directory: "/tmp" })

    const sdk = {
      session: { prompt: promptMock, create: mock(async () => ({ data: { id: "s1" } })) },
    } as any

    await handleMessage({
      chatId: 123,
      text: "hello world",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    // Prompt is fire-and-forget — wait a microtick for the promise to resolve
    await new Promise((r) => setTimeout(r, 10))

    expect(promptMock).toHaveBeenCalledTimes(1)
    const call = promptMock.mock.calls[0]![0] as any
    expect(call.sessionID).toBe("s1")
    expect(call.parts[0].type).toBe("text")
    expect(call.parts[0].text).toBe("hello world")
  })

  test("creates session automatically for unknown chat", async () => {
    const { handleMessage } = await import("./bot")
    const createMock = mock(async () => ({
      data: { id: "new-s1", directory: "/tmp" },
    }))
    const promptMock = mock(async () => ({ data: {} }))

    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()
    const sdk = {
      session: { create: createMock, prompt: promptMock },
    } as any

    await handleMessage({
      chatId: 999,
      text: "test",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    // Wait for fire-and-forget prompt
    await new Promise((r) => setTimeout(r, 10))

    // Should have created a session
    expect(createMock).toHaveBeenCalledTimes(1)
    // And then prompted it
    expect(promptMock).toHaveBeenCalledTimes(1)
  })

  test("starts a turn and returns it", async () => {
    const { handleMessage } = await import("./bot")
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = {
      session: {
        prompt: mock(async () => ({ data: {} })),
        create: mock(async () => ({ data: { id: "s1" } })),
      },
    } as any

    const result = await handleMessage({
      chatId: 123,
      text: "hello",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    expect(result.turn).toBeDefined()
    expect(result.turn.chatId).toBe(123)
    expect(result.turn.sessionId).toBe("s1")
    expect(tm.get("s1")).toBeDefined()
  })
})

describe("handleNew", () => {
  test("removes old session and creates new one", async () => {
    const { handleNew } = await import("./bot")
    const createMock = mock(async () => ({
      data: { id: "new-session", directory: "/tmp" },
    }))

    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    sm.set("123", { sessionId: "old-session", directory: "/tmp" })

    const sdk = {
      session: { create: createMock },
    } as any

    const result = await handleNew({
      chatId: 123,
      sdk,
      sessionManager: sm,
    })

    // Old session mapping removed, new one created
    expect(sm.get("123")!.sessionId).toBe("new-session")
    expect(sm.getBySessionId("old-session")).toBeUndefined()
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(result.sessionId).toBe("new-session")
  })

  test("creates session for chat without existing session", async () => {
    const { handleNew } = await import("./bot")
    const createMock = mock(async () => ({
      data: { id: "fresh-session", directory: "/tmp" },
    }))

    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const sdk = {
      session: { create: createMock },
    } as any

    const result = await handleNew({
      chatId: 456,
      sdk,
      sessionManager: sm,
    })

    expect(sm.get("456")!.sessionId).toBe("fresh-session")
    expect(result.sessionId).toBe("fresh-session")
  })

  test("preserves model/agent overrides across /new", async () => {
    const { handleNew } = await import("./bot")
    const createMock = mock(async () => ({
      data: { id: "new-session-2", directory: "/tmp" },
    }))

    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    sm.set("123", {
      sessionId: "old-session",
      directory: "/tmp",
      modelOverride: { providerID: "google", modelID: "gemini-flash" },
      agentOverride: "code",
    })

    const sdk = {
      session: { create: createMock },
    } as any

    await handleNew({ chatId: 123, sdk, sessionManager: sm })

    const entry = sm.get("123")!
    expect(entry.sessionId).toBe("new-session-2")
    expect(entry.modelOverride).toEqual({ providerID: "google", modelID: "gemini-flash" })
    expect(entry.agentOverride).toBe("code")
  })
})

describe("handleSessionCallback — override preservation", () => {
  test("preserves model/agent overrides when switching session", async () => {
    const { handleSessionCallback } = await import("./bot")
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    sm.set("123", {
      sessionId: "old-session",
      directory: "/tmp",
      modelOverride: { providerID: "anthropic", modelID: "claude-opus" },
      agentOverride: "build",
    })

    const sdk = {
      session: {
        list: mock(async () => ({
          data: [{ id: "target-session-full", title: "Target", directory: "/proj" }],
        })),
      },
    } as any

    const result = await handleSessionCallback({
      chatKey: "123",
      sessionPrefix: "target-session",
      sdk,
      sessionManager: sm,
    })

    expect(result).toContain("Switched to")
    const entry = sm.get("123")!
    expect(entry.sessionId).toBe("target-session-full")
    expect(entry.modelOverride).toEqual({ providerID: "anthropic", modelID: "claude-opus" })
    expect(entry.agentOverride).toBe("build")
  })
})

// --- Phase 4 tests: handleMessage abort, session commands ---

describe("handleMessage — streaming interruption fix", () => {
  test("calls sdk.session.abort when existing turn present", async () => {
    const { handleMessage } = await import("./bot")
    const abortMock = mock(async () => ({}))
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: abortMock,
      },
    } as any

    // First message — creates a turn
    await handleMessage({
      chatId: 123,
      text: "first message",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    // Second message — should abort old turn
    await handleMessage({
      chatId: 123,
      text: "second message",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(abortMock).toHaveBeenCalledTimes(1)
    const abortCall = abortMock.mock.calls[0]![0] as any
    expect(abortCall.sessionID).toBe("s1")
  })

  test("does NOT call abort when no existing turn", async () => {
    const { handleMessage } = await import("./bot")
    const abortMock = mock(async () => ({}))
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: abortMock,
      },
    } as any

    // First message — no existing turn
    await handleMessage({
      chatId: 123,
      text: "first message",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(abortMock).not.toHaveBeenCalled()
  })
})

describe("handleSessionCallback", () => {
  test("switches session on valid sess: callback", async () => {
    const { handleSessionCallback } = await import("./bot")
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const sdk = {
      session: {
        list: mock(async () => ({
          data: [
            { id: "session-full-id-12345", title: "My Session", directory: "/tmp", time: { created: 1000, updated: 2000 } },
          ],
        })),
      },
    } as any

    const result = await handleSessionCallback({
      chatKey: "123",
      sessionPrefix: "session-full-id-1234",
      sdk,
      sessionManager: sm,
    })

    expect(result).toContain("Switched to")
    expect(result).toContain("My Session")
    expect(sm.get("123")?.sessionId).toBe("session-full-id-12345")
  })

  test("returns 'Session not found.' for unknown prefix", async () => {
    const { handleSessionCallback } = await import("./bot")
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const sdk = {
      session: {
        list: mock(async () => ({ data: [] })),
      },
    } as any

    const result = await handleSessionCallback({
      chatKey: "123",
      sessionPrefix: "nonexistent",
      sdk,
      sessionManager: sm,
    })

    expect(result).toBe("Session not found.")
  })
})

// --- Phase 5: model/agent override passing ---

describe("handleMessage — model/agent overrides", () => {
  test("passes modelOverride to sdk.session.prompt when set", async () => {
    const { handleMessage } = await import("./bot")
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", {
      sessionId: "s1",
      directory: "/tmp",
      modelOverride: { providerID: "anthropic", modelID: "claude-opus" },
    })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: mock(async () => ({})),
      },
    } as any

    await handleMessage({
      chatId: 123,
      text: "hello",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))
    const call = promptMock.mock.calls[0]![0] as any
    expect(call.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" })
  })

  test("passes agentOverride to sdk.session.prompt when set", async () => {
    const { handleMessage } = await import("./bot")
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", {
      sessionId: "s1",
      directory: "/tmp",
      agentOverride: "code",
    })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: mock(async () => ({})),
      },
    } as any

    await handleMessage({
      chatId: 123,
      text: "hello",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))
    const call = promptMock.mock.calls[0]![0] as any
    expect(call.agent).toBe("code")
  })

  test("does NOT pass model/agent when overrides not set", async () => {
    const { handleMessage } = await import("./bot")
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: mock(async () => ({})),
      },
    } as any

    await handleMessage({
      chatId: 123,
      text: "hello",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))
    const call = promptMock.mock.calls[0]![0] as any
    expect(call.model).toBeUndefined()
    expect(call.agent).toBeUndefined()
  })

  test("passes both overrides simultaneously", async () => {
    const { handleMessage } = await import("./bot")
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", {
      sessionId: "s1",
      directory: "/tmp",
      modelOverride: { providerID: "openai", modelID: "gpt-4o" },
      agentOverride: "build",
    })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: mock(async () => ({})),
      },
    } as any

    await handleMessage({
      chatId: 123,
      text: "hello",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))
    const call = promptMock.mock.calls[0]![0] as any
    expect(call.model).toEqual({ providerID: "openai", modelID: "gpt-4o" })
    expect(call.agent).toBe("build")
  })
})

// --- Phase 6: media parts passthrough ---

describe("handleMessage — media parts", () => {
  test("uses explicit parts array when provided", async () => {
    const { handleMessage } = await import("./bot")
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: mock(async () => ({})),
      },
    } as any

    const customParts = [
      { type: "text" as const, text: "What is this?" },
      { type: "file" as const, mime: "image/jpeg", url: "data:image/jpeg;base64,abc", filename: "photo.jpg" },
    ]

    await handleMessage({
      chatId: 123,
      text: "",
      parts: customParts,
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))
    const call = promptMock.mock.calls[0]![0] as any
    expect(call.parts).toHaveLength(2)
    expect(call.parts[0].type).toBe("text")
    expect(call.parts[1].type).toBe("file")
    expect(call.parts[1].mime).toBe("image/jpeg")
  })

  test("without parts builds text part from text param (backward compat)", async () => {
    const { handleMessage } = await import("./bot")
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: mock(async () => ({})),
      },
    } as any

    await handleMessage({
      chatId: 123,
      text: "hello world",
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))
    const call = promptMock.mock.calls[0]![0] as any
    expect(call.parts).toHaveLength(1)
    expect(call.parts[0].type).toBe("text")
    expect(call.parts[0].text).toBe("hello world")
  })

  test("with both text and parts — parts wins", async () => {
    const { handleMessage } = await import("./bot")
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: mock(async () => ({})),
      },
    } as any

    const customParts = [
      { type: "file" as const, mime: "image/png", url: "data:image/png;base64,xyz", filename: "img.png" },
    ]

    await handleMessage({
      chatId: 123,
      text: "this should be ignored",
      parts: customParts,
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))
    const call = promptMock.mock.calls[0]![0] as any
    expect(call.parts).toHaveLength(1)
    expect(call.parts[0].type).toBe("file")
  })

  test("with empty parts array still works", async () => {
    const { handleMessage } = await import("./bot")
    const promptMock = mock(async () => ({ data: {} }))
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const sdk = {
      session: {
        prompt: promptMock,
        create: mock(async () => ({ data: { id: "s1" } })),
        abort: mock(async () => ({})),
      },
    } as any

    await handleMessage({
      chatId: 123,
      text: "fallback text",
      parts: [],
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    await new Promise((r) => setTimeout(r, 10))
    const call = promptMock.mock.calls[0]![0] as any
    // Empty parts array → falls back to text
    expect(call.parts).toHaveLength(1)
    expect(call.parts[0].type).toBe("text")
    expect(call.parts[0].text).toBe("fallback text")
  })
})
