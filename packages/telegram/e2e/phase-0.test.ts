import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import { sendAndWait, assertContains } from "./helpers"

describe("Phase 0 — Bot Skeleton", () => {
  beforeAll(async () => {
    await setup()
  }, 30000) // 30s timeout for setup

  afterAll(async () => {
    await teardown()
  })

  test("bot responds to /start", async () => {
    const client = getClient()
    const reply = await sendAndWait(client, getBotUsername(), "/start")
    assertContains(reply, "OpenCode Telegram Bot")
    assertContains(reply, "/new")
    assertContains(reply, "/cancel")
  }, 20000)

  test("bot does not crash on unknown command", async () => {
    const client = getClient()
    // Send unknown command — bot should not crash
    await client.sendMessage(getBotUsername(), { message: "/nonexistent_command_xyz" })
    // Wait briefly and verify bot is still responsive
    const reply = await sendAndWait(client, getBotUsername(), "/start")
    assertContains(reply, "OpenCode Telegram Bot")
  }, 20000)
})
