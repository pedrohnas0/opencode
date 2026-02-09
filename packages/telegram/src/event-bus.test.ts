import { describe, test, expect, beforeEach, mock } from "bun:test"
import { EventBus, computeDelay, DEFAULT_BACKOFF, type EventHandler } from "./event-bus"
import { SessionManager } from "./session-manager"

// Helper: create a mock SSE stream from an array of events
function createMockStream(events: any[]) {
  async function* generate() {
    for (const event of events) {
      yield event
    }
  }
  return { stream: generate() }
}

// Helper: create a mock SDK with controllable event stream
function createMockSdk(events: any[]) {
  return {
    event: {
      subscribe: mock(async () => createMockStream(events)),
    },
  }
}

// Extract sessionId from event (same logic as EventBus)
function makePartEvent(sessionId: string, text: string) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "p1",
        sessionID: sessionId,
        messageID: "m1",
        type: "text",
        text,
      },
    },
  }
}

function makeIdleEvent(sessionId: string) {
  return {
    type: "session.idle",
    properties: { sessionID: sessionId },
  }
}

function makeErrorEvent(sessionId: string) {
  return {
    type: "session.error",
    properties: { sessionID: sessionId, error: "test error" },
  }
}

describe("EventBus", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 100, ttlMs: 60000 })
  })

  test("routes event to correct chatKey via SessionManager", async () => {
    // Setup: map chat:1 → session s1
    sm.set("chat:1", { sessionId: "s1", directory: "/tmp" })

    const received: any[] = []
    const handler: EventHandler = (sessionId, chatKey, event) => {
      received.push({ sessionId, chatKey, type: event.type })
    }

    const sdk = createMockSdk([makePartEvent("s1", "hello")])
    const bus = new EventBus({ sdk: sdk as any, sessionManager: sm, onEvent: handler })
    await bus.start()

    // Wait for stream to be consumed
    await new Promise((r) => setTimeout(r, 50))
    bus.stop()

    expect(received.length).toBe(1)
    expect(received[0].sessionId).toBe("s1")
    expect(received[0].chatKey).toBe("chat:1")
    expect(received[0].type).toBe("message.part.updated")
  })

  test("ignores events for unknown sessionIds", async () => {
    const received: any[] = []
    const handler: EventHandler = (sessionId, chatKey, event) => {
      received.push({ sessionId, chatKey })
    }

    const sdk = createMockSdk([makePartEvent("unknown-session", "hello")])
    const bus = new EventBus({ sdk: sdk as any, sessionManager: sm, onEvent: handler })
    await bus.start()

    await new Promise((r) => setTimeout(r, 50))
    bus.stop()

    expect(received.length).toBe(0)
  })

  test("calls onEvent with sessionId, chatKey, and event", async () => {
    sm.set("chat:42", { sessionId: "s42", directory: "/tmp" })

    const onEvent = mock((_sid: string, _ck: string, _ev: any) => {})
    const sdk = createMockSdk([makeIdleEvent("s42")])
    const bus = new EventBus({ sdk: sdk as any, sessionManager: sm, onEvent })
    await bus.start()

    await new Promise((r) => setTimeout(r, 50))
    bus.stop()

    expect(onEvent).toHaveBeenCalledTimes(1)
    const [sid, ck, ev] = onEvent.mock.calls[0]
    expect(sid).toBe("s42")
    expect(ck).toBe("chat:42")
    expect(ev.type).toBe("session.idle")
  })

  test("handles multiple events for different sessions", async () => {
    sm.set("chat:1", { sessionId: "s1", directory: "/tmp" })
    sm.set("chat:2", { sessionId: "s2", directory: "/tmp" })

    const received: string[] = []
    const handler: EventHandler = (sessionId, chatKey, event) => {
      received.push(`${chatKey}:${event.type}`)
    }

    const sdk = createMockSdk([
      makePartEvent("s1", "hello"),
      makeIdleEvent("s2"),
      makeErrorEvent("s1"),
    ])
    const bus = new EventBus({ sdk: sdk as any, sessionManager: sm, onEvent: handler })
    await bus.start()

    await new Promise((r) => setTimeout(r, 50))
    bus.stop()

    expect(received).toEqual([
      "chat:1:message.part.updated",
      "chat:2:session.idle",
      "chat:1:session.error",
    ])
  })

  test("stop() prevents processing of further events", async () => {
    sm.set("chat:1", { sessionId: "s1", directory: "/tmp" })

    const received: any[] = []
    const handler: EventHandler = (sid, ck, ev) => {
      received.push(ev.type)
    }

    // Create a stream that yields events slowly
    async function* slowStream() {
      yield makePartEvent("s1", "first")
      await new Promise((r) => setTimeout(r, 100))
      yield makePartEvent("s1", "second")
    }

    const sdk = {
      event: {
        subscribe: mock(async () => ({ stream: slowStream() })),
      },
    }

    const bus = new EventBus({ sdk: sdk as any, sessionManager: sm, onEvent: handler })
    await bus.start()

    // Let first event process
    await new Promise((r) => setTimeout(r, 50))
    bus.stop()

    // Wait for slow stream
    await new Promise((r) => setTimeout(r, 200))

    // Should have only the first event
    expect(received.length).toBe(1)
  })
})

describe("EventBus reconnect", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 100, ttlMs: 60000 })
  })

  test("reconnects after stream ends", async () => {
    sm.set("chat:1", { sessionId: "s1", directory: "/tmp" })

    const received: string[] = []
    const handler: EventHandler = (_sid, _ck, event) => {
      received.push(event.type)
    }

    let callCount = 0
    const sdk = {
      event: {
        subscribe: mock(async () => {
          callCount++
          if (callCount === 1) {
            return createMockStream([makePartEvent("s1", "first")])
          }
          if (callCount === 2) {
            return createMockStream([makeIdleEvent("s1")])
          }
          // Third call: block forever (simulates stable connection)
          return {
            stream: (async function* () {
              await new Promise(() => {}) // never resolves
            })(),
          }
        }),
      },
    }

    const bus = new EventBus({
      sdk: sdk as any,
      sessionManager: sm,
      onEvent: handler,
      backoff: { initialDelayMs: 10, maxDelayMs: 100, jitter: 0 },
      _sleep: async () => {
        await new Promise((r) => setTimeout(r, 5))
      },
    })
    await bus.start()

    // Wait for reconnect cycle to reach third subscribe
    await new Promise((r) => setTimeout(r, 200))
    bus.stop()

    expect(received).toContain("message.part.updated")
    expect(received).toContain("session.idle")
    expect(callCount).toBe(3)
  })

  test("does NOT reconnect after stop() is called", async () => {
    let subscribeCalls = 0
    const sdk = {
      event: {
        subscribe: mock(async () => {
          subscribeCalls++
          return createMockStream([])
        }),
      },
    }

    let sleepCalled = false
    const bus = new EventBus({
      sdk: sdk as any,
      sessionManager: sm,
      onEvent: () => {},
      backoff: { initialDelayMs: 50, maxDelayMs: 100, jitter: 0 },
      _sleep: async (ms) => {
        sleepCalled = true
        // Stop during sleep — should cancel reconnect
        bus.stop()
        await new Promise((r) => setTimeout(r, ms))
      },
    })
    await bus.start()

    // Wait for stream to end, sleep to start, and stop to take effect
    await new Promise((r) => setTimeout(r, 200))

    expect(sleepCalled).toBe(true)
    // Only the initial subscribe should have been called (no reconnect after stop)
    expect(subscribeCalls).toBe(1)
  })

  test("backoff delay increases on consecutive failures", async () => {
    const sdk = {
      event: {
        subscribe: mock(async () => {
          throw new Error("connection refused")
        }),
      },
    }

    const sleepCalls: number[] = []
    const bus = new EventBus({
      sdk: sdk as any,
      sessionManager: sm,
      onEvent: () => {},
      backoff: { initialDelayMs: 100, maxDelayMs: 10000, backoffFactor: 2, jitter: 0 },
      _sleep: async (ms) => {
        sleepCalls.push(ms)
        if (sleepCalls.length >= 4) bus.stop()
        await new Promise((r) => setTimeout(r, 5))
      },
    })
    await bus.start()

    await new Promise((r) => setTimeout(r, 200))

    // Each delay should be larger than the previous
    expect(sleepCalls.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < sleepCalls.length; i++) {
      expect(sleepCalls[i]).toBeGreaterThan(sleepCalls[i - 1])
    }
  })

  test("jitter adds randomness to delay", () => {
    const config = { initialDelayMs: 1000, maxDelayMs: 30000, backoffFactor: 1.8, jitter: 0.25 }
    const delays = new Set<number>()
    for (let i = 0; i < 20; i++) {
      delays.add(Math.round(computeDelay(config, 0)))
    }
    // With jitter, we should get multiple different values
    expect(delays.size).toBeGreaterThan(1)
  })

  test("max delay is capped at maxDelayMs", () => {
    const config = { initialDelayMs: 1000, maxDelayMs: 5000, backoffFactor: 10, jitter: 0 }
    // attempt 5 → base would be 1000 * 10^5 = 100_000_000, but capped at 5000
    const delay = computeDelay(config, 5)
    expect(delay).toBe(5000)
  })

  test("reconnects after subscribe() throws an error", async () => {
    let callCount = 0
    const sdk = {
      event: {
        subscribe: mock(async () => {
          callCount++
          if (callCount === 1) throw new Error("network error")
          // Block forever on success (simulates stable connection)
          return {
            stream: (async function* () {
              await new Promise(() => {})
            })(),
          }
        }),
      },
    }

    const bus = new EventBus({
      sdk: sdk as any,
      sessionManager: sm,
      onEvent: () => {},
      backoff: { initialDelayMs: 10, maxDelayMs: 100, jitter: 0 },
      _sleep: async () => {
        await new Promise((r) => setTimeout(r, 5))
      },
    })
    await bus.start()

    await new Promise((r) => setTimeout(r, 200))
    bus.stop()

    // Should have retried after the error
    expect(callCount).toBe(2)
  })

  test("reconnects after stream throws mid-iteration", async () => {
    sm.set("chat:1", { sessionId: "s1", directory: "/tmp" })

    const received: string[] = []
    let callCount = 0
    const sdk = {
      event: {
        subscribe: mock(async () => {
          callCount++
          if (callCount === 1) {
            // Stream that throws after yielding one event
            async function* brokenStream() {
              yield makePartEvent("s1", "before-error")
              throw new Error("stream broke")
            }
            return { stream: brokenStream() }
          }
          // Yields event then blocks forever
          async function* stableStream() {
            yield makeIdleEvent("s1")
            await new Promise(() => {}) // never resolves
          }
          return { stream: stableStream() }
        }),
      },
    }

    const bus = new EventBus({
      sdk: sdk as any,
      sessionManager: sm,
      onEvent: (_sid, _ck, ev) => received.push(ev.type),
      backoff: { initialDelayMs: 10, maxDelayMs: 100, jitter: 0 },
      _sleep: async () => {
        await new Promise((r) => setTimeout(r, 5))
      },
    })
    await bus.start()

    await new Promise((r) => setTimeout(r, 200))
    bus.stop()

    expect(received).toContain("message.part.updated")
    expect(received).toContain("session.idle")
    expect(callCount).toBe(2)
  })

  test("continues processing events after reconnecting", async () => {
    sm.set("chat:1", { sessionId: "s1", directory: "/tmp" })

    const received: string[] = []
    let callCount = 0
    const sdk = {
      event: {
        subscribe: mock(async () => {
          callCount++
          if (callCount === 1) {
            return createMockStream([makePartEvent("s1", "stream1")])
          }
          if (callCount === 2) {
            return createMockStream([
              makePartEvent("s1", "stream2-a"),
              makeIdleEvent("s1"),
            ])
          }
          // Block forever on third call
          return {
            stream: (async function* () {
              await new Promise(() => {})
            })(),
          }
        }),
      },
    }

    const bus = new EventBus({
      sdk: sdk as any,
      sessionManager: sm,
      onEvent: (_sid, _ck, ev) => received.push(ev.type),
      backoff: { initialDelayMs: 10, maxDelayMs: 100, jitter: 0 },
      _sleep: async () => {
        await new Promise((r) => setTimeout(r, 5))
      },
    })
    await bus.start()

    await new Promise((r) => setTimeout(r, 200))
    bus.stop()

    // Events from both streams should be processed
    expect(received.filter((t) => t === "message.part.updated").length).toBe(2)
    expect(received).toContain("session.idle")
  })

  test("stop() during reconnect delay cancels the reconnect", async () => {
    const sdk = {
      event: {
        subscribe: mock(async () => createMockStream([])),
      },
    }

    let sleepStarted = false
    const bus = new EventBus({
      sdk: sdk as any,
      sessionManager: sm,
      onEvent: () => {},
      backoff: { initialDelayMs: 5000, maxDelayMs: 5000, jitter: 0 },
      _sleep: async (ms) => {
        sleepStarted = true
        await new Promise((r) => setTimeout(r, ms))
      },
    })
    await bus.start()

    // Wait for first stream to end and sleep to begin
    await new Promise((r) => setTimeout(r, 50))
    expect(sleepStarted).toBe(true)

    const callsBefore = (sdk.event.subscribe as any).mock.calls.length
    bus.stop()

    // Wait — should NOT reconnect
    await new Promise((r) => setTimeout(r, 200))
    expect((sdk.event.subscribe as any).mock.calls.length).toBe(callsBefore)
  })
})

describe("computeDelay", () => {
  test("returns initialDelayMs for attempt 0 with no jitter", () => {
    const delay = computeDelay({ ...DEFAULT_BACKOFF, jitter: 0 }, 0)
    expect(delay).toBe(DEFAULT_BACKOFF.initialDelayMs)
  })

  test("increases delay with each attempt", () => {
    const config = { initialDelayMs: 100, maxDelayMs: 10000, backoffFactor: 2, jitter: 0 }
    expect(computeDelay(config, 0)).toBe(100)
    expect(computeDelay(config, 1)).toBe(200)
    expect(computeDelay(config, 2)).toBe(400)
    expect(computeDelay(config, 3)).toBe(800)
  })

  test("caps at maxDelayMs", () => {
    const config = { initialDelayMs: 100, maxDelayMs: 300, backoffFactor: 2, jitter: 0 }
    expect(computeDelay(config, 0)).toBe(100)
    expect(computeDelay(config, 1)).toBe(200)
    expect(computeDelay(config, 2)).toBe(300) // would be 400, capped
    expect(computeDelay(config, 10)).toBe(300)
  })

  test("jitter keeps delay within expected range", () => {
    const config = { initialDelayMs: 1000, maxDelayMs: 30000, backoffFactor: 1, jitter: 0.25 }
    for (let i = 0; i < 50; i++) {
      const delay = computeDelay(config, 0)
      expect(delay).toBeGreaterThanOrEqual(750)  // 1000 - 25%
      expect(delay).toBeLessThanOrEqual(1250)     // 1000 + 25%
    }
  })
})
