import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import type { Config } from "./config"

describe("loadConfig", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, originalEnv)
  })

  test("parses required TELEGRAM_BOT_TOKEN", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    const { loadConfig } = await import("./config")
    const config = loadConfig()
    expect(config.botToken).toBe("123:ABC")
  })

  test("throws when TELEGRAM_BOT_TOKEN is missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    // Re-import to get fresh module
    const mod = await import("./config?missing")
    expect(() => mod.loadConfig()).toThrow()
  })

  test("uses default opencodeUrl when not set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    const { loadConfig } = await import("./config?defaults")
    const config = loadConfig()
    expect(config.opencodeUrl).toBe("http://127.0.0.1:4096")
  })

  test("uses custom opencodeUrl when set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    process.env.OPENCODE_URL = "http://localhost:9999"
    const { loadConfig } = await import("./config?custom")
    const config = loadConfig()
    expect(config.opencodeUrl).toBe("http://localhost:9999")
  })

  test("defaults testEnv to false", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    const { loadConfig } = await import("./config?testenv1")
    const config = loadConfig()
    expect(config.testEnv).toBe(false)
  })

  test("sets testEnv to true when TELEGRAM_TEST_ENV=1", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    process.env.TELEGRAM_TEST_ENV = "1"
    const { loadConfig } = await import("./config?testenv2")
    const config = loadConfig()
    expect(config.testEnv).toBe(true)
  })

  test("parses e2e config with defaults", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    delete process.env.TELEGRAM_API_ID
    delete process.env.TELEGRAM_API_HASH
    delete process.env.TELEGRAM_SESSION
    delete process.env.TELEGRAM_BOT_USERNAME
    const { loadConfig } = await import("./config?e2e1")
    const config = loadConfig()
    expect(config.e2e.apiId).toBe(0)
    expect(config.e2e.apiHash).toBe("")
    expect(config.e2e.session).toBe("")
    expect(config.e2e.botUsername).toBe("")
  })

  test("parses e2e config from env", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    process.env.TELEGRAM_API_ID = "12345"
    process.env.TELEGRAM_API_HASH = "abcdef"
    process.env.TELEGRAM_SESSION = "session123"
    process.env.TELEGRAM_BOT_USERNAME = "test_bot"
    const { loadConfig } = await import("./config?e2e2")
    const config = loadConfig()
    expect(config.e2e.apiId).toBe(12345)
    expect(config.e2e.apiHash).toBe("abcdef")
    expect(config.e2e.session).toBe("session123")
    expect(config.e2e.botUsername).toBe("test_bot")
  })

  test("parses TELEGRAM_ALLOWED_USERS as number array", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    process.env.TELEGRAM_ALLOWED_USERS = "111,222,333"
    const { loadConfig } = await import("./config?allow1")
    const config = loadConfig()
    expect(config.allowedUsers).toEqual([111, 222, 333])
  })

  test("defaults allowedUsers to empty array when not set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    delete process.env.TELEGRAM_ALLOWED_USERS
    const { loadConfig } = await import("./config?allow2")
    const config = loadConfig()
    expect(config.allowedUsers).toEqual([])
  })

  test("defaults allowedUsers to empty array when empty string", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    process.env.TELEGRAM_ALLOWED_USERS = ""
    const { loadConfig } = await import("./config?allow3")
    const config = loadConfig()
    expect(config.allowedUsers).toEqual([])
    expect(config.allowAllUsers).toBe(false)
  })

  test("TELEGRAM_ALLOWED_USERS='*' sets allowAllUsers=true", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    process.env.TELEGRAM_ALLOWED_USERS = "*"
    const { loadConfig } = await import("./config?allow4")
    const config = loadConfig()
    expect(config.allowAllUsers).toBe(true)
    expect(config.allowedUsers).toEqual([])
  })

  test("allowAllUsers defaults to false when not set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    delete process.env.TELEGRAM_ALLOWED_USERS
    const { loadConfig } = await import("./config?allow5")
    const config = loadConfig()
    expect(config.allowAllUsers).toBe(false)
  })

  test("apiPort defaults to 4097 when not set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    delete process.env.TELEGRAM_API_PORT
    const { loadConfig } = await import("./config?apiport1")
    const config = loadConfig()
    expect(config.apiPort).toBe(4097)
  })

  test("apiPort reads from TELEGRAM_API_PORT env var", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC"
    process.env.TELEGRAM_API_PORT = "5555"
    const { loadConfig } = await import("./config?apiport2")
    const config = loadConfig()
    expect(config.apiPort).toBe(5555)
  })
})
