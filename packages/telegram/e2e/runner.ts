import { spawn, type Subprocess } from "bun"
import type { TelegramClient } from "telegram"
import { createTestClient } from "./client"
import { loadConfig } from "../src/config"

let botProcess: Subprocess | null = null
let testClient: TelegramClient | null = null
let botUsername = ""

/**
 * Start the bot as a subprocess and connect the gramjs test client.
 * Must be called in beforeAll().
 */
export async function setup(): Promise<void> {
  const config = loadConfig()

  if (!config.e2e.apiId || !config.e2e.apiHash || !config.e2e.session) {
    throw new Error(
      "E2E tests require TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_SESSION env vars. " +
        "See .env.example for details.",
    )
  }

  if (!config.e2e.botUsername) {
    throw new Error("E2E tests require TELEGRAM_BOT_USERNAME env var.")
  }

  botUsername = config.e2e.botUsername

  // Start bot subprocess
  botProcess = spawn(["bun", "run", "src/index.ts"], {
    cwd: import.meta.dir.replace("/e2e", ""),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })

  // Wait for "Bot started" in stdout
  await waitForReady(botProcess, 15000)

  // Connect gramjs test client
  testClient = await createTestClient({
    apiId: config.e2e.apiId,
    apiHash: config.e2e.apiHash,
    session: config.e2e.session,
  })
}

/**
 * Stop the bot and disconnect the test client.
 * Must be called in afterAll().
 */
export async function teardown(): Promise<void> {
  if (testClient) {
    await testClient.disconnect().catch(() => {})
    testClient = null
  }
  if (botProcess) {
    botProcess.kill()
    botProcess = null
  }
}

export function getClient(): TelegramClient {
  if (!testClient) throw new Error("Test client not initialized. Call setup() first.")
  return testClient
}

export function getBotUsername(): string {
  if (!botUsername) throw new Error("Bot username not set. Call setup() first.")
  return botUsername
}

async function waitForReady(proc: Subprocess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const reader = proc.stdout?.getReader()
  if (!reader) throw new Error("Bot process has no stdout")

  let output = ""
  const decoder = new TextDecoder()

  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 1000),
      ),
    ])

    if (value) {
      output += decoder.decode(value)
      if (output.includes("Bot started")) {
        reader.releaseLock()
        return
      }
    }
    if (done && !output.includes("Bot started")) {
      break
    }
  }

  // Check if process exited
  if (proc.exitCode !== null) {
    throw new Error(`Bot process exited with code ${proc.exitCode}. Output: ${output}`)
  }

  throw new Error(`Bot did not start within ${timeoutMs}ms. Output: ${output}`)
}
