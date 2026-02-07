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

    expect(promptMock).toHaveBeenCalledTimes(1)
    const call = promptMock.mock.calls[0][0]
    expect(call.path.id).toBe("s1")
    expect(call.body.parts[0].type).toBe("text")
    expect(call.body.parts[0].text).toBe("hello world")
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
})
