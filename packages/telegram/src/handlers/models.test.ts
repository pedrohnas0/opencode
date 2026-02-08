import { describe, test, expect, beforeEach, mock } from "bun:test"
import { SessionManager } from "../session-manager"
import {
  parseModelCallback,
  formatProviderList,
  formatModelList,
  formatCurrentModel,
  handleModel,
  handleModelSelect,
} from "./models"

// --- parseModelCallback ---

describe("parseModelCallback", () => {
  test("parses provider callback", () => {
    const result = parseModelCallback("mdl:anthropic")
    expect(result).toEqual({ type: "provider", providerID: "anthropic" })
  })

  test("parses model callback with providerID:modelID", () => {
    const result = parseModelCallback("mdl:anthropic:claude-sonnet-4-5-20250929")
    expect(result).toEqual({
      type: "model",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5-20250929",
    })
  })

  test("parses back callback", () => {
    expect(parseModelCallback("mdl:back")).toEqual({ type: "back" })
  })

  test("parses reset callback", () => {
    expect(parseModelCallback("mdl:reset")).toEqual({ type: "reset" })
  })

  test("returns null for non-mdl prefix", () => {
    expect(parseModelCallback("invalid")).toBeNull()
  })

  test("returns null for empty after prefix", () => {
    expect(parseModelCallback("mdl:")).toBeNull()
  })
})

// --- formatProviderList ---

describe("formatProviderList", () => {
  test("formats 2 providers as inline keyboard rows", () => {
    const providers = [
      { id: "anthropic", name: "Anthropic", models: { m1: {} } },
      { id: "openai", name: "OpenAI", models: { m1: {} } },
    ]
    const result = formatProviderList(providers)
    expect(result.reply_markup.inline_keyboard.length).toBe(2)
    expect(result.reply_markup.inline_keyboard[0][0].text).toBe("Anthropic")
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe("mdl:anthropic")
    expect(result.reply_markup.inline_keyboard[1][0].text).toBe("OpenAI")
  })

  test("returns 'No providers' when list is empty", () => {
    const result = formatProviderList([])
    expect(result.text).toContain("No providers")
    expect(result.reply_markup.inline_keyboard).toEqual([])
  })

  test("filters providers with 0 models", () => {
    const providers = [
      { id: "anthropic", name: "Anthropic", models: { m1: {} } },
      { id: "empty", name: "Empty", models: {} },
    ]
    const result = formatProviderList(providers)
    expect(result.reply_markup.inline_keyboard.length).toBe(1)
    expect(result.reply_markup.inline_keyboard[0][0].text).toBe("Anthropic")
  })
})

// --- formatModelList ---

describe("formatModelList", () => {
  test("formats 3 models as rows + back button", () => {
    const models = [
      { id: "claude-sonnet", name: "Claude Sonnet" },
      { id: "claude-opus", name: "Claude Opus" },
      { id: "claude-haiku", name: "Claude Haiku" },
    ]
    const result = formatModelList("anthropic", "Anthropic", models)
    // 3 model rows + 1 back row
    expect(result.reply_markup.inline_keyboard.length).toBe(4)
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      "mdl:anthropic:claude-sonnet",
    )
    // Last row is back button
    const lastRow = result.reply_markup.inline_keyboard[3]
    expect(lastRow[0].callback_data).toBe("mdl:back")
  })

  test("returns 'No models' with back button when empty", () => {
    const result = formatModelList("anthropic", "Anthropic", [])
    expect(result.text).toContain("No models")
    // Still has back button
    expect(result.reply_markup.inline_keyboard.length).toBe(1)
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe("mdl:back")
  })

  test("callback_data includes providerID and modelID", () => {
    const models = [{ id: "gpt-4o", name: "GPT-4o" }]
    const result = formatModelList("openai", "OpenAI", models)
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe("mdl:openai:gpt-4o")
  })
})

// --- formatCurrentModel ---

describe("formatCurrentModel", () => {
  test("shows provider/model when override set", () => {
    const result = formatCurrentModel({ providerID: "anthropic", modelID: "claude-opus" })
    expect(result).toContain("anthropic")
    expect(result).toContain("claude-opus")
  })

  test("shows default message when no override", () => {
    const result = formatCurrentModel(undefined)
    expect(result).toContain("default")
  })
})

// --- handleModel ---

describe("handleModel", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
  })

  test("fetches providers and returns keyboard", async () => {
    const sdk = {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              { id: "anthropic", name: "Anthropic", models: { m1: { id: "m1", name: "M1" } } },
            ],
          },
        })),
      },
    }
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const result = await handleModel({ sdk: sdk as any, sessionManager: sm, chatKey: "123" })
    expect(result.reply_markup.inline_keyboard.length).toBeGreaterThan(0)
    expect(sdk.provider.list).toHaveBeenCalledTimes(1)
  })

  test("returns 'No providers' when list is empty", async () => {
    const sdk = {
      provider: {
        list: mock(async () => ({ data: { all: [] } })),
      },
    }
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const result = await handleModel({ sdk: sdk as any, sessionManager: sm, chatKey: "123" })
    expect(result.text).toContain("No providers")
  })
})

// --- handleModelSelect ---

describe("handleModelSelect", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 10, ttlMs: 60000 })
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
  })

  test("stores override in sessionManager", async () => {
    const result = await handleModelSelect({
      chatKey: "123",
      providerID: "anthropic",
      modelID: "claude-opus",
      sessionManager: sm,
    })
    expect(sm.get("123")?.modelOverride).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus",
    })
    expect(result).toContain("anthropic")
    expect(result).toContain("claude-opus")
  })

  test("returns error when no active session", async () => {
    const result = await handleModelSelect({
      chatKey: "999",
      providerID: "anthropic",
      modelID: "claude-opus",
      sessionManager: sm,
    })
    expect(result).toContain("No active session")
  })
})
