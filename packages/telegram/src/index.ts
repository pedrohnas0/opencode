/**
 * Entry point for the OpenCode Telegram Bot.
 *
 * 1. Initializes SDK (spawns server or connects to existing)
 * 2. Creates Grammy bot with all handlers
 * 3. Starts EventBus (single SSE connection)
 * 4. Routes events → formatted Telegram responses
 * 5. Graceful shutdown on SIGINT/SIGTERM
 */

import { loadConfig } from "./config"
import { initSdk } from "./sdk"
import { createBot } from "./bot"
import { SessionManager } from "./session-manager"
import { TurnManager } from "./turn-manager"
import { EventBus } from "./event-bus"
import { PendingRequests } from "./pending-requests"
import { markdownToTelegramHtml } from "./send/format"
import { chunkMessage } from "./send/chunker"
import { formatPermissionMessage } from "./handlers/permissions"
import { formatQuestionMessage } from "./handlers/questions"

const config = loadConfig()

// --- Initialize SDK ---
// If OPENCODE_URL is set, connect to it; otherwise spawn a local server
const externalUrl = process.env.OPENCODE_URL
if (externalUrl) {
  console.log(`Connecting to OpenCode server at ${externalUrl}...`)
} else {
  console.log(`Starting OpenCode server for ${config.projectDirectory}...`)
}
const sdkHandle = await initSdk({
  opencodeUrl: externalUrl,
  projectDirectory: config.projectDirectory,
})
const sdk = sdkHandle.client
console.log(`OpenCode server at ${sdkHandle.url}`)

// --- Create managers ---
const sessionManager = new SessionManager({
  maxEntries: 500,
  ttlMs: 30 * 60 * 1000, // 30 minutes
})

const turnManager = new TurnManager()

const pendingRequests = new PendingRequests({
  maxEntries: 200,
  ttlMs: 10 * 60 * 1000, // 10 minutes
})

// --- Create bot with deps ---
const bot = createBot(config, { sdk, sessionManager, turnManager, pendingRequests })

// --- Response sender (format + chunk + send) ---
async function sendFormattedResponse(chatId: number, markdown: string) {
  const html = markdownToTelegramHtml(markdown)
  const chunks = chunkMessage(html)
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" })
    } catch (err) {
      // HTML parse error → retry as plain text
      if (/can't parse entities/i.test(String(err))) {
        const plainChunks = chunkMessage(markdown)
        for (const plain of plainChunks) {
          await bot.api.sendMessage(chatId, plain)
        }
        return
      }
      throw err
    }
  }
}

// --- EventBus: route SSE events → Telegram ---
const eventBus = new EventBus({
  sdk,
  sessionManager,
  onEvent: (sessionId, chatKey, event) => {
    const chatId = Number(chatKey.split(":")[0])

    switch (event.type) {
      case "message.part.updated": {
        const part = event.properties.part
        if (part.type === "text") {
          // Replace accumulated text (SDK sends full text, not deltas)
          const turn = turnManager.get(sessionId)
          if (turn) {
            turn.accumulatedText = part.text
          }
        }
        break
      }

      case "session.idle": {
        const turn = turnManager.get(sessionId)
        if (turn && turn.accumulatedText) {
          sendFormattedResponse(chatId, turn.accumulatedText).catch((err) => {
            console.error("Error sending response:", err)
          })
        }
        turnManager.end(sessionId)
        break
      }

      case "session.error": {
        const error = event.properties.error
        const msg =
          typeof error === "string"
            ? error
            : error?.data?.message ?? "Unknown error"
        bot.api
          .sendMessage(chatId, `Error: ${msg}`)
          .catch((err) => console.error("Error sending error message:", err))
        turnManager.end(sessionId)
        break
      }

      case "permission.asked": {
        const perm = event.properties
        const { text, reply_markup } = formatPermissionMessage(perm)
        pendingRequests.set(perm.id, {
          type: "permission",
          createdAt: Date.now(),
        })
        bot.api
          .sendMessage(chatId, text, { parse_mode: "HTML", reply_markup })
          .catch((err) =>
            console.error("Error sending permission message:", err),
          )
        break
      }

      case "question.asked": {
        const q = event.properties
        if (q.questions && q.questions.length > 0) {
          pendingRequests.set(q.id, {
            type: "question",
            createdAt: Date.now(),
            questions: q.questions.map((qq: any) => ({
              options: qq.options,
            })),
          })
          const { text, reply_markup } = formatQuestionMessage(q)
          bot.api
            .sendMessage(chatId, text, { reply_markup })
            .catch((err) =>
              console.error("Error sending question message:", err),
            )
        }
        break
      }
    }
  },
})

// --- Start everything ---
await eventBus.start()
console.log("EventBus listening for SSE events")

// Periodic TTL cleanup
const cleanupInterval = setInterval(() => {
  sessionManager.cleanup()
  pendingRequests.cleanup()
}, 5 * 60 * 1000)

// --- Graceful shutdown ---
const shutdown = async () => {
  console.log("Shutting down...")
  clearInterval(cleanupInterval)
  eventBus.stop()
  turnManager.abortAll()
  await bot.stop()
  sdkHandle.cleanup()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// --- Start polling ---
await bot.start({
  onStart: () => console.log("Bot started"),
})
