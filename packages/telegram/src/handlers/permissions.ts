/**
 * Permission event → Telegram inline keyboard message.
 *
 * Pure functions:
 *   - formatPermissionMessage(perm) → { text, reply_markup } for sendMessage
 *   - parsePermissionCallback(data) → { requestID, reply } parsed from callback_data
 */

export type PermissionEvent = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

type InlineKeyboardButton = {
  text: string
  callback_data: string
}

type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][]
}

export function formatPermissionMessage(perm: PermissionEvent): {
  text: string
  reply_markup: InlineKeyboardMarkup
} {
  const description = perm.patterns.length > 0
    ? perm.patterns.join(", ")
    : perm.permission

  const text = `Permission needed: <b>${escapeHtml(perm.permission)}</b>\n<code>${escapeHtml(description)}</code>`

  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✓ Allow", callback_data: `perm:once:${perm.id}` },
          { text: "✓ Always", callback_data: `perm:always:${perm.id}` },
          { text: "✗ Deny", callback_data: `perm:deny:${perm.id}` },
        ],
      ],
    },
  }
}

const VALID_ACTIONS = new Set(["once", "always", "deny"])

const ACTION_TO_REPLY: Record<string, "once" | "always" | "reject"> = {
  once: "once",
  always: "always",
  deny: "reject",
}

export function parsePermissionCallback(
  data: string,
): { requestID: string; reply: "once" | "always" | "reject" } | null {
  if (!data.startsWith("perm:")) return null

  const firstColon = data.indexOf(":")
  const secondColon = data.indexOf(":", firstColon + 1)
  if (secondColon === -1) return null

  const action = data.slice(firstColon + 1, secondColon)
  const requestID = data.slice(secondColon + 1)

  if (!VALID_ACTIONS.has(action) || !requestID) return null

  return { requestID, reply: ACTION_TO_REPLY[action] }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
