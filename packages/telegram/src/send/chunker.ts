/**
 * Split an HTML message into chunks that fit Telegram's 4096-char limit.
 *
 * Strategy:
 *   1. Try to split at the last newline before the limit
 *   2. If no newline, split at the last space
 *   3. Never split inside an HTML tag (< ... >)
 *   4. As a last resort, split at the limit
 */

const DEFAULT_LIMIT = 4096

export function chunkMessage(html: string, limit = DEFAULT_LIMIT): string[] {
  if (!html) return []
  if (html.length <= limit) return [html]

  const chunks: string[] = []
  let remaining = html

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    let splitAt = findSplitPoint(remaining, limit)
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }

  return chunks
}

function findSplitPoint(text: string, limit: number): number {
  // Try newline first (best visual break)
  const lastNewline = text.lastIndexOf("\n", limit)
  if (lastNewline > limit * 0.5) {
    return lastNewline + 1 // include the newline in the current chunk
  }

  // Try space
  const lastSpace = text.lastIndexOf(" ", limit)
  if (lastSpace > limit * 0.5) {
    return lastSpace + 1
  }

  // Ensure we don't split inside an HTML tag
  let splitAt = limit
  const tagStart = text.lastIndexOf("<", splitAt)
  if (tagStart !== -1) {
    const tagEnd = text.indexOf(">", tagStart)
    if (tagEnd === -1 || tagEnd >= splitAt) {
      // We'd be splitting inside a tag — move split before the tag
      splitAt = tagStart
    }
  }

  return splitAt
}
