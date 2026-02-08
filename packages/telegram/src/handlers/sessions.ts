/**
 * Session command handlers — pure functions + thin async handlers.
 *
 * Exports:
 *   - formatSessionList(sessions) — format sessions as inline keyboard
 *   - formatSessionInfo(session) — format session info text
 *   - formatHistory(messages) — format message history
 *   - parseSessionCallback(data) — parse "sess:" callback data
 *   - handleList(params) — fetch + format session list
 *   - handleRename(params) — rename current session
 *   - handleDelete(params) — delete current session
 *   - handleInfo(params) — show session info
 *   - handleHistory(params) — show recent messages
 *   - handleSummarize(params) — summarize current session
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { SessionManager } from "../session-manager"

// --- Pure formatting functions ---

export function formatSessionList(sessions: any[]): {
  text: string
  reply_markup: { inline_keyboard: any[][] }
} {
  // Filter out archived sessions
  const active = sessions.filter((s) => !s.time?.archived)

  if (active.length === 0) {
    return { text: "No sessions found.", reply_markup: { inline_keyboard: [] } }
  }

  // Sort by updated desc
  const sorted = [...active].sort(
    (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
  )

  // Limit to 10
  const limited = sorted.slice(0, 10)

  const rows = limited.map((s) => {
    const date = new Date(s.time?.updated ?? 0).toLocaleDateString()
    const title = s.title || s.id.slice(0, 8)
    return [
      {
        text: `${title} (${date})`,
        callback_data: `sess:${s.id.slice(0, 20)}`,
      },
    ]
  })

  return {
    text: "Select a session:",
    reply_markup: { inline_keyboard: rows },
  }
}

export function formatSessionInfo(session: any): string {
  const title = session.title || session.id
  const dir = session.directory || "—"
  const created = session.time?.created
    ? new Date(session.time.created).toLocaleString()
    : "—"
  const updated = session.time?.updated
    ? new Date(session.time.updated).toLocaleString()
    : "—"

  return [
    `Session: ${title}`,
    `Directory: ${dir}`,
    `Created: ${created}`,
    `Updated: ${updated}`,
  ].join("\n")
}

export function formatHistory(
  messages: Array<{ info: any; parts: any[] }>,
): string {
  if (messages.length === 0) return "No messages yet."

  // Take last 10 messages
  const recent = messages.slice(-10)

  return recent
    .map((m) => {
      const role = m.info.role ?? "unknown"
      const textParts = m.parts.filter((p: any) => p.type === "text")
      const text = textParts.map((p: any) => p.text).join("") || "(no text)"
      // Truncate long messages
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text
      return `${role}: ${truncated}`
    })
    .join("\n\n")
}

export function parseSessionCallback(
  data: string,
): { sessionPrefix: string } | null {
  if (!data.startsWith("sess:")) return null
  const prefix = data.slice(5)
  if (!prefix) return null
  return { sessionPrefix: prefix }
}

// --- Async handlers ---

export async function handleList(params: {
  sdk: OpencodeClient
}): Promise<{ text: string; reply_markup: { inline_keyboard: any[][] } }> {
  const result = await params.sdk.session.list()
  const sessions = (result as any).data ?? []
  return formatSessionList(sessions)
}

export async function handleRename(params: {
  chatKey: string
  title: string
  sdk: OpencodeClient
  sessionManager: SessionManager
}): Promise<string> {
  const { chatKey, title, sdk, sessionManager } = params

  if (!title.trim()) {
    return "Usage: /rename <title>"
  }

  const entry = sessionManager.get(chatKey)
  if (!entry) return "No active session."

  await sdk.session.update({
    sessionID: entry.sessionId,
    title,
  })

  return `Session renamed to: ${title}`
}

export async function handleDelete(params: {
  chatKey: string
  sdk: OpencodeClient
  sessionManager: SessionManager
}): Promise<string> {
  const { chatKey, sdk, sessionManager } = params
  const entry = sessionManager.get(chatKey)
  if (!entry) return "No active session."

  await sdk.session.delete({
    sessionID: entry.sessionId,
  })
  sessionManager.remove(chatKey)

  return "Session deleted."
}

export async function handleInfo(params: {
  chatKey: string
  sdk: OpencodeClient
  sessionManager: SessionManager
}): Promise<string> {
  const { chatKey, sdk, sessionManager } = params
  const entry = sessionManager.get(chatKey)
  if (!entry) return "No active session."

  const result = await sdk.session.get({
    sessionID: entry.sessionId,
  })
  const session = (result as any).data
  if (!session) return "Session not found."

  return formatSessionInfo(session)
}

export async function handleHistory(params: {
  chatKey: string
  sdk: OpencodeClient
  sessionManager: SessionManager
}): Promise<string> {
  const { chatKey, sdk, sessionManager } = params
  const entry = sessionManager.get(chatKey)
  if (!entry) return "No active session."

  const result = await sdk.session.messages({
    sessionID: entry.sessionId,
  })
  const messages = (result as any).data ?? []

  if (messages.length === 0) return "No messages yet."

  return formatHistory(messages)
}

export async function handleSummarize(params: {
  chatKey: string
  sdk: OpencodeClient
  sessionManager: SessionManager
}): Promise<string> {
  const { chatKey, sessionManager } = params
  const entry = sessionManager.get(chatKey)
  if (!entry) return "No active session."

  return "Use /history to see recent messages, or ask the AI to summarize the conversation."
}
