/**
 * Format tool call status for display in the streaming draft.
 *
 * Returns a suffix string to append to the draft message while a tool
 * is running/pending, or null if no suffix is needed (completed/error).
 */
export function formatToolStatus(part: any): string | null {
  if (part.type !== "tool") return null
  if (!part.state) return null

  const tool = part.tool ?? "tool"
  const { status } = part.state

  if (status === "running" && part.state.title) {
    return `\n\n---\n⚙ Running ${tool}: ${part.state.title}`
  }
  if (status === "pending") {
    return `\n\n---\n⚙ Preparing ${tool}...`
  }

  return null
}
