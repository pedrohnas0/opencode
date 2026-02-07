/**
 * Generate a gramjs StringSession for E2E testing.
 *
 * Usage:
 *   TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abcdef bun run scripts/gen-session.ts
 *
 * This will prompt for your phone number and the code Telegram sends.
 * At the end it prints the session string — copy it to your .env file.
 */
import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions"
import * as readline from "node:readline"

const apiId = Number(process.env.TELEGRAM_API_ID)
const apiHash = process.env.TELEGRAM_API_HASH ?? ""

if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH env vars first.")
  process.exit(1)
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

const session = new StringSession("")
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 3,
})

await client.start({
  phoneNumber: () => prompt("Phone number (with country code, e.g. +5511999999999): "),
  phoneCode: () => prompt("Code from Telegram: "),
  password: () => prompt("2FA password (if enabled, otherwise press Enter): "),
  onError: (err) => console.error("Error:", err),
})

console.log("\n=== Session string (copy this to .env as TELEGRAM_SESSION) ===\n")
console.log(client.session.save())
console.log("\n=== Done ===")

await client.disconnect()
process.exit(0)
