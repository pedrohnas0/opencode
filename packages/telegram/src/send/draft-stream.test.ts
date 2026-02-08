import { describe, test, expect, mock, beforeEach } from "bun:test"
import { DraftStream, type DraftStreamDeps } from "./draft-stream"

function createMockDeps(): DraftStreamDeps & {
  sendMessage: ReturnType<typeof mock>
  editMessageText: ReturnType<typeof mock>
} {
  return {
    sendMessage: mock(async (_chatId: number, _text: string, _opts?: any) => ({
      message_id: 42,
    })),
    editMessageText: mock(async (_chatId: number, _msgId: number, _text: string, _opts?: any) => {}),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe("DraftStream", () => {
  let deps: ReturnType<typeof createMockDeps>
  let ac: AbortController

  beforeEach(() => {
    deps = createMockDeps()
    ac = new AbortController()
  })

  // --- Initial send ---

  test("first update sends a new message via sendMessage", async () => {
    const ds = new DraftStream(deps, 123, ac.signal)
    await ds.update("hello")
    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    ac.abort()
  })

  test("first update stores messageId from sendMessage response", async () => {
    const ds = new DraftStream(deps, 123, ac.signal)
    expect(ds.getMessageId()).toBeNull()
    await ds.update("hello")
    expect(ds.getMessageId()).toBe(42)
    ac.abort()
  })

  test("first update truncates text to 4096 chars", async () => {
    const ds = new DraftStream(deps, 123, ac.signal)
    const longText = "x".repeat(5000)
    await ds.update(longText)
    // The text sent should be truncated
    const sentText = deps.sendMessage.mock.calls[0][1] as string
    expect(sentText.length).toBeLessThanOrEqual(4096)
    ac.abort()
  })

  test("first update sends with HTML parse_mode", async () => {
    const ds = new DraftStream(deps, 123, ac.signal)
    await ds.update("hello **bold**")
    const opts = deps.sendMessage.mock.calls[0][2]
    expect(opts?.parse_mode).toBe("HTML")
    ac.abort()
  })

  // --- Throttled edits ---

  test("second update schedules an edit (not immediate)", async () => {
    const ds = new DraftStream(deps, 123, ac.signal, 100)
    await ds.update("hello")
    await ds.update("hello world")
    // Edit not called yet (still in throttle window)
    expect(deps.editMessageText).toHaveBeenCalledTimes(0)
    ac.abort()
  })

  test("after throttle delay, editMessageText is called", async () => {
    const ds = new DraftStream(deps, 123, ac.signal, 50)
    await ds.update("hello")
    await ds.update("hello world")
    await sleep(100)
    expect(deps.editMessageText).toHaveBeenCalledTimes(1)
    ac.abort()
  })

  test("multiple rapid updates only result in one edit (latest text wins)", async () => {
    const ds = new DraftStream(deps, 123, ac.signal, 50)
    await ds.update("v1")
    await ds.update("v2")
    await ds.update("v3")
    await ds.update("v4")
    await sleep(100)
    expect(deps.editMessageText).toHaveBeenCalledTimes(1)
    // The edit should contain the latest text (v4), converted to HTML
    const editedText = deps.editMessageText.mock.calls[0][2] as string
    expect(editedText).toContain("v4")
    ac.abort()
  })

  test("edit uses HTML parse_mode", async () => {
    const ds = new DraftStream(deps, 123, ac.signal, 50)
    await ds.update("hello")
    await ds.update("updated")
    await sleep(100)
    const opts = deps.editMessageText.mock.calls[0][3]
    expect(opts?.parse_mode).toBe("HTML")
    ac.abort()
  })

  // --- Error handling ---

  test("message is not modified error is silently ignored", async () => {
    deps.editMessageText = mock(async () => {
      throw new Error("Bad Request: message is not modified")
    })
    const ds = new DraftStream(deps, 123, ac.signal, 50)
    await ds.update("hello")
    await ds.update("hello") // same text but triggers edit
    // Force different pending to trigger edit
    await ds.update("different")
    await sleep(100)
    // Should not throw, stream still active
    expect(ds.isStopped()).toBe(false)
    ac.abort()
  })

  test("can't parse entities falls back to plain text edit", async () => {
    let callCount = 0
    deps.editMessageText = mock(async (_cid: number, _mid: number, _text: string, opts?: any) => {
      callCount++
      if (callCount === 1 && opts?.parse_mode === "HTML") {
        throw new Error("Bad Request: can't parse entities")
      }
    })
    const ds = new DraftStream(deps, 123, ac.signal, 50)
    await ds.update("hello")
    await ds.update("**broken html")
    await sleep(100)
    // Should have retried without parse_mode
    expect(deps.editMessageText.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(ds.hasHtmlFailed()).toBe(true)
    ac.abort()
  })

  test("after HTML failure, subsequent edits use plain text", async () => {
    let callCount = 0
    deps.editMessageText = mock(async (_cid: number, _mid: number, _text: string, opts?: any) => {
      callCount++
      if (callCount === 1 && opts?.parse_mode === "HTML") {
        throw new Error("Bad Request: can't parse entities")
      }
    })
    const ds = new DraftStream(deps, 123, ac.signal, 50)
    await ds.update("hello")
    await ds.update("update1")
    await sleep(100)
    expect(ds.hasHtmlFailed()).toBe(true)

    // Next edit should not use HTML
    await ds.update("update2")
    await sleep(100)
    const lastCall = deps.editMessageText.mock.calls[deps.editMessageText.mock.calls.length - 1]
    const lastOpts = lastCall[3]
    expect(lastOpts?.parse_mode).toBeUndefined()
    ac.abort()
  })

  test("message to edit not found stops the stream", async () => {
    deps.editMessageText = mock(async () => {
      throw new Error("Bad Request: message to edit not found")
    })
    const ds = new DraftStream(deps, 123, ac.signal, 50)
    await ds.update("hello")
    await ds.update("updated")
    await sleep(100)
    expect(ds.isStopped()).toBe(true)
    ac.abort()
  })

  test("sendMessage failure on first update keeps messageId null", async () => {
    deps.sendMessage = mock(async () => {
      throw new Error("network error")
    })
    const ds = new DraftStream(deps, 123, ac.signal)
    await ds.update("hello")
    expect(ds.getMessageId()).toBeNull()
    ac.abort()
  })

  // --- stop() ---

  test("stop clears pending timer", async () => {
    const ds = new DraftStream(deps, 123, ac.signal, 200)
    await ds.update("hello")
    await ds.update("updated")
    ds.stop()
    await sleep(250)
    // Edit should not have fired
    expect(deps.editMessageText).toHaveBeenCalledTimes(0)
  })

  test("after stop, update is a no-op", async () => {
    const ds = new DraftStream(deps, 123, ac.signal)
    ds.stop()
    await ds.update("hello")
    expect(deps.sendMessage).toHaveBeenCalledTimes(0)
  })

  test("stop sets isStopped to true", () => {
    const ds = new DraftStream(deps, 123, ac.signal)
    expect(ds.isStopped()).toBe(false)
    ds.stop()
    expect(ds.isStopped()).toBe(true)
  })

  // --- AbortSignal ---

  test("aborting signal calls stop automatically", async () => {
    const ds = new DraftStream(deps, 123, ac.signal)
    await ds.update("hello")
    expect(ds.isStopped()).toBe(false)
    ac.abort()
    expect(ds.isStopped()).toBe(true)
  })

  test("already-aborted signal stops immediately on construction", () => {
    ac.abort()
    const ds = new DraftStream(deps, 123, ac.signal)
    expect(ds.isStopped()).toBe(true)
  })

  // --- Race condition: concurrent updates before first sendMessage resolves ---

  test("concurrent updates while first sendMessage is in-flight only send once", async () => {
    // Simulate a slow sendMessage (e.g., network latency)
    let resolveFirst: ((v: { message_id: number }) => void) | null = null
    deps.sendMessage = mock(
      () => new Promise<{ message_id: number }>((resolve) => { resolveFirst = resolve }),
    )
    const ds = new DraftStream(deps, 123, ac.signal, 50)

    // Fire multiple concurrent updates — all see messageId === null
    const p1 = ds.update("v1")
    const p2 = ds.update("v2")
    const p3 = ds.update("v3")

    // Only ONE sendMessage call should have been made (the first)
    expect(deps.sendMessage).toHaveBeenCalledTimes(1)

    // Resolve the first sendMessage
    resolveFirst!({ message_id: 42 })
    await p1
    await p2
    await p3

    // Still only one sendMessage call
    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(ds.getMessageId()).toBe(42)

    // The pending text "v3" differs from initial — a flush should be scheduled
    await sleep(100)
    expect(deps.editMessageText).toHaveBeenCalledTimes(1)
    ac.abort()
  })

  test("concurrent updates during send store latest pending text", async () => {
    let resolveFirst: ((v: { message_id: number }) => void) | null = null
    deps.sendMessage = mock(
      () => new Promise<{ message_id: number }>((resolve) => { resolveFirst = resolve }),
    )
    const ds = new DraftStream(deps, 123, ac.signal, 50)

    // Start first update (goes into sending state)
    const p1 = ds.update("first")
    // These arrive while sending — should just update pending
    ds.update("second")
    ds.update("final text")

    resolveFirst!({ message_id: 99 })
    await p1

    // After flush, the edit should contain "final text"
    await sleep(100)
    const editedText = deps.editMessageText.mock.calls[0]?.[2] as string
    expect(editedText).toContain("final text")
    ac.abort()
  })

  test("if sendMessage fails during race, subsequent updates retry send", async () => {
    let callCount = 0
    deps.sendMessage = mock(async () => {
      callCount++
      if (callCount === 1) throw new Error("network error")
      return { message_id: 55 }
    })
    const ds = new DraftStream(deps, 123, ac.signal, 50)

    // First update fails
    await ds.update("attempt1")
    expect(ds.getMessageId()).toBeNull()

    // Second update should retry (sending flag is cleared after failure)
    await ds.update("attempt2")
    expect(ds.getMessageId()).toBe(55)
    ac.abort()
  })
})
