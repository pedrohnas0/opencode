import { describe, test, expect, beforeEach, mock } from "bun:test"
import { SessionManager } from "../session-manager"
import {
  parseModelCallback,
  filterModels,
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

// --- filterModels ---

describe("filterModels", () => {
  test("groups by family, returns most recent per family", () => {
    const models = [
      { id: "opus-4", name: "Opus 4", family: "opus", release_date: "2025-04-01" },
      { id: "opus-4.5", name: "Opus 4.5", family: "opus", release_date: "2025-09-01" },
      { id: "opus-4.6", name: "Opus 4.6", family: "opus", release_date: "2025-12-01" },
      { id: "sonnet-4.5", name: "Sonnet 4.5", family: "sonnet", release_date: "2025-09-01" },
    ]
    const result = filterModels(models)
    expect(result.length).toBe(2)
    expect(result.find((m: any) => m.family === "opus").id).toBe("opus-4.6")
    expect(result.find((m: any) => m.family === "sonnet").id).toBe("sonnet-4.5")
  })

  test("keeps models without family field (uses id as key)", () => {
    const models = [
      { id: "custom-model", name: "Custom" },
      { id: "other-model", name: "Other" },
    ]
    const result = filterModels(models)
    expect(result.length).toBe(2)
  })

  test("handles single model per family (no-op)", () => {
    const models = [
      { id: "sonnet-4.5", name: "Sonnet 4.5", family: "sonnet", release_date: "2025-09-01" },
    ]
    const result = filterModels(models)
    expect(result.length).toBe(1)
    expect(result[0].id).toBe("sonnet-4.5")
  })

  test("sorts result by release_date descending", () => {
    const models = [
      { id: "old", name: "Old", family: "a", release_date: "2024-01-01" },
      { id: "new", name: "New", family: "b", release_date: "2025-12-01" },
      { id: "mid", name: "Mid", family: "c", release_date: "2025-06-01" },
    ]
    const result = filterModels(models)
    expect(result[0].id).toBe("new")
    expect(result[1].id).toBe("mid")
    expect(result[2].id).toBe("old")
  })

  test("handles empty array", () => {
    expect(filterModels([])).toEqual([])
  })
})

// --- formatProviderList ---

describe("formatProviderList", () => {
  test("formats 2 providers as inline keyboard rows with model count", () => {
    const providers = [
      { id: "anthropic", name: "Anthropic", models: { m1: {}, m2: {} } },
      { id: "openai", name: "OpenAI", models: { m1: {} } },
    ]
    const result = formatProviderList(providers)
    expect(result.reply_markup.inline_keyboard.length).toBe(2)
    expect(result.reply_markup.inline_keyboard[0][0].text).toBe("Anthropic (2)")
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe("mdl:anthropic")
    expect(result.reply_markup.inline_keyboard[1][0].text).toBe("OpenAI (1)")
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
    expect(result.reply_markup.inline_keyboard[0][0].text).toContain("Anthropic")
  })

  test("filters to only connected providers when connected array provided", () => {
    const providers = [
      { id: "anthropic", name: "Anthropic", models: { m1: {} } },
      { id: "openai", name: "OpenAI", models: { m1: {} } },
      { id: "google", name: "Google", models: { m1: {} } },
    ]
    const connected = ["anthropic", "google"]
    const result = formatProviderList(providers, connected)
    expect(result.reply_markup.inline_keyboard.length).toBe(2)
    const texts = result.reply_markup.inline_keyboard.map((r: any) => r[0].callback_data)
    expect(texts).toContain("mdl:anthropic")
    expect(texts).toContain("mdl:google")
    expect(texts).not.toContain("mdl:openai")
  })

  test("shows all providers when connected not provided (backward compat)", () => {
    const providers = [
      { id: "a", name: "A", models: { m1: {} } },
      { id: "b", name: "B", models: { m1: {} } },
    ]
    const result = formatProviderList(providers)
    expect(result.reply_markup.inline_keyboard.length).toBe(2)
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

  test("marks active model with ✓ prefix", () => {
    const models = [
      { id: "claude-sonnet", name: "Claude Sonnet" },
      { id: "claude-opus", name: "Claude Opus" },
    ]
    const result = formatModelList("anthropic", "Anthropic", models, "claude-opus")
    expect(result.reply_markup.inline_keyboard[0][0].text).toBe("Claude Sonnet")
    expect(result.reply_markup.inline_keyboard[1][0].text).toBe("✓ Claude Opus")
  })

  test("no ✓ when activeModelID not provided", () => {
    const models = [
      { id: "claude-sonnet", name: "Claude Sonnet" },
      { id: "claude-opus", name: "Claude Opus" },
    ]
    const result = formatModelList("anthropic", "Anthropic", models)
    expect(result.reply_markup.inline_keyboard[0][0].text).toBe("Claude Sonnet")
    expect(result.reply_markup.inline_keyboard[1][0].text).toBe("Claude Opus")
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
            connected: ["anthropic"],
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
        list: mock(async () => ({ data: { all: [], connected: [] } })),
      },
    }
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const result = await handleModel({ sdk: sdk as any, sessionManager: sm, chatKey: "123" })
    expect(result.text).toContain("No providers")
  })

  test("passes connected array to formatProviderList", async () => {
    const sdk = {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              { id: "anthropic", name: "Anthropic", models: { m1: { id: "m1", name: "M1" } } },
              { id: "openai", name: "OpenAI", models: { m1: { id: "m1", name: "M1" } } },
            ],
            connected: ["anthropic"],
          },
        })),
      },
    }
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    const result = await handleModel({ sdk: sdk as any, sessionManager: sm, chatKey: "123" })
    // Only anthropic should be shown (connected)
    expect(result.reply_markup.inline_keyboard.length).toBe(1)
    expect(result.reply_markup.inline_keyboard[0][0].callback_data).toBe("mdl:anthropic")
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
