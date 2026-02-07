import { describe, test, expect, mock } from "bun:test"
import { startTypingLoop } from "./typing"

describe("startTypingLoop", () => {
  test("calls sendAction immediately on start", () => {
    const sendAction = mock(async () => {})
    const ac = new AbortController()

    startTypingLoop(123, sendAction, ac.signal)
    expect(sendAction).toHaveBeenCalledTimes(1)
    expect(sendAction).toHaveBeenCalledWith(123, "typing")

    ac.abort()
  })

  test("calls sendAction again after ~4 seconds", async () => {
    const sendAction = mock(async () => {})
    const ac = new AbortController()

    startTypingLoop(123, sendAction, ac.signal)
    expect(sendAction).toHaveBeenCalledTimes(1)

    // Wait a bit over 4 seconds for the next tick
    await new Promise((r) => setTimeout(r, 4200))

    expect(sendAction.mock.calls.length).toBeGreaterThanOrEqual(2)
    ac.abort()
  })

  test("stops calling when signal is aborted", async () => {
    const sendAction = mock(async () => {})
    const ac = new AbortController()

    startTypingLoop(123, sendAction, ac.signal)
    expect(sendAction).toHaveBeenCalledTimes(1)

    ac.abort()

    // Wait long enough for another tick to fire (if it weren't aborted)
    await new Promise((r) => setTimeout(r, 4500))

    // Should still be 1 (no more calls after abort)
    expect(sendAction).toHaveBeenCalledTimes(1)
  }, 10000)

  test("does not throw if sendAction rejects", async () => {
    const sendAction = mock(async () => {
      throw new Error("network error")
    })
    const ac = new AbortController()

    // Should not throw
    startTypingLoop(123, sendAction, ac.signal)
    expect(sendAction).toHaveBeenCalledTimes(1)

    // Wait for next tick to confirm no unhandled rejection
    await new Promise((r) => setTimeout(r, 4500))
    ac.abort()
  })
})
