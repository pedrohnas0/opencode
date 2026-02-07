import { loadConfig } from "./config"
import { createBot } from "./bot"

const config = loadConfig()
const bot = createBot(config)

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...")
  await bot.stop()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// Start polling
await bot.start({
  onStart: () => console.log("Bot started"),
})
