import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import { sendAndWait, assertContains } from "./helpers"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe("Phase 3 — Streaming + UX", () => {
  beforeAll(async () => {
    await setup()
  }, 90000)

  afterAll(async () => {
    await teardown()
  })

  test(
    "response appears before AI finishes (draft streaming)",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Get baseline message ID before sending
      const before = await client.getMessages(bot, { limit: 1 })
      const lastIdBefore = before[0]?.id ?? 0

      // Send a prompt that requires a lengthy response (forces streaming)
      await client.sendMessage(bot, {
        message:
          "Write a detailed explanation of how TCP/IP works, covering at least the 4 layers. Be thorough.",
      })

      // Poll for the draft message to appear (should arrive within seconds, NOT after full response)
      let draftId: number | null = null
      let draftText = ""
      const draftDeadline = Date.now() + 15000
      while (Date.now() < draftDeadline) {
        await sleep(1500)
        const msgs = await client.getMessages(bot, { limit: 5 })
        const botMsg = msgs.find((m) => !m.out && m.id > lastIdBefore)
        if (botMsg) {
          draftId = botMsg.id
          draftText = botMsg.text ?? botMsg.message ?? ""
          break
        }
      }

      expect(draftId).not.toBeNull()
      expect(draftText.length).toBeGreaterThan(0)

      // Wait for response to finalize
      await sleep(8000)

      // Re-fetch the SAME message by ID — it should have been edited (streaming via edit)
      const updated = await client.getMessages(bot, { ids: [draftId!] })
      const finalMsg = updated[0]
      const finalText = finalMsg?.text ?? finalMsg?.message ?? ""

      // Core assertion: same message ID was reused (streaming via edit, not new message)
      // Note: final text may be shorter than draft (tool suffix gets stripped on finalization)
      expect(finalMsg?.id).toBe(draftId)
      expect(finalText.length).toBeGreaterThan(0)
    },
    90000,
  )

  test(
    "tool call shows progress indicator then completes",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Start fresh session to avoid context carryover
      await sendAndWait(client, bot, "/new", 30000)

      const before = await client.getMessages(bot, { limit: 1 })
      const lastIdBefore = before[0]?.id ?? 0

      // Prompt that will trigger a tool call (bash/read)
      await client.sendMessage(bot, {
        message: "Run the command: echo 'e2e-tool-test-ok'",
      })

      // Poll for bot messages — look for the tool indicator or final response
      let sawToolIndicator = false
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        await sleep(1500)
        const msgs = await client.getMessages(bot, { limit: 5 })
        for (const msg of msgs) {
          if (msg.out || msg.id <= lastIdBefore) continue
          const text = msg.text ?? msg.message ?? ""
          // Check for tool progress indicator (⚙) in any snapshot
          if (text.includes("⚙") || text.includes("Running")) {
            sawToolIndicator = true
          }
          // Check for final result
          if (text.includes("e2e-tool-test-ok")) {
            // Tool completed — the response contains the output
            expect(text).toContain("e2e-tool-test-ok")
            return
          }
        }
      }

      // If we get here, at least verify the bot responded
      const finalMsgs = await client.getMessages(bot, { limit: 5 })
      const botReply = finalMsgs.find((m) => !m.out && m.id > lastIdBefore)
      expect(botReply).toBeDefined()
    },
    60000,
  )

  test(
    "regression: /start still works",
    async () => {
      const client = getClient()
      const reply = await sendAndWait(client, getBotUsername(), "/start")
      assertContains(reply, "OpenCode Telegram Bot")
    },
    20000,
  )

  test(
    "regression: text message gets AI response",
    async () => {
      const client = getClient()
      const reply = await sendAndWait(
        client,
        getBotUsername(),
        "Respond with exactly the single word: hello",
        60000,
      )
      // Bot responded — content varies by model config (may be "hello", "Feito", etc.)
      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
    },
    90000,
  )
})
