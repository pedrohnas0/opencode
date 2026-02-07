import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import { sendAndWait, assertContains } from "./helpers"

describe("Phase 0 — Bot Skeleton", () => {
  beforeAll(async () => {
    await setup()
  }, 90000) // 90s: OpenCode server + bot + gramjs startup

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
    // (It may respond via AI or ignore it — either is fine)
    const reply = await sendAndWait(client, getBotUsername(), "/nonexistent_command_xyz", 30000)
    // Bot responded without crashing — that's the test
    expect(reply).toBeDefined()
  }, 45000)
})
