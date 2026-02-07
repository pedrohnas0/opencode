import { Bot } from "grammy"
import type { Config } from "./config"

export const START_MESSAGE = [
  "OpenCode Telegram Bot",
  "",
  "Send any message to start coding.",
  "/new — New session",
  "/cancel — Stop generation",
].join("\n")

export function createBot(config: Config) {
  const bot = new Bot(config.botToken)

  bot.command("start", async (ctx) => {
    await ctx.reply(START_MESSAGE)
  })

  bot.catch((err) => {
    console.error("Bot error:", err.message)
  })

  return bot
}
