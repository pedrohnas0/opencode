export type Config = {
  botToken: string
  opencodeUrl: string
  projectDirectory: string
  testEnv: boolean
  e2e: {
    apiId: number
    apiHash: string
    session: string
    botUsername: string
  }
}

export function loadConfig(): Config {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required")
  }

  return {
    botToken,
    opencodeUrl: process.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    projectDirectory: process.env.OPENCODE_DIRECTORY ?? process.cwd(),
    testEnv: process.env.TELEGRAM_TEST_ENV === "1",
    e2e: {
      apiId: Number(process.env.TELEGRAM_API_ID ?? 0),
      apiHash: process.env.TELEGRAM_API_HASH ?? "",
      session: process.env.TELEGRAM_SESSION ?? "",
      botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "",
    },
  }
}
