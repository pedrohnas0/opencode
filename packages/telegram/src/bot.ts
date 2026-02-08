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
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
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
import { DraftStream } from "./send/draft-stream"
import { createAllowlistMiddleware } from "./handlers/allowlist"
import {
  handleList,
  handleRename,
  handleDelete,
  handleInfo,
  handleHistory,
  handleSummarize,
  parseSessionCallback,
} from "./handlers/sessions"
import {
  handleModel,
  handleModelSelect,
  parseModelCallback,
  formatProviderList,
  formatModelList,
} from "./handlers/models"
import {
  handleAgent,
  handleAgentSelect,
  parseAgentCallback,
} from "./handlers/agents"

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

  // Allowlist middleware — must be first (blocks unauthorized users)
  bot.use(createAllowlistMiddleware(config.allowedUsers, config.allowAllUsers))

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

    bot.command("list", async (ctx) => {
      const result = await handleList({ sdk })
      await ctx.reply(result.text, { reply_markup: result.reply_markup })
    })

    bot.command("rename", async (ctx) => {
      const chatKey = String(ctx.chat.id)
      const title = ctx.match?.trim() ?? ""
      const result = await handleRename({ chatKey, title, sdk, sessionManager })
      await ctx.reply(result)
    })

    bot.command("delete", async (ctx) => {
      const chatKey = String(ctx.chat.id)
      const result = await handleDelete({ chatKey, sdk, sessionManager })
      await ctx.reply(result)
    })

    bot.command("info", async (ctx) => {
      const chatKey = String(ctx.chat.id)
      const result = await handleInfo({ chatKey, sdk, sessionManager })
      await ctx.reply(result)
    })

    bot.command("history", async (ctx) => {
      const chatKey = String(ctx.chat.id)
      const result = await handleHistory({ chatKey, sdk, sessionManager })
      await ctx.reply(result)
    })

    bot.command("summarize", async (ctx) => {
      const chatKey = String(ctx.chat.id)
      const result = await handleSummarize({ chatKey, sdk, sessionManager })
      await ctx.reply(result)
    })

    bot.command("model", async (ctx) => {
      const chatKey = String(ctx.chat.id)
      const result = await handleModel({ sdk, sessionManager, chatKey })
      await ctx.reply(result.text, { reply_markup: result.reply_markup })
    })

    bot.command("agent", async (ctx) => {
      const chatKey = String(ctx.chat.id)
      const result = await handleAgent({ sdk, sessionManager, chatKey })
      await ctx.reply(result.text, { reply_markup: result.reply_markup })
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
          reply: parsed.reply as "once" | "always" | "reject",
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

      if (data.startsWith("sess:")) {
        const parsed = parseSessionCallback(data)
        if (!parsed) return
        const chatKey = String(ctx.from.id)
        const result = await handleSessionCallback({
          chatKey,
          sessionPrefix: parsed.sessionPrefix,
          sdk,
          sessionManager,
        })
        await ctx.editMessageText(result)
        return
      }

      if (data.startsWith("mdl:")) {
        const parsed = parseModelCallback(data)
        if (!parsed) return
        const chatKey = String(ctx.from.id)

        if (parsed.type === "reset") {
          const entry = sessionManager.get(chatKey)
          if (entry) {
            sessionManager.set(chatKey, { ...entry, modelOverride: undefined })
          }
          await ctx.editMessageText("Model reset to default.")
          return
        }

        if (parsed.type === "back") {
          const result = await handleModel({ sdk, sessionManager, chatKey })
          await ctx.editMessageText(result.text, { reply_markup: result.reply_markup })
          return
        }

        if (parsed.type === "provider") {
          const provResult = await sdk.provider.list()
          const providers = (provResult as any).data?.all ?? []
          const provider = providers.find((p: any) => p.id === parsed.providerID)
          if (!provider) {
            await ctx.editMessageText("Provider not found.")
            return
          }
          const models = Object.values(provider.models ?? {}) as any[]
          const result = formatModelList(parsed.providerID, provider.name || parsed.providerID, models)
          await ctx.editMessageText(result.text, { reply_markup: result.reply_markup })
          return
        }

        if (parsed.type === "model") {
          const result = await handleModelSelect({
            chatKey,
            providerID: parsed.providerID,
            modelID: parsed.modelID,
            sessionManager,
          })
          await ctx.editMessageText(result)
          return
        }
      }

      if (data.startsWith("agt:")) {
        const parsed = parseAgentCallback(data)
        if (!parsed) return
        const chatKey = String(ctx.from.id)

        if ("action" in parsed && parsed.action === "reset") {
          const entry = sessionManager.get(chatKey)
          if (entry) {
            sessionManager.set(chatKey, { ...entry, agentOverride: undefined })
          }
          await ctx.editMessageText("Agent reset to default.")
          return
        }

        if ("name" in parsed) {
          const result = await handleAgentSelect({
            chatKey,
            agentName: parsed.name,
            sessionManager,
          })
          await ctx.editMessageText(result)
          return
        }
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
        draftDeps: {
          sendMessage: (id, t, o) =>
            bot.api.sendMessage(id, t, o as any),
          editMessageText: (id, m, t, o) =>
            bot.api.editMessageText(id, m, t, o as any),
        },
      })

      startTypingLoop(
        chatId,
        (id, action) => bot.api.sendChatAction(id, action as any),
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
  draftDeps?: import("./send/draft-stream").DraftStreamDeps
}): Promise<{ turn: ActiveTurn }> {
  const { chatId, text, sdk, sessionManager, turnManager, draftDeps } = params
  const chatKey = String(chatId)

  const entry = await sessionManager.getOrCreate(chatKey, sdk)

  // Streaming interruption fix (N2): abort old server-side prompt
  const existingTurn = turnManager.get(entry.sessionId)
  if (existingTurn) {
    sdk.session.abort({ sessionID: entry.sessionId }).catch((err: unknown) => {
      console.error("Abort error:", err)
    })
  }

  const turn = turnManager.start(entry.sessionId, chatId)

  // Attach draft stream BEFORE firing the prompt, so SSE events
  // can update the draft immediately as they arrive.
  if (draftDeps) {
    turn.draft = new DraftStream(draftDeps, chatId, turn.abortController.signal)
  }

  // Fire-and-forget: don't block the Grammy handler.
  // The response comes via SSE events → DraftStream → finalizeResponse.
  sdk.session.prompt({
    sessionID: entry.sessionId,
    parts: [{ type: "text", text }],
    ...(entry.modelOverride && { model: entry.modelOverride }),
    ...(entry.agentOverride && { agent: entry.agentOverride }),
  }).catch((err: unknown) => {
    console.error("Prompt error:", err)
  })

  return { turn }
}

export async function handleSessionCallback(params: {
  chatKey: string
  sessionPrefix: string
  sdk: OpencodeClient
  sessionManager: SessionManager
}): Promise<string> {
  const { chatKey, sessionPrefix, sdk, sessionManager } = params
  const result = await sdk.session.list()
  const sessions = (result as any).data ?? []
  const match = sessions.find((s: any) => s.id.startsWith(sessionPrefix))
  if (!match) return "Session not found."

  sessionManager.set(chatKey, {
    sessionId: match.id,
    directory: match.directory ?? "",
  })
  return `Switched to: ${match.title || match.id}`
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
