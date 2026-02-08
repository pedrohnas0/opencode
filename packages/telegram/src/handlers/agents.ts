/**
 * Agent selection handlers — list agents → select → store override.
 *
 * Exports:
 *   - parseAgentCallback(data) — parse "agt:" callback data
 *   - formatAgentList(agents) — inline keyboard of agents
 *   - handleAgent(params) — fetch agents, return keyboard
 *   - handleAgentSelect(params) — store agent override in SessionEntry
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { SessionManager } from "../session-manager"

// --- Pure functions ---

export type AgentCallbackResult =
  | { name: string }
  | { action: "reset" }

export function parseAgentCallback(data: string): AgentCallbackResult | null {
  if (!data.startsWith("agt:")) return null
  const rest = data.slice(4)
  if (!rest) return null

  if (rest === "reset") return { action: "reset" }
  return { name: rest }
}

export function formatAgentList(agents: any[]): {
  text: string
  reply_markup: { inline_keyboard: any[][] }
} {
  const visible = agents.filter((a) => !a.hidden)
  const resetRow = [{ text: "Reset to default", callback_data: "agt:reset" }]

  if (visible.length === 0) {
    return {
      text: "No agents available.",
      reply_markup: { inline_keyboard: [resetRow] },
    }
  }

  const rows = visible.map((a) => [
    { text: a.name, callback_data: `agt:${a.name}` },
  ])

  rows.push(resetRow)

  return {
    text: "Select an agent:",
    reply_markup: { inline_keyboard: rows },
  }
}

// --- Async handlers ---

export async function handleAgent(params: {
  sdk: OpencodeClient
  sessionManager: SessionManager
  chatKey: string
}): Promise<{ text: string; reply_markup: { inline_keyboard: any[][] } }> {
  const { sdk, sessionManager, chatKey } = params
  const result = await sdk.app.agents()
  const agents = (result as any).data ?? []
  const entry = sessionManager.get(chatKey)
  const currentText = entry?.agentOverride
    ? `Current agent: ${entry.agentOverride}`
    : "Using default agent."

  const list = formatAgentList(agents)

  return {
    text: `${currentText}\n\n${list.text}`,
    reply_markup: list.reply_markup,
  }
}

export async function handleAgentSelect(params: {
  chatKey: string
  agentName: string
  sessionManager: SessionManager
}): Promise<string> {
  const { chatKey, agentName, sessionManager } = params
  const entry = sessionManager.get(chatKey)
  if (!entry) return "No active session."

  sessionManager.set(chatKey, {
    ...entry,
    agentOverride: agentName,
  })

  return `Agent set to: ${agentName}`
}
