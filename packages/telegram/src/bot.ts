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
import type { TurnManager, ActiveTurn } from "./turn-manager"
import type { PendingRequests } from "./pending-requests"
import { handleCancel } from "./handlers/cancel"
import { parsePermissionCallback } from "./handlers/permissions"
import {
  parseQuestionCallback,
  resolveQuestionAnswer,
} from "./handlers/questions"
import { startTypingLoop } from "./handlers/typing"

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
  pendingRequests: PendingRequests
}

export function createBot(config: Config, deps?: BotDeps) {
  const bot = new Bot(config.botToken)

  bot.command("start", async (ctx) => {
    await ctx.reply(START_MESSAGE)
  })

  if (deps) {
    const { sdk, sessionManager, turnManager, pendingRequests } = deps

    bot.command("new", async (ctx) => {
      const chatId = ctx.chat.id
      await handleNew({ chatId, sdk, sessionManager })
      await ctx.reply("New session started.")
    })

    bot.command("cancel", async (ctx) => {
      const chatId = ctx.chat.id
      const result = await handleCancel({
        chatId,
        sdk,
        sessionManager,
        turnManager,
      })
      await ctx.reply(result)
    })

    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data
      await ctx.answerCallbackQuery()

      if (data.startsWith("perm:")) {
        const parsed = parsePermissionCallback(data)
        if (!parsed) return

        const pending = pendingRequests.get(parsed.requestID)
        if (!pending) {
          await ctx.editMessageText("This request has expired.")
          return
        }
        pendingRequests.delete(parsed.requestID)

        await sdk.permission.reply({
          requestID: parsed.requestID,
          reply: parsed.reply,
        })

        const label =
          parsed.reply === "reject"
            ? "Denied"
            : `Granted (${parsed.reply})`
        await ctx.editMessageText(`Permission ${label}`)
        return
      }

      if (data.startsWith("q:")) {
        const parsed = parseQuestionCallback(data)
        if (!parsed) return

        const pending = pendingRequests.get(parsed.requestID)
        if (!pending) {
          await ctx.editMessageText("This question has expired.")
          return
        }
        pendingRequests.delete(parsed.requestID)

        if (parsed.action === "skip") {
          await sdk.question.reject({ requestID: parsed.requestID })
          await ctx.editMessageText("Question skipped.")
        } else {
          const answer = resolveQuestionAnswer(parsed.optionIndex, pending)
          await sdk.question.reply({
            requestID: parsed.requestID,
            answers: [answer],
          })
          await ctx.editMessageText(`Selected: ${answer.join(", ")}`)
        }
        return
      }
    })

    bot.on("message:text", async (ctx) => {
      const chatId = ctx.chat.id
      const text = ctx.message.text.trim()
      if (!text) return

      const { turn } = await handleMessage({
        chatId,
        text,
        sdk,
        sessionManager,
        turnManager,
      })
      startTypingLoop(
        chatId,
        (id, action) => bot.api.sendChatAction(id, action),
        turn.abortController.signal,
      )
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
}): Promise<{ turn: ActiveTurn }> {
  const { chatId, text, sdk, sessionManager, turnManager } = params
  const chatKey = String(chatId)

  const entry = await sessionManager.getOrCreate(chatKey, sdk)
  const turn = turnManager.start(entry.sessionId, chatId)

  await sdk.session.prompt({
    path: { id: entry.sessionId },
    body: {
      parts: [{ type: "text", text }],
    },
  })

  return { turn }
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
