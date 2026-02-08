/**
 * Per-turn lifecycle manager.
 *
 * Each turn (user prompt → AI response) gets:
 *   - One AbortController (abort() cleans up all listeners + timers)
 *   - A set of tracked timers (auto-cleared on end)
 *   - Accumulated text from SSE events (for final send on session.idle)
 *
 * Anti-leak: end() or abortAll() guarantees full cleanup.
 */

export type ActiveTurn = {
  sessionId: string
  chatId: number
  abortController: AbortController
  accumulatedText: string
  toolSuffix: string
  timers: Set<ReturnType<typeof setTimeout>>
  draft: { stop(): void; getMessageId(): number | null } | null
}

export class TurnManager {
  private active = new Map<string, ActiveTurn>()

  start(sessionId: string, chatId: number): ActiveTurn {
    // If there's an existing turn, end it first
    const existing = this.active.get(sessionId)
    if (existing) {
      this.endTurn(existing)
    }

    const turn: ActiveTurn = {
      sessionId,
      chatId,
      abortController: new AbortController(),
      accumulatedText: "",
      toolSuffix: "",
      timers: new Set(),
      draft: null,
    }

    this.active.set(sessionId, turn)
    return turn
  }

  get(sessionId: string): ActiveTurn | undefined {
    return this.active.get(sessionId)
  }

  end(sessionId: string): void {
    const turn = this.active.get(sessionId)
    if (turn) {
      this.endTurn(turn)
      this.active.delete(sessionId)
    }
  }

  addTimer(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
    const turn = this.active.get(sessionId)
    if (turn) {
      turn.timers.add(timer)
    }
  }

  abortAll(): void {
    for (const [sessionId, turn] of this.active) {
      this.endTurn(turn)
    }
    this.active.clear()
  }

  get size(): number {
    return this.active.size
  }

  private endTurn(turn: ActiveTurn): void {
    // Stop draft stream if active
    turn.draft?.stop()
    // Abort all listeners registered with this signal
    turn.abortController.abort()
    // Clear all tracked timers
    for (const timer of turn.timers) {
      clearTimeout(timer)
    }
    turn.timers.clear()
  }
}
