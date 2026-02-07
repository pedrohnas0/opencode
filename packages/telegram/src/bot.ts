/**
 * Grammy bot creation and handler logic.
 *
 * Exports:
 *   - createBot(config, deps?) — creates Grammy Bot with all handlers
 *   - handleMessage(params) — processes a text message (testable standalone)
 *   - handleNew(params) — processes /new command (testable standalone)
 */

import { Bot } from "grammy"
import type { Config } from "./config"
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { SessionManager } from "./session-manager"
import type { TurnManager } from "./turn-manager"

export const START_MESSAGE = [
  "OpenCode Telegram Bot",
  "",
  "Send any message to start coding.",
  "/new — New session",
  "/cancel — Stop generation",
].join("\n")

export type BotDeps = {
  sdk: OpencodeClient
  sessionManager: SessionManager
  turnManager: TurnManager
}

export function createBot(config: Config, deps?: BotDeps) {
  const bot = new Bot(config.botToken)

  bot.command("start", async (ctx) => {
    await ctx.reply(START_MESSAGE)
  })

  if (deps) {
    const { sdk, sessionManager, turnManager } = deps

    bot.command("new", async (ctx) => {
      const chatId = ctx.chat.id
      const result = await handleNew({ chatId, sdk, sessionManager })
      await ctx.reply(`New session started.`)
    })

    bot.on("message:text", async (ctx) => {
      const chatId = ctx.chat.id
      const text = ctx.message.text.trim()
      if (!text) return

      await bot.api.sendChatAction(chatId, "typing")
      await handleMessage({ chatId, text, sdk, sessionManager, turnManager })
    })
  }

  bot.catch((err) => {
    console.error("Bot error:", err.message)
  })

  return bot
}

// --- Testable handler functions ---

export async function handleMessage(params: {
  chatId: number
  text: string
  sdk: OpencodeClient
  sessionManager: SessionManager
  turnManager: TurnManager
}) {
  const { chatId, text, sdk, sessionManager, turnManager } = params
  const chatKey = String(chatId)

  const entry = await sessionManager.getOrCreate(chatKey, sdk)
  turnManager.start(entry.sessionId, chatId)

  await sdk.session.prompt({
    path: { id: entry.sessionId },
    body: {
      parts: [{ type: "text", text }],
    },
  })
}

export async function handleNew(params: {
  chatId: number
  sdk: OpencodeClient
  sessionManager: SessionManager
}) {
  const { chatId, sdk, sessionManager } = params
  const chatKey = String(chatId)

  // Remove existing session mapping (session persists on server)
  sessionManager.remove(chatKey)

  // Create fresh session
  const entry = await sessionManager.getOrCreate(chatKey, sdk)
  return entry
}
