import { describe, test, expect, mock } from "bun:test"
import { handleCancel } from "./cancel"
import { SessionManager } from "../session-manager"
import { TurnManager } from "../turn-manager"

function createMockSdk() {
  return {
    session: {
      abort: mock(async () => ({ data: true })),
      create: mock(async () => ({ data: { id: "s1", directory: "/tmp" } })),
    },
  } as any
}

describe("handleCancel", () => {
  test("returns 'No active session.' if no session found", async () => {
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()
    const sdk = createMockSdk()

    const result = await handleCancel({
      chatId: 123,
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    expect(result).toBe("No active session.")
    expect(sdk.session.abort).not.toHaveBeenCalled()
  })

  test("returns 'Nothing running.' if no active turn", async () => {
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()
    const sdk = createMockSdk()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })

    const result = await handleCancel({
      chatId: 123,
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    expect(result).toBe("Nothing running.")
    expect(sdk.session.abort).not.toHaveBeenCalled()
  })

  test("calls sdk.session.abort with sessionID", async () => {
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()
    const sdk = createMockSdk()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    tm.start("s1", 123)

    await handleCancel({
      chatId: 123,
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    expect(sdk.session.abort).toHaveBeenCalledTimes(1)
    expect(sdk.session.abort).toHaveBeenCalledWith({ sessionID: "s1" })
  })

  test("calls turnManager.end after abort", async () => {
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()
    const sdk = createMockSdk()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    tm.start("s1", 123)

    await handleCancel({
      chatId: 123,
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    // Turn should be cleaned up
    expect(tm.get("s1")).toBeUndefined()
  })

  test("returns 'Generation cancelled.' on success", async () => {
    const sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    const tm = new TurnManager()
    const sdk = createMockSdk()

    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    tm.start("s1", 123)

    const result = await handleCancel({
      chatId: 123,
      sdk,
      sessionManager: sm,
      turnManager: tm,
    })

    expect(result).toBe("Generation cancelled.")
  })
})
