import { describe, test, expect, beforeEach, mock } from "bun:test"
import { SessionManager } from "../session-manager"
import {
  parseAgentCallback,
  formatAgentList,
  handleAgent,
  handleAgentSelect,
} from "./agents"

// --- parseAgentCallback ---

describe("parseAgentCallback", () => {
  test("parses agent name", () => {
    expect(parseAgentCallback("agt:code")).toEqual({ name: "code" })
  })

  test("parses reset action", () => {
    expect(parseAgentCallback("agt:reset")).toEqual({ action: "reset" })
  })

  test("returns null for non-agt prefix", () => {
    expect(parseAgentCallback("invalid")).toBeNull()
  })

  test("returns null for empty after prefix", () => {
    expect(parseAgentCallback("agt:")).toBeNull()
  })
})

// --- formatAgentList ---

describe("formatAgentList", () => {
  test("formats 2 agents as rows + reset row", () => {
    const agents = [
      { name: "code", description: "Code agent" },
      { name: "build", description: "Build agent" },
    ]
    const result = formatAgentList(agents)
    // 2 agent rows + 1 reset row
    expect(result.reply_markup.inline_keyboard.length).toBe(3)
    expect(result.reply_markup.inline_keyboard[0][0].text).toBe("code")
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe("agt:code")
    const lastRow = result.reply_markup.inline_keyboard[2]
    expect(lastRow[0].callback_data).toBe("agt:reset")
  })

  test("filters hidden agents", () => {
    const agents = [
      { name: "code", hidden: false },
      { name: "secret", hidden: true },
    ]
    const result = formatAgentList(agents)
    // 1 agent row + 1 reset row
    expect(result.reply_markup.inline_keyboard.length).toBe(2)
    expect(result.reply_markup.inline_keyboard[0][0].text).toBe("code")
  })

  test("returns 'No agents' when all hidden or empty", () => {
    const result = formatAgentList([])
    expect(result.text).toContain("No agents")
    // Still has reset row
    expect(result.reply_markup.inline_keyboard.length).toBe(1)
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe("agt:reset")
  })
})

// --- handleAgent ---

describe("handleAgent", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
  })

  test("fetches agents and returns keyboard", async () => {
    const sdk = {
      app: {
        agents: mock(async () => ({
          data: [
            { name: "code", description: "Code agent" },
            { name: "build", description: "Build agent" },
          ],
        })),
      },
    }
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const result = await handleAgent({ sdk: sdk as any, sessionManager: sm, chatKey: "123" })
    expect(result.reply_markup.inline_keyboard.length).toBeGreaterThan(0)
    expect(sdk.app.agents).toHaveBeenCalledTimes(1)
  })
})

// --- handleAgentSelect ---

describe("handleAgentSelect", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
  })

  test("stores override in sessionManager", async () => {
    const result = await handleAgentSelect({
      chatKey: "123",
      agentName: "code",
      sessionManager: sm,
    })
    expect(sm.get("123")?.agentOverride).toBe("code")
    expect(result).toContain("code")
  })

  test("returns error when no active session", async () => {
    const result = await handleAgentSelect({
      chatKey: "999",
      agentName: "code",
      sessionManager: sm,
    })
    expect(result).toContain("No active session")
  })
})
