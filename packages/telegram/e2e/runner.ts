import { spawn, type Subprocess } from "bun"
import type { TelegramClient } from "telegram"
import { createTestClient } from "./client"
import { loadConfig } from "../src/config"
import { resolve } from "node:path"

let serverProcess: Subprocess | null = null
let botProcess: Subprocess | null = null
let testClient: TelegramClient | null = null
let botUsername = ""

/**
 * Start OpenCode server + bot as subprocesses and connect the gramjs test client.
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
  const packageDir = import.meta.dir.replace("/e2e", "")
  const opencodeDir = resolve(packageDir, "../opencode")

  // 1. Start OpenCode server
  serverProcess = spawn(
    [process.execPath, "run", "--conditions=browser", "./src/index.ts", "serve", "--port=0"],
    {
      cwd: opencodeDir,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  const serverUrl = await waitForPattern(
    serverProcess,
    /opencode server listening on (https?:\/\/[^\s]+)/,
    30000,
    "OpenCode server",
  )

  console.log(`E2E: OpenCode server at ${serverUrl}`)

  // 2. Start bot with OPENCODE_URL pointing to our server
  // Use /home/pedro/dev as project dir (has opencode.json with Opus configured)
  const projectDir = process.env.OPENCODE_DIRECTORY ?? resolve(packageDir, "../../..")
  botProcess = spawn([process.execPath, "run", "src/index.ts"], {
    cwd: packageDir,
    env: { ...process.env, OPENCODE_URL: serverUrl, OPENCODE_DIRECTORY: projectDir, TELEGRAM_ALLOWED_USERS: "*" },
    stdout: "pipe",
    stderr: "pipe",
  })

  await waitForPattern(botProcess, /Bot started/, 30000, "Bot")
  console.log("E2E: Bot started")

  // 3. Connect gramjs test client
  testClient = await createTestClient({
    apiId: config.e2e.apiId,
    apiHash: config.e2e.apiHash,
    session: config.e2e.session,
  })
}

/**
 * Stop everything and disconnect the test client.
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
  if (serverProcess) {
    serverProcess.kill()
    serverProcess = null
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

/**
 * Read stdout of a process until a regex pattern matches.
 * Uses `for await` on the ReadableStream — reliable with Bun.spawn.
 * Returns the first capture group if present, otherwise the full match.
 */
async function waitForPattern(
  proc: Subprocess,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<string> {
  if (!proc.stdout) throw new Error(`${label} process has no stdout`)

  let output = ""
  const decoder = new TextDecoder()

  // Race the stream against a timeout
  const result = await Promise.race([
    (async () => {
      for await (const chunk of proc.stdout!) {
        output += decoder.decode(chunk)
        const match = output.match(pattern)
        if (match) {
          return match[1] ?? match[0]
        }
      }
      // Stream ended without match
      return null
    })(),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs),
    ),
  ])

  if (result) return result

  if (proc.exitCode !== null) {
    throw new Error(`${label} exited with code ${proc.exitCode}. Output: ${output}`)
  }

  throw new Error(`${label} did not match "${pattern}" within ${timeoutMs}ms. Output: ${output}`)
}
