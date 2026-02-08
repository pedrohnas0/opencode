import { describe, test, expect, beforeEach, mock } from "bun:test"
import { TurnManager } from "./turn-manager"

describe("TurnManager", () => {
  let tm: TurnManager

  beforeEach(() => {
    tm = new TurnManager()
  })

  test("start creates a turn with AbortController", () => {
    const turn = tm.start("s1", 12345)
    expect(turn).toBeDefined()
    expect(turn.sessionId).toBe("s1")
    expect(turn.chatId).toBe(12345)
    expect(turn.abortController).toBeDefined()
    expect(turn.abortController.signal.aborted).toBe(false)
  })

  test("get returns active turn", () => {
    tm.start("s1", 12345)
    const turn = tm.get("s1")
    expect(turn).toBeDefined()
    expect(turn!.sessionId).toBe("s1")
  })

  test("get returns undefined for unknown session", () => {
    expect(tm.get("unknown")).toBeUndefined()
  })

  test("end aborts controller and removes entry", () => {
    const turn = tm.start("s1", 12345)
    tm.end("s1")
    expect(turn.abortController.signal.aborted).toBe(true)
    expect(tm.get("s1")).toBeUndefined()
  })

  test("end clears all timers", () => {
    const turn = tm.start("s1", 12345)
    let timerFired = false
    const timer = setTimeout(() => {
      timerFired = true
    }, 50)
    tm.addTimer("s1", timer)
    tm.end("s1")
    // Wait a bit to confirm timer was cleared
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(timerFired).toBe(false)
        resolve()
      }, 100)
    })
  })

  test("addTimer tracks timer in turn", () => {
    tm.start("s1", 12345)
    const timer = setTimeout(() => {}, 1000)
    tm.addTimer("s1", timer)
    // Just verify no throw — internals tracked
    tm.end("s1") // cleans up
  })

  test("addTimer is noop for unknown session", () => {
    const timer = setTimeout(() => {}, 1000)
    // Should not throw
    tm.addTimer("unknown", timer)
    clearTimeout(timer)
  })

  test("abortAll cleans up all active turns", () => {
    const t1 = tm.start("s1", 111)
    const t2 = tm.start("s2", 222)
    tm.abortAll()
    expect(t1.abortController.signal.aborted).toBe(true)
    expect(t2.abortController.signal.aborted).toBe(true)
    expect(tm.get("s1")).toBeUndefined()
    expect(tm.get("s2")).toBeUndefined()
  })

  test("start replaces existing turn for same session", () => {
    const t1 = tm.start("s1", 12345)
    const t2 = tm.start("s1", 12345)
    // Old turn should be aborted
    expect(t1.abortController.signal.aborted).toBe(true)
    // New turn is active
    expect(t2.abortController.signal.aborted).toBe(false)
    expect(tm.get("s1")).toBe(t2)
  })

  test("accumulatedText starts empty and can be set", () => {
    const turn = tm.start("s1", 12345)
    expect(turn.accumulatedText).toBe("")
    turn.accumulatedText = "hello world"
    expect(tm.get("s1")!.accumulatedText).toBe("hello world")
  })

  test("ended turn has no remaining references in manager", () => {
    tm.start("s1", 12345)
    tm.end("s1")
    expect(tm.get("s1")).toBeUndefined()
    expect(tm.size).toBe(0)
  })

  test("size tracks active turn count", () => {
    expect(tm.size).toBe(0)
    tm.start("s1", 111)
    expect(tm.size).toBe(1)
    tm.start("s2", 222)
    expect(tm.size).toBe(2)
    tm.end("s1")
    expect(tm.size).toBe(1)
  })

  // --- Phase 3: draft + toolSuffix fields ---

  test("new turn has toolSuffix='' and draft=null", () => {
    const turn = tm.start("s1", 12345)
    expect(turn.toolSuffix).toBe("")
    expect(turn.draft).toBeNull()
  })

  test("draft can be set on turn and accessed", () => {
    const turn = tm.start("s1", 12345)
    const fakeDraft = { stop: mock(() => {}), getMessageId: () => 42 }
    turn.draft = fakeDraft
    expect(tm.get("s1")!.draft).toBe(fakeDraft)
  })

  test("end calls draft.stop() if draft exists", () => {
    const turn = tm.start("s1", 12345)
    const stopFn = mock(() => {})
    turn.draft = { stop: stopFn, getMessageId: () => 42 }
    tm.end("s1")
    expect(stopFn).toHaveBeenCalledTimes(1)
  })
})
