import { describe, test, beforeAll, afterAll } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import { sendAndWait, assertContains } from "./helpers"

describe("Phase 1 — Core Loop", () => {
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
    "/new creates fresh session",
    async () => {
      const client = getClient()
      const reply = await sendAndWait(client, getBotUsername(), "/new", 30000)
      assertContains(reply, /session/i)
    },
    45000,
  )

  test(
    "text message gets AI response",
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
