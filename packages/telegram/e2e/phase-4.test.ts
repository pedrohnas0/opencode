import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import { sendAndWait, assertContains, assertHasButtons } from "./helpers"

describe("Phase 4 — Session Management + Hardening", () => {
  beforeAll(async () => {
    await setup()
  }, 90000)

  afterAll(async () => {
    await teardown()
  })

  test(
    "/list shows sessions (with inline keyboard after creating one)",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Ensure at least one session exists by sending a message
      await sendAndWait(client, bot, "Say hello", 60000)

      // Now list sessions
      const reply = await sendAndWait(client, bot, "/list", 15000)
      const text = reply.text ?? reply.message ?? ""
      // Should show session selection or a list
      expect(text.length).toBeGreaterThan(0)
      // Should have inline keyboard buttons
      assertHasButtons(reply)
    },
    120000,
  )

  test(
    "/info shows session details",
    async () => {
      const client = getClient()
      const reply = await sendAndWait(client, getBotUsername(), "/info", 15000)
      const text = reply.text ?? reply.message ?? ""
      // Should contain session info (title, dates, directory)
      assertContains(reply, /session|directory|created/i)
    },
    30000,
  )

  test(
    "/rename changes session title",
    async () => {
      const client = getClient()
      const reply = await sendAndWait(
        client,
        getBotUsername(),
        "/rename E2E Test Session",
        15000,
      )
      assertContains(reply, /renamed/i)
    },
    30000,
  )

  test(
    "regression: text message gets AI response",
    async () => {
      const client = getClient()
      // Start fresh to avoid context from previous tests
      await sendAndWait(client, getBotUsername(), "/new", 30000)

      const reply = await sendAndWait(
        client,
        getBotUsername(),
        "Respond with exactly the single word: hello",
        60000,
      )
      // Bot responded — content varies by model config
      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
    },
    120000,
  )

  test(
    "regression: /new creates fresh session",
    async () => {
      const client = getClient()
      const reply = await sendAndWait(
        client,
        getBotUsername(),
        "/new",
        15000,
      )
      assertContains(reply, /session/i)
    },
    30000,
  )
})
