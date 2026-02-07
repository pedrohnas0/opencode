import { describe, test, beforeAll, afterAll, expect } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import { sendAndWait, assertContains } from "./helpers"

describe("Phase 2 — Interactive Controls", () => {
  beforeAll(async () => {
    await setup()
  }, 90000)

  afterAll(async () => {
    await teardown()
  })

  test(
    "/start still works (regression)",
    async () => {
      const client = getClient()
      const reply = await sendAndWait(client, getBotUsername(), "/start")
      assertContains(reply, "OpenCode Telegram Bot")
    },
    20000,
  )

  test(
    "/cancel with no active turn returns 'Nothing running.'",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Fresh session
      await sendAndWait(client, bot, "/new", 30000)

      // Cancel with nothing running
      const reply = await sendAndWait(client, bot, "/cancel", 15000)
      assertContains(reply, /nothing running/i)
    },
    60000,
  )

  test(
    "text message still gets AI response (Phase 2 wiring regression)",
    async () => {
      const client = getClient()
      const reply = await sendAndWait(
        client,
        getBotUsername(),
        "Say exactly the word hello and nothing else",
        60000,
      )
      assertContains(reply, /hello/i)
    },
    90000,
  )
})
