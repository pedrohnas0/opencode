import { describe, test, expect, beforeEach, mock } from "bun:test"
import { EventBus, type EventHandler } from "./event-bus"
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

    expect(received.length).toBe(0)
  })

  test("calls onEvent with sessionId, chatKey, and event", async () => {
    sm.set("chat:42", { sessionId: "s42", directory: "/tmp" })

    const onEvent = mock((_sid: string, _ck: string, _ev: any) => {})
    const sdk = createMockSdk([makeIdleEvent("s42")])
    const bus = new EventBus({ sdk: sdk as any, sessionManager: sm, onEvent })
    await bus.start()

    await new Promise((r) => setTimeout(r, 50))

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
