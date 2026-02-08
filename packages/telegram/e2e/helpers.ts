import type { TelegramClient } from "telegram"
import { Api } from "telegram/tl"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Send a message to the bot and wait for a reply.
 * Polls for new messages from the bot until one arrives after our send time.
 */
export async function sendAndWait(
  client: TelegramClient,
  botUsername: string,
  text: string,
  timeoutMs = 15000,
): Promise<Api.Message> {
  // Get the latest message ID before sending, so we only look for newer messages
  const messagesBefore = await client.getMessages(botUsername, { limit: 1 })
  const lastIdBefore = messagesBefore[0]?.id ?? 0

  await client.sendMessage(botUsername, { message: text })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1500)
    const messages = await client.getMessages(botUsername, { limit: 5 })
    for (const msg of messages) {
      // Bot messages have .out === false (not sent by us)
      // Only consider messages with ID greater than what existed before we sent
      if (!msg.out && msg.id > lastIdBefore) {
        return msg
      }
    }
  }
  throw new Error(`Bot did not reply within ${timeoutMs}ms after sending: "${text}"`)
}

/**
 * Wait for the next bot reply (without sending anything).
 */
export async function waitForBotReply(
  client: TelegramClient,
  botUsername: string,
  timeoutMs = 15000,
): Promise<Api.Message> {
  const before = Math.floor(Date.now() / 1000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(500)
    const messages = await client.getMessages(botUsername, { limit: 5 })
    for (const msg of messages) {
      if (!msg.out && msg.date >= before) {
        return msg
      }
    }
  }
  throw new Error(`Bot did not reply within ${timeoutMs}ms`)
}

/**
 * Click an inline keyboard button by matching its text.
 */
export async function clickInlineButton(
  client: TelegramClient,
  botUsername: string,
  msgId: number,
  buttonText: string,
): Promise<void> {
  const messages = await client.getMessages(botUsername, { ids: [msgId] })
  const msg = messages[0]
  if (!msg?.replyMarkup || !(msg.replyMarkup instanceof Api.ReplyInlineMarkup)) {
    throw new Error("Message has no inline keyboard")
  }

  for (const row of msg.replyMarkup.rows) {
    for (const btn of row.buttons) {
      if (btn.text.includes(buttonText) && btn instanceof Api.KeyboardButtonCallback) {
        await client.invoke(
          new Api.messages.GetBotCallbackAnswer({
            peer: botUsername,
            msgId,
            data: btn.data,
          }),
        )
        return
      }
    }
  }
  throw new Error(`Button "${buttonText}" not found in message ${msgId}`)
}

/**
 * Assert that a message's text contains a string or matches a regex.
 */
export function assertContains(msg: Api.Message, pattern: string | RegExp): void {
  const text = msg.text ?? msg.message ?? ""
  if (typeof pattern === "string") {
    if (!text.includes(pattern)) {
      throw new Error(`Expected "${pattern}" in message, got: "${text.slice(0, 200)}"`)
    }
  } else {
    if (!pattern.test(text)) {
      throw new Error(`Expected ${pattern} to match message, got: "${text.slice(0, 200)}"`)
    }
  }
}

/**
 * Click an inline button, then wait for the message to be edited.
 * Returns the updated message after edit.
 */
export async function clickAndWaitEdit(
  client: TelegramClient,
  botUsername: string,
  msgId: number,
  buttonText: string,
  timeoutMs = 10000,
): Promise<Api.Message> {
  // Capture the message text before clicking
  const before = await client.getMessages(botUsername, { ids: [msgId] })
  const textBefore = before[0]?.text ?? before[0]?.message ?? ""

  await clickInlineButton(client, botUsername, msgId, buttonText)

  // Poll until the message text changes (bot edited it)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1500)
    const messages = await client.getMessages(botUsername, { ids: [msgId] })
    const msg = messages[0]
    const textNow = msg?.text ?? msg?.message ?? ""
    if (textNow !== textBefore) {
      return msg!
    }
  }

  // Return whatever the message is — it may have been edited to same-looking text
  const final = await client.getMessages(botUsername, { ids: [msgId] })
  return final[0]!
}

/**
 * Assert that a message has inline keyboard buttons.
 */
export function assertHasButtons(msg: Api.Message): void {
  if (!msg.replyMarkup || !(msg.replyMarkup instanceof Api.ReplyInlineMarkup)) {
    throw new Error("Expected inline buttons, got none")
  }
  if (msg.replyMarkup.rows.length === 0) {
    throw new Error("Expected inline buttons, got empty keyboard")
  }
}
