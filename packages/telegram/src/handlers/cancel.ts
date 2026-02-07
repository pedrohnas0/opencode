/**
 * /cancel command handler — aborts the active generation.
 *
 * Calls sdk.session.abort() and cleans up the TurnManager.
 */

import type { OpencodeClient } from "@opencode-ai/sdk"
import type { SessionManager } from "../session-manager"
import type { TurnManager } from "../turn-manager"

export async function handleCancel(params: {
  chatId: number
  sdk: OpencodeClient
  sessionManager: SessionManager
  turnManager: TurnManager
}): Promise<string> {
  const { chatId, sdk, sessionManager, turnManager } = params
  const chatKey = String(chatId)

  const entry = sessionManager.get(chatKey)
  if (!entry) return "No active session."

  const turn = turnManager.get(entry.sessionId)
  if (!turn) return "Nothing running."

  await sdk.session.abort({ sessionID: entry.sessionId })
  turnManager.end(entry.sessionId)

  return "Generation cancelled."
}
