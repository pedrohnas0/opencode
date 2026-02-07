/**
 * Typing indicator loop — sends "typing" chat action every 4 seconds.
 *
 * Telegram's typing indicator expires after ~5s, so we re-send it
 * at 4s intervals. Tied to an AbortSignal for automatic cleanup
 * when the turn ends.
 */

export function startTypingLoop(
  chatId: number,
  sendAction: (chatId: number, action: string) => Promise<unknown>,
  signal: AbortSignal,
): void {
  const send = () => {
    sendAction(chatId, "typing").catch(() => {})
  }

  const schedule = () => {
    if (signal.aborted) return
    send()
    const timer = setTimeout(schedule, 4000)
    const onAbort = () => clearTimeout(timer)
    signal.addEventListener("abort", onAbort, { once: true })
  }

  schedule()
}
