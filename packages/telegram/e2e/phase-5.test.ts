import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import {
  sendAndWait,
  assertHasButtons,
  assertContains,
  clickInlineButton,
  clickAndWaitEdit,
} from "./helpers"
import { Api } from "telegram/tl"

describe("Phase 5 — Model & Agent Selection", () => {
  beforeAll(async () => {
    await setup()
  }, 90000)

  afterAll(async () => {
    await teardown()
  })

  // --- /model flow ---

  test(
    "/model shows provider buttons",
    async () => {
      const client = getClient()
      const bot = getBotUsername()
      const reply = await sendAndWait(client, bot, "/model", 15000)
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
      assertHasButtons(reply)
    },
    30000,
  )

  test(
    "clicking provider shows model list with Back button",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Send /model to get provider list
      const providerMsg = await sendAndWait(client, bot, "/model", 15000)
      assertHasButtons(providerMsg)

      // Get the first provider button text
      const markup = providerMsg.replyMarkup as Api.ReplyInlineMarkup
      const firstButton = markup.rows[0].buttons[0]
      const providerName = firstButton.text

      // Click the first provider
      const modelMsg = await clickAndWaitEdit(
        client,
        bot,
        providerMsg.id,
        providerName,
      )

      // Should now show model list
      const text = modelMsg.text ?? modelMsg.message ?? ""
      expect(text).toContain("Models for")
      assertHasButtons(modelMsg)

      // Should have a Back button
      const modelMarkup = modelMsg.replyMarkup as Api.ReplyInlineMarkup
      const allButtons = modelMarkup.rows.flatMap((r) => r.buttons)
      const hasBack = allButtons.some((b) => b.text.includes("Back"))
      expect(hasBack).toBe(true)
    },
    30000,
  )

  test(
    "clicking model stores override and shows confirmation",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Send /model → click first provider → click first model
      const providerMsg = await sendAndWait(client, bot, "/model", 15000)
      const provMarkup = providerMsg.replyMarkup as Api.ReplyInlineMarkup
      const provButton = provMarkup.rows[0].buttons[0]

      const modelMsg = await clickAndWaitEdit(
        client,
        bot,
        providerMsg.id,
        provButton.text,
      )

      // Click the first model (not Back)
      const mdlMarkup = modelMsg.replyMarkup as Api.ReplyInlineMarkup
      const modelButton = mdlMarkup.rows[0].buttons[0]
      // Skip if first row is Back button
      const nonBackButton = mdlMarkup.rows
        .flatMap((r) => r.buttons)
        .find((b) => !b.text.includes("Back"))

      expect(nonBackButton).toBeDefined()

      const confirmMsg = await clickAndWaitEdit(
        client,
        bot,
        providerMsg.id,
        nonBackButton!.text,
      )

      const confirmText = confirmMsg.text ?? confirmMsg.message ?? ""
      expect(confirmText).toContain("Model set to")
    },
    30000,
  )

  // --- /agent flow ---

  test(
    "/agent shows agent buttons with Reset",
    async () => {
      const client = getClient()
      const bot = getBotUsername()
      const reply = await sendAndWait(client, bot, "/agent", 15000)
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
      assertHasButtons(reply)

      // Should have Reset button
      const markup = reply.replyMarkup as Api.ReplyInlineMarkup
      const allButtons = markup.rows.flatMap((r) => r.buttons)
      const hasReset = allButtons.some((b) => b.text.includes("Reset"))
      expect(hasReset).toBe(true)
    },
    30000,
  )

  test(
    "clicking agent stores override and shows confirmation",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      const agentMsg = await sendAndWait(client, bot, "/agent", 15000)
      const markup = agentMsg.replyMarkup as Api.ReplyInlineMarkup

      // Click the first non-Reset agent
      const agentButton = markup.rows
        .flatMap((r) => r.buttons)
        .find((b) => !b.text.includes("Reset"))

      expect(agentButton).toBeDefined()

      const confirmMsg = await clickAndWaitEdit(
        client,
        bot,
        agentMsg.id,
        agentButton!.text,
      )

      const confirmText = confirmMsg.text ?? confirmMsg.message ?? ""
      expect(confirmText).toContain("Agent set to")
    },
    30000,
  )

  test(
    "clicking Reset clears agent override",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      const agentMsg = await sendAndWait(client, bot, "/agent", 15000)
      const resetMsg = await clickAndWaitEdit(
        client,
        bot,
        agentMsg.id,
        "Reset",
      )

      const text = resetMsg.text ?? resetMsg.message ?? ""
      expect(text).toContain("reset to default")
    },
    30000,
  )

  // --- model override integration ---

  test(
    "selecting model then sending message gets AI response",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // 1. /new to start fresh
      await sendAndWait(client, bot, "/new", 30000)

      // 2. /model → pick first provider → pick first model
      const providerMsg = await sendAndWait(client, bot, "/model", 15000)
      assertHasButtons(providerMsg)

      const provMarkup = providerMsg.replyMarkup as Api.ReplyInlineMarkup
      const provButton = provMarkup.rows[0].buttons[0]

      const modelMsg = await clickAndWaitEdit(
        client,
        bot,
        providerMsg.id,
        provButton.text,
      )

      const mdlMarkup = modelMsg.replyMarkup as Api.ReplyInlineMarkup
      const nonBackButton = mdlMarkup.rows
        .flatMap((r) => r.buttons)
        .find((b) => !b.text.includes("Back"))

      expect(nonBackButton).toBeDefined()

      const confirmMsg = await clickAndWaitEdit(
        client,
        bot,
        providerMsg.id,
        nonBackButton!.text,
      )
      const confirmText = confirmMsg.text ?? confirmMsg.message ?? ""
      expect(confirmText).toContain("Model set to")

      // 3. Now send a text message — should work with the override
      const reply = await sendAndWait(
        client,
        bot,
        "Respond with exactly the single word: pong",
        90000,
      )
      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
    },
    180000,
  )

  test(
    "model override persists after /new",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Model was set in previous test. Do /new to create fresh session.
      await sendAndWait(client, bot, "/new", 30000)

      // Send a message — should still work with the overridden model
      const reply = await sendAndWait(
        client,
        bot,
        "Respond with exactly the single word: pong",
        90000,
      )
      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)

      // Verify override is still shown in /model
      const modelMsg = await sendAndWait(client, bot, "/model", 15000)
      const modelText = modelMsg.text ?? modelMsg.message ?? ""
      expect(modelText).toContain("Current model:")
    },
    180000,
  )

  // --- regression ---

  test(
    "regression: text message still works after model/agent commands",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Reset model to default first
      const modelMsg = await sendAndWait(client, bot, "/model", 15000)
      assertHasButtons(modelMsg)
      // Look for Reset button — if model was overridden, there should be one
      // (But in E2E the mdl:reset callback is handled)

      await sendAndWait(client, bot, "/new", 30000)

      const reply = await sendAndWait(
        client,
        bot,
        "Respond with exactly the single word: pong",
        60000,
      )
      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
    },
    120000,
  )
})
